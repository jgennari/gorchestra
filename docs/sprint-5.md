# Sprint 5: Session Write API And Fake Agent

Sprint 5 adds the first write-side API surface. The goal is to create sessions, submit user messages, persist those messages as events, and run a deterministic fake agent through the existing event service.

This sprint creates the first backend vertical slice: HTTP write request -> session state change -> persisted events -> live stream visibility. Codex and frontend session UI remain out of scope.

## Goal

Add:

- `POST /api/sessions`
- `POST /api/sessions/{sessionId}/messages`
- A minimal provider-neutral agent interface
- A fake agent implementation for end-to-end event flow testing

Sprint 5 should leave the repository ready for Sprint 6, where cancellation and run lifecycle hardening can be added before Codex integration.

## Scope

In scope:

- Add session creation over HTTP.
- Add message submission over HTTP.
- Add session status update behavior in the store if Sprint 2 did not already add it.
- Add a small agent interface in `internal/agents`.
- Add a deterministic fake agent in `internal/agents/fake`.
- Run fake agent jobs asynchronously after message submission.
- Persist user messages and fake agent output through the Sprint 3 event service.
- Make fake agent output visible through the Sprint 4 history and SSE endpoints.
- Add tests for session creation, message submission, state transitions, and fake agent event emission.

Out of scope:

- Codex adapter.
- Cancellation endpoint.
- Multiple concurrent runs in one session.
- Agent process supervision.
- Workdir/repo management.
- Frontend session UI.
- Auth or multi-user behavior.
- Durable background job queue.

## Decisions

- Supported Sprint 5 agent type: `fake`
- Unsupported `agent_type` values return HTTP 400.
- `POST /api/sessions` returns HTTP 201.
- `POST /api/sessions/{sessionId}/messages` returns HTTP 202 after the fake agent run is scheduled.
- Empty message content returns HTTP 400.
- Message submission to a `running` session returns HTTP 409.
- Message submission to a missing session returns HTTP 404.
- Session status transitions in this sprint: `idle -> running -> completed` or `idle -> running -> failed`.
- User messages are persisted before the session is marked `running`.
- Fake agent events are emitted only through the event service.
- Fake agent runs in a goroutine using a request-independent context.
- Sprint 5 does not support cancellation; cancellation is Sprint 6.

## Checklist

### Session Store Updates

- [x] Add store behavior to update session status and timestamps.
- [x] Support setting `completed_at` when a session enters `completed`, `failed`, or `cancelled`.
- [x] Keep `updated_at` current on every status change.
- [x] Ensure invalid or missing session IDs return typed errors handlers can map to HTTP status codes.
- [x] Add tests for status transitions and timestamp updates.

### Agent Interface

- [x] Create `internal/agents`.
- [x] Add a provider-neutral `Agent` interface.
- [x] Add `AgentInput`, `AgentEvent`, and `EmitFunc` types.
- [x] Keep the interface independent from HTTP and SQLite.
- [x] Convert `AgentEvent` payloads to JSON before appending through the event service.
- [x] Add a registry or lookup function for supported agents.

Interface shape:

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

### Fake Agent

- [x] Create `internal/agents/fake`.
- [x] Implement `Type() string` returning `fake`.
- [x] Emit `agent.run.started`.
- [x] Emit at least one `agent.message.delta`.
- [x] Emit `agent.message.completed`.
- [x] Emit `agent.run.completed` before returning nil.
- [x] Return an error only when configured by a test.
- [x] Keep output deterministic so tests can assert exact event order.

Required successful fake run event order:

```txt
agent.run.started
agent.message.delta
agent.message.completed
agent.run.completed
```

Suggested fake message payloads:

```json
{"text":"Fake agent started."}
{"text":"Received task: <user message>"}
{"text":"Fake agent completed the task."}
{"agent_type":"fake"}
```

### Session Creation API

- [x] Add `POST /api/sessions`.
- [x] Decode JSON body.
- [x] Require `agent_type`.
- [x] Accept only `agent_type: "fake"` in Sprint 5.
- [x] Accept optional `title`.
- [x] Create an `idle` session through the store.
- [x] Return HTTP 201 and the new session ID.

Request:

```json
{
  "agent_type": "fake",
  "title": "Inspect repository"
}
```

Response:

