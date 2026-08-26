package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type dashboardRunStart struct {
	SessionID    string
	Seq          int64
	CreatedAt    time.Time
	Payload      json.RawMessage
	AgentType    string
	Workspace    string
	SessionState SessionStatus
	NextSeq      int64
}

// syncDashboardProjection incrementally rebuilds the dashboard projection from
// durable events. Events remain the source of truth; this table only keeps the
// dashboard fast for long-lived databases with large provider event histories.
func (s *Store) syncDashboardProjection(ctx context.Context) error {
	starts, err := s.dashboardRunStarts(ctx)
	if err != nil {
		return err
	}
	if len(starts) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin dashboard projection sync: %w", err)
	}
	defer rollback(tx)

	latestStartBySession := make(map[string]int64)
	for _, start := range starts {
		latestStartBySession[start.SessionID] = start.Seq
	}

	for _, start := range starts {
		runID := dashboardPayloadString(start.Payload, "run_id")
		if runID == "" {
			runID = legacyDashboardRunID(start.SessionID, start.Seq)
		}
		kind := dashboardPayloadString(start.Payload, "run_kind")
		if kind == "" {
			kind, err = dashboardRunKindBefore(ctx, tx, start.SessionID, start.Seq)
			if err != nil {
				return err
			}
		}
		if kind == "" {
			kind = "unknown"
		}
		workspace := dashboardPayloadString(start.Payload, "workspace_path")
		if workspace == "" {
			workspace = start.Workspace
		}
		agentType := dashboardPayloadString(start.Payload, "agent_type")
		if agentType == "" {
			agentType = start.AgentType
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO dashboard_runs (
				id, session_id, kind, agent_type, workspace_path, status,
				start_seq, last_projected_seq, started_at
			) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
			ON CONFLICT(session_id, start_seq) DO UPDATE SET
				kind = CASE WHEN dashboard_runs.kind = 'unknown' THEN excluded.kind ELSE dashboard_runs.kind END,
				agent_type = excluded.agent_type,
				workspace_path = CASE WHEN dashboard_runs.workspace_path = '' THEN excluded.workspace_path ELSE dashboard_runs.workspace_path END`,
			runID, start.SessionID, kind, agentType, workspace, start.Seq, start.Seq, formatTime(start.CreatedAt),
		); err != nil {
			return fmt.Errorf("insert dashboard run: %w", err)
		}

		var projectedSeq int64
		if err := tx.QueryRowContext(ctx,
			`SELECT last_projected_seq FROM dashboard_runs WHERE session_id = ? AND start_seq = ?`,
			start.SessionID, start.Seq,
		).Scan(&projectedSeq); err != nil {
			return fmt.Errorf("load dashboard projection cursor: %w", err)
		}

		events, err := dashboardEventsForProjection(ctx, tx, start.SessionID, projectedSeq, start.NextSeq)
		if err != nil {
			return err
		}
		for _, event := range events {
			if err := projectDashboardEvent(ctx, tx, event); err != nil {
				return err
			}
		}

		if start.SessionState != SessionStatusRunning || latestStartBySession[start.SessionID] != start.Seq {
			if _, err := tx.ExecContext(ctx, `
				UPDATE dashboard_runs
				SET status = 'unknown'
				WHERE session_id = ? AND start_seq = ? AND status = 'running'`,
				start.SessionID, start.Seq,
			); err != nil {
				return fmt.Errorf("close unmatched dashboard run: %w", err)
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit dashboard projection sync: %w", err)
	}
	return nil
}

func (s *Store) dashboardRunStarts(ctx context.Context) ([]dashboardRunStart, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.session_id, e.seq, e.created_at, e.payload_json,
		       s.agent_type, s.workspace_path, s.status
		FROM events e
		JOIN sessions s ON s.id = e.session_id
		WHERE e.type = 'session.status.updated'
		  AND json_extract(e.payload_json, '$.status') = 'running'
		ORDER BY e.session_id, e.seq`)
	if err != nil {
		return nil, fmt.Errorf("load dashboard run starts: %w", err)
	}
	defer rows.Close()

	starts := make([]dashboardRunStart, 0)
	for rows.Next() {
		var start dashboardRunStart
		var createdAt string
		var payload string
		var workspace sql.NullString
		var status string
		if err := rows.Scan(
			&start.SessionID, &start.Seq, &createdAt, &payload,
			&start.AgentType, &workspace, &status,
		); err != nil {
			return nil, fmt.Errorf("scan dashboard run start: %w", err)
		}
		parsedCreatedAt, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse dashboard run start: %w", err)
		}
		start.CreatedAt = parsedCreatedAt
		start.Payload = json.RawMessage(payload)
		start.Workspace = workspace.String
		start.SessionState = SessionStatus(status)
		starts = append(starts, start)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load dashboard run start rows: %w", err)
	}
	for index := range starts {
		if index+1 < len(starts) && starts[index+1].SessionID == starts[index].SessionID {
			starts[index].NextSeq = starts[index+1].Seq
		}
	}
	return starts, nil
}

