package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type DashboardRange string

const (
	DashboardRange7Days  DashboardRange = "7d"
	DashboardRange30Days DashboardRange = "30d"
	DashboardRange90Days DashboardRange = "90d"
	DashboardRangeAll    DashboardRange = "all"
)

type DashboardParams struct {
	Range    DashboardRange
	Location *time.Location
}

type DashboardRunListParams struct {
	DashboardParams
	Status      string
	Kind        string
	AgentType   string
	Workspace   string
	Outcome     string
	BucketStart *time.Time
	BucketEnd   *time.Time
	Sort        string
	Cursor      string
	Limit       int
}

type DashboardSummary struct {
	Runs               int      `json:"runs"`
	CompletedRuns      int      `json:"completed_runs"`
	FailedRuns         int      `json:"failed_runs"`
	CancelledRuns      int      `json:"cancelled_runs"`
	RunningRuns        int      `json:"running_runs"`
	UnknownRuns        int      `json:"unknown_runs"`
	ActiveNow          int      `json:"active_now"`
	SuccessRate        *float64 `json:"success_rate"`
	AgentRuntimeMS     int64    `json:"agent_runtime_ms"`
	ToolCalls          int64    `json:"tool_calls"`
	FilesChanged       int64    `json:"files_changed"`
	InputRequests      int64    `json:"input_requests"`
	PermissionRequests int64    `json:"permission_requests"`
	Workspaces         int      `json:"workspaces"`
	Agents             int      `json:"agents"`
}

type DashboardActivityBucket struct {
	Start     time.Time `json:"start"`
	End       time.Time `json:"end"`
	Completed int       `json:"completed"`
	Failed    int       `json:"failed"`
	Cancelled int       `json:"cancelled"`
	Running   int       `json:"running"`
	Unknown   int       `json:"unknown"`
}

type DashboardBreakdown struct {
	Key            string   `json:"key"`
	Label          string   `json:"label"`
	Runs           int      `json:"runs"`
	CompletedRuns  int      `json:"completed_runs"`
	FailedRuns     int      `json:"failed_runs"`
	CancelledRuns  int      `json:"cancelled_runs"`
	RunningRuns    int      `json:"running_runs"`
	SuccessRate    *float64 `json:"success_rate"`
	AgentRuntimeMS int64    `json:"agent_runtime_ms"`
}

type DashboardUsageCost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
	Runs     int     `json:"runs"`
}

type DashboardUsage struct {
	Tokens       int64                `json:"tokens"`
	TokenRuns    int                  `json:"token_runs"`
	CostRuns     int                  `json:"cost_runs"`
	EligibleRuns int                  `json:"eligible_runs"`
	Costs        []DashboardUsageCost `json:"costs"`
}

type DashboardOutcome struct {
	Kind     string `json:"kind"`
	Count    int    `json:"count"`
	Passed   int    `json:"passed"`
	Failed   int    `json:"failed"`
	Reported bool   `json:"reported"`
}

type DashboardData struct {
	GeneratedAt time.Time                 `json:"generated_at"`
	Range       DashboardRange            `json:"range"`
	RangeStart  time.Time                 `json:"range_start"`
	RangeEnd    time.Time                 `json:"range_end"`
	TimeZone    string                    `json:"time_zone"`
	Bucket      string                    `json:"bucket"`
	Summary     DashboardSummary          `json:"summary"`
	Activity    []DashboardActivityBucket `json:"activity"`
	Workspaces  []DashboardBreakdown      `json:"workspaces"`
	Agents      []DashboardBreakdown      `json:"agents"`
	Usage       DashboardUsage            `json:"usage"`
	Outcomes    []DashboardOutcome        `json:"outcomes"`
}

type DashboardRunOutcomeCounts struct {
	Commits      int `json:"commits"`
	PullRequests int `json:"pull_requests"`
	Tests        int `json:"tests"`
	TestsPassed  int `json:"tests_passed"`
	TestsFailed  int `json:"tests_failed"`
	Delegations  int `json:"delegations"`
}

