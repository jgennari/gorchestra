package agents

import (
	"context"
	"testing"
)

func TestRegistryReturnsRegisteredAgent(t *testing.T) {
	agent := stubAgent{agentType: "fake"}

	registry, err := NewRegistry(agent)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	got, ok := registry.Get("fake")
	if !ok {
		t.Fatal("expected fake agent")
	}
	if got.Type() != "fake" {
		t.Fatalf("expected fake agent, got %q", got.Type())
	}
}

func TestRegistryRejectsDuplicateAgentTypes(t *testing.T) {
	_, err := NewRegistry(
		stubAgent{agentType: "fake"},
		stubAgent{agentType: "fake"},
	)
	if err == nil {
		t.Fatal("expected duplicate agent type error")
	}
}

func TestRegistryReturnsFalseForUnsupportedType(t *testing.T) {
	registry, err := NewRegistry(stubAgent{agentType: "fake"})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	if _, ok := registry.Get("codex"); ok {
		t.Fatal("expected unsupported agent lookup to return false")
	}
}

type stubAgent struct {
	agentType string
}

func (a stubAgent) Type() string {
	return a.agentType
}

func (a stubAgent) Run(context.Context, AgentInput, EmitFunc) error {
	return nil
}
