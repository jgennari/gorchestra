package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestMigrationsRunAgainstEmptyDatabase(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	assertTableExists(t, ctx, store, "schema_migrations")
	assertTableExists(t, ctx, store, "sessions")
	assertTableExists(t, ctx, store, "events")
	assertColumnExists(t, ctx, store, "sessions", "provider_session_id")
	assertColumnExists(t, ctx, store, "sessions", "workspace_path")
}

func TestMigrationsAreIdempotent(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("migrate second time: %v", err)
	}

	var count int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != 6 {
		t.Fatalf("expected six recorded migrations, got %d", count)
	}
}

func TestProviderSessionIDMigrationBackfillsFromCodexRunStartedEvents(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	now := formatTime(time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC))
	_, err = db.ExecContext(ctx, `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at DATETIME NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  completed_at DATETIME,
  archived_at DATETIME
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_events_session_seq ON events(session_id, seq);
INSERT INTO schema_migrations (version, name, applied_at)
  VALUES (1, '001_initial.sql', ?), (2, '002_collapse_terminal_session_statuses.sql', ?), (3, '003_archive_sessions.sql', ?);
INSERT INTO sessions (id, title, agent_type, status, created_at, updated_at)
  VALUES ('sess_codex', 'Codex', 'codex', 'idle', ?, ?);
INSERT INTO events (id, session_id, seq, type, role, status, payload_json, created_at)
  VALUES
    ('evt_1', 'sess_codex', 1, 'agent.run.started', 'assistant', 'started', '{"provider":"codex","thread_id":"thread_first"}', ?),
    ('evt_2', 'sess_codex', 2, 'agent.run.started', 'assistant', 'started', '{"provider":"codex","thread_id":"thread_second"}', ?);
`, now, now, now, now, now, now, now)
	if err != nil {
		_ = db.Close()
		t.Fatalf("seed legacy db: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	store, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open migrated store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})

	session, err := store.GetSession(ctx, "sess_codex")
	if err != nil {
		t.Fatalf("get migrated session: %v", err)
	}
	if session.ProviderSessionID != "thread_first" {
		t.Fatalf("expected provider session id thread_first, got %q", session.ProviderSessionID)
	}
}

func TestProviderSessionIDMigrationRepairsAbandonedProviderStateMigration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-provider-state.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	now := formatTime(time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC))
	_, err = db.ExecContext(ctx, `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at DATETIME NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  completed_at DATETIME,
  archived_at DATETIME
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE session_provider_state (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY(session_id, provider)
);
CREATE INDEX idx_events_session_seq ON events(session_id, seq);
INSERT INTO schema_migrations (version, name, applied_at)
  VALUES
    (1, '001_initial.sql', ?),
    (2, '002_collapse_terminal_session_statuses.sql', ?),
    (3, '003_archive_sessions.sql', ?),
    (4, '004_session_provider_state.sql', ?);
INSERT INTO sessions (id, title, agent_type, status, created_at, updated_at)
  VALUES ('sess_codex', 'Codex', 'codex', 'idle', ?, ?);
INSERT INTO events (id, session_id, seq, type, role, status, payload_json, created_at)
  VALUES ('evt_1', 'sess_codex', 1, 'agent.run.started', 'assistant', 'started', '{"provider":"codex","thread_id":"thread_first"}', ?);
INSERT INTO session_provider_state (session_id, provider, provider_session_id, created_at, updated_at)
  VALUES ('sess_codex', 'codex', 'thread_old_table', ?, ?);
`, now, now, now, now, now, now, now, now, now)
	if err != nil {
		_ = db.Close()
		t.Fatalf("seed legacy db: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	store, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open migrated store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})

	assertColumnExists(t, ctx, store, "sessions", "provider_session_id")
	assertTableNotExists(t, ctx, store, "session_provider_state")

	session, err := store.GetSession(ctx, "sess_codex")
	if err != nil {
		t.Fatalf("get migrated session: %v", err)
	}
	if session.ProviderSessionID != "thread_first" {
		t.Fatalf("expected provider session id thread_first, got %q", session.ProviderSessionID)
	}
}

func TestCreateSessionPersistsIdleSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	created, err := store.CreateSession(ctx, CreateSessionParams{
		Title:         "Inspect repository",
		AgentType:     "codex",
		WorkspacePath: "/tmp/gorchestra-workspace",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	if created.ID == "" {
		t.Fatal("expected session ID")
	}
	if created.Status != SessionStatusIdle {
		t.Fatalf("expected idle status, got %q", created.Status)
	}
	if created.CompletedAt != nil {
		t.Fatal("expected no completed_at")
	}
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatal("expected timestamps")
	}
	if created.WorkspacePath != "/tmp/gorchestra-workspace" {
		t.Fatalf("expected workspace path, got %q", created.WorkspacePath)
	}

	persisted, err := store.GetSession(ctx, created.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}

	if persisted.ID != created.ID {
		t.Fatalf("expected persisted ID %q, got %q", created.ID, persisted.ID)
	}
	if persisted.Title != "Inspect repository" {
		t.Fatalf("expected title, got %q", persisted.Title)
	}
	if persisted.AgentType != "codex" {
		t.Fatalf("expected agent type codex, got %q", persisted.AgentType)
	}
	if persisted.Status != SessionStatusIdle {
		t.Fatalf("expected idle status, got %q", persisted.Status)
	}
	if persisted.WorkspacePath != "/tmp/gorchestra-workspace" {
		t.Fatalf("expected persisted workspace path, got %q", persisted.WorkspacePath)
	}
	if persisted.EventCount != 0 {
		t.Fatalf("expected no events for new session, got %d", persisted.EventCount)
	}
}

func TestCreateSessionRejectsEmptyAgentType(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	_, err := store.CreateSession(ctx, CreateSessionParams{Title: "Missing agent"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected ErrInvalidArgument, got %v", err)
	}
}

func TestListSessionsReturnsMostRecentlyUpdatedFirst(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	firstAt := time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC)
	secondAt := firstAt.Add(time.Minute)
	thirdAt := firstAt.Add(2 * time.Minute)
	updatedAt := firstAt.Add(5 * time.Minute)

	store.now = func() time.Time { return firstAt }
	first := createTestSessionWithTitle(t, ctx, store, "First")
	store.now = func() time.Time { return secondAt }
	second := createTestSessionWithTitle(t, ctx, store, "Second")
	store.now = func() time.Time { return thirdAt }
	third := createTestSessionWithTitle(t, ctx, store, "Third")
	store.now = func() time.Time { return updatedAt }
	if _, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     first.ID,
		Status: SessionStatusRunning,
	}); err != nil {
		t.Fatalf("update first session: %v", err)
	}

	sessions, err := store.ListSessions(ctx, ListSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}

	assertSessionIDs(t, sessions, []string{first.ID, third.ID, second.ID})
}

