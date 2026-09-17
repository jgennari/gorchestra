ALTER TABLE dashboard_runs ADD COLUMN requested_options_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_runs ADD COLUMN resolved_options_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_runs ADD COLUMN final_response TEXT NOT NULL DEFAULT '';
ALTER TABLE dashboard_runs ADD COLUMN final_response_seq INTEGER;

CREATE TABLE run_submissions (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted',
  error TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_run_submissions_run_id ON run_submissions(run_id);
CREATE INDEX idx_run_submissions_state ON run_submissions(state, created_at);
