package store

import "context"

// Questions are control state, not a transcript page. Return unresolved requests
// and their submission state at the page watermark, even if a long turn's start
// has fallen outside the requested event/byte budget.
func (s *Store) ListPendingInputEvents(ctx context.Context, sessionID string, throughSeq int64) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH current_inputs AS (
			SELECT * FROM events WHERE session_id = ? AND seq <= ?
			AND type IN ('agent.input.requested', 'agent.input.submitted', 'agent.input.failed', 'agent.input.answered')
			AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ? AND seq <= ?
			AND type IN ('agent.run.completed', 'agent.run.failed', 'agent.run.cancelled')), 0)
		)
		SELECT id, session_id, seq, type, role, status, payload_json, created_at FROM current_inputs AS pending
		WHERE type != 'agent.input.answered' AND NOT EXISTS (
			SELECT 1 FROM current_inputs AS answered WHERE answered.type = 'agent.input.answered'
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
