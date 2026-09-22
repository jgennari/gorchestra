package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/threave-io/threave/internal/agents"
	runcontrol "github.com/threave-io/threave/internal/session"
	"github.com/threave-io/threave/internal/store"
)

type runControlStore interface {
	CreateRunSubmission(context.Context, store.CreateRunSubmissionParams) (store.RunSubmission, store.Session, bool, error)
	GetRunSubmissionByRunID(context.Context, string) (store.RunSubmission, error)
	UpdateRunSubmission(context.Context, string, string, string) error
	GetRun(context.Context, string) (store.Run, error)
}

type runEventStore interface {
	runControlStore
	ListEventsFiltered(context.Context, string, int64, int, store.EventListFilter) ([]store.Event, error)
	ListPendingInputEvents(context.Context, string, int64) ([]store.Event, error)
	ListPendingPermissionEvents(context.Context, string, int64) ([]store.Event, error)
}

type runEventsResponse struct {
	SchemaVersion int             `json:"schema_version"`
	RunID         string          `json:"run_id"`
	SessionID     string          `json:"session_id"`
	Events        []eventResponse `json:"events"`
	NextAfterSeq  int64           `json:"next_after_seq"`
	HasMore       bool            `json:"has_more"`
}

type createRunRequest struct {
	RequestID       string              `json:"request_id,omitempty"`
	Title           string              `json:"title,omitempty"`
	AgentType       string              `json:"agent_type"`
	Workspace       string              `json:"workspace_path,omitempty"`
	AgentOptions    *createAgentOptions `json:"agent_options,omitempty"`
	Prompt          string              `json:"prompt"`
	ParentSessionID string              `json:"parent_session_id,omitempty"`
	SpawnedByRunID  string              `json:"spawned_by_run_id,omitempty"`
}

type runReceiptResponse struct {
	SchemaVersion    int    `json:"schema_version"`
	RequestID        string `json:"request_id,omitempty"`
	SessionID        string `json:"session_id"`
	RunID            string `json:"run_id"`
	Status           string `json:"status"`
	AgentType        string `json:"agent_type"`
	WorkspacePath    string `json:"workspace_path"`
	RequestedOptions any    `json:"requested_options"`
	ResolvedOptions  any    `json:"resolved_options"`
	CreatedAt        string `json:"created_at,omitempty"`
	ParentSessionID  string `json:"parent_session_id,omitempty"`
	SpawnedByRunID   string `json:"spawned_by_run_id,omitempty"`
}

type runResponse struct {
	SchemaVersion          int     `json:"schema_version"`
	ID                     string  `json:"id"`
	SessionID              string  `json:"session_id"`
	SessionTitle           string  `json:"session_title"`
	Kind                   string  `json:"kind"`
	AgentType              string  `json:"agent_type"`
	WorkspacePath          string  `json:"workspace_path"`
	Status                 string  `json:"status"`
	StartSeq               int64   `json:"start_seq"`
	TerminalSeq            int64   `json:"terminal_seq,omitempty"`
	StartedAt              string  `json:"started_at"`
	CompletedAt            *string `json:"completed_at"`
	RequestedOptions       any     `json:"requested_options"`
	ResolvedOptions        any     `json:"resolved_options"`
	FinalResponse          string  `json:"final_response,omitempty"`
	FinalResponseSeq       int64   `json:"final_response_seq,omitempty"`
	Error                  string  `json:"error,omitempty"`
	ToolCount              int64   `json:"tool_count"`
	FileCount              int64   `json:"file_count"`
	InputRequestCount      int64   `json:"input_request_count"`
	PermissionRequestCount int64   `json:"permission_request_count"`
	TokenCount             *int64  `json:"token_count,omitempty"`
	Cost                   any     `json:"cost,omitempty"`
	ParentSessionID        string  `json:"parent_session_id,omitempty"`
	SpawnedByRunID         string  `json:"spawned_by_run_id,omitempty"`
}

const (
	defaultMaxLineageDepth   = 6
	defaultMaxActiveChildren = 8
)

