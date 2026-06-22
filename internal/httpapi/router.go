package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

const (
	defaultEventLimit        = 500
	maxEventLimit            = 1000
	eventHistoryBackfillStep = 250
	defaultSessionLimit      = 50
	maxSessionLimit          = 100
	streamHeartbeat          = 15 * time.Second
)

type Store interface {
	CreateSession(ctx context.Context, params store.CreateSessionParams) (store.Session, error)
	GetSession(ctx context.Context, id string) (store.Session, error)
	ListSessions(ctx context.Context, params store.ListSessionsParams) ([]store.Session, error)
	ArchiveSession(ctx context.Context, params store.ArchiveSessionParams) (store.Session, error)
	RestoreSession(ctx context.Context, params store.RestoreSessionParams) (store.Session, error)
	UpdateSessionTitle(ctx context.Context, params store.UpdateSessionTitleParams) (store.Session, error)
	UpdateSessionAgentOptions(ctx context.Context, params store.UpdateSessionAgentOptionsParams) (store.Session, error)
	UpdateSessionStatus(ctx context.Context, params store.UpdateSessionStatusParams) (store.Session, error)
	SetSessionProviderSessionID(ctx context.Context, params store.SetSessionProviderSessionIDParams) (store.Session, error)
	ClearSessionProviderSessionID(ctx context.Context, params store.ClearSessionProviderSessionIDParams) (store.Session, error)
	ListEvents(ctx context.Context, sessionID string, afterSeq int64, limit int) ([]store.Event, error)
	ListRecentEvents(ctx context.Context, sessionID string, limit int) ([]store.Event, error)
	ListEventsBefore(ctx context.Context, sessionID string, beforeSeq int64, limit int) ([]store.Event, error)
}

type EventService interface {
	Append(ctx context.Context, params eventservice.AppendParams) (store.Event, error)
	Subscribe(sessionID string) (<-chan store.Event, func())
	SubscribeAll() (<-chan store.Event, func())
}

type AgentRegistry interface {
	Get(agentType string) (agents.Agent, bool)
}

type RunManager interface {
	Register(parent context.Context, sessionID string) (context.Context, func(), error)
	Cancel(sessionID string) error
	Active(sessionID string) bool
	OpenUserInput(ctx context.Context, request agents.UserInputRequest) (agents.UserInputWaiter, error)
	PendingUserInput(sessionID string, requestID string) (agents.UserInputRequest, error)
	AnswerUserInput(sessionID string, requestID string, response agents.UserInputResponse) error
}

type Dependencies struct {
	Store          Store
	Events         EventService
	Agents         AgentRegistry
	Runs           RunManager
	Workdir        string
	WorkspaceRoots []string
	StaticAssets   fs.FS
}

type API struct {
	store        Store
	events       EventService
	agents       AgentRegistry
	runs         RunManager
	workdir      string
	workspaces   workspaceConfig
	staticAssets fs.FS
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
		api.workspaces = newWorkspaceConfig(deps[0].Workdir, deps[0].WorkspaceRoots)
		api.staticAssets = deps[0].StaticAssets
	}

	r := chi.NewRouter()
	r.Get("/api/health", healthHandler)

	if api.store != nil && api.events != nil && api.agents != nil && api.runs != nil {
		r.Get("/api/agents/{agentType}/options", api.agentOptionsHandler)
		r.Get("/api/workspaces/roots", api.workspaceRootsHandler)
		r.Get("/api/workspaces/browse", api.workspaceBrowseHandler)
		r.Post("/api/sessions", api.createSessionHandler)
		r.Patch("/api/sessions/{sessionId}", api.updateSessionHandler)
		r.Post("/api/sessions/{sessionId}/archive", api.archiveSessionHandler)
		r.Post("/api/sessions/{sessionId}/restore", api.restoreSessionHandler)
		r.Get("/api/sessions/{sessionId}/files", api.sessionFilesHandler)
		r.Get("/api/sessions/{sessionId}/files/content", api.sessionFileContentHandler)
		r.Put("/api/sessions/{sessionId}/files/content", api.updateSessionFileContentHandler)
		r.Get("/api/sessions/{sessionId}/files/search", api.sessionFileSearchHandler)
		r.Post("/api/sessions/{sessionId}/messages", api.submitMessageHandler)
		r.Post("/api/sessions/{sessionId}/clear", api.clearSessionHandler)
		r.Post("/api/sessions/{sessionId}/compact", api.compactSessionHandler)
		r.Post("/api/sessions/{sessionId}/cancel", api.cancelSessionHandler)
		r.Post("/api/sessions/{sessionId}/requests/{requestId}/answer", api.answerUserInputHandler)
	}
	if api.store != nil {
		r.Get("/api/sessions", api.listSessionsHandler)
		r.Get("/api/sessions/{sessionId}", api.getSessionHandler)
		r.Get("/api/sessions/{sessionId}/events", api.eventHistoryHandler)
	}
	if api.store != nil && api.events != nil {
		r.Get("/api/sessions/{sessionId}/events/stream", api.eventStreamHandler)
		r.Get("/api/sessions/activity/stream", api.sessionActivityStreamHandler)
	}
	r.NotFound(api.notFoundHandler)

	return r
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})
}

func (api API) notFoundHandler(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if api.staticAssets == nil {
		http.NotFound(w, r)
		return
	}
	serveStaticAsset(api.staticAssets, w, r)
}

func serveStaticAsset(assets fs.FS, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "." || name == "" {
		name = "index.html"
	}
	if staticAssetExists(assets, name) {
		serveStaticFile(assets, name, w, r)
		return
	}
	if isFrontendAssetPath(name) {
		http.NotFound(w, r)
		return
	}
	serveStaticFile(assets, "index.html", w, r)
}

