# Sprint 4: HTTP Event History And SSE Streaming

Sprint 4 exposes the durable event store and internal event pipeline over HTTP. The goal is to let clients fetch event history and receive live session events through Server-Sent Events without losing events across reconnects.

This sprint adds browser-facing event visibility only. Session creation, prompt submission, agents, cancellation, and frontend session UI remain out of scope.

## Goal

Add HTTP endpoints for session event history and live event streaming:

- `GET /api/sessions/{sessionId}/events?after_seq=N&limit=500`
- `GET /api/sessions/{sessionId}/events/stream?after_seq=N`

Sprint 4 should leave the repository ready for Sprint 5, where session creation and message submission can use the same persisted event flow.

## Scope

In scope:

- Add an event history endpoint backed by SQLite.
- Add an SSE stream endpoint backed by SQLite replay plus Sprint 3 live subscriptions.
- Parse and validate `after_seq` and `limit`.
- Serialize persisted events consistently for HTTP and SSE.
- Handle browser disconnects through request context cancellation.
- Add tests for event history, replay, streaming, ordering, and reconnect behavior.

Out of scope:

- `POST /api/sessions`.
- `POST /api/sessions/{sessionId}/messages`.
- `POST /api/sessions/{sessionId}/cancel`.
- Agent interface.
- Fake/mock agent.
- Codex adapter.
- Frontend session UI.
- Authentication.
- WebSocket transport.

## Decisions

- HTTP router remains `chi`.
- Route package follows the Sprint 1 backend structure.
- Event history source: SQLite `ListEvents`.
- Live source: Sprint 3 event service subscriptions.
- Replay source for stream setup: SQLite, not the in-memory buffer.
- `after_seq` default: `0`.
- `after_seq` minimum: `0`; negative values return HTTP 400.
- `limit` default: `500`.
- `limit` maximum: `1000`; larger values are capped to `1000`.
- Missing or unknown session IDs return HTTP 404.
- SSE event `id`: event sequence number as a string.
- SSE event name: persisted event `type`.
- SSE data: JSON event response object.
- SSE `Content-Type`: `text/event-stream`.
- SSE connections must disable response buffering where supported.

## Checklist

### Event Response Shape

- [ ] Add one JSON response shape for events used by both history and SSE.
- [ ] Include `id`, `session_id`, `seq`, `type`, `role`, `status`, `payload`, and `created_at`.
- [ ] Emit `payload` as JSON, not an escaped JSON string.
- [ ] Use UTC timestamps.
- [ ] Keep field names snake_case.

Example response event:

```json
{
  "id": "evt_...",
  "session_id": "sess_...",
  "seq": 124,
  "type": "agent.message.delta",
  "role": "assistant",
  "status": "delta",
  "payload": {
    "text": "Creating the file..."
  },
  "created_at": "2026-06-12T16:00:00Z"
}
```

### Event History Endpoint

- [ ] Add `GET /api/sessions/{sessionId}/events`.
- [ ] Validate that the session exists.
- [ ] Parse `after_seq`; default to `0`.
- [ ] Reject negative `after_seq` with HTTP 400.
- [ ] Parse `limit`; default to `500`.
- [ ] Reject non-numeric `limit` with HTTP 400.
- [ ] Cap `limit` at `1000`.
- [ ] Return events where `seq > after_seq`.
- [ ] Return events ordered by ascending `seq`.
- [ ] Return an empty list when no events match.

Response shape:

```json
{
  "events": []
}
```

### SSE Stream Endpoint

- [ ] Add `GET /api/sessions/{sessionId}/events/stream`.
- [ ] Validate that the session exists before starting the stream.
- [ ] Parse `after_seq`; default to `0`.
- [ ] Reject negative `after_seq` with HTTP 400.
- [ ] Set SSE headers before writing event data.
- [ ] Flush after each SSE event.
- [ ] Stop streaming when the request context is cancelled.
- [ ] Unsubscribe from the event service when the stream ends.

