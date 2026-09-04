package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const debugOnlyEventPredicate = `(
	type IN (
		'agent.log.delta',
		'provider.codex.request',
		'provider.codex.parse_error',
		'provider.claude.parse_error',
		'provider.opencode.request',
		'provider.opencode.parse_error',
		'provider.pi.parse_error'
	)
	OR (
		type = 'provider.codex.event'
		AND COALESCE(json_extract(payload_json, '$.provider_event_type'), '') NOT IN ('thread/tokenUsage/updated', 'item/plan/delta')
		AND NOT (
			json_extract(payload_json, '$.provider_event_type') = 'item/completed'
			AND json_extract(payload_json, '$.raw.item.type') = 'plan'
		)
	)
	OR (
		type = 'provider.claude.event'
		AND json_type(payload_json, '$.usage') IS NULL
	)
	OR (
		type = 'provider.opencode.event'
		AND COALESCE(json_extract(payload_json, '$.provider_event_type'), '') != 'usage_update'
	)
	OR type = 'provider.pi.event'
)`

func (s *Store) HasRunningSession(ctx context.Context) (bool, error) {
	var exists int
	if err := s.db.QueryRowContext(
		ctx,
		`SELECT EXISTS(SELECT 1 FROM sessions WHERE status = ? LIMIT 1)`,
		string(SessionStatusRunning),
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check running sessions: %w", err)
	}
	return exists != 0, nil
}

func (s *Store) EventMaintenanceStatus(ctx context.Context) (EventMaintenanceStatus, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT running, last_started_at, last_completed_at, last_error,
		       deleted_delta_events, deleted_debug_events, extracted_blob_events,
		       reclaimed_bytes, retained_debug_after
		FROM event_maintenance_state WHERE id = 1`)
	var status EventMaintenanceStatus
	var running int
	var lastStartedAt sql.NullString
	var lastCompletedAt sql.NullString
	var retainedDebugAfter sql.NullString
	if err := row.Scan(
		&running,
		&lastStartedAt,
		&lastCompletedAt,
		&status.LastError,
		&status.DeletedDeltaEvents,
		&status.DeletedDebugEvents,
		&status.ExtractedBlobEvents,
		&status.ReclaimedBytes,
		&retainedDebugAfter,
	); err != nil {
		return EventMaintenanceStatus{}, fmt.Errorf("get event maintenance status: %w", err)
	}
	status.Running = running != 0
	var err error
	if status.LastStartedAt, err = parseOptionalMaintenanceTime(lastStartedAt); err != nil {
		return EventMaintenanceStatus{}, err
	}
	if status.LastCompletedAt, err = parseOptionalMaintenanceTime(lastCompletedAt); err != nil {
		return EventMaintenanceStatus{}, err
	}
	if status.RetainedDebugAfter, err = parseOptionalMaintenanceTime(retainedDebugAfter); err != nil {
		return EventMaintenanceStatus{}, err
	}
	return status, nil
}

func parseOptionalMaintenanceTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil, nil
	}
	parsed, err := parseTime(value.String)
	if err != nil {
		return nil, fmt.Errorf("parse event maintenance time: %w", err)
	}
	return &parsed, nil
}

func (s *Store) StartEventMaintenance(ctx context.Context, retainedDebugAfter *time.Time) error {
	var cutoff any
	if retainedDebugAfter != nil {
		cutoff = formatTime(*retainedDebugAfter)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE event_maintenance_state
		SET running = 1, last_started_at = ?, last_error = '', retained_debug_after = ?
		WHERE id = 1`, formatTime(s.now()), cutoff)
	if err != nil {
		return fmt.Errorf("start event maintenance: %w", err)
	}
	return nil
}

