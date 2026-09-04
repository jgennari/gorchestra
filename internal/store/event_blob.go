package store

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode/utf8"
)

const (
	toolOutputBlobThreshold = 16 * 1024
	toolOutputPreviewBytes  = 4 * 1024
)

func (s *Store) GetEventBlob(ctx context.Context, sessionID string, seq int64, kind string, itemIndex int) (EventBlob, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT blobs.event_id, blobs.kind, blobs.item_index, blobs.name, blobs.media_type,
		        blobs.encoding, blobs.original_bytes, blobs.data, blobs.created_at
		 FROM event_blobs AS blobs
		 JOIN events ON events.id = blobs.event_id
		 WHERE events.session_id = ? AND events.seq = ? AND blobs.kind = ? AND blobs.item_index = ?`,
		sessionID,
		seq,
		kind,
		itemIndex,
	)
	var blob EventBlob
	var createdAt string
	if err := row.Scan(
		&blob.EventID,
		&blob.Kind,
		&blob.ItemIndex,
		&blob.Name,
		&blob.MediaType,
		&blob.Encoding,
		&blob.OriginalBytes,
		&blob.Data,
		&createdAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EventBlob{}, ErrNotFound
		}
		return EventBlob{}, fmt.Errorf("get event blob: %w", err)
	}
	parsed, err := parseTime(createdAt)
	if err != nil {
		return EventBlob{}, fmt.Errorf("parse event blob created_at: %w", err)
	}
	blob.CreatedAt = parsed
	if blob.Encoding == "gzip" {
		reader, err := gzip.NewReader(bytes.NewReader(blob.Data))
		if err != nil {
			return EventBlob{}, fmt.Errorf("open compressed event blob: %w", err)
		}
		decoded, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil {
			return EventBlob{}, fmt.Errorf("read compressed event blob: %w", readErr)
		}
		if closeErr != nil {
			return EventBlob{}, fmt.Errorf("close compressed event blob: %w", closeErr)
		}
		blob.Data = decoded
		blob.Encoding = "identity"
	}
	return blob, nil
}

func prepareEventPayload(eventType string, payload json.RawMessage) (json.RawMessage, []EventBlob, error) {
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		return nil, nil, fmt.Errorf("decode event payload for storage: %w", err)
	}

	blobs := make([]EventBlob, 0)
	if eventType == "user.message.completed" {
		blobs = append(blobs, extractAttachmentBlobs(value)...)
	}
	if eventType == "tool.call.completed" {
		blobs = append(blobs, extractToolContentBlobs(value)...)
		if output := eventToolOutput(value); len(output) > toolOutputBlobThreshold {
			blobs = append(blobs, compressedEventBlob("tool-output", 0, "tool-output.txt", "text/plain; charset=utf-8", []byte(output)))
			truncateToolOutput(value)
			value["_gorchestra_tool_output"] = map[string]any{
				"truncated":      true,
				"original_bytes": len(output),
			}
		}
	}

	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, nil, fmt.Errorf("encode event payload for storage: %w", err)
	}
	return encoded, blobs, nil
}

func extractAttachmentBlobs(payload map[string]any) []EventBlob {
	attachments, ok := payload["attachments"].([]any)
	if !ok {
		return nil
	}
	blobs := make([]EventBlob, 0)
	for index, raw := range attachments {
		attachment, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		dataURL, _ := attachment["data_url"].(string)
		data, mediaType, ok := decodeDataURL(dataURL)
		if !ok {
			continue
		}
		if declared, _ := attachment["media_type"].(string); strings.TrimSpace(declared) != "" {
			mediaType = strings.TrimSpace(declared)
		}
		name, _ := attachment["name"].(string)
		blobs = append(blobs, compressedEventBlob("attachment", index, name, mediaType, data))
		attachment["data_url"] = ""
		attachment["_gorchestra_blob"] = true
	}
	return blobs
}

func extractToolContentBlobs(payload map[string]any) []EventBlob {
	result, ok := payload["result"].(map[string]any)
	if !ok {
		return nil
	}
	content, ok := result["content"].([]any)
	if !ok {
		return nil
	}
	blobs := make([]EventBlob, 0)
	for index, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := block["type"].(string)
		switch kind {
		case "image", "audio":
			encoded, _ := block["data"].(string)
			mediaType := firstString(block, "mimeType", "mime_type")
			data, ok := decodeBase64Content(encoded, mediaType)
			if !ok {
				continue
			}
			blobs = append(blobs, compressedEventBlob("tool-content", index, "tool-"+kind, mediaType, data))
			block["data"] = ""
			block["_gorchestra_blob"] = true
		case "resource":
			resource, ok := block["resource"].(map[string]any)
			if !ok {
				continue
			}
			encoded, _ := resource["blob"].(string)
			mediaType := firstString(resource, "mimeType", "mime_type")
			if mediaType == "" {
				mediaType = "application/octet-stream"
			}
			data, ok := decodeBase64Content(encoded, mediaType)
			if !ok {
				continue
			}
			name := path.Base(strings.Split(firstString(resource, "uri"), "?")[0])
			if name == "" || name == "." || name == "/" {
				name = "tool-resource"
			}
			blobs = append(blobs, compressedEventBlob("tool-content", index, name, mediaType, data))
			resource["blob"] = ""
			resource["_gorchestra_blob"] = true
		}
	}
	return blobs
}

func eventToolOutput(payload map[string]any) string {
	for _, key := range []string{"output", "aggregated_output", "text", "error"} {
		if value, ok := payload[key].(string); ok && value != "" {
			return value
		}
	}
	result, ok := payload["result"].(map[string]any)
	if !ok {
		return ""
	}
	if structured, ok := result["structuredContent"].(map[string]any); ok {
		if output, ok := structured["output"].(string); ok && output != "" {
			return output
		}
	}
	if content, ok := result["content"].([]any); ok {
		parts := make([]string, 0, len(content))
		for _, raw := range content {
			block, _ := raw.(map[string]any)
			if text, ok := block["text"].(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func truncateToolOutput(payload map[string]any) {
	for _, key := range []string{"output", "aggregated_output", "text", "error"} {
		if value, ok := payload[key].(string); ok && len(value) > toolOutputPreviewBytes {
			payload[key] = utf8Prefix(value, toolOutputPreviewBytes) + "\n… output truncated; load full output"
		}
	}
	result, _ := payload["result"].(map[string]any)
	if result == nil {
		return
	}
	if structured, ok := result["structuredContent"].(map[string]any); ok {
		if output, ok := structured["output"].(string); ok && len(output) > toolOutputPreviewBytes {
			structured["output"] = utf8Prefix(output, toolOutputPreviewBytes) + "\n… output truncated; load full output"
		}
	}
	if content, ok := result["content"].([]any); ok {
		for _, raw := range content {
			block, _ := raw.(map[string]any)
			if text, ok := block["text"].(string); ok && len(text) > toolOutputPreviewBytes {
				block["text"] = utf8Prefix(text, toolOutputPreviewBytes) + "\n… output truncated; load full output"
			}
		}
	}
}

func compressedEventBlob(kind string, itemIndex int, name string, mediaType string, data []byte) EventBlob {
	copyOfData := append([]byte(nil), data...)
	encoding := "identity"
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, writeErr := writer.Write(data)
	closeErr := writer.Close()
	if writeErr == nil && closeErr == nil && compressed.Len() < len(data) {
		copyOfData = append([]byte(nil), compressed.Bytes()...)
		encoding = "gzip"
	}
	return EventBlob{
		Kind:          kind,
		ItemIndex:     itemIndex,
		Name:          name,
		MediaType:     mediaType,
		Encoding:      encoding,
		OriginalBytes: int64(len(data)),
		Data:          copyOfData,
	}
}

func decodeDataURL(value string) ([]byte, string, bool) {
	header, encoded, ok := strings.Cut(strings.TrimSpace(value), ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(header, ";base64") {
		return nil, "", false
	}
	mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	return data, mediaType, err == nil
}

func decodeBase64Content(value string, mediaType string) ([]byte, bool) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "data:") {
		data, encodedMediaType, ok := decodeDataURL(value)
		return data, ok && (mediaType == "" || mediaType == encodedMediaType)
	}
	data, err := base64.StdEncoding.DecodeString(value)
	return data, err == nil
}

func firstString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := value[key].(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func utf8Prefix(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	for limit > 0 && !utf8.ValidString(value[:limit]) {
		limit--
	}
	return value[:limit]
}
