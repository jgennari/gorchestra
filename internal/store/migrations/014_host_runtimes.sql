CREATE TABLE host_runtimes (
  session_id TEXT PRIMARY KEY,
  route_slug TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  config_path TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_hash TEXT NOT NULL,
  recipe_snapshot BLOB NOT NULL,
  status TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  started_at DATETIME,
  stopped_at DATETIME,
  last_error TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_host_runtimes_status_updated
  ON host_runtimes(status, updated_at DESC);