func dashboardEventsForProjection(ctx context.Context, tx *sql.Tx, sessionID string, afterSeq int64, beforeSeq int64) ([]Event, error) {
	query := `SELECT id, session_id, seq, type, role, status, payload_json, created_at
		FROM events WHERE session_id = ? AND seq > ? AND (
			type IN (
				'tool.call.started', 'tool.call.completed', 'file.change.completed', 'agent.input.requested',
				'agent.permission.requested', 'agent.message.completed', 'run.outcome.recorded',
				'agent.delegation.started', 'agent.delegation.completed',
				'agent.run.completed', 'agent.run.failed', 'agent.run.cancelled', 'agent.usage.updated'
			)
			OR (type = 'provider.codex.event' AND json_extract(payload_json, '$.provider_event_type') = 'thread/tokenUsage/updated')
			OR (type = 'provider.claude.event' AND json_type(payload_json, '$.usage') IS NOT NULL)
			OR (type = 'provider.opencode.event' AND json_extract(payload_json, '$.provider_event_type') = 'usage_update')
			OR (type = 'provider.pi.event' AND json_type(payload_json, '$.usage') IS NOT NULL)
		)`
	args := []any{sessionID, afterSeq}
	if beforeSeq > 0 {
		query += ` AND seq < ?`
		args = append(args, beforeSeq)
	}
	query += ` ORDER BY seq ASC`
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("load dashboard projection events: %w", err)
	}
	defer rows.Close()
	events := make([]Event, 0)
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load dashboard projection event rows: %w", err)
	}
	return events, nil
}

func dashboardRunKindBefore(ctx context.Context, tx *sql.Tx, sessionID string, startSeq int64) (string, error) {
	var eventType string
	var payload string
	err := tx.QueryRowContext(ctx, `
		SELECT type, payload_json
		FROM events
		WHERE session_id = ? AND seq < ?
		  AND type IN ('user.message.completed', 'session.action.completed')
		ORDER BY seq DESC LIMIT 1`, sessionID, startSeq).Scan(&eventType, &payload)
	if err != nil {
		if err == sql.ErrNoRows {
			return "unknown", nil
		}
		return "", fmt.Errorf("load dashboard run kind: %w", err)
	}
	if eventType == "user.message.completed" {
		return "message", nil
	}
	if dashboardPayloadString(json.RawMessage(payload), "action") == "compact" {
		return "compact", nil
	}
	return "unknown", nil
}

