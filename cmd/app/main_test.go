package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

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
