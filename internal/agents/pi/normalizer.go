package pi

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

func (n *normalizer) normalize(message *rpcMessage) []normalizedEvent {
	if message == nil || n.terminal {
		return nil
	}

	eventType := stringFromRaw(message.Raw, "type")
	payload := basePayload(eventType, message.Raw)
	payload["raw"] = rawOrNil(message.Raw)

	switch eventType {
	case "message_update":
		return compact(n.normalizeMessageUpdate(message.Raw, payload))
	case "message_end":
		return compact(n.normalizeMessageEnd(message.Raw, payload))
	case "tool_execution_start":
		copyToolFields(payload, message.Raw)
		return []normalizedEvent{{Event: event("tool.call.started", "assistant", "started", payload)}}
	case "tool_execution_update":
		copyToolFields(payload, message.Raw)
		copyToolResult(payload, anyAt(message.Raw, "partialResult"))
		return []normalizedEvent{{Event: event("tool.call.delta", "assistant", "delta", payload)}}
	case "tool_execution_end":
		copyToolFields(payload, message.Raw)
		copyToolResult(payload, anyAt(message.Raw, "result"))
		if boolAt(message.Raw, "isError") {
			payload["is_error"] = true
			if text := stringFromPayload(payload, "text"); text != "" {
				payload["error"] = text
			}
		}
		return []normalizedEvent{{Event: event("tool.call.completed", "assistant", toolStatus(message.Raw), payload)}}
	case "agent_end":
		n.markTerminal(terminalCompleted, "")
		return []normalizedEvent{{Event: event("agent.run.completed", "assistant", "completed", payload), Terminal: terminalCompleted}}
	case "agent_start", "turn_start", "turn_end", "message_start", "queue_update", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "extension_error", "extension_ui_request":
		return []normalizedEvent{{Event: event("provider.pi.event", "system", "completed", payload)}}
	default:
		return []normalizedEvent{unknown(eventType, message.Raw)}
	}
}

func (n *normalizer) normalizeMessageUpdate(raw json.RawMessage, payload map[string]any) normalizedEvent {
	updateType := stringAt(raw, "assistantMessageEvent", "type")
	payload["provider_event_type"] = "message_update/" + updateType
	copyMessageID(payload, raw)
	copyContentIndex(payload, raw)

	switch updateType {
	case "text_delta":
		payload["text"] = stringAt(raw, "assistantMessageEvent", "delta")
		return normalizedEvent{Event: event("agent.message.delta", "assistant", "delta", payload)}
	case "thinking_start":
		return normalizedEvent{Event: event("agent.thinking.started", "assistant", "started", payload)}
	case "thinking_delta":
		payload["text"] = stringAt(raw, "assistantMessageEvent", "delta")
		return normalizedEvent{Event: event("agent.thinking.delta", "assistant", "delta", payload)}
	case "thinking_end":
		return normalizedEvent{Event: event("agent.thinking.completed", "assistant", "completed", payload)}
	default:
		return normalizedEvent{Event: event("provider.pi.event", "system", "completed", payload)}
	}
}

func (n *normalizer) normalizeMessageEnd(raw json.RawMessage, payload map[string]any) normalizedEvent {
	copyMessageID(payload, raw)
	payload["raw_message"] = anyAt(raw, "message")
	if text := textFromMessage(anyAt(raw, "message")); text != "" {
		payload["text"] = text
	}
	if model := stringAt(raw, "message", "model"); model != "" {
		payload["model"] = model
	}
	if provider := stringAt(raw, "message", "provider"); provider != "" {
		payload["model_provider"] = provider
	}
	if usage := anyAt(raw, "message", "usage"); usage != nil {
		payload["usage"] = usage
	}
	if stopReason := stringAt(raw, "message", "stopReason"); stopReason != "" {
		payload["stop_reason"] = stopReason
	}
	return normalizedEvent{Event: event("agent.message.completed", "assistant", "completed", payload)}
}

