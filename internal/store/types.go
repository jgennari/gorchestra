package store

import (
	"encoding/json"
	"time"
)

type SessionStatus string

const (
	SessionStatusIdle      SessionStatus = "idle"
	SessionStatusRunning   SessionStatus = "running"
	SessionStatusCompleted SessionStatus = "completed"
	SessionStatusFailed    SessionStatus = "failed"
	SessionStatusCancelled SessionStatus = "cancelled"
)

type EventStatus string

const (
	EventStatusStarted   EventStatus = "started"
	EventStatusDelta     EventStatus = "delta"
	EventStatusCompleted EventStatus = "completed"
	EventStatusFailed    EventStatus = "failed"
	EventStatusCancelled EventStatus = "cancelled"
)

type Session struct {
	ID          string
	Title       string
	AgentType   string
	Status      SessionStatus
	CreatedAt   time.Time
	UpdatedAt   time.Time
	CompletedAt *time.Time
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

type CreateSessionParams struct {
	Title     string
	AgentType string
}

type UpdateSessionStatusParams struct {
	ID     string
	Status SessionStatus
}

type ListSessionsParams struct {
	Limit int
}

type AppendEventParams struct {
	SessionID string
	Type      string
	Role      string
	Status    EventStatus
	Payload   json.RawMessage
}
