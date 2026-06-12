package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
)

const (
	Type                  = "codex"
	defaultBinary         = "codex"
	defaultSandbox        = "workspace-write"
	defaultApprovalPolicy = "never"
	defaultInterruptGrace = 2 * time.Second
)

type VersionChecker func(ctx context.Context, binary string) (string, error)

type Option func(*Agent)

type Agent struct {
	binary          string
	sandbox         string
	approvalPolicy  string
	model           string
	workspace       string
	interruptGrace  time.Duration
	versionChecker  VersionChecker
	availabilityMu  sync.Mutex
	availabilitySet bool
	availabilityErr error
	version         string
}

func New(options ...Option) *Agent {
	agent := &Agent{
		binary:         defaultBinary,
		sandbox:        defaultSandbox,
		approvalPolicy: defaultApprovalPolicy,
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

func WithSandbox(sandbox string) Option {
	return func(agent *Agent) {
		if strings.TrimSpace(sandbox) != "" {
			agent.sandbox = strings.TrimSpace(sandbox)
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

func (a *Agent) Version() string {
	a.availabilityMu.Lock()
	defer a.availabilityMu.Unlock()
	return a.version
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
		err = fmt.Errorf("%w: codex binary %q: %v", agents.ErrUnavailable, a.binary, err)
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

	workdir, err := a.workdirForRun(input.Workdir)
	if err != nil {
		return err
	}

	cmd := a.command(workdir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("create codex stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("create codex stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("create codex stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start codex app-server: %w", err)
	}

	run := &appServerRun{
		agent:      a,
		rpc:        newRPCClient(stdin),
		incoming:   readAppServer(stdout, stderr),
		process:    waitProcess(cmd),
		emit:       emit,
		normalizer: newNormalizer(),
	}
	return run.execute(ctx, input, workdir)
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

func (a *Agent) command(workdir string) *exec.Cmd {
	cmd := exec.Command(a.binary, "app-server", "--stdio")
	cmd.Dir = workdir
	return cmd
}

type appServerRun struct {
	agent      *Agent
	rpc        *rpcClient
	incoming   <-chan incomingMessage
	process    *processState
	emit       agents.EmitFunc
	normalizer *normalizer

	stateMu  sync.Mutex
	threadID string
	turnID   string
}

func (r *appServerRun) execute(ctx context.Context, input agents.AgentInput, workdir string) error {
	cancelWatchDone := r.watchCancellation(ctx)
	defer close(cancelWatchDone)
	defer r.stopServer()

	if err := r.initialize(ctx); err != nil {
		return err
	}
	if err := r.startThread(ctx, workdir); err != nil {
		return err
	}
	if err := r.startTurn(ctx, input.Message, workdir); err != nil {
		return err
	}
	return r.awaitTerminal(ctx)
}

func (r *appServerRun) initialize(ctx context.Context) error {
	id, err := r.rpc.sendRequest("initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "gorchestra",
			"title":   "Gorchestra",
			"version": "0.0.0",
		},
		"capabilities": map[string]any{
			"experimentalApi":    true,
			"requestAttestation": false,
		},
	})
	if err != nil {
		return err
	}

	response, err := r.awaitResponse(ctx, id)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("codex initialize failed: %s", response.Error.Message)
	}
	return r.rpc.sendNotification("initialized", nil)
}

func (r *appServerRun) startThread(ctx context.Context, workdir string) error {
	params := map[string]any{
		"cwd":                   workdir,
		"runtimeWorkspaceRoots": []string{workdir},
		"approvalPolicy":        r.agent.approvalPolicy,
		"sandbox":               r.agent.sandbox,
		"ephemeral":             true,
	}
	if r.agent.model != "" {
		params["model"] = r.agent.model
	}

	id, err := r.rpc.sendRequest("thread/start", params)
	if err != nil {
		return err
	}

	response, err := r.awaitResponse(ctx, id)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("codex thread/start failed: %s", response.Error.Message)
	}

	threadID := stringAt(response.Result, "thread", "id")
	if threadID == "" {
		return fmt.Errorf("codex thread/start response missing thread.id")
	}
	r.setThreadID(threadID)
	return r.emitSyntheticRunStarted(ctx, "thread/start", threadID)
}

func (r *appServerRun) startTurn(ctx context.Context, message string, workdir string) error {
	threadID := r.getThreadID()
	params := map[string]any{
		"threadId": threadID,
		"input": []map[string]any{
			{
				"type":          "text",
				"text":          message,
				"text_elements": []any{},
			},
		},
		"cwd":                   workdir,
		"runtimeWorkspaceRoots": []string{workdir},
		"approvalPolicy":        r.agent.approvalPolicy,
	}
	if r.agent.model != "" {
		params["model"] = r.agent.model
	}

	id, err := r.rpc.sendRequest("turn/start", params)
	if err != nil {
		return err
	}

	response, err := r.awaitResponse(ctx, id)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("codex turn/start failed: %s", response.Error.Message)
	}

	turnID := stringAt(response.Result, "turn", "id")
	if turnID == "" {
		return fmt.Errorf("codex turn/start response missing turn.id")
	}
	r.setTurnID(turnID)
	return r.emitSyntheticTurnStarted(ctx, "turn/start", threadID, turnID)
}

func (r *appServerRun) awaitResponse(ctx context.Context, requestID string) (*rpcMessage, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-r.process.done:
			return nil, r.processExitBeforeTerminal(ctx)
		case incoming, ok := <-r.incoming:
			if !ok {
				return nil, fmt.Errorf("codex app-server closed before response %s", requestID)
			}
			response, matched, _, err := r.handleIncoming(ctx, incoming, requestID)
			if err != nil {
				return nil, err
			}
			if matched {
				return response, nil
			}
		}
	}
}

