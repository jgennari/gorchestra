package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/threave-io/threave/internal/store"
)

func TestSearchStreamReturnsSessionsBeforeHistory(t *testing.T) {
	search := &searchStoreStub{
		sessions: []store.SearchResult{{
			Kind:         "session",
			SessionID:    "sess_release",
			SessionTitle: "Release work",
			Title:        "Release work",
		}},
		history: []store.SearchResult{{
			Kind:         "agent_message",
			SessionID:    "sess_release",
			SessionTitle: "Release work",
			Title:        "Release completed",
		}},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/search/stream?q=release", nil)

	API{search: search}.searchStreamHandler(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/x-ndjson" {
		t.Fatalf("unexpected content type %q", contentType)
	}
	var records []spotlightSearchStreamRecord
	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	for scanner.Scan() {
		var record spotlightSearchStreamRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("decode stream record: %v", err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan stream: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("expected three stream records, got %#v", records)
	}
	if records[0].Type != "results" || records[0].Source != "sessions" || records[0].Results[0].Kind != "session" {
		t.Fatalf("expected sessions first, got %#v", records[0])
	}
	if records[1].Type != "results" || records[1].Source != "history" || records[1].Results[0].Kind != "agent_message" {
		t.Fatalf("expected history second, got %#v", records[1])
	}
	if records[2].Type != "done" {
		t.Fatalf("expected done record, got %#v", records[2])
	}
	if search.sessionCalls != 1 || search.historyCalls != 1 {
		t.Fatalf("unexpected search calls: sessions=%d history=%d", search.sessionCalls, search.historyCalls)
	}
}

type searchStoreStub struct {
	all          []store.SearchResult
	sessions     []store.SearchResult
	history      []store.SearchResult
	allCalls     int
	sessionCalls int
	historyCalls int
}

func (s *searchStoreStub) Search(context.Context, string, int) ([]store.SearchResult, error) {
	s.allCalls++
	return s.all, nil
}

func (s *searchStoreStub) SearchSessions(context.Context, string, int) ([]store.SearchResult, error) {
	s.sessionCalls++
	return s.sessions, nil
}

func (s *searchStoreStub) SearchHistory(context.Context, string, int) ([]store.SearchResult, error) {
	s.historyCalls++
	return s.history, nil
}
