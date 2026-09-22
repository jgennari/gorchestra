package controlcli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	ExitRunFailed   = 1
	ExitUsage       = 2
	ExitTransport   = 3
	ExitTimeout     = 4
	ExitCancelled   = 5
	ExitNeedsInput  = 6
	ExitInterrupted = 130
)

type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exit *ExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	if errors.Is(err, context.Canceled) {
		return ExitInterrupted
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ExitTimeout
	}
	return ExitRunFailed
}

func usageError(message string, args ...any) error {
	return &ExitError{Code: ExitUsage, Err: fmt.Errorf(message, args...)}
}
func transportError(message string, args ...any) error {
	return &ExitError{Code: ExitTransport, Err: fmt.Errorf(message, args...)}
}

type runReceipt struct {
	SchemaVersion   int    `json:"schema_version"`
	RequestID       string `json:"request_id,omitempty"`
	SessionID       string `json:"session_id"`
	RunID           string `json:"run_id"`
	Status          string `json:"status"`
	AgentType       string `json:"agent_type,omitempty"`
	WorkspacePath   string `json:"workspace_path,omitempty"`
	ParentSessionID string `json:"parent_session_id,omitempty"`
	SpawnedByRunID  string `json:"spawned_by_run_id,omitempty"`
}

type runRecord struct {
	SchemaVersion          int     `json:"schema_version"`
	ID                     string  `json:"id"`
	SessionID              string  `json:"session_id"`
	SessionTitle           string  `json:"session_title,omitempty"`
	Kind                   string  `json:"kind,omitempty"`
	AgentType              string  `json:"agent_type,omitempty"`
	WorkspacePath          string  `json:"workspace_path,omitempty"`
	Status                 string  `json:"status"`
	StartSeq               int64   `json:"start_seq"`
	TerminalSeq            int64   `json:"terminal_seq,omitempty"`
	StartedAt              string  `json:"started_at,omitempty"`
	CompletedAt            *string `json:"completed_at,omitempty"`
	RequestedOptions       any     `json:"requested_options,omitempty"`
	ResolvedOptions        any     `json:"resolved_options,omitempty"`
	FinalResponse          string  `json:"final_response,omitempty"`
	FinalResponseSeq       int64   `json:"final_response_seq,omitempty"`
	Error                  string  `json:"error,omitempty"`
	ToolCount              int64   `json:"tool_count"`
	FileCount              int64   `json:"file_count"`
	InputRequestCount      int64   `json:"input_request_count"`
	PermissionRequestCount int64   `json:"permission_request_count"`
	TokenCount             *int64  `json:"token_count,omitempty"`
	Cost                   any     `json:"cost,omitempty"`
	ParentSessionID        string  `json:"parent_session_id,omitempty"`
	SpawnedByRunID         string  `json:"spawned_by_run_id,omitempty"`
}

type eventRecord struct {
	ID        string          `json:"id"`
	SessionID string          `json:"session_id"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Status    string          `json:"status"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
	Transient bool            `json:"transient,omitempty"`
}

type runEventsPage struct {
	RunID        string        `json:"run_id"`
	SessionID    string        `json:"session_id"`
	Events       []eventRecord `json:"events"`
	NextAfterSeq int64         `json:"next_after_seq"`
	HasMore      bool          `json:"has_more"`
}

func validFormat(format string) bool {
	return format == "text" || format == "json" || format == "ndjson"
}

func (c CLI) renderValue(format, kind string, value any) error {
	switch format {
	case "json":
		return writeJSON(c.Stdout, value)
	case "ndjson":
		return json.NewEncoder(c.Stdout).Encode(map[string]any{"schema_version": 1, "kind": kind, kind: value})
	case "text":
		switch typed := value.(type) {
		case runReceipt:
			_, err := fmt.Fprintf(c.Stdout, "accepted run %s (session %s)\n", typed.RunID, typed.SessionID)
			return err
		case runRecord:
			if typed.FinalResponse != "" {
				_, _ = fmt.Fprintln(c.Stdout, typed.FinalResponse)
			}
			_, err := fmt.Fprintf(c.Stdout, "run %s %s\n", typed.ID, typed.Status)
			if typed.Error != "" {
				_, _ = fmt.Fprintln(c.Stdout, typed.Error)
			}
			return err
		default:
			return writeJSON(c.Stdout, value)
		}
	default:
		return usageError("unsupported format %q", format)
	}
}