func TestListSessionsHonorsLimit(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	store.now = func() time.Time { return time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC) }
	first := createTestSessionWithTitle(t, ctx, store, "First")
	store.now = func() time.Time { return time.Date(2026, 6, 12, 16, 1, 0, 0, time.UTC) }
	second := createTestSessionWithTitle(t, ctx, store, "Second")
	store.now = func() time.Time { return time.Date(2026, 6, 12, 16, 2, 0, 0, time.UTC) }
	third := createTestSessionWithTitle(t, ctx, store, "Third")

	sessions, err := store.ListSessions(ctx, ListSessionsParams{Limit: 2})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}

	assertSessionIDs(t, sessions, []string{third.ID, second.ID})
	if hasSessionID(sessions, first.ID) {
		t.Fatalf("expected limited result not to include first session: %#v", sessions)
	}
}

func TestListSessionsFiltersByStatus(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	idle := createTestSessionWithTitle(t, ctx, store, "Idle")
	running := createTestSessionWithTitle(t, ctx, store, "Running")
	failed := createTestSessionWithTitle(t, ctx, store, "Failed")
	if _, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     running.ID,
		Status: SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}
	if _, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     failed.ID,
		Status: SessionStatusFailed,
	}); err != nil {
		t.Fatalf("mark failed: %v", err)
	}

	sessions, err := store.ListSessions(ctx, ListSessionsParams{Status: SessionStatusRunning})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}

	assertSessionIDs(t, sessions, []string{running.ID})
	if hasSessionID(sessions, idle.ID) || hasSessionID(sessions, failed.ID) {
		t.Fatalf("expected only running session, got %#v", sessions)
	}
}

