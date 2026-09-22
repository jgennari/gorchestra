package controlcli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultServer = "http://127.0.0.1:8080"

type CLI struct {
	Client *http.Client
	Stdout io.Writer
	Stderr io.Writer
	Stdin  io.Reader
	Getenv func(string) string
	Getwd  func() (string, error)
}

type commandSpec struct {
	Command         string     `json:"command"`
	Description     string     `json:"description"`
	RequiresService bool       `json:"requires_service,omitempty"`
	Output          string     `json:"output,omitempty"`
	Examples        []string   `json:"examples,omitempty"`
	Flags           []flagSpec `json:"flags,omitempty"`
}

type flagSpec struct {
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	Default       any      `json:"default,omitempty"`
	Required      bool     `json:"required,omitempty"`
	Enum          []string `json:"enum,omitempty"`
	ConflictsWith []string `json:"conflicts_with,omitempty"`
	Requires      []string `json:"requires,omitempty"`
	Description   string   `json:"description"`
}

var commandSpecs = []commandSpec{
	{Command: "commands --json", Description: "Print this machine-readable command catalog without contacting the service.", Output: "command catalog JSON"},
	{Command: "help [command]", Description: "Show human-readable CLI help without contacting the service.", Output: "text"},
	{Command: "agents list", Description: "List registered agent providers.", RequiresService: true, Output: "provider catalog JSON"},
	{Command: "agents options <provider>", Description: "Show models and modes reported by a provider.", RequiresService: true, Output: "provider option catalog JSON"},
	{Command: "search <query>", Description: "Search sessions, durable history, and optionally the current session workspace.", RequiresService: true, Output: "merged search response, readable result rows, or an NDJSON source stream", Examples: []string{
		`gorchestra search "dependency audit" --json`,
		`gorchestra search "insurance" --session current --format ndjson`,
		`gorchestra search "release" --session none --json`,
	}, Flags: []flagSpec{
		{Name: "session", Type: "session-id|current|none", Description: "workspace to search; defaults to GORCHESTRA_SESSION_ID inside a managed run"},
		{Name: "timeout", Type: "duration", Description: "maximum search time"},
	}},
	{Command: "run", Description: "Create a session and start its first run; stream until terminal unless detached.", RequiresService: true, Output: "text activity, one JSON result, or an NDJSON accepted/event/result stream", Examples: []string{
		`gorchestra run --agent codex --prompt-file task.md --format ndjson`,
		`gorchestra run --title "Read-only audit" --prompt-file task.md --detach --json`,
	}, Flags: []flagSpec{
		{Name: "agent", Type: "string", Description: "agent provider; required for a root run and inherited by child runs"},
		{Name: "model", Type: "string", Description: "provider model override"},
		{Name: "thinking", Type: "string", Description: "reasoning effort or thinking level"},
		{Name: "fast", Type: "boolean", Description: "Codex fast mode"},
		{Name: "plan", Type: "boolean", Description: "planning mode"},
		{Name: "cwd", Type: "path", Description: "server-side workspace path"},
		{Name: "parent", Type: "session-id|current|none", Description: "child parent; defaults to current inside a run"},
		{Name: "title", Type: "string", Description: "session title"},
		{Name: "prompt", Type: "string", ConflictsWith: []string{"prompt-file"}, Description: "task prompt; one prompt source is required"},
		{Name: "prompt-file", Type: "path|-", ConflictsWith: []string{"prompt"}, Description: "read the required task prompt from a file or stdin"},
		{Name: "request-id", Type: "string", Description: "idempotency key"},
		{Name: "permission-policy", Type: "string", Enum: []string{"ask", "deny", "bypass"}, Description: "provider permission policy where supported"},
		{Name: "detach", Type: "boolean", Default: false, Description: "return after durable acceptance"},
		{Name: "format", Type: "string", Default: "text", Enum: []string{"text", "json", "ndjson"}, Description: "output format"},
		{Name: "json", Type: "boolean", Default: false, Description: "shorthand for --format json"},
		{Name: "timeout", Type: "duration", Description: "maximum foreground observation time"},
		{Name: "until-attention", Type: "boolean", Description: "return with code 6 when input is required"},
	}},
	{Command: "runs show <run-id>", Description: "Inspect an exact run.", RequiresService: true, Output: "run JSON by default"},
	{Command: "runs watch <run-id>", Description: "Replay and follow an exact run until terminal.", RequiresService: true, Output: "text activity, one JSON result, or NDJSON events and result", Examples: []string{`gorchestra runs watch RUN_ID --format ndjson`}, Flags: []flagSpec{
		{Name: "after-seq", Type: "integer", Default: 0, Description: "resume after a durable event sequence"},
		{Name: "format", Type: "string", Default: "json", Enum: []string{"text", "json", "ndjson"}, Description: "output format"},
		{Name: "timeout", Type: "duration", Description: "maximum observation time"},
		{Name: "until-attention", Type: "boolean", Description: "return with code 6 when input is required"},
	}},
	{Command: "runs wait <run-id>...", Description: "Wait quietly for one or more exact runs.", RequiresService: true, Output: "terminal run array", Flags: []flagSpec{
		{Name: "any", Type: "boolean", ConflictsWith: []string{"all"}, Description: "return when the first run becomes terminal"},
		{Name: "all", Type: "boolean", Default: true, ConflictsWith: []string{"any"}, Description: "return after every run is terminal"},
		{Name: "timeout", Type: "duration", Description: "maximum wait time"},
	}},
	{Command: "runs report <run-id>", Description: "Retrieve a terminal run report.", RequiresService: true, Output: "durable terminal report JSON"},
	{Command: "runs cancel <run-id>", Description: "Cancel only the specified active run.", RequiresService: true, Output: "cancel response", Flags: []flagSpec{
		{Name: "reason", Type: "string", Description: "human-readable cancellation reason"},
	}},
	{Command: "sessions send <session-id>", Description: "Send, queue, or steer a follow-up message.", RequiresService: true, Output: "accepted run or queued-message receipt", Flags: []flagSpec{
		{Name: "prompt", Type: "string", ConflictsWith: []string{"prompt-file"}, Description: "follow-up prompt; one prompt source is required"},
		{Name: "prompt-file", Type: "path|-", ConflictsWith: []string{"prompt"}, Description: "read the required prompt from a file or stdin"},
		{Name: "queue", Type: "boolean", ConflictsWith: []string{"steer"}, Description: "queue behind the active run"},
		{Name: "steer", Type: "boolean", ConflictsWith: []string{"queue"}, Requires: []string{"expected-run-id"}, Description: "steer the exact active run"},
		{Name: "expected-run-id", Type: "string", Description: "required exact run ID for steering"},
		{Name: "request-id", Type: "string", Description: "idempotency key"},
		{Name: "model", Type: "string", Description: "model override for the follow-up run"},
		{Name: "thinking", Type: "string", Description: "reasoning effort or thinking level"},
		{Name: "fast", Type: "boolean", Description: "Codex fast mode"},
		{Name: "plan", Type: "boolean", Description: "planning mode"},
		{Name: "detach", Type: "boolean", Description: "return after acceptance"},
	}},
	{Command: "sessions list", Description: "List sessions with lineage metadata.", RequiresService: true, Output: "session list JSON"},
	{Command: "sessions show <session-id>", Description: "Inspect a session and its parent linkage.", RequiresService: true, Output: "session JSON"},
	{Command: "sessions children <session-id>", Description: "List direct children or all descendants.", RequiresService: true, Output: "session lineage JSON", Flags: []flagSpec{
		{Name: "recursive", Type: "boolean", Description: "include all descendants"},
	}},
	{Command: "sessions archive <session-id>", Description: "Archive an idle session without deleting its lineage.", RequiresService: true, Output: "updated session JSON"},
	{Command: "sessions restore <session-id>", Description: "Restore an archived session to the active session list.", RequiresService: true, Output: "updated session JSON"},
	{Command: "requests list <run-id>", Description: "List unresolved questions and permissions for a run.", RequiresService: true, Output: "request list JSON"},
	{Command: "requests answer <run-id> <request-id>", Description: "Answer an input request using a JSON object.", RequiresService: true, Output: "answer acknowledgement", Flags: []flagSpec{
		{Name: "answers-json", Type: "path|-", Required: true, Description: "read the answer object from a file or stdin"},
	}},
	{Command: "requests resolve <run-id> <request-id>", Description: "Resolve a permission request with an offered option.", RequiresService: true, Output: "permission acknowledgement", Flags: []flagSpec{
		{Name: "option", Type: "string", Required: true, Description: "offered option ID"},
	}},
	{Command: "serve", Description: "Run the Gorchestra service. Bare gorchestra prints help; use this explicit command for maintained launch configurations.", Examples: []string{`gorchestra serve --open`, `gorchestra serve --config ~/.config/gorchestra/gorchestra.env`}, Flags: serveFlagSpecs},
	{Command: "host status", Description: "Show hosted-preview status.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host validate", Description: "Validate a hosted-preview recipe.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host check", Description: "Run hosted-preview health checks.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host start", Description: "Start a hosted preview.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host stop", Description: "Stop a hosted preview.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host restart", Description: "Restart a hosted preview.", RequiresService: true, Output: "preview status JSON", Flags: hostCommonFlagSpecs},
	{Command: "host url", Description: "Print a hosted-preview URL.", RequiresService: true, Output: "URL text", Flags: hostCommonFlagSpecs},
	{Command: "host logs", Description: "Read or follow hosted-preview logs.", RequiresService: true, Output: "prefixed log text", Flags: append(append([]flagSpec(nil), hostCommonFlagSpecs...),
		flagSpec{Name: "service", Type: "string", Description: "filter by service"},
		flagSpec{Name: "follow", Type: "boolean", Default: false, Description: "follow new log output"},
		flagSpec{Name: "after-seq", Type: "integer", Default: 0, Description: "return logs after this sequence"},
		flagSpec{Name: "limit", Type: "integer", Default: 1000, Description: "maximum retained chunks"},
	)},
}