func (c CLI) renderEvent(format, runID string, event eventRecord) error {
	if format == "json" {
		return nil
	}
	if format == "ndjson" {
		return json.NewEncoder(c.Stdout).Encode(map[string]any{"schema_version": 1, "kind": "event", "run_id": runID, "event": event})
	}
	var payload map[string]any
	_ = json.Unmarshal(event.Payload, &payload)
	detail := ""
	for _, key := range []string{"text", "message", "command", "name", "output", "error"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			detail = strings.TrimSpace(value)
			break
		}
	}
	if len(detail) > 500 {
		detail = detail[:500] + "…"
	}
	if detail == "" {
		_, err := fmt.Fprintf(c.Stdout, "[%d] %s\n", event.Seq, event.Type)
		return err
	}
	_, err := fmt.Fprintf(c.Stdout, "[%d] %s: %s\n", event.Seq, event.Type, detail)
	return err
}

func (c CLI) watchRun(ctx context.Context, server, runID, format string, after int64, untilAttention bool) error {
	server = strings.TrimRight(server, "/")
	for {
		pageURL := fmt.Sprintf("%s/api/runs/%s/events?after_seq=%d&limit=500", server, url.PathEscape(runID), after)
		var page runEventsPage
		if err := c.doJSON(ctx, http.MethodGet, pageURL, nil, &page); err != nil {
			return err
		}
		for _, event := range page.Events {
			if err := c.renderEvent(format, runID, event); err != nil {
				return err
			}
		}
		if page.NextAfterSeq > after {
			after = page.NextAfterSeq
		}
		if !page.HasMore {
			break
		}
	}
	var current runRecord
	if err := c.doJSON(ctx, http.MethodGet, server+"/api/runs/"+url.PathEscape(runID), nil, &current); err != nil {
		return err
	}
	if terminalStatus(current.Status) {
		return c.finishRun(format, current)
	}
	if untilAttention {
		var pending struct {
			Requests []eventRecord `json:"requests"`
		}
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/runs/"+url.PathEscape(runID)+"/requests", nil, &pending); err != nil {
			return err
		}
		if len(pending.Requests) > 0 {
			return c.finishAttention(format, runID, pending.Requests[0])
		}
	}

	for {
		resync, err := c.consumeRunStream(ctx, server, runID, format, &after, untilAttention)
		if err != nil {
			return err
		}
		if resync {
			for {
				var page runEventsPage
				target := fmt.Sprintf("%s/api/runs/%s/events?after_seq=%d&limit=500", server, url.PathEscape(runID), after)
				if err := c.doJSON(ctx, http.MethodGet, target, nil, &page); err != nil {
					return err
				}
				for _, event := range page.Events {
					if err := c.renderEvent(format, runID, event); err != nil {
						return err
					}
				}
				if page.NextAfterSeq > after {
					after = page.NextAfterSeq
				}
				if !page.HasMore {
					break
				}
			}
			continue
		}
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/runs/"+url.PathEscape(runID), nil, &current); err != nil {
			return err
		}
		if terminalStatus(current.Status) {
			return c.finishRun(format, current)
		}
		return transportError("run stream closed before %s became terminal; resume with --after-seq %d", runID, after)
	}
}

