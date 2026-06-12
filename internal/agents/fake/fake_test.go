package fake

import (
	"context"
	"errors"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestAgentEmitsDeterministicSuccessfulEventOrder(t *testing.T) {
	agent := New()
	input := agents.AgentInput{
		SessionID: "sess_test",
		Message:   "Inspect repository",
	}

	var events []agents.AgentEvent
	err := agent.Run(context.Background(), input, func(_ context.Context, event agents.AgentEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run fake agent: %v", err)
	}

	assertEventTypes(t, events, []string{
		"agent.run.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})

	if got := events[1].Payload.(map[string]any)["text"]; got != "Received task: Inspect repository" {
		t.Fatalf("expected deterministic delta text, got %#v", got)
	}
}

func TestAgentReturnsConfiguredError(t *testing.T) {
	wantErr := errors.New("planned failure")
	agent := New(WithError(wantErr))

	var events []agents.AgentEvent
	err := agent.Run(context.Background(), agents.AgentInput{}, func(_ context.Context, event agents.AgentEvent) error {
		events = append(events, event)
		return nil
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected configured error, got %v", err)
	}

	assertEventTypes(t, events, []string{"agent.run.started"})
}

func TestAgentReturnsContextCanceledWithoutCompletionEvents(t *testing.T) {
	stepBarrier := make(chan struct{})
	agent := New(WithStepBarrier(stepBarrier))
	ctx, cancel := context.WithCancel(context.Background())

	var events []agents.AgentEvent
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- agent.Run(ctx, agents.AgentInput{}, func(_ context.Context, event agents.AgentEvent) error {
			events = append(events, event)
			if event.Type == "agent.run.started" {
				close(started)
			}
			return nil
		})
	}()

	<-started
	cancel()

	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	assertEventTypes(t, events, []string{"agent.run.started"})
}

func assertEventTypes(t *testing.T, events []agents.AgentEvent, want []string) {
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