func (s *Store) CompleteEventMaintenance(ctx context.Context, result EventMaintenanceBatch) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE event_maintenance_state
		SET running = 0,
		    last_completed_at = ?,
		    last_error = '',
		    deleted_delta_events = deleted_delta_events + ?,
		    deleted_debug_events = deleted_debug_events + ?,
		    extracted_blob_events = extracted_blob_events + ?,
		    reclaimed_bytes = reclaimed_bytes + ?
		WHERE id = 1`,
		formatTime(s.now()),
		result.DeletedDeltaEvents,
		result.DeletedDebugEvents,
		result.ExtractedBlobEvents,
		result.ReclaimedBytes,
	)
	if err != nil {
		return fmt.Errorf("complete event maintenance: %w", err)
	}
	return nil
}

func (s *Store) FailEventMaintenance(ctx context.Context, maintenanceErr error) error {
	message := "event maintenance failed"
	if maintenanceErr != nil {
		message = maintenanceErr.Error()
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE event_maintenance_state SET running = 0, last_error = ? WHERE id = 1`, message)
	if err != nil {
		return fmt.Errorf("record event maintenance failure: %w", err)
	}
	return nil
}

func (s *Store) RunEventMaintenanceBatch(
	ctx context.Context,
	retainedDebugAfter *time.Time,
	limit int,
) (EventMaintenanceBatch, error) {
	if limit <= 0 {
		limit = 1000
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventMaintenanceBatch{}, fmt.Errorf("begin event maintenance batch: %w", err)
	}
	defer rollback(tx)

	result := EventMaintenanceBatch{}
	deleted, bytes, err := deleteMaintenanceEvents(ctx, tx, `
		e.type LIKE '%.delta'
		AND EXISTS (
		  SELECT 1
		  FROM events AS settled
		  WHERE settled.session_id = e.session_id
		    AND settled.seq > e.seq
		    AND settled.type = replace(e.type, '.delta', '.completed')
		)`, nil, limit)
	if err != nil {
		return EventMaintenanceBatch{}, err
	}
	result.DeletedDeltaEvents = deleted
	result.ReclaimedBytes += bytes
	if deleted == int64(limit) {
		result.More = true
		if err := tx.Commit(); err != nil {
			return EventMaintenanceBatch{}, fmt.Errorf("commit event maintenance batch: %w", err)
		}
		return result, nil
	}

	remaining := limit - int(deleted)
	if retainedDebugAfter != nil && remaining > 0 {
		deleted, bytes, err = deleteMaintenanceEvents(
			ctx,
			tx,
			debugOnlyEventPredicate+` AND e.created_at < ?`,
			[]any{formatTime(*retainedDebugAfter)},
			remaining,
		)
		if err != nil {
			return EventMaintenanceBatch{}, err
		}
		result.DeletedDebugEvents = deleted
		result.ReclaimedBytes += bytes
		remaining -= int(deleted)
		if remaining == 0 {
			result.More = true
			if err := tx.Commit(); err != nil {
				return EventMaintenanceBatch{}, fmt.Errorf("commit event maintenance batch: %w", err)
			}
			return result, nil
		}
	}

	if remaining > 0 {
		extracted, more, err := extractLegacyEventBlobs(ctx, tx, remaining)
		if err != nil {
			return EventMaintenanceBatch{}, err
		}
		result.ExtractedBlobEvents = extracted
		result.More = more
	}

	if err := tx.Commit(); err != nil {
		return EventMaintenanceBatch{}, fmt.Errorf("commit event maintenance batch: %w", err)
	}
	return result, nil
}

func deleteMaintenanceEvents(
	ctx context.Context,
	tx *sql.Tx,
	predicate string,
	args []any,
	limit int,
) (int64, int64, error) {
	query := `SELECT e.id, length(e.payload_json)
		FROM events AS e
		JOIN sessions AS s ON s.id = e.session_id
		WHERE s.status != ? AND ` + predicate + `
		ORDER BY e.created_at, e.seq
		LIMIT ?`
	queryArgs := []any{string(SessionStatusRunning)}
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, limit)
	rows, err := tx.QueryContext(ctx, query, queryArgs...)
	if err != nil {
		return 0, 0, fmt.Errorf("select event maintenance deletions: %w", err)
	}
	type candidate struct {
		id    string
		bytes int64
	}
	candidates := make([]candidate, 0, limit)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.bytes); err != nil {
			_ = rows.Close()
			return 0, 0, fmt.Errorf("scan event maintenance deletion: %w", err)
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return 0, 0, fmt.Errorf("close event maintenance deletions: %w", err)
	}
	var reclaimed int64
	for _, item := range candidates {
		if _, err := tx.ExecContext(ctx, `DELETE FROM events WHERE id = ?`, item.id); err != nil {
			return 0, 0, fmt.Errorf("delete maintenance event: %w", err)
		}
		reclaimed += item.bytes
	}
	return int64(len(candidates)), reclaimed, nil
}