func (api API) createRunHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runControlStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "durable run control is unavailable")
		return
	}
	var request createRunRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.AgentType = strings.TrimSpace(request.AgentType)
	request.Prompt = strings.TrimSpace(request.Prompt)
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.ParentSessionID = strings.TrimSpace(request.ParentSessionID)
	request.SpawnedByRunID = strings.TrimSpace(request.SpawnedByRunID)
	if request.Prompt == "" {
		writeError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	var parent store.Session
	if request.ParentSessionID != "" {
		var loadErr error
		parent, loadErr = api.store.GetSession(r.Context(), request.ParentSessionID)
		if errors.Is(loadErr, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "parent session not found")
			return
		}
		if loadErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to load parent session")
			return
		}
		if parent.ArchivedAt != nil {
			writeError(w, http.StatusConflict, "parent session is archived")
			return
		}
		if request.AgentType == "" {
			request.AgentType = parent.AgentType
		}
	}
	if request.AgentType == "" {
		writeError(w, http.StatusBadRequest, "agent_type is required for a root run")
		return
	}
	if len(request.RequestID) > 128 {
		writeError(w, http.StatusBadRequest, "request_id must be 128 characters or fewer")
		return
	}
	agent, ok := api.agents.Get(request.AgentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}
	workspaceRequest := request.Workspace
	parentWorkspace := ""
	if request.ParentSessionID != "" {
		resolvedParentWorkspace, resolveErr := api.workspaces.resolveWorkspacePath(sessionWorkspacePath(parent, api.workdir))
		if resolveErr != nil {
			writeWorkspacePathError(w, resolveErr)
			return
		}
		parentWorkspace = resolvedParentWorkspace
		if strings.TrimSpace(workspaceRequest) == "" {
			workspaceRequest = parentWorkspace
		}
	}
	workspace, err := api.workspaces.resolveWorkspacePath(workspaceRequest)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	if request.ParentSessionID != "" && workspace != parentWorkspace {
		writeError(w, http.StatusBadRequest, "child sessions must use the parent workspace")
		return
	}
	var options json.RawMessage
	if request.ParentSessionID != "" && request.AgentType == parent.AgentType {
		options, err = mergeInheritedCreateOptions(parent.AgentOptions, request.AgentType, request.AgentOptions)
	} else {
		options, err = createSessionAgentOptions(request.AgentType, request.AgentOptions)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateCreateRunOptions(r.Context(), agent, request.AgentType, request.AgentOptions); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	metadata, requestedOptions, err := submitOptionsMetadata(request.AgentType, options, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if request.RequestID == "" {
		generated, generateErr := store.NewRunID()
		if generateErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to create request ID")
			return
		}
		request.RequestID = "req_" + strings.TrimPrefix(generated, "run_")
	}
	canonical, _ := json.Marshal(request)
	fingerprint := sha256.Sum256(canonical)
	runID, err := store.NewRunID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create run ID")
		return
	}
	submission, session, claimed, err := persistence.CreateRunSubmission(r.Context(), store.CreateRunSubmissionParams{
		RequestID: request.RequestID, RequestHash: hex.EncodeToString(fingerprint[:]), RunID: runID,
		Prompt: request.Prompt, Title: request.Title, AgentType: request.AgentType,
		WorkspacePath: workspace, AgentOptions: options, ParentSessionID: request.ParentSessionID,
		SpawnedByRunID: request.SpawnedByRunID, MaxLineageDepth: api.maxLineageDepth,
		MaxActiveChildren: api.maxActiveChildren,
	})
	if err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "parent session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to reserve run")
		return
	}
	if !claimed {
		if submission.RequestHash != hex.EncodeToString(fingerprint[:]) {
			writeError(w, http.StatusConflict, "request ID already belongs to different content")
			return
		}
		api.writeExistingRunReceipt(w, r, persistence, submission, session)
		return
	}
	if session.ParentSessionID != "" {
		payload := map[string]any{"parent_session_id": session.ParentSessionID, "child_session_id": session.ID,
			"child_run_id": submission.RunID, "agent_type": session.AgentType, "workspace_path": session.WorkspacePath}
		if err := api.appendAgentEvent(r.Context(), session.ID, agents.AgentEvent{Type: "agent.delegation.created", Role: "system", Status: string(store.EventStatusCompleted), Payload: payload}, submission.RunID); err != nil {
			_ = persistence.UpdateRunSubmission(context.Background(), submission.RunID, "failed", "failed to persist child linkage event")
			writeError(w, http.StatusInternalServerError, "failed to persist child linkage")
			return
		}
		if err := api.appendAgentEvent(r.Context(), session.ParentSessionID, agents.AgentEvent{Type: "agent.delegation.started", Role: "assistant", Status: string(store.EventStatusStarted), Payload: payload}, session.SpawnedByRunID); err != nil {
			_ = persistence.UpdateRunSubmission(context.Background(), submission.RunID, "failed", "failed to persist parent delegation event")
			writeError(w, http.StatusInternalServerError, "failed to persist parent delegation")
			return
		}
	}

	updated, startedRunID, started := api.startSessionRunWithID(
		w, r, session, request.Prompt, nil, nil, agent, metadata, requestedOptions,
		agents.AgentActionMessage,
		func(ctx context.Context) error {
			return api.appendUserMessage(ctx, session.ID, request.Prompt, nil, nil, requestedOptions,
				map[string]any{"client_submission_id": request.RequestID}, "")
		},
		"failed to persist run prompt", submission.RunID,
	)
	if !started {
		_ = persistence.UpdateRunSubmission(context.Background(), submission.RunID, "failed", "run did not start")
		return
	}
	_ = persistence.UpdateRunSubmission(context.Background(), submission.RunID, "running", "")
	writeJSON(w, http.StatusAccepted, runReceiptResponse{
		SchemaVersion: 1, RequestID: submission.RequestID, SessionID: updated.ID,
		RunID: startedRunID, Status: "running", AgentType: updated.AgentType,
		WorkspacePath: updated.WorkspacePath, RequestedOptions: decodeRawObject(options),
		ResolvedOptions: metadata, CreatedAt: submission.CreatedAt.UTC().Format(time.RFC3339Nano),
		ParentSessionID: updated.ParentSessionID, SpawnedByRunID: updated.SpawnedByRunID,
	})
}