func projectDashboardEvent(ctx context.Context, tx *sql.Tx, event Event) error {
	if event.Type == "session.status.updated" && dashboardPayloadString(event.Payload, "status") == "running" {
		return projectDashboardRunStart(ctx, tx, event)
	}

	runID, err := dashboardRunForEvent(ctx, tx, event)
	if err != nil || runID == "" {
		return err
	}

	switch event.Type {
	case "tool.call.started":
		if _, err := tx.ExecContext(ctx, `UPDATE dashboard_runs SET tool_count = tool_count + 1 WHERE id = ?`, runID); err != nil {
			return fmt.Errorf("project dashboard tool call: %w", err)
		}
		if dashboardExplicitDelegation(event.Payload) {
			if err := projectDashboardOutcome(ctx, tx, runID, "delegation", event, "started"); err != nil {
				return err
			}
		}
	case "tool.call.completed":
		for _, outcome := range dashboardShellOutcomes(event) {
			derivedEvent := event
			derivedEvent.Payload = dashboardShellOutcomePayload(event, outcome)
			if err := projectDashboardOutcome(ctx, tx, runID, outcome.Kind, derivedEvent, outcome.Status); err != nil {
				return err
			}
		}
	case "file.change.completed":
		if event.Status != EventStatusFailed && event.Status != EventStatusCancelled {
			if err := projectDashboardFiles(ctx, tx, runID, event.Payload); err != nil {
				return err
			}
		}
	case "agent.input.requested":
		if _, err := tx.ExecContext(ctx, `UPDATE dashboard_runs SET input_request_count = input_request_count + 1 WHERE id = ?`, runID); err != nil {
			return fmt.Errorf("project dashboard input request: %w", err)
		}
	case "agent.permission.requested":
		if _, err := tx.ExecContext(ctx, `UPDATE dashboard_runs SET permission_request_count = permission_request_count + 1 WHERE id = ?`, runID); err != nil {
			return fmt.Errorf("project dashboard permission request: %w", err)
		}
	case "agent.message.completed":
		if summary := dashboardPayloadString(event.Payload, "text"); summary != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE dashboard_runs SET summary = ? WHERE id = ?`, dashboardExcerpt(summary), runID); err != nil {
				return fmt.Errorf("project dashboard summary: %w", err)
			}
		}
	case "run.outcome.recorded":
		kind := dashboardPayloadString(event.Payload, "kind")
		if kind == "commit" || kind == "pull_request" || kind == "test" {
			if err := projectDashboardOutcome(ctx, tx, runID, kind, event, dashboardPayloadString(event.Payload, "status")); err != nil {
				return err
			}
		}
	case "agent.delegation.started":
		if err := projectDashboardOutcome(ctx, tx, runID, "delegation", event, "started"); err != nil {
			return err
		}
	case "agent.delegation.completed":
		if err := projectDashboardOutcome(ctx, tx, runID, "delegation", event, "completed"); err != nil {
			return err
		}
	}

	if tokens, ok := dashboardTokenUsage(event); ok {
		if _, err := tx.ExecContext(ctx, `
			UPDATE dashboard_runs
			SET token_count = MAX(token_count, ?), has_token_usage = 1
			WHERE id = ?`, tokens, runID); err != nil {
			return fmt.Errorf("project dashboard token usage: %w", err)
		}
	}
	if amount, currency, ok := dashboardCostUsage(event); ok {
		if _, err := tx.ExecContext(ctx, `
			UPDATE dashboard_runs
			SET cost_amount = MAX(cost_amount, ?), cost_currency = ?, has_cost_usage = 1
			WHERE id = ?`, amount, currency, runID); err != nil {
			return fmt.Errorf("project dashboard cost usage: %w", err)
		}
	}

	terminalStatus := ""
	switch event.Type {
	case "agent.run.completed":
		terminalStatus = "completed"
	case "agent.run.failed":
		terminalStatus = "failed"
	case "agent.run.cancelled":
		terminalStatus = "cancelled"
	}
	if terminalStatus != "" {
		errorText := dashboardPayloadString(event.Payload, "error")
		if _, err := tx.ExecContext(ctx, `
			UPDATE dashboard_runs
			SET status = ?, terminal_seq = ?, completed_at = ?, error = ?
			WHERE id = ?`, terminalStatus, event.Seq, formatTime(event.CreatedAt), dashboardExcerpt(errorText), runID); err != nil {
			return fmt.Errorf("project dashboard terminal event: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE dashboard_runs SET last_projected_seq = MAX(last_projected_seq, ?) WHERE id = ?`,
		event.Seq, runID,
	); err != nil {
		return fmt.Errorf("advance dashboard projection cursor: %w", err)
	}
	return nil
}

