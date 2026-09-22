package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

const maxSpotlightSearchResults = 50

type spotlightSearchResponse struct {
	Query      string                          `json:"query"`
	Results    []spotlightSearchResultResponse `json:"results"`
	LocalError string                          `json:"local_error,omitempty"`
}

type spotlightSearchStreamRecord struct {
	Type    string                          `json:"type"`
	Source  string                          `json:"source,omitempty"`
	Query   string                          `json:"query,omitempty"`
	Results []spotlightSearchResultResponse `json:"results,omitempty"`
	Error   string                          `json:"error,omitempty"`
}

type spotlightSearchResultResponse struct {
	ID            string  `json:"id"`
	Kind          string  `json:"kind"`
	Scope         string  `json:"scope"`
	Title         string  `json:"title"`
	Snippet       string  `json:"snippet,omitempty"`
	SessionID     string  `json:"session_id"`
	SessionTitle  string  `json:"session_title"`
	WorkspacePath string  `json:"workspace_path,omitempty"`
	EventSeq      int64   `json:"event_seq,omitempty"`
	Path          string  `json:"path,omitempty"`
	LineNumber    int     `json:"line_number,omitempty"`
	CreatedAt     string  `json:"created_at,omitempty"`
	Archived      bool    `json:"archived,omitempty"`
	Rank          float64 `json:"rank,omitempty"`
}

func (api API) searchHandler(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	history, err := api.search.Search(r.Context(), query, maxSpotlightSearchResults)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to search session history")
		return
	}
	results := spotlightStoreSearchResults(query, history)

	localError := ""
	if sessionID := strings.TrimSpace(r.URL.Query().Get("session_id")); sessionID != "" {
		localResults, localSearchError := api.searchSessionWorkspace(r.Context(), sessionID, query)
		if localSearchError != nil {
			localError = localSearchError.Error()
		} else {
			results = append(results, localResults...)
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Rank == results[j].Rank {
			if results[i].CreatedAt == results[j].CreatedAt {
				return strings.ToLower(results[i].Title) < strings.ToLower(results[j].Title)
			}
			return results[i].CreatedAt > results[j].CreatedAt
		}
		return results[i].Rank < results[j].Rank
	})
	if len(results) > maxSpotlightSearchResults {
		results = results[:maxSpotlightSearchResults]
	}
	writeJSON(w, http.StatusOK, spotlightSearchResponse{Query: query, Results: results, LocalError: localError})
}

func (api API) searchStreamHandler(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}

	headers := w.Header()
	headers.Set("Content-Type", "application/x-ndjson")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	writeRecord := func(record spotlightSearchStreamRecord) bool {
		if err := encoder.Encode(record); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	type workspaceBatch struct {
		results []spotlightSearchResultResponse
		err     error
	}
	workspace := make(chan workspaceBatch, 1)
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if sessionID != "" {
		go func() {
			results, err := api.searchSessionWorkspace(r.Context(), sessionID, query)
			workspace <- workspaceBatch{results: results, err: err}
		}()
	}

	sessions, err := api.search.SearchSessions(r.Context(), query, maxSpotlightSearchResults)
	if err != nil {
		if !writeRecord(spotlightSearchStreamRecord{Type: "error", Source: "sessions", Query: query, Error: "failed to search sessions"}) {
			return
		}
	} else if !writeRecord(spotlightSearchStreamRecord{
		Type: "results", Source: "sessions", Query: query, Results: spotlightStoreSearchResults(query, sessions),
	}) {
		return
	}

	history, err := api.search.SearchHistory(r.Context(), query, maxSpotlightSearchResults)
	if err != nil {
		if !writeRecord(spotlightSearchStreamRecord{Type: "error", Source: "history", Query: query, Error: "failed to search session history"}) {
			return
		}
	} else if !writeRecord(spotlightSearchStreamRecord{
		Type: "results", Source: "history", Query: query, Results: spotlightStoreSearchResults(query, history),
	}) {
		return
	}

	if sessionID != "" {
		batch := <-workspace
		if batch.err != nil {
			if !writeRecord(spotlightSearchStreamRecord{Type: "error", Source: "workspace", Query: query, Error: batch.err.Error()}) {
				return
			}
		} else if !writeRecord(spotlightSearchStreamRecord{
			Type: "results", Source: "workspace", Query: query, Results: batch.results,
		}) {
			return
		}
	}
	_ = writeRecord(spotlightSearchStreamRecord{Type: "done", Query: query})
}

