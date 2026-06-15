package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

const testSessionID = "sess_test"

var testCreatedAt = time.Date(2026, 6, 12, 16, 0, 0, 123456789, time.FixedZone("EDT", -4*60*60))

func TestHealthRoute(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()

	NewRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}

	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Fatalf("expected health response %q, got %q", `{"status":"ok"}`, got)
	}

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected content type application/json, got %q", got)
	}
}

func TestStaticAssetsServeIndexAndFrontendRoutes(t *testing.T) {
	handler := NewRouter(Dependencies{StaticAssets: testStaticAssets()})

	for _, route := range []string{"/", "/sessions/sess_123", "/sessions/sess_123/files/src/main.go"} {
		t.Run(route, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); !strings.Contains(got, `<div id="root"></div>`) {
				t.Fatalf("expected index.html body, got %q", got)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
				t.Fatalf("expected text/html content type, got %q", got)
			}
		})
	}
}

func TestStaticAssetsServeFilesWithContentTypes(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{StaticAssets: testStaticAssets()}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); !strings.Contains(got, "console.log") {
		t.Fatalf("expected javascript body, got %q", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "javascript") {
		t.Fatalf("expected javascript content type, got %q", got)
	}
}

func TestStaticAssetsDoNotFallbackForMissingAssetFiles(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{StaticAssets: testStaticAssets()}).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestAPIRoutePrecedenceAndMissingAPIRoute(t *testing.T) {
	handler := NewRouter(Dependencies{StaticAssets: testStaticAssets()})

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("expected health status %d, got %d", http.StatusOK, health.Code)
	}
	if got := strings.TrimSpace(health.Body.String()); got != `{"status":"ok"}` {
		t.Fatalf("expected API health response, got %q", got)
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("expected missing API status %d, got %d", http.StatusNotFound, missing.Code)
	}
	assertErrorResponse(t, missing, "not found")
}

func TestListSessionsReturnsMostRecentlyUpdatedFirst(t *testing.T) {
	fakeStore := newFakeHTTPStore()
	oldUpdatedAt := testCreatedAt.Add(-10 * time.Minute)
	newUpdatedAt := testCreatedAt.Add(5 * time.Minute)
	fakeStore.addSessionWith(store.Session{
		ID:        "sess_old",
		Title:     "Old session",
		AgentType: "fake",
		Status:    store.SessionStatusIdle,
		CreatedAt: oldUpdatedAt,
		UpdatedAt: oldUpdatedAt,
	})
	fakeStore.addSessionWith(store.Session{
		ID:        "sess_new",
		Title:     "New session",
		AgentType: "codex",
		Status:    store.SessionStatusRunning,
		CreatedAt: testCreatedAt,
		UpdatedAt: newUpdatedAt,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/sessions?limit=10", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: fakeStore}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response listSessionsResponse
	decodeJSON(t, rec, &response)
	if len(response.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %#v", response.Sessions)
	}
	if response.Sessions[0].ID != "sess_new" || response.Sessions[1].ID != "sess_old" {
		t.Fatalf("expected sessions sorted newest first, got %#v", response.Sessions)
	}
	if response.Sessions[0].UpdatedAt != newUpdatedAt.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("expected UTC updated_at, got %q", response.Sessions[0].UpdatedAt)
	}
}

func testStaticAssets() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {
			Data: []byte(`<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`),
		},
		"assets/app.js": {
			Data: []byte(`console.log("gorchestra")`),
		},
	}
}

func TestListSessionsAppliesDefaultAndCapsLimit(t *testing.T) {
	for _, test := range []struct {
		name      string
		query     string
		wantLimit int
	}{
		{name: "default", query: "", wantLimit: defaultSessionLimit},
		{name: "cap", query: "?limit=5000", wantLimit: maxSessionLimit},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newFakeHTTPStore()
			store.addSession(testSessionID)
			req := httptest.NewRequest(http.MethodGet, "/api/sessions"+test.query, nil)
			rec := httptest.NewRecorder()

			NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
			}
			if got := store.lastListSessionsLimit(t); got != test.wantLimit {
				t.Fatalf("expected list sessions limit %d, got %d", test.wantLimit, got)
			}
		})
	}
}

