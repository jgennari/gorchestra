package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/claude"
	"github.com/jgennari/gorchestra/internal/agents/codex"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	"github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/httpapi"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
	"github.com/jgennari/gorchestra/internal/webassets"
)

const databaseFileName = "gorchestra.db"

var version = "dev"

type config struct {
	configPath     string
	host           string
	port           string
	dataDir        string
	db             string
	workspace      string
	workspaceRoots []string
	codexBin       string
	codexSandbox   string
	codexNetwork   bool
	codexSearch    string
	codexModel     string
	claudeBin      string
	claudeModel    string
	open           bool
	showVersion    bool
}

func main() {
	cfg, err := parseConfig()
	if err != nil {
		log.Fatalf("configuration failed: %v", err)
	}
	if cfg.showVersion {
		fmt.Printf("gorchestra %s\n", version)
		return
	}

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

	claudeAgent := claude.New(
		claude.WithBinary(cfg.claudeBin),
		claude.WithModel(cfg.claudeModel),
		claude.WithWorkspace(cfg.workspace),
	)
	if version, err := claudeAgent.CheckAvailability(ctx); err != nil {
		log.Printf("claude unavailable: %v", err)
	} else {
		log.Printf("claude available: %s", version)
	}

	agentRegistry, err := agents.NewRegistry(fake.New(), codexAgent, claudeAgent)
	if err != nil {
		log.Fatalf("agent registry startup failed: %v", err)
	}
	runManager := runcontrol.NewManager()

	frontendAssets, err := webassets.Dist()
	if err != nil {
		log.Printf("frontend assets unavailable: %v", err)
	}

	addr := net.JoinHostPort(cfg.host, cfg.port)
	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewRouter(httpapi.Dependencies{Store: dbStore, Events: eventService, Agents: agentRegistry, Runs: runManager, Workdir: cfg.workspace, WorkspaceRoots: cfg.workspaceRoots, StaticAssets: frontendAssets}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	listenURL := listeningURL(cfg.host, cfg.port)
	errc := make(chan error, 1)
	go func() {
		log.Printf("gorchestra listening on %s", listenURL)
		if cfg.open {
			go func() {
				time.Sleep(150 * time.Millisecond)
				if err := openBrowser(listenURL); err != nil {
					log.Printf("open browser failed: %v", err)
				}
			}()
		}
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

func parseConfig() (config, error) {
	return parseConfigArgs(os.Args[1:], os.Getenv)
}

func parseConfigArgs(args []string, getenv func(string) string) (config, error) {
	var cfg config
	var workspaceRoots repeatedStringFlag
	flags := flag.NewFlagSet("gorchestra", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.configPath, "config", "", "path to an env-style configuration file")
	flags.StringVar(&cfg.host, "host", "", "host interface for the HTTP server")
	flags.StringVar(&cfg.port, "port", "", "port for the HTTP server")
	flags.StringVar(&cfg.dataDir, "data-dir", "", "directory for Gorchestra runtime data")
	flags.StringVar(&cfg.db, "db", "", "path to the SQLite database; overrides --data-dir")
	flags.StringVar(&cfg.workspace, "workspace", "", "workspace directory for agent runs")
	flags.Var(&workspaceRoots, "workspace-root", "additional allowed workspace root; may be provided more than once")
	flags.StringVar(&cfg.codexBin, "codex-bin", "", "path to the Codex CLI binary")
	flags.StringVar(&cfg.codexSandbox, "codex-sandbox", "", "Codex sandbox mode")
	flags.BoolVar(&cfg.codexNetwork, "codex-network-access", true, "allow network access for Codex shell commands")
	flags.StringVar(&cfg.codexSearch, "codex-web-search", "", "Codex web search mode: disabled, cached, or live")
	flags.StringVar(&cfg.codexModel, "codex-model", "", "optional Codex model override")
	flags.StringVar(&cfg.claudeBin, "claude-bin", "", "path to the Claude CLI binary")
	flags.StringVar(&cfg.claudeModel, "claude-model", "", "optional Claude model override")
	flags.BoolVar(&cfg.open, "open", false, "open the app in the default browser after startup")
	flags.BoolVar(&cfg.showVersion, "version", false, "print version and exit")
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	configFlag := flagWasSet(flags, "config")
	hostFlag := flagWasSet(flags, "host")
	portFlag := flagWasSet(flags, "port")
	dataDirFlag := flagWasSet(flags, "data-dir")
	dbFlag := flagWasSet(flags, "db")
	workspaceFlag := flagWasSet(flags, "workspace")
	codexBinFlag := flagWasSet(flags, "codex-bin")
	codexSandboxFlag := flagWasSet(flags, "codex-sandbox")
	codexNetworkFlag := flagWasSet(flags, "codex-network-access")
	codexSearchFlag := flagWasSet(flags, "codex-web-search")
	codexModelFlag := flagWasSet(flags, "codex-model")
	claudeBinFlag := flagWasSet(flags, "claude-bin")
	claudeModelFlag := flagWasSet(flags, "claude-model")
	openFlag := flagWasSet(flags, "open")
	workspaceRootsFlag := flagWasSet(flags, "workspace-root")
	if cfg.showVersion {
		return cfg, nil
	}

	if !configFlag {
		cfg.configPath = envOr(getenv, "GORCHESTRA_CONFIG", "")
	}
	configEnv, err := loadConfigEnvFile(cfg.configPath)
	if err != nil {
		return config{}, err
	}
	configGetenv := mergedGetenv(getenv, configEnv)

	if !hostFlag {
		cfg.host = envOr(configGetenv, "GORCHESTRA_HOST", "127.0.0.1")
	}
	if !portFlag {
		cfg.port = envOrAny(configGetenv, []string{"GORCHESTRA_PORT", "PORT"}, "8080")
	}
	if !dataDirFlag {
		cfg.dataDir = envOr(configGetenv, "GORCHESTRA_DATA_DIR", "")
	}
	if !dbFlag && !dataDirFlag {
		cfg.db = envOr(configGetenv, "GORCHESTRA_DB", "")
	}
	if !workspaceFlag {
		cfg.workspace = envOr(configGetenv, "GORCHESTRA_WORKSPACE", "")
	}
	if !workspaceRootsFlag {
		workspaceRoots = workspaceRootsFromEnv(configGetenv("GORCHESTRA_WORKSPACE_ROOTS"))
	}
	if !codexBinFlag {
		cfg.codexBin = envOr(configGetenv, "GORCHESTRA_CODEX_BIN", "codex")
	}
	if !codexSandboxFlag {
		cfg.codexSandbox = envOr(configGetenv, "GORCHESTRA_CODEX_SANDBOX", "workspace-write")
	}
	if !codexNetworkFlag {
		cfg.codexNetwork = envBool(configGetenv, "GORCHESTRA_CODEX_NETWORK_ACCESS", true)
	}
	if !codexSearchFlag {
		cfg.codexSearch = envOr(configGetenv, "GORCHESTRA_CODEX_WEB_SEARCH", "live")
	}
	if !codexModelFlag {
		cfg.codexModel = envOr(configGetenv, "GORCHESTRA_CODEX_MODEL", "")
	}
	if !claudeBinFlag {
		cfg.claudeBin = envOr(configGetenv, "GORCHESTRA_CLAUDE_BIN", "claude")
	}
	if !claudeModelFlag {
		cfg.claudeModel = envOr(configGetenv, "GORCHESTRA_CLAUDE_MODEL", "")
	}
	if !openFlag {
		cfg.open = envBool(configGetenv, "GORCHESTRA_OPEN", false)
	}

	if cfg.db == "" {
		dataDir := cfg.dataDir
		if dataDir == "" {
			defaultDir, err := defaultDataDir(getenv)
			if err != nil {
				return config{}, err
			}
			dataDir = defaultDir
		}
		resolvedDataDir, err := prepareDataDir(dataDir)
		if err != nil {
			return config{}, err
		}
		cfg.dataDir = resolvedDataDir
		cfg.db = filepath.Join(resolvedDataDir, databaseFileName)
	}

	if cfg.workspace == "" {
		workspace, err := os.Getwd()
		if err != nil {
			return config{}, fmt.Errorf("determine workspace: %w", err)
		}
		cfg.workspace = workspace
	}
	expandedWorkspace, err := expandHome(cfg.workspace)
	if err != nil {
		return config{}, err
	}
	workspace, err := filepath.Abs(expandedWorkspace)
	if err != nil {
		return config{}, fmt.Errorf("resolve workspace %q: %w", cfg.workspace, err)
	}
	cfg.workspace, err = existingDirectory("workspace", workspace)
	if err != nil {
		return config{}, err
	}
	for _, root := range workspaceRoots {
		if root == "" {
			continue
		}
		expandedRoot, err := expandHome(root)
		if err != nil {
			return config{}, err
		}
		workspaceRoot, err := existingDirectory("workspace root", expandedRoot)
		if err != nil {
			return config{}, err
		}
		cfg.workspaceRoots = append(cfg.workspaceRoots, workspaceRoot)
	}

	return cfg, nil
}

func flagWasSet(flags *flag.FlagSet, name string) bool {
	wasSet := false
	flags.Visit(func(flag *flag.Flag) {
		if flag.Name == name {
			wasSet = true
		}
	})
	return wasSet
}

type repeatedStringFlag []string

func (f *repeatedStringFlag) String() string {
	return ""
}

func (f *repeatedStringFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

func loadConfigEnvFile(path string) (map[string]string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, nil
	}
	expandedPath, err := expandHome(path)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(expandedPath)
	if err != nil {
		return nil, fmt.Errorf("open config file %q: %w", path, err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("config file close failed: %v", err)
		}
	}()

	values := make(map[string]string)
	scanner := bufio.NewScanner(file)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("parse config file %q line %d: expected KEY=value", path, lineNumber)
		}
		key = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(key), "export "))
		if !validConfigKey(key) {
			return nil, fmt.Errorf("parse config file %q line %d: invalid key %q", path, lineNumber, key)
		}
		values[key] = trimConfigValue(value)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read config file %q: %w", path, err)
	}
	return values, nil
}

