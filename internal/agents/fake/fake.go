package fake

import (
	"context"

	"github.com/jgennari/gorchestra/internal/agents"
)

const Type = "fake"

type Agent struct {
	err error
}

type Option func(*Agent)

func New(options ...Option) *Agent {
	agent := &Agent{}
	for _, option := range options {
		option(agent)
	}
	return agent
}

func WithError(err error) Option {
	return func(agent *Agent) {
		agent.err = err
	}
}

func (a *Agent) Type() string {
	return Type
}

func (a *Agent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.run.started",
		Role:   "assistant",
		Status: "started",
		Payload: map[string]any{
			"text": "Fake agent started.",
		},
	}); err != nil {
		return err
	}

	if a.err != nil {
		return a.err
	}

	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.message.delta",
		Role:   "assistant",
		Status: "delta",
		Payload: map[string]any{
			"text": "Received task: " + input.Message,
		},
	}); err != nil {
		return err
	}

	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.message.completed",
		Role:   "assistant",
		Status: "completed",
		Payload: map[string]any{
			"text": "Fake agent completed the task.",
		},
	}); err != nil {
		return err
	}

	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.run.completed",
		Role:   "assistant",
		Status: "completed",
		Payload: map[string]any{
			"agent_type": Type,
		},
	}); err != nil {
		return err
	}

	return nil
}