func extractLegacyEventBlobs(ctx context.Context, tx *sql.Tx, limit int) (int64, bool, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT e.id, e.type, e.payload_json, e.created_at
		FROM events AS e
		JOIN sessions AS s ON s.id = e.session_id
		WHERE s.status != ?
		  AND e.type IN ('user.message.completed', 'tool.call.completed')
		  AND NOT EXISTS (SELECT 1 FROM event_blobs AS b WHERE b.event_id = e.id)
		  AND (
		    instr(e.payload_json, '"data_url":"data:') > 0
		    OR instr(e.payload_json, '"blob":"') > 0
		    OR MAX(
		      length(COALESCE(json_extract(e.payload_json, '$.output'), '')),
		      length(COALESCE(json_extract(e.payload_json, '$.aggregated_output'), '')),
		      length(COALESCE(json_extract(e.payload_json, '$.text'), '')),
		      length(COALESCE(json_extract(e.payload_json, '$.error'), '')),
		      length(COALESCE(json_extract(e.payload_json, '$.result.structuredContent.output'), ''))
		    ) > ?
		    OR EXISTS (
		      SELECT 1
		      FROM json_each(e.payload_json, '$.result.content') AS content
		      WHERE (
		        json_extract(content.value, '$.type') = 'text'
		        AND length(COALESCE(json_extract(content.value, '$.text'), '')) > ?
		      ) OR (
		        json_extract(content.value, '$.type') IN ('image', 'audio')
		        AND length(COALESCE(json_extract(content.value, '$.data'), '')) > 0
		      ) OR (
		        json_extract(content.value, '$.type') = 'resource'
		        AND length(COALESCE(json_extract(content.value, '$.resource.blob'), '')) > 0
		      )
		    )
		  )
		ORDER BY e.created_at, e.seq
		LIMIT ?`,
		string(SessionStatusRunning),
		toolOutputBlobThreshold,
		toolOutputBlobThreshold,
		limit,
	)
	if err != nil {
		return 0, false, fmt.Errorf("select legacy event blobs: %w", err)
	}
	type candidate struct {
		id        string
		eventType string
		payload   json.RawMessage
		createdAt time.Time
	}
	candidates := make([]candidate, 0, limit)
	for rows.Next() {
		var item candidate
		var payload string
		var createdAt string
		if err := rows.Scan(&item.id, &item.eventType, &payload, &createdAt); err != nil {
			_ = rows.Close()
			return 0, false, fmt.Errorf("scan legacy event blob: %w", err)
		}
		parsed, err := parseTime(createdAt)
		if err != nil {
			_ = rows.Close()
			return 0, false, fmt.Errorf("parse legacy event blob time: %w", err)
		}
		item.payload = json.RawMessage(payload)
		item.createdAt = parsed
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return 0, false, fmt.Errorf("close legacy event blobs: %w", err)
	}

	var extracted int64
	for _, item := range candidates {
		payload, blobs, err := prepareEventPayload(item.eventType, item.payload)
		if err != nil {
			return 0, false, err
		}
		if len(blobs) == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE events SET payload_json = ? WHERE id = ?`, string(payload), item.id); err != nil {
			return 0, false, fmt.Errorf("compact legacy event payload: %w", err)
		}
		for index := range blobs {
			blobs[index].EventID = item.id
			blobs[index].CreatedAt = item.createdAt
			if err := insertEventBlob(ctx, tx, blobs[index]); err != nil {
				return 0, false, err
			}
		}
		extracted++
	}
	return extracted, extracted > 0 && len(candidates) == limit, nil
}
