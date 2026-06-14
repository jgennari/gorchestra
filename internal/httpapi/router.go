package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

const (
	defaultEventLimit   = 500
	maxEventLimit       = 1000
	defaultSessionLimit = 50
	maxSessionLimit     = 100
	streamHeartbeat     = 15 * time.Second
)

type Store interface {
	CreateSession(ctx context.Context, params store.CreateSessionParams) (store.Session, error)
	GetSession(ctx context.Context, id string) (store.Session, error)
	ListSessions(ctx context.Context, params store.ListSessionsParams) ([]store.Session, error)
	UpdateSessionTitle(ctx context.Context, params store.UpdateSessionTitleParams) (store.Session, error)
	UpdateSessionStatus(ctx context.Context, params store.UpdateSessionStatusParams) (store.Session, error)
	ListEvents(ctx context.Context, sessionID string, afterSeq int64, limit int) ([]store.Event, error)
}

type EventService interface {
	Append(ctx context.Context, params eventservice.AppendParams) (store.Event, error)
	Subscribe(sessionID string) (<-chan store.Event, func())
}

type AgentRegistry interface {
	Get(agentType string) (agents.Agent, bool)
}

type RunManager interface {
	Register(parent context.Context, sessionID string) (context.Context, func(), error)
	Cancel(sessionID string) error
	Active(sessionID string) bool
}

type Dependencies struct {
	Store   Store
	Events  EventService
	Agents  AgentRegistry
	Runs    RunManager
	Workdir string
}

type API struct {
	store   Store
	events  EventService
	agents  AgentRegistry
	runs    RunManager
	workdir string
}

var _ RunManager = (*runcontrol.Manager)(nil)

type healthResponse struct {
	Status string `json:"status"`
}

type errorResponse struct {
	Error string `json:"error"`
}

type eventResponse struct {
	ID        string          `json:"id"`
	SessionID string          `json:"session_id"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Status    string          `json:"status"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

type eventHistoryResponse struct {
	Events []eventResponse `json:"events"`
}

func NewRouter(deps ...Dependencies) http.Handler {
	api := API{}
	if len(deps) > 0 {
		api.store = deps[0].Store
		api.events = deps[0].Events
		api.agents = deps[0].Agents
		api.runs = deps[0].Runs
		api.workdir = deps[0].Workdir
	}

	r := chi.NewRouter()
	r.Get("/api/health", healthHandler)

	if api.store != nil && api.events != nil && api.agents != nil && api.runs != nil {
		r.Get("/api/agents/{agentType}/options", api.agentOptionsHandler)
		r.Post("/api/sessions", api.createSessionHandler)
		r.Patch("/api/sessions/{sessionId}", api.updateSessionHandler)
		r.Post("/api/sessions/{sessionId}/messages", api.submitMessageHandler)
		r.Post("/api/sessions/{sessionId}/cancel", api.cancelSessionHandler)
	}
	if api.store != nil {
		r.Get("/api/sessions", api.listSessionsHandler)
		r.Get("/api/sessions/{sessionId}", api.getSessionHandler)
		r.Get("/api/sessions/{sessionId}/events", api.eventHistoryHandler)
	}
	if api.store != nil && api.events != nil {
		r.Get("/api/sessions/{sessionId}/events/stream", api.eventStreamHandler)
	}

	return r
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})
}

func (api API) eventHistoryHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}

	afterSeq, ok := parseAfterSeq(w, r)
	if !ok {
		return
	}
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}

	events, err := api.store.ListEvents(r.Context(), sessionID, afterSeq, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list events")
		return
	}

	writeJSON(w, http.StatusOK, eventHistoryResponse{Events: eventResponses(events)})
}

func (api API) eventStreamHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}

	afterSeq, ok := parseAfterSeq(w, r)
	if !ok {
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}

	liveEvents, unsubscribe := api.events.Subscribe(sessionID)
	defer unsubscribe()

	replayedEvents, err := api.replayEvents(r.Context(), sessionID, afterSeq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replay events")
		return
	}

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if err := writeSSEComment(w, "connected"); err != nil {
		return
	}
	flusher.Flush()

	highestSeqSent := afterSeq
	for _, event := range replayedEvents {
		if err := writeSSE(w, event); err != nil {
			return
		}
		flusher.Flush()
		if event.Seq > highestSeqSent {
			highestSeqSent = event.Seq
		}
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
		case event, ok := <-liveEvents:
			if !ok {
				return
			}
			if event.Seq <= highestSeqSent {
				continue
			}
			if err := writeSSE(w, event); err != nil {
				return
			}
			flusher.Flush()
			highestSeqSent = event.Seq
		}
	}
}

func (api API) replayEvents(ctx context.Context, sessionID string, afterSeq int64) ([]store.Event, error) {
	events := make([]store.Event, 0)
	nextAfterSeq := afterSeq

	for {
		page, err := api.store.ListEvents(ctx, sessionID, nextAfterSeq, maxEventLimit)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			return events, nil
		}

		events = append(events, page...)

		lastSeq := page[len(page)-1].Seq
		if lastSeq <= nextAfterSeq {
			return nil, fmt.Errorf("event replay did not advance past seq %d", nextAfterSeq)
		}
		nextAfterSeq = lastSeq

		if len(page) < maxEventLimit {
			return events, nil
		}
	}
}

func (api API) sessionExists(w http.ResponseWriter, r *http.Request, sessionID string) bool {
	if _, err := api.store.GetSession(r.Context(), sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return false
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return false
	}

	return true
}

func parseAfterSeq(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := r.URL.Query().Get("after_seq")
	if raw == "" {
		return 0, true
	}

	afterSeq, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || afterSeq < 0 {
		writeError(w, http.StatusBadRequest, "after_seq must be a non-negative integer")
		return 0, false
	}

	return afterSeq, true
}

func parseLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultEventLimit, true
	}

	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 0 {
		writeError(w, http.StatusBadRequest, "limit must be a non-negative integer")
		return 0, false
	}
	if limit == 0 {
		return defaultEventLimit, true
	}
	if limit > maxEventLimit {
		return maxEventLimit, true
	}

	return limit, true
}

func eventResponses(events []store.Event) []eventResponse {
	if len(events) == 0 {
		return []eventResponse{}
	}

	responses := make([]eventResponse, 0, len(events))
	for _, event := range events {
		responses = append(responses, newEventResponse(event))
	}

	return responses
}

func newEventResponse(event store.Event) eventResponse {
	return eventResponse{
		ID:        event.ID,
		SessionID: event.SessionID,
		Seq:       event.Seq,
		Type:      event.Type,
		Role:      event.Role,
		Status:    string(event.Status),
		Payload:   event.Payload,
		CreatedAt: event.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func writeSSE(w http.ResponseWriter, event store.Event) error {
	body, err := json.Marshal(newEventResponse(event))
	if err != nil {
		return fmt.Errorf("marshal sse event: %w", err)
	}

	if _, err := fmt.Fprintf(w, "id: %d\n", event.Seq); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event.Type); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
		return err
	}

	return nil
}

func writeSSEComment(w http.ResponseWriter, comment string) error {
	_, err := fmt.Fprintf(w, ": %s\n\n", comment)
	return err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorResponse{Error: message})
}
