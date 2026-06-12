package agents

import (
	"fmt"
	"strings"
)

type Registry struct {
	agents map[string]Agent
}

func NewRegistry(agentList ...Agent) (*Registry, error) {
	registry := &Registry{
		agents: make(map[string]Agent),
	}

	for _, agent := range agentList {
		if err := registry.Register(agent); err != nil {
			return nil, err
		}
	}

	return registry, nil
}

func (r *Registry) Register(agent Agent) error {
	if agent == nil {
		return fmt.Errorf("agents: agent is required")
	}

	agentType := strings.TrimSpace(agent.Type())
	if agentType == "" {
		return fmt.Errorf("agents: agent type is required")
	}
	if _, exists := r.agents[agentType]; exists {
		return fmt.Errorf("agents: duplicate agent type %q", agentType)
	}

	r.agents[agentType] = agent
	return nil
}

func (r *Registry) Get(agentType string) (Agent, bool) {
	if r == nil {
		return nil, false
	}

	agent, ok := r.agents[strings.TrimSpace(agentType)]
	return agent, ok
}