type DashboardRun struct {
	ID                     string                    `json:"id"`
	SessionID              string                    `json:"session_id"`
	SessionTitle           string                    `json:"session_title"`
	Kind                   string                    `json:"kind"`
	AgentType              string                    `json:"agent_type"`
	WorkspacePath          string                    `json:"workspace_path"`
	Status                 string                    `json:"status"`
	StartSeq               int64                     `json:"start_seq"`
	TerminalSeq            int64                     `json:"terminal_seq,omitempty"`
	StartedAt              time.Time                 `json:"started_at"`
	CompletedAt            *time.Time                `json:"completed_at,omitempty"`
	DurationMS             int64                     `json:"duration_ms"`
	Summary                string                    `json:"summary"`
	Error                  string                    `json:"error"`
	ToolCount              int64                     `json:"tool_count"`
	FileCount              int64                     `json:"file_count"`
	InputRequestCount      int64                     `json:"input_request_count"`
	PermissionRequestCount int64                     `json:"permission_request_count"`
	TokenCount             int64                     `json:"token_count"`
	HasTokenUsage          bool                      `json:"has_token_usage"`
	CostAmount             float64                   `json:"cost_amount"`
	CostCurrency           string                    `json:"cost_currency"`
	HasCostUsage           bool                      `json:"has_cost_usage"`
	Archived               bool                      `json:"archived"`
	Outcomes               DashboardRunOutcomeCounts `json:"outcomes"`
}

type DashboardRunPage struct {
	Runs       []DashboardRun `json:"runs"`
	NextCursor string         `json:"next_cursor,omitempty"`
	Total      int            `json:"total"`
}

type dashboardOutcomeRecord struct {
	RunID  string
	Kind   string
	Status string
}

func ValidDashboardRange(value DashboardRange) bool {
	switch value {
	case DashboardRange7Days, DashboardRange30Days, DashboardRange90Days, DashboardRangeAll:
		return true
	default:
		return false
	}
}

