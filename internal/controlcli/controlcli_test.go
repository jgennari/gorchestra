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
