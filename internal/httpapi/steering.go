package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

type steeringRunManager interface {
	SteerWithPersistence(context.Context, string, string, agents.SteeringInput, func() error) error
}

func (api API) steerSessionMessage(w http.ResponseWriter, r *http.Request, session store.Session, request submitMessageRequest, content string, attachments []agents.Attachment, skills []agents.SkillReference) {
	runID := strings.TrimSpace(request.ExpectedRunID)
	if request.Queue || request.AgentOptions != nil || runID == "" || len(runID) > 128 || request.ClientSubmissionID == "" {
		writeError(w, http.StatusBadRequest, "Send now requires a run ID and submission ID; it cannot queue or change agent settings")
		return
	}
	manager, ok := api.runs.(steeringRunManager)
	if !ok || session.Status != store.SessionStatusRunning {
		writeError(w, http.StatusConflict, "The target run is no longer active. Nothing was queued or started.")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Second)
	defer cancel()
	payload := map[string]any{"text": content, "attachments": attachments, "skills": skills, "delivery": "steer", "client_submission_id": request.ClientSubmissionID}
	submitted := false
	err := manager.SteerWithPersistence(ctx, session.ID, runID, agents.SteeringInput{Message: content, Attachments: attachments, Skills: skills}, func() error {
		if err := api.appendAgentEvent(ctx, session.ID, agents.AgentEvent{Type: "user.message.steer.submitted", Role: "user", Status: "started", Payload: payload}, runID); err != nil {
			return err
		}
		submitted = true
		return nil
	})
	if err != nil {
		if submitted {
			failureCtx, cancelFailure := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelFailure()
			if persistErr := api.appendAgentEvent(failureCtx, session.ID, agents.AgentEvent{Type: "user.message.steer.failed", Role: "user", Status: "failed", Payload: map[string]any{"client_submission_id": request.ClientSubmissionID, "error": "Send now delivery was not confirmed. Nothing was automatically resent."}}, runID); persistErr != nil {
				log.Printf("failed to persist steering delivery failure: session_id=%s run_id=%s error=%v", session.ID, runID, persistErr)
			}
		}
		if !submitted && (errors.Is(err, runcontrol.ErrRunNotActive) || errors.Is(err, runcontrol.ErrSteeringUnavailable)) {
			writeError(w, http.StatusConflict, "This run cannot receive input now. It may have ended, changed, or still be starting. Nothing was queued or started.")
			return
		}
		writeError(w, http.StatusServiceUnavailable, "Send now delivery was not confirmed. Check delivery before sending again; nothing was automatically resent.")
		return
	}
	// Only a provider-confirmed steer becomes an ordinary user message. Submitted
	// intent alone must not make durable recovery claim the provider received it.
	if err := api.appendUserMessage(ctx, session.ID, content, attachments, skills, nil, map[string]any{"delivery": "steer", "run_id": runID, "client_submission_id": request.ClientSubmissionID}, ""); err != nil {
		writeError(w, http.StatusServiceUnavailable, "Message delivered, but confirmation could not be saved. Do not resend it.")
		return
	}
	writeJSON(w, http.StatusAccepted, submitMessageResponse{SessionID: session.ID, Status: string(session.Status), AcceptedAs: "steered"})
}