var clientCommonFlagSpecs = []flagSpec{
	{Name: "server", Type: "url", Default: defaultServer, Description: "API base URL; GORCHESTRA_API_URL supplies the default"},
	{Name: "format", Type: "string", Default: "json", Enum: []string{"text", "json", "ndjson"}, Description: "output format where supported"},
	{Name: "json", Type: "boolean", Description: "shorthand for --format json where supported"},
}

var hostCommonFlagSpecs = []flagSpec{
	{Name: "server", Type: "url", Default: defaultServer, Description: "API base URL; GORCHESTRA_API_URL supplies the default"},
	{Name: "session", Type: "session-id", Description: "session ID; GORCHESTRA_SESSION_ID supplies the default"},
	{Name: "timeout", Type: "duration", Default: "1m", Description: "command timeout"},
	{Name: "wait", Type: "boolean", Default: true, Description: "wait for the requested state"},
}

var serveFlagSpecs = []flagSpec{
	{Name: "config", Type: "path", Description: "env-style configuration file"},
	{Name: "host", Type: "string", Default: "127.0.0.1", Description: "HTTP listen interface"},
	{Name: "port", Type: "string", Default: "8080", Description: "HTTP listen port"},
	{Name: "data-dir", Type: "path", Description: "runtime data directory"},
	{Name: "db", Type: "path", Description: "exact SQLite path; overrides --data-dir"},
	{Name: "workspace", Type: "path", Description: "default workspace for agent runs"},
	{Name: "workspace-root", Type: "path", Description: "allowed workspace root; repeatable"},
	{Name: "codex-bin", Type: "path", Default: "codex", Description: "Codex CLI binary"},
	{Name: "codex-model", Type: "string", Description: "default Codex model"},
	{Name: "codex-sandbox", Type: "string", Default: "workspace-write", Description: "Codex sandbox mode"},
	{Name: "codex-network-access", Type: "boolean", Default: true, Description: "allow network access for Codex shell commands"},
	{Name: "codex-web-search", Type: "string", Default: "live", Enum: []string{"disabled", "cached", "live"}, Description: "Codex web search mode"},
	{Name: "claude-bin", Type: "path", Default: "claude", Description: "Claude CLI binary"},
	{Name: "claude-model", Type: "string", Description: "default Claude model"},
	{Name: "opencode-bin", Type: "path", Default: "opencode", Description: "OpenCode CLI binary"},
	{Name: "pi-bin", Type: "path", Default: "pi", Description: "Pi CLI binary"},
	{Name: "push-subject", Type: "string", Description: "VAPID subject for Web Push"},
	{Name: "preview-url-template", Type: "string", Description: "hosted-preview URL containing {slug}"},
	{Name: "debug-retention", Type: "duration", Default: "168h", Description: "raw debug-event retention; 0 disables expiry"},
	{Name: "open", Type: "boolean", Default: false, Description: "open the app after startup"},
	{Name: "max-lineage-depth", Type: "integer", Default: 6, Description: "maximum delegated-session nesting depth"},
	{Name: "max-active-children", Type: "integer", Default: 8, Description: "maximum active child runs per session"},
	{Name: "version", Type: "boolean", Default: false, Description: "print the version and exit"},
}