func (s *Store) Dashboard(ctx context.Context, params DashboardParams) (DashboardData, error) {
	params = normalizeDashboardParams(params)
	now := s.now()
	runs, err := s.loadDashboardRuns(ctx, now)
	if err != nil {
		return DashboardData{}, err
	}
	outcomes, err := s.loadDashboardOutcomes(ctx)
	if err != nil {
		return DashboardData{}, err
	}

	start, end, bucketKind := dashboardRangeBounds(params.Range, params.Location, now, runs)
	periodRuns := filterRunsByRange(runs, start, end)
	periodRunIDs := make(map[string]struct{}, len(periodRuns))
	for _, run := range periodRuns {
		periodRunIDs[run.ID] = struct{}{}
	}

	data := DashboardData{
		GeneratedAt: now,
		Range:       params.Range,
		RangeStart:  start,
		RangeEnd:    end,
		TimeZone:    params.Location.String(),
		Bucket:      bucketKind,
		Activity:    dashboardBuckets(start, end, params.Location, bucketKind),
		Usage:       DashboardUsage{Costs: []DashboardUsageCost{}},
		Outcomes: []DashboardOutcome{
			{Kind: "commit"},
			{Kind: "pull_request"},
			{Kind: "test"},
			{Kind: "delegation"},
		},
	}

	for _, run := range runs {
		if run.Status == "running" {
			data.Summary.ActiveNow++
		}
	}

	workspaceStats := make(map[string]*DashboardBreakdown)
	agentStats := make(map[string]*DashboardBreakdown)
	workspaceSet := make(map[string]struct{})
	agentSet := make(map[string]struct{})
	costs := make(map[string]*DashboardUsageCost)

	for _, run := range periodRuns {
		data.Summary.Runs++
		duration := dashboardRunDuration(run, now)
		data.Summary.AgentRuntimeMS += duration
		data.Summary.ToolCalls += run.ToolCount
		data.Summary.FilesChanged += run.FileCount
		data.Summary.InputRequests += run.InputRequestCount
		data.Summary.PermissionRequests += run.PermissionRequestCount
		incrementRunStatus(&data.Summary, run.Status)

		workspaceSet[run.WorkspacePath] = struct{}{}
		agentSet[run.AgentType] = struct{}{}
		incrementBreakdown(workspaceStats, run.WorkspacePath, workspaceLabel(run.WorkspacePath), run, duration)
		incrementBreakdown(agentStats, run.AgentType, agentLabel(run.AgentType), run, duration)

		if run.HasTokenUsage {
			data.Usage.TokenRuns++
			data.Usage.Tokens += run.TokenCount
		}
		if run.HasCostUsage && run.CostCurrency != "" {
			data.Usage.CostRuns++
			cost := costs[run.CostCurrency]
			if cost == nil {
				cost = &DashboardUsageCost{Currency: run.CostCurrency}
				costs[run.CostCurrency] = cost
			}
			cost.Amount += run.CostAmount
			cost.Runs++
		}
		if run.Status != "running" && run.Status != "unknown" {
			data.Usage.EligibleRuns++
		}

		bucketIndex := dashboardBucketIndex(data.Activity, run.StartedAt)
		if bucketIndex >= 0 {
			incrementBucketStatus(&data.Activity[bucketIndex], run.Status)
		}
	}

	data.Summary.Workspaces = len(workspaceSet)
	data.Summary.Agents = len(agentSet)
	data.Summary.SuccessRate = successRate(data.Summary.CompletedRuns, data.Summary.FailedRuns)
	data.Workspaces = sortedBreakdowns(workspaceStats)
	data.Agents = sortedBreakdowns(agentStats)
	for _, cost := range costs {
		cost.Amount = math.Round(cost.Amount*1_000_000) / 1_000_000
		data.Usage.Costs = append(data.Usage.Costs, *cost)
	}
	sort.Slice(data.Usage.Costs, func(i, j int) bool {
		return data.Usage.Costs[i].Currency < data.Usage.Costs[j].Currency
	})

	for _, outcome := range outcomes {
		if _, ok := periodRunIDs[outcome.RunID]; !ok {
			continue
		}
		for index := range data.Outcomes {
			if data.Outcomes[index].Kind != outcome.Kind {
				continue
			}
			data.Outcomes[index].Reported = true
			data.Outcomes[index].Count++
			if outcome.Kind == "test" {
				switch outcome.Status {
				case "passed", "completed", "success":
					data.Outcomes[index].Passed++
				case "failed", "error":
					data.Outcomes[index].Failed++
				}
			}
		}
	}

	return data, nil
}

