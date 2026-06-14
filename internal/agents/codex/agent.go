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
	Type                   = "codex"
	defaultBinary          = "codex"
	defaultSandbox         = "workspace-write"
	defaultApprovalPolicy  = "never"
	defaultNetworkAccess   = true
	defaultWebSearchMode   = "live"
	defaultInterruptGrace  = 2 * time.Second
	defaultFastServiceTier = "priority"
)

type VersionChecker func(ctx context.Context, binary string) (string, error)

type Option func(*Agent)

type Agent struct {
	binary          string
	sandbox         string
	approvalPolicy  string
	networkAccess   bool
	webSearchMode   string
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
		networkAccess:  defaultNetworkAccess,
		webSearchMode:  defaultWebSearchMode,
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

func WithNetworkAccess(enabled bool) Option {
	return func(agent *Agent) {
		agent.networkAccess = enabled
	}
}

func WithWebSearchMode(mode string) Option {
	return func(agent *Agent) {
		if strings.TrimSpace(mode) != "" {
			agent.webSearchMode = strings.TrimSpace(mode)
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

	cmd := a.command(workdir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create codex options stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create codex options stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return agents.Options{}, fmt.Errorf("create codex options stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return agents.Options{}, fmt.Errorf("start codex options app-server: %w", err)
	}

	probe := &appServerProbe{
		rpc:            newRPCClient(stdin),
		incoming:       readAppServer(stdout, stderr),
		process:        waitProcess(cmd),
		interruptGrace: a.interruptGrace,
	}
	defer probe.stop()

	if err := probe.initialize(ctx); err != nil {
		return agents.Options{}, err
	}

	models, err := probe.listModels(ctx)
	if err != nil {
		return agents.Options{}, err
	}
	modes, err := probe.listCollaborationModes(ctx)
	if err != nil {
		return agents.Options{}, err
	}

	return normalizeOptions(models, modes), nil
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
		agent:             a,
		rpc:               newRPCClient(stdin),
		incoming:          readAppServer(stdout, stderr),
		process:           waitProcess(cmd),
		emit:              emit,
		normalizer:        newNormalizer(),
		options:           runOptionsFromMetadata(input.Metadata),
		attachments:       input.Attachments,
		sessionID:         input.SessionID,
		providerSessionID: strings.TrimSpace(input.ProviderSessionID),
		userInput:         input.UserInput,
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
	args := []string{"app-server", "--stdio"}
	if a.webSearchMode != "" {
		args = append(args, "-c", fmt.Sprintf("web_search=%q", a.webSearchMode))
	}
	cmd := exec.Command(a.binary, args...)
	cmd.Dir = workdir
	return cmd
}

type codexRunOptions struct {
	Model           string
	ReasoningEffort string
	ServiceTier     string
	PlanningMode    bool
}

func runOptionsFromMetadata(metadata map[string]any) codexRunOptions {
	rawOptions, ok := metadata["codex_options"].(map[string]any)
	if !ok {
		return codexRunOptions{}
	}

	options := codexRunOptions{
		Model:           stringMetadataValue(rawOptions, "model"),
		ReasoningEffort: stringMetadataValue(rawOptions, "reasoning_effort"),
		ServiceTier:     stringMetadataValue(rawOptions, "service_tier"),
		PlanningMode:    boolMetadataValue(rawOptions, "planning_mode"),
	}
	if options.ServiceTier == "" && boolMetadataValue(rawOptions, "fast_mode") {
		options.ServiceTier = defaultFastServiceTier
	}
	return options
}

func stringMetadataValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func boolMetadataValue(values map[string]any, key string) bool {
	value, _ := values[key].(bool)
	return value
}

type appServerProbe struct {
	rpc            *rpcClient
	incoming       <-chan incomingMessage
	process        *processState
	interruptGrace time.Duration
}

type codexModelListResponse struct {
	Data       []codexModel `json:"data"`
	NextCursor string       `json:"nextCursor"`
}

type codexModel struct {
	ID                        string                  `json:"id"`
	Model                     string                  `json:"model"`
	DisplayName               string                  `json:"displayName"`
	Description               string                  `json:"description"`
	Hidden                    bool                    `json:"hidden"`
	SupportedReasoningEfforts []codexReasoningEffort  `json:"supportedReasoningEfforts"`
	DefaultReasoningEffort    string                  `json:"defaultReasoningEffort"`
	ServiceTiers              []codexModelServiceTier `json:"serviceTiers"`
	DefaultServiceTier        string                  `json:"defaultServiceTier"`
	IsDefault                 bool                    `json:"isDefault"`
}

type codexReasoningEffort struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type codexModelServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type codexCollaborationModeListResponse struct {
	Data []codexCollaborationMode `json:"data"`
}

type codexCollaborationMode struct {
	Name            string `json:"name"`
	Mode            string `json:"mode"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
}

func (p *appServerProbe) initialize(ctx context.Context) error {
	id, err := p.rpc.sendRequest("initialize", map[string]any{
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

	response, err := p.awaitResponse(ctx, id)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("codex initialize failed: %s", response.Error.Message)
	}
	return p.rpc.sendNotification("initialized", nil)
}

func (p *appServerProbe) listModels(ctx context.Context) ([]codexModel, error) {
	var models []codexModel
	cursor := ""
	for {
		params := map[string]any{
			"limit":         100,
			"includeHidden": false,
		}
		if cursor != "" {
			params["cursor"] = cursor
		}

		result, err := p.request(ctx, "model/list", params)
		if err != nil {
			return nil, err
		}

		var response codexModelListResponse
		if err := json.Unmarshal(result, &response); err != nil {
			return nil, fmt.Errorf("decode codex model/list response: %w", err)
		}
		models = append(models, response.Data...)
		if response.NextCursor == "" {
			return models, nil
		}
		cursor = response.NextCursor
	}
}

func (p *appServerProbe) listCollaborationModes(ctx context.Context) ([]codexCollaborationMode, error) {
	result, err := p.request(ctx, "collaborationMode/list", map[string]any{})
	if err != nil {
		return nil, err
	}

	var response codexCollaborationModeListResponse
	if err := json.Unmarshal(result, &response); err != nil {
		return nil, fmt.Errorf("decode codex collaborationMode/list response: %w", err)
	}
	return response.Data, nil
}

func (p *appServerProbe) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, err := p.rpc.sendRequest(method, params)
	if err != nil {
		return nil, err
	}
	response, err := p.awaitResponse(ctx, id)
	if err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, fmt.Errorf("codex %s failed: %s", method, response.Error.Message)
	}
	return response.Result, nil
}

func (p *appServerProbe) awaitResponse(ctx context.Context, requestID string) (*rpcMessage, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.process.done:
			return nil, p.processExitBeforeResponse(requestID)
		case incoming, ok := <-p.incoming:
			if !ok {
				return nil, fmt.Errorf("codex app-server closed before response %s", requestID)
			}
			if incoming.ParseErr != nil {
				return nil, incoming.ParseErr
			}
			if incoming.ReadErr != nil {
				return nil, incoming.ReadErr
			}
			if incoming.Message == nil {
				continue
			}
			if len(incoming.Message.ID) == 0 {
				continue
			}
			if incoming.Message.idKey() == requestID {
				return incoming.Message, nil
			}
		}
	}
}

func (p *appServerProbe) processExitBeforeResponse(requestID string) error {
	if err := p.process.err(); err != nil {
		return fmt.Errorf("codex app-server exited before response %s: %w", requestID, err)
	}
	return fmt.Errorf("codex app-server exited before response %s", requestID)
}

func (p *appServerProbe) stop() {
	_ = p.rpc.Close()
	if _, ok := p.process.waitTimeout(p.interruptGrace); ok {
		return
	}
	p.process.kill()
	_, _ = p.process.waitTimeout(p.interruptGrace)
}

func normalizeOptions(models []codexModel, modes []codexCollaborationMode) agents.Options {
	options := agents.Options{
		Models:             make([]agents.ModelOption, 0, len(models)),
		CollaborationModes: make([]agents.CollaborationModeOption, 0, len(modes)),
	}
	for _, model := range models {
		modelOption := agents.ModelOption{
			ID:                        model.ID,
			Model:                     model.Model,
			DisplayName:               model.DisplayName,
			Description:               model.Description,
			Hidden:                    model.Hidden,
			SupportedReasoningEfforts: make([]agents.ReasoningEffortOption, 0, len(model.SupportedReasoningEfforts)),
			DefaultReasoningEffort:    model.DefaultReasoningEffort,
			ServiceTiers:              make([]agents.ModelServiceTier, 0, len(model.ServiceTiers)),
			DefaultServiceTier:        model.DefaultServiceTier,
			IsDefault:                 model.IsDefault,
		}
		for _, effort := range model.SupportedReasoningEfforts {
			modelOption.SupportedReasoningEfforts = append(modelOption.SupportedReasoningEfforts, agents.ReasoningEffortOption{
				ReasoningEffort: effort.ReasoningEffort,
				Description:     effort.Description,
			})
		}
		for _, tier := range model.ServiceTiers {
			modelOption.ServiceTiers = append(modelOption.ServiceTiers, agents.ModelServiceTier{
				ID:          tier.ID,
				Name:        tier.Name,
				Description: tier.Description,
			})
		}
		if modelOption.IsDefault {
			options.DefaultModel = modelOption.Model
		}
		options.Models = append(options.Models, modelOption)
	}
	if options.DefaultModel == "" && len(options.Models) > 0 {
		options.DefaultModel = options.Models[0].Model
	}
	for _, mode := range modes {
		if mode.Name == "" && mode.Mode == "" {
			continue
		}
		options.CollaborationModes = append(options.CollaborationModes, agents.CollaborationModeOption{
			Name:            mode.Name,
			Mode:            mode.Mode,
			Model:           mode.Model,
			ReasoningEffort: mode.ReasoningEffort,
		})
	}
	return options
}

type appServerRun struct {
	agent             *Agent
	rpc               *rpcClient
	incoming          <-chan incomingMessage
	process           *processState
	emit              agents.EmitFunc
	normalizer        *normalizer
	options           codexRunOptions
	attachments       []agents.Attachment
	sessionID         string
	providerSessionID string
	userInput         agents.UserInputBroker

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
	if r.providerSessionID != "" {
		if err := r.resumeThread(ctx, r.providerSessionID, workdir); err != nil {
			return err
		}
	} else {
		if err := r.startThread(ctx, workdir); err != nil {
			return err
		}
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
		"ephemeral":             false,
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

func (r *appServerRun) resumeThread(ctx context.Context, providerSessionID string, workdir string) error {
	threadID := strings.TrimSpace(providerSessionID)
	if threadID == "" {
		return fmt.Errorf("codex thread/resume requires threadId")
	}

	params := map[string]any{
		"threadId":       threadID,
		"cwd":            workdir,
		"approvalPolicy": r.agent.approvalPolicy,
		"sandbox":        r.agent.sandbox,
	}
	if r.agent.model != "" {
		params["model"] = r.agent.model
	}
	if r.options.Model != "" {
		params["model"] = r.options.Model
	}
	if r.options.ServiceTier != "" {
		params["serviceTier"] = r.options.ServiceTier
	}

	id, err := r.rpc.sendRequest("thread/resume", params)
	if err != nil {
		return err
	}

	response, err := r.awaitResponse(ctx, id)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("codex thread/resume failed: %s", response.Error.Message)
	}

	resumedThreadID := stringAt(response.Result, "thread", "id")
	if resumedThreadID == "" {
		return fmt.Errorf("codex thread/resume response missing thread.id")
	}
	if resumedThreadID != threadID {
		return fmt.Errorf("codex thread/resume returned different thread.id %q for requested %q", resumedThreadID, threadID)
	}
	r.setThreadID(resumedThreadID)
	return r.emitSyntheticRunStarted(ctx, "thread/resume", resumedThreadID)
}

func (r *appServerRun) startTurn(ctx context.Context, message string, workdir string) error {
	threadID := r.getThreadID()
	params := map[string]any{
		"threadId":              threadID,
		"input":                 userInputItems(message, r.attachments),
		"cwd":                   workdir,
		"runtimeWorkspaceRoots": []string{workdir},
		"approvalPolicy":        r.agent.approvalPolicy,
	}
	if sandboxPolicy := sandboxPolicyForMode(r.agent.sandbox, r.agent.networkAccess); sandboxPolicy != nil {
		params["sandboxPolicy"] = sandboxPolicy
	}
	if r.agent.model != "" {
		params["model"] = r.agent.model
	}
	if r.options.Model != "" {
		params["model"] = r.options.Model
	}
	if r.options.ServiceTier != "" {
		params["serviceTier"] = r.options.ServiceTier
	}
	if r.options.ReasoningEffort != "" {
		params["effort"] = r.options.ReasoningEffort
	}
	if r.options.PlanningMode {
		model := r.options.Model
		if model == "" {
			model = r.agent.model
		}
		if model != "" {
			settings := map[string]any{
				"model":                  model,
				"reasoning_effort":       nil,
				"developer_instructions": nil,
			}
			if r.options.ReasoningEffort != "" {
				settings["reasoning_effort"] = r.options.ReasoningEffort
			}
			params["collaborationMode"] = map[string]any{
				"mode":     "plan",
				"settings": settings,
			}
		}
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

func userInputItems(message string, attachments []agents.Attachment) []map[string]any {
	items := make([]map[string]any, 0, 1+len(attachments))
	if strings.TrimSpace(message) != "" {
		items = append(items, map[string]any{
			"type":          "text",
			"text":          message,
			"text_elements": []any{},
		})
	}
	for _, attachment := range attachments {
		dataURL := strings.TrimSpace(attachment.DataURL)
		if dataURL == "" {
			continue
		}
		items = append(items, map[string]any{
			"type":   "image",
			"url":    dataURL,
			"detail": "auto",
		})
	}
	return items
}

func sandboxPolicyForMode(mode string, networkAccess bool) map[string]any {
	switch strings.TrimSpace(mode) {
	case "workspace-write", "workspaceWrite":
		return map[string]any{
			"type":                "workspaceWrite",
			"writableRoots":       []string{},
			"networkAccess":       networkAccess,
			"excludeTmpdirEnvVar": false,
			"excludeSlashTmp":     false,
		}
	case "read-only", "readOnly":
		return map[string]any{
			"type":          "readOnly",
			"networkAccess": networkAccess,
		}
	case "danger-full-access", "dangerFullAccess":
		return map[string]any{
			"type": "dangerFullAccess",
		}
	default:
		return nil
	}
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
	if message.Method == "item/tool/requestUserInput" {
		return r.handleUserInputRequest(ctx, message)
	}

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

func (r *appServerRun) handleUserInputRequest(ctx context.Context, message *rpcMessage) error {
	var params codexUserInputParams
	if err := json.Unmarshal(message.Params, &params); err != nil {
		if emitErr := r.emitProviderRequest(ctx, message, "failed"); emitErr != nil {
			return emitErr
		}
		return r.rpc.sendErrorResponse(message.ID, -32602, "invalid Codex user input request params")
	}

	request := agents.UserInputRequest{
		SessionID:         r.sessionID,
		RequestID:         codexUserInputRequestID(params, message.ID),
		Provider:          "codex",
		ProviderEventType: message.Method,
		ProviderRequestID: message.idKey(),
		ThreadID:          params.ThreadID,
		TurnID:            params.TurnID,
		ItemID:            params.ItemID,
		Questions:         codexUserInputQuestions(params.Questions),
	}
	if request.RequestID == "" || len(request.Questions) == 0 {
		if emitErr := r.emitProviderRequest(ctx, message, "failed"); emitErr != nil {
			return emitErr
		}
		return r.rpc.sendErrorResponse(message.ID, -32602, "invalid Codex user input request")
	}
	if r.userInput == nil {
		if err := r.emitUserInputRequested(ctx, request, message.Raw); err != nil {
			return err
		}
		return r.rpc.sendErrorResponse(message.ID, -32601, "Gorchestra cannot answer Codex user input requests")
	}

	waiter, err := r.userInput.OpenUserInput(ctx, request)
	if err != nil {
		if emitErr := r.emitUserInputRequested(ctx, request, message.Raw); emitErr != nil {
			return emitErr
		}
		return r.rpc.sendErrorResponse(message.ID, -32000, "Gorchestra could not open a user input request")
	}
	defer waiter.Close()

	if err := r.emitUserInputRequested(ctx, request, message.Raw); err != nil {
		return err
	}

	response, err := waiter.Wait(ctx)
	if err != nil {
		_ = r.rpc.sendErrorResponse(message.ID, -32800, "Gorchestra user input request was cancelled")
		return err
	}
	return r.rpc.sendResponse(message.ID, response)
}

func (r *appServerRun) emitProviderRequest(ctx context.Context, message *rpcMessage, status string) error {
	event := agents.AgentEvent{
		Type:   "provider.codex.request",
		Role:   "system",
		Status: status,
		Payload: map[string]any{
			"provider":            "codex",
			"provider_event_type": message.Method,
			"raw":                 json.RawMessage(message.Raw),
		},
	}
	return r.emitEvent(ctx, normalizedEvent{Event: event})
}

func (r *appServerRun) emitUserInputRequested(ctx context.Context, request agents.UserInputRequest, raw json.RawMessage) error {
	event := agents.AgentEvent{
		Type:   "agent.input.requested",
		Role:   "assistant",
		Status: "started",
		Payload: map[string]any{
			"provider":            request.Provider,
			"provider_event_type": request.ProviderEventType,
			"provider_request_id": request.ProviderRequestID,
			"request_id":          request.RequestID,
			"thread_id":           request.ThreadID,
			"turn_id":             request.TurnID,
			"item_id":             request.ItemID,
			"questions":           request.Questions,
			"raw":                 json.RawMessage(raw),
		},
	}
	return r.emitEvent(ctx, normalizedEvent{Event: event})
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

type codexUserInputParams struct {
	ThreadID  string                   `json:"threadId"`
	TurnID    string                   `json:"turnId"`
	ItemID    string                   `json:"itemId"`
	Questions []codexUserInputQuestion `json:"questions"`
}

type codexUserInputQuestion struct {
	ID       string                 `json:"id"`
	Header   string                 `json:"header"`
	Question string                 `json:"question"`
	IsOther  bool                   `json:"isOther"`
	IsSecret bool                   `json:"isSecret"`
	Options  []codexUserInputOption `json:"options"`
}

type codexUserInputOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

func codexUserInputRequestID(params codexUserInputParams, rpcID json.RawMessage) string {
	if itemID := strings.TrimSpace(params.ItemID); itemID != "" {
		return itemID
	}
	if turnID := strings.TrimSpace(params.TurnID); turnID != "" {
		if id := rawIDKey(rpcID); id != "" {
			return turnID + "-" + id
		}
		return turnID
	}
	return rawIDKey(rpcID)
}

func codexUserInputQuestions(questions []codexUserInputQuestion) []agents.UserInputQuestion {
	normalized := make([]agents.UserInputQuestion, 0, len(questions))
	for _, question := range questions {
		id := strings.TrimSpace(question.ID)
		if id == "" {
			continue
		}
		options := make([]agents.UserInputOption, 0, len(question.Options))
		for _, option := range question.Options {
			label := strings.TrimSpace(option.Label)
			if label == "" {
				continue
			}
			options = append(options, agents.UserInputOption{
				Label:       label,
				Description: strings.TrimSpace(option.Description),
			})
		}
		normalized = append(normalized, agents.UserInputQuestion{
			ID:       id,
			Header:   strings.TrimSpace(question.Header),
			Question: strings.TrimSpace(question.Question),
			IsOther:  question.IsOther,
			IsSecret: question.IsSecret,
			Options:  options,
		})
	}
	return normalized
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
	message := map[string]any{
		"jsonrpc": "2.0",
		"id":      rpcIDValue(id),
		"error": map[string]any{
			"code":    code,
			"message": messageText,
		},
	}
	return writeRPC(c.writer, message)
}

func (c *rpcClient) sendResponse(id json.RawMessage, result any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	message := map[string]any{
		"jsonrpc": "2.0",
		"id":      rpcIDValue(id),
		"result":  result,
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

func rpcIDValue(raw json.RawMessage) any {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	return value
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
