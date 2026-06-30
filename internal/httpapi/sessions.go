package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

type createSessionRequest struct {
	AgentType     string              `json:"agent_type"`
	Title         string              `json:"title"`
	WorkspacePath string              `json:"workspace_path"`
	AgentOptions  *createAgentOptions `json:"agent_options,omitempty"`
}

type updateSessionRequest struct {
	Title        *string             `json:"title,omitempty"`
	AgentOptions *createAgentOptions `json:"agent_options,omitempty"`
}

type createAgentOptions struct {
	Codex  *createCodexOptions  `json:"codex,omitempty"`
	Claude *createClaudeOptions `json:"claude,omitempty"`
}

type createCodexOptions struct {
	RunDangerously bool `json:"run_dangerously,omitempty"`
}

type createClaudeOptions struct {
	RunDangerously bool `json:"run_dangerously,omitempty"`
}

type createSessionResponse struct {
	SessionID string `json:"session_id"`
}

type sessionResponse struct {
	ID                string  `json:"id"`
	Title             string  `json:"title"`
	AgentType         string  `json:"agent_type"`
	Status            string  `json:"status"`
	ProviderSessionID string  `json:"provider_session_id,omitempty"`
	WorkspacePath     string  `json:"workspace_path"`
	AgentOptions      any     `json:"agent_options"`
	EventCount        int64   `json:"event_count"`
	LastEventSeq      int64   `json:"last_event_seq"`
	ToolCount         int64   `json:"tool_count"`
	PendingInput      bool    `json:"pending_input"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
	CompletedAt       *string `json:"completed_at"`
	ArchivedAt        *string `json:"archived_at"`
}

type listSessionsResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

type submitMessageRequest struct {
	Content      string              `json:"content"`
	AgentOptions *submitAgentOptions `json:"agent_options,omitempty"`
	Attachments  []submitAttachment  `json:"attachments,omitempty"`
	Queue        bool                `json:"queue,omitempty"`
}

type submitAgentOptions struct {
	Codex  *submitCodexOptions  `json:"codex,omitempty"`
	Claude *submitClaudeOptions `json:"claude,omitempty"`
}

type submitCodexOptions struct {
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
	FastMode        bool   `json:"fast_mode,omitempty"`
	PlanningMode    bool   `json:"planning_mode,omitempty"`
	ServiceTier     string `json:"service_tier,omitempty"`
}

type submitClaudeOptions struct {
	Model        string `json:"model,omitempty"`
	Effort       string `json:"effort,omitempty"`
	PlanningMode bool   `json:"planning_mode,omitempty"`
}

type submitAttachment struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	DataURL   string `json:"data_url"`
	SizeBytes int64  `json:"size_bytes"`
}

type submitMessageResponse struct {
	SessionID     string                 `json:"session_id"`
	Status        string                 `json:"status"`
	AcceptedAs    string                 `json:"accepted_as,omitempty"`
	QueuedMessage *queuedMessageResponse `json:"queued_message,omitempty"`
}

type queuedMessageResponse struct {
	ID           string `json:"id"`
	SessionID    string `json:"session_id"`
	Seq          int64  `json:"seq"`
	Content      string `json:"content"`
	AgentOptions any    `json:"agent_options"`
	CreatedAt    string `json:"created_at"`
}

type queuedMessagesResponse struct {
	Messages []queuedMessageResponse `json:"messages"`
}

const (
	maxSubmitAttachments     = 8
	maxSubmitAttachmentBytes = 5 * 1024 * 1024
	maxQueuedMessages        = 5
)

type cancelSessionResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

type answerUserInputRequest struct {
	Answers map[string]agents.UserInputQuestionAnswer `json:"answers"`
}

type answerUserInputResponse struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
}

func (api API) listSessionsHandler(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseSessionLimit(w, r)
	if !ok {
		return
	}
	status, ok := parseSessionStatus(w, r)
	if !ok {
		return
	}
	includeArchived, ok := parseIncludeArchived(w, r)
	if !ok {
		return
	}

	sessions, err := api.store.ListSessions(r.Context(), store.ListSessionsParams{
		Limit:           limit,
		Status:          status,
		IncludeArchived: includeArchived,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list sessions")
		return
	}

	responses, err := api.sessionResponses(r.Context(), sessions)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session activity")
		return
	}

	writeJSON(w, http.StatusOK, listSessionsResponse{Sessions: responses})
}

func (api API) getSessionHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}

	response, err := api.sessionResponse(r.Context(), session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session activity")
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (api API) createSessionHandler(w http.ResponseWriter, r *http.Request) {
	var request createSessionRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}

	agentType := strings.TrimSpace(request.AgentType)
	if agentType == "" {
		writeError(w, http.StatusBadRequest, "agent_type is required")
		return
	}
	agent, ok := api.agents.Get(agentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}

	workspacePath, err := api.workspaces.resolveWorkspacePath(request.WorkspacePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	agentOptions, err := createSessionAgentOptions(agentType, request.AgentOptions)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	session, err := api.store.CreateSession(r.Context(), store.CreateSessionParams{
		Title:         request.Title,
		AgentType:     agentType,
		WorkspacePath: workspacePath,
		AgentOptions:  agentOptions,
	})
	if err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	writeJSON(w, http.StatusCreated, createSessionResponse{SessionID: session.ID})
}

func (api API) updateSessionHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	var request updateSessionRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}

	if request.Title == nil && request.AgentOptions == nil {
		writeError(w, http.StatusBadRequest, "session update requires title or agent_options")
		return
	}

	var session store.Session
	var err error
	if request.Title != nil {
		session, err = api.store.UpdateSessionTitle(r.Context(), store.UpdateSessionTitleParams{
			ID:    sessionID,
			Title: *request.Title,
		})
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "session not found")
				return
			}
			if errors.Is(err, store.ErrInvalidArgument) {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to update session")
			return
		}
	} else {
		session, err = api.store.GetSession(r.Context(), sessionID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "session not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to load session")
			return
		}
	}

	if request.AgentOptions != nil {
		agentOptions, err := createSessionAgentOptions(session.AgentType, request.AgentOptions)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		session, err = api.store.UpdateSessionAgentOptions(r.Context(), store.UpdateSessionAgentOptionsParams{
			ID:           sessionID,
			AgentOptions: agentOptions,
		})
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "session not found")
				return
			}
			if errors.Is(err, store.ErrInvalidArgument) {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to update session")
			return
		}
	}

	response, err := api.sessionResponse(r.Context(), session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session activity")
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (api API) archiveSessionHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}
	if session.Status == store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "running session cannot be archived")
		return
	}

	archived, err := api.store.ArchiveSession(r.Context(), store.ArchiveSessionParams{ID: session.ID})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to archive session")
		return
	}

	response, err := api.sessionResponse(r.Context(), archived)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session activity")
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (api API) restoreSessionHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	restored, err := api.store.RestoreSession(r.Context(), store.RestoreSessionParams{ID: sessionID})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to restore session")
		return
	}

	response, err := api.sessionResponse(r.Context(), restored)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session activity")
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (api API) sessionResponses(ctx context.Context, sessions []store.Session) ([]sessionResponse, error) {
	responses := make([]sessionResponse, 0, len(sessions))
	for _, session := range sessions {
		response, err := api.sessionResponse(ctx, session)
		if err != nil {
			return nil, err
		}
		responses = append(responses, response)
	}
	return responses, nil
}

func (api API) sessionResponse(ctx context.Context, session store.Session) (sessionResponse, error) {
	pendingInput := false
	if session.Status == store.SessionStatusRunning {
		var err error
		pendingInput, err = api.sessionHasPendingInput(ctx, session.ID)
		if err != nil {
			return sessionResponse{}, err
		}
	}
	return sessionResponseFromStore(session, pendingInput), nil
}

func sessionResponseFromStore(session store.Session, pendingInput bool) sessionResponse {
	var completedAt *string
	if session.CompletedAt != nil {
		formatted := session.CompletedAt.UTC().Format(time.RFC3339Nano)
		completedAt = &formatted
	}
	var archivedAt *string
	if session.ArchivedAt != nil {
		formatted := session.ArchivedAt.UTC().Format(time.RFC3339Nano)
		archivedAt = &formatted
	}

	agentOptions := map[string]any{}
	if len(session.AgentOptions) > 0 {
		_ = json.Unmarshal(session.AgentOptions, &agentOptions)
	}

	return sessionResponse{
		ID:                session.ID,
		Title:             session.Title,
		AgentType:         session.AgentType,
		Status:            string(session.Status),
		ProviderSessionID: session.ProviderSessionID,
		WorkspacePath:     session.WorkspacePath,
		AgentOptions:      agentOptions,
		EventCount:        session.EventCount,
		LastEventSeq:      session.EventCount,
		ToolCount:         session.ToolCount,
		PendingInput:      pendingInput,
		CreatedAt:         session.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:         session.UpdatedAt.UTC().Format(time.RFC3339Nano),
		CompletedAt:       completedAt,
		ArchivedAt:        archivedAt,
	}
}

func (api API) sessionHasPendingInput(ctx context.Context, sessionID string) (bool, error) {
	events, err := api.eventsSinceLatestTerminal(ctx, sessionID)
	if err != nil {
		return false, err
	}

	pending := make(map[string]bool)
	for _, event := range events {
		switch event.Type {
		case "agent.input.requested":
			requestID := rawPayloadString(event.Payload, "request_id")
			if requestID != "" {
				pending[requestID] = true
			}
		case "agent.input.answered":
			requestID := rawPayloadString(event.Payload, "request_id")
			if requestID != "" {
				delete(pending, requestID)
			}
		default:
			if isTerminalRunEvent(event.Type) {
				clear(pending)
			}
		}
	}

	return len(pending) > 0, nil
}

func (api API) eventsSinceLatestTerminal(ctx context.Context, sessionID string) ([]store.Event, error) {
	collected := make([]store.Event, 0)
	beforeSeq := int64(0)

	for {
		var (
			page []store.Event
			err  error
		)
		if beforeSeq == 0 {
			page, err = api.store.ListRecentEvents(ctx, sessionID, maxEventLimit)
		} else {
			page, err = api.store.ListEventsBefore(ctx, sessionID, beforeSeq, maxEventLimit)
		}
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			return collected, nil
		}

		for i := len(page) - 1; i >= 0; i-- {
			if isTerminalRunEvent(page[i].Type) {
				return append(append([]store.Event(nil), page[i+1:]...), collected...), nil
			}
		}

		collected = append(append([]store.Event(nil), page...), collected...)
		if page[0].Seq <= 1 {
			return collected, nil
		}
		beforeSeq = page[0].Seq
	}
}

func rawPayloadString(payload json.RawMessage, key string) string {
	if len(payload) == 0 {
		return ""
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return ""
	}
	value, _ := decoded[key].(string)
	return strings.TrimSpace(value)
}

func createSessionAgentOptions(agentType string, options *createAgentOptions) (json.RawMessage, error) {
	if options == nil || options.Codex == nil && options.Claude == nil {
		return json.RawMessage(`{}`), nil
	}
	if options.Codex != nil && agentType != "codex" {
		return nil, fmt.Errorf("codex options require a codex session")
	}
	if options.Claude != nil && agentType != "claude" {
		return nil, fmt.Errorf("claude options require a claude session")
	}

	agentOptions := map[string]any{}
	if options.Codex != nil {
		codexOptions := map[string]any{}
		if options.Codex.RunDangerously {
			codexOptions["run_dangerously"] = true
		}
		if len(codexOptions) > 0 {
			agentOptions["codex"] = codexOptions
		}
	}
	if options.Claude != nil {
		claudeOptions := map[string]any{}
		if options.Claude.RunDangerously {
			claudeOptions["run_dangerously"] = true
		}
		if len(claudeOptions) > 0 {
			agentOptions["claude"] = claudeOptions
		}
	}

	encoded, err := json.Marshal(agentOptions)
	if err != nil {
		return nil, fmt.Errorf("marshal agent options: %w", err)
	}
	return encoded, nil
}

func submitOptionsMetadata(agentType string, sessionAgentOptions json.RawMessage, options *submitAgentOptions) (map[string]any, map[string]any, error) {
	metadata := map[string]any{
		"agent_type": agentType,
	}
	codexOptions := map[string]any{}
	claudeOptions := map[string]any{}
	if len(sessionAgentOptions) > 0 {
		var persisted map[string]map[string]any
		if err := json.Unmarshal(sessionAgentOptions, &persisted); err != nil {
			return nil, nil, fmt.Errorf("session agent options are invalid")
		}
		for key, value := range persisted["codex"] {
			codexOptions[key] = value
		}
		for key, value := range persisted["claude"] {
			claudeOptions[key] = value
		}
	}
	if options == nil || options.Codex == nil && options.Claude == nil {
		responseOptions := map[string]any{}
		if len(codexOptions) > 0 {
			metadata["codex_options"] = codexOptions
			responseOptions["codex"] = codexOptions
		}
		if len(claudeOptions) > 0 {
			metadata["claude_options"] = claudeOptions
			responseOptions["claude"] = claudeOptions
		}
		if len(responseOptions) == 0 {
			return metadata, nil, nil
		}
		return metadata, responseOptions, nil
	}
	if options.Codex == nil {
		if options.Claude == nil {
			return metadata, nil, nil
		}
		if agentType != "claude" {
			return nil, nil, fmt.Errorf("claude options require a claude session")
		}
		claudeOptions["model"] = strings.TrimSpace(options.Claude.Model)
		claudeOptions["effort"] = strings.TrimSpace(options.Claude.Effort)
		claudeOptions["planning_mode"] = options.Claude.PlanningMode
		if options.Claude.PlanningMode {
			claudeOptions["permission_mode"] = "plan"
		} else {
			claudeOptions["permission_mode"] = ""
		}
		metadata["claude_options"] = claudeOptions
		return metadata, map[string]any{"claude": claudeOptions}, nil
	}
	if agentType != "codex" {
		return nil, nil, fmt.Errorf("codex options require a codex session")
	}

	codexOptions["model"] = strings.TrimSpace(options.Codex.Model)
	codexOptions["reasoning_effort"] = strings.TrimSpace(options.Codex.ReasoningEffort)
	codexOptions["fast_mode"] = options.Codex.FastMode
	codexOptions["planning_mode"] = options.Codex.PlanningMode
	codexOptions["service_tier"] = strings.TrimSpace(options.Codex.ServiceTier)
	metadata["codex_options"] = codexOptions
	return metadata, map[string]any{"codex": codexOptions}, nil
}

func validateSubmitAttachments(attachments []submitAttachment) ([]agents.Attachment, error) {
	if len(attachments) > maxSubmitAttachments {
		return nil, fmt.Errorf("too many attachments: maximum is %d", maxSubmitAttachments)
	}

	normalized := make([]agents.Attachment, 0, len(attachments))
	for index, attachment := range attachments {
		name := strings.TrimSpace(attachment.Name)
		if name == "" {
			name = fmt.Sprintf("image-%d", index+1)
		}
		mediaType := strings.TrimSpace(attachment.MediaType)
		dataURL := strings.TrimSpace(attachment.DataURL)
		if mediaType == "" {
			return nil, fmt.Errorf("attachment %d media_type is required", index+1)
		}
		if !strings.HasPrefix(mediaType, "image/") {
			return nil, fmt.Errorf("attachment %d must be an image", index+1)
		}
		if dataURL == "" {
			return nil, fmt.Errorf("attachment %d data_url is required", index+1)
		}
		if err := validateImageDataURL(dataURL, mediaType); err != nil {
			return nil, fmt.Errorf("attachment %d %v", index+1, err)
		}

		sizeBytes := attachment.SizeBytes
		if sizeBytes <= 0 {
			sizeBytes = dataURLDecodedBytes(dataURL)
		}
		if sizeBytes <= 0 {
			return nil, fmt.Errorf("attachment %d size is required", index+1)
		}
		if sizeBytes > maxSubmitAttachmentBytes {
			return nil, fmt.Errorf("attachment %d exceeds %d MB", index+1, maxSubmitAttachmentBytes/(1024*1024))
		}

		normalized = append(normalized, agents.Attachment{
			Name:      name,
			MediaType: mediaType,
			DataURL:   dataURL,
			SizeBytes: sizeBytes,
		})
	}
	return normalized, nil
}

func validateImageDataURL(dataURL string, mediaType string) error {
	header, payload, ok := strings.Cut(dataURL, ",")
	if !ok || !strings.HasPrefix(header, "data:") {
		return errors.New("must be a data URL")
	}
	headerMediaType := strings.TrimPrefix(strings.SplitN(header, ";", 2)[0], "data:")
	if headerMediaType != mediaType {
		return fmt.Errorf("data URL media type %q does not match %q", headerMediaType, mediaType)
	}
	if !strings.Contains(header, ";base64") {
		return errors.New("must be base64 encoded")
	}
	if payload == "" {
		return errors.New("has empty data")
	}
	if _, err := base64.StdEncoding.DecodeString(payload); err != nil {
		return errors.New("has invalid base64 data")
	}
	return nil
}

func dataURLDecodedBytes(dataURL string) int64 {
	_, payload, ok := strings.Cut(dataURL, ",")
	if !ok {
		return 0
	}
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return 0
	}
	return int64(len(decoded))
}

func (api API) submitMessageHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	var request submitMessageRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}

	content := strings.TrimSpace(request.Content)
	attachments, err := validateSubmitAttachments(request.Attachments)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if content == "" && len(attachments) == 0 {
		writeError(w, http.StatusBadRequest, "content or attachments are required")
		return
	}

	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}

	if session.ArchivedAt != nil {
		writeError(w, http.StatusConflict, "session is archived")
		return
	}
	if request.Queue || session.Status == store.SessionStatusRunning {
		if len(attachments) > 0 {
			writeError(w, http.StatusBadRequest, "queued messages cannot include image attachments")
			return
		}
		queued, ok := api.enqueueSessionMessage(w, r, session, content, request.AgentOptions)
		if !ok {
			return
		}
		writeJSON(w, http.StatusAccepted, submitMessageResponse{
			SessionID:     session.ID,
			Status:        string(session.Status),
			AcceptedAs:    "queued",
			QueuedMessage: queuedMessageToResponse(queued),
		})
		return
	}

	metadata, eventOptions, err := submitOptionsMetadata(session.AgentType, session.AgentOptions, request.AgentOptions)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	agent, ok := api.agents.Get(session.AgentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}

	updatedSession, ok := api.startSessionRun(
		w,
		r,
		session,
		content,
		attachments,
		agent,
		metadata,
		agents.AgentActionMessage,
		func(ctx context.Context) error {
			return api.appendUserMessage(ctx, session.ID, content, attachments, eventOptions, "")
		},
		"failed to persist user message",
	)
	if !ok {
		return
	}

	writeJSON(w, http.StatusAccepted, submitMessageResponse{
		SessionID:  updatedSession.ID,
		Status:     string(updatedSession.Status),
		AcceptedAs: "run",
	})
}

func (api API) listQueuedMessagesHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if _, err := api.store.GetSession(r.Context(), sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}

	messages, err := api.store.ListQueuedMessages(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load queued messages")
		return
	}
	response := queuedMessagesResponse{Messages: make([]queuedMessageResponse, 0, len(messages))}
	for _, message := range messages {
		response.Messages = append(response.Messages, *queuedMessageToResponse(message))
	}
	writeJSON(w, http.StatusOK, response)
}

func (api API) removeQueuedMessageHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	messageID := chi.URLParam(r, "queuedMessageId")

	removed, err := api.store.RemoveQueuedMessage(r.Context(), store.QueueMessageIDParams{
		SessionID: sessionID,
		ID:        messageID,
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "queued message not found")
			return
		}
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to remove queued message")
		return
	}
	if err := api.appendQueuedMessageRemoved(r.Context(), removed); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist queued message removal")
		return
	}
	writeJSON(w, http.StatusOK, queuedMessageToResponse(removed))
}

func (api API) enqueueSessionMessage(
	w http.ResponseWriter,
	r *http.Request,
	session store.Session,
	content string,
	options *submitAgentOptions,
) (store.QueuedMessage, bool) {
	if _, _, err := submitOptionsMetadata(session.AgentType, session.AgentOptions, options); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return store.QueuedMessage{}, false
	}
	rawOptions, err := json.Marshal(optionsOrEmpty(options))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode queued message options")
		return store.QueuedMessage{}, false
	}

	queued, err := api.store.EnqueueMessage(r.Context(), store.EnqueueMessageParams{
		SessionID:    session.ID,
		Content:      content,
		AgentOptions: rawOptions,
		MaxPending:   maxQueuedMessages,
	})
	if err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return store.QueuedMessage{}, false
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return store.QueuedMessage{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to queue message")
		return store.QueuedMessage{}, false
	}
	if err := api.appendQueuedMessageQueued(r.Context(), queued); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist queued message event")
		return store.QueuedMessage{}, false
	}
	return queued, true
}

func optionsOrEmpty(options *submitAgentOptions) any {
	if options == nil {
		return map[string]any{}
	}
	return options
}

func decodeAgentOptions(raw json.RawMessage) any {
	agentOptions := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &agentOptions)
	}
	return agentOptions
}

func queuedMessageToResponse(message store.QueuedMessage) *queuedMessageResponse {
	return &queuedMessageResponse{
		ID:           message.ID,
		SessionID:    message.SessionID,
		Seq:          message.Seq,
		Content:      message.Content,
		AgentOptions: decodeAgentOptions(message.AgentOptions),
		CreatedAt:    message.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (api API) clearSessionHandler(w http.ResponseWriter, r *http.Request) {
	if !validateEmptyBody(w, r, string(agents.AgentActionClear)) {
		return
	}

	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}
	if session.Status == store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "session is already running")
		return
	}
	if session.ArchivedAt != nil {
		writeError(w, http.StatusConflict, "session is archived")
		return
	}
	if session.AgentType != "codex" {
		writeError(w, http.StatusBadRequest, "session action requires a codex session")
		return
	}

	clearedSession, err := api.store.ClearSessionProviderSessionID(r.Context(), store.ClearSessionProviderSessionIDParams{ID: session.ID})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to clear session context")
		return
	}
	if err := api.appendSessionAction(r.Context(), session.ID, agents.AgentActionClear); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist session action")
		return
	}
	if clearedSession.Status != store.SessionStatusIdle {
		clearedSession, err = api.updateSessionStatus(r.Context(), store.UpdateSessionStatusParams{
			ID:     clearedSession.ID,
			Status: store.SessionStatusIdle,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to mark session idle")
			return
		}
	}

	writeJSON(w, http.StatusAccepted, submitMessageResponse{
		SessionID: clearedSession.ID,
		Status:    string(clearedSession.Status),
	})
}

func (api API) compactSessionHandler(w http.ResponseWriter, r *http.Request) {
	api.compactSessionActionHandler(w, r)
}

func (api API) compactSessionActionHandler(w http.ResponseWriter, r *http.Request) {
	if !validateEmptyBody(w, r, string(agents.AgentActionCompact)) {
		return
	}

	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}
	if session.Status == store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "session is already running")
		return
	}
	if session.ArchivedAt != nil {
		writeError(w, http.StatusConflict, "session is archived")
		return
	}
	if session.AgentType != "codex" {
		writeError(w, http.StatusBadRequest, "session action requires a codex session")
		return
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		writeError(w, http.StatusConflict, "session has no codex thread to compact")
		return
	}

	metadata, _, err := submitOptionsMetadata(session.AgentType, session.AgentOptions, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	metadata["agent_action"] = string(agents.AgentActionCompact)

	agent, ok := api.agents.Get(session.AgentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}

	updatedSession, ok := api.startSessionRun(
		w,
		r,
		session,
		"",
		nil,
		agent,
		metadata,
		agents.AgentActionCompact,
		func(ctx context.Context) error {
			return api.appendSessionAction(ctx, session.ID, agents.AgentActionCompact)
		},
		"failed to persist session action",
	)
	if !ok {
		return
	}

	writeJSON(w, http.StatusAccepted, submitMessageResponse{
		SessionID: updatedSession.ID,
		Status:    string(updatedSession.Status),
	})
}

func (api API) startSessionRun(
	w http.ResponseWriter,
	r *http.Request,
	session store.Session,
	message string,
	attachments []agents.Attachment,
	agent agents.Agent,
	metadata map[string]any,
	action agents.AgentAction,
	appendBeforeRun func(context.Context) error,
	appendErrorMessage string,
) (store.Session, bool) {
	runCtx, cleanup, err := api.runs.Register(context.Background(), session.ID)
	if err != nil {
		if errors.Is(err, runcontrol.ErrRunAlreadyActive) {
			writeError(w, http.StatusConflict, "session is already running")
			return store.Session{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to register run")
		return store.Session{}, false
	}

	if appendBeforeRun != nil {
		if err := appendBeforeRun(r.Context()); err != nil {
			cleanup()
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "session not found")
				return store.Session{}, false
			}
			if errors.Is(err, store.ErrInvalidArgument) {
				writeError(w, http.StatusBadRequest, err.Error())
				return store.Session{}, false
			}
			writeError(w, http.StatusInternalServerError, appendErrorMessage)
			return store.Session{}, false
		}
	}

	updatedSession, err := api.store.UpdateSessionStatus(r.Context(), store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	})
	if err != nil {
		cleanup()
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return store.Session{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to mark session running")
		return store.Session{}, false
	}
	if err := api.appendSessionStatusUpdated(r.Context(), updatedSession); err != nil {
		cleanup()
		writeError(w, http.StatusInternalServerError, "failed to emit session status")
		return store.Session{}, false
	}

	go func() {
		completed := api.runAgent(runCtx, updatedSession, message, attachments, agent, metadata, action)
		cleanup()
		if completed {
			api.startQueuedMessageRun(context.Background(), session.ID)
		}
	}()

	return updatedSession, true
}

func (api API) startQueuedMessageRun(ctx context.Context, sessionID string) bool {
	queued, err := api.store.ClaimNextQueuedMessage(ctx, sessionID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("failed to claim queued message: session_id=%s error=%v", sessionID, err)
		}
		return false
	}
	release := func() {
		if _, releaseErr := api.store.ReleaseQueuedMessage(context.Background(), store.QueueMessageIDParams{
			SessionID: queued.SessionID,
			ID:        queued.ID,
		}); releaseErr != nil {
			log.Printf("failed to release queued message: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, releaseErr)
		}
	}

	session, err := api.store.GetSession(ctx, queued.SessionID)
	if err != nil {
		log.Printf("failed to load queued message session: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}
	if session.Status != store.SessionStatusIdle || session.ArchivedAt != nil {
		release()
		return false
	}

	var queuedOptions submitAgentOptions
	if len(queued.AgentOptions) > 0 {
		if err := json.Unmarshal(queued.AgentOptions, &queuedOptions); err != nil {
			log.Printf("failed to decode queued message options: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
			release()
			return false
		}
	}
	metadata, eventOptions, err := submitOptionsMetadata(session.AgentType, session.AgentOptions, &queuedOptions)
	if err != nil {
		log.Printf("failed to prepare queued message options: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}

	agent, ok := api.agents.Get(session.AgentType)
	if !ok {
		log.Printf("queued message agent unavailable: session_id=%s queue_item_id=%s agent_type=%s", queued.SessionID, queued.ID, session.AgentType)
		release()
		return false
	}
	if availability, ok := agent.(agents.Availability); ok {
		if err := availability.Available(); err != nil {
			log.Printf("queued message agent unavailable: session_id=%s queue_item_id=%s agent_type=%s error=%v", queued.SessionID, queued.ID, session.AgentType, err)
			release()
			return false
		}
	}

	runCtx, cleanup, err := api.runs.Register(context.Background(), session.ID)
	if err != nil {
		if !errors.Is(err, runcontrol.ErrRunAlreadyActive) {
			log.Printf("failed to register queued message run: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		}
		release()
		return false
	}

	if err := api.appendUserMessage(ctx, session.ID, queued.Content, nil, eventOptions, queued.ID); err != nil {
		cleanup()
		log.Printf("failed to append queued user message: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}
	updatedSession, err := api.store.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	})
	if err != nil {
		cleanup()
		log.Printf("failed to mark queued session running: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}
	if err := api.appendSessionStatusUpdated(ctx, updatedSession); err != nil {
		cleanup()
		log.Printf("failed to emit queued session status: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}
	if _, err := api.store.MarkQueuedMessageSent(ctx, store.QueueMessageIDParams{
		SessionID: queued.SessionID,
		ID:        queued.ID,
	}); err != nil {
		cleanup()
		log.Printf("failed to mark queued message sent: session_id=%s queue_item_id=%s error=%v", queued.SessionID, queued.ID, err)
		release()
		return false
	}

	go func() {
		completed := api.runAgent(runCtx, updatedSession, queued.Content, nil, agent, metadata, agents.AgentActionMessage)
		cleanup()
		if completed {
			api.startQueuedMessageRun(context.Background(), session.ID)
		}
	}()
	return true
}

func (api API) cancelSessionHandler(w http.ResponseWriter, r *http.Request) {
	if !validateCancelBody(w, r) {
		return
	}

	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}

	if session.Status != store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "session is not running")
		return
	}

	if err := api.runs.Cancel(session.ID); err != nil {
		if errors.Is(err, runcontrol.ErrRunAlreadyCanceled) {
			writeError(w, http.StatusConflict, "session cancellation already requested")
			return
		}
		if errors.Is(err, runcontrol.ErrRunNotActive) {
			updatedSession, ok := api.failRunningSessionWithoutActiveRun(r.Context(), session)
			if !ok {
				writeError(w, http.StatusInternalServerError, "failed to repair stale run")
				return
			}
			writeJSON(w, http.StatusAccepted, submitMessageResponse{
				SessionID: updatedSession.ID,
				Status:    string(updatedSession.Status),
			})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to cancel session")
		return
	}

	writeJSON(w, http.StatusAccepted, cancelSessionResponse{
		SessionID: session.ID,
		Status:    "cancelling",
	})
}

func (api API) answerUserInputHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	requestID := chi.URLParam(r, "requestId")

	var request answerUserInputRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if len(request.Answers) == 0 {
		writeError(w, http.StatusBadRequest, "answers are required")
		return
	}

	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}
	if session.Status != store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "session is not running")
		return
	}

	pending, err := api.runs.PendingUserInput(session.ID, requestID)
	if err != nil {
		if errors.Is(err, runcontrol.ErrRunNotActive) || errors.Is(err, runcontrol.ErrUserInputNotActive) {
			writeError(w, http.StatusConflict, "user input request is not active")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load user input request")
		return
	}
	if err := validateUserInputAnswers(pending, request.Answers); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := api.appendUserInputAnswered(r.Context(), session.ID, pending, request.Answers); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist user input answer")
		return
	}
	if err := api.runs.AnswerUserInput(session.ID, pending.RequestID, agents.UserInputResponse{Answers: request.Answers}); err != nil {
		if errors.Is(err, runcontrol.ErrRunNotActive) || errors.Is(err, runcontrol.ErrUserInputNotActive) {
			writeError(w, http.StatusConflict, "user input request is not active")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to answer user input request")
		return
	}

	writeJSON(w, http.StatusAccepted, answerUserInputResponse{
		SessionID: session.ID,
		RequestID: pending.RequestID,
		Status:    "answered",
	})
}

func (api API) appendUserMessage(
	ctx context.Context,
	sessionID string,
	content string,
	attachments []agents.Attachment,
	agentOptions map[string]any,
	queueItemID string,
) error {
	payloadValue := map[string]any{"text": content}
	if len(attachments) > 0 {
		payloadValue["attachments"] = attachments
	}
	if len(agentOptions) > 0 {
		payloadValue["agent_options"] = agentOptions
	}
	if strings.TrimSpace(queueItemID) != "" {
		payloadValue["queue_item_id"] = strings.TrimSpace(queueItemID)
	}

	payload, err := json.Marshal(payloadValue)
	if err != nil {
		return fmt.Errorf("marshal user message payload: %w", err)
	}

	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: sessionID,
		Type:      "user.message.completed",
		Role:      "user",
		Status:    store.EventStatusCompleted,
		Payload:   payload,
	})
	return err
}

func (api API) appendQueuedMessageQueued(ctx context.Context, message store.QueuedMessage) error {
	payload, err := json.Marshal(map[string]any{
		"queue_item_id": message.ID,
		"text":          message.Content,
		"agent_options": decodeAgentOptions(message.AgentOptions),
	})
	if err != nil {
		return fmt.Errorf("marshal queued message payload: %w", err)
	}
	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: message.SessionID,
		Type:      "user.message.queued",
		Role:      "user",
		Status:    store.EventStatusCompleted,
		Payload:   payload,
	})
	return err
}

func (api API) appendQueuedMessageRemoved(ctx context.Context, message store.QueuedMessage) error {
	payload, err := json.Marshal(map[string]any{
		"queue_item_id": message.ID,
		"text":          message.Content,
	})
	if err != nil {
		return fmt.Errorf("marshal queued message removed payload: %w", err)
	}
	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: message.SessionID,
		Type:      "user.message.queue.removed",
		Role:      "user",
		Status:    store.EventStatusCompleted,
		Payload:   payload,
	})
	return err
}

func (api API) appendSessionAction(ctx context.Context, sessionID string, action agents.AgentAction) error {
	payloadValue := map[string]any{
		"action": string(action),
		"text":   userActionText(action),
	}
	payload, err := json.Marshal(payloadValue)
	if err != nil {
		return fmt.Errorf("marshal user action payload: %w", err)
	}

	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: sessionID,
		Type:      "session.action.completed",
		Role:      "system",
		Status:    store.EventStatusCompleted,
		Payload:   payload,
	})
	return err
}

func userActionText(action agents.AgentAction) string {
	switch action {
	case agents.AgentActionClear:
		return "Clear context"
	case agents.AgentActionCompact:
		return "Compact context"
	default:
		return "Session action"
	}
}

func (api API) appendUserInputAnswered(
	ctx context.Context,
	sessionID string,
	request agents.UserInputRequest,
	answers map[string]agents.UserInputQuestionAnswer,
) error {
	return api.appendAgentEvent(ctx, sessionID, agents.AgentEvent{
		Type:   "agent.input.answered",
		Role:   "user",
		Status: string(store.EventStatusCompleted),
		Payload: map[string]any{
			"provider":            request.Provider,
			"provider_event_type": request.ProviderEventType,
			"provider_request_id": request.ProviderRequestID,
			"request_id":          request.RequestID,
			"thread_id":           request.ThreadID,
			"turn_id":             request.TurnID,
			"item_id":             request.ItemID,
			"answers":             userInputAnsweredPayload(request, answers),
		},
	})
}

func (api API) runAgent(
	ctx context.Context,
	session store.Session,
	message string,
	attachments []agents.Attachment,
	agent agents.Agent,
	metadata map[string]any,
	action agents.AgentAction,
) bool {
	terminalEventEmitted := false
	emit := func(ctx context.Context, event agents.AgentEvent) error {
		terminalEvent := isTerminalRunEvent(event.Type)
		if terminalEvent && terminalEventEmitted {
			return fmt.Errorf("terminal run event already emitted for session %s", session.ID)
		}

		updatedSession, err := api.persistProviderSessionIDFromEvent(ctx, session, event, action)
		if err != nil {
			return err
		}
		session = updatedSession

		if err := api.appendAgentEvent(ctx, session.ID, event); err != nil {
			return err
		}
		if terminalEvent {
			terminalEventEmitted = true
		}
		return nil
	}

	err := agent.Run(ctx, agents.AgentInput{
		SessionID:         session.ID,
		ProviderSessionID: session.ProviderSessionID,
		Action:            action,
		Message:           message,
		Workdir:           sessionWorkspacePath(session, api.workdir),
		Metadata:          metadata,
		Attachments:       attachments,
		UserInput:         api.runs,
	}, emit)
	if errors.Is(err, context.Canceled) {
		if !terminalEventEmitted {
			if appendErr := api.appendAgentRunCancelled(context.Background(), session.ID, agent.Type()); appendErr != nil {
				log.Printf("failed to append agent.run.cancelled: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
			} else {
				terminalEventEmitted = true
			}
		}
		if _, updateErr := api.updateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusIdle,
		}); updateErr != nil {
			log.Printf("failed to mark session idle after cancellation: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
		}
		return false
	}
	if err != nil {
		log.Printf("agent run failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), err)

		if !terminalEventEmitted {
			if appendErr := api.appendAgentRunFailed(context.Background(), session.ID, agent.Type(), err); appendErr != nil {
				log.Printf("failed to append agent.run.failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
			} else {
				terminalEventEmitted = true
			}
		}
		if _, updateErr := api.updateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusFailed,
		}); updateErr != nil {
			log.Printf("failed to mark session failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
		}
		return false
	}

	if !terminalEventEmitted {
		if appendErr := api.appendAgentRunCompleted(context.Background(), session.ID, agent.Type()); appendErr != nil {
			log.Printf("failed to append agent.run.completed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
			if _, updateErr := api.updateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
				ID:     session.ID,
				Status: store.SessionStatusFailed,
			}); updateErr != nil {
				log.Printf("failed to mark session failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
			}
			return false
		}
	}

	if _, err := api.updateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusIdle,
	}); err != nil {
		log.Printf("failed to mark session idle after completion: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), err)
		return false
	}
	return true
}

func (api API) persistProviderSessionIDFromEvent(
	ctx context.Context,
	session store.Session,
	event agents.AgentEvent,
	action agents.AgentAction,
) (store.Session, error) {
	providerSessionID := providerSessionIDFromAgentEvent(session.AgentType, event)
	if providerSessionID == "" {
		return session, nil
	}
	if session.ProviderSessionID != "" {
		if session.ProviderSessionID != providerSessionID {
			if action == agents.AgentActionClear {
				return api.store.SetSessionProviderSessionID(ctx, store.SetSessionProviderSessionIDParams{
					ID:                session.ID,
					ProviderSessionID: providerSessionID,
					Replace:           true,
				})
			}
			return store.Session{}, fmt.Errorf("provider session mismatch for session %s: existing %q, event %q", session.ID, session.ProviderSessionID, providerSessionID)
		}
		return session, nil
	}
	return api.store.SetSessionProviderSessionID(ctx, store.SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: providerSessionID,
		Replace:           action == agents.AgentActionClear,
	})
}

func providerSessionIDFromAgentEvent(agentType string, event agents.AgentEvent) string {
	if event.Type != "agent.run.started" {
		return ""
	}
	payload, ok := event.Payload.(map[string]any)
	if !ok {
		return ""
	}
	switch agentType {
	case "codex":
		if payloadString(payload, "provider") != "codex" {
			return ""
		}
		switch payloadString(payload, "provider_event_type") {
		case "thread/start", "thread/resume", "thread/started", "thread/resumed":
			return payloadString(payload, "thread_id")
		default:
			return ""
		}
	case "claude":
		if payloadString(payload, "provider") != "claude" || payloadString(payload, "provider_event_type") != "system/init" {
			return ""
		}
		return payloadString(payload, "provider_session_id")
	default:
		return ""
	}
}

func payloadString(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func (api API) updateSessionStatus(ctx context.Context, params store.UpdateSessionStatusParams) (store.Session, error) {
	session, err := api.store.UpdateSessionStatus(ctx, params)
	if err != nil {
		return store.Session{}, err
	}
	if err := api.appendSessionStatusUpdated(ctx, session); err != nil {
		return session, err
	}
	return session, nil
}

func (api API) appendAgentEvent(ctx context.Context, sessionID string, event agents.AgentEvent) error {
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" {
		return fmt.Errorf("agent event type is required")
	}

	eventStatus := store.EventStatus(strings.TrimSpace(event.Status))
	if eventStatus == "" {
		return fmt.Errorf("agent event status is required")
	}

	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return fmt.Errorf("marshal agent event payload: %w", err)
	}

	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: sessionID,
		Type:      eventType,
		Role:      strings.TrimSpace(event.Role),
		Status:    eventStatus,
		Payload:   payload,
	})
	return err
}

func (api API) appendSessionStatusUpdated(ctx context.Context, session store.Session) error {
	payload := map[string]any{
		"status":     string(session.Status),
		"updated_at": session.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if session.CompletedAt != nil {
		payload["completed_at"] = session.CompletedAt.UTC().Format(time.RFC3339Nano)
	} else {
		payload["completed_at"] = nil
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal session status payload: %w", err)
	}

	_, err = api.events.Append(ctx, eventservice.AppendParams{
		SessionID: session.ID,
		Type:      "session.status.updated",
		Role:      "system",
		Status:    eventStatusForSessionStatus(session.Status),
		Payload:   encoded,
	})
	return err
}

func eventStatusForSessionStatus(status store.SessionStatus) store.EventStatus {
	switch status {
	case store.SessionStatusRunning:
		return store.EventStatusStarted
	case store.SessionStatusFailed:
		return store.EventStatusFailed
	default:
		return store.EventStatusCompleted
	}
}

func (api API) appendAgentRunFailed(ctx context.Context, sessionID string, agentType string, runErr error) error {
	return api.appendAgentEvent(ctx, sessionID, agents.AgentEvent{
		Type:   "agent.run.failed",
		Role:   "assistant",
		Status: string(store.EventStatusFailed),
		Payload: map[string]any{
			"agent_type": agentType,
			"error":      runErr.Error(),
		},
	})
}

func (api API) appendAgentRunCompleted(ctx context.Context, sessionID string, agentType string) error {
	return api.appendAgentEvent(ctx, sessionID, agents.AgentEvent{
		Type:   "agent.run.completed",
		Role:   "assistant",
		Status: string(store.EventStatusCompleted),
		Payload: map[string]any{
			"agent_type": agentType,
		},
	})
}

func (api API) appendAgentRunCancelled(ctx context.Context, sessionID string, agentType string) error {
	return api.appendAgentEvent(ctx, sessionID, agents.AgentEvent{
		Type:   "agent.run.cancelled",
		Role:   "assistant",
		Status: string(store.EventStatusCancelled),
		Payload: map[string]any{
			"agent_type": agentType,
		},
	})
}

func (api API) failRunningSessionWithoutActiveRun(ctx context.Context, session store.Session) (store.Session, bool) {
	err := fmt.Errorf("running session has no active run")
	if appendErr := api.appendAgentRunFailed(ctx, session.ID, session.AgentType, err); appendErr != nil {
		log.Printf("failed to append agent.run.failed for missing active run: session_id=%s agent_type=%s error=%v", session.ID, session.AgentType, appendErr)
	}
	updatedSession, updateErr := api.updateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusFailed,
	})
	if updateErr != nil {
		log.Printf("failed to mark session failed for missing active run: session_id=%s agent_type=%s error=%v", session.ID, session.AgentType, updateErr)
		return store.Session{}, false
	}
	return updatedSession, true
}

func (api API) agentAvailable(w http.ResponseWriter, agent agents.Agent) bool {
	availability, ok := agent.(agents.Availability)
	if !ok {
		return true
	}
	if err := availability.Available(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "agent unavailable")
		return false
	}
	return true
}

func parseSessionLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultSessionLimit, true
	}

	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 0 {
		writeError(w, http.StatusBadRequest, "limit must be a non-negative integer")
		return 0, false
	}
	if limit > maxSessionLimit {
		return maxSessionLimit, true
	}

	return limit, true
}

func parseSessionStatus(w http.ResponseWriter, r *http.Request) (store.SessionStatus, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("status"))
	if raw == "" {
		return "", true
	}

	status := store.SessionStatus(raw)
	switch status {
	case store.SessionStatusIdle,
		store.SessionStatusRunning,
		store.SessionStatusFailed:
		return status, true
	default:
		writeError(w, http.StatusBadRequest, "status is unsupported")
		return "", false
	}
}

func parseIncludeArchived(w http.ResponseWriter, r *http.Request) (bool, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("include_archived"))
	if raw == "" {
		return false, true
	}

	includeArchived, err := strconv.ParseBool(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "include_archived must be a boolean")
		return false, false
	}

	return includeArchived, true
}

func isTerminalRunEvent(eventType string) bool {
	switch eventType {
	case "agent.run.completed", "agent.run.failed", "agent.run.cancelled":
		return true
	default:
		return false
	}
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != nil {
		if !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return false
		}
		return true
	}

	writeError(w, http.StatusBadRequest, "invalid JSON body")
	return false
}

func validateCancelBody(w http.ResponseWriter, r *http.Request) bool {
	return validateEmptyBody(w, r, "cancel")
}

func validateEmptyBody(w http.ResponseWriter, r *http.Request, requestName string) bool {
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		return true
	}

	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return false
	}
	if len(body) > 0 {
		writeError(w, http.StatusBadRequest, requestName+" request body must be empty")
		return false
	}

	return true
}

func validateUserInputAnswers(request agents.UserInputRequest, answers map[string]agents.UserInputQuestionAnswer) error {
	questionsByID := make(map[string]agents.UserInputQuestion, len(request.Questions))
	for _, question := range request.Questions {
		questionsByID[question.ID] = question
	}

	for id := range answers {
		if _, ok := questionsByID[id]; !ok {
			return fmt.Errorf("answer %q does not match a pending question", id)
		}
	}
	for _, question := range request.Questions {
		answer, ok := answers[question.ID]
		if !ok {
			return fmt.Errorf("answer %q is required", question.ID)
		}
		if len(answer.Answers) != 1 {
			return fmt.Errorf("answer %q must include exactly one selection", question.ID)
		}
		value := strings.TrimSpace(answer.Answers[0])
		if value == "" {
			return fmt.Errorf("answer %q cannot be empty", question.ID)
		}
		if questionAllowsAnswer(question, value) {
			continue
		}
		return fmt.Errorf("answer %q is not a valid option", question.ID)
	}
	return nil
}

func questionAllowsAnswer(question agents.UserInputQuestion, value string) bool {
	for _, option := range question.Options {
		if value == option.Label {
			return true
		}
	}
	return question.IsOther
}

func userInputAnsweredPayload(
	request agents.UserInputRequest,
	answers map[string]agents.UserInputQuestionAnswer,
) map[string]any {
	secretQuestions := make(map[string]bool, len(request.Questions))
	for _, question := range request.Questions {
		secretQuestions[question.ID] = question.IsSecret
	}

	payload := make(map[string]any, len(answers))
	for id, answer := range answers {
		if secretQuestions[id] {
			payload[id] = map[string]any{
				"answers":  []string{"[redacted]"},
				"redacted": true,
			}
			continue
		}
		payload[id] = answer
	}
	return payload
}
