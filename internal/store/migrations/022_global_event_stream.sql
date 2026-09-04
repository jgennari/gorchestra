CREATE TABLE global_event_stream (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,

  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

INSERT INTO global_event_stream(event_id)
SELECT id
FROM events
WHERE type NOT LIKE '%.delta'
ORDER BY created_at ASC, rowid ASC;
