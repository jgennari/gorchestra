package main

import (
	"context"
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
	port         string
	db           string
	workspace    string
	codexBin     string
	codexSandbox string
	codexNetwork bool
	codexSearch  string
	codexModel   string
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
		Handler:           httpapi.NewRouter(httpapi.Dependencies{Store: dbStore, Events: eventService, Agents: agentRegistry, Runs: runManager, Workdir: cfg.workspace}),
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
	flag.StringVar(&cfg.db, "db", "./sessions.db", "path to the SQLite database")
	flag.StringVar(&cfg.workspace, "workspace", "", "workspace directory for agent runs")
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
	cfg.workspace = workspace

	return cfg
}