func (c CLI) consumeRunStream(ctx context.Context, server, runID, format string, after *int64, untilAttention bool) (bool, error) {
	target := fmt.Sprintf("%s/api/runs/%s/events/stream?after_seq=%d", server, url.PathEscape(runID), *after)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "text/event-stream")
	response, err := c.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, transportError("Threave run stream %s: %v", target, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(response.Body)
		return false, transportError("Threave run stream returned %s: %s", response.Status, strings.TrimSpace(string(raw)))
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	eventType := ""
	data := make([]string, 0, 1)
	dispatch := func() (bool, bool, error) {
		if len(data) == 0 {
			eventType = ""
			return false, false, nil
		}
		raw := []byte(strings.Join(data, "\n"))
		data = data[:0]
		if eventType == "stream.resync.required" {
			eventType = ""
			return true, false, nil
		}
		var event eventRecord
		if err := json.Unmarshal(raw, &event); err != nil {
			return false, false, transportError("decode run stream event: %v", err)
		}
		if err := c.renderEvent(format, runID, event); err != nil {
			return false, false, err
		}
		if !event.Transient && event.Seq > *after {
			*after = event.Seq
		}
		if untilAttention && (event.Type == "agent.input.requested" || event.Type == "agent.permission.requested") {
			return false, false, c.finishAttention(format, runID, event)
		}
		terminal := event.Type == "agent.run.completed" || event.Type == "agent.run.failed" || event.Type == "agent.run.cancelled"
		eventType = ""
		return false, terminal, nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			resync, terminal, dispatchErr := dispatch()
			if dispatchErr != nil || resync || terminal {
				return resync, dispatchErr
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return false, transportError("read run stream at sequence %d: %v", *after, err)
	}
	return false, nil
}

func (c CLI) finishAttention(format, runID string, event eventRecord) error {
	if format == "json" {
		if err := c.renderValue(format, "attention", map[string]any{"schema_version": 1, "run_id": runID, "request": event}); err != nil {
			return err
		}
	}
	return &ExitError{Code: ExitNeedsInput, Err: fmt.Errorf("run %s needs input", runID)}
}

func (c CLI) finishRun(format string, current runRecord) error {
	if err := c.renderValue(format, "result", current); err != nil {
		return err
	}
	switch current.Status {
	case "completed":
		return nil
	case "cancelled":
		return &ExitError{Code: ExitCancelled, Err: fmt.Errorf("run %s was cancelled", current.ID)}
	default:
		return &ExitError{Code: ExitRunFailed, Err: fmt.Errorf("run %s %s", current.ID, current.Status)}
	}
}

func terminalStatus(status string) bool {
	return status != "" && status != "accepted" && status != "running" && status != "cancelling"
}

func parseSimpleOptions(args []string, fallback string) (server, format string, timeout time.Duration, rest []string, err error) {
	server, format = strings.TrimRight(fallback, "/"), "json"
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			format = "json"
		case arg == "--server" || arg == "--format" || arg == "--timeout":
			if i+1 >= len(args) {
				return "", "", 0, nil, usageError("%s requires a value", arg)
			}
			i++
			value := args[i]
			if arg == "--server" {
				server = strings.TrimRight(value, "/")
			}
			if arg == "--format" {
				format = value
			}
			if arg == "--timeout" {
				timeout, err = time.ParseDuration(value)
				if err != nil {
					return "", "", 0, nil, usageError("invalid timeout: %v", err)
				}
			}
		case strings.HasPrefix(arg, "--server="):
			server = strings.TrimRight(strings.TrimPrefix(arg, "--server="), "/")
		case strings.HasPrefix(arg, "--format="):
			format = strings.TrimPrefix(arg, "--format=")
		case strings.HasPrefix(arg, "--timeout="):
			timeout, err = time.ParseDuration(strings.TrimPrefix(arg, "--timeout="))
			if err != nil {
				return "", "", 0, nil, usageError("invalid timeout: %v", err)
			}
		default:
			rest = append(rest, arg)
		}
	}
	if !validFormat(format) {
		return "", "", 0, nil, usageError("--format must be text, json, or ndjson")
	}
	parsed, parseErr := url.Parse(server)
	if parseErr != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", "", 0, nil, usageError("invalid --server URL %q", server)
	}
	return
}