func TestListSessionsRejectsInvalidLimit(t *testing.T) {
	for _, limit := range []string{"-1", "nope"} {
		t.Run(limit, func(t *testing.T) {
			store := newFakeHTTPStore()
			req := httptest.NewRequest(http.MethodGet, "/api/sessions?limit="+limit, nil)
			rec := httptest.NewRecorder()

			NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			assertErrorResponse(t, rec, "limit must be a non-negative integer")
			if got := store.listSessionsCallCount(); got != 0 {
				t.Fatalf("expected no list sessions calls, got %d", got)
			}
		})
	}
}

func TestListSessionsFiltersByStatus(t *testing.T) {
	fakeStore := newFakeHTTPStore()
	fakeStore.addSessionWith(store.Session{
		ID:        "sess_running",
		Title:     "Running session",
		AgentType: "fake",
		Status:    store.SessionStatusRunning,
		CreatedAt: testCreatedAt,
		UpdatedAt: testCreatedAt,
	})
	fakeStore.addSessionWith(store.Session{
		ID:        "sess_failed",
		Title:     "Failed session",
		AgentType: "fake",
		Status:    store.SessionStatusFailed,
		CreatedAt: testCreatedAt,
		UpdatedAt: testCreatedAt,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/sessions?status=running", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: fakeStore}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := fakeStore.lastListSessionsStatus(t); got != store.SessionStatusRunning {
		t.Fatalf("expected status filter running, got %q", got)
	}

	var response listSessionsResponse
	decodeJSON(t, rec, &response)
	if len(response.Sessions) != 1 || response.Sessions[0].ID != "sess_running" {
		t.Fatalf("expected only running session, got %#v", response.Sessions)
	}
}

func TestListSessionsRejectsInvalidStatus(t *testing.T) {
	for _, status := range []string{"paused", "completed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			fakeStore := newFakeHTTPStore()
			req := httptest.NewRequest(http.MethodGet, "/api/sessions?status="+status, nil)
			rec := httptest.NewRecorder()

			NewRouter(Dependencies{Store: fakeStore}).ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			assertErrorResponse(t, rec, "status is unsupported")
			if got := fakeStore.listSessionsCallCount(); got != 0 {
				t.Fatalf("expected no list sessions calls, got %d", got)
			}
		})
	}
}

func TestGetSessionReturnsSession(t *testing.T) {
	fakeStore := newFakeHTTPStore()
	fakeStore.addSessionWith(store.Session{
		ID:        testSessionID,
		Title:     "Inspect repository",
		AgentType: "codex",
		Status:    store.SessionStatusIdle,
		CreatedAt: testCreatedAt,
		UpdatedAt: testCreatedAt,
	})
	fakeStore.setEvents(
		testSessionID,
		testEvent(1, "agent.message.delta"),
		testEvent(2, "tool.call.started"),
		testEvent(3, "tool.call.completed"),
		testEvent(4, "file.change.started"),
		testEvent(5, "file.change.completed"),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID, nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: fakeStore}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response sessionResponse
	decodeJSON(t, rec, &response)
	if response.ID != testSessionID || response.AgentType != "codex" || response.Status != string(store.SessionStatusIdle) {
		t.Fatalf("unexpected session response: %#v", response)
	}
	if response.CompletedAt != nil {
		t.Fatalf("expected no completed_at for idle session, got %#v", response.CompletedAt)
	}
	if response.EventCount != 5 {
		t.Fatalf("expected event_count 5, got %d", response.EventCount)
	}
	if response.ToolCount != 2 {
		t.Fatalf("expected tool_count 2, got %d", response.ToolCount)
	}
}

func TestGetSessionReturns404ForUnknownSession(t *testing.T) {
	store := newFakeHTTPStore()
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/missing", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
}

