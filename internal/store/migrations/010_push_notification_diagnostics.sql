ALTER TABLE push_subscriptions ADD COLUMN origin TEXT;

CREATE TABLE push_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_hash TEXT NOT NULL,
  origin TEXT,
  payload_kind TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT,
  http_status INTEGER,
  response_status TEXT,
  error TEXT,
  created_at DATETIME NOT NULL
);

CREATE INDEX idx_push_delivery_attempts_created_at ON push_delivery_attempts(created_at DESC);