func validConfigKey(key string) bool {
	if key == "" {
		return false
	}
	for index, char := range key {
		if char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || index > 0 && char >= '0' && char <= '9' {
			continue
		}
		return false
	}
	return true
}

func trimConfigValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 {
		return value
	}
	first := value[0]
	last := value[len(value)-1]
	if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
		return value[1 : len(value)-1]
	}
	return value
}

func mergedGetenv(getenv func(string) string, configEnv map[string]string) func(string) string {
	return func(key string) string {
		if value := getenv(key); value != "" {
			return value
		}
		return configEnv[key]
	}
}

func workspaceRootsFromEnv(value string) repeatedStringFlag {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	roots := repeatedStringFlag{}
	for _, root := range filepath.SplitList(value) {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		roots = append(roots, root)
	}
	return roots
}

func envOr(getenv func(string) string, key string, fallback string) string {
	if value := getenv(key); value != "" {
		return value
	}
	return fallback
}

func envOrAny(getenv func(string) string, keys []string, fallback string) string {
	for _, key := range keys {
		if value := getenv(key); value != "" {
			return value
		}
	}
	return fallback
}

func envBool(getenv func(string) string, key string, fallback bool) bool {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback
	}
	switch strings.ToLower(value) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func defaultDataDir(getenv func(string) string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("determine home directory: %w", err)
	}
	return defaultDataDirFor(runtime.GOOS, getenv, home)
}

