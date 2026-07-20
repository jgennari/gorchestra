package pi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
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
	Type                  = "pi"
	defaultBinary         = "pi"
	defaultInterruptGrace = 2 * time.Second
	maxJSONLineBytes      = 64 * 1024 * 1024
	maxStderrLineBytes    = 1024 * 1024
)

type VersionChecker func(ctx context.Context, binary string) (string, error)

type Option func(*Agent)

type Agent struct {
	binary         string
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
		err = fmt.Errorf("%w: pi binary %q: %v", agents.ErrUnavailable, a.binary, err)
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

func (a *Agent) Options(ctx context.Context) (agents.Options, error) {
	if err := ctx.Err(); err != nil {
		return agents.Options{}, err
	}
	if err := a.Available(); err != nil {
		return agents.Options{}, err
	}

	workdir, err := a.workdirForRun("")
	if err != nil {
		return agents.Options{}, err
	}
	cmd := a.optionsCommand(workdir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create pi stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create pi stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create pi stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return agents.Options{}, fmt.Errorf("start pi rpc: %w", err)
	}
	process := waitProcess(cmd)
	rpc := newRPCClient(stdin)
	incoming := readRPC(stdout, stderr)
	defer func() {
		_ = rpc.Close()
		if _, ok := process.waitTimeout(a.interruptGrace); !ok {
			process.kill()
			_, _ = process.waitTimeout(a.interruptGrace)
		}
	}()

	id, err := rpc.sendCommand("get_available_models", nil)
	if err != nil {
		return agents.Options{}, err
	}
	for {
		response, err := awaitResponse(ctx, incoming, process, id, "get_available_models")
		if err != nil {
			return agents.Options{}, err
		}
		if response.Error != "" {
			return agents.Options{}, fmt.Errorf("pi get_available_models failed: %s", response.Error)
		}
		return optionsFromModels(response.Data), nil
	}
}

func optionsFromModels(raw json.RawMessage) agents.Options {
	models := make([]agents.ModelOption, 0)
	seen := make(map[string]bool)

	var decoded struct {
		Models []struct {
			Provider    string `json:"provider"`
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Reasoning   bool   `json:"reasoning"`
			Default     bool   `json:"default"`
		} `json:"models"`
	}
	_ = json.Unmarshal(raw, &decoded)
	for _, model := range decoded.Models {
		provider := strings.TrimSpace(model.Provider)
		modelID := strings.TrimSpace(model.ID)
		if modelID == "" {
			continue
		}
		id := modelID
		if provider != "" && !strings.Contains(modelID, "/") {
			id = provider + "/" + modelID
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		displayName := strings.TrimSpace(model.Name)
		if displayName == "" {
			displayName = displayNameForModel(id)
		}
		option := agents.ModelOption{
			ID:          id,
			Model:       id,
			DisplayName: displayName,
			Description: strings.TrimSpace(model.Description),
			IsDefault:   model.Default,
		}
		if model.Reasoning {
			option.SupportedReasoningEfforts = piThinkingEfforts()
			option.DefaultReasoningEffort = "medium"
		}
		models = append(models, option)
	}

	defaultModel := ""
	for _, model := range models {
		if model.IsDefault {
			defaultModel = model.Model
			break
		}
	}
	if defaultModel == "" && len(models) > 0 {
		defaultModel = models[0].Model
		models[0].IsDefault = true
	}

	return agents.Options{
		DefaultModel: defaultModel,
		Models:       models,
	}
}

func piThinkingEfforts() []agents.ReasoningEffortOption {
	values := []string{"off", "minimal", "low", "medium", "high", "xhigh"}
	options := make([]agents.ReasoningEffortOption, 0, len(values))
	for _, value := range values {
		options = append(options, agents.ReasoningEffortOption{
			ReasoningEffort: value,
			Description:     "Pi thinking level " + value,
		})
	}
	return options
}

func displayNameForModel(modelID string) string {
	provider, model, ok := strings.Cut(modelID, "/")
	if !ok || provider == "" {
		return modelID
	}
	return strings.ToUpper(provider[:1]) + provider[1:] + "/" + strings.ReplaceAll(model, "-", " ")
}

func (a *Agent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := a.Available(); err != nil {
		return err
	}
	if input.Action != "" && input.Action != agents.AgentActionMessage {
		return fmt.Errorf("unsupported pi agent action %q", input.Action)
	}

	workdir, err := a.workdirForRun(input.Workdir)
	if err != nil {
		return err
	}

	cmd := a.command(workdir, input.ProviderSessionID)
	if err := agents.ApplyEnvironment(cmd, input.Environment); err != nil {
		return fmt.Errorf("configure pi environment: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("create pi stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("create pi stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("create pi stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start pi rpc: %w", err)
	}

	run := &rpcRun{
		agent:             a,
		rpc:               newRPCClient(stdin),
		incoming:          readRPC(stdout, stderr),
		process:           waitProcess(cmd),
		emit:              emit,
		normalizer:        newNormalizer(),
		sessionID:         input.SessionID,
		providerSessionID: strings.TrimSpace(input.ProviderSessionID),
		attachments:       input.Attachments,
		options:           runOptionsFromMetadata(input.Metadata),
	}
	return run.execute(ctx, input.ProviderMessage())
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

func (a *Agent) command(workdir string, providerSessionID string) *exec.Cmd {
	args := []string{"--mode", "rpc", "--no-approve"}
	if strings.TrimSpace(providerSessionID) != "" {
		args = append(args, "--session", strings.TrimSpace(providerSessionID))
	}
	cmd := exec.Command(a.binary, args...)
	cmd.Dir = workdir
	return cmd
}

func (a *Agent) optionsCommand(workdir string) *exec.Cmd {
	cmd := exec.Command(a.binary, "--mode", "rpc", "--no-approve", "--no-session")
	cmd.Dir = workdir
	return cmd
}

type rpcRun struct {
	agent             *Agent
	rpc               *rpcClient
	incoming          <-chan incomingMessage
	process           *processState
	emit              agents.EmitFunc
	normalizer        *normalizer
	sessionID         string
	providerSessionID string
	attachments       []agents.Attachment
	options           piRunOptions
}

type piRunOptions struct {
	Model         string
	ThinkingLevel string
}

func runOptionsFromMetadata(metadata map[string]any) piRunOptions {
	rawOptions, ok := metadata["pi_options"].(map[string]any)
	if !ok {
		return piRunOptions{}
	}
	return piRunOptions{
		Model:         stringMetadataValue(rawOptions, "model"),
		ThinkingLevel: stringMetadataValue(rawOptions, "thinking_level"),
	}
}

func (r *rpcRun) execute(ctx context.Context, message string) error {
	cancelWatchDone := r.watchCancellation(ctx)
	defer close(cancelWatchDone)
	defer r.stop()

	if err := r.loadState(ctx); err != nil {
		return err
	}
	if err := r.configure(ctx); err != nil {
		return err
	}
	if err := r.prompt(ctx, message); err != nil {
		return err
	}
	return r.terminalReturn(ctx)
}

func (r *rpcRun) loadState(ctx context.Context) error {
	id, err := r.rpc.sendCommand("get_state", nil)
	if err != nil {
		return err
	}
	response, err := r.awaitResponse(ctx, id, "get_state")
	if err != nil {
		return err
	}
	if response.Error != "" {
		return fmt.Errorf("pi get_state failed: %s", response.Error)
	}
	sessionID := strings.TrimSpace(r.providerSessionID)
	if sessionID == "" {
		sessionID = stringAt(response.Data, "sessionId")
	}
	if sessionID == "" {
		return fmt.Errorf("pi get_state response missing sessionId")
	}
	return r.emit(ctx, agents.AgentEvent{
		Type:   "agent.run.started",
		Role:   "assistant",
		Status: "started",
		Payload: map[string]any{
			"provider":            Type,
			"provider_event_type": "get_state",
			"provider_session_id": sessionID,
		},
	})
}

func (r *rpcRun) configure(ctx context.Context) error {
	if err := r.sendSimpleCommand(ctx, "set_auto_retry", map[string]any{"enabled": false}); err != nil {
		return err
	}
	if r.options.Model != "" {
		provider, model := splitModel(r.options.Model)
		params := map[string]any{"modelId": model}
		if provider != "" {
			params["provider"] = provider
		}
		if err := r.sendSimpleCommand(ctx, "set_model", params); err != nil {
			return err
		}
	}
	if r.options.ThinkingLevel != "" {
		if err := r.sendSimpleCommand(ctx, "set_thinking_level", map[string]any{"thinkingLevel": r.options.ThinkingLevel}); err != nil {
			return err
		}
	}
	return nil
}

func (r *rpcRun) sendSimpleCommand(ctx context.Context, command string, data any) error {
	id, err := r.rpc.sendCommand(command, data)
	if err != nil {
		return err
	}
	response, err := r.awaitResponse(ctx, id, command)
	if err != nil {
		return err
	}
	if response.Error != "" {
		return fmt.Errorf("pi %s failed: %s", command, response.Error)
	}
	return nil
}

func (r *rpcRun) prompt(ctx context.Context, message string) error {
	data, err := promptData(message, r.attachments)
	if err != nil {
		return err
	}
	id, err := r.rpc.sendCommand("prompt", data)
	if err != nil {
		return err
	}
	response, err := r.awaitResponse(ctx, id, "prompt")
	if err != nil {
		return err
	}
	if response.Error != "" {
		normalized := r.normalizer.failed(response.Error, response.Raw)
		if emitErr := r.emitEvent(ctx, normalized); emitErr != nil {
			return emitErr
		}
		return errors.New(response.Error)
	}
	return nil
}

func promptData(message string, attachments []agents.Attachment) (map[string]any, error) {
	data := map[string]any{
		"prompt": strings.TrimSpace(message),
	}
	images := make([]map[string]any, 0, len(attachments))
	for _, attachment := range attachments {
		prefix, encoded, ok := strings.Cut(strings.TrimSpace(attachment.DataURL), ",")
		if !ok || !strings.HasPrefix(prefix, "data:") {
			return nil, fmt.Errorf("pi attachment %q must be a data URL", attachment.Name)
		}
		mediaType := strings.TrimPrefix(prefix, "data:")
		mediaType = strings.TrimSuffix(mediaType, ";base64")
		if mediaType == "" {
			mediaType = attachment.MediaType
		}
		if mediaType == "" {
			return nil, fmt.Errorf("pi attachment %q is missing media type", attachment.Name)
		}
		if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
			return nil, fmt.Errorf("pi attachment %q has invalid base64 data: %w", attachment.Name, err)
		}
		images = append(images, map[string]any{
			"data":      encoded,
			"mediaType": mediaType,
		})
	}
	if len(images) > 0 {
		data["images"] = images
	}
	return data, nil
}

func splitModel(model string) (string, string) {
	model = strings.TrimSpace(model)
	provider, id, ok := strings.Cut(model, "/")
	if !ok {
		return "", model
	}
	return strings.TrimSpace(provider), strings.TrimSpace(id)
}

func (r *rpcRun) awaitResponse(ctx context.Context, id string, command string) (*rpcMessage, error) {
	return awaitResponse(ctx, r.incoming, r.process, id, command, r.handleIncoming)
}

func awaitResponse(ctx context.Context, incoming <-chan incomingMessage, process *processState, id string, command string, handlers ...func(context.Context, incomingMessage) error) (*rpcMessage, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-process.done:
			if err := process.err(); err != nil {
				return nil, fmt.Errorf("pi rpc exited before %s response: %w", command, err)
			}
			return nil, fmt.Errorf("pi rpc exited before %s response", command)
		case incomingMessage, ok := <-incoming:
			if !ok {
				return nil, fmt.Errorf("pi rpc closed before %s response", command)
			}
			if incomingMessage.Stderr != "" || incomingMessage.ParseErr != nil || incomingMessage.ReadErr != nil {
				if len(handlers) > 0 && handlers[0] != nil {
					if err := handlers[0](ctx, incomingMessage); err != nil {
						return nil, err
					}
					continue
				}
				if incomingMessage.ParseErr != nil {
					return nil, incomingMessage.ParseErr
				}
				if incomingMessage.ReadErr != nil {
					return nil, incomingMessage.ReadErr
				}
				continue
			}
			message := incomingMessage.Message
			if message == nil {
				continue
			}
			if message.CommandID == id {
				return message, nil
			}
			if len(handlers) > 0 && handlers[0] != nil {
				if err := handlers[0](ctx, incomingMessage); err != nil {
					return nil, err
				}
			}
		}
	}
}

func (r *rpcRun) handleIncoming(ctx context.Context, incoming incomingMessage) error {
	if incoming.Stderr != "" {
		return r.emit(ctx, agents.AgentEvent{
			Type:   "agent.log.delta",
			Role:   "system",
			Status: "delta",
			Payload: map[string]any{
				"provider": Type,
				"text":     incoming.Stderr,
			},
		})
	}
	if incoming.ParseErr != nil {
		event := agents.AgentEvent{
			Type:   "provider.pi.parse_error",
			Role:   "system",
			Status: "failed",
			Payload: map[string]any{
				"provider":            Type,
				"provider_event_type": "parse_error",
				"line":                incoming.ParseErr.Line,
				"error":               incoming.ParseErr.Err.Error(),
				"raw":                 incoming.ParseErr.Raw,
			},
		}
		if err := r.emit(ctx, event); err != nil {
			return err
		}
		return incoming.ParseErr
	}
	if incoming.ReadErr != nil {
		return incoming.ReadErr
	}
	if incoming.Message == nil {
		return nil
	}
	if incoming.Message.CommandID != "" {
		return nil
	}
	for _, normalized := range r.normalizer.normalize(incoming.Message) {
		if err := r.emitEvent(ctx, normalized); err != nil {
			return err
		}
	}
	return nil
}

func (r *rpcRun) emitEvent(ctx context.Context, normalized normalizedEvent) error {
	if normalized.Event.Type == "" {
		return nil
	}
	if err := r.emit(ctx, normalized.Event); err != nil {
		return err
	}
	return nil
}

func (r *rpcRun) watchCancellation(ctx context.Context) chan struct{} {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_, _ = r.rpc.sendCommand("abort", nil)
		case <-done:
		}
	}()
	return done
}

