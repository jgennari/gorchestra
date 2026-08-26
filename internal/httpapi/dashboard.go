package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/jgennari/gorchestra/internal/store"
)

func (api API) dashboardHandler(w http.ResponseWriter, r *http.Request) {
	if api.dashboard == nil {
		writeError(w, http.StatusServiceUnavailable, "dashboard unavailable")
		return
	}
	params, ok := dashboardParamsFromRequest(w, r)
	if !ok {
		return
	}
	data, err := api.dashboard.Dashboard(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load dashboard")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, data)
}

func (api API) dashboardRunsHandler(w http.ResponseWriter, r *http.Request) {
	if api.dashboard == nil {
		writeError(w, http.StatusServiceUnavailable, "dashboard unavailable")
		return
	}
	dashboardParams, ok := dashboardParamsFromRequest(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	params := store.DashboardRunListParams{
		DashboardParams: dashboardParams,
		Status:          strings.TrimSpace(query.Get("status")),
		Kind:            strings.TrimSpace(query.Get("kind")),
		AgentType:       strings.TrimSpace(query.Get("agent")),
		Workspace:       strings.TrimSpace(query.Get("workspace")),
		Outcome:         strings.TrimSpace(query.Get("outcome")),
		Sort:            strings.TrimSpace(query.Get("sort")),
		Cursor:          strings.TrimSpace(query.Get("cursor")),
	}
	if params.Status != "" && !dashboardValueAllowed(params.Status, "completed", "failed", "cancelled", "running", "unknown") {
		writeError(w, http.StatusBadRequest, "unsupported dashboard run status")
		return
	}
	if params.Kind != "" && !dashboardValueAllowed(params.Kind, "all", "message", "compact", "unknown") {
		writeError(w, http.StatusBadRequest, "unsupported dashboard run kind")
		return
	}
	if params.Outcome != "" && !dashboardValueAllowed(params.Outcome, "commit", "pull_request", "test", "delegation") {
		writeError(w, http.StatusBadRequest, "unsupported dashboard outcome")
		return
	}
	if params.Sort != "" && !dashboardValueAllowed(params.Sort, "recent", "duration") {
		writeError(w, http.StatusBadRequest, "unsupported dashboard sort")
		return
	}
	if rawLimit := strings.TrimSpace(query.Get("limit")); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 || limit > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		params.Limit = limit
	}
	if value := strings.TrimSpace(query.Get("bucket_start")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bucket_start must be RFC3339")
			return
		}
		params.BucketStart = &parsed
	}
	if value := strings.TrimSpace(query.Get("bucket_end")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bucket_end must be RFC3339")
			return
		}
		params.BucketEnd = &parsed
	}
	if params.BucketStart != nil && params.BucketEnd != nil && !params.BucketStart.Before(*params.BucketEnd) {
		writeError(w, http.StatusBadRequest, "bucket_start must be before bucket_end")
		return
	}

	page, err := api.dashboard.ListDashboardRuns(r.Context(), params)
	if err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load dashboard runs")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, page)
}

func dashboardParamsFromRequest(w http.ResponseWriter, r *http.Request) (store.DashboardParams, bool) {
	rangeValue := store.DashboardRange(strings.TrimSpace(r.URL.Query().Get("range")))
	if rangeValue == "" {
		rangeValue = store.DashboardRange30Days
	}
	if !store.ValidDashboardRange(rangeValue) {
		writeError(w, http.StatusBadRequest, "unsupported dashboard range")
		return store.DashboardParams{}, false
	}
	timeZone := strings.TrimSpace(r.URL.Query().Get("time_zone"))
	if timeZone == "" {
		timeZone = "UTC"
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid dashboard time_zone")
		return store.DashboardParams{}, false
	}
	return store.DashboardParams{Range: rangeValue, Location: location}, true
}

func dashboardValueAllowed(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
