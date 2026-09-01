package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	searchProjectionVersion = 1
	maxSearchDocumentBytes  = 256 * 1024
)

var searchableEventTypes = map[string]bool{
	"user.message.completed":  true,
	"agent.message.completed": true,
	"agent.plan.completed":    true,
	"tool.call.started":       true,
	"tool.call.completed":     true,
}

func (s *Store) syncSearchProjection(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, `SELECT version FROM search_projection_state WHERE id = 1`).Scan(&version); err != nil {
		return fmt.Errorf("load search projection version: %w", err)
	}
	if version >= searchProjectionVersion {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin search projection sync: %w", err)
	}
	defer rollback(tx)

	if _, err := tx.ExecContext(ctx, `DELETE FROM search_documents WHERE kind != 'session'`); err != nil {
		return fmt.Errorf("clear search event projection: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, session_id, seq, type, role, status, payload_json, created_at
		FROM events
		WHERE type IN ('user.message.completed', 'agent.message.completed', 'agent.plan.completed', 'tool.call.started', 'tool.call.completed')
		ORDER BY session_id, seq`)
	if err != nil {
		return fmt.Errorf("load search projection events: %w", err)
	}
	events := make([]Event, 0)
	for rows.Next() {
		event, scanErr := scanEvent(rows)
		if scanErr != nil {
			_ = rows.Close()
			return scanErr
		}
		events = append(events, event)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close search projection events: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("load search projection event rows: %w", err)
	}
	for _, event := range events {
		if err := projectSearchEvent(ctx, tx, event); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE search_projection_state SET version = ? WHERE id = 1`, searchProjectionVersion); err != nil {
		return fmt.Errorf("advance search projection version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit search projection sync: %w", err)
	}
	return nil
}

