package httpapi

import (
	"context"
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
	AgentType string `json:"agent_type"`
	Title     string `json:"title"`
}

type createSessionResponse struct {
	SessionID string `json:"session_id"`
}

type sessionResponse struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	AgentType   string  `json:"agent_type"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
	CompletedAt *string `json:"completed_at"`
}

type listSessionsResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

type submitMessageRequest struct {
	Content string `json:"content"`
}

type submitMessageResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

type cancelSessionResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

func (api API) listSessionsHandler(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseSessionLimit(w, r)
	if !ok {
		return
	}

	sessions, err := api.store.ListSessions(r.Context(), store.ListSessionsParams{Limit: limit})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list sessions")
		return
	}

	writeJSON(w, http.StatusOK, listSessionsResponse{Sessions: sessionResponses(sessions)})
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

	writeJSON(w, http.StatusOK, sessionResponseFromStore(session))
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

	session, err := api.store.CreateSession(r.Context(), store.CreateSessionParams{
		Title:     request.Title,
		AgentType: agentType,
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

func sessionResponses(sessions []store.Session) []sessionResponse {
	responses := make([]sessionResponse, 0, len(sessions))
	for _, session := range sessions {
		responses = append(responses, sessionResponseFromStore(session))
	}
	return responses
}

func sessionResponseFromStore(session store.Session) sessionResponse {
	var completedAt *string
	if session.CompletedAt != nil {
		formatted := session.CompletedAt.UTC().Format(time.RFC3339Nano)
		completedAt = &formatted
	}

	return sessionResponse{
		ID:          session.ID,
		Title:       session.Title,
		AgentType:   session.AgentType,
		Status:      string(session.Status),
		CreatedAt:   session.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   session.UpdatedAt.UTC().Format(time.RFC3339Nano),
		CompletedAt: completedAt,
	}
}

func (api API) submitMessageHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	var request submitMessageRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}

	content := strings.TrimSpace(request.Content)
	if content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
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

	if session.Status == store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "session is already running")
		return
	}
	if session.Status != store.SessionStatusIdle {
		writeError(w, http.StatusConflict, "session is not idle")
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

	runCtx, cleanup, err := api.runs.Register(context.Background(), session.ID)
	if err != nil {
		if errors.Is(err, runcontrol.ErrRunAlreadyActive) {
			writeError(w, http.StatusConflict, "session is already running")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to register run")
		return
	}

	if err := api.appendUserMessage(r.Context(), session.ID, content); err != nil {
		cleanup()
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to persist user message")
		return
	}

	updatedSession, err := api.store.UpdateSessionStatus(r.Context(), store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	})
	if err != nil {
		cleanup()
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to mark session running")
		return
	}

	go func() {
		defer cleanup()
		api.runAgent(runCtx, updatedSession, content, agent)
	}()

	writeJSON(w, http.StatusAccepted, submitMessageResponse{
		SessionID: updatedSession.ID,
		Status:    string(updatedSession.Status),
	})
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
			api.failRunningSessionWithoutActiveRun(r.Context(), session)
			writeError(w, http.StatusConflict, "session has no active run")
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

func (api API) appendUserMessage(ctx context.Context, sessionID string, content string) error {
	payload, err := json.Marshal(map[string]string{"text": content})
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

func (api API) runAgent(ctx context.Context, session store.Session, message string, agent agents.Agent) {
	terminalEventEmitted := false
	emit := func(ctx context.Context, event agents.AgentEvent) error {
		terminalEvent := isTerminalRunEvent(event.Type)
		if terminalEvent && terminalEventEmitted {
			return fmt.Errorf("terminal run event already emitted for session %s", session.ID)
		}

		if err := api.appendAgentEvent(ctx, session.ID, event); err != nil {
			return err
		}
		if terminalEvent {
			terminalEventEmitted = true
		}
		return nil
	}

	err := agent.Run(ctx, agents.AgentInput{
		SessionID: session.ID,
		Message:   message,
		Workdir:   api.workdir,
		Metadata: map[string]any{
			"agent_type": agent.Type(),
		},
	}, emit)
	if errors.Is(err, context.Canceled) {
		if !terminalEventEmitted {
			if appendErr := api.appendAgentRunCancelled(context.Background(), session.ID, agent.Type()); appendErr != nil {
				log.Printf("failed to append agent.run.cancelled: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
			} else {
				terminalEventEmitted = true
			}
		}
		if _, updateErr := api.store.UpdateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusCancelled,
		}); updateErr != nil {
			log.Printf("failed to mark session cancelled: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
		}
		return
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
		if _, updateErr := api.store.UpdateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusFailed,
		}); updateErr != nil {
			log.Printf("failed to mark session failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
		}
		return
	}

	if !terminalEventEmitted {
		if appendErr := api.appendAgentRunCompleted(context.Background(), session.ID, agent.Type()); appendErr != nil {
			log.Printf("failed to append agent.run.completed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
			if _, updateErr := api.store.UpdateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
				ID:     session.ID,
				Status: store.SessionStatusFailed,
			}); updateErr != nil {
				log.Printf("failed to mark session failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
			}
			return
		}
	}

	if _, err := api.store.UpdateSessionStatus(context.Background(), store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusCompleted,
	}); err != nil {
		log.Printf("failed to mark session completed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), err)
	}
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

func (api API) failRunningSessionWithoutActiveRun(ctx context.Context, session store.Session) {
	err := fmt.Errorf("running session has no active run")
	if appendErr := api.appendAgentRunFailed(ctx, session.ID, session.AgentType, err); appendErr != nil {
		log.Printf("failed to append agent.run.failed for missing active run: session_id=%s agent_type=%s error=%v", session.ID, session.AgentType, appendErr)
	}
	if _, updateErr := api.store.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusFailed,
	}); updateErr != nil {
		log.Printf("failed to mark session failed for missing active run: session_id=%s agent_type=%s error=%v", session.ID, session.AgentType, updateErr)
	}
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
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		return true
	}

	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return false
	}
	if len(body) > 0 {
		writeError(w, http.StatusBadRequest, "cancel request body must be empty")
		return false
	}

	return true
}
