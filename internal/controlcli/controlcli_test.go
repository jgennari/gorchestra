package controlcli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCommandsCatalogWorksOffline(t *testing.T) {
	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}}
	if err := cli.Run(context.Background(), []string{"commands", "--json"}); err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		SchemaVersion int           `json:"schema_version"`
		Commands      []commandSpec `json:"commands"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.SchemaVersion != 1 || len(catalog.Commands) < 6 {
		t.Fatalf("unexpected catalog: %#v", catalog)
	}
	commands := make(map[string]bool, len(catalog.Commands))
	for _, command := range catalog.Commands {
		commands[command.Command] = true
	}
	for _, command := range []string{"sessions archive <session-id>", "sessions restore <session-id>"} {
		if !commands[command] {
			t.Fatalf("catalog missing %q", command)
		}
	}
}

func TestRunSendsProviderOptionsAndPrintsReceipt(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runs" || r.Method != http.MethodPost {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"schema_version":1,"session_id":"sess_one","run_id":"run_one","status":"running"}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}, Getwd: func() (string, error) { return "/tmp/project", nil }}
	err := cli.Run(context.Background(), []string{
		"run", "--server", server.URL, "--agent", "codex", "--model", "gpt-test",
		"--thinking", "high", "--fast=false", "--plan=true", "--prompt", "do work", "--detach", "--json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"run_id": "run_one"`) {
		t.Fatalf("missing receipt: %s", stdout.String())
	}
	provider := received["agent_options"].(map[string]any)["codex"].(map[string]any)
	if provider["fast_mode"] != false || provider["planning_mode"] != true || provider["reasoning_effort"] != "high" {
		t.Fatalf("unexpected options: %#v", provider)
	}
}