func (n *normalizer) failed(message string, raw json.RawMessage) normalizedEvent {
	payload := map[string]any{
		"provider":            Type,
		"provider_event_type": "rpc_error",
		"error":               message,
	}
	if len(raw) > 0 {
		payload["raw"] = rawOrNil(raw)
	}
	n.markTerminal(terminalFailed, message)
	return normalizedEvent{Event: event("agent.run.failed", "assistant", "failed", payload), Terminal: terminalFailed}
}

func (n *normalizer) cancelled(raw json.RawMessage) normalizedEvent {
	payload := map[string]any{
		"provider":            Type,
		"provider_event_type": "abort",
	}
	if len(raw) > 0 {
		payload["raw"] = rawOrNil(raw)
	}
	n.markTerminal(terminalCancelled, "pi run cancelled")
	return normalizedEvent{Event: event("agent.run.cancelled", "assistant", "cancelled", payload), Terminal: terminalCancelled}
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

func unknown(providerEventType string, raw json.RawMessage) normalizedEvent {
	return normalizedEvent{Event: event("provider.pi.event", "system", "completed", map[string]any{
		"provider":            Type,
		"provider_event_type": providerEventType,
		"raw":                 rawOrNil(raw),
	})}
}

func basePayload(providerEventType string, raw json.RawMessage) map[string]any {
	payload := map[string]any{
		"provider":            Type,
		"provider_event_type": providerEventType,
	}
	return payload
}

func compact(events ...normalizedEvent) []normalizedEvent {
	compacted := make([]normalizedEvent, 0, len(events))
	for _, event := range events {
		if event.Event.Type != "" {
			compacted = append(compacted, event)
		}
	}
	return compacted
}

func copyMessageID(payload map[string]any, raw json.RawMessage) {
	if messageID := stringAt(raw, "message", "id"); messageID != "" {
		payload["message_id"] = messageID
		payload["item_id"] = messageID
		return
	}
	if messageID := stringAt(raw, "message", "entryId"); messageID != "" {
		payload["message_id"] = messageID
		payload["item_id"] = messageID
	}
}

func copyContentIndex(payload map[string]any, raw json.RawMessage) {
	index, ok := numberAt(raw, "assistantMessageEvent", "contentIndex")
	if !ok {
		return
	}
	payload["content_index"] = index
	itemID := stringFromPayload(payload, "item_id")
	if itemID == "" {
		itemID = "message"
	}
	payload["item_id"] = fmt.Sprintf("%s:%s:%d", itemID, stringAt(raw, "assistantMessageEvent", "type"), index)
}

func copyToolFields(payload map[string]any, raw json.RawMessage) {
	if toolCallID := stringFromRaw(raw, "toolCallId"); toolCallID != "" {
		payload["tool_call_id"] = toolCallID
		payload["item_id"] = toolCallID
	}
	if toolName := stringFromRaw(raw, "toolName"); toolName != "" {
		payload["name"] = toolName
		payload["tool"] = toolName
		payload["kind"] = toolName
		payload["title"] = toolName
	}
	if args := anyAt(raw, "args"); args != nil {
		payload["raw_input"] = args
		if argsMap, ok := args.(map[string]any); ok {
			if command := stringFromMap(argsMap, "command"); command != "" {
				payload["command"] = command
			}
			if path := firstStringFromMap(argsMap, "path", "file", "filePath", "file_path"); path != "" {
				payload["path"] = path
			}
		}
	}
}

func copyToolResult(payload map[string]any, raw any) {
	if raw == nil {
		return
	}
	payload["raw_output"] = raw
	if text := textFromToolResult(raw); text != "" {
		payload["text"] = text
		payload["output"] = text
		payload["aggregated_output"] = text
	}
}

func toolStatus(raw json.RawMessage) string {
	if boolAt(raw, "isError") {
		return "failed"
	}
	return "completed"
}

func textFromMessage(raw any) string {
	message, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	return textFromContent(message["content"])
}

func textFromToolResult(raw any) string {
	result, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	return textFromContent(result["content"])
}

func textFromContent(raw any) string {
	switch value := raw.(type) {
	case string:
		return value
	case []any:
		var parts []string
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			switch stringFromMap(block, "type") {
			case "text":
				if text := stringFromMap(block, "text"); text != "" {
					parts = append(parts, text)
				}
			case "thinking":
				if text := stringFromMap(block, "thinking"); text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}
