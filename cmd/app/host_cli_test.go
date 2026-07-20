package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHostCLIStatusUsesEnvironmentDefaults(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		writeHostCLITestStatus(t, w, "running", "http://demo.localhost:8080")
	}))
	defer server.Close()

	stdout := &bytes.Buffer{}
	cli := hostCLI{
		client: server.Client(),
		stdout: stdout,
		stderr: &bytes.Buffer{},
		getenv: func(key string) string {
			switch key {
			case "GORCHESTRA_API_URL":
				return server.URL
			case "GORCHESTRA_SESSION_ID":
				return "sess_1"
			default:
				return ""
			}
		},
	}

	if err := cli.run(context.Background(), []string{"status"}); err != nil {
		t.Fatalf("run status: %v", err)
	}
	if path != "/api/sessions/sess_1/host" {
		t.Fatalf("unexpected path %q", path)
	}
	if !strings.Contains(stdout.String(), `"status": "running"`) {
		t.Fatalf("status output missing runtime: %s", stdout.String())
	}
}

func TestHostCLIStartWaitsUntilRunning(t *testing.T) {
	var statusCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			writeHostCLITestStatus(t, w, "starting", "http://demo.localhost:8080")
			return
		}
		if statusCalls.Add(1) < 2 {
			writeHostCLITestStatus(t, w, "starting", "http://demo.localhost:8080")
			return
		}
		writeHostCLITestStatus(t, w, "running", "http://demo.localhost:8080")
	}))
	defer server.Close()

	stdout := &bytes.Buffer{}
	cli := hostCLI{client: server.Client(), stdout: stdout, stderr: &bytes.Buffer{}, getenv: func(string) string { return "" }}
	if err := cli.run(context.Background(), []string{
		"start",
		"--server", server.URL,
		"--session", "sess_1",
		"--timeout", "2s",
	}); err != nil {
		t.Fatalf("run start: %v", err)
	}
	if statusCalls.Load() < 2 {
		t.Fatalf("expected polling, got %d status calls", statusCalls.Load())
	}
	if !strings.Contains(stdout.String(), `"status": "running"`) {
		t.Fatalf("start output missing running status: %s", stdout.String())
	}
}

func TestHostCLIURLRequiresRuntimeURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeHostCLITestStatus(t, w, "stopped", "")
	}))
	defer server.Close()

	cli := hostCLI{client: server.Client(), stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}, getenv: func(string) string { return "" }}
	err := cli.run(context.Background(), []string{"url", "--server", server.URL, "--session", "sess_1"})
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("expected unavailable URL error, got %v", err)
	}
}

func writeHostCLITestStatus(t *testing.T, w http.ResponseWriter, status string, rawURL string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(hostStatusResponse{
		SessionID: "sess_1",
		Config:    hostConfigResponse{Path: ".gorchestra/host.yaml", Present: true, Valid: true, Errors: []string{}},
		Runtime:   hostRuntimeResponse{Status: status, URL: rawURL},
		Services:  []hostServiceResponse{},
	}); err != nil {
		t.Fatalf("encode status: %v", err)
	}
}

func TestHostCommandTerminal(t *testing.T) {
	cases := []struct {
		command string
		status  string
		want    bool
	}{
		{"start", "running", true},
		{"restart", "failed", true},
		{"stop", "stopped", true},
		{"stop", "running", false},
		{"start", "starting", false},
	}
	for _, test := range cases {
		t.Run(test.command+"-"+test.status, func(t *testing.T) {
			if got := hostCommandTerminal(test.command, test.status); got != test.want {
				t.Fatalf("hostCommandTerminal(%q, %q) = %v, want %v", test.command, test.status, got, test.want)
			}
		})
	}
}

func TestHostCLIDefaultTimeout(t *testing.T) {
	if defaultHostCommandTimeout != 60*time.Second {
		t.Fatalf("unexpected default timeout %s", defaultHostCommandTimeout)
	}
}