func validateCreateRunOptions(ctx context.Context, agent agents.Agent, agentType string, requested *createAgentOptions) error {
	if requested == nil {
		return nil
	}
	var model, thinking string
	var planning, fast bool
	switch agentType {
	case "codex":
		if requested.Codex == nil {
			return nil
		}
		model, thinking = strings.TrimSpace(requested.Codex.Model), strings.TrimSpace(requested.Codex.ReasoningEffort)
		planning, fast = boolOption(requested.Codex.PlanningMode), boolOption(requested.Codex.FastMode)
	case "claude":
		if requested.Claude == nil {
			return nil
		}
		model, thinking = strings.TrimSpace(requested.Claude.Model), strings.TrimSpace(requested.Claude.Effort)
		planning = boolOption(requested.Claude.PlanningMode)
	case "opencode":
		if requested.OpenCode == nil {
			return nil
		}
		model, planning = strings.TrimSpace(requested.OpenCode.Model), boolOption(requested.OpenCode.PlanningMode)
	case "pi":
		if requested.Pi == nil {
			return nil
		}
		model, thinking = strings.TrimSpace(requested.Pi.Model), strings.TrimSpace(requested.Pi.ThinkingLevel)
	}
	if model == "" && thinking == "" && !planning && !fast {
		return nil
	}
	provider, ok := agent.(agents.OptionsProvider)
	if !ok {
		return nil
	}
	options, err := provider.Options(ctx)
	if err != nil {
		return fmt.Errorf("load agent options: %w", err)
	}
	selectedModel := model
	if selectedModel == "" {
		selectedModel = options.DefaultModel
	}
	var selected *agents.ModelOption
	for index := range options.Models {
		candidate := &options.Models[index]
		if candidate.Model == selectedModel || candidate.ID == selectedModel {
			selected = candidate
			break
		}
	}
	if model != "" && selected == nil && len(options.Models) > 0 {
		return fmt.Errorf("unsupported model %q", model)
	}
	if thinking != "" && selected != nil && len(selected.SupportedReasoningEfforts) > 0 {
		supported := false
		for _, effort := range selected.SupportedReasoningEfforts {
			if effort.ReasoningEffort == thinking {
				supported = true
				break
			}
		}
		if !supported {
			return fmt.Errorf("unsupported thinking level %q for model %q", thinking, selectedModel)
		}
	}
	if planning && len(options.CollaborationModes) > 0 {
		supported := false
		for _, mode := range options.CollaborationModes {
			if mode.Mode == "plan" || mode.Name == "plan" {
				supported = true
				break
			}
		}
		if !supported {
			return errors.New("planning mode is unsupported by this agent")
		}
	}
	if fast && selected != nil && len(selected.ServiceTiers) > 0 {
		supported := false
		for _, tier := range selected.ServiceTiers {
			if tier.ID == "priority" {
				supported = true
				break
			}
		}
		if !supported {
			return fmt.Errorf("fast mode is unsupported by model %q", selectedModel)
		}
	}
	return nil
}

