ALTER TABLE sessions ADD COLUMN provider_session_id TEXT;

UPDATE sessions
SET provider_session_id = (
  SELECT json_extract(events.payload_json, '$.thread_id')
  FROM events
  WHERE events.session_id = sessions.id
    AND events.type = 'agent.run.started'
    AND json_extract(events.payload_json, '$.provider') = 'codex'
    AND NULLIF(json_extract(events.payload_json, '$.thread_id'), '') IS NOT NULL
  ORDER BY events.seq ASC
  LIMIT 1
)
WHERE agent_type = 'codex'
  AND provider_session_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM events
    WHERE events.session_id = sessions.id
      AND events.type = 'agent.run.started'
      AND json_extract(events.payload_json, '$.provider') = 'codex'
      AND NULLIF(json_extract(events.payload_json, '$.thread_id'), '') IS NOT NULL
  );

DROP TABLE IF EXISTS session_provider_state;