func TestEventHistoryReturnsEventsAfterSeq(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(
		testSessionID,
		testEvent(1, "agent.message.delta"),
		testEvent(2, "agent.tool.started"),
		testEvent(3, "agent.tool.completed"),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?after_seq=1&limit=10", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response eventHistoryResponse
	decodeJSON(t, rec, &response)

	if got, want := len(response.Events), 2; got != want {
		t.Fatalf("expected %d events, got %d: %#v", want, got, response.Events)
	}
	if response.Events[0].Seq != 2 || response.Events[1].Seq != 3 {
		t.Fatalf("expected seqs [2 3], got [%d %d]", response.Events[0].Seq, response.Events[1].Seq)
	}
	if got := response.Events[0].CreatedAt; got != testCreatedAt.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("expected UTC created_at %q, got %q", testCreatedAt.UTC().Format(time.RFC3339Nano), got)
	}

	var payload map[string]string
	if err := json.Unmarshal(response.Events[0].Payload, &payload); err != nil {
		t.Fatalf("expected payload to be JSON object: %v", err)
	}
	if got := payload["text"]; got != "event 2" {
		t.Fatalf("expected payload text %q, got %q", "event 2", got)
	}
}

func TestEventHistoryAppliesDefaultLimit(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	call := store.lastListCall(t)
	if call.afterSeq != 0 {
		t.Fatalf("expected default after_seq 0, got %d", call.afterSeq)
	}
	if call.limit != defaultEventLimit {
		t.Fatalf("expected default limit %d, got %d", defaultEventLimit, call.limit)
	}
}

func TestEventHistoryCapsLargeLimit(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?limit=5000", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	call := store.lastListCall(t)
	if call.limit != maxEventLimit {
		t.Fatalf("expected capped limit %d, got %d", maxEventLimit, call.limit)
	}
}

