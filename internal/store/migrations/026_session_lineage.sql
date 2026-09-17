ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN spawned_by_run_id TEXT;
ALTER TABLE sessions ADD COLUMN lineage_depth INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_sessions_parent_updated ON sessions(parent_session_id, updated_at DESC);
CREATE INDEX idx_sessions_spawned_by_run ON sessions(spawned_by_run_id);