func TestArchiveSessionHidesSessionFromLists(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	archiveAt := time.Date(2026, 6, 12, 16, 5, 0, 0, time.UTC)
	visible := createTestSessionWithTitle(t, ctx, store, "Visible")
	archived := createTestSessionWithTitle(t, ctx, store, "Archived")

	store.now = func() time.Time { return archiveAt }
	updated, err := store.ArchiveSession(ctx, ArchiveSessionParams{ID: archived.ID})
	if err != nil {
		t.Fatalf("archive session: %v", err)
	}
	if updated.ArchivedAt == nil {
		t.Fatal("expected archived_at")
	}
	if !updated.ArchivedAt.Equal(archiveAt) {
		t.Fatalf("expected archived_at %s, got %s", archiveAt, *updated.ArchivedAt)
	}
	if !updated.UpdatedAt.Equal(archiveAt) {
		t.Fatalf("expected updated_at %s, got %s", archiveAt, updated.UpdatedAt)
	}

	sessions, err := store.ListSessions(ctx, ListSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	assertSessionIDs(t, sessions, []string{visible.ID})

	persisted, err := store.GetSession(ctx, archived.ID)
	if err != nil {
		t.Fatalf("get archived session: %v", err)
	}
	if persisted.ArchivedAt == nil {
		t.Fatal("expected get session to return archived_at")
	}
}

func TestArchiveSessionReturnsNotFoundForMissingSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	_, err := store.ArchiveSession(ctx, ArchiveSessionParams{ID: "sess_missing"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestSetSessionProviderSessionIDPersistsThreadID(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	updated, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_1",
	})
	if err != nil {
		t.Fatalf("set provider session id: %v", err)
	}
	if updated.ProviderSessionID != "thread_1" {
		t.Fatalf("expected provider session id thread_1, got %q", updated.ProviderSessionID)
	}

	persisted, err := store.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if persisted.ProviderSessionID != "thread_1" {
		t.Fatalf("expected persisted provider session id thread_1, got %q", persisted.ProviderSessionID)
	}
}

func TestSetSessionProviderSessionIDRejectsDifferentExistingID(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	if _, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_1",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}

	_, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_2",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected ErrInvalidArgument, got %v", err)
	}
}

func TestSetSessionProviderSessionIDCanReplaceExistingID(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	if _, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_1",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}

	updated, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_2",
		Replace:           true,
	})
	if err != nil {
		t.Fatalf("replace provider session id: %v", err)
	}
	if updated.ProviderSessionID != "thread_2" {
		t.Fatalf("expected provider session id thread_2, got %q", updated.ProviderSessionID)
	}
}

