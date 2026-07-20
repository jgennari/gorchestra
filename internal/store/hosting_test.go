package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestHostRuntimePersistenceAndImmutableRouteSlug(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	session := createHostTestSession(t, ctx, database, "one")
	startedAt := time.Date(2026, 7, 17, 12, 30, 0, 0, time.UTC)
	exitCode := 12

	created, err := database.SaveHostRuntime(ctx, SaveHostRuntimeParams{
		SessionID:      session.ID,
		RouteSlug:      "my-app-12345678-gorchestra",
		WorkspacePath:  "/workspace/one",
		ConfigPath:     "/workspace/one/.gorchestra/host.yaml",
		RecipeName:     "my-app",
		RecipeHash:     "hash-one",
		RecipeSnapshot: []byte("version: 1\n"),
		Status:         HostRuntimeStatusRunning,
		Services: []HostServiceSnapshot{{
			Name:      "web",
			Port:      5173,
			PID:       101,
			Status:    HostServiceStatusRunning,
			ExitCode:  &exitCode,
			StartedAt: &startedAt,
		}},
		StartedAt: &startedAt,
	})
	if err != nil {
		t.Fatalf("save host runtime: %v", err)
	}
	if created.SessionID != session.ID || created.RouteSlug != "my-app-12345678-gorchestra" || created.Status != HostRuntimeStatusRunning {
		t.Fatalf("unexpected runtime: %#v", created)
	}
	if len(created.Services) != 1 || created.Services[0].Port != 5173 || created.Services[0].PID != 101 {
		t.Fatalf("unexpected service snapshot: %#v", created.Services)
	}
	if created.StartedAt == nil || !created.StartedAt.Equal(startedAt) {
		t.Fatalf("started_at was not preserved: %#v", created.StartedAt)
	}

	stoppedAt := startedAt.Add(time.Minute)
	updated, err := database.SaveHostRuntime(ctx, SaveHostRuntimeParams{
		SessionID:      session.ID,
		RouteSlug:      "attempted-new-slug",
		WorkspacePath:  "/workspace/two",
		ConfigPath:     "/workspace/two/.gorchestra/host.yaml",
		RecipeName:     "new-name",
		RecipeHash:     "hash-two",
		RecipeSnapshot: []byte("version: 1\nname: new-name\n"),
		Status:         HostRuntimeStatusStopped,
		Services: []HostServiceSnapshot{{
			Name:      "web",
			Port:      5180,
			Status:    HostServiceStatusStopped,
			ExitCode:  &exitCode,
			StartedAt: &startedAt,
			StoppedAt: &stoppedAt,
		}},
		StartedAt: &startedAt,
		StoppedAt: &stoppedAt,
		LastError: "process exited",
	})
	if err != nil {
		t.Fatalf("update host runtime: %v", err)
	}
	if updated.RouteSlug != created.RouteSlug {
		t.Fatalf("route slug changed from %q to %q", created.RouteSlug, updated.RouteSlug)
	}
	if updated.WorkspacePath != "/workspace/two" || updated.RecipeHash != "hash-two" || updated.RecipeName != "new-name" {
		t.Fatalf("mutable fields were not updated: %#v", updated)
	}
	if string(updated.RecipeSnapshot) != "version: 1\nname: new-name\n" || updated.LastError != "process exited" {
		t.Fatalf("snapshot/error not preserved: %#v", updated)
	}
	if updated.StoppedAt == nil || !updated.StoppedAt.Equal(stoppedAt) {
		t.Fatalf("stopped_at was not preserved: %#v", updated.StoppedAt)
	}

	loaded, err := database.GetHostRuntime(ctx, session.ID)
	if err != nil {
		t.Fatalf("get host runtime: %v", err)
	}
	if !reflect.DeepEqual(updated, loaded) {
		t.Fatalf("GetHostRuntime mismatch:\nupdated=%#v\nloaded=%#v", updated, loaded)
	}
}

