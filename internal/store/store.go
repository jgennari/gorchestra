package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const defaultEventLimit = 500
const defaultSessionLimit = 50

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	store := &Store{
		db: db,
		now: func() time.Time {
			return time.Now().UTC()
		},
	}

	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable sqlite foreign keys: %w", err)
	}

	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set sqlite busy timeout: %w", err)
	}

	if err := store.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) CreateSession(ctx context.Context, params CreateSessionParams) (Session, error) {
	if strings.TrimSpace(params.AgentType) == "" {
		return Session{}, fmt.Errorf("%w: agent_type is required", ErrInvalidArgument)
	}

	id, err := newPrefixedUUID("sess_")
	if err != nil {
		return Session{}, err
	}

	now := s.now()
	session := Session{
		ID:            id,
		Title:         params.Title,
		AgentType:     params.AgentType,
		Status:        SessionStatusIdle,
		WorkspacePath: strings.TrimSpace(params.WorkspacePath),
		AgentOptions:  json.RawMessage(`{}`),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if len(params.AgentOptions) > 0 {
		if !json.Valid(params.AgentOptions) {
			return Session{}, fmt.Errorf("%w: agent_options must be valid JSON", ErrInvalidArgument)
		}
		session.AgentOptions = append(json.RawMessage(nil), params.AgentOptions...)
	}

	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO sessions (id, title, agent_type, status, workspace_path, agent_options_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		session.ID,
		session.Title,
		session.AgentType,
		string(session.Status),
		session.WorkspacePath,
		string(session.AgentOptions),
		formatTime(session.CreatedAt),
		formatTime(session.UpdatedAt),
	); err != nil {
		return Session{}, fmt.Errorf("insert session: %w", err)
	}

	return session, nil
}

func (s *Store) GetSession(ctx context.Context, id string) (Session, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT id, title, agent_type, status, provider_session_id, workspace_path, agent_options_json,
		        (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id) AS event_count,
		        (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id AND type IN ('tool.call.started', 'file.change.started')) AS tool_count,
		        created_at, updated_at, completed_at, archived_at
		 FROM sessions
		 WHERE id = ?`,
		id,
	)

	session, err := scanSession(row)
	if err != nil {
		return Session{}, err
	}

	return session, nil
}

func (s *Store) ListSessions(ctx context.Context, params ListSessionsParams) ([]Session, error) {
	limit := params.Limit
	if limit <= 0 {
		limit = defaultSessionLimit
	}

	query := `SELECT id, title, agent_type, status, provider_session_id, workspace_path, agent_options_json,
		        (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id) AS event_count,
		        (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id AND type IN ('tool.call.started', 'file.change.started')) AS tool_count,
		        created_at, updated_at, completed_at, archived_at
		 FROM sessions`
	args := []any{}
	filters := []string{`archived_at IS NULL`}
	if params.Status != "" {
		filters = append(filters, `status = ?`)
		args = append(args, string(params.Status))
	}
	query += ` WHERE ` + strings.Join(filters, ` AND `)
	query += ` ORDER BY updated_at DESC, created_at DESC, id DESC
		 LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0)
	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list sessions rows: %w", err)
	}

	return sessions, nil
}

func (s *Store) UpdateSessionTitle(ctx context.Context, params UpdateSessionTitleParams) (Session, error) {
	if strings.TrimSpace(params.ID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidArgument)
	}

	title := strings.TrimSpace(params.Title)
	now := s.now()
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions
		 SET title = ?, updated_at = ?
		 WHERE id = ?`,
		title,
		formatTime(now),
		params.ID,
	)
	if err != nil {
		return Session{}, fmt.Errorf("update session title: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Session{}, fmt.Errorf("check updated session title rows: %w", err)
	}
	if rowsAffected == 0 {
		return Session{}, fmt.Errorf("%w: session %s", ErrNotFound, params.ID)
	}

	return s.GetSession(ctx, params.ID)
}

func (s *Store) ArchiveSession(ctx context.Context, params ArchiveSessionParams) (Session, error) {
	if strings.TrimSpace(params.ID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidArgument)
	}

	now := s.now()
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions
		 SET archived_at = COALESCE(archived_at, ?), updated_at = ?
		 WHERE id = ?`,
		formatTime(now),
		formatTime(now),
		params.ID,
	)
	if err != nil {
		return Session{}, fmt.Errorf("archive session: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Session{}, fmt.Errorf("check archived session rows: %w", err)
	}
	if rowsAffected == 0 {
		return Session{}, fmt.Errorf("%w: session %s", ErrNotFound, params.ID)
	}

	return s.GetSession(ctx, params.ID)
}