func TestEventHistoryTailReturnsRecentEvents(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(
		testSessionID,
		testEvent(1, "agent.message.delta"),
		testEvent(2, "agent.message.delta"),
		testEvent(3, "agent.message.completed"),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?tail=true&limit=2", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response eventHistoryResponse
	decodeJSON(t, rec, &response)

	if got, want := len(response.Events), 2; got != want {
		t.Fatalf("expected %d events, got %d: %#v", want, got, response.Events)
	}
	if response.Events[0].Seq != 2 || response.Events[1].Seq != 3 {
		t.Fatalf("expected seqs [2 3], got [%d %d]", response.Events[0].Seq, response.Events[1].Seq)
	}
	call := store.lastListCall(t)
	if call.mode != "tail" {
		t.Fatalf("expected tail event list mode, got %q", call.mode)
	}
}

func TestEventHistoryBeforeSeqReturnsPreviousEvents(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(
		testSessionID,
		testEvent(1, "agent.message.delta"),
		testEvent(2, "agent.message.delta"),
		testEvent(3, "agent.message.delta"),
		testEvent(4, "agent.message.completed"),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?before_seq=4&limit=2", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response eventHistoryResponse
	decodeJSON(t, rec, &response)

	if got, want := len(response.Events), 2; got != want {
		t.Fatalf("expected %d events, got %d: %#v", want, got, response.Events)
	}
	if response.Events[0].Seq != 2 || response.Events[1].Seq != 3 {
		t.Fatalf("expected seqs [2 3], got [%d %d]", response.Events[0].Seq, response.Events[1].Seq)
	}
	call := store.lastListCall(t)
	if call.mode != "before" || call.beforeSeq != 4 {
		t.Fatalf("expected before event list mode at seq 4, got mode=%q before_seq=%d", call.mode, call.beforeSeq)
	}
}

func TestEventHistoryRejectsMixedCursors(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?after_seq=1&tail=true", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "use only one event history cursor")
	if got := store.listCallCount(); got != 0 {
		t.Fatalf("expected no list calls, got %d", got)
	}
}

func TestEventHistoryRejectsInvalidAfterSeq(t *testing.T) {
	for _, afterSeq := range []string{"-1", "nope"} {
		t.Run(afterSeq, func(t *testing.T) {
			store := newFakeHTTPStore()
			store.addSession(testSessionID)

			req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?after_seq="+afterSeq, nil)
			rec := httptest.NewRecorder()

			NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			assertErrorResponse(t, rec, "after_seq must be a non-negative integer")
			if got := store.listCallCount(); got != 0 {
				t.Fatalf("expected no list calls, got %d", got)
			}
		})
	}
}

func TestEventHistoryRejectsInvalidLimit(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events?limit=nope", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "limit must be a non-negative integer")
	if got := store.listCallCount(); got != 0 {
		t.Fatalf("expected no list calls, got %d", got)
	}
}

func TestEventHistoryReturns404ForUnknownSession(t *testing.T) {
	store := newFakeHTTPStore()

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/missing/events", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store}).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
	if got := store.listCallCount(); got != 0 {
		t.Fatalf("expected no list calls, got %d", got)
	}
}

func TestSSEReplaySendsMissedEventsBeforeLiveEvents(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(testSessionID, testEvent(1, "agent.message.delta"))

	subscriber := &fakeSubscriber{}
	store.onList = func(string, int64, int) {
		subscriber.send(testEvent(2, "agent.message.completed"))
		subscriber.closeAll()
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream?after_seq=0", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("expected content type text/event-stream, got %q", got)
	}

	body := rec.Body.String()
	assertSeqOrder(t, body, 1, 2)
}

func TestSSEUsesIDEventAndDataFields(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(testSessionID, testEvent(1, "agent.message.delta"))

	subscriber := &fakeSubscriber{}
	store.onList = func(string, int64, int) {
		subscriber.closeAll()
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	body := rec.Body.String()
	if !strings.Contains(body, "id: 1\n") {
		t.Fatalf("expected SSE id field in body:\n%s", body)
	}
	if !strings.Contains(body, "event: agent.message.delta\n") {
		t.Fatalf("expected SSE event field in body:\n%s", body)
	}

	response := firstSSEData(t, body)
	if response.Seq != 1 {
		t.Fatalf("expected data seq 1, got %d", response.Seq)
	}
	if response.Type != "agent.message.delta" {
		t.Fatalf("expected data type agent.message.delta, got %q", response.Type)
	}

	var payload map[string]string
	if err := json.Unmarshal(response.Payload, &payload); err != nil {
		t.Fatalf("expected payload to be JSON object: %v", err)
	}
	if got := payload["text"]; got != "event 1" {
		t.Fatalf("expected payload text %q, got %q", "event 1", got)
	}
}

func TestSSEFlushesHeadersBeforeWaitingForEvents(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	subscriber := &fakeSubscriber{}
	store.onList = func(string, int64, int) {
		subscriber.closeAll()
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if !rec.Flushed {
		t.Fatal("expected stream headers to be flushed before waiting for events")
	}
	if body := rec.Body.String(); !strings.Contains(body, ": connected\n\n") {
		t.Fatalf("expected initial connected comment in stream body:\n%s", body)
	}
}

func TestSessionActivityStreamSendsAllLiveSessionEvents(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	subscriber := &fakeSubscriber{}
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/activity/stream", nil)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)
	}()

	waitFor(t, func() bool {
		return subscriber.subscribeAllCount() == 1
	})

	subscriber.sendAll(testEvent(1, "agent.input.requested"))
	subscriber.closeAll()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("activity stream did not exit after subscriber closed")
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, ": connected\n\n") {
		t.Fatalf("expected initial connected comment in stream body:\n%s", body)
	}
	if !strings.Contains(body, "event: agent.input.requested\n") {
		t.Fatalf("expected input requested event in body:\n%s", body)
	}
	response := firstSSEData(t, body)
	if response.SessionID != testSessionID || response.Type != "agent.input.requested" {
		t.Fatalf("expected activity event for %s, got %#v", testSessionID, response)
	}
}

func TestSSESkipsDuplicateLiveEventsAlreadySentDuringReplay(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(
		testSessionID,
		testEvent(1, "agent.message.delta"),
		testEvent(2, "agent.message.completed"),
	)

	subscriber := &fakeSubscriber{}
	store.onList = func(string, int64, int) {
		subscriber.send(testEvent(2, "agent.message.completed"))
		subscriber.closeAll()
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	body := rec.Body.String()
	if got := strings.Count(body, `"seq":2`); got != 1 {
		t.Fatalf("expected duplicate seq 2 to be filtered once, got %d occurrences in body:\n%s", got, body)
	}
}

func TestSSEDoesNotLoseEventsAppendedDuringStreamSetup(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)
	store.setEvents(testSessionID, testEvent(1, "agent.message.delta"))

	subscriber := &fakeSubscriber{}
	appended := false
	store.onList = func(string, int64, int) {
		if appended {
			return
		}
		appended = true

		event := testEvent(2, "agent.message.completed")
		store.appendEvent(event)
		subscriber.send(event)
		subscriber.closeAll()
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream?after_seq=0", nil)
	rec := httptest.NewRecorder()

	NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	body := rec.Body.String()
	assertSeqOrder(t, body, 1, 2)
	if got := strings.Count(body, `"seq":2`); got != 1 {
		t.Fatalf("expected setup event seq 2 exactly once, got %d occurrences in body:\n%s", got, body)
	}
}

func TestStreamCleanupUnsubscribesWhenRequestCancelled(t *testing.T) {
	store := newFakeHTTPStore()
	store.addSession(testSessionID)

	subscriber := &fakeSubscriber{}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionID+"/events/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		NewRouter(Dependencies{Store: store, Events: subscriber}).ServeHTTP(rec, req)
	}()

	waitFor(t, func() bool {
		return subscriber.subscribeCount() == 1
	})

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not exit after request cancellation")
	}

	if got := subscriber.unsubscribeCount(); got != 1 {
		t.Fatalf("expected one unsubscribe, got %d", got)
	}
}

type fakeHTTPStore struct {
	mu       sync.Mutex
	sessions map[string]store.Session
	events   map[string][]store.Event

	listCalls         []listCall
	listSessionsCalls []listSessionsCall
	onList            func(sessionID string, afterSeq int64, limit int)
	getErr            error
	listErr           error
}

type listCall struct {
	sessionID string
	afterSeq  int64
	beforeSeq int64
	limit     int
	mode      string
}

type listSessionsCall struct {
	limit  int
	status store.SessionStatus
}

func newFakeHTTPStore() *fakeHTTPStore {
	return &fakeHTTPStore{
		sessions: make(map[string]store.Session),
		events:   make(map[string][]store.Event),
	}
}

func (s *fakeHTTPStore) addSession(id string) {
	s.addSessionWith(store.Session{
		ID:        id,
		Title:     "Test session",
		AgentType: "fake",
		Status:    store.SessionStatusIdle,
		CreatedAt: testCreatedAt,
		UpdatedAt: testCreatedAt,
	})
}

func (s *fakeHTTPStore) addSessionWith(session store.Session) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sessions[session.ID] = session
}

