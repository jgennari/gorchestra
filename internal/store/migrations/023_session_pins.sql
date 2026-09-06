ALTER TABLE sessions ADD COLUMN pinned_at DATETIME;

CREATE INDEX idx_sessions_pinned_updated
ON sessions(pinned_at DESC, updated_at DESC, created_at DESC, id DESC);
