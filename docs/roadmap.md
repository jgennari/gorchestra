# Gorchestra Roadmap

This roadmap turns the initial product discussion into an implementation plan for Gorchestra: a single deployable Go service that orchestrates long-running AI coding-agent sessions with durable event history and live browser visibility.

The critical path is:

```txt
event model -> persistence -> streaming -> replay -> agent adapter
```

Getting that foundation right keeps frontend rendering, provider adapters, and later orchestration features swappable.

## Target Architecture

Gorchestra should ship as one Go binary that provides:

- Go backend API
- React/Vite frontend served from embedded assets
- SQLite durable event and session store
- In-memory live event buffer
- Server-Sent Events streaming to browser clients
- Replay and resume support using monotonic per-session sequence IDs
- Pluggable agent interface, starting with Codex

Core shape:

```txt
Browser UI
  |-- POST /api/sessions
  |-- POST /api/sessions/:id/messages
  |-- GET  /api/sessions/:id/events/stream
  `-- GET  /api/sessions/:id/events?after_seq=N

Go Orchestrator
  |-- Session manager
  |-- Event bus
  |-- Agent runner interface
  |-- Codex adapter
  |-- SQLite event store
  `-- Static React asset server
```

## Non-Negotiable Design Rules

- The backend is the source of truth.
- The event stream is the canonical representation of a session.
- Every event gets a monotonically increasing `seq` per session.
- Events are persisted before being broadcast.
- Reconnect recovery is driven by `after_seq`.
- Agent-specific behavior stays behind adapter boundaries.
- Failures are persisted and visible.
- No automatic retries in the MVP unless explicitly added later.

## Milestone 1: Project Skeleton

Create the base Go and frontend layout.

Suggested structure:

```txt
/cmd/app/main.go
/internal/http
/internal/session
/internal/events
/internal/agents
/internal/agents/codex
/internal/store
/internal/config
/web
```

Initial technology choices:

- Go HTTP server using `net/http` or `chi`
- SQLite using `modernc.org/sqlite` or `mattn/go-sqlite3`
- Server-Sent Events for streaming
- Vite and React for the frontend
- Go `embed` for production frontend assets

Development tooling:

```txt
bun run dev           # local Go rebuild/restart plus Vite HMR
bun run dev:tailnet   # same stack with Vite reachable on the tailnet
```

Exit criteria:

- Go module exists.
- Backend server starts.
- Frontend app starts in development mode.
- Basic health endpoint works.
- Repository has repeatable local development commands.

## Milestone 2: Core Data Model

Use event-sourcing-style storage without overbuilding a full event-sourcing framework.

### `sessions`

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  completed_at DATETIME
);
```

Expected session statuses:

```txt
idle
running
completed
failed
cancelled
```

### `events`

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,

  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

Expected event statuses:

```txt
started
delta
completed
failed
cancelled
```

Example event:

```json
{
  "seq": 42,
  "type": "agent.message.delta",
  "status": "delta",
  "payload": {
    "text": "Creating the file..."
  }
}
```

Exit criteria:

- Migrations create `sessions` and `events`.
- Session creation persists data.
- Event inserts enforce unique `(session_id, seq)`.
- Tests cover sequence assignment and duplicate sequence rejection.

## Milestone 3: Event System

Implement an internal event path that all agent output uses.

Core event type:

```go
type Event struct {
    ID        string
    SessionID string
    Seq       int64
    Type      string
    Role      string
    Status    string
    Payload   json.RawMessage
    CreatedAt time.Time
}
```

Required flow:

```txt
agent emits event
  -> assign seq
  -> persist to SQLite
  -> append to memory buffer
  -> broadcast to connected clients