func (s *fakeHTTPStore) CreateSession(_ context.Context, params store.CreateSessionParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.TrimSpace(params.AgentType) == "" {
		return store.Session{}, store.ErrInvalidArgument
	}

	id := fmt.Sprintf("sess_fake_%d", len(s.sessions)+1)
	session := store.Session{
		ID:            id,
		Title:         params.Title,
		AgentType:     params.AgentType,
		Status:        store.SessionStatusIdle,
		WorkspacePath: params.WorkspacePath,
		CreatedAt:     testCreatedAt,
		UpdatedAt:     testCreatedAt,
	}
	s.sessions[id] = session

	return session, nil
}

func (s *fakeHTTPStore) setEvents(sessionID string, events ...store.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.events[sessionID] = append([]store.Event(nil), events...)
	sort.Slice(s.events[sessionID], func(i, j int) bool {
		return s.events[sessionID][i].Seq < s.events[sessionID][j].Seq
	})
}

func (s *fakeHTTPStore) appendEvent(event store.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.events[event.SessionID] = append(s.events[event.SessionID], event)
	sort.Slice(s.events[event.SessionID], func(i, j int) bool {
		return s.events[event.SessionID][i].Seq < s.events[event.SessionID][j].Seq
	})
}

func (s *fakeHTTPStore) GetSession(_ context.Context, stringID string) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.getErr != nil {
		return store.Session{}, s.getErr
	}

	session, ok := s.sessions[stringID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}
	s.applySessionCounts(&session)

	return session, nil
}

