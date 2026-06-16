package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
)

const (
	Type                  = "claude"
	defaultBinary         = "claude"
	defaultInterruptGrace = 2 * time.Second
)

type VersionChecker func(ctx context.Context, binary string) (string, error)

type Option func(*Agent)

type Agent struct {
	binary         string
	model          string
	workspace      string
	interruptGrace time.Duration
	versionChecker VersionChecker

	availabilityMu  sync.Mutex
	availabilitySet bool
	availabilityErr error
	version         string
}

func New(options ...Option) *Agent {
	agent := &Agent{
		binary:         defaultBinary,
		interruptGrace: defaultInterruptGrace,
		versionChecker: defaultVersionChecker,
	}
	for _, option := range options {
		option(agent)
	}
	return agent
}

func WithBinary(binary string) Option {
	return func(agent *Agent) {
		if strings.TrimSpace(binary) != "" {
			agent.binary = strings.TrimSpace(binary)
		}
	}
}

func WithModel(model string) Option {
	return func(agent *Agent) {
		agent.model = strings.TrimSpace(model)
	}
}

func WithWorkspace(workspace string) Option {
	return func(agent *Agent) {
		agent.workspace = strings.TrimSpace(workspace)
	}
}

func WithInterruptGrace(grace time.Duration) Option {
	return func(agent *Agent) {
		if grace > 0 {
			agent.interruptGrace = grace
		}
	}
}

func WithVersionChecker(checker VersionChecker) Option {
	return func(agent *Agent) {
		if checker != nil {
			agent.versionChecker = checker
		}
	}
}

func (a *Agent) Type() string {
	return Type
}

