package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientPerformanceDiagnosticsStoresLongTaskBatch(t *testing.T) {
	handler := NewRouter()

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/diagnostics/performance",
		strings.NewReader(`{"captured_at":1788537600000,"route":"/sessions/example","session_id":"sess_1","long_tasks":[{"start_time":12.5,"duration_ms":74.2}]}`),
	)
	request.Header.Set("User-Agent", "performance-test")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected saved performance sample, got %d: %s", recorder.Code, recorder.Body.String())
	}

	getRecorder := httptest.NewRecorder()
	handler.ServeHTTP(getRecorder, httptest.NewRequest(http.MethodGet, "/api/diagnostics/performance", nil))
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("expected diagnostics response, got %d: %s", getRecorder.Code, getRecorder.Body.String())
	}
	body := getRecorder.Body.String()
	for _, expected := range []string{`"route":"/sessions/example"`, `"duration_ms":74.2`, `"user_agent":"performance-test"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %s in diagnostics response: %s", expected, body)
		}
	}
}

func TestClientPerformanceDiagnosticsRejectsNonLongTasks(t *testing.T) {
	handler := NewRouter()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/diagnostics/performance",
		strings.NewReader(`{"route":"/","long_tasks":[{"start_time":1,"duration_ms":49.9}]}`),
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, recorder.Code, recorder.Body.String())
	}
}

func TestPerformanceDiagnosticsCountsReconnectsByStableClientID(t *testing.T) {
	diagnostics := &performanceDiagnosticsStore{}

	diagnostics.streamConnected("browser-one", false)
	diagnostics.streamDisconnected()
	diagnostics.streamConnected("browser-two", false)
	diagnostics.streamDisconnected()
	diagnostics.streamConnected("browser-one", false)
	diagnostics.streamDisconnected()
	diagnostics.streamConnected("", true)
	diagnostics.streamDisconnected()

	if diagnostics.stream.ConnectionsTotal != 4 {
		t.Fatalf("expected 4 connections, got %d", diagnostics.stream.ConnectionsTotal)
	}
	if diagnostics.stream.ReconnectsTotal != 2 {
		t.Fatalf("expected stable-client and legacy reconnects only, got %d", diagnostics.stream.ReconnectsTotal)
	}
	if diagnostics.stream.ActiveConnections != 0 {
		t.Fatalf("expected no active connections, got %d", diagnostics.stream.ActiveConnections)
	}
}