func TestRunDefaultsToCurrentSessionParent(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/sessions/sess_parent":
			_, _ = w.Write([]byte(`{"id":"sess_parent","agent_type":"fake"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/runs":
			if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"schema_version":1,"session_id":"sess_child","run_id":"run_child","status":"running","parent_session_id":"sess_parent","spawned_by_run_id":"run_parent"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	getenv := func(name string) string {
		switch name {
		case "GORCHESTRA_SESSION_ID":
			return "sess_parent"
		case "GORCHESTRA_RUN_ID":
			return "run_parent"
		}
		return ""
	}
	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}, Getenv: getenv}
	if err := cli.Run(context.Background(), []string{"run", "--server", server.URL, "--prompt", "delegate", "--detach", "--json"}); err != nil {
		t.Fatal(err)
	}
	if received["parent_session_id"] != "sess_parent" || received["spawned_by_run_id"] != "run_parent" || received["agent_type"] != "fake" {
		t.Fatalf("unexpected child request: %#v", received)
	}
	if _, ok := received["workspace_path"]; ok {
		t.Fatalf("child request should inherit workspace: %#v", received)
	}
}

func TestSessionsChildrenRequestsRecursiveLineage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/sessions/sess_parent/children" || r.URL.Query().Get("recursive") != "true" {
			t.Fatalf("unexpected request %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"schema_version":1,"parent_session_id":"sess_parent","recursive":true,"sessions":[{"id":"sess_child","parent_session_id":"sess_parent"}]}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}}
	if err := cli.Run(context.Background(), []string{"sessions", "children", "sess_parent", "--recursive", "--server", server.URL, "--json"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"id": "sess_child"`) {
		t.Fatalf("missing child response: %s", stdout.String())
	}
}

func TestSessionsArchiveAndRestore(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sessions/sess_archive/archive":
			_, _ = w.Write([]byte(`{"id":"sess_archive","status":"idle","archived_at":"2026-09-17T15:00:00Z"}`))
		case "/api/sessions/sess_restore/restore":
			_, _ = w.Write([]byte(`{"id":"sess_restore","status":"idle","archived_at":null}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	for _, test := range []struct {
		command   string
		sessionID string
		want      string
	}{
		{command: "archive", sessionID: "sess_archive", want: `"archived_at": "2026-09-17T15:00:00Z"`},
		{command: "restore", sessionID: "sess_restore", want: `"archived_at": null`},
	} {
		t.Run(test.command, func(t *testing.T) {
			var stdout bytes.Buffer
			cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}}
			if err := cli.Run(context.Background(), []string{"sessions", test.command, test.sessionID, "--server", server.URL, "--json"}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stdout.String(), test.want) {
				t.Fatalf("missing %s in %s", test.want, stdout.String())
			}
		})
	}
}

func TestRunForegroundReplaysStreamsAndReturnsResult(t *testing.T) {
	var runReads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"schema_version":1,"session_id":"sess_one","run_id":"run_one","status":"running"}`))
		case r.URL.Path == "/api/runs/run_one/events":
			_, _ = w.Write([]byte(`{"schema_version":1,"run_id":"run_one","session_id":"sess_one","events":[{"id":"evt_1","session_id":"sess_one","seq":1,"type":"tool.call.started","role":"assistant","status":"started","payload":{"command":"go test ./..."},"created_at":"2026-01-01T00:00:00Z"}],"next_after_seq":1,"has_more":false}`))
		case r.URL.Path == "/api/runs/run_one/events/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("id: 2\nevent: agent.run.completed\ndata: {\"id\":\"evt_2\",\"session_id\":\"sess_one\",\"seq\":2,\"type\":\"agent.run.completed\",\"role\":\"assistant\",\"status\":\"completed\",\"payload\":{\"run_id\":\"run_one\"},\"created_at\":\"2026-01-01T00:00:01Z\"}\n\n"))
		case r.URL.Path == "/api/runs/run_one":
			status := "running"
			terminal := ""
			if runReads.Add(1) > 1 {
				status = "completed"
				terminal = `,"terminal_seq":2,"final_response":"done"`
			}
			_, _ = fmt.Fprintf(w, `{"schema_version":1,"id":"run_one","session_id":"sess_one","status":%q,"start_seq":1%s}`, status, terminal)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}, Getwd: func() (string, error) { return "/tmp/project", nil }}
	if err := cli.Run(context.Background(), []string{"run", "--server", server.URL, "--agent", "fake", "--prompt", "work", "--format", "ndjson"}); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	for _, want := range []string{`"kind":"accepted"`, `"type":"tool.call.started"`, `"type":"agent.run.completed"`, `"kind":"result"`, `"final_response":"done"`} {
		if !strings.Contains(output, want) {
			t.Fatalf("missing %s in %s", want, output)
		}
	}
}

func TestWatchUntilAttentionReturnsRequestAndExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/runs/run_wait/events":
			_, _ = w.Write([]byte(`{"run_id":"run_wait","session_id":"sess_one","events":[],"next_after_seq":1,"has_more":false}`))
		case "/api/runs/run_wait":
			_, _ = w.Write([]byte(`{"schema_version":1,"id":"run_wait","session_id":"sess_one","status":"running","start_seq":1}`))
		case "/api/runs/run_wait/requests":
			_, _ = w.Write([]byte(`{"requests":[{"id":"evt_q","session_id":"sess_one","seq":2,"type":"agent.input.requested","role":"assistant","status":"started","payload":{"request_id":"question"},"created_at":"2026-01-01T00:00:00Z"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	var stdout bytes.Buffer
	cli := CLI{Stdout: &stdout, Stderr: &bytes.Buffer{}}
	err := cli.Run(context.Background(), []string{"runs", "watch", "run_wait", "--server", server.URL, "--json", "--until-attention"})
	if ExitCode(err) != ExitNeedsInput {
		t.Fatalf("expected exit %d, got %d: %v", ExitNeedsInput, ExitCode(err), err)
	}
	if !strings.Contains(stdout.String(), `"type": "agent.input.requested"`) {
		t.Fatalf("missing attention request: %s", stdout.String())
	}
}