func TestClearSessionProviderSessionID(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	if _, err := store.SetSessionProviderSessionID(ctx, SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_1",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}

	updated, err := store.ClearSessionProviderSessionID(ctx, ClearSessionProviderSessionIDParams{ID: session.ID})
	if err != nil {
		t.Fatalf("clear provider session id: %v", err)
	}
	if updated.ProviderSessionID != "" {
		t.Fatalf("expected provider session id to be cleared, got %q", updated.ProviderSessionID)
	}
}

func TestUpdateSessionTitleTrimsTitleAndUpdatesTimestamp(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	createdAt := time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC)
	updatedAt := createdAt.Add(10 * time.Minute)
	store.now = func() time.Time { return createdAt }
	session := createTestSessionWithTitle(t, ctx, store, "Old title")

	store.now = func() time.Time { return updatedAt }
	updated, err := store.UpdateSessionTitle(ctx, UpdateSessionTitleParams{
		ID:    session.ID,
		Title: "  New title  ",
	})
	if err != nil {
		t.Fatalf("update title: %v", err)
	}

	if updated.Title != "New title" {
		t.Fatalf("expected trimmed title, got %q", updated.Title)
	}
	if !updated.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("expected updated_at %s, got %s", updatedAt, updated.UpdatedAt)
	}
}

func TestUpdateSessionTitleAllowsEmptyTitle(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSessionWithTitle(t, ctx, store, "Old title")

	updated, err := store.UpdateSessionTitle(ctx, UpdateSessionTitleParams{
		ID:    session.ID,
		Title: "   ",
	})
	if err != nil {
		t.Fatalf("update title: %v", err)
	}

	if updated.Title != "" {
		t.Fatalf("expected empty title, got %q", updated.Title)
	}
}

func TestUpdateSessionAgentOptions(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	updated, err := store.UpdateSessionAgentOptions(ctx, UpdateSessionAgentOptionsParams{
		ID:           session.ID,
		AgentOptions: json.RawMessage(`{"codex":{"run_dangerously":true}}`),
	})
	if err != nil {
		t.Fatalf("update agent options: %v", err)
	}
	if string(updated.AgentOptions) != `{"codex":{"run_dangerously":true}}` {
		t.Fatalf("expected agent options to be updated, got %s", updated.AgentOptions)
	}
}

func TestUpdateSessionTitleReturnsNotFoundForMissingSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	_, err := store.UpdateSessionTitle(ctx, UpdateSessionTitleParams{
		ID:    "sess_missing",
		Title: "New title",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestUpdateSessionStatusSetsRunningAndUpdatedAt(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	createdAt := time.Date(2026, 6, 12, 16, 0, 0, 0, time.UTC)
	runningAt := createdAt.Add(2 * time.Minute)
	store.now = func() time.Time { return createdAt }
	session := createTestSession(t, ctx, store)

	store.now = func() time.Time { return runningAt }
	updated, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     session.ID,
		Status: SessionStatusRunning,
	})
	if err != nil {
		t.Fatalf("update session status: %v", err)
	}

	if updated.Status != SessionStatusRunning {
		t.Fatalf("expected running status, got %q", updated.Status)
	}
	if !updated.UpdatedAt.Equal(runningAt) {
		t.Fatalf("expected updated_at %s, got %s", runningAt, updated.UpdatedAt)
	}
	if updated.CompletedAt != nil {
		t.Fatal("expected no completed_at for running session")
	}
}

func TestUpdateSessionStatusSetsCompletedAtForFailedStatus(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	failedAt := time.Date(2026, 6, 12, 16, 5, 0, 0, time.UTC)
	session := createTestSession(t, ctx, store)

	store.now = func() time.Time { return failedAt }
	updated, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     session.ID,
		Status: SessionStatusFailed,
	})
	if err != nil {
		t.Fatalf("update session status: %v", err)
	}

	if updated.Status != SessionStatusFailed {
		t.Fatalf("expected failed status, got %q", updated.Status)
	}
	if updated.CompletedAt == nil {
		t.Fatal("expected completed_at")
	}
	if !updated.CompletedAt.Equal(failedAt) {
		t.Fatalf("expected completed_at %s, got %s", failedAt, *updated.CompletedAt)
	}
	if !updated.UpdatedAt.Equal(failedAt) {
		t.Fatalf("expected updated_at %s, got %s", failedAt, updated.UpdatedAt)
	}
}

