package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestParseConfigUsesDataDirForDefaultDatabase(t *testing.T) {
	workspace := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data")

	cfg, err := parseConfigArgs([]string{
		"--data-dir", dataDir,
		"--workspace", workspace,
		"--host", "0.0.0.0",
		"--port", "18080",
	}, emptyEnv)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if cfg.host != "0.0.0.0" {
		t.Fatalf("expected host 0.0.0.0, got %q", cfg.host)
	}
	if cfg.port != "18080" {
		t.Fatalf("expected port 18080, got %q", cfg.port)
	}
	if cfg.dataDir != dataDir {
		t.Fatalf("expected data dir %q, got %q", dataDir, cfg.dataDir)
	}
	if cfg.db != filepath.Join(dataDir, databaseFileName) {
		t.Fatalf("expected database under data dir, got %q", cfg.db)
	}
	wantWorkspace, err := existingDirectory("workspace", workspace)
	if err != nil {
		t.Fatalf("resolve expected workspace: %v", err)
	}
	if cfg.workspace != wantWorkspace {
		t.Fatalf("expected workspace %q, got %q", wantWorkspace, cfg.workspace)
	}
}

func TestParseConfigExplicitDBOverridesDataDir(t *testing.T) {
	workspace := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data")
	dbPath := filepath.Join(t.TempDir(), "custom.db")

	cfg, err := parseConfigArgs([]string{
		"--data-dir", dataDir,
		"--db", dbPath,
		"--workspace", workspace,
	}, emptyEnv)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if cfg.db != dbPath {
		t.Fatalf("expected explicit db %q, got %q", dbPath, cfg.db)
	}
}

func TestParseConfigDataDirFlagOverridesEnvironmentDB(t *testing.T) {
	workspace := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data")
	envDB := filepath.Join(t.TempDir(), "env.db")

	cfg, err := parseConfigArgs([]string{
		"--data-dir", dataDir,
		"--workspace", workspace,
	}, envMap(map[string]string{
		"GORCHESTRA_DB": envDB,
	}))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if cfg.db != filepath.Join(dataDir, databaseFileName) {
		t.Fatalf("expected data-dir database, got %q", cfg.db)
	}
}

func TestParseConfigLoadsConfigFile(t *testing.T) {
	workspace := t.TempDir()
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data")
	configPath := writeConfigFile(t, fmt.Sprintf(`
GORCHESTRA_HOST=0.0.0.0
GORCHESTRA_PORT=15173
GORCHESTRA_DATA_DIR=%s
GORCHESTRA_WORKSPACE=%s
GORCHESTRA_WORKSPACE_ROOTS=%s%c%s
GORCHESTRA_CODEX_BIN=/opt/codex/bin/codex
GORCHESTRA_CODEX_SANDBOX=read-only
GORCHESTRA_CODEX_NETWORK_ACCESS=false
GORCHESTRA_CODEX_WEB_SEARCH=cached
GORCHESTRA_CODEX_MODEL=gpt-test
GORCHESTRA_CLAUDE_BIN=/opt/claude/bin/claude
GORCHESTRA_CLAUDE_MODEL=claude-test
GORCHESTRA_OPEN=true
`, dataDir, workspace, firstRoot, os.PathListSeparator, secondRoot))

	cfg, err := parseConfigArgs([]string{"--config", configPath}, emptyEnv)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if cfg.host != "0.0.0.0" || cfg.port != "15173" {
		t.Fatalf("expected host/port from config, got %s:%s", cfg.host, cfg.port)
	}
	if cfg.dataDir != dataDir || cfg.db != filepath.Join(dataDir, databaseFileName) {
		t.Fatalf("expected data dir database from config, got data_dir=%q db=%q", cfg.dataDir, cfg.db)
	}
	wantWorkspace, err := existingDirectory("workspace", workspace)
	if err != nil {
		t.Fatalf("resolve expected workspace: %v", err)
	}
	firstResolvedRoot, err := existingDirectory("workspace root", firstRoot)
	if err != nil {
		t.Fatalf("resolve first workspace root: %v", err)
	}
	secondResolvedRoot, err := existingDirectory("workspace root", secondRoot)
	if err != nil {
		t.Fatalf("resolve second workspace root: %v", err)
	}
	if cfg.workspace != wantWorkspace {
		t.Fatalf("expected workspace %q, got %q", wantWorkspace, cfg.workspace)
	}
	if len(cfg.workspaceRoots) != 2 || cfg.workspaceRoots[0] != firstResolvedRoot || cfg.workspaceRoots[1] != secondResolvedRoot {
		t.Fatalf("expected workspace roots from config, got %#v", cfg.workspaceRoots)
	}
	if cfg.codexBin != "/opt/codex/bin/codex" || cfg.codexSandbox != "read-only" || cfg.codexSearch != "cached" || cfg.codexModel != "gpt-test" {
		t.Fatalf("expected codex config values, got %#v", cfg)
	}
	if cfg.claudeBin != "/opt/claude/bin/claude" || cfg.claudeModel != "claude-test" {
		t.Fatalf("expected claude config values, got %#v", cfg)
	}
	if cfg.codexNetwork || !cfg.open {
		t.Fatalf("expected boolean config values, got network=%v open=%v", cfg.codexNetwork, cfg.open)
	}
}