func isFrontendAssetPath(name string) bool {
	return strings.HasPrefix(name, "assets/") || name == "favicon.svg"
}

func staticAssetExists(assets fs.FS, name string) bool {
	info, err := fs.Stat(assets, name)
	return err == nil && !info.IsDir()
}

func serveStaticFile(assets fs.FS, name string, w http.ResponseWriter, r *http.Request) {
	info, err := fs.Stat(assets, name)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	content, err := fs.ReadFile(assets, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(content))
}

func (api API) eventHistoryHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}

	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}

	events, err := api.listHistoryEvents(r, sessionID, limit)
	if errors.Is(err, errInvalidEventHistoryCursor) {
		writeError(w, http.StatusBadRequest, eventHistoryCursorMessage(err))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list events")
		return
	}

	writeJSON(w, http.StatusOK, eventHistoryResponse{Events: eventResponses(events)})
}

var errInvalidEventHistoryCursor = errors.New("invalid event history cursor")

func eventHistoryCursorMessage(err error) string {
	message := err.Error()
	return strings.TrimPrefix(message, errInvalidEventHistoryCursor.Error()+": ")
}

func (api API) listHistoryEvents(r *http.Request, sessionID string, limit int) ([]store.Event, error) {
	query := r.URL.Query()
	rawAfterSeq := query.Get("after_seq")
	rawBeforeSeq := query.Get("before_seq")
	rawTail := query.Get("tail")

	tail := false
	if rawTail != "" {
		parsedTail, err := strconv.ParseBool(rawTail)
		if err != nil {
			return nil, fmt.Errorf("%w: tail must be a boolean", errInvalidEventHistoryCursor)
		}
		tail = parsedTail
	}

	cursorCount := 0
	if rawAfterSeq != "" {
		cursorCount++
	}
	if rawBeforeSeq != "" {
		cursorCount++
	}
	if tail {
		cursorCount++
	}
	if cursorCount > 1 {
		return nil, fmt.Errorf("%w: use only one event history cursor", errInvalidEventHistoryCursor)
	}

	if tail {
		return api.listBoundarySafeRecentEvents(r.Context(), sessionID, limit)
	}
	if rawBeforeSeq != "" {
		beforeSeq, err := parseNonNegativeInt64(rawBeforeSeq, "before_seq")
		if err != nil {
			return nil, fmt.Errorf("%w: %s", errInvalidEventHistoryCursor, err.Error())
		}
		return api.listBoundarySafeEventsBefore(r.Context(), sessionID, beforeSeq, limit)
	}

	afterSeq := int64(0)
	if rawAfterSeq != "" {
		parsedAfterSeq, err := parseNonNegativeInt64(rawAfterSeq, "after_seq")
		if err != nil {
			return nil, fmt.Errorf("%w: %s", errInvalidEventHistoryCursor, err.Error())
		}
		afterSeq = parsedAfterSeq
	}
	return api.store.ListEvents(r.Context(), sessionID, afterSeq, limit)
}

func (api API) listBoundarySafeRecentEvents(ctx context.Context, sessionID string, limit int) ([]store.Event, error) {
	events, err := api.store.ListRecentEvents(ctx, sessionID, limit)
	if err != nil {
		return nil, err
	}
	return api.expandHistoryWindowToSafeBoundary(ctx, sessionID, events)
}

func (api API) listBoundarySafeEventsBefore(
	ctx context.Context,
	sessionID string,
	beforeSeq int64,
	limit int,
) ([]store.Event, error) {
	events, err := api.store.ListEventsBefore(ctx, sessionID, beforeSeq, limit)
	if err != nil {
		return nil, err
	}
	return api.expandHistoryWindowToSafeBoundary(ctx, sessionID, events)
}

func (api API) expandHistoryWindowToSafeBoundary(
	ctx context.Context,
	sessionID string,
	events []store.Event,
) ([]store.Event, error) {
	for len(events) > 0 && !safeHistoryWindowStart(events[0]) && len(events) < maxEventLimit {
		beforeSeq := events[0].Seq
		if beforeSeq <= 1 {
			return events, nil
		}

		backfillLimit := eventHistoryBackfillStep
		if remaining := maxEventLimit - len(events); backfillLimit > remaining {
			backfillLimit = remaining
		}
		if backfillLimit <= 0 {
			return events, nil
		}

		olderEvents, err := api.store.ListEventsBefore(ctx, sessionID, beforeSeq, backfillLimit)
		if err != nil {
			return nil, err
		}
		if len(olderEvents) == 0 {
			return events, nil
		}

		expanded := make([]store.Event, 0, len(olderEvents)+len(events))
		expanded = append(expanded, olderEvents...)
		expanded = append(expanded, events...)
		events = expanded
	}

	return events, nil
}

func safeHistoryWindowStart(event store.Event) bool {
	switch event.Type {
	case "agent.message.delta",
		"agent.plan.delta",
		"agent.thinking.delta",
		"agent.log.delta",
		"tool.call.delta",
		"file.change.delta",
		"tool.call.completed",
		"file.change.completed",
		"agent.thinking.completed":
		return false
	default:
		return true
	}
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

func (api API) sessionActivityStreamHandler(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}

	liveEvents, unsubscribe := api.events.SubscribeAll()
	defer unsubscribe()

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
			if err := writeSSE(w, event); err != nil {
				return
			}
			flusher.Flush()
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

	afterSeq, err := parseNonNegativeInt64(raw, "after_seq")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return 0, false
	}

	return afterSeq, true
}

func parseNonNegativeInt64(raw string, name string) (int64, error) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return value, nil
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
