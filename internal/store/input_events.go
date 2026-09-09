package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

// Questions are control state, not a transcript page. Return unresolved requests
// and their submission state at the page watermark, even if a long turn's start
// has fallen outside the requested event/byte budget.
func (s *Store) ListPendingInputEvents(ctx context.Context, sessionID string, throughSeq int64) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH current_inputs AS (
			SELECT * FROM events WHERE session_id = ? AND seq <= ?
			AND type IN ('agent.input.requested', 'agent.input.submitted', 'agent.input.failed', 'agent.input.answered', 'agent.input.cancelled')
			AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ? AND seq <= ?
			AND type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')), 0)
		)
		SELECT id, session_id, seq, type, role, status, payload_json, created_at FROM current_inputs AS pending
		WHERE type NOT IN ('agent.input.answered', 'agent.input.cancelled') AND NOT EXISTS (
			SELECT 1 FROM current_inputs AS answered WHERE answered.type IN ('agent.input.answered', 'agent.input.cancelled')
			AND json_extract(answered.payload_json, '$.request_id') = json_extract(pending.payload_json, '$.request_id')
		) ORDER BY seq`, sessionID, throughSeq, sessionID, throughSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// An answer can race a provider withdrawal or arrive after a run finishes.
// Resolve a control only once, and never decrement a successor run's count.
func controlResolutionDelta(ctx context.Context, tx *sql.Tx, event Event) (int, error) {
	var payload struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.RequestID == "" {
		return -1, nil // Preserve the behavior of legacy events without request IDs.
	}
	requested, answered, failed, cancelled := "agent.input.requested", "agent.input.answered", "agent.input.failed", "agent.input.cancelled"
	if strings.HasPrefix(event.Type, "agent.permission.") {
		requested, answered, failed, cancelled = "agent.permission.requested", "agent.permission.resolved", "agent.permission.cancelled", "agent.permission.cancelled"
	}
	var unresolved bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM events AS requested WHERE session_id = ? AND type = ?
		AND json_extract(payload_json, '$.request_id') = ?
		AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ?
		AND type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')), 0)
		AND NOT EXISTS (SELECT 1 FROM events AS resolved WHERE resolved.session_id = requested.session_id
		AND resolved.seq > requested.seq AND resolved.seq < ?
		AND resolved.type IN (?, ?, ?)
		AND json_extract(resolved.payload_json, '$.request_id') = json_extract(requested.payload_json, '$.request_id'))
	)`, event.SessionID, requested, payload.RequestID, event.SessionID, event.Seq, answered, failed, cancelled).Scan(&unresolved)
	if err != nil {
		return 0, err
	}
	if unresolved {
		return -1, nil
	}
	return 0, nil
}
