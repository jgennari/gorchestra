# Global event stream plan

Status: Stages 1–3 complete

Last updated: 2026-09-04

## Goal

Keep every browser synchronized with durable activity from every session over one
server-wide SSE connection. Session transcripts remain projections of the durable
event log, and reconnects recover from a server-owned cursor instead of refetching
individual sessions as a normal part of operation.

## Invariants

- Persist each durable event before assigning it to the live global stream.
- Give every durable event one monotonically increasing server-wide cursor in
  addition to its existing per-session sequence number.
- Capture the global cursor before reading the session-list snapshot. An event
  racing that snapshot may be represented twice, but cannot be skipped; the
  per-session sequence makes the duplicate harmless.
- Subscribe before replaying on SSE connect, then discard live events at or below
  the highest replayed cursor.
- Keep transient token deltas out of durable replay and route them only to the
  browser currently watching their session.
- Treat an exceeded replay window as an explicit resync, never as silent loss.

## Stage 1 — durable global backbone

Status: complete (2026-09-04)

- Add a persisted global cursor index for durable events and backfill existing
  history in deterministic creation order.
- Return a snapshot cursor with `GET /api/sessions`.
- Upgrade `/api/sessions/activity/stream` to accept `after_cursor`, replay missed
  durable events, and use the global cursor as the SSE id.
- Keep one stable global EventSource regardless of selected session.
- Advance the reconnect cursor as messages arrive and reload the session snapshot
  only when the server explicitly requests resynchronization.
- Continue the selected-session stream for transcript data and transient deltas;
  deduplicate durable summary updates by session sequence.
- Cover cursor assignment, persistence-before-broadcast, replay ordering, the
  snapshot race contract, and stable client connection behavior with tests.

Exit criteria: changing selection does not reconnect the activity stream; a short
disconnect replays background activity without a session-list refetch; all backend
and frontend tests and builds pass.

Checkpoint: implemented migration 022, transactional cursor assignment,
cross-session broadcast ordering, snapshot cursors, bounded replay/resync, and the
stable cursor-aware browser connection. The selected-session stream remains in
place for transient deltas and transcript compatibility as planned.

Rollout note: backfilling a live-data snapshot containing roughly 185,000 durable
events took 0.43 seconds on the development Mac. The benchmark used a disposable
database copy; the running human database was not modified or restarted.

Validation checkpoint (2026-09-04):

- The human stack applied migration 022 and remained healthy with two concurrent
  active sessions.
- SQLite integrity and foreign-key checks passed; every durable event had one
  cursor row and every cursor row resolved to an event.
- A real reconnect after cursor 185736 resumed at 185737 and continued in global
  order across both active sessions.
- A real overflow from cursor zero returned `stream.resync.required`; a headless
  browser then fetched one fresh snapshot and reconnected at the new cursor.
- Switching selected sessions retained one global EventSource. Forcing that source
  to fail reconnected at the next observed cursor without fetching another
  session snapshot.
- The replay query used the global integer primary key plus the event-id index.
  Five live 50-session snapshots had 0.8–2.3 ms server response times.

Non-blocking follow-ups observed during browser validation: React Strict Mode
duplicates the initial snapshot request in the Vite development build, and TanStack
Virtual emits one `flushSync`-during-layout warning while measuring the transcript.
Neither affected global-stream correctness; request coalescing and the virtualizer
warning should be addressed during the Stage 2 client-store work.

## Stage 2 — one client event store

Status: complete (2026-09-04)

- Introduce a bounded client event store keyed by session id and per-session seq.
- Route durable global events to summaries, notifications, queue state, dashboard
  invalidation, and cached transcript tails through one reducer.
- Let session views hydrate from the shared store before requesting older pages.
- Remove terminal-event detail refetches and other reconciliation calls made
  redundant by authoritative global events.
- Add memory bounds and eviction that retain session summaries and cursors.

Exit criteria: background sessions are immediately current when selected, and
durable session state has one ingestion path in the browser.

Checkpoint: durable events from both compatibility transports now converge on a
single reducer keyed by session id and per-session sequence. The store keeps a
bounded 32 MiB / 50-session transcript window, retains per-session cursors after
window eviction, persists background events to IndexedDB, and publishes selected
session updates to transcript and queue consumers. Session summaries,
notifications, workspace invalidation, and dashboard invalidation run only after
that reducer accepts a new event. Known terminal events no longer trigger detail
refetches; an unknown session still fetches its missing metadata.

