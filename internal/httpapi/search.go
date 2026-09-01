package httpapi

import (
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxSpotlightSearchResults = 50

type spotlightSearchResponse struct {
	Query      string                          `json:"query"`
	Results    []spotlightSearchResultResponse `json:"results"`
	LocalError string                          `json:"local_error,omitempty"`
}

type spotlightSearchResultResponse struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Scope         string `json:"scope"`
	Title         string `json:"title"`
	Snippet       string `json:"snippet,omitempty"`
	SessionID     string `json:"session_id"`
	SessionTitle  string `json:"session_title"`
	WorkspacePath string `json:"workspace_path,omitempty"`
	EventSeq      int64  `json:"event_seq,omitempty"`
	Path          string `json:"path,omitempty"`
	LineNumber    int    `json:"line_number,omitempty"`
	CreatedAt     string `json:"created_at,omitempty"`
	Archived      bool   `json:"archived,omitempty"`
	rank          float64
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
	results := make([]spotlightSearchResultResponse, 0, len(history)+maxSearchResults)
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
			rank:          spotlightTextRank(query, result.Title, result.Snippet) + float64(index)/1000,
		})
	}

	localError := ""
	if sessionID := strings.TrimSpace(r.URL.Query().Get("session_id")); sessionID != "" {
		localResults, localSearchError := api.searchSessionWorkspace(r, sessionID, query)
		if localSearchError != nil {
			localError = localSearchError.Error()
		} else {
			results = append(results, localResults...)
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].rank == results[j].rank {
			if results[i].CreatedAt == results[j].CreatedAt {
				return strings.ToLower(results[i].Title) < strings.ToLower(results[j].Title)
			}
			return results[i].CreatedAt > results[j].CreatedAt
		}
		return results[i].rank < results[j].rank
	})
	if len(results) > maxSpotlightSearchResults {
		results = results[:maxSpotlightSearchResults]
	}
	writeJSON(w, http.StatusOK, spotlightSearchResponse{Query: query, Results: results, LocalError: localError})
}

func (api API) searchSessionWorkspace(r *http.Request, sessionID string, query string) ([]spotlightSearchResultResponse, error) {
	session, err := api.store.GetSession(r.Context(), sessionID)
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
			rank:          spotlightTextRank(query, filepath.Base(entry.Path), snippet) + float64(index)/1000,
		})
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
