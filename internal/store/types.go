package store

import (
	"encoding/json"
	"time"
)

type SessionStatus string

const (
	SessionStatusIdle    SessionStatus = "idle"
	SessionStatusRunning SessionStatus = "running"
	SessionStatusFailed  SessionStatus = "failed"
)

type EventStatus string

const (
	EventStatusStarted   EventStatus = "started"
	EventStatusDelta     EventStatus = "delta"
	EventStatusCompleted EventStatus = "completed"
	EventStatusFailed    EventStatus = "failed"
	EventStatusCancelled EventStatus = "cancelled"
)

type QueuedMessageStatus string

const (
	QueuedMessageStatusPending QueuedMessageStatus = "pending"
	QueuedMessageStatusSending QueuedMessageStatus = "sending"
	QueuedMessageStatusSent    QueuedMessageStatus = "sent"
	QueuedMessageStatusRemoved QueuedMessageStatus = "removed"
)

type Session struct {
	ID                string
	Title             string
	AgentType         string
	Status            SessionStatus
	ProviderSessionID string
	WorkspacePath     string
	AgentOptions      json.RawMessage
	EventCount        int64
	ToolCount         int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
	CompletedAt       *time.Time
	ArchivedAt        *time.Time
}

type Event struct {
	ID        string
	SessionID string
	Seq       int64
	Type      string
	Role      string
	Status    EventStatus
	Payload   json.RawMessage
	CreatedAt time.Time
}

type QueuedMessage struct {
	ID           string
	SessionID    string
	Seq          int64
	Status       QueuedMessageStatus
	Content      string
	AgentOptions json.RawMessage
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type CreateSessionParams struct {
	Title         string
	AgentType     string
	WorkspacePath string
	AgentOptions  json.RawMessage
}

type UpdateSessionStatusParams struct {
	ID     string
	Status SessionStatus
}

type UpdateSessionTitleParams struct {
	ID    string
	Title string
}

type UpdateSessionAgentOptionsParams struct {
	ID           string
	AgentOptions json.RawMessage
}

type ArchiveSessionParams struct {
	ID string
}

type RestoreSessionParams struct {
	ID string
}

type SetSessionProviderSessionIDParams struct {
	ID                string
	ProviderSessionID string
	Replace           bool
}

type ClearSessionProviderSessionIDParams struct {
	ID string
}

type ListSessionsParams struct {
	Limit           int
	Status          SessionStatus
	IncludeArchived bool
}

type AppendEventParams struct {
	SessionID string
	Type      string
	Role      string
	Status    EventStatus
	Payload   json.RawMessage
}

type EnqueueMessageParams struct {
	SessionID    string
	Content      string
	AgentOptions json.RawMessage
	MaxPending   int
}

type QueueMessageIDParams struct {
	SessionID string
	ID        string
}