func (c CLI) Run(ctx context.Context, args []string) error {
	c = c.defaults()
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		return c.help(args)
	}
	switch args[0] {
	case "commands":
		return c.commands(args[1:])
	case "agents":
		return c.agents(ctx, args[1:])
	case "search":
		return c.search(ctx, args[1:])
	case "run":
		return c.run(ctx, args[1:])
	case "runs":
		return c.runs(ctx, args[1:])
	case "sessions":
		return c.sessions(ctx, args[1:])
	case "requests":
		return c.requests(ctx, args[1:])
	default:
		return usageError("unknown command %q; run 'gorchestra commands --json' to discover commands", args[0])
	}
}

func (c CLI) defaults() CLI {
	if c.Client == nil {
		c.Client = &http.Client{}
	}
	if c.Stdout == nil {
		c.Stdout = os.Stdout
	}
	if c.Stderr == nil {
		c.Stderr = os.Stderr
	}
	if c.Stdin == nil {
		c.Stdin = os.Stdin
	}
	if c.Getenv == nil {
		c.Getenv = os.Getenv
	}
	if c.Getwd == nil {
		c.Getwd = os.Getwd
	}
	return c
}

func (c CLI) commands(args []string) error {
	if len(args) != 1 || args[0] != "--json" {
		return usageError("usage: gorchestra commands --json")
	}
	return writeJSON(c.Stdout, map[string]any{
		"schema_version":      1,
		"usage":               "gorchestra <command> [flags]",
		"service_start":       "gorchestra serve [flags]",
		"offline_discovery":   true,
		"commands":            commandSpecs,
		"client_common_flags": clientCommonFlagSpecs,
		"output_formats":      []string{"text", "json", "ndjson"},
		"environment": []map[string]string{
			{"name": "GORCHESTRA_API_URL", "purpose": "default API base URL for client commands"},
			{"name": "GORCHESTRA_BIN", "purpose": "absolute Gorchestra executable injected into managed agent runs"},
			{"name": "GORCHESTRA_SESSION_ID", "purpose": "current session; makes run default to a child and supplies host --session"},
			{"name": "GORCHESTRA_RUN_ID", "purpose": "current run; records which parent run spawned a child"},
		},
		"workflows": []map[string]any{
			{
				"name":        "delegate_and_fetch",
				"description": "Start a named child, retain exact IDs, wait for that run, then retrieve its durable report.",
				"steps": []string{
					`"$GORCHESTRA_BIN" run --title "TASK NAME" --prompt-file task.md --detach --json`,
					`"$GORCHESTRA_BIN" runs wait RUN_ID --timeout 10m --json`,
					`"$GORCHESTRA_BIN" runs report RUN_ID --json`,
				},
			},
			{
				"name":        "stream_child",
				"description": "Start a child and stream its accepted receipt, events, tool activity, and terminal result.",
				"steps":       []string{`"$GORCHESTRA_BIN" run --title "TASK NAME" --prompt-file task.md --format ndjson`},
			},
			{
				"name":        "handle_attention",
				"description": "Stop observation when the run needs input, inspect requests, answer the exact request, and resume watching.",
				"steps": []string{
					`"$GORCHESTRA_BIN" runs watch RUN_ID --until-attention --json`,
					`"$GORCHESTRA_BIN" requests list RUN_ID --json`,
					`"$GORCHESTRA_BIN" requests answer RUN_ID REQUEST_ID --answers-json answers.json --json`,
					`"$GORCHESTRA_BIN" runs watch RUN_ID --json`,
				},
			},
		},
		"exit_codes": map[string]int{
			"success": 0, "run_failed": ExitRunFailed, "usage": ExitUsage,
			"transport": ExitTransport, "timeout": ExitTimeout, "cancelled": ExitCancelled,
			"needs_input": ExitNeedsInput, "interrupted": ExitInterrupted,
		},
	})
}

