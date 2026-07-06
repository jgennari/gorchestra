CREATE TABLE notification_attention (
  session_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  event_type TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