func TestParseConfigFlagsAndEnvironmentOverrideConfigFile(t *testing.T) {
	workspace := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data")
	configPath := writeConfigFile(t, fmt.Sprintf(`
GORCHESTRA_HOST=0.0.0.0
GORCHESTRA_PORT=15173
GORCHESTRA_DATA_DIR=%s
GORCHESTRA_WORKSPACE=%s
`, dataDir, workspace))

	cfg, err := parseConfigArgs([]string{
		"--config", configPath,
		"--port", "19090",
	}, envMap(map[string]string{
		"GORCHESTRA_HOST": "127.0.0.2",
		"GORCHESTRA_PORT": "18080",
	}))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if cfg.host != "127.0.0.2" {
		t.Fatalf("expected environment host to override config, got %q", cfg.host)
	}
	if cfg.port != "19090" {
		t.Fatalf("expected flag port to override environment and config, got %q", cfg.port)
	}
}

func TestParseConfigMissingConfigFileFails(t *testing.T) {
	_, err := parseConfigArgs([]string{"--config", filepath.Join(t.TempDir(), "missing.env")}, emptyEnv)
	if err == nil {
		t.Fatal("expected missing config file error")
	}
}

func TestParseConfigVersionSkipsFilesystemValidation(t *testing.T) {
	cfg, err := parseConfigArgs([]string{
		"--version",
		"--config", filepath.Join(t.TempDir(), "missing.env"),
		"--workspace", filepath.Join(t.TempDir(), "missing"),
	}, emptyEnv)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	if !cfg.showVersion {
		t.Fatal("expected showVersion")
	}
}

func TestDefaultDataDirForOS(t *testing.T) {
	tests := []struct {
		name string
		goos string
		env  map[string]string
		home string
		want string
	}{
		{
			name: "macos",
			goos: "darwin",
			home: "/Users/joey",
			want: filepath.Join("/Users/joey", "Library", "Application Support", "Gorchestra"),
		},
		{
			name: "linux xdg",
			goos: "linux",
			env:  map[string]string{"XDG_DATA_HOME": "/xdg"},
			home: "/home/joey",
			want: filepath.Join("/xdg", "gorchestra"),
		},
		{
			name: "linux fallback",
			goos: "linux",
			home: "/home/joey",
			want: filepath.Join("/home/joey", ".local", "share", "gorchestra"),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := defaultDataDirFor(test.goos, envMap(test.env), test.home)
			if err != nil {
				t.Fatalf("default data dir: %v", err)
			}
			if got != test.want {
				t.Fatalf("expected %q, got %q", test.want, got)
			}
		})
	}
}

func TestRecoverInterruptedRunsMarksRunningSessionsFailed(t *testing.T) {
	ctx := context.Background()
	dbStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := dbStore.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})
	events, err := eventservice.NewService(dbStore)
	if err != nil {
		t.Fatalf("new event service: %v", err)
	}

	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Interrupted run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}

	if err := recoverInterruptedRuns(ctx, dbStore, events); err != nil {
		t.Fatalf("recover interrupted runs: %v", err)
	}

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.Status != store.SessionStatusFailed {
		t.Fatalf("expected failed status, got %q", updated.Status)
	}
	if updated.CompletedAt == nil {
		t.Fatal("expected completed_at after recovery")
	}

	persistedEvents, err := dbStore.ListEvents(ctx, session.ID, 0, 10)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(persistedEvents) != 2 {
		t.Fatalf("expected two recovery events, got %#v", persistedEvents)
	}
	if persistedEvents[0].Type != "agent.run.failed" || persistedEvents[1].Type != "session.status.updated" {
		t.Fatalf("expected failed run and status events, got %#v", persistedEvents)
	}
	var payload map[string]any
	if err := json.Unmarshal(persistedEvents[0].Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["error"] != "server restarted while run was active" {
		t.Fatalf("expected interrupted run error, got %#v", payload)
	}
}

func emptyEnv(string) string {
	return ""
}

func envMap(values map[string]string) func(string) string {
	return func(key string) string {
		return values[key]
	}
}

func writeConfigFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gorchestra.env")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}
	return path
}
