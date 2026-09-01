package scheduler

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestProcessDueMaterializesOnceAndDispatches(t *testing.T) {
	ctx := context.Background()
	database := openSchedulerTestStore(t, ctx)
	events, err := eventservice.NewService(database)
	if err != nil {
		t.Fatal(err)
	}
	service := New(database, events)
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	session, err := database.CreateSession(ctx, store.CreateSessionParams{Title: "Scheduled", AgentType: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := service.Create(ctx, session.ID, Input{Prompt: "Inspect", Cadence: Cadence{Kind: "interval", Every: 1, Unit: "hours"}, Timezone: "UTC", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	var mu sync.Mutex
	dispatched := 0
	service.SetDispatch(func(id string) {
		mu.Lock()
		defer mu.Unlock()
		if id == session.ID {
			dispatched++
		}
	})
	service.processDue(ctx)
	service.processDue(ctx)
	occurrences, err := service.Occurrences(ctx, session.ID, item.ID, 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(occurrences) != 1 || occurrences[0].Status != "queued" {
		t.Fatalf("occurrences=%#v", occurrences)
	}
	mu.Lock()
	count := dispatched
	mu.Unlock()
	if count != 1 {
		t.Fatalf("expected one dispatch, got %d", count)
	}
	updated, err := service.Get(ctx, session.ID, item.ID)
	if err != nil || updated.NextRunAt == nil || !updated.NextRunAt.After(now) {
		t.Fatalf("next run not advanced: %#v err=%v", updated.NextRunAt, err)
	}
}

func TestStartSkipsOfflineFirings(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	database := openSchedulerTestStore(t, ctx)
	events, _ := eventservice.NewService(database)
	service := New(database, events)
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	session, _ := database.CreateSession(ctx, store.CreateSessionParams{Title: "Scheduled", AgentType: "fake"})
	item, err := service.Create(ctx, session.ID, Input{Prompt: "Inspect", Cadence: Cadence{Kind: "daily", Time: "09:00"}, Timezone: "UTC", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	past := now.Add(-24 * time.Hour)
	if err := database.SetScheduleNextRun(ctx, session.ID, item.ID, &past); err != nil {
		t.Fatal(err)
	}
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	occurrences, err := service.Occurrences(context.Background(), session.ID, item.ID, 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(occurrences) != 0 {
		t.Fatalf("expected no catch-up occurrences, got %d", len(occurrences))
	}
	updated, _ := service.Get(context.Background(), session.ID, item.ID)
	if updated.NextRunAt == nil || !updated.NextRunAt.After(now) {
		t.Fatalf("expected future next run, got %#v", updated.NextRunAt)
	}
}

func openSchedulerTestStore(t *testing.T, ctx context.Context) *store.Store {
	t.Helper()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}
