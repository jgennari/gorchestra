package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/store"
)

type messageSubmissionStore interface {
	ClaimMessageSubmission(context.Context, string, string, string) (store.MessageSubmission, bool, error)
	GetMessageSubmission(context.Context, string, string) (store.MessageSubmission, error)
	CompleteMessageSubmission(context.Context, string, string, int, []byte) error
}

type submissionResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *submissionResponse) Header() http.Header { return w.header }
func (w *submissionResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *submissionResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}

func (api API) submitMessageHandler(w http.ResponseWriter, r *http.Request) {
	var request submitMessageRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	request.ClientSubmissionID = strings.TrimSpace(request.ClientSubmissionID)
	id := request.ClientSubmissionID
	if len(id) > 128 {
		writeError(w, 400, "client_submission_id must be 128 characters or fewer")
		return
	}
	if id == "" {
		api.submitDecodedMessage(w, r, request)
		return
	}
	sessionID := chi.URLParam(r, "sessionId")
	if _, err := api.store.GetSession(r.Context(), sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, 404, "session not found")
		} else {
			writeError(w, 500, "failed to load session")
		}
		return
	}
	persistence, ok := api.store.(messageSubmissionStore)
	if !ok {
		writeError(w, 503, "durable message submission is unavailable")
		return
	}
	canonical, err := json.Marshal(request)
	if err != nil {
		writeError(w, 400, "invalid submission")
		return
	}
	hash := sha256.Sum256(canonical)
	fingerprint := hex.EncodeToString(hash[:])
	record, claimed, err := persistence.ClaimMessageSubmission(r.Context(), sessionID, id, fingerprint)
	if err != nil {
		writeError(w, 500, "failed to reserve submission")
		return
	}
	if !claimed {
		if record.RequestHash != fingerprint {
			writeError(w, 409, "submission ID already belongs to different content")
			return
		}
		if record.State == "unknown" {
			writeError(w, 409, "submission delivery is still uncertain; check its status before retrying")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(record.HTTPStatus)
		_, _ = w.Write(record.Response)
		return
	}
	// Buffer the acknowledgment until its receipt is durable, even when the
	// requesting browser disconnects. A failed receipt write remains unknown.
	response := &submissionResponse{header: make(http.Header)}
	api.submitDecodedMessage(response, r, request)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := persistence.CompleteMessageSubmission(ctx, sessionID, id, response.status, response.body.Bytes()); err != nil {
		writeError(w, 503, "submission acknowledgment could not be saved; check delivery status")
		return
	}
	for name, values := range response.header {
		w.Header()[name] = values
	}
	w.WriteHeader(response.status)
	_, _ = w.Write(response.body.Bytes())
}

func (api API) messageSubmissionStatusHandler(w http.ResponseWriter, r *http.Request) {
	persistence, ok := api.store.(messageSubmissionStore)
	if !ok {
		writeError(w, 503, "submission recovery is unavailable")
		return
	}
	record, err := persistence.GetMessageSubmission(r.Context(), chi.URLParam(r, "sessionId"), chi.URLParam(r, "submissionId"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, 200, map[string]string{"state": "not_received"})
		return
	}
	if err != nil {
		writeError(w, 500, "failed to check submission")
		return
	}
	writeJSON(w, 200, record)
}
