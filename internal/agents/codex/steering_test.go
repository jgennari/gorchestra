package codex

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
)

// Observe registration without racing an early thinking notification from the
// fake provider with completion of the turn/start RPC.
type readySteeringBroker struct {
	*runcontrol.Manager
	ready chan struct{}
}

func (b readySteeringBroker) RegisterSteering(ctx context.Context, s, run string, deliver func(context.Context, agents.SteeringInput) error) (func(), error) {
	cleanup, err := b.Manager.RegisterSteering(ctx, s, run, deliver)
	close(b.ready)
	return cleanup, err
}

func TestGenericSteeringWithoutAQuestion(t *testing.T) {
	for _, mode := range []string{"steer", "steer-reject"} {
		t.Run(mode, func(t *testing.T) {
			manager := runcontrol.NewManager()
			ctx, cleanup, err := manager.Register(context.Background(), "s")
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			broker := readySteeringBroker{Manager: manager, ready: make(chan struct{})}
			agent := fakeAppServerAgent(t, mode)
			recorder := newEventRecorder()
			done := make(chan error, 1)
			workdir := t.TempDir()
			go func() {
				done <- agent.Run(ctx, agents.AgentInput{SessionID: "s", RunID: "run1", Message: "Start", Workdir: workdir, Steering: broker}, recorder.emit)
			}()
			select {
			case <-broker.ready:
			case <-time.After(3 * time.Second):
				t.Fatal("steering never became ready")
			}
			if hasAgentEvent(recorder.snapshot(), "agent.input.requested") {
				t.Fatal("test requires no question")
			}
			answerCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			err = manager.SteerWithPersistence(answerCtx, "s", "run1", agents.SteeringInput{Message: "Actually focus on the tests"}, func() error { return nil })
			if mode == "steer-reject" {
				if err == nil {
					t.Fatal("rejection reported success")
				}
				if hasAgentEvent(recorder.snapshot(), "agent.run.failed") {
					t.Fatal("steer rejection failed the run")
				}
				_ = manager.Cancel("s", runcontrol.Cancellation{})
			} else if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if mode == "steer" && err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("run failed to finish")
			}
			assertTerminalCount(t, recorder.snapshot(), 1)
			if err := manager.SteerWithPersistence(context.Background(), "s", "run1", agents.SteeringInput{Message: "late"}, func() error { t.Error("late input persisted"); return nil }); !errors.Is(err, runcontrol.ErrSteeringUnavailable) && !errors.Is(err, runcontrol.ErrRunNotActive) {
				t.Fatalf("handler not removed: %v", err)
			}
		})
	}
}
