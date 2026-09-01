package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/scheduler"
	"github.com/jgennari/gorchestra/internal/store"
)

type schedulesResponse struct {
	Schedules []scheduleResponse `json:"schedules"`
}

type scheduleResponse struct {
	ID               string            `json:"id"`
	SessionID        string            `json:"session_id"`
	Name             string            `json:"name"`
	Prompt           string            `json:"prompt"`
	Cadence          scheduler.Cadence `json:"cadence"`
	Timezone         string            `json:"timezone"`
	Enabled          bool              `json:"enabled"`
	NextRunAt        *string           `json:"next_run_at"`
	PendingCount     int               `json:"pending_count"`
	LastStatus       string            `json:"last_status,omitempty"`
	LastScheduledFor *string           `json:"last_scheduled_for,omitempty"`
	CreatedAt        string            `json:"created_at"`
	UpdatedAt        string            `json:"updated_at"`
}

type occurrencesResponse struct {
	Occurrences []occurrenceResponse `json:"occurrences"`
}

type occurrenceResponse struct {
	ID           string  `json:"id"`
	ScheduleID   string  `json:"schedule_id"`
	Trigger      string  `json:"trigger"`
	ScheduledFor string  `json:"scheduled_for"`
	Status       string  `json:"status"`
	RunID        string  `json:"run_id,omitempty"`
	Error        string  `json:"error,omitempty"`
	CreatedAt    string  `json:"created_at"`
	StartedAt    *string `json:"started_at,omitempty"`
	CompletedAt  *string `json:"completed_at,omitempty"`
}

func (api API) listSchedulesHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}
	items, err := api.schedules.List(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list schedules")
		return
	}
	response := schedulesResponse{Schedules: make([]scheduleResponse, 0, len(items))}
	for _, item := range items {
		response.Schedules = append(response.Schedules, scheduleToResponse(item))
	}
	writeJSON(w, http.StatusOK, response)
}

func (api API) createScheduleHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.scheduleSessionMutable(w, r, sessionID) {
		return
	}
	var input scheduler.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.schedules.Create(r.Context(), sessionID, input)
	if !writeScheduleError(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, scheduleToResponse(item))
}

func (api API) updateScheduleHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.scheduleSessionMutable(w, r, sessionID) {
		return
	}
	var input scheduler.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.schedules.Update(r.Context(), sessionID, chi.URLParam(r, "scheduleId"), input)
	if !writeScheduleError(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, scheduleToResponse(item))
}

func (api API) deleteScheduleHandler(w http.ResponseWriter, r *http.Request) {
	err := api.schedules.Delete(r.Context(), chi.URLParam(r, "sessionId"), chi.URLParam(r, "scheduleId"))
	if !writeScheduleError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api API) runScheduleNowHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.scheduleSessionMutable(w, r, sessionID) {
		return
	}
	item, err := api.schedules.RunNow(r.Context(), sessionID, chi.URLParam(r, "scheduleId"))
	if !writeScheduleError(w, err) {
		return
	}
	writeJSON(w, http.StatusAccepted, occurrenceToResponse(item))
}

func (api API) listScheduleOccurrencesHandler(w http.ResponseWriter, r *http.Request) {
	limit := 25
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = parsed
	}
	items, err := api.schedules.Occurrences(r.Context(), chi.URLParam(r, "sessionId"), chi.URLParam(r, "scheduleId"), limit)
	if !writeScheduleError(w, err) {
		return
	}
	response := occurrencesResponse{Occurrences: make([]occurrenceResponse, 0, len(items))}
	for _, item := range items {
		response.Occurrences = append(response.Occurrences, occurrenceToResponse(item))
	}
	writeJSON(w, http.StatusOK, response)
}

func (api API) cancelScheduleOccurrenceHandler(w http.ResponseWriter, r *http.Request) {
	item, err := api.schedules.CancelOccurrence(r.Context(), chi.URLParam(r, "sessionId"), chi.URLParam(r, "scheduleId"), chi.URLParam(r, "occurrenceId"))
	if !writeScheduleError(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, occurrenceToResponse(item))
}

func (api API) scheduleSessionMutable(w http.ResponseWriter, r *http.Request, sessionID string) bool {
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load session")
		}
		return false
	}
	if session.ArchivedAt != nil {
		writeError(w, http.StatusConflict, "session is archived")
		return false
	}
	return true
}

func writeScheduleError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, store.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "schedule request failed")
	}
	return false
}

func scheduleToResponse(item store.SessionSchedule) scheduleResponse {
	var cadence scheduler.Cadence
	_ = json.Unmarshal(item.Cadence, &cadence)
	return scheduleResponse{ID: item.ID, SessionID: item.SessionID, Name: item.Name, Prompt: item.Prompt, Cadence: cadence, Timezone: item.Timezone, Enabled: item.Enabled, NextRunAt: stringTime(item.NextRunAt), PendingCount: item.PendingCount, LastStatus: item.LastStatus, LastScheduledFor: stringTime(item.LastScheduledFor), CreatedAt: item.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: item.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}

func occurrenceToResponse(item store.ScheduleOccurrence) occurrenceResponse {
	return occurrenceResponse{ID: item.ID, ScheduleID: item.ScheduleID, Trigger: item.Trigger, ScheduledFor: item.ScheduledFor.UTC().Format(time.RFC3339Nano), Status: item.Status, RunID: item.RunID, Error: item.Error, CreatedAt: item.CreatedAt.UTC().Format(time.RFC3339Nano), StartedAt: stringTime(item.StartedAt), CompletedAt: stringTime(item.CompletedAt)}
}

func stringTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
