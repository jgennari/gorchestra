package maintenance

import (
	"context"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

func TestRunSkipsWhileSessionIsRunning(t *testing.T) {
	database := &fakeMaintenanceStore{running: true}
	service := New(database, 7*24*time.Hour)
	if err := service.Run(context.Background()); err != nil {
		t.Fatalf("run maintenance: %v", err)
	}
	if database.started != 0 || database.batchCalls != 0 {
		t.Fatalf("expected no maintenance writes while running, got %#v", database)
	}
}

func TestRunAggregatesBoundedBatchesAndRetentionCutoff(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	database := &fakeMaintenanceStore{batches: []store.EventMaintenanceBatch{
		{DeletedDeltaEvents: 1000, ReclaimedBytes: 8000, More: true},
		{DeletedDebugEvents: 3, ExtractedBlobEvents: 2, ReclaimedBytes: 1200},
	}}
	service := New(database, 7*24*time.Hour)
	service.now = func() time.Time { return now }
	if err := service.Run(context.Background()); err != nil {
		t.Fatalf("run maintenance: %v", err)
	}
	if database.cutoff == nil || !database.cutoff.Equal(now.Add(-7*24*time.Hour)) {
		t.Fatalf("expected seven-day cutoff, got %v", database.cutoff)
	}
	if database.completed.DeletedDeltaEvents != 1000 ||
		database.completed.DeletedDebugEvents != 3 ||
		database.completed.ExtractedBlobEvents != 2 ||
		database.completed.ReclaimedBytes != 9200 {
		t.Fatalf("unexpected aggregate: %#v", database.completed)
	}
}

type fakeMaintenanceStore struct {
	running    bool
	started    int
	batchCalls int
	batches    []store.EventMaintenanceBatch
	cutoff     *time.Time
	completed  store.EventMaintenanceBatch
}

func (f *fakeMaintenanceStore) HasRunningSession(context.Context) (bool, error) {
	return f.running, nil
}

func (f *fakeMaintenanceStore) EventMaintenanceStatus(context.Context) (store.EventMaintenanceStatus, error) {
	return store.EventMaintenanceStatus{}, nil
}

func (f *fakeMaintenanceStore) StartEventMaintenance(_ context.Context, cutoff *time.Time) error {
	f.started++
	f.cutoff = cutoff
	return nil
}

func (f *fakeMaintenanceStore) RunEventMaintenanceBatch(context.Context, *time.Time, int) (store.EventMaintenanceBatch, error) {
	batch := f.batches[f.batchCalls]
	f.batchCalls++
	return batch, nil
}

func (f *fakeMaintenanceStore) CompleteEventMaintenance(_ context.Context, result store.EventMaintenanceBatch) error {
	f.completed = result
	return nil
}

func (f *fakeMaintenanceStore) FailEventMaintenance(context.Context, error) error {
	return nil
}