func (s *fakeHTTPStore) ListSessions(_ context.Context, params store.ListSessionsParams) ([]store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.listSessionsCalls = append(s.listSessionsCalls, listSessionsCall{
		limit:  params.Limit,
		status: params.Status,
	})

	sessions := make([]store.Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		if session.ArchivedAt != nil {
			continue
		}
		if params.Status != "" && session.Status != params.Status {
			continue
		}
		s.applySessionCounts(&session)
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].UpdatedAt.Equal(sessions[j].UpdatedAt) {
			return sessions[i].ID > sessions[j].ID
		}
		return sessions[i].UpdatedAt.After(sessions[j].UpdatedAt)
	})

	if params.Limit > 0 && len(sessions) > params.Limit {
		sessions = sessions[:params.Limit]
	}

	return append([]store.Session(nil), sessions...), nil
}

func (s *fakeHTTPStore) applySessionCounts(session *store.Session) {
	events := s.events[session.ID]
	session.EventCount = int64(len(events))
	session.ToolCount = int64(countToolActivityEvents(events))
}

func countToolActivityEvents(events []store.Event) int {
	count := 0
	for _, event := range events {
		if event.Type == "tool.call.started" || event.Type == "file.change.started" {
			count++
		}
	}
	return count
}

func (s *fakeHTTPStore) UpdateSessionTitle(_ context.Context, params store.UpdateSessionTitleParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}

	session.Title = strings.TrimSpace(params.Title)
	session.UpdatedAt = testCreatedAt
	s.sessions[params.ID] = session

	return session, nil
}

func (s *fakeHTTPStore) UpdateSessionAgentOptions(_ context.Context, params store.UpdateSessionAgentOptionsParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}

	session.AgentOptions = params.AgentOptions
	session.UpdatedAt = testCreatedAt
	s.sessions[params.ID] = session

	return session, nil
}

func (s *fakeHTTPStore) ArchiveSession(_ context.Context, params store.ArchiveSessionParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}

	archivedAt := testCreatedAt
	session.ArchivedAt = &archivedAt
	session.UpdatedAt = archivedAt
	s.sessions[params.ID] = session

	return session, nil
}

func (s *fakeHTTPStore) UpdateSessionStatus(_ context.Context, params store.UpdateSessionStatusParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}

	session.Status = params.Status
	session.UpdatedAt = testCreatedAt
	if isTestTerminalSessionStatus(params.Status) {
		completedAt := testCreatedAt
		session.CompletedAt = &completedAt
	} else {
		session.CompletedAt = nil
	}
	s.sessions[params.ID] = session

	return session, nil
}

func (s *fakeHTTPStore) SetSessionProviderSessionID(_ context.Context, params store.SetSessionProviderSessionIDParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}
	if session.ProviderSessionID != "" && session.ProviderSessionID != params.ProviderSessionID && !params.Replace {
		return store.Session{}, store.ErrInvalidArgument
	}
	session.ProviderSessionID = params.ProviderSessionID
	session.UpdatedAt = testCreatedAt
	s.sessions[params.ID] = session
	return session, nil
}

