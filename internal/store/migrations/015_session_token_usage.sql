CREATE TABLE session_token_usage (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  context_id TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  last_event_seq INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY(session_id, provider, context_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO session_token_usage (session_id, provider, context_id, token_count, last_event_seq)
SELECT
  session_id,
  'codex',
  COALESCE(NULLIF(TRIM(json_extract(payload_json, '$.raw.threadId')), ''), 'legacy-codex'),
  MAX(CAST(json_extract(payload_json, '$.raw.tokenUsage.total.totalTokens') AS INTEGER)),
  MAX(seq)
FROM events
WHERE type = 'provider.codex.event'
  AND json_extract(payload_json, '$.provider_event_type') = 'thread/tokenUsage/updated'
  AND CAST(json_extract(payload_json, '$.raw.tokenUsage.total.totalTokens') AS INTEGER) > 0
GROUP BY
  session_id,
  COALESCE(NULLIF(TRIM(json_extract(payload_json, '$.raw.threadId')), ''), 'legacy-codex');

CREATE INDEX idx_session_token_usage_session
  ON session_token_usage(session_id);