SSE frame shape:

```txt
id: 124
event: agent.message.delta
data: {"id":"evt_...","session_id":"sess_...","seq":124,"type":"agent.message.delta","role":"assistant","status":"delta","payload":{"text":"..."},"created_at":"2026-06-12T16:00:00Z"}

```

### Replay And Live Ordering

- [ ] Avoid the replay/subscribe gap during stream setup.
- [ ] Subscribe to the session's live event stream.
- [ ] Query SQLite for events where `seq > after_seq`.
- [ ] Send replayed events in ascending `seq`.
- [ ] Track the highest `seq` sent.
- [ ] Continue with live events from the subscription.
- [ ] Skip any live event with `seq <= highestSeqSent`.
- [ ] Send live events in the order received from the event service.

This order prevents events appended during stream setup from being lost. Duplicates are acceptable internally during setup only if they are filtered before writing to the client.

### Error Handling

- [ ] Return structured JSON errors for non-streaming failures.
- [ ] Return HTTP 400 for invalid query parameters.
- [ ] Return HTTP 404 for unknown sessions.
- [ ] Return HTTP 500 for store or event service failures before streaming starts.
- [ ] After SSE headers are written, represent recoverable stream errors as SSE `error` events only when useful.
- [ ] Always clean up subscriptions on stream exit.

### Tests

- [ ] Test event history returns events after `after_seq`.
- [ ] Test event history applies the default limit.
- [ ] Test event history caps large limits at `1000`.
- [ ] Test event history rejects invalid `after_seq`.
- [ ] Test event history returns 404 for an unknown session.
- [ ] Test SSE replay sends missed events before live events.
- [ ] Test SSE uses `id`, `event`, and `data` fields.
- [ ] Test SSE skips duplicate live events already sent during replay.
- [ ] Test events appended during stream setup are not lost.
- [ ] Test stream cleanup unsubscribes when the request is cancelled.
- [ ] Test `go test ./...` passes.

Use HTTP handler tests with fake store/event-service dependencies where possible. Use SQLite-backed integration tests for replay ordering when fake dependencies would hide store behavior.

### Version Control

- [ ] Commit Sprint 4 in one dedicated git commit after verification passes.

## Public Interfaces

Sprint 4 adds event history:

```http
GET /api/sessions/{sessionId}/events?after_seq=0&limit=500
```

Success response:

```json
{
  "events": [
    {
      "id": "evt_...",
      "session_id": "sess_...",
      "seq": 1,
      "type": "user.message.completed",
      "role": "user",
      "status": "completed",
      "payload": {
        "text": "Inspect this repo."
      },
      "created_at": "2026-06-12T16:00:00Z"
    }
  ]
}
```

Sprint 4 adds event streaming:

```http
GET /api/sessions/{sessionId}/events/stream?after_seq=0
```

SSE frame:

```txt
id: 1
event: user.message.completed
data: {"id":"evt_...","session_id":"sess_...","seq":1,"type":"user.message.completed","role":"user","status":"completed","payload":{"text":"Inspect this repo."},"created_at":"2026-06-12T16:00:00Z"}

```

No write APIs are introduced in Sprint 4.

## Completion Criteria

Sprint 4 is complete when:

- Event history is available over HTTP.
- SSE clients receive missed events from SQLite before live events.
- Events appended during stream setup are not lost.
- Browser or test clients can reconnect with `after_seq` and resume without duplicates being written.
- Invalid query parameters and unknown sessions return clear errors.
- Request cancellation cleans up live subscriptions.
- `go test ./...` passes.
- No session creation, message submission, agent runner, cancellation, or frontend session UI has been added.

## Handoff To Sprint 5

Sprint 5 should add the first write-side API surface:

- `POST /api/sessions`.
- `POST /api/sessions/{sessionId}/messages`.
- Session status transitions for submitted work.
- User message events persisted through the event service.
- A fake/mock agent to exercise the full session-to-event path before Codex.