func (s *Store) SetSessionProviderSessionID(ctx context.Context, params SetSessionProviderSessionIDParams) (Session, error) {
	sessionID := strings.TrimSpace(params.ID)
	providerSessionID := strings.TrimSpace(params.ProviderSessionID)
	if sessionID == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidArgument)
	}
	if providerSessionID == "" {
		return Session{}, fmt.Errorf("%w: provider_session_id is required", ErrInvalidArgument)
	}

	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		return Session{}, err
	}
	if session.ProviderSessionID != "" {
		if session.ProviderSessionID != providerSessionID {
			if params.Replace {
				return s.updateSessionProviderSessionID(ctx, sessionID, providerSessionID)
			}
			return Session{}, fmt.Errorf("%w: provider_session_id already set for session %s", ErrInvalidArgument, sessionID)
		}
		return session, nil
	}

	return s.updateSessionProviderSessionID(ctx, sessionID, providerSessionID)
}

func (s *Store) updateSessionProviderSessionID(ctx context.Context, sessionID string, providerSessionID string) (Session, error) {
	now := s.now()
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions
		 SET provider_session_id = ?, updated_at = ?
		 WHERE id = ?`,
		providerSessionID,
		formatTime(now),
		sessionID,
	)
	if err != nil {
		return Session{}, fmt.Errorf("set session provider_session_id: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Session{}, fmt.Errorf("check session provider_session_id rows: %w", err)
	}
	if rowsAffected == 0 {
		return Session{}, fmt.Errorf("%w: session %s", ErrNotFound, sessionID)
	}

	return s.GetSession(ctx, sessionID)
}

func (s *Store) UpdateSessionStatus(ctx context.Context, params UpdateSessionStatusParams) (Session, error) {
	if strings.TrimSpace(params.ID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidArgument)
	}
	if strings.TrimSpace(string(params.Status)) == "" {
		return Session{}, fmt.Errorf("%w: status is required", ErrInvalidArgument)
	}
	if !isValidSessionStatus(params.Status) {
		return Session{}, fmt.Errorf("%w: unsupported status %s", ErrInvalidArgument, params.Status)
	}

	now := s.now()
	var completedAt any
	if isTerminalSessionStatus(params.Status) {
		completedAt = formatTime(now)
	}

	result, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions
		 SET status = ?, updated_at = ?, completed_at = ?
		 WHERE id = ?`,
		string(params.Status),
		formatTime(now),
		completedAt,
		params.ID,
	)
	if err != nil {
		return Session{}, fmt.Errorf("update session status: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Session{}, fmt.Errorf("check updated session status rows: %w", err)
	}
	if rowsAffected == 0 {
		return Session{}, fmt.Errorf("%w: session %s", ErrNotFound, params.ID)
	}

	return s.GetSession(ctx, params.ID)
}

func (s *Store) AppendEvent(ctx context.Context, params AppendEventParams) (Event, error) {
	if strings.TrimSpace(params.SessionID) == "" {
		return Event{}, fmt.Errorf("%w: session_id is required", ErrInvalidArgument)
	}
	if strings.TrimSpace(params.Type) == "" {
		return Event{}, fmt.Errorf("%w: type is required", ErrInvalidArgument)
	}
	if strings.TrimSpace(string(params.Status)) == "" {
		return Event{}, fmt.Errorf("%w: status is required", ErrInvalidArgument)
	}
	if !json.Valid(params.Payload) {
		return Event{}, fmt.Errorf("%w: payload must be valid JSON", ErrInvalidArgument)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, fmt.Errorf("begin append event: %w", err)
	}
	defer rollback(tx)

	var exists int
	if err := tx.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM sessions WHERE id = ?`,
		params.SessionID,
	).Scan(&exists); err != nil {
		return Event{}, fmt.Errorf("check session: %w", err)
	}
	if exists == 0 {
		return Event{}, fmt.Errorf("%w: session %s", ErrNotFound, params.SessionID)
	}

	var seq int64
	if err := tx.QueryRowContext(
		ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?`,
		params.SessionID,
	).Scan(&seq); err != nil {
		return Event{}, fmt.Errorf("assign event sequence: %w", err)
	}

	id, err := newPrefixedUUID("evt_")
	if err != nil {
		return Event{}, err
	}

	event := Event{
		ID:        id,
		SessionID: params.SessionID,
		Seq:       seq,
		Type:      params.Type,
		Role:      params.Role,
		Status:    params.Status,
		Payload:   append(json.RawMessage(nil), params.Payload...),
		CreatedAt: s.now(),
	}

	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO events (id, session_id, seq, type, role, status, payload_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		event.ID,
		event.SessionID,
		event.Seq,
		event.Type,
		event.Role,
		string(event.Status),
		string(event.Payload),
		formatTime(event.CreatedAt),
	); err != nil {
		return Event{}, fmt.Errorf("insert event: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return Event{}, fmt.Errorf("commit append event: %w", err)
	}

	return event, nil
}

