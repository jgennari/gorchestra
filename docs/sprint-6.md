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

- [ ] Add a run manager that tracks active runs by session ID.
- [ ] Register a run before starting the agent goroutine.
- [ ] Reject registration when a run already exists for the session.
- [ ] Store the cancellation function for each active run.
- [ ] Expose cancel behavior by session ID.
- [ ] Remove active run state when the run exits.
- [ ] Make cleanup idempotent.
- [ ] Protect active run state with synchronization.
- [ ] Do not hold run manager locks while calling agents, store methods, or event service methods.

### Fake Agent Cancellation

- [ ] Make the fake agent observe `ctx.Done()`.
- [ ] Add a test-controlled delay or step barrier so cancellation can be tested deterministically.
- [ ] Return `context.Canceled` when cancelled.
- [ ] Avoid emitting successful completion events after cancellation.
- [ ] Keep the normal successful fake run behavior from Sprint 5 unchanged.

### Cancel API

- [ ] Add `POST /api/sessions/{sessionId}/cancel`.
- [ ] Load the session before attempting cancellation.
- [ ] Return HTTP 404 for unknown session IDs.
- [ ] Return HTTP 409 for `idle`, `completed`, `failed`, or `cancelled` sessions.
- [ ] Return HTTP 202 when cancellation is accepted for a running session.
- [ ] Cancel the run context through the run manager.
- [ ] Return structured JSON responses.

Success response:

```json
{
  "session_id": "sess_...",
  "status": "cancelling"
}
```

### Run Lifecycle

- [ ] Ensure every scheduled run emits exactly one terminal run event.
- [ ] On successful agent return, emit `agent.run.completed` if the agent did not already emit it.
- [ ] On agent error, emit `agent.run.failed` unless the error is cancellation.
- [ ] On context cancellation, emit `agent.run.cancelled`.
- [ ] Mark session `completed` after successful completion.
- [ ] Mark session `failed` after failure.
- [ ] Mark session `cancelled` after cancellation.
- [ ] Set `completed_at` for all terminal session statuses.
- [ ] Ensure cleanup runs after all terminal event and session status updates.
- [ ] Log lifecycle failures with session ID and agent type.

### State Rules

- [ ] Only `idle` sessions can accept a new message in this sprint.
- [ ] `running` sessions reject new messages with HTTP 409.
- [ ] Terminal sessions reject new messages with HTTP 409.
- [ ] Running sessions can be cancelled once.
- [ ] Terminal sessions cannot be cancelled.
- [ ] No run manager entry should remain after a terminal state is reached.

### Error Handling

- [ ] Return HTTP 400 for malformed cancel requests if a body is ever accepted.
- [ ] Return HTTP 404 for unknown session IDs.
- [ ] Return HTTP 409 for invalid session state.
- [ ] Return HTTP 500 for unexpected store, event service, or run manager failures.
- [ ] Do not emit cancellation events for sessions that were never running.

### Tests

- [ ] Test cancelling a running fake-agent session returns HTTP 202.
- [ ] Test cancellation emits `agent.run.cancelled`.
- [ ] Test cancellation marks the session `cancelled`.
- [ ] Test cancelled fake runs do not emit `agent.run.completed`.
- [ ] Test active run state is cleaned up after cancellation.
- [ ] Test cancelling an unknown session returns HTTP 404.
- [ ] Test cancelling an idle session returns HTTP 409.
- [ ] Test cancelling a completed session returns HTTP 409.
- [ ] Test duplicate cancellation returns HTTP 409 after the session becomes terminal.
- [ ] Test duplicate message submission while running returns HTTP 409.
- [ ] Test successful runs emit exactly one terminal event.
- [ ] Test failed runs emit exactly one terminal event.
- [ ] Test cancelled runs emit exactly one terminal event.
- [ ] Test `go test ./...` passes.
- [ ] Test `go test -race ./...` passes or document any race-test limitation.

Use deterministic fake-agent synchronization in tests. Do not rely on sleep timing when a channel or barrier would make the test exact.

### Version Control

- [ ] Commit Sprint 6 in one dedicated git commit after verification passes.

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
