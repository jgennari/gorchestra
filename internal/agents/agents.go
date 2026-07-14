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

type AgentAction string

const (
	AgentActionMessage AgentAction = "message"
	AgentActionClear   AgentAction = "clear"
	AgentActionCompact AgentAction = "compact"
)

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
	SessionID         string
	ProviderSessionID string
	Action            AgentAction
	Message           string
	Workdir           string
	Metadata          map[string]any
	Attachments       []Attachment
	UserInput         UserInputBroker
	Permissions       PermissionBroker
}

type Attachment struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	DataURL   string `json:"data_url"`
	SizeBytes int64  `json:"size_bytes"`
}

type EmitFunc func(ctx context.Context, event AgentEvent) error

type AgentEvent struct {
	Type    string
	Role    string
	Status  string
	Payload any
}

type UserInputBroker interface {
	OpenUserInput(ctx context.Context, request UserInputRequest) (UserInputWaiter, error)
}

type UserInputWaiter interface {
	Wait(ctx context.Context) (UserInputResponse, error)
	Close()
}

type UserInputRequest struct {
	SessionID         string
	RequestID         string
	Provider          string
	ProviderEventType string
	ProviderRequestID string
	ThreadID          string
	TurnID            string
	ItemID            string
	Questions         []UserInputQuestion
}

type UserInputQuestion struct {
	ID       string            `json:"id"`
	Header   string            `json:"header"`
	Question string            `json:"question"`
	IsOther  bool              `json:"is_other"`
	IsSecret bool              `json:"is_secret"`
	Options  []UserInputOption `json:"options"`
}

type UserInputOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type UserInputResponse struct {
	Answers map[string]UserInputQuestionAnswer `json:"answers"`
}

type UserInputQuestionAnswer struct {
	Answers []string `json:"answers"`
}

type PermissionBroker interface {
	OpenPermission(ctx context.Context, request PermissionRequest) (PermissionWaiter, error)
}

type PermissionWaiter interface {
	Wait(ctx context.Context) (PermissionResponse, error)
	Close()
}

type PermissionRequest struct {
	SessionID         string             `json:"-"`
	RequestID         string             `json:"request_id"`
	Provider          string             `json:"provider"`
	ProviderEventType string             `json:"provider_event_type"`
	ProviderRequestID string             `json:"provider_request_id,omitempty"`
	ThreadID          string             `json:"thread_id,omitempty"`
	TurnID            string             `json:"turn_id,omitempty"`
	ItemID            string             `json:"item_id,omitempty"`
	Kind              string             `json:"kind"`
	Title             string             `json:"title"`
	Description       string             `json:"description,omitempty"`
	Reason            string             `json:"reason,omitempty"`
	Command           string             `json:"command,omitempty"`
	CWD               string             `json:"cwd,omitempty"`
	ToolName          string             `json:"tool_name,omitempty"`
	ToolInput         any                `json:"tool_input,omitempty"`
	Paths             []string           `json:"paths,omitempty"`
	Diff              string             `json:"diff,omitempty"`
	RequestedGrants   any                `json:"requested_grants,omitempty"`
	Options           []PermissionOption `json:"options"`
}

type PermissionOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Decision    string `json:"decision"`
	Scope       string `json:"scope,omitempty"`
}

type PermissionResponse struct {
	OptionID string `json:"option_id"`
}