func TestUpdateSessionStatusClearsCompletedAtForIdleStatus(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	failedAt := time.Date(2026, 6, 12, 16, 5, 0, 0, time.UTC)
	idleAt := failedAt.Add(time.Minute)
	session := createTestSession(t, ctx, store)

	store.now = func() time.Time { return failedAt }
	if _, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     session.ID,
		Status: SessionStatusFailed,
	}); err != nil {
		t.Fatalf("mark failed: %v", err)
	}

	store.now = func() time.Time { return idleAt }
	updated, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     session.ID,
		Status: SessionStatusIdle,
	})
	if err != nil {
		t.Fatalf("mark idle: %v", err)
	}

	if updated.Status != SessionStatusIdle {
		t.Fatalf("expected idle status, got %q", updated.Status)
	}
	if updated.CompletedAt != nil {
		t.Fatalf("expected completed_at to be cleared, got %s", updated.CompletedAt)
	}
}

func TestUpdateSessionStatusFailsForMissingSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	_, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
		ID:     "sess_missing",
		Status: SessionStatusRunning,
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestUpdateSessionStatusRejectsInvalidArguments(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	for _, params := range []UpdateSessionStatusParams{
		{Status: SessionStatusRunning},
		{ID: "sess_test"},
		{ID: "sess_test", Status: "completed"},
	} {
		_, err := store.UpdateSessionStatus(ctx, params)
		if !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("expected ErrInvalidArgument for params %#v, got %v", params, err)
		}
	}
}

func TestAppendEventAssignsFirstSequence(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	event := appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	if event.Seq != 1 {
		t.Fatalf("expected seq 1, got %d", event.Seq)
	}
	if event.ID == "" {
		t.Fatal("expected event ID")
	}
	if event.SessionID != session.ID {
		t.Fatalf("expected session ID %q, got %q", session.ID, event.SessionID)
	}
	if event.CreatedAt.IsZero() {
		t.Fatal("expected created_at")
	}
	assertJSONEqual(t, event.Payload, json.RawMessage(`{"text":"one"}`))
}

func TestAppendEventAssignsConsecutiveSequences(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	first := appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	second := appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)

	if first.Seq != 1 || second.Seq != 2 {
		t.Fatalf("expected seqs 1 and 2, got %d and %d", first.Seq, second.Seq)
	}
}

func TestAppendEventSequencesAreIndependentPerSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	firstSession := createTestSession(t, ctx, store)
	secondSession := createTestSession(t, ctx, store)

	firstEvent := appendTestEvent(t, ctx, store, firstSession.ID, `{"text":"one"}`)
	secondEvent := appendTestEvent(t, ctx, store, secondSession.ID, `{"text":"one"}`)

	if firstEvent.Seq != 1 {
		t.Fatalf("expected first session seq 1, got %d", firstEvent.Seq)
	}
	if secondEvent.Seq != 1 {
		t.Fatalf("expected second session seq 1, got %d", secondEvent.Seq)
	}
}

func TestAppendEventFailsForMissingSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	_, err := store.AppendEvent(ctx, AppendEventParams{
		SessionID: "sess_missing",
		Type:      "agent.message.delta",
		Role:      "assistant",
		Status:    EventStatusDelta,
		Payload:   json.RawMessage(`{"text":"missing"}`),
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestListEventsReturnsEventsOrderedByAscendingSequence(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"three"}`)

	events, err := store.ListEvents(ctx, session.ID, 0, 0)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}

	assertSeqs(t, events, []int64{1, 2, 3})
}

func TestSessionReadsIncludeActivityCounts(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEventWithType(t, ctx, store, session.ID, "tool.call.started", `{"item_id":"tool_1"}`)
	appendTestEventWithType(t, ctx, store, session.ID, "tool.call.completed", `{"item_id":"tool_1"}`)
	appendTestEventWithType(t, ctx, store, session.ID, "file.change.started", `{"item_id":"edit_1"}`)
	appendTestEventWithType(t, ctx, store, session.ID, "file.change.completed", `{"item_id":"edit_1"}`)

	persisted, err := store.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if persisted.EventCount != 5 {
		t.Fatalf("expected event count 5, got %d", persisted.EventCount)
	}
	if persisted.ToolCount != 2 {
		t.Fatalf("expected tool count 2, got %d", persisted.ToolCount)
	}

	sessions, err := store.ListSessions(ctx, ListSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].EventCount != 5 || sessions[0].ToolCount != 2 {
		t.Fatalf("expected listed session activity counts, got %#v", sessions)
	}
}

func TestListEventsHonorsAfterSeq(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"three"}`)

	events, err := store.ListEvents(ctx, session.ID, 1, 0)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}

	assertSeqs(t, events, []int64{2, 3})
}

func TestListEventsHonorsLimit(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"three"}`)

	events, err := store.ListEvents(ctx, session.ID, 0, 2)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}

	assertSeqs(t, events, []int64{1, 2})
}

func TestListRecentEventsReturnsTailInAscendingSequence(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"three"}`)

	events, err := store.ListRecentEvents(ctx, session.ID, 2)
	if err != nil {
		t.Fatalf("list recent events: %v", err)
	}

	assertSeqs(t, events, []int64{2, 3})
}

func TestListEventsBeforeReturnsPreviousPageInAscendingSequence(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"two"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"three"}`)
	appendTestEvent(t, ctx, store, session.ID, `{"text":"four"}`)

	events, err := store.ListEventsBefore(ctx, session.ID, 4, 2)
	if err != nil {
		t.Fatalf("list events before: %v", err)
	}

	assertSeqs(t, events, []int64{2, 3})
}

func TestListEventsBeforeReturnsEmptyAtBoundary(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)

	appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)

	events, err := store.ListEventsBefore(ctx, session.ID, 1, 2)
	if err != nil {
		t.Fatalf("list events before: %v", err)
	}

	assertSeqs(t, events, []int64{})
}

func TestConcurrentAppendsProduceUniqueContiguousSequences(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)
	const appendCount = 50

	errc := make(chan error, appendCount)
	seqc := make(chan int64, appendCount)
	for i := 0; i < appendCount; i++ {
		go func() {
			event, err := store.AppendEvent(ctx, AppendEventParams{
				SessionID: session.ID,
				Type:      "agent.message.delta",
				Role:      "assistant",
				Status:    EventStatusDelta,
				Payload:   json.RawMessage(`{"text":"concurrent"}`),
			})
			if err != nil {
				errc <- err
				return
			}
			seqc <- event.Seq
			errc <- nil
		}()
	}

	seqs := make([]int64, 0, appendCount)
	for i := 0; i < appendCount; i++ {
		if err := <-errc; err != nil {
			t.Fatalf("append event: %v", err)
		}
		seqs = append(seqs, <-seqc)
	}

	sort.Slice(seqs, func(i, j int) bool {
		return seqs[i] < seqs[j]
	})
	for i, seq := range seqs {
		want := int64(i + 1)
		if seq != want {
			t.Fatalf("expected contiguous seq %d at index %d, got %d; all seqs: %v", want, i, seq, seqs)
		}
	}
}

func TestDuplicateEventSequenceIsRejectedByConstraint(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)
	session := createTestSession(t, ctx, store)
	event := appendTestEvent(t, ctx, store, session.ID, `{"text":"one"}`)

	_, err := store.db.ExecContext(
		ctx,
		`INSERT INTO events (id, session_id, seq, type, role, status, payload_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		"evt_duplicate",
		session.ID,
		event.Seq,
		"agent.message.delta",
		"assistant",
		string(EventStatusDelta),
		`{"text":"duplicate"}`,
		formatTime(store.now()),
	)
	if err == nil {
		t.Fatal("expected duplicate sequence insert to fail")
	}
}