func spotlightStoreSearchResults(query string, history []store.SearchResult) []spotlightSearchResultResponse {
	results := make([]spotlightSearchResultResponse, 0, len(history))
	for index, result := range history {
		results = append(results, spotlightSearchResultResponse{
			ID:            fmt.Sprintf("%s:%s:%d", result.Kind, result.SessionID, result.EventSeq),
			Kind:          result.Kind,
			Scope:         "global",
			Title:         result.Title,
			Snippet:       searchResultSnippet(result.Snippet),
			SessionID:     result.SessionID,
			SessionTitle:  result.SessionTitle,
			WorkspacePath: result.WorkspacePath,
			EventSeq:      result.EventSeq,
			CreatedAt:     result.CreatedAt.UTC().Format(time.RFC3339Nano),
			Archived:      result.ArchivedAt != nil,
			Rank:          spotlightTextRank(query, result.Title, result.Snippet) + float64(index)/1000,
		})
	}
	return results
}

func (api API) searchSessionWorkspace(ctx context.Context, sessionID string, query string) ([]spotlightSearchResultResponse, error) {
	session, err := api.store.GetSession(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("current session is unavailable")
	}
	workspacePath, err := api.workspaces.resolveWorkspacePath(sessionWorkspacePath(session, api.workdir))
	if err != nil || workspacePath == "" {
		return nil, fmt.Errorf("current session workspace is unavailable")
	}
	entries, err := searchWorkspace(workspacePath, workspacePath, query)
	if err != nil {
		return nil, fmt.Errorf("failed to search current session files")
	}
	results := make([]spotlightSearchResultResponse, 0, len(entries))
	for index, entry := range entries {
		if entry.Type != "file" {
			continue
		}
		kind := "file"
		if isAgentInstructionPath(entry.Path) {
			kind = "agent_instruction"
		}
		snippet := entry.LineText
		if snippet == "" {
			snippet = entry.Path
		}
		results = append(results, spotlightSearchResultResponse{
			ID:            kind + ":" + sessionID + ":" + entry.Path,
			Kind:          kind,
			Scope:         "local",
			Title:         entry.Path,
			Snippet:       searchResultSnippet(snippet),
			SessionID:     sessionID,
			SessionTitle:  session.Title,
			WorkspacePath: workspacePath,
			Path:          entry.Path,
			LineNumber:    entry.LineNumber,
			CreatedAt:     entry.ModifiedAt,
			Rank:          spotlightTextRank(query, filepath.Base(entry.Path), snippet) + float64(index)/1000,
		})
	}
	if len(results) > maxSpotlightSearchResults {
		results = results[:maxSpotlightSearchResults]
	}
	return results, nil
}

func isAgentInstructionPath(path string) bool {
	normalized := strings.ToLower(filepath.ToSlash(strings.TrimSpace(path)))
	base := filepath.Base(normalized)
	if base == "agents.md" || base == "claude.md" || base == "gemini.md" {
		return true
	}
	return normalized == ".github/copilot-instructions.md" || strings.Contains(normalized, "/.github/copilot-instructions.md")
}

func spotlightTextRank(query string, title string, snippet string) float64 {
	query = strings.ToLower(strings.TrimSpace(query))
	title = strings.ToLower(strings.TrimSpace(title))
	snippet = strings.ToLower(strings.TrimSpace(snippet))
	switch {
	case title == query:
		return 0
	case strings.HasPrefix(title, query):
		return 10
	case strings.Contains(title, query):
		return 20
	case strings.Contains(snippet, query):
		return 30
	default:
		return 40
	}
}

func searchResultSnippet(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) <= maxSearchLineSnippetRunes {
		return value
	}
	return string([]rune(value)[:maxSearchLineSnippetRunes]) + "…"
}