func (s *Store) ListEvents(ctx context.Context, sessionID string, afterSeq int64, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = defaultEventLimit
	}

	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id, session_id, seq, type, role, status, payload_json, created_at
		 FROM events
		 WHERE session_id = ? AND seq > ?
		 ORDER BY seq ASC
		 LIMIT ?`,
		sessionID,
		afterSeq,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
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
		return nil, fmt.Errorf("list events rows: %w", err)
	}

	return events, nil
}

func (s *Store) ListRecentEvents(ctx context.Context, sessionID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = defaultEventLimit
	}

	events, err := s.listEventsDescending(ctx, sessionID, ``, 0, limit)
	if err != nil {
		return nil, err
	}
	reverseEvents(events)
	return events, nil
}

func (s *Store) ListEventsBefore(ctx context.Context, sessionID string, beforeSeq int64, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = defaultEventLimit
	}

	events, err := s.listEventsDescending(ctx, sessionID, `AND seq < ?`, beforeSeq, limit)
	if err != nil {
		return nil, err
	}
	reverseEvents(events)
	return events, nil
}

func (s *Store) listEventsDescending(ctx context.Context, sessionID string, extraWhere string, seqBound int64, limit int) ([]Event, error) {
	query := `SELECT id, session_id, seq, type, role, status, payload_json, created_at
		 FROM events
		 WHERE session_id = ? ` + extraWhere + `
		 ORDER BY seq DESC
		 LIMIT ?`
	args := []any{sessionID}
	if extraWhere != "" {
		args = append(args, seqBound)
	}
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list events descending: %w", err)
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
		return nil, fmt.Errorf("list events descending rows: %w", err)
	}

	return events, nil
}

func reverseEvents(events []Event) {
	for left, right := 0, len(events)-1; left < right; left, right = left+1, right-1 {
		events[left], events[right] = events[right], events[left]
	}
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSession(row rowScanner) (Session, error) {
	var session Session
	var status string
	var providerSessionID sql.NullString
	var workspacePath sql.NullString
	var agentOptions string
	var eventCount int64
	var toolCount int64
	var createdAt string
	var updatedAt string
	var completedAt sql.NullString
	var archivedAt sql.NullString

	if err := row.Scan(
		&session.ID,
		&session.Title,
		&session.AgentType,
		&status,
		&providerSessionID,
		&workspacePath,
		&agentOptions,
		&eventCount,
		&toolCount,
		&createdAt,
		&updatedAt,
		&completedAt,
		&archivedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, ErrNotFound
		}
		return Session{}, fmt.Errorf("scan session: %w", err)
	}

	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return Session{}, fmt.Errorf("parse session created_at: %w", err)
	}
	parsedUpdatedAt, err := parseTime(updatedAt)
	if err != nil {
		return Session{}, fmt.Errorf("parse session updated_at: %w", err)
	}

	session.Status = SessionStatus(status)
	if providerSessionID.Valid {
		session.ProviderSessionID = providerSessionID.String
	}
	if workspacePath.Valid {
		session.WorkspacePath = workspacePath.String
	}
	if agentOptions == "" {
		agentOptions = "{}"
	}
	if !json.Valid([]byte(agentOptions)) {
		return Session{}, fmt.Errorf("scan session: invalid agent_options_json")
	}
	session.AgentOptions = json.RawMessage(agentOptions)
	session.EventCount = eventCount
	session.ToolCount = toolCount
	session.CreatedAt = parsedCreatedAt
	session.UpdatedAt = parsedUpdatedAt

	if completedAt.Valid {
		parsedCompletedAt, err := parseTime(completedAt.String)
		if err != nil {
			return Session{}, fmt.Errorf("parse session completed_at: %w", err)
		}
		session.CompletedAt = &parsedCompletedAt
	}
	if archivedAt.Valid {
		parsedArchivedAt, err := parseTime(archivedAt.String)
		if err != nil {
			return Session{}, fmt.Errorf("parse session archived_at: %w", err)
		}
		session.ArchivedAt = &parsedArchivedAt
	}

	return session, nil
}

func scanEvent(row rowScanner) (Event, error) {
	var event Event
	var role sql.NullString
	var status string
	var payload string
	var createdAt string

	if err := row.Scan(
		&event.ID,
		&event.SessionID,
		&event.Seq,
		&event.Type,
		&role,
		&status,
		&payload,
		&createdAt,
	); err != nil {
		return Event{}, fmt.Errorf("scan event: %w", err)
	}

	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return Event{}, fmt.Errorf("parse event created_at: %w", err)
	}

	event.Status = EventStatus(status)
	if role.Valid {
		event.Role = role.String
	}
	event.Payload = json.RawMessage(payload)
	event.CreatedAt = parsedCreatedAt

	return event, nil
}

func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}

	return t.UTC(), nil
}

func isTerminalSessionStatus(status SessionStatus) bool {
	return status == SessionStatusFailed
}

func isValidSessionStatus(status SessionStatus) bool {
	switch status {
	case SessionStatusIdle, SessionStatusRunning, SessionStatusFailed:
		return true
	default:
		return false
	}
}