func newTestStore(t *testing.T, ctx context.Context) *Store {
	t.Helper()

	path := filepath.Join(t.TempDir(), "test.db")
	store, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})

	return store
}

func createTestSession(t *testing.T, ctx context.Context, store *Store) Session {
	t.Helper()

	return createTestSessionWithTitle(t, ctx, store, "Test session")
}

func createTestSessionWithTitle(t *testing.T, ctx context.Context, store *Store, title string) Session {
	t.Helper()

	session, err := store.CreateSession(ctx, CreateSessionParams{
		Title:     title,
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	return session
}

func assertSessionIDs(t *testing.T, sessions []Session, want []string) {
	t.Helper()

	if len(sessions) != len(want) {
		t.Fatalf("expected %d sessions, got %d: %#v", len(want), len(sessions), sessions)
	}
	for i, session := range sessions {
		if session.ID != want[i] {
			t.Fatalf("expected session %d ID %q, got %q", i, want[i], session.ID)
		}
	}
}

func hasSessionID(sessions []Session, id string) bool {
	for _, session := range sessions {
		if session.ID == id {
			return true
		}
	}
	return false
}

func appendTestEvent(t *testing.T, ctx context.Context, store *Store, sessionID string, payload string) Event {
	t.Helper()
	return appendTestEventWithType(t, ctx, store, sessionID, "agent.message.delta", payload)
}

func appendTestEventWithType(t *testing.T, ctx context.Context, store *Store, sessionID string, eventType string, payload string) Event {
	t.Helper()

	event, err := store.AppendEvent(ctx, AppendEventParams{
		SessionID: sessionID,
		Type:      eventType,
		Role:      "assistant",
		Status:    EventStatusDelta,
		Payload:   json.RawMessage(payload),
	})
	if err != nil {
		t.Fatalf("append event: %v", err)
	}

	return event
}

func assertTableExists(t *testing.T, ctx context.Context, store *Store, name string) {
	t.Helper()

	var tableName string
	err := store.db.QueryRowContext(
		ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(&tableName)
	if errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected table %s to exist", name)
	}
	if err != nil {
		t.Fatalf("query table %s: %v", name, err)
	}
}

func assertTableNotExists(t *testing.T, ctx context.Context, store *Store, name string) {
	t.Helper()

	var tableName string
	err := store.db.QueryRowContext(
		ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(&tableName)
	if errors.Is(err, sql.ErrNoRows) {
		return
	}
	if err != nil {
		t.Fatalf("query table %s: %v", name, err)
	}
	t.Fatalf("expected table %s not to exist", name)
}

func assertColumnExists(t *testing.T, ctx context.Context, store *Store, table string, column string) {
	t.Helper()

	rows, err := store.db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		t.Fatalf("query columns for %s: %v", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan column for %s: %v", table, err)
		}
		if name == column {
			return
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("columns rows for %s: %v", table, err)
	}
	t.Fatalf("expected column %s.%s to exist", table, column)
}

func assertSeqs(t *testing.T, events []Event, want []int64) {
	t.Helper()

	if len(events) != len(want) {
		t.Fatalf("expected %d events, got %d", len(want), len(events))
	}

	for i, event := range events {
		if event.Seq != want[i] {
			t.Fatalf("expected seq %d at index %d, got %d", want[i], i, event.Seq)
		}
	}
}

func assertJSONEqual(t *testing.T, got json.RawMessage, want json.RawMessage) {
	t.Helper()

	var gotValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("unmarshal got JSON: %v", err)
	}
	var wantValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("unmarshal want JSON: %v", err)
	}

	if fmtJSON(gotValue) != fmtJSON(wantValue) {
		t.Fatalf("expected JSON %s, got %s", want, got)
	}
}

func fmtJSON(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(body)
}