Hydration merges network or IndexedDB tails with events already admitted by the
global stream, so an in-flight older response cannot roll the visible transcript
backward. Queue lifecycle event types are now registered on both SSE transports,
and the composer replays the full cached lifecycle rather than only its last
event. Concurrent identical session snapshots are coalesced, and transcript
measurement no longer requests a nested `flushSync` from React's layout phase.

Validation checkpoint (2026-09-04):

- A live headless browser against the persistent human stack made one initial
  session snapshot request and held one global activity stream.
- After activity arrived in the running background session, selecting it opened
  from the shared store with zero tail requests and one compatibility stream.
- The live browser console contained no errors, warnings, or virtualizer
  `flushSync` diagnostics.
- Tests cover transport deduplication, cold-window eviction with retained
  cursors, background transcript and queue hydration, stale-tail races, stale
  IndexedDB hot windows, terminal refetch removal, and snapshot coalescing.

## Stage 3 — transient multiplexing and old-stream retirement

Status: complete (2026-09-04)

- Multiplex transient deltas for actively watched sessions onto the global
  connection using explicit watch/unwatch control, or a bounded server policy.
- Preserve backpressure and slow-consumer behavior per browser.
- Remove the selected-session SSE connection after parity and soak testing.
- Instrument reconnects, replay counts/bytes, resyncs, subscriber pressure, and
  end-to-end event latency.

Exit criteria: each browser normally holds one SSE connection and no feature
depends on the legacy selected-session stream.

Checkpoint: the activity connection now identifies one browser client and its
currently watched session. A small `PUT /api/sessions/activity/watch` control
request changes that watch without reconnecting SSE. The event service sends
all durable events plus only that session's transient deltas to the subscriber,
retaining per-browser bounded queues and slow-consumer eviction. Transient SSE
frames intentionally omit `id`, so they cannot advance or corrupt the durable
global replay cursor.

The React session hook no longer constructs an EventSource. Both durable and
transient selected-session activity enter through the shared client event bus;
debug-only events take an uncached path so normal transcript caches remain
clean. The old selected-session endpoint remains server-side for compatibility,
but the application has no dependency on it.

Operational diagnostics now expose connection/reconnect, replay event/byte,
live durable/transient event/byte, resync, delivery latency, subscriber
pressure, and slow-consumer drop counters at
`GET /api/diagnostics/performance`. Chromium long tasks are batched only after
a 50 ms stall and retained in a bounded in-memory diagnostic history. Reconnects
are identified by the stable browser client id rather than by a nonzero snapshot
cursor, and the remembered-client set is bounded.

Provider option requests are cached for the browser lifetime, queued-message
snapshots are coalesced and updated from authoritative mutations/events, and
workspace directory listings use a bounded cache with explicit refresh and
upload invalidation. Reattaching a transcript to the live tail also reuses the
connected global-stream window instead of downloading the same tail again.

Validation checkpoint (2026-09-04):

- A live Chromium run against the persistent human stack reached an interactive
  composer in 353–428 ms; DOM content loaded in 138–154 ms.
- Selecting another session and returning issued two small watch-control PUTs
  while the browser retained exactly one EventSource.
- Thinking, tool-start, tool-delta, tool-completion, and provider events from an
  active run all arrived on that same connection. Server diagnostics counted
  both durable and transient deliveries with zero dropped subscribers.
- The initial provider-options, queue, workspace-files, and selected-tail reads
  each occurred once. Returning to the original session reused its file and
  transcript windows without another GET.
- Forced browser stalls were reported through the bounded long-task telemetry
  path. The browser recorded no console errors or uncaught page errors.

## Rollout and rollback

Stage 1 is wire-compatible: the endpoint path and event payload retain their
existing fields, while `global_seq`, `event_cursor`, and `after_cursor` are
additive. The selected-session endpoint remains available as a rollback path,
although the shipped client no longer opens it.
If replay pressure is unexpectedly high, lower the reconnect window and force an
explicit snapshot resync rather than dropping or silently truncating events.
