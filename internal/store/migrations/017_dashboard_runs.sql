CREATE INDEX IF NOT EXISTS idx_events_type_session_seq
  ON events(type, session_id, seq);

CREATE TABLE dashboard_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unknown',
  agent_type TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  start_seq INTEGER NOT NULL,
  last_projected_seq INTEGER NOT NULL,
  terminal_seq INTEGER,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  tool_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  input_request_count INTEGER NOT NULL DEFAULT 0,
  permission_request_count INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  has_token_usage INTEGER NOT NULL DEFAULT 0,
  cost_amount REAL NOT NULL DEFAULT 0,
  cost_currency TEXT NOT NULL DEFAULT '',
  has_cost_usage INTEGER NOT NULL DEFAULT 0,

  UNIQUE(session_id, start_seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_dashboard_runs_started
  ON dashboard_runs(started_at DESC, id DESC);

CREATE INDEX idx_dashboard_runs_status_started
  ON dashboard_runs(status, started_at DESC);

CREATE INDEX idx_dashboard_runs_workspace_started
  ON dashboard_runs(workspace_path, started_at DESC);

CREATE INDEX idx_dashboard_runs_agent_started
  ON dashboard_runs(agent_type, started_at DESC);

CREATE TABLE dashboard_run_files (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY(run_id, path),
  FOREIGN KEY(run_id) REFERENCES dashboard_runs(id) ON DELETE CASCADE
);

CREATE TABLE dashboard_run_outcomes (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  started_at DATETIME,
  completed_at DATETIME,
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(run_id, kind, outcome_key),
  FOREIGN KEY(run_id) REFERENCES dashboard_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_dashboard_run_outcomes_kind
  ON dashboard_run_outcomes(kind, run_id);