func (c CLI) help(args []string) error {
	if len(args) > 0 && (args[0] == "help" || args[0] == "-h" || args[0] == "--help") {
		args = args[1:]
	}
	if len(args) == 0 {
		_, err := fmt.Fprintln(c.Stdout, `Gorchestra conducts durable agent sessions through a local service.

Usage: gorchestra <command>

Start the service explicitly:
  gorchestra serve --open

Agent delegation quick start:
  gorchestra agents list --json
  gorchestra run --agent codex --title "Dependency audit" \
    --prompt-file task.md --detach --json
  gorchestra runs wait RUN_ID --timeout 10m --json
  gorchestra runs report RUN_ID --json

Inside a Gorchestra-managed run, omit --agent, --parent, and --cwd to inherit
the current provider, attach the new session as a child, and share its workspace.

Agent control commands:
  commands --json                machine-readable command catalog
  agents list                    list registered providers
  agents options <provider>      list models and modes
  search <query>                 search sessions, history, and workspace files
  run [flags]                    start and stream a run
  runs show <run-id>             inspect a run
  runs watch <run-id>            replay and follow a run
  runs wait <run-id>...          wait for exact runs
  runs report <run-id>           retrieve a terminal report
  runs cancel <run-id>           cancel an exact run
  sessions list                  list sessions and lineage
  sessions show <session>        inspect a session
  sessions children <session>    list child sessions
  sessions archive <session>     archive an idle session
  sessions restore <session>     restore an archived session
  sessions send <session-id>     send, queue, or steer a follow-up
  requests <command>             inspect or answer agent requests

Server and preview commands:
  serve [flags]                  run the Gorchestra service
  host <command>                 manage a hosted preview

Bare "gorchestra" prints this help. This help and "commands --json" work offline.
Run "gorchestra help run" or "gorchestra commands --json" for details.`)
		return err
	}
	for _, spec := range commandSpecs {
		if strings.HasPrefix(spec.Command, strings.Join(args, " ")) {
			if _, err := fmt.Fprintf(c.Stdout, "Usage: gorchestra %s\n\n%s\n", spec.Command, spec.Description); err != nil {
				return err
			}
			if len(spec.Flags) > 0 {
				if _, err := fmt.Fprintln(c.Stdout, "\nFlags:"); err != nil {
					return err
				}
				for _, option := range spec.Flags {
					defaultText := ""
					if option.Default != nil {
						defaultText = fmt.Sprintf(" (default %v)", option.Default)
					}
					if _, err := fmt.Fprintf(c.Stdout, "  --%-18s %s%s\n", option.Name, option.Description, defaultText); err != nil {
						return err
					}
				}
			}
			if len(spec.Examples) > 0 {
				if _, err := fmt.Fprintln(c.Stdout, "\nExamples:"); err != nil {
					return err
				}
				for _, example := range spec.Examples {
					if _, err := fmt.Fprintf(c.Stdout, "  %s\n", example); err != nil {
						return err
					}
				}
			}
			return nil
		}
	}
	return usageError("unknown help topic %q", strings.Join(args, " "))
}

