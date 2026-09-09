package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Unknown is deliberately durable: a crashed handler must never allow a retry
// to launch the same work again. Canonical events/queue rows settle acceptance.
type MessageSubmission struct {
	State       string          `json:"state"`
	HTTPStatus  int             `json:"http_status"`
	Response    json.RawMessage `json:"response"`
	RequestHash string          `json:"-"`
}

func (s *Store) ClaimMessageSubmission(ctx context.Context, sessionID, clientID, hash string) (MessageSubmission, bool, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO message_submissions (session_id, client_id, request_hash) VALUES (?, ?, ?) ON CONFLICT(session_id, client_id) DO NOTHING`, sessionID, clientID, hash)
	if err != nil {
		return MessageSubmission{}, false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return MessageSubmission{}, false, err
	}
	record, err := s.GetMessageSubmission(ctx, sessionID, clientID)
	return record, count == 1, err
}

func (s *Store) CompleteMessageSubmission(ctx context.Context, sessionID, clientID string, status int, response []byte) error {
	state := "unknown"
	if status >= 200 && status < 300 {
		state = "accepted"
	}
	if status >= 400 && status < 500 {
		state = "rejected"
	}
	_, err := s.db.ExecContext(ctx, `UPDATE message_submissions SET state = ?, http_status = ?, response_json = ? WHERE session_id = ? AND client_id = ?`, state, status, string(response), sessionID, clientID)
	return err
}

func (s *Store) GetMessageSubmission(ctx context.Context, sessionID, clientID string) (MessageSubmission, error) {
	var record MessageSubmission
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT state, http_status, response_json, request_hash FROM message_submissions WHERE session_id = ? AND client_id = ?`, sessionID, clientID).Scan(&record.State, &record.HTTPStatus, &raw, &record.RequestHash)
	if errors.Is(err, sql.ErrNoRows) {
		return MessageSubmission{}, ErrNotFound
	}
	if err != nil {
		return MessageSubmission{}, err
	}
	record.Response = json.RawMessage(raw)
	if record.State == "accepted" {
		return record, nil
	}
	var acceptedAs string
	err = s.db.QueryRowContext(ctx, `SELECT CASE WHEN json_extract(payload_json, '$.delivery') = 'steer' THEN 'steered' ELSE 'run' END FROM events WHERE session_id = ? AND type = 'user.message.completed' AND json_extract(payload_json, '$.client_submission_id') = ?
 UNION ALL SELECT 'queued' FROM queued_messages WHERE session_id = ? AND source_kind = 'manual' AND source_id = ? LIMIT 1`, sessionID, clientID, sessionID, clientID).Scan(&acceptedAs)
	if err == nil {
		record.State = "accepted"
		record.HTTPStatus = 202
		record.Response, err = json.Marshal(map[string]string{"session_id": sessionID, "accepted_as": acceptedAs})
	} else if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return record, err
}
