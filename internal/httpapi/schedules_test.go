package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents/fake"
)

func TestScheduleCRUDRunNowAndCancel(t *testing.T) {
	ctx := context.Background()
	database, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, database)

	created := postJSON(handler, "/api/sessions/"+session.ID+"/schedules", `{"name":"Morning check","prompt":"Inspect the repository","cadence":{"kind":"daily","time":"09:00"},"timezone":"America/New_York","enabled":true}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create schedule: status=%d body=%s", created.Code, created.Body.String())
	}
	var schedule scheduleResponse
	decodeJSON(t, created, &schedule)
	if schedule.ID == "" || schedule.NextRunAt == nil || !schedule.Enabled {
		t.Fatalf("unexpected schedule: %#v", schedule)
	}

	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID+"/schedules", nil))
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), schedule.ID) {
		t.Fatalf("list schedules: status=%d body=%s", listed.Code, listed.Body.String())
	}

	run := postJSON(handler, "/api/sessions/"+session.ID+"/schedules/"+schedule.ID+"/run-now", `{}`)
	if run.Code != http.StatusAccepted {
		t.Fatalf("run now: status=%d body=%s", run.Code, run.Body.String())
	}
	var occurrence occurrenceResponse
	decodeJSON(t, run, &occurrence)
	if occurrence.ID == "" || occurrence.Trigger != "manual" {
		t.Fatalf("unexpected occurrence: %#v", occurrence)
	}

	pausedBody := `{"name":"Morning check","prompt":"Inspect the repository","cadence":{"kind":"daily","time":"10:00"},"timezone":"America/New_York","enabled":false}`
	pausedReq := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+session.ID+"/schedules/"+schedule.ID, strings.NewReader(pausedBody))
	pausedReq.Header.Set("Content-Type", "application/json")
	paused := httptest.NewRecorder()
	handler.ServeHTTP(paused, pausedReq)
	if paused.Code != http.StatusOK {
		t.Fatalf("pause schedule: status=%d body=%s", paused.Code, paused.Body.String())
	}
}

func TestScheduleRejectsInvalidCron(t *testing.T) {
	ctx := context.Background()
	database, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, database)
	rec := postJSON(handler, "/api/sessions/"+session.ID+"/schedules", `{"prompt":"Run","cadence":{"kind":"cron","expression":"not cron"},"timezone":"UTC","enabled":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request, got %d: %s", rec.Code, rec.Body.String())
	}
}
