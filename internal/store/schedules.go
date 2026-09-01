package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const scheduleSelect = `
	SELECT s.id, s.session_id, s.name, s.prompt, s.cadence_json, s.timezone,
	       s.enabled, s.next_run_at, s.deleted_at, s.created_at, s.updated_at,
	       (SELECT COUNT(*) FROM schedule_occurrences o WHERE o.schedule_id = s.id AND o.status = 'queued'),
	       COALESCE((SELECT o.status FROM schedule_occurrences o WHERE o.schedule_id = s.id ORDER BY o.created_at DESC LIMIT 1), ''),
	       (SELECT o.scheduled_for FROM schedule_occurrences o WHERE o.schedule_id = s.id ORDER BY o.created_at DESC LIMIT 1)
	FROM session_schedules s`

func (s *Store) CreateSchedule(ctx context.Context, params CreateScheduleParams) (SessionSchedule, error) {
	if strings.TrimSpace(params.SessionID) == "" || strings.TrimSpace(params.Prompt) == "" {
		return SessionSchedule{}, fmt.Errorf("%w: session_id and prompt are required", ErrInvalidArgument)
	}
	if !json.Valid(params.Cadence) {
		return SessionSchedule{}, fmt.Errorf("%w: cadence must be valid JSON", ErrInvalidArgument)
	}
	id, err := newPrefixedUUID("sched_")
	if err != nil {
		return SessionSchedule{}, err
	}
	now := s.now()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO session_schedules
			(id, session_id, name, prompt, cadence_json, timezone, enabled, next_run_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, params.SessionID, strings.TrimSpace(params.Name), strings.TrimSpace(params.Prompt), string(params.Cadence),
		params.Timezone, boolInt(params.Enabled), nullableTime(params.NextRunAt), formatTime(now), formatTime(now))
	if err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			return SessionSchedule{}, fmt.Errorf("%w: session %s", ErrNotFound, params.SessionID)
		}
		return SessionSchedule{}, fmt.Errorf("create schedule: %w", err)
	}
	return s.GetSchedule(ctx, params.SessionID, id)
}

func (s *Store) GetSchedule(ctx context.Context, sessionID, id string) (SessionSchedule, error) {
	row := s.db.QueryRowContext(ctx, scheduleSelect+` WHERE s.session_id = ? AND s.id = ? AND s.deleted_at IS NULL`, sessionID, id)
	return scanSchedule(row)
}

