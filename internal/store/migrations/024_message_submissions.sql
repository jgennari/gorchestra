CREATE TABLE message_submissions (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  client_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown',
  http_status INTEGER NOT NULL DEFAULT 0,
  response_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, client_id)
);
CREATE INDEX idx_events_client_submission ON events(session_id, json_extract(payload_json, '$.client_submission_id'))
  WHERE type = 'user.message.completed';
CREATE INDEX idx_manual_queue_client_submission ON queued_messages(session_id, source_id)
  WHERE source_kind = 'manual' AND source_id != '';
