# Client and Wire Performance Plan

Status: Phase 1 implementation complete; Phase 2 not started  
Created: 2026-09-04  
Scope: Gorchestra browser client, HTTP/SSE wire protocol, embedded frontend delivery, and the SQLite read paths that directly affect UI latency.

## Why this work exists

A live production trace and source review found that Gorchestra's browser is not primarily limited by JavaScript execution. During active streaming, Chrome recorded no main-thread task longer than 50 ms, and rebuilding a representative transcript timeline averaged roughly 0.5 ms. The expensive paths are redundant requests, replay behavior, oversized event projections, and database queries over accumulated event history.

The implementation must preserve these invariants:

- The persisted event stream remains the canonical session record.
- Events are persisted before they are broadcast.
- Session sequence numbers remain monotonically increasing.
- Reconnects recover from the last accepted sequence and fall back to a bounded resync only when the server explicitly requires it.
- Optimistic user messages continue to reconcile with their persisted events without duplicates.
- Debug visibility remains opt-in; performance work must not discard information required for an active debug view.
- The persistent human stack must not be restarted while a run is active.

## Measured baseline

Measurements were taken against the persistent human stack and its built frontend.

- A short Overview sample spanning two small tool calls produced 13 requests to `/api/dashboard` and 13 to `/api/dashboard/runs`: 26 requests and about 439 KiB decoded.
- A long-lived browser tab accumulated 17 downloads of the same 50-turn event tail. Those responses totaled about 32 MiB decoded and 4.46 MiB transferred; the slowest took 6.2 seconds.
- In a simultaneous six-second sample, the selected-session SSE and global activity SSE delivered the same two events and the same 2,137 bytes.
- A clean open of an active session observed approximately 836 ms for the session list, 933 ms for skills, 163 ms for the redundant session detail request, and 1.19 seconds for a 1.53 MiB decoded event tail.
- The active-session tail was dominated by `tool.call.completed`: about 1.40 MiB across 57 events, with a single projected event reaching roughly 254 KiB.
- The embedded main JavaScript asset is about 1.29 MiB uncompressed and roughly 361 KiB gzip, but the embedded server currently sends it without content encoding.
- `/api/sessions?limit=50` settles around 330 ms locally. Its query runs multiple correlated event-table subqueries for every returned session.
- The human database is about 2.2 GiB. It contains roughly 679,615 events and 1.58 GiB of JSON payloads: about 799 MiB of raw Codex provider events, 347 MiB of transient deltas, and 268 MiB of completed tool-call payloads.

## Phase 1: Remove redundant live work

Goal: make ordinary navigation, streaming, dashboard monitoring, and reconnects cheaper without changing the canonical persisted event model.

Completion summary:

- [x] Coalesce dashboard invalidations and cancel superseded request pairs.
- [x] Reconnect selected-session SSE from its accepted cursor, with bounded backoff and explicit resync fallback.
- [x] Exclude the selected session from the global activity stream.
- [x] Reconnect the global activity stream before performing one post-open session-list reconciliation.
- [x] Remove avoidable selected-detail, queue, and notification-diagnostic startup requests.
- [x] Generate and serve deterministic gzip representations of compressible hashed assets.

### 1. Coalesce dashboard refreshes

- Replace the per-event dashboard refresh counter with a bounded invalidation cadence while Overview is visible.
- Refresh immediately for terminal events; coalesce ordinary activity to a short trailing interval.
- Abort or ignore superseded dashboard and run-ledger requests so older responses cannot overwrite newer state.
- Keep the manual Refresh action immediate.
- Test a burst of activity and assert one coalesced pair of dashboard requests rather than one pair per event.

### 2. Reconnect selected-session SSE from its cursor

- On an ordinary EventSource error, reconnect with `after_seq=lastAcceptedSeq` instead of downloading the entire recent tail first.
- Continue to honor `stream.resync.required`; only that control event should trigger the bounded tail reload.
- Use bounded exponential backoff with reset after a successful connection.
- Test ordinary disconnect/reconnect replay, duplicate suppression, resync fallback, and cleanup on session changes.
- Reconnect the global activity stream with bounded exponential backoff, then reconcile the session list once only after a connection successfully reopens. Prefer newer event-derived session snapshots if that reconciliation races with fresh stream activity.

### 3. Stop delivering the selected session twice

- Add an optional selected-session exclusion to `/api/sessions/activity/stream`.
- Restart the global stream when selection changes and exclude that session on the server, eliminating both duplicate bytes and duplicate client work.
- Keep a defensive sequence guard before updating/sorting/persisting session summaries.
- Ensure notification and terminal behavior is still emitted exactly once for selected and unselected sessions.

### 4. Remove avoidable startup fetches

- Do not immediately fetch selected-session detail when the freshly loaded list already contains that session.
- Preserve the detail fallback for deep links to sessions outside the list and for explicit refresh operations.
- Reconcile queued messages from queue events and mutation responses; avoid a follow-up GET for acknowledgements already represented locally.
- Remove queued messages locally after a successful delete, with SSE remaining the canonical reconciliation path.
- Avoid fetching full notification diagnostics during ordinary startup when notification state does not require it.

### 5. Compress immutable embedded assets