```json
{
  "session_id": "sess_..."
}
```

### Message Submission API

- [x] Add `POST /api/sessions/{sessionId}/messages`.
- [x] Decode JSON body.
- [x] Require non-empty `content`.
- [x] Return HTTP 404 for missing sessions.
- [x] Return HTTP 409 when the session is already `running`.
- [x] Persist a `user.message.completed` event through the event service.
- [x] Mark the session `running`.
- [x] Start the selected agent asynchronously.
- [x] Return HTTP 202 after scheduling the run.

Request:

```json
{
  "content": "Inspect this repo and propose a plan."
}
```

Response:

```json
{
  "session_id": "sess_...",
  "status": "running"
}
```

Persisted user event:

```json
{
  "type": "user.message.completed",
  "role": "user",
  "status": "completed",
  "payload": {
    "text": "Inspect this repo and propose a plan."
  }
}
```

### Agent Run Lifecycle

- [x] Load the session and selected agent before scheduling.
- [x] Convert each `AgentEvent` into an event service append.
- [x] If the agent returns nil, mark the session `completed`.
- [x] If the agent returns an error, append `agent.run.failed` and mark the session `failed`.
- [x] If event append fails during the agent run, mark the session `failed`.
- [x] Ensure every scheduled fake run ends with either `agent.run.completed` or `agent.run.failed`.
- [x] Log background run failures with session ID and agent type.

### Error Responses

- [x] Return structured JSON errors.
- [x] Return HTTP 400 for malformed JSON.
- [x] Return HTTP 400 for missing `agent_type`.
- [x] Return HTTP 400 for unsupported `agent_type`.
- [x] Return HTTP 400 for empty message content.
- [x] Return HTTP 404 for unknown session IDs.
- [x] Return HTTP 409 for message submission while running.
- [x] Return HTTP 500 for unexpected store or event service failures.

### Tests

- [x] Test `POST /api/sessions` creates an idle fake-agent session.
- [x] Test `POST /api/sessions` rejects unsupported agents.
- [x] Test `POST /api/sessions` rejects missing `agent_type`.
- [x] Test `POST /api/sessions/{sessionId}/messages` persists `user.message.completed`.
- [x] Test message submission marks the session `running`.
- [x] Test fake agent emits the expected event order.
- [x] Test successful fake run marks the session `completed`.
- [x] Test fake agent error emits `agent.run.failed` and marks the session `failed`.
- [x] Test message submission to a running session returns HTTP 409.
- [x] Test missing session returns HTTP 404.
- [x] Test events from the fake agent are visible through the Sprint 4 event history endpoint.
- [x] Test `go test ./...` passes.

Use fake or controllable agents in handler tests so background run outcomes are deterministic.

### Version Control

- [x] Commit Sprint 5 in one dedicated git commit after verification passes.

## Public Interfaces

Sprint 5 adds session creation:

```http
POST /api/sessions
```

Request:

```json
{
  "agent_type": "fake",
  "title": "Inspect repository"
}
```

Success response:

```json
{
  "session_id": "sess_..."
}
```

Sprint 5 adds message submission:

```http
POST /api/sessions/{sessionId}/messages
```

Request:

```json
{
  "content": "Inspect this repo and propose a plan."
}
```

Success response:

```json
{
  "session_id": "sess_...",
  "status": "running"
}
```

Sprint 5 does not add cancellation or Codex-specific APIs.

## Completion Criteria

Sprint 5 is complete when:

- A session can be created with `agent_type: "fake"`.
- A message can be submitted to an idle session.
- The user message is persisted as `user.message.completed`.
- The fake agent emits events through the event service.
- The fake agent events are visible through event history and SSE.
- Successful fake runs mark sessions `completed`.
- Failed fake runs mark sessions `failed` and persist `agent.run.failed`.
- Running sessions reject additional message submissions with HTTP 409.
- `go test ./...` passes.
- No Codex adapter, cancellation endpoint, durable job queue, or frontend session UI has been added.

## Handoff To Sprint 6

Sprint 6 should harden run control before real provider integration:

- Add `POST /api/sessions/{sessionId}/cancel`.
- Track active runs and cancellation contexts.
- Emit `agent.run.cancelled`.
- Enforce terminal session states.
- Add tests for cancellation, duplicate cancellation, and cleanup.