func projectSearchEvent(ctx context.Context, tx *sql.Tx, event Event) error {
	document, ok := searchDocumentFromEvent(event)
	if !ok {
		return nil
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO search_documents(key, kind, session_id, event_seq, title, content, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			kind = excluded.kind,
			event_seq = excluded.event_seq,
			title = CASE WHEN excluded.title = 'Tool call' THEN search_documents.title ELSE excluded.title END,
			content = substr(trim(search_documents.content || char(10) || excluded.content), 1, ?),
			created_at = excluded.created_at`,
		document.Key,
		document.Kind,
		event.SessionID,
		event.Seq,
		document.Title,
		document.Content,
		formatTime(event.CreatedAt),
		maxSearchDocumentBytes,
	)
	if err != nil {
		return fmt.Errorf("project search event: %w", err)
	}
	return nil
}

type searchDocument struct {
	Key     string
	Kind    string
	Title   string
	Content string
}

func searchDocumentFromEvent(event Event) (searchDocument, bool) {
	if !searchableEventTypes[event.Type] {
		return searchDocument{}, false
	}
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return searchDocument{}, false
	}

	switch event.Type {
	case "user.message.completed":
		content := searchPayloadString(payload, "text")
		return searchDocument{Key: "event:" + event.ID, Kind: "user_message", Title: "User message", Content: content}, strings.TrimSpace(content) != ""
	case "agent.message.completed":
		content := searchPayloadString(payload, "text")
		return searchDocument{Key: "event:" + event.ID, Kind: "agent_message", Title: "Agent response", Content: content}, strings.TrimSpace(content) != ""
	case "agent.plan.completed":
		content := searchPayloadString(payload, "text")
		return searchDocument{Key: "event:" + event.ID, Kind: "agent_message", Title: "Agent plan", Content: content}, strings.TrimSpace(content) != ""
	case "tool.call.started", "tool.call.completed":
		groupID := firstSearchPayloadString(payload, "tool_call_id", "item_id", "call_id", "process_id", "tool_id", "id")
		if groupID == "" {
			groupID = event.ID
		}
		title := firstSearchPayloadString(payload, "title", "name", "tool", "kind", "command")
		if title == "" {
			title = "Tool call"
		}
		content := searchableToolPayload(payload)
		return searchDocument{
			Key:     "tool:" + event.SessionID + ":" + groupID,
			Kind:    "tool_call",
			Title:   truncateSearchText(title, 512),
			Content: content,
		}, strings.TrimSpace(content) != "" || title != "Tool call"
	default:
		return searchDocument{}, false
	}
}

func searchableToolPayload(payload map[string]any) string {
	keys := []string{
		"tool", "name", "title", "kind", "command", "description", "path", "file_path", "query", "url",
		"input", "raw_input", "arguments", "output", "aggregated_output", "error", "raw_output", "result",
	}
	parts := make([]string, 0, len(keys))
	remaining := maxSearchDocumentBytes
	for _, key := range keys {
		value, exists := payload[key]
		if !exists || remaining <= 0 {
			continue
		}
		text := searchableValueText(value, remaining)
		if text == "" {
			continue
		}
		parts = append(parts, text)
		remaining -= len(text)
	}
	return strings.Join(parts, "\n")
}

func searchableValueText(value any, limit int) string {
	if limit <= 0 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, "data:") {
			return ""
		}
		return truncateSearchText(typed, limit)
	case map[string]any:
		parts := make([]string, 0, len(typed))
		for key, child := range typed {
			lowerKey := strings.ToLower(key)
			if lowerKey == "data" || lowerKey == "data_url" || lowerKey == "blob" || strings.Contains(lowerKey, "base64") {
				continue
			}
			text := searchableValueText(child, limit)
			if text != "" {
				parts = append(parts, text)
				limit -= len(text)
			}
			if limit <= 0 {
				break
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		parts := make([]string, 0, len(typed))
		for _, child := range typed {
			text := searchableValueText(child, limit)
			if text != "" {
				parts = append(parts, text)
				limit -= len(text)
			}
			if limit <= 0 {
				break
			}
		}
		return strings.Join(parts, "\n")
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return truncateSearchText(string(encoded), limit)
	}
}

func truncateSearchText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len(value) <= limit {
		return value
	}
	limit = min(limit, len(value))
	for limit > 0 && !utf8.ValidString(value[:limit]) {
		limit--
	}
	return strings.TrimSpace(value[:limit])
}

func searchPayloadString(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func firstSearchPayloadString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(searchPayloadString(payload, key)); value != "" {
			return value
		}
	}
	return ""
}

func (s *Store) Search(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	match := searchFTSQuery(query)
	if match == "" {
		return []SearchResult{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.kind, d.session_id, s.title, s.workspace_path, COALESCE(d.event_seq, 0),
		       d.title, snippet(search_documents_fts, 1, '', '', ' … ', 24), d.created_at,
		       s.archived_at, bm25(search_documents_fts, 7.0, 1.0)
		FROM search_documents_fts
		JOIN search_documents d ON d.rowid = search_documents_fts.rowid
		JOIN sessions s ON s.id = d.session_id
		WHERE search_documents_fts MATCH ?
		ORDER BY bm25(search_documents_fts, 7.0, 1.0), d.created_at DESC
		LIMIT ?`, match, limit)
	if err != nil {
		return nil, fmt.Errorf("search documents: %w", err)
	}
	defer rows.Close()
	results := make([]SearchResult, 0)
	for rows.Next() {
		var result SearchResult
		var createdAt string
		var archivedAt sql.NullString
		if err := rows.Scan(
			&result.Kind, &result.SessionID, &result.SessionTitle, &result.WorkspacePath, &result.EventSeq,
			&result.Title, &result.Snippet, &createdAt, &archivedAt, &result.Rank,
		); err != nil {
			return nil, fmt.Errorf("scan search result: %w", err)
		}
		parsedCreatedAt, err := parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse search result time: %w", err)
		}
		result.CreatedAt = parsedCreatedAt
		if archivedAt.Valid {
			parsedArchivedAt, err := parseTime(archivedAt.String)
			if err != nil {
				return nil, fmt.Errorf("parse search result archive time: %w", err)
			}
			result.ArchivedAt = &parsedArchivedAt
		}
		if result.Snippet == "" {
			result.Snippet = result.Title
		}
		results = append(results, result)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("search document rows: %w", err)
	}
	return results, nil
}

func searchFTSQuery(query string) string {
	fields := strings.FieldsFunc(strings.ToLower(strings.TrimSpace(query)), func(r rune) bool {
		return !(unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-')
	})
	terms := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.Trim(field, "_-")
		if field == "" {
			continue
		}
		terms = append(terms, `"`+strings.ReplaceAll(field, `"`, `""`)+`"*`)
	}
	return strings.Join(terms, " AND ")
}