func (c CLI) agents(ctx context.Context, args []string) error {
	server, args, err := parseCommonServer(args, c.server())
	if err != nil {
		return usageError("%v", err)
	}
	args = removeJSONFlag(args)
	if len(args) == 1 && args[0] == "list" {
		return c.getJSON(ctx, server+"/api/agents")
	}
	if len(args) == 2 && args[0] == "options" {
		return c.getJSON(ctx, server+"/api/agents/"+url.PathEscape(args[1])+"/options")
	}
	return usageError("usage: gorchestra agents list | gorchestra agents options <provider>")
}

type optionalBool struct{ set, value bool }

func (b *optionalBool) String() string {
	if !b.set {
		return ""
	}
	return fmt.Sprint(b.value)
}
func (b *optionalBool) Set(value string) error {
	parsed, err := parseBool(value)
	if err != nil {
		return err
	}
	b.set, b.value = true, parsed
	return nil
}
func (b *optionalBool) IsBoolFlag() bool { return true }

func (c CLI) run(ctx context.Context, args []string) (resultErr error) {
	defer func() {
		if resultErr == nil {
			return
		}
		var exit *ExitError
		if !errors.As(resultErr, &exit) && !errors.Is(resultErr, context.Canceled) && !errors.Is(resultErr, context.DeadlineExceeded) {
			resultErr = usageError("%v", resultErr)
		}
	}()
	flags := flag.NewFlagSet("gorchestra run", flag.ContinueOnError)
	flags.SetOutput(c.Stderr)
	var server, agent, model, thinking, cwd, prompt, promptFile, title, requestID, permissionPolicy, format, parent string
	var detach bool
	var jsonOutput bool
	var timeout time.Duration
	var untilAttention bool
	var fast, plan optionalBool
	flags.StringVar(&server, "server", c.server(), "Gorchestra API base URL")
	flags.StringVar(&agent, "agent", "", "agent provider")
	flags.StringVar(&model, "model", "", "model override")
	flags.StringVar(&thinking, "thinking", "", "reasoning effort or thinking level")
	flags.Var(&fast, "fast", "Codex fast mode")
	flags.Var(&plan, "plan", "planning mode")
	flags.StringVar(&cwd, "cwd", "", "server-side workspace path")
	flags.StringVar(&parent, "parent", "", "parent session ID, current, or none")
	flags.StringVar(&prompt, "prompt", "", "task prompt")
	flags.StringVar(&promptFile, "prompt-file", "", "read task prompt from file or -")
	flags.StringVar(&title, "title", "", "session title")
	flags.StringVar(&requestID, "request-id", "", "idempotency key")
	flags.StringVar(&permissionPolicy, "permission-policy", "", "ask, deny, or bypass")
	flags.StringVar(&format, "format", "text", "output format (text, json, or ndjson)")
	flags.BoolVar(&jsonOutput, "json", false, "shorthand for --format json")
	flags.BoolVar(&detach, "detach", false, "return after durable acceptance")
	flags.DurationVar(&timeout, "timeout", 0, "stop observing after this duration")
	flags.BoolVar(&untilAttention, "until-attention", false, "return with exit code 6 when input is required")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	if timeout < 0 {
		return usageError("--timeout cannot be negative")
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	if jsonOutput {
		format = "json"
	}
	if !validFormat(format) {
		return usageError("--format must be text, json, or ndjson")
	}
	agent = strings.TrimSpace(agent)
	currentSessionID := strings.TrimSpace(c.Getenv("GORCHESTRA_SESSION_ID"))
	currentRunID := strings.TrimSpace(c.Getenv("GORCHESTRA_RUN_ID"))
	parent = strings.TrimSpace(parent)
	if parent == "" && currentSessionID != "" {
		parent = currentSessionID
	}
	if parent == "current" {
		if currentSessionID == "" {
			return errors.New("--parent current requires GORCHESTRA_SESSION_ID")
		}
		parent = currentSessionID
	}
	if parent == "none" {
		parent = ""
	}
	if agent == "" && parent != "" {
		var parentSession struct {
			AgentType string `json:"agent_type"`
		}
		if err := c.doJSON(ctx, http.MethodGet, strings.TrimRight(server, "/")+"/api/sessions/"+url.PathEscape(parent), nil, &parentSession); err != nil {
			return err
		}
		agent = parentSession.AgentType
	}
	if agent == "" {
		return errors.New("--agent is required for a root run")
	}
	if prompt != "" && promptFile != "" {
		return errors.New("use only one of --prompt and --prompt-file")
	}
	if promptFile != "" {
		var data []byte
		var err error
		if promptFile == "-" {
			data, err = io.ReadAll(c.Stdin)
		} else {
			data, err = os.ReadFile(promptFile)
		}
		if err != nil {
			return fmt.Errorf("read prompt: %w", err)
		}
		prompt = string(data)
	}
	if strings.TrimSpace(prompt) == "" {
		return errors.New("--prompt or --prompt-file is required")
	}
	if cwd == "" && parent == "" {
		parsed, err := url.Parse(server)
		if err != nil {
			return fmt.Errorf("invalid --server: %w", err)
		}
		if parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1" {
			return errors.New("--cwd is required when targeting a remote service")
		}
		cwd, err = c.Getwd()
		if err != nil {
			return fmt.Errorf("determine cwd: %w", err)
		}
		cwd, _ = filepath.Abs(cwd)
	}
	if requestID == "" {
		requestID = newRequestID()
	}
	providerOptions := map[string]any{}
	if model != "" {
		providerOptions["model"] = model
	}
	if permissionPolicy != "" {
		providerOptions["permission_policy"] = permissionPolicy
	}
	switch agent {
	case "codex":
		if thinking != "" {
			providerOptions["reasoning_effort"] = thinking
		}
		if fast.set {
			providerOptions["fast_mode"] = fast.value
		}
		if plan.set {
			providerOptions["planning_mode"] = plan.value
		}
	case "claude":
		if thinking != "" {
			providerOptions["effort"] = thinking
		}
		if plan.set {
			providerOptions["planning_mode"] = plan.value
		}
		if fast.set {
			return errors.New("--fast is only supported by codex")
		}
	case "opencode":
		if thinking != "" {
			return errors.New("--thinking is unsupported by opencode")
		}
		if plan.set {
			providerOptions["planning_mode"] = plan.value
		}
		if fast.set {
			return errors.New("--fast is only supported by codex")
		}
	case "pi":
		if thinking != "" {
			providerOptions["thinking_level"] = thinking
		}
		if plan.set || fast.set || permissionPolicy != "" {
			return errors.New("--plan, --fast, and --permission-policy are unsupported by pi")
		}
	default:
		if model != "" || thinking != "" || fast.set || plan.set || permissionPolicy != "" {
			return fmt.Errorf("provider-specific options are unavailable for %q", agent)
		}
	}
	request := map[string]any{
		"request_id": requestID, "title": title, "agent_type": agent,
		"prompt": prompt,
	}
	if cwd != "" {
		request["workspace_path"] = cwd
	}
	if parent != "" {
		request["parent_session_id"] = parent
		if parent == currentSessionID && currentRunID != "" {
			request["spawned_by_run_id"] = currentRunID
		}
	}
	if len(providerOptions) > 0 {
		request["agent_options"] = map[string]any{agent: providerOptions}
	}
	var receipt runReceipt
	if err := c.doJSON(ctx, http.MethodPost, strings.TrimRight(server, "/")+"/api/runs", request, &receipt); err != nil {
		return err
	}
	if detach {
		return c.renderValue(format, "accepted", receipt)
	}
	if format != "json" {
		if err := c.renderValue(format, "accepted", receipt); err != nil {
			return err
		}
	}
	return c.watchRun(ctx, server, receipt.RunID, format, 0, untilAttention)
}