func (r *rpcRun) terminalReturn(ctx context.Context) error {
	for {
		switch r.normalizer.terminalKind {
		case terminalCompleted:
			return nil
		case terminalCancelled:
			return context.Canceled
		case terminalFailed:
			if r.normalizer.terminalError != "" {
				return errors.New(r.normalizer.terminalError)
			}
			return errors.New("pi run failed")
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.process.done:
			if err := r.process.err(); err != nil {
				return fmt.Errorf("pi rpc exited before terminal event: %w", err)
			}
			return nil
		case incoming, ok := <-r.incoming:
			if !ok {
				return nil
			}
			if err := r.handleIncoming(ctx, incoming); err != nil {
				return err
			}
		}
	}
}

func (r *rpcRun) stop() {
	_ = r.rpc.Close()
	if _, ok := r.process.waitTimeout(r.agent.interruptGrace); ok {
		return
	}
	r.process.kill()
	_, _ = r.process.waitTimeout(r.agent.interruptGrace)
}

func stringMetadataValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
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
	return fmt.Sprintf("parse pi RPC JSON line %d: %v", e.Line, e.Err)
}

func readRPC(stdout io.Reader, stderr io.Reader) <-chan incomingMessage {
	incoming := make(chan incomingMessage, 128)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanJSON(stdout, incoming)
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

func scanJSON(reader io.Reader, incoming chan<- incomingMessage) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), maxJSONLineBytes)
	line := 0
	for scanner.Scan() {
		line++
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		message, err := parseRPCMessage(raw)
		if err != nil {
			incoming <- incomingMessage{ParseErr: &ParseError{Line: line, Raw: string(raw), Err: err}}
			continue
		}
		incoming <- incomingMessage{Message: message}
	}
	if err := scanner.Err(); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			incoming <- incomingMessage{ReadErr: fmt.Errorf("read pi stdout: %w", err)}
		}
	}
}

