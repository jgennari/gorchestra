CREATE TABLE IF NOT EXISTS queued_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_options_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_queued_messages_session_status_seq
  ON queued_messages(session_id, status, seq);
