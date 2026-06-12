# Sprint 6: Run Control And Cancellation

Sprint 6 hardens agent run lifecycle behavior before real provider integration. The goal is to make running sessions cancellable, enforce terminal states, and ensure every run ends with one clear terminal event.

This sprint builds on the fake agent from Sprint 5. Codex remains out of scope until cancellation and cleanup are proven against deterministic local behavior.

## Goal

Add:

- `POST /api/sessions/{sessionId}/cancel`
- An active run manager for running sessions
- Context-driven cancellation for fake agent runs
- Terminal lifecycle guarantees for completed, failed, and cancelled runs

Sprint 6 should leave the repository ready for Sprint 7, where the Codex adapter can use the same run-control path.

## Scope

In scope:

- Track active agent runs by session ID.
- Store each running session's cancellation function.
- Cancel fake agent work through context cancellation.
- Add the cancel HTTP endpoint.
- Emit `agent.run.cancelled`.
- Mark cancelled sessions as `cancelled`.
- Prevent duplicate active runs per session.
- Clean up active run state after completion, failure, or cancellation.
- Add tests for cancellation, duplicate cancellation, terminal events, and cleanup.

Out of scope:

- Codex adapter.
- Provider process management.
- Durable background job queue.
- Restart recovery for in-flight runs.
- Multi-agent sessions.
- Frontend session UI.
- Auth or multi-user permissions.

## Decisions

- Run manager package: `internal/session` unless an equivalent package already owns orchestration.
- Active run key: session ID.
- Cancellation mechanism: `context.Context`.
- Cancel endpoint success for a running session: HTTP 202.
- Cancel missing session: HTTP 404.
- Cancel idle session: HTTP 409.
- Cancel already terminal session: HTTP 409.
- Cancel session with no active run but `running` status: mark `failed`, persist `agent.run.failed`, and return HTTP 409.
- Duplicate message submission while running remains HTTP 409.
- Exactly one terminal run event may be emitted for each scheduled run.
- Terminal run events: `agent.run.completed`, `agent.run.failed`, `agent.run.cancelled`.
- Terminal session statuses: `completed`, `failed`, `cancelled`.
- No automatic retries.

## Checklist

### Active Run Manager

- [x] Add a run manager that tracks active runs by session ID.
- [x] Register a run before starting the agent goroutine.
- [x] Reject registration when a run already exists for the session.
- [x] Store the cancellation function for each active run.
- [x] Expose cancel behavior by session ID.
- [x] Remove active run state when the run exits.
- [x] Make cleanup idempotent.
- [x] Protect active run state with synchronization.
- [x] Do not hold run manager locks while calling agents, store methods, or event service methods.

### Fake Agent Cancellation

- [x] Make the fake agent observe `ctx.Done()`.
- [x] Add a test-controlled delay or step barrier so cancellation can be tested deterministically.
- [x] Return `context.Canceled` when cancelled.
- [x] Avoid emitting successful completion events after cancellation.
- [x] Keep the normal successful fake run behavior from Sprint 5 unchanged.

### Cancel API

- [x] Add `POST /api/sessions/{sessionId}/cancel`.
- [x] Load the session before attempting cancellation.
- [x] Return HTTP 404 for unknown session IDs.
- [x] Return HTTP 409 for `idle`, `completed`, `failed`, or `cancelled` sessions.
- [x] Return HTTP 202 when cancellation is accepted for a running session.
- [x] Cancel the run context through the run manager.
- [x] Return structured JSON responses.

Success response:

```json
{
  "session_id": "sess_...",
  "status": "cancelling"
}
```

### Run Lifecycle

- [x] Ensure every scheduled run emits exactly one terminal run event.
- [x] On successful agent return, emit `agent.run.completed` if the agent did not already emit it.
- [x] On agent error, emit `agent.run.failed` unless the error is cancellation.
- [x] On context cancellation, emit `agent.run.cancelled`.
- [x] Mark session `completed` after successful completion.
- [x] Mark session `failed` after failure.
- [x] Mark session `cancelled` after cancellation.
- [x] Set `completed_at` for all terminal session statuses.
- [x] Ensure cleanup runs after all terminal event and session status updates.
- [x] Log lifecycle failures with session ID and agent type.

### State Rules

- [x] Only `idle` sessions can accept a new message in this sprint.
- [x] `running` sessions reject new messages with HTTP 409.
- [x] Terminal sessions reject new messages with HTTP 409.
- [x] Running sessions can be cancelled once.
- [x] Terminal sessions cannot be cancelled.
- [x] No run manager entry should remain after a terminal state is reached.

### Error Handling

- [x] Return HTTP 400 for malformed cancel requests if a body is ever accepted.
- [x] Return HTTP 404 for unknown session IDs.
- [x] Return HTTP 409 for invalid session state.
- [x] Return HTTP 500 for unexpected store, event service, or run manager failures.
- [x] Do not emit cancellation events for sessions that were never running.

### Tests

- [x] Test cancelling a running fake-agent session returns HTTP 202.
- [x] Test cancellation emits `agent.run.cancelled`.
- [x] Test cancellation marks the session `cancelled`.
- [x] Test cancelled fake runs do not emit `agent.run.completed`.
- [x] Test active run state is cleaned up after cancellation.
- [x] Test cancelling an unknown session returns HTTP 404.
- [x] Test cancelling an idle session returns HTTP 409.
- [x] Test cancelling a completed session returns HTTP 409.
- [x] Test duplicate cancellation returns HTTP 409 after the session becomes terminal.
- [x] Test duplicate message submission while running returns HTTP 409.
- [x] Test successful runs emit exactly one terminal event.
- [x] Test failed runs emit exactly one terminal event.
- [x] Test cancelled runs emit exactly one terminal event.
- [x] Test `go test ./...` passes.
- [x] Test `go test -race ./...` passes or document any race-test limitation.

Use deterministic fake-agent synchronization in tests. Do not rely on sleep timing when a channel or barrier would make the test exact.

### Version Control

- [x] Commit Sprint 6 in one dedicated git commit after verification passes.

## Public Interfaces

Sprint 6 adds cancellation:

```http
POST /api/sessions/{sessionId}/cancel
```

Accepted response:

```json
{
  "session_id": "sess_...",
  "status": "cancelling"
}
```

Expected errors:

- HTTP 404 for unknown sessions.
- HTTP 409 for idle sessions.
- HTTP 409 for completed, failed, or cancelled sessions.

The existing session creation, message submission, event history, and SSE endpoints remain stable.

## Completion Criteria

Sprint 6 is complete when:

- Running fake-agent sessions can be cancelled over HTTP.
- Cancellation emits `agent.run.cancelled`.
- Cancelled sessions are marked `cancelled`.
- Completed, failed, and cancelled runs each produce exactly one terminal run event.
- Active run state is cleaned up after every terminal outcome.
- Invalid cancel attempts return clear errors.
- Duplicate active runs for the same session are impossible.
- `go test ./...` passes.
- `go test -race ./...` passes or any limitation is documented.
- No Codex adapter, provider process management, durable job queue, or frontend session UI has been added.

## Handoff To Sprint 7

Sprint 7 should add the first real provider adapter:

- Add `internal/agents/codex`.
- Verify the current Codex invocation and event/output protocol.
- Normalize Codex output into Gorchestra events.
- Use the Sprint 6 run manager for cancellation.
- Keep Codex-specific behavior out of the orchestrator.
