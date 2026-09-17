package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// CreateRunSubmission durably reserves a client request, session, and run ID in
// one transaction. Provider execution is deliberately started only after this
// commit so a lost HTTP response cannot cause a duplicate launch.
func (s *Store) CreateRunSubmission(ctx context.Context, params CreateRunSubmissionParams) (RunSubmission, Session, bool, error) {
	params.RequestID = strings.TrimSpace(params.RequestID)
	params.RequestHash = strings.TrimSpace(params.RequestHash)
	params.RunID = strings.TrimSpace(params.RunID)
	params.AgentType = strings.TrimSpace(params.AgentType)
	params.WorkspacePath = strings.TrimSpace(params.WorkspacePath)
	params.Prompt = strings.TrimSpace(params.Prompt)
	params.ParentSessionID = strings.TrimSpace(params.ParentSessionID)
	params.SpawnedByRunID = strings.TrimSpace(params.SpawnedByRunID)
	if params.RequestID == "" || params.RequestHash == "" || params.RunID == "" || params.AgentType == "" || params.Prompt == "" {
		return RunSubmission{}, Session{}, false, fmt.Errorf("%w: request_id, request_hash, run_id, agent_type, and prompt are required", ErrInvalidArgument)
	}
	options := params.AgentOptions
	if len(options) == 0 {
		options = json.RawMessage(`{}`)
	}
	if !json.Valid(options) {
		return RunSubmission{}, Session{}, false, fmt.Errorf("%w: agent_options must be valid JSON", ErrInvalidArgument)
	}

	sessionID, err := newPrefixedUUID("sess_")
	if err != nil {
		return RunSubmission{}, Session{}, false, err
	}
	now := s.now()
	session := Session{
		ID: sessionID, Title: params.Title, AgentType: params.AgentType,
		Status: SessionStatusIdle, WorkspacePath: params.WorkspacePath,
		AgentOptions: append(json.RawMessage(nil), options...), CreatedAt: now, UpdatedAt: now,
	}
	submission := RunSubmission{
		RequestID: params.RequestID, RequestHash: params.RequestHash,
		SessionID: session.ID, RunID: params.RunID, Prompt: params.Prompt,
		State: "accepted", CreatedAt: now, UpdatedAt: now,
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RunSubmission{}, Session{}, false, fmt.Errorf("begin run submission: %w", err)
	}
	defer rollback(tx)
	existing, existingErr := scanRunSubmission(tx.QueryRowContext(ctx, `
		SELECT request_id, request_hash, session_id, run_id, prompt, state, error, created_at, updated_at
		FROM run_submissions WHERE request_id = ?`, params.RequestID))
	if existingErr == nil {
		_ = tx.Rollback()
		existingSession, getErr := s.GetSession(ctx, existing.SessionID)
		return existing, existingSession, false, getErr
	}
	if !errors.Is(existingErr, ErrNotFound) {
		return RunSubmission{}, Session{}, false, existingErr
	}
	if params.ParentSessionID != "" {
		var parentDepth int
		var archivedAt sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT lineage_depth, archived_at FROM sessions WHERE id = ?`, params.ParentSessionID).Scan(&parentDepth, &archivedAt); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return RunSubmission{}, Session{}, false, fmt.Errorf("%w: parent session", ErrNotFound)
			}
			return RunSubmission{}, Session{}, false, fmt.Errorf("load parent session: %w", err)
		}
		if archivedAt.Valid {
			return RunSubmission{}, Session{}, false, fmt.Errorf("%w: parent session is archived", ErrInvalidArgument)
		}
		session.ParentSessionID = params.ParentSessionID
		session.SpawnedByRunID = params.SpawnedByRunID
		session.LineageDepth = parentDepth + 1
		if params.MaxLineageDepth > 0 && session.LineageDepth > params.MaxLineageDepth {
			return RunSubmission{}, Session{}, false, fmt.Errorf("%w: maximum child depth %d exceeded", ErrInvalidArgument, params.MaxLineageDepth)
		}
		if params.SpawnedByRunID != "" {
			var owner string
			if err := tx.QueryRowContext(ctx, `SELECT session_id FROM dashboard_runs WHERE id = ? AND status = 'running'`, params.SpawnedByRunID).Scan(&owner); err != nil || owner != params.ParentSessionID {
				return RunSubmission{}, Session{}, false, fmt.Errorf("%w: spawning run is not active in the parent session", ErrInvalidArgument)
			}
		}
		if params.MaxActiveChildren > 0 {
			var active int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM run_submissions submissions
				JOIN sessions children ON children.id = submissions.session_id
				LEFT JOIN dashboard_runs runs ON runs.id = submissions.run_id
				WHERE children.parent_session_id = ?
				AND ((runs.id IS NULL AND submissions.state = 'accepted') OR runs.status = 'running')`, params.ParentSessionID).Scan(&active); err != nil {
				return RunSubmission{}, Session{}, false, fmt.Errorf("count active children: %w", err)
			}
			if active >= params.MaxActiveChildren {
				return RunSubmission{}, Session{}, false, fmt.Errorf("%w: parent already has %d active children", ErrInvalidArgument, active)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (id, title, agent_type, status, workspace_path, agent_options_json, created_at, updated_at,
		                     parent_session_id, spawned_by_run_id, lineage_depth)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		session.ID, session.Title, session.AgentType, string(session.Status), session.WorkspacePath,
		string(session.AgentOptions), formatTime(now), formatTime(now), nullIfEmpty(session.ParentSessionID),
		nullIfEmpty(session.SpawnedByRunID), session.LineageDepth); err != nil {
		return RunSubmission{}, Session{}, false, fmt.Errorf("insert run session: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO run_submissions
		(request_id, request_hash, session_id, run_id, prompt, state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)
		ON CONFLICT(request_id) DO NOTHING`,
		submission.RequestID, submission.RequestHash, submission.SessionID, submission.RunID,
		submission.Prompt, formatTime(now), formatTime(now))
	if err != nil {
		return RunSubmission{}, Session{}, false, fmt.Errorf("insert run submission: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return RunSubmission{}, Session{}, false, fmt.Errorf("check run submission insert: %w", err)
	}
	if inserted == 0 {
		_ = tx.Rollback()
		existing, getErr := s.GetRunSubmission(ctx, params.RequestID)
		if getErr != nil {
			return RunSubmission{}, Session{}, false, getErr
		}
		existingSession, getErr := s.GetSession(ctx, existing.SessionID)
		return existing, existingSession, false, getErr
	}
	if err := tx.Commit(); err != nil {
		return RunSubmission{}, Session{}, false, fmt.Errorf("commit run submission: %w", err)
	}
	return submission, session, true, nil
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func (s *Store) GetRunSubmission(ctx context.Context, requestID string) (RunSubmission, error) {
	return scanRunSubmission(s.db.QueryRowContext(ctx, `
		SELECT request_id, request_hash, session_id, run_id, prompt, state, error, created_at, updated_at
		FROM run_submissions WHERE request_id = ?`, strings.TrimSpace(requestID)))
}

func (s *Store) GetRunSubmissionByRunID(ctx context.Context, runID string) (RunSubmission, error) {
	return scanRunSubmission(s.db.QueryRowContext(ctx, `
		SELECT request_id, request_hash, session_id, run_id, prompt, state, error, created_at, updated_at
		FROM run_submissions WHERE run_id = ?`, strings.TrimSpace(runID)))
}

func (s *Store) UpdateRunSubmission(ctx context.Context, runID, state, message string) error {
	now := s.now()
	result, err := s.db.ExecContext(ctx, `UPDATE run_submissions SET state = ?, error = ?, updated_at = ? WHERE run_id = ?`,
		strings.TrimSpace(state), strings.TrimSpace(message), formatTime(now), strings.TrimSpace(runID))
	if err != nil {
		return fmt.Errorf("update run submission: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check run submission update: %w", err)
	}
	if count == 0 {
		return fmt.Errorf("%w: run submission %s", ErrNotFound, runID)
	}
	return nil
}

func (s *Store) FailAcceptedRunSubmissions(ctx context.Context, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE run_submissions SET state = 'failed', error = ?, updated_at = ? WHERE state = 'accepted'`,
		strings.TrimSpace(message), formatTime(s.now()))
	if err != nil {
		return fmt.Errorf("fail accepted run submissions: %w", err)
	}
	return nil
}

func (s *Store) GetRun(ctx context.Context, runID string) (Run, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT r.id, r.session_id, s.parent_session_id, s.spawned_by_run_id, s.title, r.kind, r.agent_type, r.workspace_path, r.status,
		       r.start_seq, r.terminal_seq, r.started_at, r.completed_at,
		       r.requested_options_json, r.resolved_options_json,
		       r.final_response, r.final_response_seq, r.error,
		       r.tool_count, r.file_count, r.input_request_count, r.permission_request_count,
		       r.token_count, r.has_token_usage, r.cost_amount, r.cost_currency, r.has_cost_usage
		FROM dashboard_runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?`, strings.TrimSpace(runID))
	return scanRun(row)
}

func scanRun(row interface{ Scan(...any) error }) (Run, error) {
	var run Run
	var terminalSeq, finalSeq sql.NullInt64
	var parentSessionID, spawnedByRunID sql.NullString
	var startedAt string
	var completedAt sql.NullString
	var requested, resolved string
	var hasTokens, hasCost int
	if err := row.Scan(
		&run.ID, &run.SessionID, &parentSessionID, &spawnedByRunID, &run.SessionTitle, &run.Kind, &run.AgentType, &run.WorkspacePath, &run.Status,
		&run.StartSeq, &terminalSeq, &startedAt, &completedAt, &requested, &resolved,
		&run.FinalResponse, &finalSeq, &run.Error,
		&run.ToolCount, &run.FileCount, &run.InputRequestCount, &run.PermissionRequestCount,
		&run.TokenCount, &hasTokens, &run.CostAmount, &run.CostCurrency, &hasCost,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, ErrNotFound
		}
		return Run{}, fmt.Errorf("scan run: %w", err)
	}
	run.ParentSessionID = parentSessionID.String
	run.SpawnedByRunID = spawnedByRunID.String
	run.StartedAt, _ = parseTime(startedAt)
	if terminalSeq.Valid {
		run.TerminalSeq = terminalSeq.Int64
	}
	if finalSeq.Valid {
		run.FinalResponseSeq = finalSeq.Int64
	}
	if completedAt.Valid {
		value, err := parseTime(completedAt.String)
		if err != nil {
			return Run{}, fmt.Errorf("parse run completion: %w", err)
		}
		run.CompletedAt = &value
	}
	run.RequestedOptions = json.RawMessage(requested)
	run.ResolvedOptions = json.RawMessage(resolved)
	run.HasTokenUsage = hasTokens != 0
	run.HasCostUsage = hasCost != 0
	return run, nil
}

func scanRunSubmission(row interface{ Scan(...any) error }) (RunSubmission, error) {
	var value RunSubmission
	var createdAt, updatedAt string
	if err := row.Scan(&value.RequestID, &value.RequestHash, &value.SessionID, &value.RunID, &value.Prompt,
		&value.State, &value.Error, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RunSubmission{}, ErrNotFound
		}
		return RunSubmission{}, fmt.Errorf("scan run submission: %w", err)
	}
	var err error
	value.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return RunSubmission{}, err
	}
	value.UpdatedAt, err = parseTime(updatedAt)
	return value, err
}
