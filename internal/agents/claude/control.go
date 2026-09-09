package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
)

type controlEnvelope struct {
	RequestID string         `json:"request_id"`
	Request   map[string]any `json:"request"`
}

type pendingControl struct {
	cancel    context.CancelFunc
	close     func()
	eventType string
	payload   map[string]any
}

type controlResult struct {
	id       string
	pending  *pendingControl
	response map[string]any
	err      error
}

func (r *streamRun) handleControlRequest(ctx context.Context, event *streamEvent) error {
	var envelope controlEnvelope
	if err := json.Unmarshal(event.Raw, &envelope); err != nil {
		return err
	}
	if envelope.RequestID == "" {
		return fmt.Errorf("claude control request is missing its request ID")
	}
	if r.controls[envelope.RequestID] != nil {
		return fmt.Errorf("claude sent duplicate pending control request %q", envelope.RequestID)
	}
	if mapString(envelope.Request, "subtype") != "can_use_tool" {
		return r.writeJSON(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": envelope.RequestID, "error": "Unsupported Claude control request",
		}})
	}
	if mapString(envelope.Request, "tool_name") == "AskUserQuestion" {
		return r.openQuestion(ctx, envelope)
	}
	return r.openPermission(ctx, envelope)
}

func (r *streamRun) openPermission(ctx context.Context, envelope controlEnvelope) error {
	input := envelope.Request["input"]
	suggestions, _ := envelope.Request["permission_suggestions"].([]any)
	// Streaming input must not silently turn the deny policy into interactive
	// approvals. Bypass is implemented by Claude's mode, not by auto-approving
	// unexpected callbacks here (notably a plan-mode write or mode change).
	if r.options.permissionPolicy() != "ask" || r.permissions == nil {
		return r.sendControlResponse(envelope.RequestID, deniedControl("Tool approval is unavailable under the current permission policy", false))
	}
	options := []agents.PermissionOption{{ID: "allow-once", Label: "Allow once", Decision: "allow", Scope: "once"}}
	if len(suggestions) > 0 {
		options = append(options, agents.PermissionOption{ID: "allow-session", Label: "Allow for session", Decision: "allow", Scope: "session"})
	}
	options = append(options, agents.PermissionOption{ID: "deny", Label: "Deny", Decision: "deny", Scope: "once"}, agents.PermissionOption{ID: "cancel", Label: "Stop run", Decision: "cancel"})
	request := agents.PermissionRequest{SessionID: r.sessionID, RequestID: envelope.RequestID, Provider: Type, ProviderEventType: "can_use_tool", ProviderRequestID: envelope.RequestID,
		ItemID: mapString(envelope.Request, "tool_use_id"), Kind: "tool", Title: firstNonEmpty(mapString(envelope.Request, "title"), mapString(envelope.Request, "display_name"), "Approve tool use"),
		Description: mapString(envelope.Request, "description"), Reason: mapString(envelope.Request, "decision_reason"), ToolName: mapString(envelope.Request, "tool_name"), ToolInput: input, Options: options}
	waiter, err := r.permissions.OpenPermission(ctx, request)
	if err != nil {
		return err
	}
	if err := r.emit(ctx, agents.AgentEvent{Type: "agent.permission.requested", Role: "assistant", Status: "started", Payload: request}); err != nil {
		waiter.Close()
		return err
	}
	r.waitForControl(ctx, envelope.RequestID, "agent.permission.cancelled", waiter.Close, func(ctx context.Context) (map[string]any, error) {
		response, err := waiter.Wait(ctx)
		if err != nil {
			return nil, err
		}
		switch response.OptionID {
		case "allow-once":
			return map[string]any{"behavior": "allow", "updatedInput": input}, nil
		case "allow-session":
			return map[string]any{"behavior": "allow", "updatedInput": input, "updatedPermissions": sessionPermissionSuggestions(suggestions)}, nil
		case "cancel":
			return deniedControl("Stopped by user", true), nil
		default:
			return deniedControl("Denied by user", false), nil
		}
	})
	return nil
}