```

Maintain an in-memory sliding buffer per session:

```go
type SessionBuffer struct {
    Events []Event
    Max    int
}
```

Use SQLite as the fallback for full replay. The buffer is an optimization for live clients and recent reconnects, not the source of truth.

Exit criteria:

- One code path handles event append, persistence, buffering, and broadcast.
- Persistence happens before broadcast.
- Tests prove broadcast is not attempted if persistence fails.
- Event append returns the assigned sequence number.

## Milestone 4: Streaming And Replay

Start with Server-Sent Events.

Stream endpoint:

```http
GET /api/sessions/{sessionId}/events/stream?after_seq=123
```

Behavior:

1. Load missed events from SQLite where `seq > after_seq`.
2. Send missed events first.
3. Subscribe the client to the live event bus.
4. Continue streaming new events.

SSE payload shape:

```txt
id: 124
event: agent.message.delta
data: {"seq":124,"type":"agent.message.delta","payload":{"text":"..."}}
```

Browser reconnect behavior:

```txt
client tracks latest seq
client reconnects with ?after_seq=lastSeq
server replays missing events
stream resumes live
```

Exit criteria:

- Browser receives live events over SSE.
- `after_seq` replays missing events before live events.
- Refresh or reconnect does not lose events.
- Tests cover replay ordering and no duplicate live delivery across reconnect.

## Milestone 5: HTTP API Surface

Implement the minimal API needed for the MVP.

### Create Session

```http
POST /api/sessions
```

Request:

```json
{
  "agent_type": "codex",
  "title": "Refactor auth middleware"
}
```

Response:

```json
{
  "session_id": "sess_..."
}
```

### Send Message Or Task

```http
POST /api/sessions/{sessionId}/messages
```

Request:

```json
{
  "content": "Inspect this repo and propose a plan."
}
```

Server behavior:

1. Persist `user.message.completed`.
2. Mark the session `running`.
3. Start agent execution.
4. Stream agent events.

### Fetch Event History

```http
GET /api/sessions/{sessionId}/events?after_seq=0&limit=500
```

### Cancel Session

```http
POST /api/sessions/{sessionId}/cancel
```

Exit criteria:

- API supports session creation, message submission, history fetch, stream, and cancellation.
- Error responses are structured and consistent.
- Invalid session IDs and invalid state transitions are handled explicitly.

## Milestone 6: Agent Interface

Keep the interface small and provider-neutral.

```go
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
```

Adapter targets:

- Codex
- Claude
- OpenAI Responses API
- Local shell-based agents
- Future remote workers

Exit criteria:

- Orchestrator depends only on the `Agent` interface.
- A fake agent can run through the full session/event/streaming path.
- Agent cancellation is context-driven.
- Tests cover adapter registration and run lifecycle.

## Milestone 7: Codex Adapter

Start with Codex, but keep Codex-specific behavior contained in:

```txt
/internal/agents/codex/adapter.go
```

Responsibilities:

- Launch Codex process or connect to Codex server mode.
- Capture stdout, stderr, and structured events where available.
- Normalize Codex output into Gorchestra events.
- Handle process exit.
- Emit status events clearly.

Example normalization:

```txt
codex.started             -> agent.run.started
codex.stdout              -> agent.log.delta
codex.tool_call.started   -> tool.call.started
codex.tool_call.completed -> tool.call.completed
codex.completed           -> agent.run.completed
codex.error               -> agent.run.failed
```

Important implementation note:

Verify the exact Codex event protocol before locking down the adapter. The adapter exists specifically so Codex protocol changes do not leak into the orchestrator.

Exit criteria:

- Codex can execute a submitted task.
- Codex output appears as normalized Gorchestra events.
- Process failure emits `agent.run.failed`.
- Cancellation terminates the Codex run and emits `agent.run.cancelled`.

## Milestone 8: Frontend MVP

Build a React app for monitoring and controlling sessions.

Screens:

```txt
Session list
Session detail
Live event stream
Prompt/task input
Run status
Cancel button
```

Frontend state model:

```ts
type SessionState = {
  sessionId: string
  status: "idle" | "running" | "completed" | "failed" | "cancelled"
  events: AgentEvent[]
  lastSeq: number
}
```

Streaming hook:

```ts
useSessionEvents(sessionId, lastSeq)
```

Behavior:

- Open SSE connection with `after_seq=lastSeq`.
- Append incoming events.
- Update `lastSeq`.
- Reconnect with latest `lastSeq` after disconnect.
- Render partial and delta events live.
- Do not use local storage or a local database in the MVP.

Exit criteria:

- User can create/select a session.
- User can submit a prompt.
- Live events render incrementally.
- Refresh reconstructs the session from the server.
- Reconnect state is visible.

## Milestone 9: UX Details

Optimize for long-running agents and mobile reconnects.

Required UX details:

- Clear running state.
- Visible reconnecting state when SSE drops.
- Last received event time.
- Noisy logs and tool calls grouped behind expandable rows.
- Latest output pinned near the bottom.
- Persisted history available when scrolling back.
- Exact failed event and payload visible on failure.

Event display groups:

```txt
User message
Agent message
Thinking/planning
Tool call
File change
Command output
Error
Completion
```

Exit criteria:

- Long sessions stay scannable.
- Errors are not hidden.
- Mobile layout supports session monitoring and cancellation.

## Milestone 10: Resilience Rules

Initial resilience posture:

- No automatic retries by default.
- Prefer transparent failure states.
- User can manually rerun or continue.
- All failures are persisted as events.

Every agent run should end in one terminal event:

```txt
agent.run.completed
agent.run.failed
agent.run.cancelled
```

Exit criteria:

- Cancelled, failed, and completed runs are distinguishable in the UI and database.
- Agent run lifecycle cannot silently disappear without a terminal event.
- Restarting the server preserves session history.

## Milestone 11: Packaging

Package Gorchestra as a single executable that can be downloaded directly, installed through Homebrew, or launched as a background service.

Target install/run shape:

```sh
brew install jgennari/tap/gorchestra
gorchestra
```

Optional background service shape:

```sh
brew services start gorchestra
```

Production build:

```txt
cd web && bun install --frozen-lockfile && bun run build
go test ./...
go build -o dist/gorchestra ./cmd/app
```

Go embeds the frontend build output. The embed package must live at or above the asset directory according to Go `embed` rules; one acceptable layout is to copy Vite output into an internal package before building:

```txt
internal/webassets/
  assets.go
  dist/
    index.html
    assets/...