func (s *Store) ListDashboardRuns(ctx context.Context, params DashboardRunListParams) (DashboardRunPage, error) {
	params.DashboardParams = normalizeDashboardParams(params.DashboardParams)
	now := s.now()
	runs, err := s.loadDashboardRuns(ctx, now)
	if err != nil {
		return DashboardRunPage{}, err
	}
	outcomes, err := s.loadDashboardOutcomes(ctx)
	if err != nil {
		return DashboardRunPage{}, err
	}
	outcomesByRun := dashboardOutcomeCounts(outcomes)

	start, end, _ := dashboardRangeBounds(params.Range, params.Location, now, runs)
	filtered := make([]DashboardRun, 0, len(runs))
	for _, run := range runs {
		if run.StartedAt.Before(start) || run.StartedAt.After(end) {
			continue
		}
		if params.Status != "" && run.Status != params.Status {
			continue
		}
		if params.Kind != "" && params.Kind != "all" && run.Kind != params.Kind {
			continue
		}
		if params.AgentType != "" && run.AgentType != params.AgentType {
			continue
		}
		if params.Workspace != "" && run.WorkspacePath != params.Workspace {
			continue
		}
		if params.BucketStart != nil && run.StartedAt.Before(*params.BucketStart) {
			continue
		}
		if params.BucketEnd != nil && !run.StartedAt.Before(*params.BucketEnd) {
			continue
		}
		run.Outcomes = outcomesByRun[run.ID]
		if params.Outcome != "" && !runHasOutcome(run.Outcomes, params.Outcome) {
			continue
		}
		filtered = append(filtered, run)
	}

	if params.Sort == "duration" {
		sort.SliceStable(filtered, func(i, j int) bool {
			if filtered[i].DurationMS == filtered[j].DurationMS {
				return newerDashboardRun(filtered[i], filtered[j])
			}
			return filtered[i].DurationMS > filtered[j].DurationMS
		})
	} else {
		sort.SliceStable(filtered, func(i, j int) bool { return newerDashboardRun(filtered[i], filtered[j]) })
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	offset, err := decodeDashboardCursor(params.Cursor)
	if err != nil {
		return DashboardRunPage{}, err
	}
	if offset > len(filtered) {
		offset = len(filtered)
	}
	endOffset := offset + limit
	if endOffset > len(filtered) {
		endOffset = len(filtered)
	}
	page := DashboardRunPage{
		Runs:  append([]DashboardRun{}, filtered[offset:endOffset]...),
		Total: len(filtered),
	}
	if endOffset < len(filtered) {
		page.NextCursor = encodeDashboardCursor(endOffset)
	}
	return page, nil
}

func (s *Store) loadDashboardRuns(ctx context.Context, now time.Time) ([]DashboardRun, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, r.session_id, s.title, r.kind, r.agent_type, r.workspace_path, r.status,
		       r.start_seq, r.terminal_seq, r.started_at, r.completed_at, r.summary, r.error,
		       r.tool_count, r.file_count, r.input_request_count, r.permission_request_count,
		       r.token_count, r.has_token_usage, r.cost_amount, r.cost_currency, r.has_cost_usage,
		       CASE WHEN s.archived_at IS NULL THEN 0 ELSE 1 END
		FROM dashboard_runs r
		JOIN sessions s ON s.id = r.session_id`)
	if err != nil {
		return nil, fmt.Errorf("load dashboard runs: %w", err)
	}
	defer rows.Close()

	runs := make([]DashboardRun, 0)
	for rows.Next() {
		var run DashboardRun
		var terminalSeq sql.NullInt64
		var startedAt string
		var completedAt sql.NullString
		var hasTokens int
		var hasCost int
		var archived int
		if err := rows.Scan(
			&run.ID, &run.SessionID, &run.SessionTitle, &run.Kind, &run.AgentType, &run.WorkspacePath, &run.Status,
			&run.StartSeq, &terminalSeq, &startedAt, &completedAt, &run.Summary, &run.Error,
			&run.ToolCount, &run.FileCount, &run.InputRequestCount, &run.PermissionRequestCount,
			&run.TokenCount, &hasTokens, &run.CostAmount, &run.CostCurrency, &hasCost, &archived,
		); err != nil {
			return nil, fmt.Errorf("scan dashboard run: %w", err)
		}
		parsedStart, err := parseTime(startedAt)
		if err != nil {
			return nil, fmt.Errorf("parse dashboard run started_at: %w", err)
		}
		run.StartedAt = parsedStart
		if terminalSeq.Valid {
			run.TerminalSeq = terminalSeq.Int64
		}
		if completedAt.Valid {
			parsedCompleted, err := parseTime(completedAt.String)
			if err != nil {
				return nil, fmt.Errorf("parse dashboard run completed_at: %w", err)
			}
			run.CompletedAt = &parsedCompleted
		}
		run.HasTokenUsage = hasTokens != 0
		run.HasCostUsage = hasCost != 0
		run.Archived = archived != 0
		run.DurationMS = dashboardRunDuration(run, now)
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load dashboard run rows: %w", err)
	}
	return runs, nil
}

func (s *Store) loadDashboardOutcomes(ctx context.Context) ([]dashboardOutcomeRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT run_id, kind, status FROM dashboard_run_outcomes`)
	if err != nil {
		return nil, fmt.Errorf("load dashboard outcomes: %w", err)
	}
	defer rows.Close()
	records := make([]dashboardOutcomeRecord, 0)
	for rows.Next() {
		var record dashboardOutcomeRecord
		if err := rows.Scan(&record.RunID, &record.Kind, &record.Status); err != nil {
			return nil, fmt.Errorf("scan dashboard outcome: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load dashboard outcome rows: %w", err)
	}
	return records, nil
}

func normalizeDashboardParams(params DashboardParams) DashboardParams {
	if !ValidDashboardRange(params.Range) {
		params.Range = DashboardRange30Days
	}
	if params.Location == nil {
		params.Location = time.UTC
	}
	return params
}

func dashboardRangeBounds(value DashboardRange, location *time.Location, now time.Time, runs []DashboardRun) (time.Time, time.Time, string) {
	localNow := now.In(location)
	localMidnight := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	start := localMidnight
	bucket := "day"
	switch value {
	case DashboardRange7Days:
		start = localMidnight.AddDate(0, 0, -6)
	case DashboardRange90Days:
		start = localMidnight.AddDate(0, 0, -89)
		bucket = "week"
	case DashboardRangeAll:
		bucket = "month"
		if len(runs) > 0 {
			earliest := runs[0].StartedAt
			for _, run := range runs[1:] {
				if run.StartedAt.Before(earliest) {
					earliest = run.StartedAt
				}
			}
			localEarliest := earliest.In(location)
			start = time.Date(localEarliest.Year(), localEarliest.Month(), 1, 0, 0, 0, 0, location)
		} else {
			start = time.Date(localNow.Year(), localNow.Month(), 1, 0, 0, 0, 0, location)
		}
	default:
		start = localMidnight.AddDate(0, 0, -29)
	}
	return start.UTC(), now, bucket
}

func filterRunsByRange(runs []DashboardRun, start time.Time, end time.Time) []DashboardRun {
	filtered := make([]DashboardRun, 0, len(runs))
	for _, run := range runs {
		if !run.StartedAt.Before(start) && !run.StartedAt.After(end) {
			filtered = append(filtered, run)
		}
	}
	return filtered
}

func dashboardBuckets(start time.Time, end time.Time, location *time.Location, kind string) []DashboardActivityBucket {
	localStart := start.In(location)
	localEnd := end.In(location)
	if kind == "week" {
		weekday := (int(localStart.Weekday()) + 6) % 7
		localStart = time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 0, 0, 0, location).AddDate(0, 0, -weekday)
	} else if kind == "month" {
		localStart = time.Date(localStart.Year(), localStart.Month(), 1, 0, 0, 0, 0, location)
	} else {
		localStart = time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 0, 0, 0, location)
	}
	buckets := make([]DashboardActivityBucket, 0)
	for cursor := localStart; !cursor.After(localEnd); {
		var next time.Time
		switch kind {
		case "week":
			next = cursor.AddDate(0, 0, 7)
		case "month":
			next = cursor.AddDate(0, 1, 0)
		default:
			next = cursor.AddDate(0, 0, 1)
		}
		buckets = append(buckets, DashboardActivityBucket{Start: cursor.UTC(), End: next.UTC()})
		cursor = next
	}
	return buckets
}