func (s *Store) ListSchedules(ctx context.Context, sessionID string) ([]SessionSchedule, error) {
	rows, err := s.db.QueryContext(ctx, scheduleSelect+` WHERE s.session_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at ASC`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	defer rows.Close()
	result := make([]SessionSchedule, 0)
	for rows.Next() {
		item, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) UpdateSchedule(ctx context.Context, params UpdateScheduleParams) (SessionSchedule, error) {
	if strings.TrimSpace(params.Prompt) == "" || !json.Valid(params.Cadence) {
		return SessionSchedule{}, fmt.Errorf("%w: prompt and valid cadence are required", ErrInvalidArgument)
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE session_schedules
		SET name = ?, prompt = ?, cadence_json = ?, timezone = ?, enabled = ?, next_run_at = ?, updated_at = ?
		WHERE session_id = ? AND id = ? AND deleted_at IS NULL`,
		strings.TrimSpace(params.Name), strings.TrimSpace(params.Prompt), string(params.Cadence), params.Timezone,
		boolInt(params.Enabled), nullableTime(params.NextRunAt), formatTime(s.now()), params.SessionID, params.ID)
	if err != nil {
		return SessionSchedule{}, fmt.Errorf("update schedule: %w", err)
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return SessionSchedule{}, fmt.Errorf("%w: schedule %s", ErrNotFound, params.ID)
	}
	return s.GetSchedule(ctx, params.SessionID, params.ID)
}

func (s *Store) DeleteSchedule(ctx context.Context, sessionID, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	now := formatTime(s.now())
	result, err := tx.ExecContext(ctx, `UPDATE session_schedules SET enabled = 0, next_run_at = NULL, deleted_at = ?, updated_at = ? WHERE session_id = ? AND id = ? AND deleted_at IS NULL`, now, now, sessionID, id)
	if err != nil {
		return fmt.Errorf("delete schedule: %w", err)
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: schedule %s", ErrNotFound, id)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE queued_messages SET status = 'removed', updated_at = ? WHERE source_kind = 'schedule' AND source_id IN (SELECT id FROM schedule_occurrences WHERE schedule_id = ? AND status = 'queued') AND status = 'pending'`, now, id); err != nil {
		return fmt.Errorf("remove deleted schedule queue: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE schedule_occurrences SET status = 'cancelled', completed_at = ? WHERE schedule_id = ? AND status = 'queued' AND id IN (SELECT source_id FROM queued_messages WHERE source_kind = 'schedule' AND status = 'removed')`, now, id); err != nil {
		return fmt.Errorf("cancel deleted schedule occurrences: %w", err)
	}
	return tx.Commit()
}

func (s *Store) PauseSchedulesForArchive(ctx context.Context, sessionID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	now := formatTime(s.now())
	if _, err := tx.ExecContext(ctx, `UPDATE session_schedules SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE session_id = ? AND deleted_at IS NULL`, now, sessionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE queued_messages SET status = 'removed', updated_at = ? WHERE source_kind = 'schedule' AND source_id IN (SELECT id FROM schedule_occurrences WHERE session_id = ? AND status = 'queued') AND status = 'pending'`, now, sessionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE schedule_occurrences SET status = 'cancelled', completed_at = ? WHERE session_id = ? AND status = 'queued' AND id IN (SELECT source_id FROM queued_messages WHERE source_kind = 'schedule' AND status = 'removed')`, now, sessionID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListDueSchedules(ctx context.Context, now time.Time) ([]SessionSchedule, error) {
	rows, err := s.db.QueryContext(ctx, scheduleSelect+` WHERE s.deleted_at IS NULL AND s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ? ORDER BY s.next_run_at, s.id`, formatTime(now))
	if err != nil {
		return nil, fmt.Errorf("list due schedules: %w", err)
	}
	defer rows.Close()
	result := make([]SessionSchedule, 0)
	for rows.Next() {
		item, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) NextScheduleTime(ctx context.Context) (*time.Time, error) {
	var value sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT MIN(next_run_at) FROM session_schedules WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL`).Scan(&value); err != nil {
		return nil, err
	}
	return parseNullableTime(value)
}

func (s *Store) SetScheduleNextRun(ctx context.Context, sessionID, id string, next *time.Time) error {
	result, err := s.db.ExecContext(ctx, `UPDATE session_schedules SET next_run_at = ?, updated_at = ? WHERE session_id = ? AND id = ? AND deleted_at IS NULL`, nullableTime(next), formatTime(s.now()), sessionID, id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: schedule %s", ErrNotFound, id)
	}
	return nil
}

func (s *Store) MaterializeScheduleOccurrence(ctx context.Context, params MaterializeScheduleOccurrenceParams) (ScheduleOccurrence, error) {
	occurrenceID, err := newPrefixedUUID("socc_")
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	queueID, err := newPrefixedUUID("qmsg_")
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	defer rollback(tx)
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM session_schedules WHERE id = ? AND session_id = ? AND deleted_at IS NULL`, params.ScheduleID, params.SessionID).Scan(&exists); err != nil || exists == 0 {
		if err != nil {
			return ScheduleOccurrence{}, err
		}
		return ScheduleOccurrence{}, fmt.Errorf("%w: schedule %s", ErrNotFound, params.ScheduleID)
	}
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) + 1 FROM queued_messages WHERE session_id = ?`, params.SessionID).Scan(&seq); err != nil {
		return ScheduleOccurrence{}, err
	}
	now := s.now()
	occurrence := ScheduleOccurrence{ID: occurrenceID, ScheduleID: params.ScheduleID, SessionID: params.SessionID, QueueMessageID: queueID, Trigger: params.Trigger, ScheduledFor: params.ScheduledFor.UTC(), Status: "queued", CreatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO queued_messages (id, session_id, seq, status, content, agent_options_json, skills_json, source_kind, source_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, '{}', '[]', 'schedule', ?, ?, ?)`, queueID, params.SessionID, seq, strings.TrimSpace(params.Prompt), occurrence.ID, formatTime(now), formatTime(now)); err != nil {
		return ScheduleOccurrence{}, fmt.Errorf("insert scheduled queue message: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schedule_occurrences (id, schedule_id, session_id, queue_message_id, trigger, scheduled_for, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`, occurrence.ID, occurrence.ScheduleID, occurrence.SessionID, occurrence.QueueMessageID, occurrence.Trigger, formatTime(occurrence.ScheduledFor), formatTime(now)); err != nil {
		return ScheduleOccurrence{}, fmt.Errorf("insert schedule occurrence: %w", err)
	}
	if params.Advance {
		if _, err := tx.ExecContext(ctx, `UPDATE session_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`, nullableTime(params.NextRunAt), formatTime(now), params.ScheduleID); err != nil {
			return ScheduleOccurrence{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return ScheduleOccurrence{}, err
	}
	return occurrence, nil
}

func (s *Store) ListScheduleOccurrences(ctx context.Context, sessionID, scheduleID string, limit int) ([]ScheduleOccurrence, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, schedule_id, session_id, queue_message_id, trigger, scheduled_for, status, run_id, error, created_at, started_at, completed_at FROM schedule_occurrences WHERE session_id = ? AND schedule_id = ? ORDER BY created_at DESC LIMIT ?`, sessionID, scheduleID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ScheduleOccurrence, 0)
	for rows.Next() {
		item, err := scanOccurrence(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) GetScheduleOccurrence(ctx context.Context, occurrenceID string) (ScheduleOccurrence, error) {
	return scanOccurrence(s.db.QueryRowContext(ctx, `SELECT id, schedule_id, session_id, queue_message_id, trigger, scheduled_for, status, run_id, error, created_at, started_at, completed_at FROM schedule_occurrences WHERE id = ?`, occurrenceID))
}

func (s *Store) CancelScheduleOccurrence(ctx context.Context, sessionID, scheduleID, occurrenceID string) (ScheduleOccurrence, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	defer rollback(tx)
	item, err := scanOccurrence(tx.QueryRowContext(ctx, `SELECT id, schedule_id, session_id, queue_message_id, trigger, scheduled_for, status, run_id, error, created_at, started_at, completed_at FROM schedule_occurrences WHERE session_id = ? AND schedule_id = ? AND id = ?`, sessionID, scheduleID, occurrenceID))
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	if item.Status != "queued" {
		return ScheduleOccurrence{}, fmt.Errorf("%w: occurrence is %s", ErrInvalidArgument, item.Status)
	}
	now := s.now()
	result, err := tx.ExecContext(ctx, `UPDATE queued_messages SET status = 'removed', updated_at = ? WHERE id = ? AND status = 'pending'`, formatTime(now), item.QueueMessageID)
	if err != nil {
		return ScheduleOccurrence{}, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ScheduleOccurrence{}, fmt.Errorf("%w: occurrence is already starting", ErrInvalidArgument)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE schedule_occurrences SET status = 'cancelled', completed_at = ? WHERE id = ?`, formatTime(now), item.ID); err != nil {
		return ScheduleOccurrence{}, err
	}
	if err := tx.Commit(); err != nil {
		return ScheduleOccurrence{}, err
	}
	item.Status = "cancelled"
	item.CompletedAt = &now
	return item, nil
}

func (s *Store) MarkScheduleOccurrenceRunning(ctx context.Context, occurrenceID, runID string) error {
	now := s.now()
	result, err := s.db.ExecContext(ctx, `UPDATE schedule_occurrences SET status = 'running', run_id = ?, started_at = ? WHERE id = ? AND status = 'queued'`, runID, formatTime(now), occurrenceID)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return fmt.Errorf("%w: occurrence is not queued", ErrInvalidArgument)
	}
	return nil
}

func (s *Store) MarkScheduleOccurrenceFinished(ctx context.Context, occurrenceID, status, message string) error {
	if status != "completed" && status != "failed" && status != "cancelled" {
		return fmt.Errorf("%w: invalid occurrence status", ErrInvalidArgument)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE schedule_occurrences SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'running'`, status, message, formatTime(s.now()), occurrenceID)
	return err
}

func (s *Store) FailInterruptedScheduleOccurrences(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE schedule_occurrences SET status = 'failed', error = 'server restarted while run was active', completed_at = ? WHERE status = 'running'`, formatTime(s.now()))
	return err
}

func (s *Store) ListPendingQueueSessionIDs(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT session_id FROM queued_messages WHERE status = 'pending' ORDER BY session_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func scanSchedule(row rowScanner) (SessionSchedule, error) {
	var item SessionSchedule
	var cadence, next, deleted, created, updated, lastScheduled sql.NullString
	var enabled int
	if err := row.Scan(&item.ID, &item.SessionID, &item.Name, &item.Prompt, &cadence, &item.Timezone, &enabled, &next, &deleted, &created, &updated, &item.PendingCount, &item.LastStatus, &lastScheduled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionSchedule{}, fmt.Errorf("%w: schedule", ErrNotFound)
		}
		return SessionSchedule{}, fmt.Errorf("scan schedule: %w", err)
	}
	item.Cadence = json.RawMessage(cadence.String)
	item.Enabled = enabled != 0
	var err error
	if item.NextRunAt, err = parseNullableTime(next); err != nil {
		return SessionSchedule{}, err
	}
	if item.DeletedAt, err = parseNullableTime(deleted); err != nil {
		return SessionSchedule{}, err
	}
	if item.LastScheduledFor, err = parseNullableTime(lastScheduled); err != nil {
		return SessionSchedule{}, err
	}
	if created.Valid {
		item.CreatedAt, err = parseTime(created.String)
		if err != nil {
			return SessionSchedule{}, err
		}
	}
	if updated.Valid {
		item.UpdatedAt, err = parseTime(updated.String)
		if err != nil {
			return SessionSchedule{}, err
		}
	}
	return item, nil
}

func scanOccurrence(row rowScanner) (ScheduleOccurrence, error) {
	var item ScheduleOccurrence
	var scheduled, created string
	var started, completed sql.NullString
	if err := row.Scan(&item.ID, &item.ScheduleID, &item.SessionID, &item.QueueMessageID, &item.Trigger, &scheduled, &item.Status, &item.RunID, &item.Error, &created, &started, &completed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ScheduleOccurrence{}, fmt.Errorf("%w: occurrence", ErrNotFound)
		}
		return ScheduleOccurrence{}, err
	}
	var err error
	if item.ScheduledFor, err = parseTime(scheduled); err != nil {
		return ScheduleOccurrence{}, err
	}
	if item.CreatedAt, err = parseTime(created); err != nil {
		return ScheduleOccurrence{}, err
	}
	if item.StartedAt, err = parseNullableTime(started); err != nil {
		return ScheduleOccurrence{}, err
	}
	if item.CompletedAt, err = parseNullableTime(completed); err != nil {
		return ScheduleOccurrence{}, err
	}
	return item, nil
}

func parseNullableTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil, nil
	}
	parsed, err := parseTime(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
