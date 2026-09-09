package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/store"
)

type asyncInputAgent struct {
	userInputAgent
	finish     chan struct{}
	onDelivery func() error
}

func (a *asyncInputAgent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	if err := emit(ctx, agents.AgentEvent{Type: "agent.run.started", Role: "assistant", Status: "started", Payload: map[string]any{}}); err != nil {
		return err
	}
	request := agents.UserInputRequest{SessionID: input.SessionID, RequestID: "async_question", Provider: "fake", Delivery: "async", ThreadID: "thread", TurnID: "turn", Questions: []agents.UserInputQuestion{{ID: "q1", Question: "Choose?", IsOther: true, Options: []agents.UserInputOption{{Label: "Alpha"}, {Label: "Beta"}}}}}
	waiter, err := input.UserInput.(agents.AsyncUserInputBroker).OpenAsyncUserInput(ctx, request, func(context.Context, agents.UserInputResponse) error { return a.onDelivery() })
	if err != nil {
		return err
	}
	defer waiter.Close()
	if err := emit(ctx, agents.AgentEvent{Type: "agent.input.requested", Role: "assistant", Status: "started", Payload: map[string]any{"request_id": request.RequestID, "delivery": "async", "questions": request.Questions, "text": "Choose?"}}); err != nil {
		return err
	}
	if err := emit(ctx, agents.AgentEvent{Type: "agent.thinking.started", Role: "assistant", Status: "started", Payload: map[string]any{}}); err != nil {
		return err
	}
	select {
	case <-a.finish:
	case <-ctx.Done():
		return ctx.Err()
	}
	return emit(ctx, agents.AgentEvent{Type: "agent.run.completed", Role: "assistant", Status: "completed", Payload: map[string]any{}})
}

func TestAsyncInputAnswerDeliveryLifecycle(t *testing.T) {
	for _, reject := range []bool{false, true} {
		name := "accepted"
		if reject {
			name = "rejected"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			agent := &asyncInputAgent{finish: make(chan struct{})}
			s, _, runs, handler := newIntegrationAPI(t, ctx, agent)
			session := createIntegrationSession(t, ctx, s)
			deliveries := 0
			agent.onDelivery = func() error {
				deliveries++
				if !hasEventType(t, ctx, s, session.ID, "agent.input.submitted") {
					t.Error("delivery preceded persistence")
				}
				if hasEventType(t, ctx, s, session.ID, "agent.input.answered") {
					t.Error("reported success before acknowledgement")
				}
				if reject {
					return errors.New("provider rejected stale turn")
				}
				return nil
			}
			t.Cleanup(func() { close(agent.finish); waitFor(t, func() bool { return !runs.Active(session.ID) }) })
			if rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Ask me"}`); rec.Code != http.StatusAccepted {
				t.Fatal(rec.Body.String())
			}
			waitFor(t, func() bool { return hasEventType(t, ctx, s, session.ID, "agent.thinking.started") })
			tailRec := get(handler, "/api/sessions/"+session.ID+"/events?tail=true&limit=1")
			var tail eventHistoryResponse
			decodeJSON(t, tailRec, &tail)
			if len(tail.Events) != 1 || tail.Events[0].Type != "agent.thinking.started" || len(tail.InputEvents) != 1 || tail.InputEvents[0].Type != "agent.input.requested" {
				t.Fatalf("bounded history lost question control state: %#v", tail)
			}
			path := "/api/sessions/" + session.ID + "/requests/async_question/answer"
			if invalid := postJSON(handler, path, `{"answers":{"unknown":{"answers":["Beta"]}}}`); invalid.Code != http.StatusBadRequest || deliveries != 0 {
				t.Fatalf("invalid answer: %d", invalid.Code)
			}
			rec := postJSON(handler, path, `{"answers":{"q1":{"answers":["A custom answer"]}}}`)
			wantStatus := http.StatusAccepted
			wantEvent := "agent.input.answered"
			if reject {
				wantStatus = http.StatusInternalServerError
				wantEvent = "agent.input.failed"
			}
			if rec.Code != wantStatus || deliveries != 1 {
				t.Fatalf("response: %d %s, deliveries %d", rec.Code, rec.Body.String(), deliveries)
			}
			if !hasEventType(t, ctx, s, session.ID, wantEvent) {
				t.Fatalf("missing %s", wantEvent)
			}
			if reject && hasEventType(t, ctx, s, session.ID, "agent.input.answered") {
				t.Fatal("rejected answer reported as successful")
			}
			if repeat := postJSON(handler, path, `{"answers":{"q1":{"answers":["Beta"]}}}`); repeat.Code != http.StatusConflict || deliveries != 1 {
				t.Fatalf("duplicate: %d, deliveries %d", repeat.Code, deliveries)
			}
			persisted, err := s.GetSession(ctx, session.ID)
			if err != nil || persisted.Status != store.SessionStatusRunning || persisted.PendingInputCount != 0 {
				t.Fatalf("answer incorrectly ended run or retained pending count: %#v %v", persisted, err)
			}
			// Replayed history retains both the question and definitive delivery state.
			if rec := get(handler, "/api/sessions/"+session.ID+"/events?limit=100"); rec.Code != http.StatusOK {
				t.Fatal(rec.Body.String())
			}
		})
	}
}
