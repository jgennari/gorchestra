package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

type dashboardRouteStore struct {
	Store
	dashboardParams store.DashboardParams
	runParams       store.DashboardRunListParams
}

func (stub *dashboardRouteStore) Dashboard(_ context.Context, params store.DashboardParams) (store.DashboardData, error) {
	stub.dashboardParams = params
	return store.DashboardData{
		Range:      params.Range,
		TimeZone:   params.Location.String(),
		Activity:   []store.DashboardActivityBucket{},
		Workspaces: []store.DashboardBreakdown{},
		Agents:     []store.DashboardBreakdown{},
		Outcomes:   []store.DashboardOutcome{},
	}, nil
}

func (stub *dashboardRouteStore) ListDashboardRuns(_ context.Context, params store.DashboardRunListParams) (store.DashboardRunPage, error) {
	stub.runParams = params
	return store.DashboardRunPage{Runs: []store.DashboardRun{}}, nil
}

func TestDashboardRouteParsesRangeAndTimeZone(t *testing.T) {
	stub := &dashboardRouteStore{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/dashboard?range=90d&time_zone=America%2FNew_York", nil)

	NewRouter(Dependencies{Store: stub}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if stub.dashboardParams.Range != store.DashboardRange90Days || stub.dashboardParams.Location.String() != "America/New_York" {
		t.Fatalf("unexpected dashboard params: %#v", stub.dashboardParams)
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store cache control, got %q", recorder.Header().Get("Cache-Control"))
	}
}

func TestDashboardRunsRouteParsesDrilldownFilters(t *testing.T) {
	stub := &dashboardRouteStore{}
	request := httptest.NewRequest(http.MethodGet,
		"/api/dashboard/runs?range=7d&time_zone=UTC&status=failed&kind=compact&agent=codex&workspace=%2Frepo&outcome=test&sort=duration&limit=40&bucket_start=2026-08-20T00%3A00%3A00Z&bucket_end=2026-08-21T00%3A00%3A00Z", nil)
	recorder := httptest.NewRecorder()

	NewRouter(Dependencies{Store: stub}).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	params := stub.runParams
	if params.Range != store.DashboardRange7Days || params.Status != "failed" || params.Kind != "compact" ||
		params.AgentType != "codex" || params.Workspace != "/repo" || params.Outcome != "test" ||
		params.Sort != "duration" || params.Limit != 40 {
		t.Fatalf("unexpected dashboard run params: %#v", params)
	}
	if params.BucketStart == nil || params.BucketEnd == nil || !params.BucketEnd.Equal(params.BucketStart.Add(24*time.Hour)) {
		t.Fatalf("unexpected bucket bounds: %#v to %#v", params.BucketStart, params.BucketEnd)
	}
}

func TestDashboardRoutesRejectInvalidQueries(t *testing.T) {
	stub := &dashboardRouteStore{}
	tests := []string{
		"/api/dashboard?range=year",
		"/api/dashboard?time_zone=Moon/Base",
		"/api/dashboard/runs?status=idle",
		"/api/dashboard/runs?limit=101",
		"/api/dashboard/runs?bucket_start=2026-08-21T00%3A00%3A00Z&bucket_end=2026-08-20T00%3A00%3A00Z",
	}
	for _, path := range tests {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			NewRouter(Dependencies{Store: stub}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestDashboardRouteIsNotRegisteredWithoutDashboardStore(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/dashboard", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", recorder.Code, recorder.Body.String())
	}
}