func (c CLI) runs(ctx context.Context, args []string) error {
	return c.runCommands(ctx, args)
}

func parseCommonServer(args []string, fallback string) (string, []string, error) {
	server := strings.TrimRight(fallback, "/")
	remaining := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		if args[index] == "--server" {
			if index+1 >= len(args) {
				return "", nil, errors.New("--server requires a URL")
			}
			server = strings.TrimRight(args[index+1], "/")
			index++
			continue
		}
		if strings.HasPrefix(args[index], "--server=") {
			server = strings.TrimRight(strings.TrimPrefix(args[index], "--server="), "/")
			continue
		}
		remaining = append(remaining, args[index])
	}
	parsed, err := url.Parse(server)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", nil, fmt.Errorf("invalid --server URL %q", server)
	}
	return server, remaining, nil
}

func removeJSONFlag(args []string) []string {
	result := make([]string, 0, len(args))
	for _, arg := range args {
		if arg != "--json" {
			result = append(result, arg)
		}
	}
	return result
}

func (c CLI) server() string {
	if value := strings.TrimRight(strings.TrimSpace(c.Getenv("GORCHESTRA_API_URL")), "/"); value != "" {
		return value
	}
	return defaultServer
}

func (c CLI) getJSON(ctx context.Context, target string) error {
	return c.requestJSON(ctx, http.MethodGet, target, nil)
}

func (c CLI) requestJSON(ctx context.Context, method, target string, body any) error {
	var value any
	if err := c.doJSON(ctx, method, target, body, &value); err != nil {
		return err
	}
	return writeJSON(c.Stdout, value)
}

func (c CLI) doJSON(ctx context.Context, method, target string, body any, output any) error {
	var input io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		input = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, input)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return transportError("Gorchestra service %s: %v", target, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return transportError("read Gorchestra response: %v", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var value struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &value)
		if value.Error == "" {
			value.Error = strings.TrimSpace(string(raw))
		}
		return transportError("Gorchestra service returned %s: %s", response.Status, value.Error)
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return transportError("decode Gorchestra response: %v", err)
	}
	return nil
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("req_%d", time.Now().UnixNano())
	}
	return "req_" + hex.EncodeToString(value[:])
}

func parseBool(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean %q", value)
	}
}