func mergeInheritedCreateOptions(parentOptions json.RawMessage, agentType string, requested *createAgentOptions) (json.RawMessage, error) {
	if requested == nil {
		return append(json.RawMessage(nil), parentOptions...), nil
	}
	var inherited map[string]any
	if err := json.Unmarshal(parentOptions, &inherited); err != nil {
		return nil, fmt.Errorf("decode parent agent options: %w", err)
	}
	rawOverride, err := json.Marshal(requested)
	if err != nil {
		return nil, fmt.Errorf("encode child agent options: %w", err)
	}
	var overrides map[string]any
	if err := json.Unmarshal(rawOverride, &overrides); err != nil {
		return nil, err
	}
	baseProvider, _ := inherited[agentType].(map[string]any)
	if baseProvider == nil {
		baseProvider = map[string]any{}
	}
	if requestedProvider, ok := overrides[agentType].(map[string]any); ok {
		for key, value := range requestedProvider {
			baseProvider[key] = value
		}
	}
	inherited[agentType] = baseProvider
	encoded, err := json.Marshal(inherited)
	if err != nil {
		return nil, fmt.Errorf("encode inherited agent options: %w", err)
	}
	return encoded, nil
}

func (api API) writeExistingRunReceipt(w http.ResponseWriter, r *http.Request, persistence runControlStore, submission store.RunSubmission, session store.Session) {
	status := submission.State
	resolved := any(map[string]any{})
	requested := decodeRawObject(session.AgentOptions)
	if run, err := persistence.GetRun(r.Context(), submission.RunID); err == nil {
		status = run.Status
		requested = decodeRawObject(run.RequestedOptions)
		resolved = decodeRawObject(run.ResolvedOptions)
	}
	writeJSON(w, http.StatusAccepted, runReceiptResponse{
		SchemaVersion: 1, RequestID: submission.RequestID, SessionID: submission.SessionID,
		RunID: submission.RunID, Status: status, AgentType: session.AgentType,
		WorkspacePath: session.WorkspacePath, RequestedOptions: requested,
		ResolvedOptions: resolved, CreatedAt: submission.CreatedAt.UTC().Format(time.RFC3339Nano),
		ParentSessionID: session.ParentSessionID, SpawnedByRunID: session.SpawnedByRunID,
	})
}

func (api API) getRunHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runControlStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run lookup is unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		if submission, submissionErr := persistence.GetRunSubmissionByRunID(r.Context(), chi.URLParam(r, "runId")); submissionErr == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"schema_version": 1, "id": submission.RunID, "session_id": submission.SessionID,
				"status": submission.State, "error": submission.Error,
			})
			return
		}
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	writeJSON(w, http.StatusOK, runToResponse(run))
}

func (api API) getRunReportHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runControlStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run reports are unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		if submission, submissionErr := persistence.GetRunSubmissionByRunID(r.Context(), chi.URLParam(r, "runId")); submissionErr == nil {
			if submission.State == "accepted" || submission.State == "running" {
				writeError(w, http.StatusConflict, "run is not terminal")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"schema_version": 1, "id": submission.RunID, "session_id": submission.SessionID,
				"status": submission.State, "error": submission.Error, "final_response": "",
			})
			return
		}
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run report")
		return
	}
	if run.Status == "running" {
		writeError(w, http.StatusConflict, "run is still running")
		return
	}
	writeJSON(w, http.StatusOK, runToResponse(run))
}

