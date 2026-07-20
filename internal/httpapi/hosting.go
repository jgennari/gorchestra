package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/hosting"
	"github.com/jgennari/gorchestra/internal/store"
)

const (
	defaultHostLogLimit = 1000
	maxHostLogLimit     = 10_000
)

func (api API) hostStatusHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, api.currentHostStatus(session))
}

func (api API) validateHostHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, api.currentHostStatus(session))
}

func (api API) startHostHandler(w http.ResponseWriter, r *http.Request) {
	session, loaded, ok := api.hostStartInput(w, r)
	if !ok {
		return
	}
	slug := hosting.RouteSlug(loaded.Recipe.Name, session.ID)
	if api.hostStore != nil {
		persisted, err := api.hostStore.GetHostRuntime(r.Context(), session.ID)
		if err == nil {
			slug = persisted.RouteSlug
		} else if !errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "failed to load hosted preview")
			return
		}
	}
	_, err := api.hosting.Start(r.Context(), hosting.StartRequest{
		SessionID: session.ID,
		Slug:      slug,
		Loaded:    loaded,
	})
	if err != nil {
		api.writeHostingError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, api.currentHostStatus(session))
}

func (api API) stopHostHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	_, err := api.hosting.Stop(r.Context(), session.ID)
	if err != nil {
		if errors.Is(err, hosting.ErrNotFound) {
			writeJSON(w, http.StatusAccepted, api.currentHostStatus(session))
			return
		}
		api.writeHostingError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, api.currentHostStatus(session))
}

func (api API) restartHostHandler(w http.ResponseWriter, r *http.Request) {
	session, loaded, ok := api.hostStartInput(w, r)
	if !ok {
		return
	}
	slug := ""
	if api.hostStore != nil {
		persisted, err := api.hostStore.GetHostRuntime(r.Context(), session.ID)
		if err == nil {
			slug = persisted.RouteSlug
		} else if !errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "failed to load hosted preview")
			return
		}
	}
	_, err := api.hosting.Restart(r.Context(), hosting.StartRequest{
		SessionID: session.ID,
		Slug:      slug,
		Loaded:    loaded,
	})
	if err != nil {
		api.writeHostingError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, api.currentHostStatus(session))
}

func (api API) checkHostHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	if _, err := api.hosting.Check(r.Context(), session.ID); err != nil {
		api.writeHostingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.currentHostStatus(session))
}

func (api API) hostLogsHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	after, limit, service, ok := parseHostLogQuery(w, r)
	if !ok {
		return
	}
	logs, err := api.hosting.Logs(session.ID, after, limit, service)
	if err != nil {
		if errors.Is(err, hosting.ErrNotFound) {
			writeJSON(w, http.StatusOK, hosting.LogSnapshot{Chunks: []hosting.LogChunk{}})
			return
		}
		api.writeHostingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, logs)
}