func (c CLI) runCommands(ctx context.Context, args []string) error {
	after := int64(0)
	reason := ""
	untilAttention := false
	cleaned := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--after-seq" {
			if index+1 >= len(args) {
				return usageError("--after-seq requires a value")
			}
			index++
			value, scanErr := strconv.ParseInt(args[index], 10, 64)
			after = value
			if scanErr != nil || after < 0 {
				return usageError("--after-seq must be a non-negative integer")
			}
			continue
		}
		if strings.HasPrefix(arg, "--after-seq=") {
			value, scanErr := strconv.ParseInt(strings.TrimPrefix(arg, "--after-seq="), 10, 64)
			after = value
			if scanErr != nil || after < 0 {
				return usageError("--after-seq must be a non-negative integer")
			}
			continue
		}
		if arg == "--reason" {
			if index+1 >= len(args) {
				return usageError("--reason requires a value")
			}
			index++
			reason = args[index]
			continue
		}
		if strings.HasPrefix(arg, "--reason=") {
			reason = strings.TrimPrefix(arg, "--reason=")
			continue
		}
		if arg == "--until-attention" {
			untilAttention = true
			continue
		}
		cleaned = append(cleaned, arg)
	}
	server, format, timeout, rest, err := parseSimpleOptions(cleaned, c.server())
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return usageError("usage: threave runs show|report|watch|wait|cancel <run-id>...")
	}
	command, ids := rest[0], rest[1:]
	if after != 0 && command != "watch" {
		return usageError("--after-seq is only valid with runs watch")
	}
	if reason != "" && command != "cancel" {
		return usageError("--reason is only valid with runs cancel")
	}
	if untilAttention && command != "watch" {
		return usageError("--until-attention is only valid with runs watch")
	}
	if containsArg(args, "--any") && containsArg(args, "--all") {
		return usageError("--any and --all are mutually exclusive")
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	switch command {
	case "show", "report":
		if len(ids) != 1 {
			return usageError("runs %s requires one run ID", command)
		}
		path := "/api/runs/" + url.PathEscape(ids[0])
		if command == "report" {
			path += "/report"
		}
		var value any
		if err := c.doJSON(ctx, http.MethodGet, server+path, nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, command, value)
	case "watch":
		if len(ids) != 1 {
			return usageError("runs watch requires one run ID")
		}
		err := c.watchRun(ctx, server, ids[0], format, after, untilAttention)
		if errors.Is(err, context.DeadlineExceeded) {
			return &ExitError{Code: ExitTimeout, Err: fmt.Errorf("timed out waiting for run %s", ids[0])}
		}
		return err
	case "wait":
		return c.waitRuns(ctx, server, ids, format, containsArg(args, "--any"))
	case "cancel":
		if len(ids) != 1 {
			return usageError("runs cancel requires one run ID")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodPost, server+"/api/runs/"+url.PathEscape(ids[0])+"/cancel", map[string]any{"reason": reason}, &value); err != nil {
			return err
		}
		return c.renderValue(format, "cancelled", value)
	default:
		return usageError("unknown runs command %q", command)
	}
}

func containsArg(args []string, wanted string) bool {
	for _, arg := range args {
		if arg == wanted {
			return true
		}
	}
	return false
}

