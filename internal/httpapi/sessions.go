package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

type createSessionRequest struct {
	AgentType string `json:"agent_type"`
	Title     string `json:"title"`
}

type createSessionResponse struct {
	SessionID string `json:"session_id"`
}

type submitMessageRequest struct {
	Content string `json:"content"`
}

type submitMessageResponse struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
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
	if _, ok := api.agents.Get(agentType); !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
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

	if err := api.appendUserMessage(r.Context(), session.ID, content); err != nil {
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
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to mark session running")
		return
	}

	go api.runAgent(context.Background(), updatedSession, content, agent)

	writeJSON(w, http.StatusAccepted, submitMessageResponse{
		SessionID: updatedSession.ID,
		Status:    string(updatedSession.Status),
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
	emit := func(ctx context.Context, event agents.AgentEvent) error {
		return api.appendAgentEvent(ctx, session.ID, event)
	}

	err := agent.Run(ctx, agents.AgentInput{
		SessionID: session.ID,
		Message:   message,
		Metadata: map[string]any{
			"agent_type": agent.Type(),
		},
	}, emit)
	if err != nil {
		log.Printf("agent run failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), err)

		if appendErr := api.appendAgentRunFailed(ctx, session.ID, agent.Type(), err); appendErr != nil {
			log.Printf("failed to append agent.run.failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), appendErr)
		}
		if _, updateErr := api.store.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
			ID:     session.ID,
			Status: store.SessionStatusFailed,
		}); updateErr != nil {
			log.Printf("failed to mark session failed: session_id=%s agent_type=%s error=%v", session.ID, agent.Type(), updateErr)
		}
		return
	}

	if _, err := api.store.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
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