func dashboardBucketIndex(buckets []DashboardActivityBucket, value time.Time) int {
	for index := range buckets {
		if !value.Before(buckets[index].Start) && value.Before(buckets[index].End) {
			return index
		}
	}
	return -1
}

func dashboardRunDuration(run DashboardRun, now time.Time) int64 {
	end := now
	if run.CompletedAt != nil {
		end = *run.CompletedAt
	}
	if end.Before(run.StartedAt) {
		return 0
	}
	return end.Sub(run.StartedAt).Milliseconds()
}

func incrementRunStatus(summary *DashboardSummary, status string) {
	switch status {
	case "completed":
		summary.CompletedRuns++
	case "failed":
		summary.FailedRuns++
	case "cancelled":
		summary.CancelledRuns++
	case "running":
		summary.RunningRuns++
	default:
		summary.UnknownRuns++
	}
}

func incrementBucketStatus(bucket *DashboardActivityBucket, status string) {
	switch status {
	case "completed":
		bucket.Completed++
	case "failed":
		bucket.Failed++
	case "cancelled":
		bucket.Cancelled++
	case "running":
		bucket.Running++
	default:
		bucket.Unknown++
	}
}

func incrementBreakdown(values map[string]*DashboardBreakdown, key string, label string, run DashboardRun, duration int64) {
	value := values[key]
	if value == nil {
		value = &DashboardBreakdown{Key: key, Label: label}
		values[key] = value
	}
	value.Runs++
	value.AgentRuntimeMS += duration
	switch run.Status {
	case "completed":
		value.CompletedRuns++
	case "failed":
		value.FailedRuns++
	case "cancelled":
		value.CancelledRuns++
	case "running":
		value.RunningRuns++
	}
}

