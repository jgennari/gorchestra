package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/store"
)

type runControlStore interface {
	CreateRunSubmission(context.Context, store.CreateRunSubmissionParams) (store.RunSubmission, store.Session, bool, error)
	GetRunSubmissionByRunID(context.Context, string) (store.RunSubmission, error)
	UpdateRunSubmission(context.Context, string, string, string) error
	GetRun(context.Context, string) (store.Run, error)
}

type createRunRequest struct {
	RequestID    string              `json:"request_id,omitempty"`
	Title        string              `json:"title,omitempty"`
	AgentType    string              `json:"agent_type"`
	Workspace    string              `json:"workspace_path,omitempty"`
	AgentOptions *createAgentOptions `json:"agent_options,omitempty"`
	Prompt       string              `json:"prompt"`
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
}

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
	if request.AgentType == "" || request.Prompt == "" {
		writeError(w, http.StatusBadRequest, "agent_type and prompt are required")
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
	workspace, err := api.workspaces.resolveWorkspacePath(request.Workspace)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	options, err := createSessionAgentOptions(request.AgentType, request.AgentOptions)
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
		WorkspacePath: workspace, AgentOptions: options,
	})
	if err != nil {
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
