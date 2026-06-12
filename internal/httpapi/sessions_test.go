package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestCreateSessionCreatesIdleFakeAgentSession(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","title":"Inspect repository"}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response createSessionResponse
	decodeJSON(t, rec, &response)
	if response.SessionID == "" {
		t.Fatal("expected session_id")
	}

	session, err := dbStore.GetSession(ctx, response.SessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.AgentType != "fake" {
		t.Fatalf("expected fake agent type, got %q", session.AgentType)
	}
	if session.Title != "Inspect repository" {
		t.Fatalf("expected title Inspect repository, got %q", session.Title)
	}
	if session.Status != store.SessionStatusIdle {
		t.Fatalf("expected idle status, got %q", session.Status)
	}
}

func TestCreateSessionRejectsUnsupportedAgent(t *testing.T) {
	ctx := context.Background()
	_, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"codex"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "unsupported agent_type")
}

func TestCreateSessionRejectsMissingAgentType(t *testing.T) {
	ctx := context.Background()
	_, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"title":"No agent"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "agent_type is required")
}

func TestMessageSubmissionPersistsUserMessageAndMarksSessionRunning(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	dbStore, _, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(func() {
		agent.release()
		waitFor(t, func() bool {
			session, err := dbStore.GetSession(ctx, session.ID)
			return err == nil && session.Status == store.SessionStatusCompleted
		})
	})

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response submitMessageResponse
	decodeJSON(t, rec, &response)
	if response.SessionID != session.ID {
		t.Fatalf("expected session_id %q, got %q", session.ID, response.SessionID)
	}
	if response.Status != string(store.SessionStatusRunning) {
		t.Fatalf("expected response status running, got %q", response.Status)
	}

	updatedSession, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updatedSession.Status != store.SessionStatusRunning {
		t.Fatalf("expected session status running, got %q", updatedSession.Status)
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"user.message.completed"})
	if events[0].Role != "user" {
		t.Fatalf("expected user role, got %q", events[0].Role)
	}
	if events[0].Status != store.EventStatusCompleted {
		t.Fatalf("expected completed user event, got %q", events[0].Status)
	}
	assertPayloadText(t, events[0], "Inspect this repo")
}

func TestSuccessfulFakeAgentRunCompletesSessionAndIsVisibleThroughHistory(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New())

	createRec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","title":"Fake run"}`)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d with body %s", http.StatusCreated, createRec.Code, createRec.Body.String())
	}

	var createResponse createSessionResponse
	decodeJSON(t, createRec, &createResponse)

	messageRec := postJSON(handler, "/api/sessions/"+createResponse.SessionID+"/messages", `{"content":"Inspect this repo"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, createResponse.SessionID)
		return err == nil && session.Status == store.SessionStatusCompleted
	})

	events := listIntegrationEvents(t, ctx, dbStore, createResponse.SessionID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"agent.run.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})
	assertPayloadText(t, events[2], "Received task: Inspect this repo")

	historyReq := httptest.NewRequest(http.MethodGet, "/api/sessions/"+createResponse.SessionID+"/events?after_seq=0", nil)
	historyRec := httptest.NewRecorder()
	handler.ServeHTTP(historyRec, historyReq)

	if historyRec.Code != http.StatusOK {
		t.Fatalf("expected history status %d, got %d with body %s", http.StatusOK, historyRec.Code, historyRec.Body.String())
	}

	var historyResponse eventHistoryResponse
	decodeJSON(t, historyRec, &historyResponse)
	if len(historyResponse.Events) != len(events) {
		t.Fatalf("expected %d history events, got %d", len(events), len(historyResponse.Events))
	}
	if historyResponse.Events[4].Type != "agent.run.completed" {
		t.Fatalf("expected final history event agent.run.completed, got %q", historyResponse.Events[4].Type)
	}
}

func TestFakeAgentErrorEmitsFailedEventAndMarksSessionFailed(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithError(errors.New("planned failure"))))
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Fail this task"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusFailed
	})

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"agent.run.started",
		"agent.run.failed",
	})
	if events[2].Status != store.EventStatusFailed {
		t.Fatalf("expected failed status, got %q", events[2].Status)
	}
	assertPayloadError(t, events[2], "planned failure")
}

func TestMessageSubmissionToRunningSessionReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	if _, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Second message"}`)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session is already running")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events to be appended, got %#v", events)
	}
}

func TestMessageSubmissionToMissingSessionReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	_, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions/sess_missing/messages", `{"content":"Hello"}`)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
}

func TestMessageSubmissionRejectsEmptyContent(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"   "}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "content is required")
}

func TestWriteAPIsRejectMalformedJSON(t *testing.T) {
	ctx := context.Background()
	dbStore, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	for _, test := range []struct {
		name string
		path string
	}{
		{name: "create session", path: "/api/sessions"},
		{name: "submit message", path: "/api/sessions/" + session.ID + "/messages"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec := postJSON(handler, test.path, `{"unterminated"`)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			assertErrorResponse(t, rec, "invalid JSON body")
		})
	}
}

func newIntegrationAPI(t *testing.T, ctx context.Context, agent agents.Agent) (*store.Store, *eventservice.Service, http.Handler) {
	t.Helper()

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

	registry, err := agents.NewRegistry(agent)
	if err != nil {
		t.Fatalf("new agent registry: %v", err)
	}

	handler := NewRouter(Dependencies{
		Store:  dbStore,
		Events: events,
		Agents: registry,
	})

	return dbStore, events, handler
}

func createIntegrationSession(t *testing.T, ctx context.Context, dbStore *store.Store) store.Session {
	t.Helper()

	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Test session",
		AgentType: "fake",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	return session
}

func postJSON(handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func listIntegrationEvents(t *testing.T, ctx context.Context, dbStore *store.Store, sessionID string) []store.Event {
	t.Helper()

	events, err := dbStore.ListEvents(ctx, sessionID, 0, 100)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}

	return events
}

func assertEventTypes(t *testing.T, events []store.Event, want []string) {
	t.Helper()

	if len(events) != len(want) {
		t.Fatalf("expected %d events, got %d: %#v", len(want), len(events), events)
	}
	for i, event := range events {
		if event.Type != want[i] {
			t.Fatalf("expected event %d type %q, got %q", i, want[i], event.Type)
		}
	}
}

func assertPayloadText(t *testing.T, event store.Event, want string) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["text"] != want {
		t.Fatalf("expected payload text %q, got %#v", want, payload["text"])
	}
}

func assertPayloadError(t *testing.T, event store.Event, want string) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["error"] != want {
		t.Fatalf("expected payload error %q, got %#v", want, payload["error"])
	}
}

func decodeEventPayload(t *testing.T, event store.Event) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}

	return payload
}

type blockingAgent struct {
	started  chan agents.AgentInput
	releasec chan struct{}
	once     sync.Once
}

func newBlockingAgent() *blockingAgent {
	return &blockingAgent{
		started:  make(chan agents.AgentInput, 1),
		releasec: make(chan struct{}),
	}
}

func (a *blockingAgent) Type() string {
	return "fake"
}

func (a *blockingAgent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	a.started <- input
	select {
	case <-a.releasec:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *blockingAgent) release() {
	a.once.Do(func() {
		close(a.releasec)
	})
}
