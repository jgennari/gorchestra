package codex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
)

func TestNormalizeAsyncQuestion(t *testing.T) {
	params := json.RawMessage(`{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"call_question","text":"Choose?","delivery":"async","questions":[{"title":"Choose?","options":["One","Two"]},{"title":"Any notes?","options":null}]}}`)
	events := newNormalizer().normalize("item/completed", params)
	if len(events) != 1 || events[0].Event.Type != "agent.input.requested" {
		t.Fatalf("events: %#v", events)
	}
	payload := events[0].Event.Payload.(map[string]any)
	questions := payload["questions"].([]agents.UserInputQuestion)
	if payload["delivery"] != "async" || payload["request_id"] != "call_question" || len(questions) != 2 || !questions[1].IsOther || len(questions[1].Options) != 0 || questions[0].ID == questions[1].ID {
		t.Fatalf("payload: %#v", payload)
	}
	for _, invalid := range []string{strings.Replace(string(params), `"delivery":"async"`, `"delivery":null`, 1), strings.Replace(string(params), `"title":"Choose?"`, `"title":""`, 1)} {
		if got := newNormalizer().normalize("item/completed", json.RawMessage(invalid)); got[0].Event.Type != "agent.message.completed" {
			t.Fatalf("lost fallback message: %#v", got)
		}
	}
}

func TestAsyncQuestionsKeepStreamingAndSteerOnlyTheOriginalTurn(t *testing.T) {
	for _, mode := range []string{"async-input", "async-reject", "async-ended"} {
		t.Run(mode, func(t *testing.T) {
			agent := fakeAppServerAgent(t, mode)
			manager := runcontrol.NewManager()
			ctx, cleanup, err := manager.Register(context.Background(), "sess_test")
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			recorder := newEventRecorder()
			done := make(chan error, 1)
			go func() {
				done <- agent.Run(ctx, agents.AgentInput{SessionID: "sess_test", Message: "Ask", Workdir: t.TempDir(), UserInput: manager}, recorder.emit)
			}()
			recorder.waitFor(t, "agent.thinking.started") // emitted AFTER the question; no answer yet
			if mode == "async-ended" {
				select {
				case err := <-done:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("run did not end")
				}
				if _, err := manager.PendingUserInput("sess_test", "call_async"); !errors.Is(err, runcontrol.ErrUserInputNotActive) {
					t.Fatalf("stale question: %v", err)
				}
				return
			}
			pending, err := manager.PendingUserInput("sess_test", "call_async")
			if err != nil || pending.Delivery != "async" {
				t.Fatalf("pending: %#v %v", pending, err)
			}
			answerCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			err = manager.AnswerUserInputWithPersistence(answerCtx, "sess_test", "call_async", agents.UserInputResponse{Answers: map[string]agents.UserInputQuestionAnswer{"question_1": {Answers: []string{"Beta"}}}}, nil)
			if mode == "async-reject" {
				if err == nil || !strings.Contains(err.Error(), "rejected") {
					t.Fatalf("expected rejection, got %v", err)
				}
				if hasAgentEvent(recorder.snapshot(), "agent.run.failed") {
					t.Fatal("answer rejection failed the run")
				}
				if err := manager.Cancel("sess_test", runcontrol.Cancellation{}); err != nil {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if mode == "async-input" && err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("run did not finish")
			}
			assertTerminalCount(t, recorder.snapshot(), 1)
		})
	}
}