func (s *fakeHTTPStore) ClearSessionProviderSessionID(_ context.Context, params store.ClearSessionProviderSessionIDParams) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[params.ID]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}
	session.ProviderSessionID = ""
	session.UpdatedAt = testCreatedAt
	s.sessions[params.ID] = session
	return session, nil
}

func (s *fakeHTTPStore) ListEvents(_ context.Context, sessionID string, afterSeq int64, limit int) ([]store.Event, error) {
	s.mu.Lock()
	s.listCalls = append(s.listCalls, listCall{sessionID: sessionID, afterSeq: afterSeq, limit: limit, mode: "after"})
	onList := s.onList
	listErr := s.listErr
	s.mu.Unlock()

	if onList != nil {
		onList(sessionID, afterSeq, limit)
	}
	if listErr != nil {
		return nil, listErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	events := s.events[sessionID]
	filtered := make([]store.Event, 0, len(events))
	for _, event := range events {
		if event.Seq > afterSeq {
			filtered = append(filtered, event)
		}
	}

	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}

	return append([]store.Event(nil), filtered...), nil
}

func (s *fakeHTTPStore) ListRecentEvents(_ context.Context, sessionID string, limit int) ([]store.Event, error) {
	s.mu.Lock()
	s.listCalls = append(s.listCalls, listCall{sessionID: sessionID, limit: limit, mode: "tail"})
	listErr := s.listErr
	s.mu.Unlock()

	if listErr != nil {
		return nil, listErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	events := s.events[sessionID]
	start := 0
	if limit > 0 && len(events) > limit {
		start = len(events) - limit
	}
	return append([]store.Event(nil), events[start:]...), nil
}

func (s *fakeHTTPStore) ListEventsBefore(_ context.Context, sessionID string, beforeSeq int64, limit int) ([]store.Event, error) {
	s.mu.Lock()
	s.listCalls = append(s.listCalls, listCall{sessionID: sessionID, beforeSeq: beforeSeq, limit: limit, mode: "before"})
	listErr := s.listErr
	s.mu.Unlock()

	if listErr != nil {
		return nil, listErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	events := s.events[sessionID]
	filtered := make([]store.Event, 0, len(events))
	for _, event := range events {
		if event.Seq < beforeSeq {
			filtered = append(filtered, event)
		}
	}
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[len(filtered)-limit:]
	}
	return append([]store.Event(nil), filtered...), nil
}

func (s *fakeHTTPStore) lastListCall(t *testing.T) listCall {
	t.Helper()

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.listCalls) == 0 {
		t.Fatal("expected at least one ListEvents call")
	}

	return s.listCalls[len(s.listCalls)-1]
}

func (s *fakeHTTPStore) listCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.listCalls)
}

func (s *fakeHTTPStore) lastListSessionsLimit(t *testing.T) int {
	t.Helper()

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.listSessionsCalls) == 0 {
		t.Fatal("expected at least one ListSessions call")
	}
	return s.listSessionsCalls[len(s.listSessionsCalls)-1].limit
}

func (s *fakeHTTPStore) lastListSessionsStatus(t *testing.T) store.SessionStatus {
	t.Helper()

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.listSessionsCalls) == 0 {
		t.Fatal("expected at least one ListSessions call")
	}
	return s.listSessionsCalls[len(s.listSessionsCalls)-1].status
}

func (s *fakeHTTPStore) listSessionsCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.listSessionsCalls)
}

func isTestTerminalSessionStatus(status store.SessionStatus) bool {
	return status == store.SessionStatusFailed
}

type fakeSubscriber struct {
	mu sync.Mutex

	channels        []chan store.Event
	allChannels     []chan store.Event
	subscribes      int
	allSubscribes   int
	unsubscribes    int
	allUnsubscribes int
}

func (s *fakeSubscriber) Subscribe(string) (<-chan store.Event, func()) {
	ch := make(chan store.Event, 16)

	s.mu.Lock()
	s.subscribes++
	s.channels = append(s.channels, ch)
	s.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()

			s.unsubscribes++
		})
	}

	return ch, unsubscribe
}

