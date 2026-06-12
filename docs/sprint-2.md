# Sprint 2: SQLite Session And Event Store

Sprint 2 establishes Gorchestra's durable server-owned state. The goal is to make sessions and events persist in SQLite with reliable per-session event sequencing.

This sprint builds the storage foundation only. Live streaming, replay endpoints, agent execution, and frontend session UI remain out of scope.

## Goal

Add a SQLite-backed data layer that can create sessions, append events with monotonic per-session sequence numbers, and read event history in sequence order.

Sprint 2 should leave the repository ready for Sprint 3, where the event bus and Server-Sent Events streaming can be built on top of durable storage.

## Scope

In scope:

- Add SQLite through `modernc.org/sqlite`.
- Add a database path config option.
- Apply embedded migrations at backend startup.
- Create `sessions`, `events`, and migration bookkeeping tables.
- Add server-owned Go types for sessions and events.
- Add store methods for creating sessions, appending events, and reading events.
- Add tests for migrations, session creation, event sequencing, and event history reads.

Out of scope:

- HTTP session API endpoints.
- Server-Sent Events streaming.
- In-memory event buffers.
- Replay from `after_seq` over HTTP.
- Agent interface.
- Fake/mock agent.
- Codex adapter.
- Cancellation.
- Frontend session UI.
- Auth or multi-user behavior.

## Decisions

- SQLite driver: `modernc.org/sqlite`
- Database package: `internal/store`
- Migration location: `internal/store/migrations`
- Migration format: embedded SQL files named with numeric prefixes, starting with `001_initial.sql`
- Migration table: `schema_migrations`
- Default database path: `./sessions.db`
- Database path override: `--db`
- Session IDs: `sess_` prefix plus a random UUID value
- Event IDs: `evt_` prefix plus a random UUID value
- Event sequence rule: `seq` starts at `1` for each session and increases by `1` for every appended event
- Persistence source of truth: SQLite, not memory

## Checklist

### Configuration And Startup

- [x] Add a backend config field for database path.
- [x] Add a `--db` flag with default value `./sessions.db`.
- [x] Open the SQLite database during backend startup.
- [x] Enable SQLite foreign keys for each connection.
- [x] Apply all pending embedded migrations before the HTTP server starts accepting requests.
- [x] Fail startup if the database cannot be opened or migrations fail.
- [x] Close the database cleanly on shutdown.

### Migrations

- [x] Add `internal/store/migrations/001_initial.sql`.
- [x] Create `schema_migrations` with `version`, `name`, and `applied_at`.
- [x] Create `sessions`.
- [x] Create `events`.
- [x] Add `UNIQUE(session_id, seq)` on events.
- [x] Add a foreign key from `events.session_id` to `sessions.id`.
- [x] Add an index that supports event history reads by `session_id` and `seq`.
- [x] Make migration application idempotent.

### Schema

Use this logical schema for `sessions`:

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

Use this logical schema for `events`:

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

Session statuses:

```txt
idle
running
completed
failed
cancelled
```

Event statuses:

```txt
started
delta
completed
failed
cancelled
```

### Go Types

- [x] Add a `Session` type with `ID`, `Title`, `AgentType`, `Status`, `CreatedAt`, `UpdatedAt`, and `CompletedAt`.
- [x] Add session status constants for `idle`, `running`, `completed`, `failed`, and `cancelled`.
- [x] Add an `Event` type with `ID`, `SessionID`, `Seq`, `Type`, `Role`, `Status`, `Payload`, and `CreatedAt`.
- [x] Add event status constants for `started`, `delta`, `completed`, `failed`, and `cancelled`.
- [x] Store event payloads as `json.RawMessage` in Go and `TEXT` JSON in SQLite.
- [x] Use UTC timestamps.

### Store API

Add store behavior equivalent to:

```go
type CreateSessionParams struct {
    Title     string
    AgentType string
}

type AppendEventParams struct {
    SessionID string
    Type      string
    Role      string
    Status    string
    Payload   json.RawMessage
}
```

Required methods:

```go
CreateSession(ctx context.Context, params CreateSessionParams) (Session, error)
GetSession(ctx context.Context, id string) (Session, error)
AppendEvent(ctx context.Context, params AppendEventParams) (Event, error)
ListEvents(ctx context.Context, sessionID string, afterSeq int64, limit int) ([]Event, error)
```

Required behavior:

- `CreateSession` creates an `idle` session.
- `CreateSession` requires `agent_type`.
- `AppendEvent` fails if the session does not exist.
- `AppendEvent` assigns the next `seq` inside the same transaction that inserts the event.
- `AppendEvent` returns the fully populated persisted event.
- `ListEvents` returns events where `seq > afterSeq`, ordered ascending by `seq`.
- `ListEvents` applies a default limit of `500` when the provided limit is zero or negative.

### Sequence Assignment

- [x] Event sequence assignment must be transaction-protected.
- [x] The first event for a session must get `seq = 1`.
- [x] Concurrent appends to the same session must not produce duplicate sequence numbers.
- [x] Events in different sessions maintain independent sequences.
- [x] Duplicate sequence insertion should remain impossible because of `UNIQUE(session_id, seq)`.

Implementation note: use a transaction for appending events, compute the next sequence from the current maximum for that session, insert the event, and rely on the unique constraint as the final integrity guard.

### Tests

- [x] Test migrations run against an empty temporary database.
- [x] Test migrations are idempotent when run twice.
- [x] Test `CreateSession` persists an `idle` session.
- [x] Test `CreateSession` rejects an empty `agent_type`.
- [x] Test `AppendEvent` assigns `seq = 1` for the first event.
- [x] Test consecutive appends assign `seq = 1`, then `seq = 2`.
- [x] Test two sessions have independent event sequences.
- [x] Test `AppendEvent` fails for a missing session.
- [x] Test `ListEvents` returns events ordered by ascending sequence.
- [x] Test `ListEvents` honors `afterSeq`.
- [x] Test concurrent appends to one session produce unique contiguous sequence numbers.

Use temporary on-disk SQLite databases in tests instead of shared in-memory databases.

## Public Interfaces

Sprint 2 adds one command-line option:

```bash
./gorchestra --db ./sessions.db
```

The existing health endpoint should remain stable:

```http
GET /api/health
```

Expected response remains:

```json
{
  "status": "ok"
}
```

No session or event HTTP APIs are introduced in Sprint 2.

## Completion Criteria

Sprint 2 is complete when:

- Backend startup opens SQLite and applies migrations.
- An empty database is initialized automatically.
- `go test ./...` passes.
- Store tests prove session creation and event append behavior.
- Event sequence numbers are monotonic per session.
- Event history reads support `afterSeq` and ordered limits.
- The existing health endpoint still works.
- No frontend session UI or streaming behavior has been added.

## Handoff To Sprint 3

Sprint 3 should build the in-memory event system on top of this store:

- Central append path: assign sequence, persist, buffer, broadcast.
- Session-scoped live subscriptions.
- Sliding in-memory event buffer.
- Tests proving persistence happens before broadcast.
- Preparation for SSE replay using durable `ListEvents`.