func (r *appServerRun) awaitTerminal(ctx context.Context) error {
	for {
		select {
		case <-r.process.done:
			if r.normalizer.terminal {
				return r.terminalReturn(ctx)
			}
			return r.processExitBeforeTerminal(ctx)
		case incoming, ok := <-r.incoming:
			if !ok {
				if r.normalizer.terminal {
					return r.terminalReturn(ctx)
				}
				if r.process.isDone() {
					return r.processExitBeforeTerminal(ctx)
				}
				if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
					return r.processExitBeforeTerminal(ctx)
				}
				return fmt.Errorf("codex app-server output closed before terminal event")
			}
			_, _, terminal, err := r.handleIncoming(ctx, incoming, "")
			if err != nil {
				return err
			}
			if terminal {
				return r.terminalReturn(ctx)
			}
		}
	}
}

func (r *appServerRun) terminalReturn(ctx context.Context) error {
	switch r.normalizer.terminalKind {
	case terminalCompleted:
		return nil
	case terminalCancelled:
		return context.Canceled
	case terminalFailed:
		if r.normalizer.terminalError != "" {
			return errors.New(r.normalizer.terminalError)
		}
		return errors.New("codex run failed")
	default:
		if err := ctx.Err(); err != nil {
			return err
		}
		return nil
	}
}

