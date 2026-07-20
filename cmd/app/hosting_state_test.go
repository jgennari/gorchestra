package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/hosting"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestRestoredHostStateIsStoppedAndKeepsStableRoute(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := hosting.RecipePath(workspace)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	snapshot := []byte(`
version: 1
name: dashboard
services:
  - name: web
    command: ["server"]
    cwd: web
    port: auto
routes:
  - path: /
    service: web
`)
	if err := os.WriteFile(configPath, snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	exitCode := 2
	state, err := restoredHostState(store.HostRuntime{
		SessionID:      "sess_12345678-rest",
		RouteSlug:      "dashboard-12345678-gorchestra",
		WorkspacePath:  workspace,
		ConfigPath:     configPath,
		RecipeName:     "dashboard",
		RecipeHash:     "persisted-hash",
		RecipeSnapshot: snapshot,
		Status:         store.HostRuntimeStatusRunning,
		Services: []store.HostServiceSnapshot{{
			Name:      "web",
			Port:      41234,
			Status:    store.HostServiceStatusRunning,
			ExitCode:  &exitCode,
			StartedAt: &now,
		}},
		StartedAt: &now,
	}, "http://{slug}.dev.gennari.industries")
	if err != nil {
		t.Fatalf("restore state: %v", err)
	}
	if state.Snapshot.Runtime.Status != hosting.StatusStopped {
		t.Fatalf("expected restored runtime to be stopped, got %s", state.Snapshot.Runtime.Status)
	}
	if state.Snapshot.Runtime.URL != "http://dashboard-12345678-gorchestra.dev.gennari.industries" {
		t.Fatalf("unexpected restored URL %q", state.Snapshot.Runtime.URL)
	}
	if len(state.Snapshot.Services) != 1 || state.Snapshot.Services[0].Status != hosting.ServiceStopped {
		t.Fatalf("expected stopped service snapshot, got %#v", state.Snapshot.Services)
	}
	if len(state.Snapshot.Services[0].RoutePaths) != 1 || state.Snapshot.Services[0].RoutePaths[0] != "/" {
		t.Fatalf("expected restored route paths, got %#v", state.Snapshot.Services[0].RoutePaths)
	}
	if state.Snapshot.Config.LoadedDigest != "persisted-hash" {
		t.Fatalf("expected persisted loaded digest, got %q", state.Snapshot.Config.LoadedDigest)
	}
}

func TestHostStateSaveParamsPreservesLifecycleSnapshot(t *testing.T) {
	now := time.Now().UTC()
	exitCode := 0
	state := hosting.PersistedState{
		Snapshot: hosting.Snapshot{
			SessionID: "sess_1",
			Config: hosting.ConfigStatus{
				Path:         "/workspace/.gorchestra/host.yaml",
				LoadedDigest: "hash",
				Name:         "app",
			},
			Runtime: hosting.RuntimeInfo{
				Status:    hosting.StatusRunning,
				StartedAt: &now,
			},
			Services: []hosting.ServiceInfo{{
				Name:      "web",
				Status:    hosting.ServiceRunning,
				Port:      43210,
				StartedAt: &now,
				ExitCode:  &exitCode,
			}},
		},
		Slug:           "app-session-gorchestra",
		Workspace:      "/workspace",
		Recipe:         hosting.Recipe{Name: "app", Version: 1},
		RecipeSnapshot: []byte("recipe"),
	}
	params := hostStateSaveParams(state)
	if params.Status != store.HostRuntimeStatusRunning || params.Services[0].Status != store.HostServiceStatusRunning {
		t.Fatalf("unexpected persisted statuses: runtime=%s service=%s", params.Status, params.Services[0].Status)
	}
	if params.RouteSlug != state.Slug || params.RecipeHash != "hash" || params.Services[0].Port != 43210 {
		t.Fatalf("unexpected persisted params %#v", params)
	}
}

func TestInitializeHostingManagerRecoversActiveRuntimeWithoutStartingIt(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	configPath := hosting.RecipePath(workspace)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	recipeSnapshot := []byte(`
version: 1
name: recovered
services:
  - name: web
    command: ["server"]
    cwd: .
    port: auto
routes:
  - path: /
    service: web
`)
	if err := os.WriteFile(configPath, recipeSnapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := hosting.LoadRecipe(workspace)
	if err != nil {
		t.Fatal(err)
	}
	dbStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer dbStore.Close()
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:         "Recovered preview",
		AgentType:     "fake",
		WorkspacePath: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbStore.SaveHostRuntime(ctx, store.SaveHostRuntimeParams{
		SessionID:      session.ID,
		RouteSlug:      "recovered-session-gorchestra",
		WorkspacePath:  loaded.Workspace,
		ConfigPath:     loaded.Path,
		RecipeName:     loaded.Recipe.Name,
		RecipeHash:     loaded.Digest,
		RecipeSnapshot: loaded.Snapshot,
		Status:         store.HostRuntimeStatusRunning,
		Services: []store.HostServiceSnapshot{{
			Name:   "web",
			Port:   45678,
			PID:    99999,
			Status: store.HostServiceStatusRunning,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	events, err := eventservice.NewService(dbStore)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := initializeHostingManager(ctx, dbStore, events, "http://{slug}.example.test")
	if err != nil {
		t.Fatalf("initialize manager: %v", err)
	}
	if manager == nil {
		t.Fatal("expected supported hosting manager")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	defer manager.Shutdown(shutdownCtx)

	snapshot, err := manager.Status(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Runtime.Status != hosting.StatusStopped || snapshot.Runtime.URL != "http://recovered-session-gorchestra.example.test" {
		t.Fatalf("unexpected restored runtime %#v", snapshot.Runtime)
	}
	persisted, err := dbStore.GetHostRuntime(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != store.HostRuntimeStatusStopped || persisted.Services[0].PID != 0 || persisted.LastError != interruptedHostRuntimeReason {
		t.Fatalf("unexpected recovered store state %#v", persisted)
	}
	recent, err := dbStore.ListRecentEvents(ctx, session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range recent {
		if event.Type == "host.runtime.stopped" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected durable recovery event, got %#v", recent)
	}
}
