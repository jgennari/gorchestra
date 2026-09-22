package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jgennari/gorchestra/internal/store"
)

func TestSearchHandlerScopesSessionNameSearch(t *testing.T) {
	search := &searchStoreStub{
		sessionResults: []store.SearchResult{{
			Kind:         "session",
			SessionID:    "sess_release",
			SessionTitle: "Release work",
			Title:        "Release work",
		}},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/search?q=release&kind=session&session_id=current", nil)

	API{search: search}.searchHandler(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, recorder.Code, recorder.Body.String())
	}
	if search.allCalls != 0 || search.sessionCalls != 1 {
		t.Fatalf("expected one session-only search, got all=%d sessions=%d", search.allCalls, search.sessionCalls)
	}
	var response spotlightSearchResponse
	decodeJSON(t, recorder, &response)
	if len(response.Results) != 1 || response.Results[0].Kind != "session" || response.Results[0].SessionID != "sess_release" {
		t.Fatalf("unexpected session search response: %#v", response.Results)
	}
}

func TestSearchHandlerRejectsUnknownKind(t *testing.T) {
	search := &searchStoreStub{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/search?q=release&kind=tool", nil)

	API{search: search}.searchHandler(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, recorder.Code, recorder.Body.String())
	}
	if search.allCalls != 0 || search.sessionCalls != 0 {
		t.Fatalf("expected no search calls, got all=%d sessions=%d", search.allCalls, search.sessionCalls)
	}
}

type searchStoreStub struct {
	results        []store.SearchResult
	sessionResults []store.SearchResult
	allCalls       int
	sessionCalls   int
}

func (s *searchStoreStub) Search(context.Context, string, int) ([]store.SearchResult, error) {
	s.allCalls++
	return s.results, nil
}

func (s *searchStoreStub) SearchSessions(context.Context, string, int) ([]store.SearchResult, error) {
	s.sessionCalls++
	return s.sessionResults, nil
}
