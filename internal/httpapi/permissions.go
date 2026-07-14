package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

type resolvePermissionRequest struct {
	OptionID string `json:"option_id"`
}

func (api API) resolvePermissionHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	requestID := chi.URLParam(r, "requestId")
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
	var body resolvePermissionRequest
	if !decodeJSONBody(w, r, &body) {
		return
	}
	pending, err := api.runs.PendingPermission(sessionID, requestID)
	if err != nil {
		if errors.Is(err, runcontrol.ErrRunNotActive) || errors.Is(err, runcontrol.ErrPermissionNotActive) {
			writeError(w, http.StatusConflict, "permission request is not active")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load permission request")
		return
	}
	optionID := strings.TrimSpace(body.OptionID)
	var selected *agents.PermissionOption
	for index := range pending.Options {
		if pending.Options[index].ID == optionID {
			selected = &pending.Options[index]
			break
		}
	}
	if selected == nil {
		writeError(w, http.StatusBadRequest, "permission option was not offered")
		return
	}
	if err := api.appendAgentEvent(r.Context(), sessionID, agents.AgentEvent{
		Type: "agent.permission.resolved", Role: "user", Status: string(store.EventStatusCompleted),
		Payload: map[string]any{"provider": pending.Provider, "provider_event_type": pending.ProviderEventType,
			"provider_request_id": pending.ProviderRequestID, "request_id": pending.RequestID,
			"option_id": selected.ID, "decision": selected.Decision, "scope": selected.Scope},
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist permission resolution")
		return
	}
	if err := api.runs.ResolvePermission(sessionID, requestID, agents.PermissionResponse{OptionID: selected.ID}); err != nil {
		writeError(w, http.StatusConflict, "permission request is not active")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"session_id": sessionID, "request_id": requestID, "status": "resolved"})
}