func (api API) hostLogStreamHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return
	}
	after, _, service, ok := parseHostLogQuery(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	replay, chunks, unsubscribe, err := api.hosting.SubscribeLogs(session.ID, after, service)
	if err != nil {
		api.writeHostingError(w, err)
		return
	}
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	for _, chunk := range replay.Chunks {
		if err := writeHostLogSSE(w, chunk); err != nil {
			return
		}
	}
	flusher.Flush()

	heartbeat := time.NewTicker(streamHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case chunk, open := <-chunks:
			if !open {
				return
			}
			if err := writeHostLogSSE(w, chunk); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (api API) hostSession(w http.ResponseWriter, r *http.Request) (store.Session, bool) {
	session, err := api.store.GetSession(r.Context(), chi.URLParam(r, "sessionId"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return store.Session{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return store.Session{}, false
	}
	return session, true
}

func (api API) hostStartInput(w http.ResponseWriter, r *http.Request) (store.Session, hosting.LoadedRecipe, bool) {
	session, ok := api.hostSession(w, r)
	if !ok {
		return store.Session{}, hosting.LoadedRecipe{}, false
	}
	if session.ArchivedAt != nil {
		writeError(w, http.StatusConflict, "restore the session before starting its hosted preview")
		return store.Session{}, hosting.LoadedRecipe{}, false
	}
	loaded, err := hosting.LoadRecipe(sessionWorkspacePath(session, api.workdir))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return store.Session{}, hosting.LoadedRecipe{}, false
	}
	return session, loaded, true
}

func (api API) currentHostStatus(session store.Session) hosting.Snapshot {
	workspace := sessionWorkspacePath(session, api.workdir)
	configPath := hosting.RecipePath(workspace)
	loaded, loadErr := hosting.LoadRecipe(workspace)
	present := true
	if loadErr != nil {
		if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
			present = false
		}
	}

	snapshot, err := api.hosting.Status(session.ID)
	if err != nil {
		snapshot = hosting.Snapshot{
			SessionID: session.ID,
			Config: hosting.ConfigStatus{
				Path:   configPath,
				Errors: []string{},
			},
			Runtime:  hosting.RuntimeInfo{Status: hosting.StatusStopped},
			Services: []hosting.ServiceInfo{},
		}
	}
	loadedDigest := snapshot.Config.LoadedDigest
	if loadErr == nil {
		snapshot.Config = hosting.ConfigStatus{
			Path:         loaded.Path,
			Present:      true,
			Valid:        true,
			Stale:        loadedDigest != "" && loadedDigest != loaded.Digest,
			Digest:       loaded.Digest,
			LoadedDigest: loadedDigest,
			Name:         loaded.Recipe.Name,
			Errors:       []string{},
		}
		if len(snapshot.Services) == 0 {
			snapshot.Services = hostRecipeServices(loaded.Recipe)
		}
	} else {
		errorsList := []string{}
		if present {
			errorsList = append(errorsList, loadErr.Error())
		}
		snapshot.Config = hosting.ConfigStatus{
			Path:         configPath,
			Present:      present,
			Valid:        false,
			Stale:        loadedDigest != "",
			LoadedDigest: loadedDigest,
			Errors:       errorsList,
		}
	}
	snapshot.SessionID = session.ID
	if snapshot.Services == nil {
		snapshot.Services = []hosting.ServiceInfo{}
	}
	return snapshot
}

func hostRecipeServices(recipe hosting.Recipe) []hosting.ServiceInfo {
	services := make([]hosting.ServiceInfo, 0, len(recipe.Services))
	for _, service := range recipe.Services {
		routes := make([]string, 0)
		for _, route := range recipe.Routes {
			if route.Service == service.Name {
				routes = append(routes, route.Path)
			}
		}
		services = append(services, hosting.ServiceInfo{
			Name:       service.Name,
			Status:     hosting.ServiceStopped,
			RoutePaths: routes,
		})
	}
	return services
}

func (api API) stopHostedPreview(ctx context.Context, sessionID string) error {
	if api.hosting == nil {
		return nil
	}
	snapshot, err := api.hosting.Status(sessionID)
	if errors.Is(err, hosting.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if snapshot.Runtime.Status == hosting.StatusStopped {
		return nil
	}
	if _, err := api.hosting.Stop(ctx, sessionID); err != nil && !errors.Is(err, hosting.ErrNotFound) {
		return err
	}
	_, err = api.hosting.Wait(ctx, sessionID)
	return err
}

func (api API) writeHostingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, hosting.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, hosting.ErrBusy), errors.Is(err, hosting.ErrRecipeChanged), errors.Is(err, hosting.ErrHostConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, hosting.ErrShuttingDown), errors.Is(err, hosting.ErrUnsupported), errors.Is(err, hosting.ErrNotReady):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusRequestTimeout, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func parseHostLogQuery(w http.ResponseWriter, r *http.Request) (uint64, int, string, bool) {
	after := uint64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("after_seq")); raw != "" {
		value, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "after_seq must be a non-negative integer")
			return 0, 0, "", false
		}
		after = value
	}
	limit := defaultHostLogLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxHostLogLimit {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("limit must be between 1 and %d", maxHostLogLimit))
			return 0, 0, "", false
		}
		limit = value
	}
	return after, limit, strings.TrimSpace(r.URL.Query().Get("service")), true
}

func writeHostLogSSE(w http.ResponseWriter, chunk hosting.LogChunk) error {
	data, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: log\ndata: %s\n\n", chunk.Seq, data)
	return err
}
