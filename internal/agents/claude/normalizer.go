package claude

import (
	"encoding/json"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
)

type terminalKind int

const (
	terminalNone terminalKind = iota
	terminalCompleted
	terminalFailed
)

type normalizedEvent struct {
	Event    agents.AgentEvent
	Terminal terminalKind
}

type normalizer struct {
	runStarted       bool
	currentMessageID string
	messageText      string
	terminal         bool
	terminalKind     terminalKind
	terminalError    string
}

func newNormalizer() *normalizer {
	return &normalizer{}
}

func (n *normalizer) normalize(input *streamEvent) []normalizedEvent {
	if input == nil || n.terminal {
		return nil
	}

	switch input.Type {
	case "system":
		return n.normalizeSystem(input)
	case "stream_event":
		return n.normalizeAnthropicStreamEvent(input)
	case "assistant":
		return n.normalizeAssistant(input)
	case "result":
		return []normalizedEvent{n.normalizeResult(input)}
	case "rate_limit_event":
		payload := basePayload(input)
		payload["rate_limit_info"] = rawOrNil(input.RateLimitInfo)
		return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
	default:
		return []normalizedEvent{n.unknown(input)}
	}
}

func (n *normalizer) normalizeSystem(input *streamEvent) []normalizedEvent {
	payload := basePayload(input)
	if input.Subtype != "" {
		payload["subtype"] = input.Subtype
	}
	if input.Status != "" {
		payload["status"] = input.Status
	}
	if input.CWD != "" {
		payload["cwd"] = input.CWD
	}
	if len(input.Tools) > 0 {
		payload["tools"] = append([]string(nil), input.Tools...)
	}
	if input.MCPServers != nil {
		payload["mcp_servers"] = rawOrNil(input.MCPServers)
	}
	if input.Model != "" {
		payload["model"] = input.Model
	}

	if input.Subtype == "init" {
		return compact(n.syntheticRunStarted(input, payload))
	}
	return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
}

func (n *normalizer) normalizeAnthropicStreamEvent(input *streamEvent) []normalizedEvent {
	providerEventType := stringAt(input.Event, "type")
	if providerEventType == "" {
		return []normalizedEvent{n.unknown(input)}
	}

	payload := basePayload(input)
	payload["provider_event_type"] = providerEventType
	payload["raw_event"] = rawOrNil(input.Event)
	if input.ParentToolUseID != "" {
		payload["parent_tool_use_id"] = input.ParentToolUseID
	}

	switch providerEventType {
	case "message_start":
		if model := stringAt(input.Event, "message", "model"); model != "" {
			payload["model"] = model
		}
		if id := stringAt(input.Event, "message", "id"); id != "" {
			n.currentMessageID = id
			payload["message_id"] = id
		}
		return []normalizedEvent{{Event: agentEvent("agent.status.started", "assistant", "started", payload)}}
	case "content_block_delta":
		text := stringAt(input.Event, "delta", "text")
		if text == "" {
			return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
		}
		n.messageText += text
		payload["text"] = text
		if n.currentMessageID != "" {
			payload["message_id"] = n.currentMessageID
		}
		payload["index"] = anyAt(input.Event, "index")
		return []normalizedEvent{{Event: agentEvent("agent.message.delta", "assistant", "delta", payload)}}
	case "message_delta":
		if stopReason := stringAt(input.Event, "delta", "stop_reason"); stopReason != "" {
			payload["stop_reason"] = stopReason
		}
		if usage := anyAt(input.Event, "usage"); usage != nil {
			payload["usage"] = usage
		}
		return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
	case "message_stop", "content_block_start", "content_block_stop":
		return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
	default:
		return []normalizedEvent{{Event: agentEvent("provider.claude.event", "system", "completed", payload)}}
	}
}

