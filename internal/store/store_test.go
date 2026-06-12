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
	if count != 1 {
		t.Fatalf("expected one recorded migration, got %d", count)
	}
}

func TestCreateSessionPersistsIdleSession(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	created, err := store.CreateSession(ctx, CreateSessionParams{
		Title:     "Inspect repository",
		AgentType: "codex",
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

func TestUpdateSessionStatusSetsCompletedAtForTerminalStatuses(t *testing.T) {
	for _, status := range []SessionStatus{
		SessionStatusCompleted,
		SessionStatusFailed,
		SessionStatusCancelled,
	} {
		t.Run(string(status), func(t *testing.T) {
			ctx := context.Background()
			store := newTestStore(t, ctx)

			completedAt := time.Date(2026, 6, 12, 16, 5, 0, 0, time.UTC)
			session := createTestSession(t, ctx, store)

			store.now = func() time.Time { return completedAt }
			updated, err := store.UpdateSessionStatus(ctx, UpdateSessionStatusParams{
				ID:     session.ID,
				Status: status,
			})
			if err != nil {
				t.Fatalf("update session status: %v", err)
			}

			if updated.Status != status {
				t.Fatalf("expected status %q, got %q", status, updated.Status)
			}
			if updated.CompletedAt == nil {
				t.Fatal("expected completed_at")
			}
			if !updated.CompletedAt.Equal(completedAt) {
				t.Fatalf("expected completed_at %s, got %s", completedAt, *updated.CompletedAt)
			}
			if !updated.UpdatedAt.Equal(completedAt) {
				t.Fatalf("expected updated_at %s, got %s", completedAt, updated.UpdatedAt)
			}
		})
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

	event, err := store.AppendEvent(ctx, AppendEventParams{
		SessionID: sessionID,
		Type:      "agent.message.delta",
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