func scanStderr(reader io.Reader, incoming chan<- incomingMessage) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), maxStderrLineBytes)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		incoming <- incomingMessage{Stderr: line}
	}
	if err := scanner.Err(); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			incoming <- incomingMessage{ReadErr: fmt.Errorf("read pi stderr: %w", err)}
		}
	}
}

type rpcClient struct {
	mu     sync.Mutex
	writer io.WriteCloser
	nextID int64
}

func newRPCClient(writer io.WriteCloser) *rpcClient {
	return &rpcClient{writer: writer}
}

func (c *rpcClient) sendCommand(command string, data any) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	id := fmt.Sprintf("%d", c.nextID)
	message := map[string]any{
		"commandId": id,
		"command":   command,
	}
	if data != nil {
		message["data"] = data
	}
	return id, c.writeLocked(message)
}

func (c *rpcClient) writeLocked(message map[string]any) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	_, err = c.writer.Write(raw)
	return err
}

func (c *rpcClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writer.Close()
}

type rpcMessage struct {
	CommandID string          `json:"commandId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Error     string          `json:"error,omitempty"`
	Raw       json.RawMessage `json:"-"`
}

func parseRPCMessage(raw []byte) (*rpcMessage, error) {
	var message rpcMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return nil, err
	}
	message.Raw = append([]byte(nil), raw...)
	return &message, nil
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

func (p *processState) err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}

func (p *processState) kill() {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Kill()
}

func (p *processState) waitTimeout(timeout time.Duration) (error, bool) {
	if p == nil {
		return nil, true
	}
	select {
	case <-p.done:
		return p.err(), true
	case <-time.After(timeout):
		return nil, false
	}
}
