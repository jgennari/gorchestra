package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestCreateRunIsIdempotentAndProducesDurableReport(t *testing.T) {
	ctx := context.Background()
	barrier := make(chan struct{})
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(barrier)))
	body := `{"request_id":"request-one","agent_type":"fake","prompt":"inspect the repository"}`

	first := postJSON(handler, "/api/runs", body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("expected accepted, got %d: %s", first.Code, first.Body.String())
	}
	var receipt runReceiptResponse
	decodeJSON(t, first, &receipt)
	if receipt.SessionID == "" || receipt.RunID == "" || receipt.RequestID != "request-one" {
		t.Fatalf("unexpected receipt: %#v", receipt)
	}

	second := postJSON(handler, "/api/runs", body)
	if second.Code != http.StatusAccepted {
		t.Fatalf("expected idempotent accepted response, got %d: %s", second.Code, second.Body.String())
	}
	var repeated runReceiptResponse
	decodeJSON(t, second, &repeated)
	if repeated.SessionID != receipt.SessionID || repeated.RunID != receipt.RunID {
		t.Fatalf("idempotent request created different work: %#v vs %#v", receipt, repeated)
	}

	conflict := postJSON(handler, "/api/runs", `{"request_id":"request-one","agent_type":"fake","prompt":"different"}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected request ID conflict, got %d: %s", conflict.Code, conflict.Body.String())
	}
	sessions, err := dbStore.ListSessions(ctx, store.ListSessionsParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("idempotent/conflicting retries created %d sessions", len(sessions))
	}

	show := httptest.NewRecorder()
	handler.ServeHTTP(show, httptest.NewRequest(http.MethodGet, "/api/runs/"+receipt.RunID, nil))
	if show.Code != http.StatusOK {
		t.Fatalf("expected running run, got %d: %s", show.Code, show.Body.String())
	}
	var running runResponse
	decodeJSON(t, show, &running)
	if running.ID != receipt.RunID || running.SessionID != receipt.SessionID || running.Status != "running" {
		t.Fatalf("unexpected running record: %#v", running)
	}

	close(barrier)
	waitFor(t, func() bool {
		run, err := dbStore.GetRun(ctx, receipt.RunID)
		return err == nil && run.Status == "completed"
	})
	report := httptest.NewRecorder()
	handler.ServeHTTP(report, httptest.NewRequest(http.MethodGet, "/api/runs/"+receipt.RunID+"/report", nil))
	if report.Code != http.StatusOK {
		t.Fatalf("expected report, got %d: %s", report.Code, report.Body.String())
	}
	var completed runResponse
	decodeJSON(t, report, &completed)
	if completed.Status != "completed" || completed.FinalResponse != "Fake agent completed the task." {
		t.Fatalf("unexpected completed report: %#v", completed)
	}
	if completed.FinalResponseSeq == 0 || completed.TerminalSeq == 0 || completed.CompletedAt == nil {
		t.Fatalf("expected report boundaries: %#v", completed)
	}
}

func TestRunReportRejectsRunningRun(t *testing.T) {
	ctx := context.Background()
	barrier := make(chan struct{})
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(barrier)))
	receiptRecorder := postJSON(handler, "/api/runs", `{"agent_type":"fake","prompt":"wait"}`)
	var receipt runReceiptResponse
	decodeJSON(t, receiptRecorder, &receipt)

	report := httptest.NewRecorder()
	handler.ServeHTTP(report, httptest.NewRequest(http.MethodGet, "/api/runs/"+receipt.RunID+"/report", nil))
	if report.Code != http.StatusConflict || !strings.Contains(report.Body.String(), "still running") {
		t.Fatalf("expected running conflict, got %d: %s", report.Code, report.Body.String())
	}
	close(barrier)
	waitFor(t, func() bool {
		run, err := dbStore.GetRun(ctx, receipt.RunID)
		return err == nil && run.Status == "completed"
	})
}

func TestRunEventsAndExactCancellation(t *testing.T) {
	ctx := context.Background()
	barrier := make(chan struct{})
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(barrier)))
	receiptRecorder := postJSON(handler, "/api/runs", `{"agent_type":"fake","prompt":"wait"}`)
	var receipt runReceiptResponse
	decodeJSON(t, receiptRecorder, &receipt)

	eventsRecorder := httptest.NewRecorder()
	handler.ServeHTTP(eventsRecorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+receipt.RunID+"/events?limit=2", nil))
	if eventsRecorder.Code != http.StatusOK {
		t.Fatalf("expected run events, got %d: %s", eventsRecorder.Code, eventsRecorder.Body.String())
	}
	var page runEventsResponse
	decodeJSON(t, eventsRecorder, &page)
	if page.RunID != receipt.RunID || page.SessionID != receipt.SessionID || len(page.Events) == 0 {
		t.Fatalf("unexpected run event page: %#v", page)
	}
	for _, event := range page.Events {
		if event.Seq < 1 {
			t.Fatalf("invalid run event boundary: %#v", event)
		}
	}

	cancel := postJSON(handler, "/api/runs/"+receipt.RunID+"/cancel", `{}`)
	if cancel.Code != http.StatusAccepted {
		t.Fatalf("expected exact cancellation, got %d: %s", cancel.Code, cancel.Body.String())
	}
	close(barrier)
	waitFor(t, func() bool {
		run, err := dbStore.GetRun(ctx, receipt.RunID)
		return err == nil && run.Status == "cancelled"
	})
	stale := postJSON(handler, "/api/runs/"+receipt.RunID+"/cancel", `{}`)
	if stale.Code != http.StatusConflict {
		t.Fatalf("expected terminal run conflict, got %d: %s", stale.Code, stale.Body.String())
	}
}

func TestCreateAgentOptionsPreservesExplicitFalseModes(t *testing.T) {
	var input createAgentOptions
	if err := json.Unmarshal([]byte(`{"codex":{"model":"example","fast_mode":false,"planning_mode":false}}`), &input); err != nil {
		t.Fatal(err)
	}
	raw, err := createSessionAgentOptions("codex", &input)
	if err != nil {
		t.Fatal(err)
	}
	var options map[string]map[string]any
	if err := json.Unmarshal(raw, &options); err != nil {
		t.Fatal(err)
	}
	if value, ok := options["codex"]["fast_mode"]; !ok || value != false {
		t.Fatalf("expected explicit false fast_mode, got %#v", options)
	}
	if value, ok := options["codex"]["planning_mode"]; !ok || value != false {
		t.Fatalf("expected explicit false planning_mode, got %#v", options)
	}
}

func TestMessageSubmissionReturnsExactRunID(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)
	recorder := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"hello"}`)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected accepted, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response submitMessageResponse
	decodeJSON(t, recorder, &response)
	if response.RunID == "" {
		t.Fatal("expected exact run_id")
	}
	waitFor(t, func() bool {
		run, err := dbStore.GetRun(ctx, response.RunID)
		return err == nil && run.Status == "completed"
	})
	if _, err := dbStore.GetRun(ctx, response.RunID); err != nil {
		t.Fatal(err)
	}
}

