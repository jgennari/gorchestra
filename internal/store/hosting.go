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

const hostRuntimeColumns = `session_id, route_slug, workspace_path, config_path, recipe_name,
	recipe_hash, recipe_snapshot, status, services_json, started_at, stopped_at,
	last_error, created_at, updated_at`

// SaveHostRuntime inserts or replaces the durable snapshot for a session. Once
// inserted, RouteSlug is deliberately immutable so a preview URL remains stable
// across recipe, title, and workspace changes.
func (s *Store) SaveHostRuntime(ctx context.Context, params SaveHostRuntimeParams) (HostRuntime, error) {
	params.SessionID = strings.TrimSpace(params.SessionID)
	params.RouteSlug = strings.TrimSpace(params.RouteSlug)
	params.WorkspacePath = strings.TrimSpace(params.WorkspacePath)
	params.ConfigPath = strings.TrimSpace(params.ConfigPath)
	params.RecipeName = strings.TrimSpace(params.RecipeName)
	params.RecipeHash = strings.TrimSpace(params.RecipeHash)
	if params.SessionID == "" {
		return HostRuntime{}, fmt.Errorf("%w: session_id is required", ErrInvalidArgument)
	}
	if params.RouteSlug == "" {
		return HostRuntime{}, fmt.Errorf("%w: route_slug is required", ErrInvalidArgument)
	}
	if params.WorkspacePath == "" {
		return HostRuntime{}, fmt.Errorf("%w: workspace_path is required", ErrInvalidArgument)
	}
	if params.ConfigPath == "" {
		return HostRuntime{}, fmt.Errorf("%w: config_path is required", ErrInvalidArgument)
	}
	if params.RecipeName == "" {
		return HostRuntime{}, fmt.Errorf("%w: recipe_name is required", ErrInvalidArgument)
	}
	if params.RecipeHash == "" {
		return HostRuntime{}, fmt.Errorf("%w: recipe_hash is required", ErrInvalidArgument)
	}
	if !isValidHostRuntimeStatus(params.Status) {
		return HostRuntime{}, fmt.Errorf("%w: unsupported host runtime status %q", ErrInvalidArgument, params.Status)
	}
	services := append([]HostServiceSnapshot(nil), params.Services...)
	if services == nil {
		services = []HostServiceSnapshot{}
	}
	for index := range services {
		services[index].Name = strings.TrimSpace(services[index].Name)
		if services[index].Name == "" {
			return HostRuntime{}, fmt.Errorf("%w: services[%d].name is required", ErrInvalidArgument, index)
		}
		if services[index].Port < 0 || services[index].Port > 65535 {
			return HostRuntime{}, fmt.Errorf("%w: services[%d].port must be between 0 and 65535", ErrInvalidArgument, index)
		}
		if services[index].PID < 0 {
			return HostRuntime{}, fmt.Errorf("%w: services[%d].pid must not be negative", ErrInvalidArgument, index)
		}
		if !isValidHostServiceStatus(services[index].Status) {
			return HostRuntime{}, fmt.Errorf("%w: unsupported host service status %q", ErrInvalidArgument, services[index].Status)
		}
	}
	servicesJSON, err := json.Marshal(services)
	if err != nil {
		return HostRuntime{}, fmt.Errorf("encode host services: %w", err)
	}

	now := s.now()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO host_runtimes (
			session_id, route_slug, workspace_path, config_path, recipe_name,
			recipe_hash, recipe_snapshot, status, services_json, started_at,
			stopped_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			workspace_path = excluded.workspace_path,
			config_path = excluded.config_path,
			recipe_name = excluded.recipe_name,
			recipe_hash = excluded.recipe_hash,
			recipe_snapshot = excluded.recipe_snapshot,
			status = excluded.status,
			services_json = excluded.services_json,
			started_at = excluded.started_at,
			stopped_at = excluded.stopped_at,
			last_error = excluded.last_error,
			updated_at = excluded.updated_at`,
		params.SessionID,
		params.RouteSlug,
		params.WorkspacePath,
		params.ConfigPath,
		params.RecipeName,
		params.RecipeHash,
		append([]byte(nil), params.RecipeSnapshot...),
		string(params.Status),
		string(servicesJSON),
		nullableTime(params.StartedAt),
		nullableTime(params.StoppedAt),
		params.LastError,
		formatTime(now),
		formatTime(now),
	)
	if err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY constraint failed") {
			return HostRuntime{}, fmt.Errorf("%w: session %s", ErrNotFound, params.SessionID)
		}
		return HostRuntime{}, fmt.Errorf("save host runtime: %w", err)
	}
	return s.GetHostRuntime(ctx, params.SessionID)
}

func (s *Store) GetHostRuntime(ctx context.Context, sessionID string) (HostRuntime, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return HostRuntime{}, fmt.Errorf("%w: session_id is required", ErrInvalidArgument)
	}
	runtime, err := scanHostRuntime(s.db.QueryRowContext(
		ctx,
		`SELECT `+hostRuntimeColumns+` FROM host_runtimes WHERE session_id = ?`,
		sessionID,
	))
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrNotFound) {
		return HostRuntime{}, fmt.Errorf("%w: host runtime for session %s", ErrNotFound, sessionID)
	}
	return runtime, err
}

// ListHostRuntimes returns all persisted runtime snapshots, including stopped
// previews, so the manager can restore stable routes after boot.
func (s *Store) ListHostRuntimes(ctx context.Context) ([]HostRuntime, error) {
	return s.listHostRuntimes(ctx, "")
}

func (s *Store) ListActiveHostRuntimes(ctx context.Context) ([]HostRuntime, error) {
	return s.listHostRuntimes(ctx, `WHERE status IN ('starting', 'running', 'stopping')`)
}

func (s *Store) listHostRuntimes(ctx context.Context, where string) ([]HostRuntime, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT `+hostRuntimeColumns+` FROM host_runtimes `+where+` ORDER BY updated_at DESC, session_id ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list host runtimes: %w", err)
	}
	defer rows.Close()

	runtimes := make([]HostRuntime, 0)
	for rows.Next() {
		runtime, err := scanHostRuntime(rows)
		if err != nil {
			return nil, err
		}
		runtimes = append(runtimes, runtime)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list host runtimes rows: %w", err)
	}
	return runtimes, nil
}

// RecoverActiveHostRuntimes atomically turns snapshots left active by a prior
// Gorchestra process into stopped snapshots. It never starts a process.
func (s *Store) RecoverActiveHostRuntimes(ctx context.Context, reason string) ([]HostRuntime, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin host runtime recovery: %w", err)
	}
	defer rollback(tx)

	rows, err := tx.QueryContext(ctx, `
		SELECT `+hostRuntimeColumns+`
		FROM host_runtimes
		WHERE status IN ('starting', 'running', 'stopping')
		ORDER BY updated_at DESC, session_id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list active host runtimes for recovery: %w", err)
	}
	active := make([]HostRuntime, 0)
	for rows.Next() {
		runtime, scanErr := scanHostRuntime(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		active = append(active, runtime)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close active host runtimes: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list active host runtimes rows: %w", err)
	}

	now := s.now()
	for index := range active {
		active[index].Status = HostRuntimeStatusStopped
		active[index].StoppedAt = timePointer(now)
		active[index].UpdatedAt = now
		if strings.TrimSpace(reason) != "" {
			active[index].LastError = reason
		}
		for serviceIndex := range active[index].Services {
			service := &active[index].Services[serviceIndex]
			service.PID = 0
			if isActiveHostServiceStatus(service.Status) {
				service.Status = HostServiceStatusStopped
				service.StoppedAt = timePointer(now)
				if service.Error == "" && strings.TrimSpace(reason) != "" {
					service.Error = reason
				}
			}
		}
		servicesJSON, marshalErr := json.Marshal(active[index].Services)
		if marshalErr != nil {
			return nil, fmt.Errorf("encode recovered host services: %w", marshalErr)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE host_runtimes
			SET status = ?, services_json = ?, stopped_at = ?, last_error = ?, updated_at = ?
			WHERE session_id = ?`,
			string(active[index].Status),
			string(servicesJSON),
			formatTime(now),
			active[index].LastError,
			formatTime(now),
			active[index].SessionID,
		); err != nil {
			return nil, fmt.Errorf("recover host runtime %s: %w", active[index].SessionID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit host runtime recovery: %w", err)
	}
	return active, nil
}

func scanHostRuntime(row rowScanner) (HostRuntime, error) {
	var runtime HostRuntime
	var recipeSnapshot []byte
	var status string
	var servicesJSON string
	var startedAt sql.NullString
	var stoppedAt sql.NullString
	var createdAt string
	var updatedAt string
	if err := row.Scan(
		&runtime.SessionID,
		&runtime.RouteSlug,
		&runtime.WorkspacePath,
		&runtime.ConfigPath,
		&runtime.RecipeName,
		&runtime.RecipeHash,
		&recipeSnapshot,
		&status,
		&servicesJSON,
		&startedAt,
		&stoppedAt,
		&runtime.LastError,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return HostRuntime{}, ErrNotFound
		}
		return HostRuntime{}, fmt.Errorf("scan host runtime: %w", err)
	}
	runtime.Status = HostRuntimeStatus(status)
	if !isValidHostRuntimeStatus(runtime.Status) {
		return HostRuntime{}, fmt.Errorf("scan host runtime: unsupported status %q", status)
	}
	if err := json.Unmarshal([]byte(servicesJSON), &runtime.Services); err != nil {
		return HostRuntime{}, fmt.Errorf("scan host runtime services: %w", err)
	}
	if runtime.Services == nil {
		runtime.Services = []HostServiceSnapshot{}
	}
	for _, service := range runtime.Services {
		if !isValidHostServiceStatus(service.Status) {
			return HostRuntime{}, fmt.Errorf("scan host runtime: service %s has unsupported status %q", service.Name, service.Status)
		}
	}
	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return HostRuntime{}, fmt.Errorf("parse host runtime created_at: %w", err)
	}
	parsedUpdatedAt, err := parseTime(updatedAt)
	if err != nil {
		return HostRuntime{}, fmt.Errorf("parse host runtime updated_at: %w", err)
	}
	runtime.RecipeSnapshot = append([]byte(nil), recipeSnapshot...)
	runtime.CreatedAt = parsedCreatedAt
	runtime.UpdatedAt = parsedUpdatedAt
	if startedAt.Valid {
		parsed, err := parseTime(startedAt.String)
		if err != nil {
			return HostRuntime{}, fmt.Errorf("parse host runtime started_at: %w", err)
		}
		runtime.StartedAt = &parsed
	}
	if stoppedAt.Valid {
		parsed, err := parseTime(stoppedAt.String)
		if err != nil {
			return HostRuntime{}, fmt.Errorf("parse host runtime stopped_at: %w", err)
		}
		runtime.StoppedAt = &parsed
	}
	return runtime, nil
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func timePointer(value time.Time) *time.Time {
	copy := value
	return &copy
}

func isValidHostRuntimeStatus(status HostRuntimeStatus) bool {
	switch status {
	case HostRuntimeStatusStopped, HostRuntimeStatusStarting, HostRuntimeStatusRunning, HostRuntimeStatusStopping, HostRuntimeStatusFailed:
		return true
	default:
		return false
	}
}

func isValidHostServiceStatus(status HostServiceStatus) bool {
	switch status {
	case HostServiceStatusStopped, HostServiceStatusStarting, HostServiceStatusRunning, HostServiceStatusStopping, HostServiceStatusFailed:
		return true
	default:
		return false
	}
}

func isActiveHostServiceStatus(status HostServiceStatus) bool {
	return status == HostServiceStatusStarting || status == HostServiceStatusRunning || status == HostServiceStatusStopping
}