func (c CLI) waitRuns(ctx context.Context, server string, ids []string, format string, anyMode bool) error {
	filtered := ids[:0]
	for _, id := range ids {
		if id != "--any" && id != "--all" {
			filtered = append(filtered, id)
		}
	}
	ids = filtered
	if len(ids) == 0 {
		return usageError("runs wait requires at least one run ID")
	}
	results := make(map[string]runRecord, len(ids))
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, id := range ids {
			if _, done := results[id]; done {
				continue
			}
			var run runRecord
			if err := c.doJSON(ctx, http.MethodGet, server+"/api/runs/"+url.PathEscape(id), nil, &run); err != nil {
				return err
			}
			if terminalStatus(run.Status) {
				results[id] = run
				if anyMode {
					return c.renderWait(format, []runRecord{run})
				}
			}
		}
		if len(results) == len(ids) {
			ordered := make([]runRecord, 0, len(ids))
			for _, id := range ids {
				ordered = append(ordered, results[id])
			}
			return c.renderWait(format, ordered)
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return &ExitError{Code: ExitTimeout, Err: fmt.Errorf("timed out waiting for runs")}
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (c CLI) renderWait(format string, runs []runRecord) error {
	value := map[string]any{"schema_version": 1, "runs": runs}
	if err := c.renderValue(format, "result", value); err != nil {
		return err
	}
	code := 0
	for _, run := range runs {
		if run.Status == "cancelled" {
			code = ExitCancelled
		} else if run.Status != "completed" && code == 0 {
			code = ExitRunFailed
		}
	}
	if code != 0 {
		return &ExitError{Code: code, Err: fmt.Errorf("one or more runs did not complete successfully")}
	}
	return nil
}

func (c CLI) sessions(ctx context.Context, args []string) error {
	server, format, _, rest, err := parseSimpleOptions(args, c.server())
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return usageError("usage: threave sessions list|show|children|archive|restore|send")
	}
	switch rest[0] {
	case "list":
		if len(rest) != 1 {
			return usageError("sessions list takes no arguments")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/sessions?limit=100", nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, "sessions", value)
	case "show":
		if len(rest) != 2 {
			return usageError("sessions show requires one session ID")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/sessions/"+url.PathEscape(rest[1]), nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, "session", value)
	case "children":
		if len(rest) < 2 || len(rest) > 3 {
			return usageError("sessions children requires one session ID and optional --recursive")
		}
		recursive := len(rest) == 3 && rest[2] == "--recursive"
		if len(rest) == 3 && !recursive {
			return usageError("unknown sessions children option %q", rest[2])
		}
		var value any
		target := server + "/api/sessions/" + url.PathEscape(rest[1]) + "/children?recursive=" + strconv.FormatBool(recursive)
		if err := c.doJSON(ctx, http.MethodGet, target, nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, "children", value)
	case "archive", "restore":
		if len(rest) != 2 {
			return usageError("sessions %s requires one session ID", rest[0])
		}
		var value any
		target := server + "/api/sessions/" + url.PathEscape(rest[1]) + "/" + rest[0]
		if err := c.doJSON(ctx, http.MethodPost, target, nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, "session", value)
	case "send":
	default:
		return usageError("unknown sessions command %q", rest[0])
	}
	if len(rest) < 2 {
		return usageError("usage: threave sessions send <session-id> --prompt <text> [--queue|--steer]")
	}
	sessionID := rest[1]
	var prompt, promptFile, expected, requestID, model, thinking string
	queue, steer, detach := false, false, false
	var fast, plan optionalBool
	for i := 2; i < len(rest); i++ {
		switch rest[i] {
		case "--prompt", "--prompt-file", "--expected-run-id", "--request-id", "--model", "--thinking":
			if i+1 >= len(rest) {
				return usageError("%s requires a value", rest[i])
			}
			key, value := rest[i], rest[i+1]
			i++
			switch key {
			case "--prompt":
				prompt = value
			case "--prompt-file":
				promptFile = value
			case "--expected-run-id":
				expected = value
			case "--request-id":
				requestID = value
			case "--model":
				model = value
			case "--thinking":
				thinking = value
			}
		case "--queue":
			queue = true
		case "--steer":
			steer = true
		case "--detach":
			detach = true
		case "--fast", "--plan":
			if rest[i] == "--fast" {
				fast.set, fast.value = true, true
			} else {
				plan.set, plan.value = true, true
			}
		default:
			if strings.HasPrefix(rest[i], "--fast=") {
				value, parseErr := parseBool(strings.TrimPrefix(rest[i], "--fast="))
				if parseErr != nil {
					return usageError("%v", parseErr)
				}
				fast.set, fast.value = true, value
			} else if strings.HasPrefix(rest[i], "--plan=") {
				value, parseErr := parseBool(strings.TrimPrefix(rest[i], "--plan="))
				if parseErr != nil {
					return usageError("%v", parseErr)
				}
				plan.set, plan.value = true, value
			} else {
				return usageError("unknown sessions send option %q", rest[i])
			}
		}
	}
	if prompt != "" && promptFile != "" {
		return usageError("use only one of --prompt and --prompt-file")
	}
	if promptFile != "" {
		data, readErr := c.readInput(promptFile)
		if readErr != nil {
			return readErr
		}
		prompt = string(data)
	}
	if strings.TrimSpace(prompt) == "" {
		return usageError("--prompt or --prompt-file is required")
	}
	if queue && steer {
		return usageError("--queue and --steer are mutually exclusive")
	}
	if steer && expected == "" {
		return usageError("--steer requires --expected-run-id")
	}
	if requestID == "" {
		requestID = newRequestID()
	}
	body := map[string]any{"content": prompt, "queue": queue, "steer": steer, "client_submission_id": requestID, "reject_if_busy": !queue && !steer}
	if expected != "" {
		body["expected_run_id"] = expected
	}
	if model != "" || thinking != "" || fast.set || plan.set {
		var session struct {
			AgentType string `json:"agent_type"`
		}
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/sessions/"+url.PathEscape(sessionID), nil, &session); err != nil {
			return err
		}
		provider := map[string]any{}
		if model != "" {
			provider["model"] = model
		}
		switch session.AgentType {
		case "codex":
			if thinking != "" {
				provider["reasoning_effort"] = thinking
			}
			if fast.set {
				provider["fast_mode"] = fast.value
			}
			if plan.set {
				provider["planning_mode"] = plan.value
			}
		case "claude":
			if thinking != "" {
				provider["effort"] = thinking
			}
			if fast.set {
				return usageError("--fast is only supported by codex")
			}
			if plan.set {
				provider["planning_mode"] = plan.value
			}
		case "opencode":
			if thinking != "" {
				return usageError("--thinking is unsupported by opencode")
			}
			if fast.set {
				return usageError("--fast is only supported by codex")
			}
			if plan.set {
				provider["planning_mode"] = plan.value
			}
		case "pi":
			if thinking != "" {
				provider["thinking_level"] = thinking
			}
			if fast.set || plan.set {
				return usageError("--fast and --plan are unsupported by pi")
			}
		default:
			if thinking != "" || fast.set || plan.set {
				return usageError("provider-specific options are unavailable for %q", session.AgentType)
			}
		}
		body["agent_options"] = map[string]any{session.AgentType: provider}
	}
	var response struct {
		SessionID     string `json:"session_id"`
		RunID         string `json:"run_id"`
		Status        string `json:"status"`
		AcceptedAs    string `json:"accepted_as"`
		QueuedMessage any    `json:"queued_message,omitempty"`
	}
	if err := c.doJSON(ctx, http.MethodPost, server+"/api/sessions/"+url.PathEscape(sessionID)+"/messages", body, &response); err != nil {
		return err
	}
	if response.RunID != "" && !detach {
		if format != "json" {
			_ = c.renderValue(format, "accepted", runReceipt{SessionID: response.SessionID, RunID: response.RunID, Status: response.Status})
		}
		return c.watchRun(ctx, server, response.RunID, format, 0, false)
	}
	return c.renderValue(format, "accepted", response)
}

func (c CLI) requests(ctx context.Context, args []string) error {
	server, format, _, rest, err := parseSimpleOptions(args, c.server())
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return usageError("usage: threave requests list|answer|resolve <run-id> ...")
	}
	command, runID := rest[0], rest[1]
	switch command {
	case "list":
		if len(rest) != 2 {
			return usageError("requests list requires one run ID")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodGet, server+"/api/runs/"+url.PathEscape(runID)+"/requests", nil, &value); err != nil {
			return err
		}
		return c.renderValue(format, "requests", value)
	case "answer":
		if len(rest) < 4 || rest[2] == "" {
			return usageError("requests answer requires run ID, request ID, and --answers-json <path|->")
		}
		requestID := rest[2]
		path := ""
		for i := 3; i < len(rest); i++ {
			if rest[i] == "--answers-json" && i+1 < len(rest) {
				path = rest[i+1]
				i++
			} else {
				return usageError("unknown requests answer option %q", rest[i])
			}
		}
		if path == "" {
			return usageError("--answers-json is required")
		}
		raw, readErr := c.readInput(path)
		if readErr != nil {
			return readErr
		}
		var answers map[string]any
		if json.Unmarshal(raw, &answers) != nil {
			return usageError("answers JSON must be an object")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodPost, server+"/api/runs/"+url.PathEscape(runID)+"/requests/"+url.PathEscape(requestID)+"/answer", map[string]any{"answers": answers}, &value); err != nil {
			return err
		}
		return c.renderValue(format, "answered", value)
	case "resolve":
		if len(rest) != 5 || rest[3] != "--option" {
			return usageError("requests resolve requires run ID, request ID, and --option <offered-option-id>")
		}
		var value any
		if err := c.doJSON(ctx, http.MethodPost, server+"/api/runs/"+url.PathEscape(runID)+"/permissions/"+url.PathEscape(rest[2])+"/resolve", map[string]any{"option_id": rest[4]}, &value); err != nil {
			return err
		}
		return c.renderValue(format, "resolved", value)
	default:
		return usageError("unknown requests command %q", command)
	}
}

func (c CLI) readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(c.Stdin)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}
