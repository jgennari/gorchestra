package opencode

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
)

type terminalKind int

const (
	terminalNone terminalKind = iota
	terminalCompleted
	terminalFailed
	terminalCancelled
)

type normalizedEvent struct {
	Event    agents.AgentEvent
	Terminal terminalKind
}

type normalizer struct {
	terminal      bool
	terminalKind  terminalKind
	terminalError string
}

func newNormalizer() *normalizer {
	return &normalizer{}
}

func (n *normalizer) normalize(method string, params json.RawMessage) []normalizedEvent {
	if n.terminal {
		return nil
	}
	if method != "session/update" {
		return []normalizedEvent{unknown("provider.opencode.event", method, params)}
	}

	update := mapAt(params, "update")
	updateType := stringFromMap(update, "sessionUpdate")
	if updateType == "" {
		return []normalizedEvent{unknown("provider.opencode.event", method, params)}
	}

	payload := basePayload(updateType, params)
	payload["raw_update"] = rawOrNil(mustMarshal(update))

	switch updateType {
	case "agent_message_chunk":
		payload["text"] = contentText(update["content"])
		copyMessageID(payload, update)
		return []normalizedEvent{{Event: event("agent.message.delta", "assistant", "delta", payload)}}
	case "agent_thought_chunk", "thought_message_chunk":
		payload["text"] = contentText(update["content"])
		copyMessageID(payload, update)
		return []normalizedEvent{{Event: event("agent.thinking.delta", "assistant", "delta", payload)}}
	case "user_message_chunk":
		payload["text"] = contentText(update["content"])
		copyMessageID(payload, update)
		return []normalizedEvent{{Event: event("provider.opencode.event", "system", "completed", payload)}}
	case "plan":
		payload["entries"] = update["entries"]
		payload["text"] = planText(update["entries"])
		return []normalizedEvent{{Event: event("agent.plan.delta", "assistant", "delta", payload)}}
	case "tool_call":
		copyToolFields(payload, update)
		return []normalizedEvent{{Event: event("tool.call.started", "assistant", "started", payload)}}
	case "tool_call_update":
		copyToolFields(payload, update)
		copyToolContent(payload, update["content"])
		if paths := toolContentPaths(update["content"]); len(paths) > 0 {
			payload["paths"] = paths
		}
		return []normalizedEvent{{Event: event("tool.call.completed", "assistant", toolStatus(update), payload)}}
	case "usage_update", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update":
		return []normalizedEvent{{Event: event("provider.opencode.event", "system", "completed", payload)}}
	default:
		return []normalizedEvent{unknown("provider.opencode.event", updateType, params)}
	}
}

func (n *normalizer) completed(stopReason string, result json.RawMessage) normalizedEvent {
	payload := map[string]any{
		"provider":            "opencode",
		"provider_event_type": "session/prompt",
		"stop_reason":         stopReason,
	}
	if len(result) > 0 {
		payload["raw_result"] = rawOrNil(result)
	}
	switch stopReason {
	case "cancelled":
		n.markTerminal(terminalCancelled, "opencode run cancelled")
		return normalizedEvent{Event: event("agent.run.cancelled", "assistant", "cancelled", payload), Terminal: terminalCancelled}
	default:
		n.markTerminal(terminalCompleted, "")
		return normalizedEvent{Event: event("agent.run.completed", "assistant", "completed", payload), Terminal: terminalCompleted}
	}
}

func (n *normalizer) failed(message string, raw json.RawMessage) normalizedEvent {
	payload := map[string]any{
		"provider":            "opencode",
		"provider_event_type": "session/prompt",
		"error":               message,
	}
	if len(raw) > 0 {
		payload["raw"] = rawOrNil(raw)
	}
	n.markTerminal(terminalFailed, message)
	return normalizedEvent{Event: event("agent.run.failed", "assistant", "failed", payload), Terminal: terminalFailed}
}

func (n *normalizer) markTerminal(kind terminalKind, message string) {
	if n.terminal {
		return
	}
	n.terminal = true
	n.terminalKind = kind
	n.terminalError = message
}

func event(eventType string, role string, status string, payload map[string]any) agents.AgentEvent {
	return agents.AgentEvent{
		Type:    eventType,
		Role:    role,
		Status:  status,
		Payload: payload,
	}
}