func (r *streamRun) openQuestion(ctx context.Context, envelope controlEnvelope) error {
	input, ok := envelope.Request["input"].(map[string]any)
	if !ok {
		return r.sendControlResponse(envelope.RequestID, deniedControl("Invalid question input", false))
	}
	questions, err := claudeQuestions(input)
	if err != nil {
		return r.sendControlResponse(envelope.RequestID, deniedControl(err.Error(), false))
	}
	if r.userInput == nil {
		return r.sendControlResponse(envelope.RequestID, deniedControl("Gorchestra cannot collect answers for this run", false))
	}
	request := agents.UserInputRequest{
		SessionID: r.sessionID, RequestID: envelope.RequestID, Provider: Type,
		ProviderEventType: "can_use_tool", ProviderRequestID: envelope.RequestID,
		ItemID: mapString(envelope.Request, "tool_use_id"), Questions: questions,
	}
	waiter, err := r.userInput.OpenUserInput(ctx, request)
	if err != nil {
		return err
	}
	if err := r.emit(ctx, agents.AgentEvent{Type: "agent.input.requested", Role: "assistant", Status: "started", Payload: map[string]any{
		"provider": Type, "provider_event_type": "can_use_tool", "provider_request_id": request.ProviderRequestID,
		"request_id": request.RequestID, "item_id": request.ItemID, "questions": questions,
	}}); err != nil {
		waiter.Close()
		return err
	}
	r.waitForControl(ctx, envelope.RequestID, "agent.input.cancelled", waiter.Close, func(ctx context.Context) (map[string]any, error) {
		response, err := waiter.Wait(ctx)
		if err != nil {
			return nil, err
		}
		answers := make(map[string]string, len(questions))
		for _, question := range questions {
			values := response.Answers[question.ID].Answers
			if len(values) == 0 || (!question.MultiSelect && len(values) != 1) {
				return nil, fmt.Errorf("claude question %q has an invalid answer count", question.ID)
			}
			trimmed := make([]string, len(values))
			for i, value := range values {
				trimmed[i] = strings.TrimSpace(value)
				if trimmed[i] == "" {
					return nil, fmt.Errorf("claude question %q has an empty answer", question.ID)
				}
			}
			// Claude keys answers by the exact question text. Its string format
			// supports multiple labels joined with a comma and space.
			answers[question.Question] = strings.Join(trimmed, ", ")
		}
		updated := make(map[string]any, len(input)+1)
		for key, value := range input {
			updated[key] = value
		}
		updated["answers"] = answers
		return map[string]any{"behavior": "allow", "updatedInput": updated}, nil
	})
	return nil
}

func claudeQuestions(input map[string]any) ([]agents.UserInputQuestion, error) {
	raw, err := json.Marshal(input["questions"])
	if err != nil {
		return nil, fmt.Errorf("invalid Claude questions")
	}
	var source []struct {
		Question    string                   `json:"question"`
		Header      string                   `json:"header"`
		MultiSelect bool                     `json:"multiSelect"`
		Options     []agents.UserInputOption `json:"options"`
	}
	if err := json.Unmarshal(raw, &source); err != nil || len(source) == 0 {
		return nil, fmt.Errorf("invalid Claude questions")
	}
	questions := make([]agents.UserInputQuestion, 0, len(source))
	seen := make(map[string]bool, len(source))
	for index, item := range source {
		if strings.TrimSpace(item.Question) == "" || seen[item.Question] {
			return nil, fmt.Errorf("Claude questions must have nonempty, distinct text")
		}
		seen[item.Question] = true
		labels := make(map[string]bool, len(item.Options))
		for _, option := range item.Options {
			if strings.TrimSpace(option.Label) == "" || labels[option.Label] {
				return nil, fmt.Errorf("Claude question choices must have nonempty, distinct labels")
			}
			labels[option.Label] = true
		}
		questions = append(questions, agents.UserInputQuestion{
			ID: fmt.Sprintf("question_%d", index+1), Header: item.Header, Question: item.Question,
			IsOther: true, MultiSelect: item.MultiSelect, Options: item.Options,
		})
	}
	return questions, nil
}

// Only the main stream loop emits events and writes responses. Waiting for a
// person must not prevent stdout processing, cancellation, or process cleanup.
func (r *streamRun) waitForControl(ctx context.Context, id, eventType string, closeWaiter func(), wait func(context.Context) (map[string]any, error)) {
	waitCtx, cancel := context.WithCancel(ctx)
	pending := &pendingControl{cancel: cancel, close: closeWaiter, eventType: eventType,
		payload: map[string]any{"provider": Type, "provider_event_type": "control_cancel_request", "request_id": id, "provider_request_id": id}}
	r.controls[id] = pending
	r.controlWaiters.Add(1)
	go func() {
		defer r.controlWaiters.Done()
		response, err := wait(waitCtx)
		select {
		case r.controlResults <- controlResult{id: id, pending: pending, response: response, err: err}:
		case <-ctx.Done():
		}
	}()
}

func (r *streamRun) finishControl(result controlResult) error {
	if r.controls[result.id] != result.pending {
		return nil // Withdrawn by Claude while the user was answering.
	}
	delete(r.controls, result.id)
	result.pending.cancel()
	result.pending.close()
	if result.err != nil {
		return result.err
	}
	return r.sendControlResponse(result.id, result.response)
}

func (r *streamRun) cancelControl(ctx context.Context, event *streamEvent) error {
	var envelope controlEnvelope
	if err := json.Unmarshal(event.Raw, &envelope); err != nil {
		return err
	}
	pending := r.controls[envelope.RequestID]
	if pending == nil {
		return nil
	}
	delete(r.controls, envelope.RequestID)
	pending.cancel()
	pending.close()
	return r.emit(ctx, agents.AgentEvent{Type: pending.eventType, Role: "system", Status: "completed", Payload: pending.payload})
}

func deniedControl(message string, interrupt bool) map[string]any {
	return map[string]any{"behavior": "deny", "message": message, "interrupt": interrupt}
}

func (r *streamRun) sendControlResponse(requestID string, result map[string]any) error {
	return r.writeJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": requestID, "response": result}})
}