func (n *normalizer) normalizeAssistant(input *streamEvent) []normalizedEvent {
	payload := basePayload(input)
	payload["provider_event_type"] = "assistant"
	payload["raw_message"] = rawOrNil(input.Message)
	text := textFromAssistantMessage(input.Message)
	if text == "" {
		text = n.messageText
	}
	if text != "" {
		payload["text"] = text
	}
	if id := stringAt(input.Message, "id"); id != "" {
		payload["message_id"] = id
	}
	if model := stringAt(input.Message, "model"); model != "" {
		payload["model"] = model
	}
	return []normalizedEvent{{Event: agentEvent("agent.message.completed", "assistant", "completed", payload)}}
}

func (n *normalizer) normalizeResult(input *streamEvent) normalizedEvent {
	payload := basePayload(input)
	payload["provider_event_type"] = "result"
	payload["is_error"] = input.IsError
	if input.Result != "" {
		payload["text"] = input.Result
	}
	if input.StopReason != "" {
		payload["stop_reason"] = input.StopReason
	}
	if input.DurationMS > 0 {
		payload["duration_ms"] = input.DurationMS
	}
	if input.DurationAPIMS > 0 {
		payload["duration_api_ms"] = input.DurationAPIMS
	}
	if input.TotalCostUSD > 0 {
		payload["total_cost_usd"] = input.TotalCostUSD
	}
	if input.Usage != nil {
		payload["usage"] = rawOrNil(input.Usage)
	}
	if input.ModelUsage != nil {
		payload["model_usage"] = rawOrNil(input.ModelUsage)
	}
	if input.PermissionDenials != nil {
		payload["permission_denials"] = rawOrNil(input.PermissionDenials)
	}

	if input.IsError {
		message := firstNonEmpty(input.Result, "claude run failed")
		payload["error"] = message
		n.markTerminal(terminalFailed, message)
		return normalizedEvent{Event: agentEvent("agent.run.failed", "assistant", "failed", payload), Terminal: terminalFailed}
	}
	n.markTerminal(terminalCompleted, "")
	return normalizedEvent{Event: agentEvent("agent.run.completed", "assistant", "completed", payload), Terminal: terminalCompleted}
}

func (n *normalizer) syntheticRunStarted(input *streamEvent, payload map[string]any) normalizedEvent {
	if n.runStarted {
		return normalizedEvent{}
	}
	n.runStarted = true
	payload["provider_event_type"] = "system/init"
	if input.SessionID != "" {
		payload["provider_session_id"] = input.SessionID
	}
	return normalizedEvent{Event: agentEvent("agent.run.started", "assistant", "started", payload)}
}

func (n *normalizer) unknown(input *streamEvent) normalizedEvent {
	payload := basePayload(input)
	payload["raw"] = rawOrNil(input.Raw)
	if input.Type != "" {
		payload["provider_event_type"] = input.Type
	}
	return normalizedEvent{Event: agentEvent("provider.claude.event", "system", "completed", payload)}
}

func (n *normalizer) markTerminal(kind terminalKind, message string) {
	if n.terminal {
		return
	}
	n.terminal = true
	n.terminalKind = kind
	n.terminalError = message
}

func agentEvent(eventType string, role string, status string, payload map[string]any) agents.AgentEvent {
	return agents.AgentEvent{
		Type:    eventType,
		Role:    role,
		Status:  status,
		Payload: payload,
	}
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

func basePayload(input *streamEvent) map[string]any {
	payload := map[string]any{
		"provider": "claude",
	}
	if input.Type != "" {
		payload["provider_event_type"] = input.Type
	}
	if input.SessionID != "" {
		payload["provider_session_id"] = input.SessionID
	}
	if input.UUID != "" {
		payload["uuid"] = input.UUID
	}
	return payload
}

func textFromAssistantMessage(raw json.RawMessage) string {
	var message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		return ""
	}
	var parts []string
	for _, content := range message.Content {
		if content.Type == "text" && content.Text != "" {
			parts = append(parts, content.Text)
		}
	}
	return strings.Join(parts, "")
}

func stringAt(raw json.RawMessage, path ...string) string {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return ""
		}
		value = object[key]
	}
	text, _ := value.(string)
	return text
}

func anyAt(raw json.RawMessage, path ...string) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func rawOrNil(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return json.RawMessage(raw)
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