func projectDashboardRunStart(ctx context.Context, tx *sql.Tx, event Event) error {
	runID := dashboardPayloadString(event.Payload, "run_id")
	if runID == "" {
		runID = legacyDashboardRunID(event.SessionID, event.Seq)
	}
	var agentType string
	var workspace sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT agent_type, workspace_path FROM sessions WHERE id = ?`, event.SessionID).Scan(&agentType, &workspace); err != nil {
		return fmt.Errorf("load dashboard run session: %w", err)
	}
	if value := dashboardPayloadString(event.Payload, "agent_type"); value != "" {
		agentType = value
	}
	workspacePath := dashboardPayloadString(event.Payload, "workspace_path")
	if workspacePath == "" {
		workspacePath = workspace.String
	}
	kind := dashboardPayloadString(event.Payload, "run_kind")
	if kind == "" {
		kind = "unknown"
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO dashboard_runs (
			id, session_id, kind, agent_type, workspace_path, status,
			start_seq, last_projected_seq, started_at
		) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
		ON CONFLICT(session_id, start_seq) DO NOTHING`,
		runID, event.SessionID, kind, agentType, workspacePath, event.Seq, event.Seq, formatTime(event.CreatedAt),
	); err != nil {
		return fmt.Errorf("project dashboard run start: %w", err)
	}
	return nil
}

func dashboardRunForEvent(ctx context.Context, tx *sql.Tx, event Event) (string, error) {
	if runID := dashboardPayloadString(event.Payload, "run_id"); runID != "" {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM dashboard_runs WHERE id = ?`, runID).Scan(&exists); err != nil {
			return "", fmt.Errorf("check dashboard run: %w", err)
		}
		if exists > 0 {
			return runID, nil
		}
	}
	var runID string
	err := tx.QueryRowContext(ctx, `
		SELECT id FROM dashboard_runs
		WHERE session_id = ? AND status = 'running' AND start_seq < ?
		ORDER BY start_seq DESC LIMIT 1`, event.SessionID, event.Seq).Scan(&runID)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("find dashboard run for event: %w", err)
	}
	return runID, nil
}

func projectDashboardFiles(ctx context.Context, tx *sql.Tx, runID string, payload json.RawMessage) error {
	for _, path := range dashboardPayloadStrings(payload, "paths") {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO dashboard_run_files (run_id, path) VALUES (?, ?)`, runID, path); err != nil {
			return fmt.Errorf("project dashboard run file: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE dashboard_runs
		SET file_count = (SELECT COUNT(*) FROM dashboard_run_files WHERE run_id = ?)
		WHERE id = ?`, runID, runID); err != nil {
		return fmt.Errorf("update dashboard file count: %w", err)
	}
	return nil
}

func projectDashboardOutcome(ctx context.Context, tx *sql.Tx, runID string, kind string, event Event, status string) error {
	key := dashboardPayloadString(event.Payload, "outcome_id")
	if key == "" {
		key = dashboardPayloadString(event.Payload, "delegation_id")
	}
	if key == "" {
		key = dashboardPayloadString(event.Payload, "item_id")
	}
	if key == "" {
		key = event.ID
	}
	title := dashboardPayloadString(event.Payload, "title")
	if title == "" {
		title = dashboardPayloadString(event.Payload, "label")
	}
	reference := dashboardPayloadString(event.Payload, "reference")
	if reference == "" {
		reference = dashboardPayloadString(event.Payload, "sha")
	}
	url := dashboardPayloadString(event.Payload, "url")
	var startedAt any
	var completedAt any
	if status == "started" {
		startedAt = formatTime(event.CreatedAt)
	} else {
		completedAt = formatTime(event.CreatedAt)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO dashboard_run_outcomes (
			run_id, kind, outcome_key, status, title, reference, url, started_at, completed_at, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(run_id, kind, outcome_key) DO UPDATE SET
			status = excluded.status,
			title = CASE WHEN excluded.title = '' THEN dashboard_run_outcomes.title ELSE excluded.title END,
			reference = CASE WHEN excluded.reference = '' THEN dashboard_run_outcomes.reference ELSE excluded.reference END,
			url = CASE WHEN excluded.url = '' THEN dashboard_run_outcomes.url ELSE excluded.url END,
			started_at = COALESCE(dashboard_run_outcomes.started_at, excluded.started_at),
			completed_at = COALESCE(excluded.completed_at, dashboard_run_outcomes.completed_at),
			payload_json = excluded.payload_json`,
		runID, kind, key, status, title, reference, url, startedAt, completedAt, string(event.Payload),
	); err != nil {
		return fmt.Errorf("project dashboard outcome: %w", err)
	}
	return nil
}

func dashboardExplicitDelegation(payload json.RawMessage) bool {
	itemType := dashboardPayloadString(payload, "item_type")
	tool := strings.ToLower(dashboardPayloadString(payload, "tool"))
	if itemType == "collabAgentToolCall" && (tool == "spawn_agent" || tool == "delegate") {
		return true
	}
	provider := strings.ToLower(dashboardPayloadString(payload, "provider"))
	return provider == "claude" && (tool == "task" || tool == "agent")
}

func dashboardTokenUsage(event Event) (int64, bool) {
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return 0, false
	}
	if tokens := dashboardNestedNumber(payload, "tokens", "total"); tokens > 0 {
		return int64(tokens), true
	}
	if event.Type == "provider.codex.event" {
		if tokens := dashboardNestedNumber(payload, "raw", "tokenUsage", "last", "totalTokens"); tokens > 0 {
			return int64(tokens), true
		}
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		total := dashboardNumber(usage["total_tokens"])
		if total <= 0 {
			total = dashboardNumber(usage["input_tokens"]) + dashboardNumber(usage["cache_creation_input_tokens"]) +
				dashboardNumber(usage["cache_read_input_tokens"]) + dashboardNumber(usage["output_tokens"])
		}
		if total > 0 {
			return int64(total), true
		}
	}
	return 0, false
}