func (s *fakeSubscriber) SubscribeAll() (<-chan store.Event, func()) {
	ch := make(chan store.Event, 16)

	s.mu.Lock()
	s.allSubscribes++
	s.allChannels = append(s.allChannels, ch)
	s.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()

			s.allUnsubscribes++
		})
	}

	return ch, unsubscribe
}

func (s *fakeSubscriber) Append(context.Context, eventservice.AppendParams) (store.Event, error) {
	return store.Event{}, nil
}

func (s *fakeSubscriber) send(event store.Event) {
	ch := s.lastChannel()
	ch <- event
}

func (s *fakeSubscriber) sendAll(event store.Event) {
	ch := s.lastAllChannel()
	ch <- event
}

func (s *fakeSubscriber) closeAll() {
	s.mu.Lock()
	channels := append([]chan store.Event(nil), s.channels...)
	allChannels := append([]chan store.Event(nil), s.allChannels...)
	s.mu.Unlock()

	for _, ch := range channels {
		close(ch)
	}
	for _, ch := range allChannels {
		close(ch)
	}
}

func (s *fakeSubscriber) subscribeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.subscribes
}

func (s *fakeSubscriber) subscribeAllCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.allSubscribes
}

func (s *fakeSubscriber) unsubscribeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.unsubscribes
}

func (s *fakeSubscriber) unsubscribeAllCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.allUnsubscribes
}

func (s *fakeSubscriber) lastChannel() chan store.Event {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.channels) == 0 {
		panic("no subscriber channel")
	}

	return s.channels[len(s.channels)-1]
}

func (s *fakeSubscriber) lastAllChannel() chan store.Event {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.allChannels) == 0 {
		panic("no all-subscriber channel")
	}

	return s.allChannels[len(s.allChannels)-1]
}

func testEvent(seq int64, eventType string) store.Event {
	return store.Event{
		ID:        fmt.Sprintf("evt_%03d", seq),
		SessionID: testSessionID,
		Seq:       seq,
		Type:      eventType,
		Role:      "assistant",
		Status:    store.EventStatusDelta,
		Payload:   json.RawMessage(fmt.Sprintf(`{"text":"event %d"}`, seq)),
		CreatedAt: testCreatedAt,
	}
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, value any) {
	t.Helper()

	if err := json.Unmarshal(rec.Body.Bytes(), value); err != nil {
		t.Fatalf("failed to decode JSON response %q: %v", rec.Body.String(), err)
	}
}

func assertErrorResponse(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()

	var response errorResponse
	decodeJSON(t, rec, &response)
	if response.Error != want {
		t.Fatalf("expected error %q, got %q", want, response.Error)
	}
}

func firstSSEData(t *testing.T, body string) eventResponse {
	t.Helper()

	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}

		var response eventResponse
		if err := json.Unmarshal([]byte(data), &response); err != nil {
			t.Fatalf("failed to decode SSE data %q: %v", data, err)
		}
		return response
	}

	t.Fatalf("expected SSE data line in body:\n%s", body)
	return eventResponse{}
}

func assertSeqOrder(t *testing.T, body string, first int64, second int64) {
	t.Helper()

	firstIndex := strings.Index(body, fmt.Sprintf(`"seq":%d`, first))
	if firstIndex < 0 {
		t.Fatalf("expected seq %d in body:\n%s", first, body)
	}

	secondIndex := strings.Index(body, fmt.Sprintf(`"seq":%d`, second))
	if secondIndex < 0 {
		t.Fatalf("expected seq %d in body:\n%s", second, body)
	}

	if firstIndex > secondIndex {
		t.Fatalf("expected seq %d before seq %d in body:\n%s", first, second, body)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("condition was not met before timeout")
}

var _ Store = (*fakeHTTPStore)(nil)
var _ EventService = (*fakeSubscriber)(nil)
