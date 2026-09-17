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
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (id, title, agent_type, status, workspace_path, agent_options_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		session.ID, session.Title, session.AgentType, string(session.Status), session.WorkspacePath,
		string(session.AgentOptions), formatTime(now), formatTime(now)); err != nil {
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
		SELECT r.id, r.session_id, s.title, r.kind, r.agent_type, r.workspace_path, r.status,
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
	var startedAt string
	var completedAt sql.NullString
	var requested, resolved string
	var hasTokens, hasCost int
	if err := row.Scan(
		&run.ID, &run.SessionID, &run.SessionTitle, &run.Kind, &run.AgentType, &run.WorkspacePath, &run.Status,
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