func (api API) getRunEventsHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runEventStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run events are unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	after := run.StartSeq - 1
	if raw := strings.TrimSpace(r.URL.Query().Get("after_seq")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 0 {
			writeError(w, http.StatusBadRequest, "after_seq must be a non-negative integer")
			return
		}
		if value > after {
			after = value
		}
	}
	limit := 500
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, parseErr := strconv.Atoi(raw)
		if parseErr != nil || value < 1 || value > 1000 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 1000")
			return
		}
		limit = value
	}
	events, err := persistence.ListEventsFiltered(r.Context(), run.SessionID, after, limit+1, store.EventListFilter{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list run events")
		return
	}
	events = eventsWithinRun(events, run)
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	responses := make([]eventResponse, 0, len(events))
	next := after
	for _, event := range events {
		responses = append(responses, newEventResponse(event))
		if !event.Transient && event.Seq > next {
			next = event.Seq
		}
	}
	writeJSON(w, http.StatusOK, runEventsResponse{SchemaVersion: 1, RunID: run.ID, SessionID: run.SessionID, Events: responses, NextAfterSeq: next, HasMore: hasMore})
}

func (api API) runEventStreamHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runEventStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run events are unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	after := run.StartSeq - 1
	if raw := strings.TrimSpace(r.URL.Query().Get("after_seq")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 0 {
			writeError(w, http.StatusBadRequest, "after_seq must be a non-negative integer")
			return
		}
		if value > after {
			after = value
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	live, unsubscribe := api.events.Subscribe(run.SessionID)
	defer unsubscribe()
	replayed, resync, err := api.replayEvents(r.Context(), run.SessionID, after, store.EventListFilter{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replay run events")
		return
	}
	replayed = eventsWithinRun(replayed, run)
	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_ = writeSSEComment(w, "connected")
	flusher.Flush()
	if resync {
		_ = writeSSEControl(w, streamResyncEventType, map[string]any{"reason": "replay_window_exceeded", "after_seq": after})
		flusher.Flush()
		return
	}
	highest := after
	for _, event := range replayed {
		if err := writeSSE(w, event); err != nil {
			return
		}
		flusher.Flush()
		if event.Seq > highest {
			highest = event.Seq
		}
		if run.TerminalSeq > 0 && event.Seq >= run.TerminalSeq {
			return
		}
	}
	if run.TerminalSeq > 0 {
		return
	}
	heartbeat := time.NewTicker(streamHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if err := writeSSEComment(w, "heartbeat"); err != nil {
				return
			}
			flusher.Flush()
		case event, open := <-live:
			if !open {
				return
			}
			if event.Seq <= highest || event.Seq < run.StartSeq {
				continue
			}
			if err := writeSSE(w, event); err != nil {
				return
			}
			flusher.Flush()
			if !event.Transient {
				highest = event.Seq
			}
			if eventRunID(event) == run.ID && isTerminalRunEvent(event.Type) {
				return
			}
		}
	}
}

func eventsWithinRun(events []store.Event, run store.Run) []store.Event {
	result := events[:0]
	for _, event := range events {
		if event.Seq < run.StartSeq || (run.TerminalSeq > 0 && event.Seq > run.TerminalSeq) {
			continue
		}
		result = append(result, event)
	}
	return result
}

func eventRunID(event store.Event) string {
	var payload struct {
		RunID string `json:"run_id"`
	}
	_ = json.Unmarshal(event.Payload, &payload)
	return strings.TrimSpace(payload.RunID)
}

func (api API) cancelRunHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runControlStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run control is unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	if run.Status != "running" {
		writeError(w, http.StatusConflict, "run is not running")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if r.Body != nil && r.Body != http.NoBody && r.ContentLength != 0 && !decodeJSONBody(w, r, &body) {
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "requested"
	}
	if err := api.runs.CancelRun(run.SessionID, run.ID, runcontrol.Cancellation{Source: "cli", Reason: reason}); err != nil {
		if errors.Is(err, runcontrol.ErrRunNotActive) || errors.Is(err, runcontrol.ErrRunAlreadyCanceled) {
			writeError(w, http.StatusConflict, "run is no longer active")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to cancel run")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"schema_version": 1, "run_id": run.ID, "session_id": run.SessionID, "status": "cancelling"})
}

func (api API) getRunRequestsHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(runEventStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run requests are unavailable")
		return
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	through := run.TerminalSeq
	if through == 0 {
		session, loadErr := api.store.GetSession(r.Context(), run.SessionID)
		if loadErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to load session")
			return
		}
		through = session.LastEventSeq
	}
	pending, err := persistence.ListPendingInputEvents(r.Context(), run.SessionID, through)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load requests")
		return
	}
	permissions, err := persistence.ListPendingPermissionEvents(r.Context(), run.SessionID, through)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load permission requests")
		return
	}
	pending = append(pending, permissions...)
	sort.Slice(pending, func(left, right int) bool { return pending[left].Seq < pending[right].Seq })
	responses := make([]eventResponse, 0, len(pending))
	for _, event := range pending {
		if event.Seq >= run.StartSeq && (run.TerminalSeq == 0 || event.Seq <= run.TerminalSeq) {
			responses = append(responses, newEventResponse(event))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": 1, "run_id": run.ID, "session_id": run.SessionID, "requests": responses})
}

func (api API) answerRunRequestHandler(w http.ResponseWriter, r *http.Request) {
	run, ok := api.requireActiveRun(w, r)
	if !ok {
		return
	}
	api.withSessionParam(r, run.SessionID, api.answerUserInputHandler, w)
}

func (api API) resolveRunPermissionHandler(w http.ResponseWriter, r *http.Request) {
	run, ok := api.requireActiveRun(w, r)
	if !ok {
		return
	}
	api.withSessionParam(r, run.SessionID, api.resolvePermissionHandler, w)
}

func (api API) requireActiveRun(w http.ResponseWriter, r *http.Request) (store.Run, bool) {
	persistence, ok := api.store.(runControlStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "run control is unavailable")
		return store.Run{}, false
	}
	run, err := persistence.GetRun(r.Context(), chi.URLParam(r, "runId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "run not found")
		return store.Run{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return store.Run{}, false
	}
	if run.Status != "running" {
		writeError(w, http.StatusConflict, "run is not running")
		return store.Run{}, false
	}
	if !api.runs.ActiveRun(run.SessionID, run.ID) {
		writeError(w, http.StatusConflict, "run is no longer active")
		return store.Run{}, false
	}
	return run, true
}

func (api API) withSessionParam(r *http.Request, sessionID string, handler http.HandlerFunc, w http.ResponseWriter) {
	ctx := chi.NewRouteContext()
	if existing := chi.RouteContext(r.Context()); existing != nil {
		*ctx = *existing
	}
	ctx.URLParams.Add("sessionId", sessionID)
	handler(w, r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx)))
}

func runToResponse(run store.Run) runResponse {
	response := runResponse{
		SchemaVersion: 1, ID: run.ID, SessionID: run.SessionID, SessionTitle: run.SessionTitle,
		Kind: run.Kind, AgentType: run.AgentType, WorkspacePath: run.WorkspacePath, Status: run.Status,
		StartSeq: run.StartSeq, TerminalSeq: run.TerminalSeq,
		StartedAt:        run.StartedAt.UTC().Format(time.RFC3339Nano),
		RequestedOptions: decodeRawObject(run.RequestedOptions), ResolvedOptions: decodeRawObject(run.ResolvedOptions),
		FinalResponse: run.FinalResponse, FinalResponseSeq: run.FinalResponseSeq, Error: run.Error,
		ToolCount: run.ToolCount, FileCount: run.FileCount, InputRequestCount: run.InputRequestCount,
		PermissionRequestCount: run.PermissionRequestCount,
		ParentSessionID:        run.ParentSessionID, SpawnedByRunID: run.SpawnedByRunID,
	}
	if run.CompletedAt != nil {
		value := run.CompletedAt.UTC().Format(time.RFC3339Nano)
		response.CompletedAt = &value
	}
	if run.HasTokenUsage {
		value := run.TokenCount
		response.TokenCount = &value
	}
	if run.HasCostUsage {
		response.Cost = map[string]any{"amount": run.CostAmount, "currency": run.CostCurrency}
	}
	return response
}

func decodeRawObject(raw json.RawMessage) any {
	value := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}
