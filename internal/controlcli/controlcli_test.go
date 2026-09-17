package controlcli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
		"--thinking", "high", "--fast=false", "--plan=true", "--prompt", "do work",
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