func dashboardCostUsage(event Event) (float64, string, bool) {
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return 0, "", false
	}
	if amount := dashboardNumber(payload["total_cost_usd"]); amount > 0 {
		return amount, "USD", true
	}
	for _, candidate := range []any{payload["cost"], dashboardNestedValue(payload, "raw_update", "cost")} {
		cost, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		amount := dashboardNumber(cost["amount"])
		currency, _ := cost["currency"].(string)
		currency = strings.ToUpper(strings.TrimSpace(currency))
		if amount >= 0 && currency != "" {
			return amount, currency, true
		}
	}
	return 0, "", false
}

func dashboardPayloadString(payload json.RawMessage, key string) string {
	var value map[string]any
	if json.Unmarshal(payload, &value) != nil {
		return ""
	}
	text, _ := value[key].(string)
	return strings.TrimSpace(text)
}

func dashboardPayloadStrings(payload json.RawMessage, key string) []string {
	var value map[string]any
	if json.Unmarshal(payload, &value) != nil {
		return nil
	}
	raw, ok := value[key].([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			result = append(result, text)
		}
	}
	return result
}

func dashboardNestedValue(value map[string]any, path ...string) any {
	var current any = value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

func dashboardNestedNumber(value map[string]any, path ...string) float64 {
	return dashboardNumber(dashboardNestedValue(value, path...))
}

func dashboardNumber(value any) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case json.Number:
		parsed, _ := number.Float64()
		return parsed
	default:
		return 0
	}
}

func dashboardExcerpt(value string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	const maxRunes = 600
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + "…"
}

func legacyDashboardRunID(sessionID string, seq int64) string {
	return fmt.Sprintf("run_legacy_%s_%d", strings.TrimPrefix(sessionID, "sess_"), seq)
}
