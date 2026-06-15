package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/codex"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	"github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/httpapi"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

type config struct {
	port           string
	db             string
	workspace      string
	workspaceRoots []string
	codexBin       string
	codexSandbox   string
	codexNetwork   bool
	codexSearch    string
	codexModel     string
}

func main() {
	cfg := parseConfig()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbStore, err := store.Open(ctx, cfg.db)
	if err != nil {
		log.Fatalf("database startup failed: %v", err)
	}
	defer func() {
		if err := dbStore.Close(); err != nil {
			log.Printf("database close failed: %v", err)
		}
	}()

	eventService, err := events.NewService(dbStore)
	if err != nil {
		log.Fatalf("event service startup failed: %v", err)
	}
	if err := recoverInterruptedRuns(ctx, dbStore, eventService); err != nil {
		log.Fatalf("recover interrupted runs failed: %v", err)
	}

	codexAgent := codex.New(
		codex.WithBinary(cfg.codexBin),
		codex.WithSandbox(cfg.codexSandbox),
		codex.WithNetworkAccess(cfg.codexNetwork),
		codex.WithWebSearchMode(cfg.codexSearch),
		codex.WithModel(cfg.codexModel),
		codex.WithWorkspace(cfg.workspace),
	)
	if version, err := codexAgent.CheckAvailability(ctx); err != nil {
		log.Printf("codex unavailable: %v", err)
	} else {
		log.Printf("codex available: %s", version)
	}

	agentRegistry, err := agents.NewRegistry(fake.New(), codexAgent)
	if err != nil {
		log.Fatalf("agent registry startup failed: %v", err)
	}
	runManager := runcontrol.NewManager()

	addr := ":" + cfg.port
	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewRouter(httpapi.Dependencies{Store: dbStore, Events: eventService, Agents: agentRegistry, Runs: runManager, Workdir: cfg.workspace, WorkspaceRoots: cfg.workspaceRoots}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Printf("gorchestra listening on http://localhost%s", addr)
		errc <- server.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown failed: %v", err)
		}

		if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server failed: %v", err)
		}
	}
}

func parseConfig() config {
	var cfg config
	var workspaceRoots repeatedStringFlag
	flag.StringVar(&cfg.db, "db", "./sessions.db", "path to the SQLite database")
	flag.StringVar(&cfg.workspace, "workspace", "", "workspace directory for agent runs")
	flag.Var(&workspaceRoots, "workspace-root", "additional allowed workspace root; may be provided more than once")
	flag.StringVar(&cfg.codexBin, "codex-bin", "codex", "path to the Codex CLI binary")
	flag.StringVar(&cfg.codexSandbox, "codex-sandbox", "workspace-write", "Codex sandbox mode")
	flag.BoolVar(&cfg.codexNetwork, "codex-network-access", true, "allow network access for Codex shell commands")
	flag.StringVar(&cfg.codexSearch, "codex-web-search", "live", "Codex web search mode: disabled, cached, or live")
	flag.StringVar(&cfg.codexModel, "codex-model", "", "optional Codex model override")
	flag.Parse()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	cfg.port = port
	if cfg.workspace == "" {
		workspace, err := os.Getwd()
		if err != nil {
			log.Fatalf("failed to determine workspace: %v", err)
		}
		cfg.workspace = workspace
	}
	workspace, err := filepath.Abs(cfg.workspace)
	if err != nil {
		log.Fatalf("failed to resolve workspace %q: %v", cfg.workspace, err)
	}
	cfg.workspace = mustExistingDirectory("workspace", workspace)
	for _, root := range workspaceRoots {
		if root == "" {
			continue
		}
		cfg.workspaceRoots = append(cfg.workspaceRoots, mustExistingDirectory("workspace root", root))
	}

	return cfg
}

type repeatedStringFlag []string

func (f *repeatedStringFlag) String() string {
	return ""
}

func (f *repeatedStringFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

func mustExistingDirectory(label string, value string) string {
	absolute, err := filepath.Abs(value)
	if err != nil {
		log.Fatalf("failed to resolve %s %q: %v", label, value, err)
	}
	if evaluated, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = evaluated
	}
	info, err := os.Stat(absolute)
	if err != nil {
		log.Fatalf("%s %q is unavailable: %v", label, absolute, err)
	}
	if !info.IsDir() {
		log.Fatalf("%s %q is not a directory", label, absolute)
	}
	return absolute
}

func recoverInterruptedRuns(ctx context.Context, dbStore *store.Store, eventService *events.Service) error {
	runningSessions, err := dbStore.ListSessions(ctx, store.ListSessionsParams{
		Limit:  1000,
		Status: store.SessionStatusRunning,
	})
	if err != nil {
		return err
	}

	for _, session := range runningSessions {
		failurePayload, err := json.Marshal(map[string]any{
			"agent_type": session.AgentType,
			"error":      "server restarted while run was active",
		})
		if err != nil {
			return err
		}
		if _, err := eventService.Append(ctx, events.AppendParams{
			SessionID: session.ID,
			Type:      "agent.run.failed",
			Role:      "assistant",
			Status:    store.EventStatusFailed,
			Payload:   failurePayload,
		}); err != nil {
			return err
		}

		updatedSession, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusFailed,
		})
		if err != nil {
			return err
		}
		var completedAt any
		if updatedSession.CompletedAt != nil {
			completedAt = updatedSession.CompletedAt.UTC().Format(time.RFC3339Nano)
		}
		statusPayload, err := json.Marshal(map[string]any{
			"status":       string(updatedSession.Status),
			"updated_at":   updatedSession.UpdatedAt.UTC().Format(time.RFC3339Nano),
			"completed_at": completedAt,
		})
		if err != nil {
			return err
		}
		if _, err := eventService.Append(ctx, events.AppendParams{
			SessionID: session.ID,
			Type:      "session.status.updated",
			Role:      "system",
			Status:    store.EventStatusFailed,
			Payload:   statusPayload,
		}); err != nil {
			return err
		}

		log.Printf("marked interrupted run failed: session_id=%s agent_type=%s", session.ID, session.AgentType)
	}

	return nil
}