func sortedBreakdowns(values map[string]*DashboardBreakdown) []DashboardBreakdown {
	result := make([]DashboardBreakdown, 0, len(values))
	for _, value := range values {
		value.SuccessRate = successRate(value.CompletedRuns, value.FailedRuns)
		result = append(result, *value)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Runs == result[j].Runs {
			return strings.ToLower(result[i].Label) < strings.ToLower(result[j].Label)
		}
		return result[i].Runs > result[j].Runs
	})
	return result
}

func successRate(completed int, failed int) *float64 {
	denominator := completed + failed
	if denominator == 0 {
		return nil
	}
	value := float64(completed) / float64(denominator)
	return &value
}

func workspaceLabel(path string) string {
	normalized := strings.TrimRight(strings.ReplaceAll(path, "\\", "/"), "/")
	if normalized == "" {
		return "Default workspace"
	}
	label := filepath.Base(normalized)
	if label == "." || label == string(filepath.Separator) || label == "" {
		return normalized
	}
	return label
}

func agentLabel(value string) string {
	switch strings.ToLower(value) {
	case "codex":
		return "Codex"
	case "claude":
		return "Claude"
	case "opencode":
		return "OpenCode"
	case "pi":
		return "Pi"
	default:
		if value == "" {
			return "Unknown"
		}
		return value
	}
}

func dashboardOutcomeCounts(records []dashboardOutcomeRecord) map[string]DashboardRunOutcomeCounts {
	result := make(map[string]DashboardRunOutcomeCounts)
	for _, record := range records {
		value := result[record.RunID]
		switch record.Kind {
		case "commit":
			value.Commits++
		case "pull_request":
			value.PullRequests++
		case "test":
			value.Tests++
			switch record.Status {
			case "passed", "completed", "success":
				value.TestsPassed++
			case "failed", "error":
				value.TestsFailed++
			}
		case "delegation":
			value.Delegations++
		}
		result[record.RunID] = value
	}
	return result
}

func runHasOutcome(value DashboardRunOutcomeCounts, kind string) bool {
	switch kind {
	case "commit":
		return value.Commits > 0
	case "pull_request":
		return value.PullRequests > 0
	case "test":
		return value.Tests > 0
	case "delegation":
		return value.Delegations > 0
	default:
		return true
	}
}

func newerDashboardRun(left DashboardRun, right DashboardRun) bool {
	if left.StartedAt.Equal(right.StartedAt) {
		return left.ID > right.ID
	}
	return left.StartedAt.After(right.StartedAt)
}

func encodeDashboardCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeDashboardCursor(cursor string) (int, error) {
	if strings.TrimSpace(cursor) == "" {
		return 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, fmt.Errorf("%w: invalid dashboard cursor", ErrInvalidArgument)
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		return 0, fmt.Errorf("%w: invalid dashboard cursor", ErrInvalidArgument)
	}
	return offset, nil
}
