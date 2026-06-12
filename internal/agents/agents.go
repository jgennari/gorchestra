package agents

import "context"

type Agent interface {
	Type() string
	Run(ctx context.Context, input AgentInput, emit EmitFunc) error
}

type AgentInput struct {
	SessionID string
	Message   string
	Workdir   string
	Metadata  map[string]any
}

type EmitFunc func(ctx context.Context, event AgentEvent) error

type AgentEvent struct {
	Type    string
	Role    string
	Status  string
	Payload any
}
