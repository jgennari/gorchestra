package store

import (
	"encoding/json"
	"testing"
)

func TestDashboardShellOutcomesDerivesCommitFromExecutedCommand(t *testing.T) {
	event := dashboardCompletedShellEvent(t, map[string]any{
		"item_id":           "item_commit",
		"command":           `/bin/zsh -lc 'git commit -m "fix: verify webhooks" && git push'`,
		"aggregated_output": "[main 29f59ca] fix: verify webhooks\n 2 files changed, 10 insertions(+), 1 deletion(-)\n",
		"exit_code":         0,
	})

	outcomes := dashboardShellOutcomes(event)
	if len(outcomes) != 1 {
		t.Fatalf("expected one commit outcome, got %#v", outcomes)
	}
	outcome := outcomes[0]
	if outcome.Kind != "commit" || outcome.Status != "created" || outcome.Reference != "29f59ca" || outcome.Title != "fix: verify webhooks" {
		t.Fatalf("unexpected commit outcome: %#v", outcome)
	}
}

func TestDashboardShellOutcomesRequiresExecutableCommandNode(t *testing.T) {
	commands := []string{
		`echo 'git commit -m fake'`,
		`printf '%s\n' 'go test ./...'`,
		`rg 'gh pr create' .`,
		`sqlite3 sessions.db "SELECT * FROM events WHERE payload_json LIKE '%git commit%'"`,
		`echo "$(git commit -m hidden)"`,
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			event := dashboardCompletedShellEvent(t, map[string]any{
				"item_id":           "item_false_positive",
				"command":           command,
				"aggregated_output": "[main abcdef1] fake\nhttps://github.com/acme/repo/pull/42",
				"exit_code":         0,
			})
			if outcomes := dashboardShellOutcomes(event); len(outcomes) != 0 {
				t.Fatalf("expected no outcome for %q, got %#v", command, outcomes)
			}
		})
	}
}

func TestDashboardShellOutcomesDerivesTestStatusFromExitCode(t *testing.T) {
	tests := []struct {
		name      string
		command   string
		exitCode  int
		framework string
		status    string
	}{
		{name: "go passing", command: `go test ./...`, exitCode: 0, framework: "go", status: "passed"},
		{name: "bun failing", command: `/bin/zsh -lc 'bun run test -- --runInBand'`, exitCode: 1, framework: "bun", status: "failed"},
		{name: "pytest passing", command: `env FOO=bar python3 -m pytest tests`, exitCode: 0, framework: "pytest", status: "passed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event := dashboardCompletedShellEvent(t, map[string]any{
				"item_id":   "item_test",
				"command":   test.command,
				"exit_code": test.exitCode,
			})
			outcomes := dashboardShellOutcomes(event)
			if len(outcomes) != 1 {
				t.Fatalf("expected one test outcome, got %#v", outcomes)
			}
			if outcomes[0].Kind != "test" || outcomes[0].Framework != test.framework || outcomes[0].Status != test.status {
				t.Fatalf("unexpected test outcome: %#v", outcomes[0])
			}
		})
	}
}

func TestDashboardShellOutcomesDoesNotMisattributeCompoundExitStatus(t *testing.T) {
	tests := []struct {
		name     string
		command  string
		exitCode int
		want     int
		status   string
	}{
		{name: "successful and chain proves test passed", command: `go test ./... && go vet ./...`, exitCode: 0, want: 1, status: "passed"},
		{name: "failed and chain is ambiguous", command: `go test ./... && go vet ./...`, exitCode: 1, want: 0},
		{name: "later sequential success hides test result", command: "go test ./...\ntrue", exitCode: 0, want: 0},
		{name: "final sequential test owns status", command: "false\ngo test ./...", exitCode: 1, want: 1, status: "failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event := dashboardCompletedShellEvent(t, map[string]any{
				"item_id":   "item_compound",
				"command":   test.command,
				"exit_code": test.exitCode,
			})
			outcomes := dashboardShellOutcomes(event)
			if len(outcomes) != test.want {
				t.Fatalf("expected %d outcomes, got %#v", test.want, outcomes)
			}
			if test.want == 1 && outcomes[0].Status != test.status {
				t.Fatalf("expected %s, got %#v", test.status, outcomes[0])
			}
		})
	}
}

func TestDashboardShellOutcomesDerivesPullRequestURL(t *testing.T) {
	event := dashboardCompletedShellEvent(t, map[string]any{
		"item_id":           "item_pr",
		"command":           `gh pr create --fill`,
		"aggregated_output": "https://github.com/acme/repo/pull/42\n",
		"exit_code":         0,
	})

	outcomes := dashboardShellOutcomes(event)
	if len(outcomes) != 1 {
		t.Fatalf("expected one pull request outcome, got %#v", outcomes)
	}
	outcome := outcomes[0]
	if outcome.Kind != "pull_request" || outcome.Reference != "42" || outcome.URL != "https://github.com/acme/repo/pull/42" {
		t.Fatalf("unexpected pull request outcome: %#v", outcome)
	}
}

func dashboardCompletedShellEvent(t *testing.T, payload map[string]any) Event {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal shell payload: %v", err)
	}
	return Event{
		ID:      "evt_shell",
		Seq:     12,
		Type:    "tool.call.completed",
		Status:  EventStatusCompleted,
		Payload: encoded,
	}
}
