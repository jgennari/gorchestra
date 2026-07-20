package hosting

import (
	"context"
	"errors"
	"net/http"
	"time"
)

const (
	DefaultLogLimit        = 1 << 20
	DefaultStopTimeout     = 5 * time.Second
	DefaultReadinessPoll   = 100 * time.Millisecond
	IngressHealthPath      = "/.well-known/gorchestra-preview-health"
	DefaultPreviewTemplate = "http://{slug}.localhost"
)

var (
	ErrNotFound      = errors.New("host runtime not found")
	ErrBusy          = errors.New("host runtime operation in progress")
	ErrRecipeChanged = errors.New("host recipe changed; restart is required")
	ErrHostConflict  = errors.New("preview hostname is already in use")
	ErrShuttingDown  = errors.New("hosting manager is shutting down")
	ErrUnsupported   = errors.New("hosting is unsupported on this platform")
	ErrNotReady      = errors.New("hosted preview readiness check failed")
)

type RuntimeStatus string

const (
	StatusStopped  RuntimeStatus = "stopped"
	StatusStarting RuntimeStatus = "starting"
	StatusRunning  RuntimeStatus = "running"
	StatusStopping RuntimeStatus = "stopping"
	StatusFailed   RuntimeStatus = "failed"
)

type ServiceStatus string

const (
	ServiceStopped  ServiceStatus = "stopped"
	ServiceStarting ServiceStatus = "starting"
	ServiceRunning  ServiceStatus = "running"
	ServiceFailed   ServiceStatus = "failed"
)

// StartRequest is all runtime input needed after a recipe has been loaded and
// validated. Slug may be empty; in that case Manager assigns a stable slug.
type StartRequest struct {
	SessionID string
	Slug      string
	Loaded    LoadedRecipe
}

type ConfigStatus struct {
	Path         string   `json:"path"`
	Present      bool     `json:"present"`
	Valid        bool     `json:"valid"`
	Stale        bool     `json:"stale"`
	Digest       string   `json:"digest,omitempty"`
	LoadedDigest string   `json:"loaded_digest,omitempty"`
	Name         string   `json:"name,omitempty"`
	Errors       []string `json:"errors"`
}

type RuntimeInfo struct {
	Status    RuntimeStatus `json:"status"`
	URL       string        `json:"url,omitempty"`
	StartedAt *time.Time    `json:"started_at,omitempty"`
	StoppedAt *time.Time    `json:"stopped_at,omitempty"`
	Error     string        `json:"error,omitempty"`
}

type ServiceInfo struct {
	Name       string        `json:"name"`
	Status     ServiceStatus `json:"status"`
	Port       int           `json:"port,omitempty"`
	PID        int           `json:"-"`
	RoutePaths []string      `json:"route_paths"`
	StartedAt  *time.Time    `json:"started_at,omitempty"`
	StoppedAt  *time.Time    `json:"stopped_at,omitempty"`
	ExitCode   *int          `json:"exit_code,omitempty"`
	Error      string        `json:"error,omitempty"`
}

// Snapshot is the public, immutable view of a session preview runtime.
type Snapshot struct {
	SessionID string        `json:"session_id"`
	Config    ConfigStatus  `json:"config"`
	Runtime   RuntimeInfo   `json:"runtime"`
	Services  []ServiceInfo `json:"services"`
	LogCursor uint64        `json:"log_cursor"`
}

// PersistedState includes the public runtime snapshot and the trusted recipe
// snapshot required to restore stable preview URLs after a Gorchestra restart.
// It never contains values inherited from the supervisor's environment.
type PersistedState struct {
	Snapshot       Snapshot
	Slug           string
	Workspace      string
	Recipe         Recipe
	RecipeSnapshot []byte
}

type RuntimeEvent struct {
	SessionID string         `json:"session_id"`
	Type      string         `json:"type"`
	Service   string         `json:"service,omitempty"`
	Error     string         `json:"error,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	Snapshot  Snapshot       `json:"snapshot"`
	Details   map[string]any `json:"details,omitempty"`
}

type PersistFunc func(context.Context, PersistedState) error
type EmitFunc func(context.Context, RuntimeEvent) error

type ManagerOptions struct {
	PreviewURLTemplate string
	Persist            PersistFunc
	Emit               EmitFunc
	LogLimit           int
	StopTimeout        time.Duration
	ReadinessPoll      time.Duration
	HTTPClient         *http.Client
	ParentEnvironment  func(string) (string, bool)
	Now                func() time.Time
}

type ServiceCheck struct {
	Name      string        `json:"name"`
	Ready     bool          `json:"ready"`
	Latency   time.Duration `json:"latency"`
	CheckedAt time.Time     `json:"checked_at"`
	Error     string        `json:"error,omitempty"`
}

type LogStream string

const (
	LogStdout LogStream = "stdout"
	LogStderr LogStream = "stderr"
)

type LogChunk struct {
	Seq       uint64    `json:"seq"`
	Service   string    `json:"service"`
	Stream    LogStream `json:"stream"`
	Data      string    `json:"data"`
	CreatedAt time.Time `json:"created_at"`
}

type LogSnapshot struct {
	Chunks    []LogChunk `json:"chunks"`
	FirstSeq  uint64     `json:"first_seq"`
	LastSeq   uint64     `json:"last_seq"`
	Truncated bool       `json:"truncated"`
}