func TestMessageSubmissionCanRejectImplicitQueueWhenBusy(t *testing.T) {
	ctx := context.Background()
	barrier := make(chan struct{})
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(barrier)))
	session := createIntegrationSession(t, ctx, dbStore)
	first := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"first"}`)
	if first.Code != http.StatusAccepted {
		t.Fatalf("start first run: %d %s", first.Code, first.Body.String())
	}
	rejected := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"second","reject_if_busy":true}`)
	if rejected.Code != http.StatusConflict || !strings.Contains(rejected.Body.String(), "queue or steer") {
		t.Fatalf("expected explicit queue/steer conflict, got %d: %s", rejected.Code, rejected.Body.String())
	}
	queued, err := dbStore.ListQueuedMessages(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 0 {
		t.Fatalf("rejected follow-up was queued: %#v", queued)
	}
	close(barrier)
	waitFor(t, func() bool {
		current, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && current.Status == store.SessionStatusIdle
	})
}

func TestRunReportKeepsFullFinalResponse(t *testing.T) {
	ctx := context.Background()
	responseText := strings.Repeat("complete result ", 80)
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, finalResponseAgent{text: responseText})
	recorder := postJSON(handler, "/api/runs", `{"agent_type":"long-final","prompt":"report fully"}`)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected accepted, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var receipt runReceiptResponse
	decodeJSON(t, recorder, &receipt)
	waitFor(t, func() bool {
		run, err := dbStore.GetRun(ctx, receipt.RunID)
		return err == nil && run.Status == "completed"
	})
	run, err := dbStore.GetRun(ctx, receipt.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.FinalResponse != responseText {
		t.Fatalf("final response was truncated: got %d bytes, want %d", len(run.FinalResponse), len(responseText))
	}
}

type finalResponseAgent struct{ text string }

func (a finalResponseAgent) Type() string { return "long-final" }

func (a finalResponseAgent) Run(ctx context.Context, _ agents.AgentInput, emit agents.EmitFunc) error {
	if err := emit(ctx, agents.AgentEvent{Type: "agent.run.started", Role: "assistant", Status: "started", Payload: map[string]any{}}); err != nil {
		return err
	}
	if err := emit(ctx, agents.AgentEvent{Type: "agent.message.completed", Role: "assistant", Status: "completed", Payload: map[string]any{"text": a.text}}); err != nil {
		return err
	}
	return emit(ctx, agents.AgentEvent{Type: "agent.run.completed", Role: "assistant", Status: "completed", Payload: map[string]any{}})
}