func (a *Agent) Available() error {
	a.availabilityMu.Lock()
	availabilitySet := a.availabilitySet
	availabilityErr := a.availabilityErr
	a.availabilityMu.Unlock()
	if availabilitySet {
		return availabilityErr
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := a.CheckAvailability(ctx)
	return err
}

func (a *Agent) CheckAvailability(ctx context.Context) (string, error) {
	version, err := a.versionChecker(ctx, a.binary)
	if err != nil {
		err = fmt.Errorf("%w: claude binary %q: %v", agents.ErrUnavailable, a.binary, err)
	}

	a.availabilityMu.Lock()
	defer a.availabilityMu.Unlock()
	a.availabilitySet = true
	a.version = version
	a.availabilityErr = err
	return version, err
}

func defaultVersionChecker(ctx context.Context, binary string) (string, error) {
	output, err := exec.CommandContext(ctx, binary, "--version").CombinedOutput()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func (a *Agent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := a.Available(); err != nil {
		return err
	}
	if input.Action != "" && input.Action != agents.AgentActionMessage {
		return fmt.Errorf("unsupported claude agent action %q", input.Action)
	}
	if len(input.Attachments) > 0 {
		return fmt.Errorf("claude attachments are not supported")
	}

	workdir, err := a.workdirForRun(input.Workdir)
	if err != nil {
		return err
	}

	options := runOptionsFromMetadata(input.Metadata)
	cmd := a.commandWithOptions(input.Message, strings.TrimSpace(input.ProviderSessionID), workdir, options)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("create claude stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("create claude stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start claude: %w", err)
	}

	run := &streamRun{
		agent:      a,
		incoming:   readStream(stdout, stderr),
		process:    waitProcess(cmd),
		emit:       emit,
		normalizer: newNormalizer(),
	}
	return run.execute(ctx)
}

func (a *Agent) workdirForRun(inputWorkdir string) (string, error) {
	workdir := strings.TrimSpace(inputWorkdir)
	if workdir == "" {
		workdir = a.workspace
	}
	if workdir == "" {
		var err error
		workdir, err = filepath.Abs(".")
		if err != nil {
			return "", fmt.Errorf("resolve current workspace: %w", err)
		}
	}
	if !filepath.IsAbs(workdir) {
		abs, err := filepath.Abs(workdir)
		if err != nil {
			return "", fmt.Errorf("resolve workspace %q: %w", workdir, err)
		}
		workdir = abs
	}
	return workdir, nil
}

func (a *Agent) command(message string, providerSessionID string, workdir string) *exec.Cmd {
	return a.commandWithOptions(message, providerSessionID, workdir, claudeRunOptions{})
}

func (a *Agent) commandWithOptions(message string, providerSessionID string, workdir string, options claudeRunOptions) *exec.Cmd {
	args := []string{"--output-format", "stream-json", "--verbose", "--include-partial-messages"}
	model := a.model
	if options.Model != "" {
		model = options.Model
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	if options.Effort != "" {
		args = append(args, "--effort", options.Effort)
	}
	if options.PermissionMode != "" {
		args = append(args, "--permission-mode", options.PermissionMode)
	}
	if options.RunDangerously {
		args = append(args, "--allow-dangerously-skip-permissions")
	}
	if providerSessionID != "" {
		args = append(args, "--resume", providerSessionID)
	}
	args = append(args, "-p", message)
	cmd := exec.Command(a.binary, args...)
	cmd.Dir = workdir
	return cmd
}

type claudeRunOptions struct {
	RunDangerously bool
	Model          string
	Effort         string
	PermissionMode string
}

func runOptionsFromMetadata(metadata map[string]any) claudeRunOptions {
	rawOptions, ok := metadata["claude_options"].(map[string]any)
	if !ok {
		return claudeRunOptions{}
	}
	return claudeRunOptions{
		RunDangerously: boolMetadataValue(rawOptions, "run_dangerously"),
		Model:          stringMetadataValue(rawOptions, "model"),
		Effort:         stringMetadataValue(rawOptions, "effort"),
		PermissionMode: stringMetadataValue(rawOptions, "permission_mode"),
	}
}

func stringMetadataValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func boolMetadataValue(values map[string]any, key string) bool {
	value, _ := values[key].(bool)
	return value
}

type streamRun struct {
	agent      *Agent
	incoming   <-chan incomingMessage
	process    *processState
	emit       agents.EmitFunc
	normalizer *normalizer
}

func (r *streamRun) execute(ctx context.Context) error {
	defer r.stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.process.done:
			if r.normalizer.terminal {
				return r.terminalReturn()
			}
			return r.processExitBeforeTerminal()
		case incoming, ok := <-r.incoming:
			if !ok {
				if r.normalizer.terminal {
					return r.terminalReturn()
				}
				if r.process.isDone() {
					return r.processExitBeforeTerminal()
				}
				if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
					return r.processExitBeforeTerminal()
				}
				return fmt.Errorf("claude stream output closed before terminal event")
			}
			if err := r.handleIncoming(ctx, incoming); err != nil {
				return err
			}
			if r.normalizer.terminal {
				return r.terminalReturn()
			}
		}
	}
}

func (r *streamRun) handleIncoming(ctx context.Context, incoming incomingMessage) error {
	if incoming.ParseErr != nil {
		payload := map[string]any{
			"provider": "claude",
			"error":    incoming.ParseErr.Err.Error(),
			"line":     incoming.ParseErr.Line,
			"raw":      incoming.ParseErr.Raw,
		}
		return r.emit(ctx, agentEvent("provider.claude.parse_error", "system", "failed", payload))
	}
	if incoming.ReadErr != nil {
		return incoming.ReadErr
	}
	if incoming.Stderr != "" {
		payload := map[string]any{
			"provider": "claude",
			"text":     incoming.Stderr,
		}
		return r.emit(ctx, agentEvent("agent.log.delta", "system", "delta", payload))
	}
	if incoming.Event == nil {
		return nil
	}
	for _, normalized := range r.normalizer.normalize(incoming.Event) {
		if err := r.emit(ctx, normalized.Event); err != nil {
			return err
		}
	}
	return nil
}

func (r *streamRun) terminalReturn() error {
	switch r.normalizer.terminalKind {
	case terminalCompleted:
		return nil
	case terminalFailed:
		if r.normalizer.terminalError != "" {
			return fmt.Errorf("%s", r.normalizer.terminalError)
		}
		return fmt.Errorf("claude run failed")
	default:
		return nil
	}
}

func (r *streamRun) processExitBeforeTerminal() error {
	if err := r.process.err(); err != nil {
		return fmt.Errorf("claude exited before terminal event: %w", err)
	}
	return fmt.Errorf("claude exited before terminal event")
}