```

Example embed shape:

```go
//go:embed dist/*
var webAssets embed.FS
```

Runtime behavior:

- Start one Go HTTP server.
- Serve `/api/*` from backend handlers.
- Serve embedded React assets for browser routes.
- Fall back to `index.html` for frontend routes.
- Store SQLite data in an OS-appropriate app data directory by default.
- Allow explicit configuration with flags and environment variables.

Default data paths:

```txt
macOS: ~/Library/Application Support/Gorchestra/gorchestra.db
Linux: $XDG_DATA_HOME/gorchestra/gorchestra.db
Fallback: ~/.local/share/gorchestra/gorchestra.db
```

Expected CLI surface:

```txt
gorchestra --host 127.0.0.1 --port 8080 --data-dir <path> --open
gorchestra --version
```

Final local artifact:

```txt
gorchestra
```

Local run shape:

```bash
./gorchestra --data-dir ./data --port 8080
```

Homebrew release requirements:

- Versioned GitHub release artifacts for supported platforms.
- Checksums for each release artifact.
- A Homebrew formula that installs the binary.
- Optional service definition for `brew services`.
- Release notes that document upgrade behavior and data location.

Exit criteria:

- One binary serves the API and frontend.
- App can start from an empty SQLite database.
- Session history survives restart.
- CLI flags and environment variables are documented.
- Release artifacts are reproducible from documented commands.
- Homebrew formula can install and run the binary.
- Production build steps are documented and repeatable.

## Milestone 12: Later Enhancements

Defer until the MVP is working:

- Auth
- Multi-user permissions
- Workspace and repo management
- Agent pool scheduling
- Multiple concurrent agents per session
- WebSocket transport
- Background job queue
- Remote worker nodes
- Prompt/version tracking
- Cost tracking
- OpenTelemetry traces
- Claude adapter
- OpenAI Responses adapter
- Local session export/import

## Suggested Build Order

1. Go API skeleton
2. SQLite migrations
3. Session and event tables
4. Event persistence
5. SSE streaming
6. Replay from `after_seq`
7. Fake/mock agent
8. React live event viewer
9. Codex adapter
10. Cancellation
11. Mobile reconnection polish
12. Embed frontend into Go binary

## MVP Success Criteria

The first usable version is complete when:

1. A user can create a session.
2. A prompt can be submitted.
3. A fake agent can stream events through the full stack.
4. Codex can execute work through the adapter.
5. Events stream live to connected browsers.
6. Events are persisted to SQLite before broadcast.
7. Browser refreshes and reconnects recover automatically.
8. Session history survives application restarts.
9. The system is deployable as a single executable.
