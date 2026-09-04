ALTER TABLE sessions ADD COLUMN durable_event_count INTEGER NOT NULL DEFAULT 0 CHECK (durable_event_count >= 0);
ALTER TABLE sessions ADD COLUMN last_durable_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_durable_event_seq >= 0);
ALTER TABLE sessions ADD COLUMN materialized_tool_count INTEGER NOT NULL DEFAULT 0 CHECK (materialized_tool_count >= 0);
ALTER TABLE sessions ADD COLUMN materialized_token_count INTEGER NOT NULL DEFAULT 0 CHECK (materialized_token_count >= 0);
ALTER TABLE sessions ADD COLUMN pending_input_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_input_count >= 0);
ALTER TABLE sessions ADD COLUMN pending_permission_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_permission_count >= 0);

UPDATE sessions
SET durable_event_count = (
      SELECT COUNT(*)
      FROM events
      WHERE events.session_id = sessions.id
        AND events.type NOT LIKE '%.delta'
    ),
    last_durable_event_seq = COALESCE((
      SELECT MAX(seq)
      FROM events
      WHERE events.session_id = sessions.id
        AND events.type NOT LIKE '%.delta'
    ), 0),
    materialized_tool_count = (
      SELECT COUNT(*)
      FROM events
      WHERE events.session_id = sessions.id
        AND events.type IN ('tool.call.started', 'file.change.started')
    ),
    materialized_token_count = COALESCE((
      SELECT SUM(token_count)
      FROM session_token_usage
      WHERE session_token_usage.session_id = sessions.id
    ), 0),
    pending_input_count = MAX(0,
      (
        SELECT COUNT(*)
        FROM events
        WHERE events.session_id = sessions.id
          AND events.type = 'agent.input.requested'
          AND events.seq > COALESCE((
            SELECT MAX(terminal.seq)
            FROM events AS terminal
            WHERE terminal.session_id = sessions.id
              AND terminal.type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')
          ), 0)
      ) - (
        SELECT COUNT(*)
        FROM events
        WHERE events.session_id = sessions.id
          AND events.type = 'agent.input.answered'
          AND events.seq > COALESCE((
            SELECT MAX(terminal.seq)
            FROM events AS terminal
            WHERE terminal.session_id = sessions.id
              AND terminal.type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')
          ), 0)
      )
    ),
    pending_permission_count = MAX(0,
      (
        SELECT COUNT(*)
        FROM events
        WHERE events.session_id = sessions.id
          AND events.type = 'agent.permission.requested'
          AND events.seq > COALESCE((
            SELECT MAX(terminal.seq)
            FROM events AS terminal
            WHERE terminal.session_id = sessions.id
              AND terminal.type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')
          ), 0)
      ) - (
        SELECT COUNT(*)
        FROM events
        WHERE events.session_id = sessions.id
          AND events.type IN ('agent.permission.resolved', 'agent.permission.cancelled')
          AND events.seq > COALESCE((
            SELECT MAX(terminal.seq)
            FROM events AS terminal
            WHERE terminal.session_id = sessions.id
              AND terminal.type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')
          ), 0)
      )
    );

CREATE TABLE event_blobs (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_index INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  encoding TEXT NOT NULL DEFAULT 'identity',
  original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
  data BLOB NOT NULL,
  created_at DATETIME NOT NULL,

  PRIMARY KEY(event_id, kind, item_index),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_event_blobs_event ON event_blobs(event_id, kind, item_index);
CREATE INDEX idx_events_type_created ON events(type, created_at, seq);

CREATE TABLE event_maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  running INTEGER NOT NULL DEFAULT 0,
  last_started_at DATETIME,
  last_completed_at DATETIME,
  last_error TEXT NOT NULL DEFAULT '',
  deleted_delta_events INTEGER NOT NULL DEFAULT 0,
  deleted_debug_events INTEGER NOT NULL DEFAULT 0,
  extracted_blob_events INTEGER NOT NULL DEFAULT 0,
  reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
  retained_debug_after DATETIME
);

INSERT INTO event_maintenance_state(id) VALUES (1);