func (r *appServerRun) handleIncoming(ctx context.Context, incoming incomingMessage, responseID string) (*rpcMessage, bool, bool, error) {
	if incoming.Stderr != "" {
		if r.normalizer.terminal {
			return nil, false, false, nil
		}
		return nil, false, false, r.emitEvent(ctx, normalizedEvent{
			Event: agents.AgentEvent{
				Type:   "agent.log.delta",
				Role:   "system",
				Status: "delta",
				Payload: map[string]any{
					"provider": "codex",
					"text":     incoming.Stderr,
				},
			},
		})
	}
	if incoming.ParseErr != nil {
		event := agents.AgentEvent{
			Type:   "provider.codex.parse_error",
			Role:   "system",
			Status: "failed",
			Payload: map[string]any{
				"provider":            "codex",
				"provider_event_type": "parse_error",
				"line":                incoming.ParseErr.Line,
				"error":               incoming.ParseErr.Err.Error(),
				"raw":                 incoming.ParseErr.Raw,
			},
		}
		if err := r.emitEvent(ctx, normalizedEvent{Event: event}); err != nil {
			return nil, false, false, err
		}
		return nil, false, false, incoming.ParseErr
	}
	if incoming.ReadErr != nil {
		return nil, false, false, incoming.ReadErr
	}

	message := incoming.Message
	if message == nil {
		return nil, false, false, nil
	}
	if message.Method != "" && len(message.ID) > 0 {
		if err := r.handleServerRequest(ctx, message); err != nil {
			return nil, false, false, err
		}
		return nil, false, false, nil
	}
	if message.Method != "" {
		terminal, err := r.handleNotification(ctx, message)
		return nil, false, terminal, err
	}
	if len(message.ID) > 0 {
		matched := message.idKey() == responseID
		return message, matched, false, nil
	}

	event := r.normalizer.unknown("provider.codex.event", "unknown", message.Raw)
	return nil, false, false, r.emitEvent(ctx, event)
}

func (r *appServerRun) handleServerRequest(ctx context.Context, message *rpcMessage) error {
	event := agents.AgentEvent{
		Type:   "provider.codex.request",
		Role:   "system",
		Status: "started",
		Payload: map[string]any{
			"provider":            "codex",
			"provider_event_type": message.Method,
			"raw":                 json.RawMessage(message.Raw),
		},
	}
	if err := r.emitEvent(ctx, normalizedEvent{Event: event}); err != nil {
		return err
	}
	return r.rpc.sendErrorResponse(message.ID, -32601, "Gorchestra does not handle Codex server requests yet")
}

func (r *appServerRun) handleNotification(ctx context.Context, message *rpcMessage) (bool, error) {
	events := r.normalizer.normalize(message.Method, message.Params)
	terminal := false
	for _, event := range events {
		if event.Terminal != terminalNone {
			terminal = true
		}
		if err := r.emitEvent(ctx, event); err != nil {
			return terminal, err
		}
	}
	return terminal, nil
}

func (r *appServerRun) emitSyntheticRunStarted(ctx context.Context, providerEventType string, threadID string) error {
	event := r.normalizer.syntheticRunStarted(providerEventType, threadID)
	if event.Event.Type == "" {
		return nil
	}
	return r.emitEvent(ctx, event)
}

func (r *appServerRun) emitSyntheticTurnStarted(ctx context.Context, providerEventType string, threadID string, turnID string) error {
	event := r.normalizer.syntheticTurnStarted(providerEventType, threadID, turnID)
	if event.Event.Type == "" {
		return nil
	}
	return r.emitEvent(ctx, event)
}

func (r *appServerRun) emitEvent(ctx context.Context, event normalizedEvent) error {
	if event.Event.Type == "" {
		return nil
	}
	emitCtx := ctx
	if event.Terminal != terminalNone && ctx.Err() != nil {
		emitCtx = context.WithoutCancel(ctx)
	}
	return r.emit(emitCtx, event.Event)
}

func (r *appServerRun) processExitBeforeTerminal(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	err := r.process.err()
	if err == nil {
		return fmt.Errorf("codex app-server exited before terminal event")
	}

	exitCode, hasExitCode := exitCode(err)
	payload := map[string]any{
		"provider":            "codex",
		"provider_event_type": "process.exit",
		"error":               err.Error(),
	}
	if hasExitCode {
		payload["exit_code"] = exitCode
	}

	runErr := fmt.Errorf("codex app-server exited before terminal event: %w", err)
	if emitErr := r.emitEvent(ctx, normalizedEvent{
		Event: agents.AgentEvent{
			Type:    "agent.run.failed",
			Role:    "assistant",
			Status:  "failed",
			Payload: payload,
		},
		Terminal: terminalFailed,
	}); emitErr != nil {
		return emitErr
	}
	r.normalizer.markTerminal(terminalFailed, runErr.Error())
	return runErr
}

