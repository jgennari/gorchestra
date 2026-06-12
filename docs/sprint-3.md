# Sprint 3: Internal Event Pipeline

Sprint 3 builds the internal event system on top of the SQLite store from Sprint 2. The goal is to create one server-owned path for appending, buffering, and broadcasting session events.

This sprint is intentionally internal. It prepares for SSE in Sprint 4, but does not expose streaming or session event APIs yet.

## Goal

Add an in-process event service that persists every event before it becomes visible to live subscribers.

Sprint 3 should leave the repository ready for Sprint 4, where HTTP event history and Server-Sent Events endpoints can be added using the same event service.

## Scope

In scope:

- Add an internal event service package.
- Wrap the Sprint 2 store append behavior in a single event append pipeline.
- Persist events before buffering or broadcasting.
- Maintain a sliding in-memory event buffer per session.
- Support session-scoped live subscriptions.
- Add tests for ordering, buffering, subscription delivery, unsubscribe behavior, and persistence-before-broadcast.

Out of scope:

- HTTP event history endpoint.
- HTTP SSE stream endpoint.
- Browser reconnect behavior.
- Agent interface.
- Fake/mock agent.
- Codex adapter.
- Session create/message HTTP APIs.
- Frontend session UI.
- Cancellation.

## Decisions

- Event service package: `internal/events`
- Store package dependency: use the Sprint 2 `internal/store` event types and append/list behavior
- Default per-session buffer size: `1000` events
- Default subscriber channel size: `64` events
- Buffer source of truth: memory optimization only; SQLite remains canonical
- Subscription scope: one session per subscription
- Live subscription behavior: subscriptions receive events appended after subscription starts
- Replay source for Sprint 4: SQLite `ListEvents`, not the in-memory buffer
- Slow subscriber behavior: if a subscriber channel is full during broadcast, unsubscribe and close that subscriber
- Broadcast guarantee: best effort for live subscribers after durable persistence; no event loss from the system because replay comes from SQLite

## Checklist

### Event Service

- [x] Create `internal/events`.
- [x] Add a service type that owns buffers and live subscribers.
- [x] Accept a store dependency through a small interface rather than a concrete database type.
- [x] Add an `Append` method that accepts session ID, event type, role, status, and JSON payload.
- [x] Call the store's `AppendEvent` from `Append`.
- [x] Return the persisted event with assigned ID, sequence, and timestamp.
- [x] Do not buffer or broadcast an event if store persistence fails.

### Store Boundary

- [x] Define the event service's required store interface around existing Sprint 2 behavior.
- [x] Reuse the persisted `store.Event` shape unless Sprint 2 names differ.
- [x] Keep sequence assignment in the store transaction.
- [x] Keep the event service responsible for post-persistence buffer and broadcast behavior.
- [x] Avoid duplicating SQL or migration logic in `internal/events`.

### Session Buffers

- [x] Maintain one sliding buffer per session.
- [x] Append persisted events to the session buffer after successful store append.
- [x] Trim the oldest events when the buffer exceeds `1000` events.
- [x] Preserve ascending sequence order in each buffer.
- [x] Add a read method for recent buffered events by session.
- [x] Treat the buffer as optional acceleration only; missing buffered events must be recoverable from SQLite later.

### Live Subscriptions

- [x] Add `Subscribe(sessionID string)` behavior that returns a receive-only event channel and an unsubscribe function.
- [x] Register subscribers per session.
- [x] Deliver only events for the subscribed session.
- [x] Deliver live events in ascending append order.
- [x] Remove the subscriber and close its channel when unsubscribe is called.
- [x] Remove all session subscriber state when the last subscriber unsubscribes.
- [x] If a subscriber channel is full during broadcast, remove it and close the channel.
- [x] Make unsubscribe safe to call more than once.

### Concurrency

- [x] Protect buffers and subscriber maps with synchronization.
- [x] Do not hold state locks while calling the store.
- [x] Do not allow a slow subscriber to block event persistence.
- [x] Do not allow one session's subscribers to receive another session's events.
- [x] Make concurrent appends safe when the store supports them.

### Tests

- [x] Test successful `Append` persists, buffers, and broadcasts an event in that order.
- [x] Test persistence failure prevents buffering and broadcasting.
- [x] Test subscribers receive only events for their session.
- [x] Test events are delivered in append order.
- [x] Test unsubscribe closes the channel and stops delivery.
- [x] Test unsubscribe is idempotent.
- [x] Test a full subscriber channel is removed and closed during broadcast.
- [x] Test the session buffer trims to `1000` events.
- [x] Test buffered events remain ordered after trimming.
- [x] Test concurrent appends do not race under `go test -race ./...`.

Use a fake store for event service unit tests where possible. Keep SQLite-backed integration tests in `internal/store`.

## Internal Interfaces

Sprint 3 should introduce behavior equivalent to this shape:

```go
type AppendParams struct {
    SessionID string
    Type      string
    Role      string
    Status    string
    Payload   json.RawMessage
}

type Store interface {
    AppendEvent(ctx context.Context, params store.AppendEventParams) (store.Event, error)
}

type Service struct {
    // owns store, buffers, and subscribers
}

func (s *Service) Append(ctx context.Context, params AppendParams) (store.Event, error)
func (s *Service) Subscribe(sessionID string) (<-chan store.Event, func())
func (s *Service) Recent(sessionID string) []store.Event
```

The exact names may follow the codebase, but the behavior must stay the same:

- `Append` is the only path that buffers and broadcasts events.
- `Subscribe` is live-only.
- `Recent` reads from memory only and is not a replay guarantee.

## Completion Criteria

Sprint 3 is complete when:

- A central event service exists.
- Every event appended through the service is persisted before buffering or broadcast.
- Per-session buffers retain the latest `1000` events in sequence order.
- Live subscribers receive events for only their subscribed session.
- Slow or unsubscribed clients cannot block append progress.
- `go test ./...` passes.
- `go test -race ./...` passes or any race-test limitation is documented.
- No HTTP SSE, HTTP event history, agent runner, or frontend session UI has been added.

## Handoff To Sprint 4

Sprint 4 should expose the event system over HTTP:

- Add `GET /api/sessions/{sessionId}/events?after_seq=N&limit=500`.
- Add `GET /api/sessions/{sessionId}/events/stream?after_seq=N`.
- Replay missed events from SQLite before subscribing to live events.
- Encode events as SSE with `id`, `event`, and JSON `data`.
- Test reconnect ordering and duplicate prevention.
