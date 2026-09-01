CREATE TABLE session_schedules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cadence_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at DATETIME,
  deleted_at DATETIME,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_schedules_session
  ON session_schedules(session_id, deleted_at, created_at);

CREATE INDEX idx_session_schedules_due
  ON session_schedules(enabled, next_run_at)
  WHERE deleted_at IS NULL AND enabled = 1;

CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  queue_message_id TEXT,
  trigger TEXT NOT NULL,
  scheduled_for DATETIME NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  started_at DATETIME,
  completed_at DATETIME,

  UNIQUE(schedule_id, trigger, scheduled_for),
  FOREIGN KEY(schedule_id) REFERENCES session_schedules(id),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(queue_message_id) REFERENCES queued_messages(id)
);

CREATE INDEX idx_schedule_occurrences_schedule_created
  ON schedule_occurrences(schedule_id, created_at DESC);

CREATE INDEX idx_schedule_occurrences_session_status
  ON schedule_occurrences(session_id, status, created_at);

ALTER TABLE queued_messages ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE queued_messages ADD COLUMN source_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_queued_messages_claim
  ON queued_messages(session_id, status, source_kind, seq);