func TestHostRuntimeListsAndStartupRecovery(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	initial := time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return initial }
	statuses := []HostRuntimeStatus{
		HostRuntimeStatusStarting,
		HostRuntimeStatusRunning,
		HostRuntimeStatusStopping,
		HostRuntimeStatusStopped,
		HostRuntimeStatusFailed,
	}
	for index, status := range statuses {
		session := createHostTestSession(t, ctx, database, string(rune('a'+index)))
		serviceStatus := HostServiceStatus(status)
		if status == HostRuntimeStatusFailed {
			serviceStatus = HostServiceStatusFailed
		}
		if _, err := database.SaveHostRuntime(ctx, SaveHostRuntimeParams{
			SessionID:      session.ID,
			RouteSlug:      "route-" + session.ID,
			WorkspacePath:  "/workspace/" + session.ID,
			ConfigPath:     "/workspace/" + session.ID + "/.gorchestra/host.yaml",
			RecipeName:     "recipe",
			RecipeHash:     "hash-" + session.ID,
			RecipeSnapshot: []byte("version: 1"),
			Status:         status,
			Services: []HostServiceSnapshot{{
				Name:   "web",
				PID:    100 + index,
				Status: serviceStatus,
			}},
		}); err != nil {
			t.Fatalf("save %s runtime: %v", status, err)
		}
	}

	all, err := database.ListHostRuntimes(ctx)
	if err != nil || len(all) != 5 {
		t.Fatalf("list all runtimes: len=%d err=%v", len(all), err)
	}
	active, err := database.ListActiveHostRuntimes(ctx)
	if err != nil || len(active) != 3 {
		t.Fatalf("list active runtimes: len=%d err=%v", len(active), err)
	}
	for _, runtime := range active {
		if runtime.Status != HostRuntimeStatusStarting && runtime.Status != HostRuntimeStatusRunning && runtime.Status != HostRuntimeStatusStopping {
			t.Fatalf("non-active status returned: %s", runtime.Status)
		}
	}

	recoveredAt := initial.Add(10 * time.Minute)
	database.now = func() time.Time { return recoveredAt }
	recovered, err := database.RecoverActiveHostRuntimes(ctx, "interrupted by Gorchestra restart")
	if err != nil {
		t.Fatalf("recover active runtimes: %v", err)
	}
	if len(recovered) != 3 {
		t.Fatalf("expected three recovered runtimes, got %d", len(recovered))
	}
	for _, runtime := range recovered {
		if runtime.Status != HostRuntimeStatusStopped || runtime.LastError != "interrupted by Gorchestra restart" {
			t.Fatalf("runtime not recovered: %#v", runtime)
		}
		if runtime.StoppedAt == nil || !runtime.StoppedAt.Equal(recoveredAt) {
			t.Fatalf("runtime recovery timestamp missing: %#v", runtime.StoppedAt)
		}
		if len(runtime.Services) != 1 || runtime.Services[0].Status != HostServiceStatusStopped || runtime.Services[0].PID != 0 {
			t.Fatalf("service not recovered: %#v", runtime.Services)
		}
		if runtime.Services[0].StoppedAt == nil || runtime.Services[0].Error != "interrupted by Gorchestra restart" {
			t.Fatalf("service recovery detail missing: %#v", runtime.Services[0])
		}
	}
	active, err = database.ListActiveHostRuntimes(ctx)
	if err != nil || len(active) != 0 {
		t.Fatalf("active runtimes remain after recovery: len=%d err=%v", len(active), err)
	}
	secondRecovery, err := database.RecoverActiveHostRuntimes(ctx, "again")
	if err != nil || len(secondRecovery) != 0 {
		t.Fatalf("expected idempotent recovery, got len=%d err=%v", len(secondRecovery), err)
	}
}

func TestSaveHostRuntimeValidationAndMissingRows(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	valid := SaveHostRuntimeParams{
		SessionID:      "missing",
		RouteSlug:      "route",
		WorkspacePath:  "/workspace",
		ConfigPath:     "/workspace/.gorchestra/host.yaml",
		RecipeName:     "recipe",
		RecipeHash:     "hash",
		RecipeSnapshot: []byte("version: 1"),
		Status:         HostRuntimeStatusStopped,
		Services:       []HostServiceSnapshot{{Name: "web", Status: HostServiceStatusStopped}},
	}
	if _, err := database.SaveHostRuntime(ctx, valid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for missing session, got %v", err)
	}
	if _, err := database.GetHostRuntime(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for missing runtime, got %v", err)
	}
	valid.SessionID = createHostTestSession(t, ctx, database, "validation").ID

	tests := []struct {
		name   string
		mutate func(*SaveHostRuntimeParams)
	}{
		{"route", func(value *SaveHostRuntimeParams) { value.RouteSlug = "" }},
		{"workspace", func(value *SaveHostRuntimeParams) { value.WorkspacePath = "" }},
		{"config", func(value *SaveHostRuntimeParams) { value.ConfigPath = "" }},
		{"recipe name", func(value *SaveHostRuntimeParams) { value.RecipeName = "" }},
		{"recipe hash", func(value *SaveHostRuntimeParams) { value.RecipeHash = "" }},
		{"runtime status", func(value *SaveHostRuntimeParams) { value.Status = "unknown" }},
		{"service name", func(value *SaveHostRuntimeParams) { value.Services[0].Name = "" }},
		{"service port", func(value *SaveHostRuntimeParams) { value.Services[0].Port = 70000 }},
		{"service pid", func(value *SaveHostRuntimeParams) { value.Services[0].PID = -1 }},
		{"service status", func(value *SaveHostRuntimeParams) { value.Services[0].Status = "unknown" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			params := valid
			params.Services = append([]HostServiceSnapshot(nil), valid.Services...)
			test.mutate(&params)
			if _, err := database.SaveHostRuntime(ctx, params); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("expected ErrInvalidArgument, got %v", err)
			}
		})
	}
}

func TestHostRuntimeRouteSlugsAreUniqueAcrossSessions(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	first := createHostTestSession(t, ctx, database, "first")
	second := createHostTestSession(t, ctx, database, "second")
	params := func(sessionID string) SaveHostRuntimeParams {
		return SaveHostRuntimeParams{
			SessionID:      sessionID,
			RouteSlug:      "same-route",
			WorkspacePath:  "/workspace",
			ConfigPath:     "/workspace/.gorchestra/host.yaml",
			RecipeName:     "recipe",
			RecipeHash:     "hash",
			RecipeSnapshot: []byte("version: 1"),
			Status:         HostRuntimeStatusStopped,
		}
	}
	if _, err := database.SaveHostRuntime(ctx, params(first.ID)); err != nil {
		t.Fatalf("save first runtime: %v", err)
	}
	if _, err := database.SaveHostRuntime(ctx, params(second.ID)); err == nil {
		t.Fatal("expected duplicate route slug error")
	}
}

func createHostTestSession(t *testing.T, ctx context.Context, database *Store, suffix string) Session {
	t.Helper()
	session, err := database.CreateSession(ctx, CreateSessionParams{
		Title:         "Host " + suffix,
		AgentType:     "codex",
		WorkspacePath: "/workspace/" + suffix,
	})
	if err != nil {
		t.Fatalf("create host test session: %v", err)
	}
	return session
}
