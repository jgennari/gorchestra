package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDashboardProjectionAggregatesDurableRunEvents(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	now := time.Date(2026, 8, 26, 14, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }

	session, err := database.CreateSession(ctx, CreateSessionParams{
		Title:         "Build dashboard",
		AgentType:     "codex",
		WorkspacePath: "/Users/joey/Source/gorchestra",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	appendDashboardEvent(t, ctx, database, session.ID, "session.status.updated", `{
		"status":"running","run_id":"run_dashboard","run_kind":"message",
		"agent_type":"codex","workspace_path":"/Users/joey/Source/gorchestra"
	}`)
	now = now.Add(2 * time.Second)
	appendDashboardEvent(t, ctx, database, session.ID, "tool.call.started", `{"run_id":"run_dashboard","tool":"apply_patch"}`)
	appendDashboardEvent(t, ctx, database, session.ID, "file.change.completed", `{"run_id":"run_dashboard","paths":["web/src/App.tsx","web/src/App.tsx","internal/store/dashboard.go"]}`)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.input.requested", `{"run_id":"run_dashboard"}`)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.permission.requested", `{"run_id":"run_dashboard"}`)
	appendDashboardEvent(t, ctx, database, session.ID, "provider.codex.event", `{
		"run_id":"run_dashboard","provider_event_type":"thread/tokenUsage/updated",
		"raw":{"tokenUsage":{"last":{"totalTokens":321}}}
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "run.outcome.recorded", `{
		"run_id":"run_dashboard","kind":"test","outcome_id":"unit-tests","status":"passed"
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.message.completed", `{
		"run_id":"run_dashboard","text":"Implemented the dashboard and verified the tests."
	}`)
	now = now.Add(8 * time.Second)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.run.completed", `{
		"run_id":"run_dashboard","total_cost_usd":0.125
	}`)

	dashboard, err := database.Dashboard(ctx, DashboardParams{Range: DashboardRange30Days, Location: time.UTC})
	if err != nil {
		t.Fatalf("load dashboard: %v", err)
	}
	if dashboard.Summary.Runs != 1 || dashboard.Summary.CompletedRuns != 1 {
		t.Fatalf("expected one completed run, got %#v", dashboard.Summary)
	}
	if dashboard.Summary.ToolCalls != 1 || dashboard.Summary.FilesChanged != 2 {
		t.Fatalf("expected one tool and two distinct files, got %#v", dashboard.Summary)
	}
	if dashboard.Summary.InputRequests != 1 || dashboard.Summary.PermissionRequests != 1 {
		t.Fatalf("expected projected requests, got %#v", dashboard.Summary)
	}
	if dashboard.Summary.AgentRuntimeMS != 10_000 {
		t.Fatalf("expected ten seconds of runtime, got %dms", dashboard.Summary.AgentRuntimeMS)
	}
	if dashboard.Usage.Tokens != 321 || dashboard.Usage.TokenRuns != 1 {
		t.Fatalf("expected explicit token usage, got %#v", dashboard.Usage)
	}
	if dashboard.Usage.CostRuns != 1 || len(dashboard.Usage.Costs) != 1 || dashboard.Usage.Costs[0].Amount != 0.125 {
		t.Fatalf("expected explicit USD cost, got %#v", dashboard.Usage)
	}
	if len(dashboard.Workspaces) != 1 || dashboard.Workspaces[0].Key != "/Users/joey/Source/gorchestra" {
		t.Fatalf("expected workspace breakdown, got %#v", dashboard.Workspaces)
	}
	if outcome := dashboardOutcomeByKind(t, dashboard.Outcomes, "test"); !outcome.Reported || outcome.Count != 1 || outcome.Passed != 1 {
		t.Fatalf("expected reported passing test outcome, got %#v", outcome)
	}
	if outcome := dashboardOutcomeByKind(t, dashboard.Outcomes, "commit"); outcome.Reported {
		t.Fatalf("expected unavailable commit outcome to remain not reported, got %#v", outcome)
	}

	page, err := database.ListDashboardRuns(ctx, DashboardRunListParams{
		DashboardParams: DashboardParams{Range: DashboardRange30Days, Location: time.UTC},
		Outcome:         "test",
	})
	if err != nil {
		t.Fatalf("list dashboard runs: %v", err)
	}
	if page.Total != 1 || len(page.Runs) != 1 {
		t.Fatalf("expected one test run, got %#v", page)
	}
	run := page.Runs[0]
	if run.ID != "run_dashboard" || run.Status != "completed" || run.Kind != "message" {
		t.Fatalf("unexpected projected run: %#v", run)
	}
	if run.Summary != "Implemented the dashboard and verified the tests." || run.Outcomes.TestsPassed != 1 {
		t.Fatalf("expected summary and test outcome, got %#v", run)
	}
}

func TestDashboardProjectionDerivesAndRebuildsShellOutcomes(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	now := time.Date(2026, 8, 26, 15, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	session := createTestSession(t, ctx, database)

	appendDashboardEvent(t, ctx, database, session.ID, "session.status.updated", `{
		"status":"running","run_id":"run_shell","run_kind":"message"
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "tool.call.completed", `{
		"run_id":"run_shell","item_id":"item_commit","command":"git commit -m dashboard",
		"aggregated_output":"[main abcdef123] dashboard outcomes\n 1 file changed","exit_code":0
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "tool.call.completed", `{
		"run_id":"run_shell","item_id":"item_test","command":"go test ./...","exit_code":1
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "tool.call.completed", `{
		"run_id":"run_shell","item_id":"item_pr","command":"gh pr create --fill",
		"aggregated_output":"https://github.com/acme/gorchestra/pull/17\n","exit_code":0
	}`)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.run.completed", `{"run_id":"run_shell"}`)

	assertShellDashboardOutcomes(t, ctx, database)

	if _, err := database.db.ExecContext(ctx, `DELETE FROM dashboard_runs`); err != nil {
		t.Fatalf("clear dashboard projection: %v", err)
	}
	if err := database.syncDashboardProjection(ctx); err != nil {
		t.Fatalf("rebuild dashboard projection: %v", err)
	}
	assertShellDashboardOutcomes(t, ctx, database)

	var payload string
	if err := database.db.QueryRowContext(ctx, `
		SELECT payload_json FROM dashboard_run_outcomes
		WHERE run_id = 'run_shell' AND kind = 'commit'`).Scan(&payload); err != nil {
		t.Fatalf("load derived outcome provenance: %v", err)
	}
	if !strings.Contains(payload, `"source":"shell"`) || !strings.Contains(payload, `"source_item_id":"item_commit"`) {
		t.Fatalf("expected shell provenance, got %s", payload)
	}
}

func assertShellDashboardOutcomes(t *testing.T, ctx context.Context, database *Store) {
	t.Helper()
	dashboard, err := database.Dashboard(ctx, DashboardParams{Range: DashboardRange30Days, Location: time.UTC})
	if err != nil {
		t.Fatalf("load dashboard: %v", err)
	}
	if outcome := dashboardOutcomeByKind(t, dashboard.Outcomes, "commit"); !outcome.Reported || outcome.Count != 1 {
		t.Fatalf("expected one derived commit, got %#v", outcome)
	}
	if outcome := dashboardOutcomeByKind(t, dashboard.Outcomes, "pull_request"); !outcome.Reported || outcome.Count != 1 {
		t.Fatalf("expected one derived pull request, got %#v", outcome)
	}
	if outcome := dashboardOutcomeByKind(t, dashboard.Outcomes, "test"); !outcome.Reported || outcome.Count != 1 || outcome.Failed != 1 {
		t.Fatalf("expected one derived failed test, got %#v", outcome)
	}

	page, err := database.ListDashboardRuns(ctx, DashboardRunListParams{
		DashboardParams: DashboardParams{Range: DashboardRange30Days, Location: time.UTC},
	})
	if err != nil {
		t.Fatalf("list dashboard runs: %v", err)
	}
	if len(page.Runs) != 1 || page.Runs[0].Outcomes.Commits != 1 || page.Runs[0].Outcomes.PullRequests != 1 || page.Runs[0].Outcomes.TestsFailed != 1 {
		t.Fatalf("unexpected derived run outcomes: %#v", page.Runs)
	}
}

func TestDashboardRunLedgerFiltersAndPaginates(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	database.now = func() time.Time { return now }
	session := createTestSession(t, ctx, database)

	appendDashboardEvent(t, ctx, database, session.ID, "session.status.updated", `{"status":"running","run_id":"run_first","run_kind":"message"}`)
	now = now.Add(time.Second)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.run.completed", `{"run_id":"run_first"}`)
	now = now.Add(time.Second)
	appendDashboardEvent(t, ctx, database, session.ID, "session.status.updated", `{"status":"running","run_id":"run_second","run_kind":"compact"}`)
	now = now.Add(3 * time.Second)
	appendDashboardEvent(t, ctx, database, session.ID, "agent.run.failed", `{"run_id":"run_second","error":"provider stopped"}`)

	params := DashboardRunListParams{
		DashboardParams: DashboardParams{Range: DashboardRange30Days, Location: time.UTC},
		Limit:           1,
	}
	first, err := database.ListDashboardRuns(ctx, params)
	if err != nil {
		t.Fatalf("list first page: %v", err)
	}
	if first.Total != 2 || len(first.Runs) != 1 || first.Runs[0].ID != "run_second" || first.NextCursor == "" {
		t.Fatalf("unexpected first page: %#v", first)
	}
	params.Cursor = first.NextCursor
	second, err := database.ListDashboardRuns(ctx, params)
	if err != nil {
		t.Fatalf("list second page: %v", err)
	}
	if len(second.Runs) != 1 || second.Runs[0].ID != "run_first" || second.NextCursor != "" {
		t.Fatalf("unexpected second page: %#v", second)
	}

	params.Cursor = ""
	params.Status = "failed"
	params.Kind = "compact"
	failed, err := database.ListDashboardRuns(ctx, params)
	if err != nil {
		t.Fatalf("filter failed compact run: %v", err)
	}
	if failed.Total != 1 || failed.Runs[0].Error != "provider stopped" {
		t.Fatalf("unexpected filtered page: %#v", failed)
	}

	params.Cursor = "not-a-cursor"
	if _, err := database.ListDashboardRuns(ctx, params); err == nil {
		t.Fatal("expected malformed cursor to fail")
	}
}

func appendDashboardEvent(t *testing.T, ctx context.Context, database *Store, sessionID, eventType, payload string) Event {
	t.Helper()
	event, err := database.AppendEvent(ctx, AppendEventParams{
		SessionID: sessionID,
		Type:      eventType,
		Role:      "assistant",
		Status:    eventStatusForType(eventType),
		Payload:   json.RawMessage(payload),
	})
	if err != nil {
		t.Fatalf("append %s: %v", eventType, err)
	}
	return event
}

func dashboardOutcomeByKind(t *testing.T, outcomes []DashboardOutcome, kind string) DashboardOutcome {
	t.Helper()
	for _, outcome := range outcomes {
		if outcome.Kind == kind {
			return outcome
		}
	}
	t.Fatalf("missing %s dashboard outcome", kind)
	return DashboardOutcome{}
}