- Produce deterministic gzip versions of hashed frontend assets during the production build/staging path.
- Serve a precompressed representation when `Accept-Encoding` permits it, with `Vary: Accept-Encoding` and the existing immutable cache policy.
- Preserve content type, range/request behavior where applicable, and an uncompressed fallback.
- Test accepted, rejected, and unavailable encodings plus cache headers.

### Phase 1 verification gate

- Frontend unit tests pass.
- `go test ./...` passes.
- Frontend lint and production build pass.
- `git diff --check` passes.
- A live Overview burst produces a bounded number of dashboard requests.
- Simulated selected-stream reconnect does not request event history unless the server sends `stream.resync.required`.
- A simultaneous stream sample no longer delivers selected-session events on the global stream.
- A built hashed JavaScript asset is transferred with gzip when requested.
- No production refresh or process restart occurs until the active human session is clear, unless explicitly requested.

### Phase 1 verification results

- Live Arc/DevTools capture on the active Overview recorded eight dashboard requests (four summary/ledger pairs, including one manual refresh) and about 139 KiB transferred over a roughly 4.8-second active window. The baseline burst produced 26 requests and about 439 KiB. Continuous activity is now bounded to at most one request pair per 750 ms, and terminal events still invalidate immediately.
- An automated ten-event Overview burst produces exactly one coalesced summary/ledger pair. A separate test verifies that superseded pairs are aborted.
- Ordinary selected-stream reconnect tests issue no history request and resume at the last accepted sequence. An explicit `stream.resync.required` test forces one bounded tail reload before reconnecting.
- Global-stream tests verify selected-session exclusion and post-open session-list reconciliation. The server handler test confirms excluded events are not serialized.
- Startup tests verify that a selected session already present in the initial list is not fetched again, queue lifecycle events reconcile without GETs, and acknowledged deletes do not trigger a queue reload. Full notification diagnostics are no longer fetched automatically.
- The final staged build produced 84 precompressed hashed assets. The main bundle is 1,288,718 bytes identity and 357,424 bytes gzip, a 72.3% wire reduction. An isolated production binary served the gzip representation with the original JavaScript content type, immutable caching, and `Vary: Accept-Encoding`; identity and ranged fallbacks also pass.
- Verification passed: 432 frontend tests, frontend lint, production frontend build, `go test ./...`, and `git diff --check`.
- The live Vite Overview rendered successfully and recovered from one transient 502 with a single retry. No manual human-stack restart or `prod:refresh` was performed while a run was active.
- Commit checkpoint remains pending because the worktree already contains the preceding optimistic-send work and generated embedded bundle changes; no unrelated user changes were discarded or overwritten.

## Phase 2: Make durable history cheaper

Goal: reduce the size and query cost of long-lived event history while keeping completed session reconstruction reliable.

### 1. Lightweight tool-result projections

- Keep full tool results in durable server-owned storage.
- Project completion metadata and a bounded preview into standard history and SSE responses.
- Add on-demand retrieval for complete textual tool output, extending the existing tool-content pattern.
- Apply a total projected-event byte cap rather than only a per-string cap.
- Ensure a reconnect during a live tool call can reconstruct the visible accumulated result.

### 2. Materialized session summaries

- Store event count, last durable sequence, tool count, and token totals in server-owned summary state maintained transactionally with event/session updates.
- Backfill existing sessions in a migration.
- Replace correlated history scans in list/get session queries.
- Verify counters against reconstructed values in migration and store tests.

### 3. Event retention and compaction

- Define retention separately for canonical completed events, transient deltas, and raw provider/debug events.
- Compact settled transient streams only after their completed canonical event is durable.
- Move large binary attachments and debug payloads to referenced blob storage where appropriate.
- Keep enough raw/debug material for a documented recent diagnostic window.
- Add maintenance observability: reclaimable bytes, last compaction, retained ranges, and failures.

### 4. Lazy secondary metadata

- Cache skill catalogs by workspace and revision; refresh explicitly or on detected filesystem changes.
- Load skill data when the user opens Skills, invokes inline completion, or has saved skill references that require validation.
- Replace full notification diagnostics on startup with a minimal status check; load diagnostics only in settings.

### Phase 2 verification gate

- A 50-turn history with large tool calls stays well below the current 2 MiB response budget until full output is explicitly requested.
- Session-list latency is independent of historical event count within normal variance.
- Compaction preserves transcript reconstruction, counts, replay boundaries, attachments, and debug-policy guarantees.
- Database growth during a representative long agent run is measured and materially reduced.

## Checkpoint protocol

At the end of each phase:

1. Update the status and completed checkboxes in this document.
2. Record before/after measurements and any changed design decisions.
3. Run the phase verification gate.
4. Commit the phase separately so it can be reviewed or reverted without mixing later storage changes.
5. Re-read this document after context compaction before beginning the next phase.

## Progress log

- 2026-09-04: Baseline audit completed using Chrome DevTools, live HTTP/SSE sampling, SQLite aggregation, and source review.
- 2026-09-04: Phase 1 started.
- 2026-09-04: Phase 1 implementation and verification completed. Phase 2 remains intentionally unstarted pending review of the durable-storage changes.
