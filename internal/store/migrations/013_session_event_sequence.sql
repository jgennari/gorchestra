ALTER TABLE sessions ADD COLUMN next_event_seq INTEGER NOT NULL DEFAULT 1;

UPDATE sessions
SET next_event_seq = COALESCE(
  (SELECT MAX(events.seq) + 1 FROM events WHERE events.session_id = sessions.id),
  1
);
