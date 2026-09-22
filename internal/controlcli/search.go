package controlcli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type searchResult struct {
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

type searchResponse struct {
	Query      string         `json:"query"`
	Results    []searchResult `json:"results"`
	LocalError string         `json:"local_error,omitempty"`
}

type searchStreamRecord struct {
	Type    string         `json:"type"`
	Source  string         `json:"source,omitempty"`
	Query   string         `json:"query,omitempty"`
	Results []searchResult `json:"results,omitempty"`
	Error   string         `json:"error,omitempty"`
}

func (c CLI) search(ctx context.Context, args []string) error {
	sessionID := strings.TrimSpace(c.Getenv("THREAVE_SESSION_ID"))
	cleaned := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--session" {
			if index+1 >= len(args) {
				return usageError("--session requires a value")
			}
			index++
			sessionID = args[index]
			continue
		}
		if strings.HasPrefix(arg, "--session=") {
			sessionID = strings.TrimPrefix(arg, "--session=")
			continue
		}
		cleaned = append(cleaned, arg)
	}

	server, format, timeout, rest, err := parseSimpleOptions(cleaned, c.server())
	if err != nil {
		return err
	}
	for _, arg := range rest {
		if strings.HasPrefix(arg, "--") {
			return usageError("unknown search option %q", arg)
		}
	}
	query := strings.TrimSpace(strings.Join(rest, " "))
	if query == "" {
		return usageError("usage: threave search <query> [--session <session-id|current|none>] [--format text|json|ndjson]")
	}

	switch strings.ToLower(strings.TrimSpace(sessionID)) {
	case "none":
		sessionID = ""
	case "current":
		sessionID = strings.TrimSpace(c.Getenv("THREAVE_SESSION_ID"))
		if sessionID == "" {
			return usageError("--session current requires THREAVE_SESSION_ID")
		}
	default:
		sessionID = strings.TrimSpace(sessionID)
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	params := url.Values{"q": []string{query}}
	if sessionID != "" {
		params.Set("session_id", sessionID)
	}
	if format == "ndjson" {
		return c.streamSearch(ctx, server+"/api/search/stream?"+params.Encode())
	}

	var response searchResponse
	if err := c.doJSON(ctx, http.MethodGet, server+"/api/search?"+params.Encode(), nil, &response); err != nil {
		return err
	}
	if format == "json" {
		return writeJSON(c.Stdout, response)
	}
	return c.renderSearchText(response)
}

func (c CLI) streamSearch(ctx context.Context, target string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/x-ndjson")
	response, err := c.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return transportError("Threave search stream %s: %v", target, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(response.Body)
		return transportError("Threave search stream returned %s: %s", response.Status, strings.TrimSpace(string(raw)))
	}

	encoder := json.NewEncoder(c.Stdout)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var record searchStreamRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return transportError("decode Threave search stream: %v", err)
		}
		if err := encoder.Encode(record); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return transportError("read Threave search stream: %v", err)
	}
	return nil
}

func (c CLI) renderSearchText(response searchResponse) error {
	for _, result := range response.Results {
		title := strings.Join(strings.Fields(result.Title), " ")
		location := result.SessionID
		switch result.Kind {
		case "file", "agent_instruction":
			location = result.Path
			if result.LineNumber > 0 {
				location += fmt.Sprintf(":%d", result.LineNumber)
			}
		case "session":
			if result.Archived {
				location += " archived"
			}
		default:
			if result.EventSeq > 0 {
				location += fmt.Sprintf(" event:%d", result.EventSeq)
			}
		}
		if _, err := fmt.Fprintf(c.Stdout, "%s\t%s\t%s", result.Kind, title, location); err != nil {
			return err
		}
		snippet := strings.Join(strings.Fields(result.Snippet), " ")
		if snippet != "" && snippet != title {
			if _, err := fmt.Fprintf(c.Stdout, "\t%s", snippet); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintln(c.Stdout); err != nil {
			return err
		}
	}
	if response.LocalError != "" {
		_, err := fmt.Fprintf(c.Stderr, "workspace search: %s\n", response.LocalError)
		return err
	}
	return nil
}
