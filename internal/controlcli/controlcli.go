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
	Command     string     `json:"command"`
	Description string     `json:"description"`
	Flags       []flagSpec `json:"flags,omitempty"`
}

type flagSpec struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Default     any    `json:"default,omitempty"`
	Description string `json:"description"`
}

var commandSpecs = []commandSpec{
	{Command: "commands --json", Description: "Print the machine-readable command catalog."},
	{Command: "help [command]", Description: "Show CLI help without contacting the service."},
	{Command: "agents list", Description: "List registered agent providers."},
	{Command: "agents options <provider>", Description: "Show models and modes reported by a provider."},
	{Command: "run", Description: "Create a session and start its first run; Stage 1 returns a detached receipt.", Flags: []flagSpec{
		{Name: "agent", Type: "string", Description: "agent provider (required)"},
		{Name: "model", Type: "string", Description: "provider model override"},
		{Name: "thinking", Type: "string", Description: "reasoning effort or thinking level"},
		{Name: "fast", Type: "boolean", Description: "Codex fast mode"},
		{Name: "plan", Type: "boolean", Description: "planning mode"},
		{Name: "cwd", Type: "path", Description: "server-side workspace path"},
		{Name: "prompt", Type: "string", Description: "task prompt"},
		{Name: "prompt-file", Type: "path|-", Description: "read task prompt from a file or stdin"},
		{Name: "request-id", Type: "string", Description: "idempotency key"},
		{Name: "detach", Type: "boolean", Default: true, Description: "return after durable acceptance"},
	}},
	{Command: "runs show <run-id>", Description: "Inspect an exact run."},
	{Command: "runs report <run-id>", Description: "Retrieve a terminal run report."},
	{Command: "serve", Description: "Run the Gorchestra service."},
	{Command: "host status", Description: "Show hosted-preview status."},
	{Command: "host validate", Description: "Validate a hosted-preview recipe."},
	{Command: "host check", Description: "Run hosted-preview health checks."},
	{Command: "host start", Description: "Start a hosted preview."},
	{Command: "host stop", Description: "Stop a hosted preview."},
	{Command: "host restart", Description: "Restart a hosted preview."},
	{Command: "host url", Description: "Print a hosted-preview URL."},
	{Command: "host logs", Description: "Read or follow hosted-preview logs."},
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
	case "run":
		return c.run(ctx, args[1:])
	case "runs":
		return c.runs(ctx, args[1:])
	default:
		return fmt.Errorf("unknown command %q; run 'gorchestra commands --json' to discover commands", args[0])
	}
}

func (c CLI) defaults() CLI {
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 30 * time.Second}
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
		return errors.New("usage: gorchestra commands --json")
	}
	return writeJSON(c.Stdout, map[string]any{"schema_version": 1, "commands": commandSpecs})
}

func (c CLI) help(args []string) error {
	if len(args) > 0 && (args[0] == "help" || args[0] == "-h" || args[0] == "--help") {
		args = args[1:]
	}
	if len(args) == 0 {
		_, err := fmt.Fprintln(c.Stdout, `Usage: gorchestra <command>

Agent control commands:
  commands --json                machine-readable command catalog
  agents list                    list registered providers
  agents options <provider>      list models and modes
  run [flags]                    start a detached run
  runs show <run-id>             inspect a run
  runs report <run-id>           retrieve a terminal report

Server and preview commands:
  serve [flags]                  run the Gorchestra service
  host <command>                 manage a hosted preview

Run "gorchestra help run" or "gorchestra commands --json" for details.`)
		return err
	}
	for _, spec := range commandSpecs {
		if strings.HasPrefix(spec.Command, strings.Join(args, " ")) {
			_, err := fmt.Fprintf(c.Stdout, "%s\n\n%s\n", spec.Command, spec.Description)
			return err
		}
	}
	return fmt.Errorf("unknown help topic %q", strings.Join(args, " "))
}

func (c CLI) agents(ctx context.Context, args []string) error {
	server, args, err := parseCommonServer(args, c.server())
	if err != nil {
		return err
	}
	args = removeJSONFlag(args)
	if len(args) == 1 && args[0] == "list" {
		return c.getJSON(ctx, server+"/api/agents")
	}
	if len(args) == 2 && args[0] == "options" {
		return c.getJSON(ctx, server+"/api/agents/"+url.PathEscape(args[1])+"/options")
	}
	return errors.New("usage: gorchestra agents list | gorchestra agents options <provider>")
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

func (c CLI) run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("gorchestra run", flag.ContinueOnError)
	flags.SetOutput(c.Stderr)
	var server, agent, model, thinking, cwd, prompt, promptFile, title, requestID, permissionPolicy, format string
	var detach bool
	var jsonOutput bool
	var fast, plan optionalBool
	flags.StringVar(&server, "server", c.server(), "Gorchestra API base URL")
	flags.StringVar(&agent, "agent", "", "agent provider")
	flags.StringVar(&model, "model", "", "model override")
	flags.StringVar(&thinking, "thinking", "", "reasoning effort or thinking level")
	flags.Var(&fast, "fast", "Codex fast mode")
	flags.Var(&plan, "plan", "planning mode")
	flags.StringVar(&cwd, "cwd", "", "server-side workspace path")
	flags.StringVar(&prompt, "prompt", "", "task prompt")
	flags.StringVar(&promptFile, "prompt-file", "", "read task prompt from file or -")
	flags.StringVar(&title, "title", "", "session title")
	flags.StringVar(&requestID, "request-id", "", "idempotency key")
	flags.StringVar(&permissionPolicy, "permission-policy", "", "ask, deny, or bypass")
	flags.StringVar(&format, "format", "json", "output format (json)")
	flags.BoolVar(&jsonOutput, "json", false, "shorthand for --format json")
	flags.BoolVar(&detach, "detach", true, "return after durable acceptance")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	if jsonOutput {
		format = "json"
	}
	if format != "json" {
		return errors.New("Stage 1 supports only --format json")
	}
	if !detach {
		return errors.New("foreground streaming is introduced in Stage 2; use --detach")
	}
	agent = strings.TrimSpace(agent)
	if agent == "" {
		return errors.New("--agent is required")
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
	if cwd == "" {
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
		"workspace_path": cwd, "prompt": prompt,
	}
	if len(providerOptions) > 0 {
		request["agent_options"] = map[string]any{agent: providerOptions}
	}
	return c.requestJSON(ctx, http.MethodPost, strings.TrimRight(server, "/")+"/api/runs", request)
}

func (c CLI) runs(ctx context.Context, args []string) error {
	server, args, err := parseCommonServer(args, c.server())
	if err != nil {
		return err
	}
	args = removeJSONFlag(args)
	if len(args) != 2 || (args[0] != "show" && args[0] != "report") {
		return errors.New("usage: gorchestra runs show <run-id> | gorchestra runs report <run-id>")
	}
	path := "/api/runs/" + url.PathEscape(args[1])
	if args[0] == "report" {
		path += "/report"
	}
	return c.getJSON(ctx, server+path)
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
		return fmt.Errorf("Gorchestra service %s: %w", target, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var value struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &value)
		if value.Error == "" {
			value.Error = strings.TrimSpace(string(raw))
		}
		return fmt.Errorf("Gorchestra service returned %s: %s", response.Status, value.Error)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("decode Gorchestra response: %w", err)
	}
	return writeJSON(c.Stdout, value)
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
