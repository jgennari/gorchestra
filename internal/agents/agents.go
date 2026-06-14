package agents

import (
	"context"
	"errors"
)

var ErrUnavailable = errors.New("agents: unavailable")

type Agent interface {
	Type() string
	Run(ctx context.Context, input AgentInput, emit EmitFunc) error
}

type Availability interface {
	Available() error
}

type OptionsProvider interface {
	Options(ctx context.Context) (Options, error)
}

type Options struct {
	DefaultModel       string                    `json:"default_model"`
	Models             []ModelOption             `json:"models"`
	CollaborationModes []CollaborationModeOption `json:"collaboration_modes"`
}

type ModelOption struct {
	ID                        string                  `json:"id"`
	Model                     string                  `json:"model"`
	DisplayName               string                  `json:"display_name"`
	Description               string                  `json:"description"`
	Hidden                    bool                    `json:"hidden"`
	SupportedReasoningEfforts []ReasoningEffortOption `json:"supported_reasoning_efforts"`
	DefaultReasoningEffort    string                  `json:"default_reasoning_effort"`
	ServiceTiers              []ModelServiceTier      `json:"service_tiers"`
	DefaultServiceTier        string                  `json:"default_service_tier"`
	IsDefault                 bool                    `json:"is_default"`
}

type ReasoningEffortOption struct {
	ReasoningEffort string `json:"reasoning_effort"`
	Description     string `json:"description"`
}

type ModelServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type CollaborationModeOption struct {
	Name            string `json:"name"`
	Mode            string `json:"mode"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
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
