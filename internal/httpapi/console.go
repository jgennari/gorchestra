package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/console"
	"github.com/jgennari/gorchestra/internal/store"
)

type consoleMessage struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func (api API) consoleStatusHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}
	if status, ok := api.console.Status(sessionID); ok {
		writeJSON(w, http.StatusOK, status)
		return
	}
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}
	writeJSON(w, http.StatusOK, console.Status{
		SessionID:     sessionID,
		WorkspacePath: session.WorkspacePath,
		Running:       false,
	})
}

func (api API) startConsoleHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.consoleSession(w, r)
	if !ok {
		return
	}
	status, err := api.console.Start(r.Context(), session.ID, session.WorkspacePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start console")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (api API) killConsoleHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !api.sessionExists(w, r, sessionID) {
		return
	}
	if err := api.console.Kill(sessionID); err != nil && !errors.Is(err, console.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "failed to stop console")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api API) consoleWebSocketHandler(w http.ResponseWriter, r *http.Request) {
	session, ok := api.consoleSession(w, r)
	if !ok {
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "console closed")
	var writeMu sync.Mutex

	attachment, _, err := api.console.Attach(r.Context(), session.ID, session.WorkspacePath)
	if err != nil {
		_ = writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "error", Message: "failed to attach console"})
		return
	}
	defer attachment.Close()

	if err := writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "ready"}); err != nil {
		return
	}
	if len(attachment.Snapshot) > 0 {
		if err := writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "output", Data: string(attachment.Snapshot)}); err != nil {
			return
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for chunk := range attachment.Output() {
			if err := writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "output", Data: string(chunk)}); err != nil {
				return
			}
		}
		exitStatus, ok := api.console.Status(session.ID)
		if !ok || exitStatus.Running {
			return
		}
		if err := writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "exit", Code: exitStatus.ExitCode}); err != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "console ended")
	}()

	for {
		select {
		case <-done:
			_ = conn.Close(websocket.StatusNormalClosure, "console ended")
			return
		default:
		}
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var message consoleMessage
		if err := json.Unmarshal(data, &message); err != nil {
			_ = writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "error", Message: "invalid console message"})
			continue
		}
		switch message.Type {
		case "input":
			if err := attachment.Write(message.Data); err != nil {
				_ = writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "error", Message: "failed to write console input"})
				return
			}
		case "resize":
			if err := attachment.Resize(message.Cols, message.Rows); err != nil {
				_ = writeConsoleMessage(r.Context(), conn, &writeMu, consoleMessage{Type: "error", Message: "failed to resize console"})
			}
		}
	}
}

func (api API) consoleSession(w http.ResponseWriter, r *http.Request) (store.Session, bool) {
	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return store.Session{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return store.Session{}, false
	}
	if session.WorkspacePath == "" {
		session.WorkspacePath = api.workdir
	}
	return session, true
}

func writeConsoleMessage(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, message consoleMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	return conn.Write(ctx, websocket.MessageText, data)
}