func unknown(eventType string, providerEventType string, raw json.RawMessage) normalizedEvent {
	return normalizedEvent{Event: event(eventType, "system", "completed", map[string]any{
		"provider":            "opencode",
		"provider_event_type": providerEventType,
		"raw":                 rawOrNil(raw),
	})}
}

func basePayload(updateType string, params json.RawMessage) map[string]any {
	payload := map[string]any{
		"provider":            "opencode",
		"provider_event_type": updateType,
	}
	if sessionID := stringAt(params, "sessionId"); sessionID != "" {
		payload["provider_session_id"] = sessionID
	}
	return payload
}

func copyMessageID(payload map[string]any, update map[string]any) {
	if messageID := stringFromMap(update, "messageId"); messageID != "" {
		payload["message_id"] = messageID
	}
}

func copyToolFields(payload map[string]any, update map[string]any) {
	for _, pair := range []struct {
		payloadKey string
		updateKey  string
	}{
		{"tool_call_id", "toolCallId"},
		{"title", "title"},
		{"kind", "kind"},
		{"tool_status", "status"},
	} {
		if value := stringFromMap(update, pair.updateKey); value != "" {
			payload[pair.payloadKey] = value
		}
	}
	if rawInput := update["rawInput"]; rawInput != nil {
		payload["raw_input"] = rawInput
	}
	if rawOutput := update["rawOutput"]; rawOutput != nil {
		payload["raw_output"] = rawOutput
	}
	if locations := update["locations"]; locations != nil {
		payload["locations"] = locations
	}
}

func copyToolContent(payload map[string]any, raw any) {
	content, ok := raw.([]any)
	if !ok || len(content) == 0 {
		return
	}
	payload["content"] = content
	var text strings.Builder
	for _, item := range content {
		itemMap, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch stringFromMap(itemMap, "type") {
		case "content":
			if chunk := contentText(itemMap["content"]); chunk != "" {
				if text.Len() > 0 {
					text.WriteByte('\n')
				}
				text.WriteString(chunk)
			}
		case "diff":
			if path := stringFromMap(itemMap, "path"); path != "" {
				if text.Len() > 0 {
					text.WriteByte('\n')
				}
				text.WriteString(path)
			}
		}
	}
	if text.Len() > 0 {
		payload["text"] = text.String()
	}
}

func toolContentPaths(raw any) []string {
	content, ok := raw.([]any)
	if !ok {
		return nil
	}
	seen := make(map[string]bool)
	var paths []string
	for _, item := range content {
		itemMap, ok := item.(map[string]any)
		if !ok || stringFromMap(itemMap, "type") != "diff" {
			continue
		}
		path := stringFromMap(itemMap, "path")
		if path != "" && !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	return paths
}

func toolStatus(update map[string]any) string {
	switch stringFromMap(update, "status") {
	case "failed":
		return "failed"
	case "cancelled":
		return "cancelled"
	default:
		return "completed"
	}
}

func contentText(raw any) string {
	content, ok := raw.(map[string]any)
	if !ok || stringFromMap(content, "type") != "text" {
		return ""
	}
	value, _ := content["text"].(string)
	return value
}

func planText(raw any) string {
	entries, ok := raw.([]any)
	if !ok {
		return ""
	}
	lines := make([]string, 0, len(entries))
	for _, item := range entries {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content := stringFromMap(entry, "content")
		status := stringFromMap(entry, "status")
		if content == "" {
			continue
		}
		if status != "" {
			content = fmt.Sprintf("%s: %s", status, content)
		}
		lines = append(lines, content)
	}
	return strings.Join(lines, "\n")
}

func mapAt(raw json.RawMessage, path ...string) map[string]any {
	var current any
	if err := json.Unmarshal(raw, &current); err != nil {
		return nil
	}
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	object, _ := current.(map[string]any)
	return object
}

func stringAt(raw json.RawMessage, path ...string) string {
	var current any
	if err := json.Unmarshal(raw, &current); err != nil {
		return ""
	}
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	value, _ := current.(string)
	return strings.TrimSpace(value)
}

func stringFromMap(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func rawOrNil(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return json.RawMessage(raw)
}

func mustMarshal(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}