func defaultDataDirFor(goos string, getenv func(string) string, home string) (string, error) {
	if home == "" {
		return "", errors.New("home directory is unavailable")
	}
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Gorchestra"), nil
	case "linux":
		if xdgDataHome := getenv("XDG_DATA_HOME"); xdgDataHome != "" {
			return filepath.Join(xdgDataHome, "gorchestra"), nil
		}
		return filepath.Join(home, ".local", "share", "gorchestra"), nil
	case "windows":
		if appData := getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "Gorchestra"), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "Gorchestra"), nil
	default:
		return filepath.Join(home, ".gorchestra"), nil
	}
}

func prepareDataDir(value string) (string, error) {
	expanded, err := expandHome(value)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(expanded)
	if err != nil {
		return "", fmt.Errorf("resolve data directory %q: %w", value, err)
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return "", fmt.Errorf("create data directory %q: %w", absolute, err)
	}
	return absolute, nil
}

func expandHome(value string) (string, error) {
	if value == "~" || strings.HasPrefix(value, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("determine home directory: %w", err)
		}
		if value == "~" {
			return home, nil
		}
		return filepath.Join(home, strings.TrimPrefix(value, "~/")), nil
	}
	return value, nil
}

func existingDirectory(label string, value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve %s %q: %w", label, value, err)
	}
	if evaluated, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = evaluated
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("%s %q is unavailable: %w", label, absolute, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s %q is not a directory", label, absolute)
	}
	return absolute, nil
}

func listeningURL(host string, port string) string {
	return "http://" + net.JoinHostPort(displayHost(host), port)
}

func displayHost(host string) string {
	switch host {
	case "", "0.0.0.0", "::":
		return "127.0.0.1"
	default:
		return host
	}
}

func openBrowser(rawURL string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
		args = []string{rawURL}
	case "windows":
		command = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", rawURL}
	default:
		command = "xdg-open"
		args = []string{rawURL}
	}
	return exec.Command(command, args...).Start()
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