func (r *streamRun) stop() {
	if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
		return
	}
	r.process.kill()
	_, _ = r.process.waitTimeout(r.agent.interruptGrace)
}

type incomingMessage struct {
	Event    *streamEvent
	Stderr   string
	ParseErr *ParseError
	ReadErr  error
}

type ParseError struct {
	Line int
	Raw  string
	Err  error
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse claude stream JSON line %d: %v", e.Line, e.Err)
}

func readStream(stdout io.Reader, stderr io.Reader) <-chan incomingMessage {
	incoming := make(chan incomingMessage, 128)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanStream(stdout, incoming)
	}()
	go func() {
		defer wg.Done()
		scanStderr(stderr, incoming)
	}()
	go func() {
		wg.Wait()
		close(incoming)
	}()
	return incoming
}

func scanStream(reader io.Reader, incoming chan<- incomingMessage) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		event, err := parseStreamEvent([]byte(raw))
		if err != nil {
			incoming <- incomingMessage{ParseErr: &ParseError{Line: line, Raw: raw, Err: err}}
			continue
		}
		incoming <- incomingMessage{Event: event}
	}
	if err := scanner.Err(); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			incoming <- incomingMessage{ReadErr: fmt.Errorf("read claude stdout: %w", err)}
		}
	}
}

func scanStderr(reader io.Reader, incoming chan<- incomingMessage) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		incoming <- incomingMessage{Stderr: line}
	}
	if err := scanner.Err(); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			incoming <- incomingMessage{ReadErr: fmt.Errorf("read claude stderr: %w", err)}
		}
	}
}

func parseStreamEvent(raw []byte) (*streamEvent, error) {
	var event streamEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, err
	}
	event.Raw = append([]byte(nil), raw...)
	return &event, nil
}

type streamEvent struct {
	Type              string          `json:"type"`
	Subtype           string          `json:"subtype,omitempty"`
	Status            string          `json:"status,omitempty"`
	SessionID         string          `json:"session_id,omitempty"`
	ParentToolUseID   string          `json:"parent_tool_use_id,omitempty"`
	UUID              string          `json:"uuid,omitempty"`
	CWD               string          `json:"cwd,omitempty"`
	Tools             []string        `json:"tools,omitempty"`
	MCPServers        json.RawMessage `json:"mcp_servers,omitempty"`
	Model             string          `json:"model,omitempty"`
	Message           json.RawMessage `json:"message,omitempty"`
	Event             json.RawMessage `json:"event,omitempty"`
	Result            string          `json:"result,omitempty"`
	IsError           bool            `json:"is_error,omitempty"`
	StopReason        string          `json:"stop_reason,omitempty"`
	DurationMS        float64         `json:"duration_ms,omitempty"`
	DurationAPIMS     float64         `json:"duration_api_ms,omitempty"`
	TotalCostUSD      float64         `json:"total_cost_usd,omitempty"`
	Usage             json.RawMessage `json:"usage,omitempty"`
	ModelUsage        json.RawMessage `json:"modelUsage,omitempty"`
	RateLimitInfo     json.RawMessage `json:"rate_limit_info,omitempty"`
	PermissionDenials json.RawMessage `json:"permission_denials,omitempty"`
	Raw               json.RawMessage `json:"-"`
}

type processState struct {
	cmd  *exec.Cmd
	done chan struct{}

	mu      sync.Mutex
	waitErr error
}

func waitProcess(cmd *exec.Cmd) *processState {
	state := &processState{
		cmd:  cmd,
		done: make(chan struct{}),
	}
	go func() {
		err := cmd.Wait()
		state.mu.Lock()
		state.waitErr = err
		state.mu.Unlock()
		close(state.done)
	}()
	return state
}

func (p *processState) waitTimeout(timeout time.Duration) (error, bool) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.done:
		return p.err(), true
	case <-timer.C:
		return nil, false
	}
}

func (p *processState) isDone() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *processState) err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}

func (p *processState) kill() {
	if p.cmd.Process == nil || p.isDone() {
		return
	}
	_ = p.cmd.Process.Kill()
}