func (r *appServerRun) watchCancellation(ctx context.Context) chan struct{} {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			r.interruptOrKill()
		case <-done:
		}
	}()
	return done
}

func (r *appServerRun) interruptOrKill() {
	threadID, turnID := r.ids()
	if threadID != "" && turnID != "" {
		_, _ = r.rpc.sendRequest("turn/interrupt", map[string]any{
			"threadId": threadID,
			"turnId":   turnID,
		})
	}

	if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
		return
	}
	r.process.kill()
}

func (r *appServerRun) stopServer() {
	_ = r.rpc.Close()
	if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
		return
	}
	r.process.kill()
	_, _ = r.process.waitTimeout(r.agent.interruptGrace)
}

func (r *appServerRun) setThreadID(threadID string) {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.threadID = threadID
}

func (r *appServerRun) setTurnID(turnID string) {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.turnID = turnID
}

func (r *appServerRun) getThreadID() string {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.threadID
}

func (r *appServerRun) ids() (string, string) {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.threadID, r.turnID
}

type incomingMessage struct {
	Message  *rpcMessage
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
	return fmt.Sprintf("parse codex app-server JSON-RPC line %d: %v", e.Line, e.Err)
}

func readAppServer(stdout io.Reader, stderr io.Reader) <-chan incomingMessage {
	incoming := make(chan incomingMessage, 128)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanJSONRPC(stdout, incoming)
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

func scanJSONRPC(reader io.Reader, incoming chan<- incomingMessage) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		message, err := parseRPCMessage([]byte(raw))
		if err != nil {
			incoming <- incomingMessage{ParseErr: &ParseError{Line: line, Raw: raw, Err: err}}
			continue
		}
		incoming <- incomingMessage{Message: message}
	}
	if err := scanner.Err(); err != nil {
		incoming <- incomingMessage{ReadErr: fmt.Errorf("read codex app-server stdout: %w", err)}
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
		incoming <- incomingMessage{ReadErr: fmt.Errorf("read codex app-server stderr: %w", err)}
	}
}

func parseRPCMessage(raw []byte) (*rpcMessage, error) {
	var message rpcMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return nil, err
	}
	message.Raw = append([]byte(nil), raw...)
	return &message, nil
}

func stringAt(raw json.RawMessage, path ...string) string {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return ""
		}
		value = object[key]
	}
	text, _ := value.(string)
	return text
}

func exitCode(err error) (int, bool) {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return 0, false
	}
	return exitErr.ExitCode(), true
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
	Raw     json.RawMessage `json:"-"`
}

func (m rpcMessage) idKey() string {
	return rawIDKey(m.ID)
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rpcClient struct {
	mu     sync.Mutex
	nextID int64
	writer io.WriteCloser
	closed bool
}

func newRPCClient(writer io.WriteCloser) *rpcClient {
	return &rpcClient{writer: writer}
}

func (c *rpcClient) sendRequest(method string, params any) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return "", io.ErrClosedPipe
	}
	c.nextID++
	id := c.nextID
	message := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		message["params"] = params
	}
	if err := writeRPC(c.writer, message); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d", id), nil
}

func (c *rpcClient) sendNotification(method string, params any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	message := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
	}
	if params != nil {
		message["params"] = params
	}
	return writeRPC(c.writer, message)
}

func (c *rpcClient) sendErrorResponse(id json.RawMessage, code int, messageText string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	var idValue any
	if len(id) > 0 {
		if err := json.Unmarshal(id, &idValue); err != nil {
			idValue = string(id)
		}
	}
	message := map[string]any{
		"jsonrpc": "2.0",
		"id":      idValue,
		"error": map[string]any{
			"code":    code,
			"message": messageText,
		},
	}
	return writeRPC(c.writer, message)
}

func (c *rpcClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.writer.Close()
}

func writeRPC(writer io.Writer, message any) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	_, err = writer.Write(encoded)
	return err
}

func rawIDKey(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	return string(raw)
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
