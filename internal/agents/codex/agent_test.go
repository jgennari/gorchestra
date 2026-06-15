package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("GORCHESTRA_FAKE_CODEX_APP_SERVER"); mode != "" {
		runFakeAppServer(mode)
		return
	}
	os.Exit(m.Run())
}

func TestAvailabilityDetection(t *testing.T) {
	agent := New(
		WithBinary("codex-test"),
		WithVersionChecker(func(_ context.Context, binary string) (string, error) {
			if binary != "codex-test" {
				t.Fatalf("expected binary codex-test, got %q", binary)
			}
			return "codex-cli 0.test", nil
		}),
	)

	version, err := agent.CheckAvailability(context.Background())
	if err != nil {
		t.Fatalf("check availability: %v", err)
	}
	if version != "codex-cli 0.test" {
		t.Fatalf("expected version codex-cli 0.test, got %q", version)
	}
	if err := agent.Available(); err != nil {
		t.Fatalf("expected available agent, got %v", err)
	}
}

func TestAvailabilityDetectionWrapsUnavailable(t *testing.T) {
	agent := New(
		WithBinary("missing-codex"),
		WithVersionChecker(func(context.Context, string) (string, error) {
			return "", errors.New("not found")
		}),
	)

	_, err := agent.CheckAvailability(context.Background())
	if !errors.Is(err, agents.ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
	if !errors.Is(agent.Available(), agents.ErrUnavailable) {
		t.Fatalf("expected Available to return ErrUnavailable, got %v", agent.Available())
	}
}

func TestCommandConstructionUsesExplicitArgsAndWorkdir(t *testing.T) {
	agent := New(WithBinary("/opt/bin/codex"))
	cmd := agent.command("/tmp/workspace")

	if cmd.Path != "/opt/bin/codex" {
		t.Fatalf("expected path /opt/bin/codex, got %q", cmd.Path)
	}
	wantArgs := []string{"/opt/bin/codex", "app-server", "--stdio", "-c", `web_search="live"`}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("expected args %#v, got %#v", wantArgs, cmd.Args)
	}
	if cmd.Dir != "/tmp/workspace" {
		t.Fatalf("expected dir /tmp/workspace, got %q", cmd.Dir)
	}
}

func TestCommandConstructionCanOverrideWebSearchMode(t *testing.T) {
	agent := New(WithBinary("/opt/bin/codex"), WithWebSearchMode("cached"))
	cmd := agent.command("/tmp/workspace")

	wantArgs := []string{"/opt/bin/codex", "app-server", "--stdio", "-c", `web_search="cached"`}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("expected args %#v, got %#v", wantArgs, cmd.Args)
	}
}

func TestSuccessFixtureNormalizesExpectedEvents(t *testing.T) {
	events := normalizeFixture(t, "success.jsonl")
	assertAgentEventTypes(t, events, []string{
		"agent.run.started",
		"agent.status.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})
	assertTerminalCount(t, events, 1)

	payload := events[2].Payload.(map[string]any)
	if payload["text"] != "Hello" {
		t.Fatalf("expected delta text Hello, got %#v", payload["text"])
	}
	if payload["provider_event_type"] != "item/agentMessage/delta" {
		t.Fatalf("expected provider event type item/agentMessage/delta, got %#v", payload["provider_event_type"])
	}
}

func TestCommandFixtureNormalizesToolEvents(t *testing.T) {
	events := normalizeFixture(t, "command.jsonl")
	assertAgentEventTypes(t, events, []string{
		"tool.call.started",
		"tool.call.delta",
		"tool.call.completed",
	})

	payload := events[2].Payload.(map[string]any)
	if payload["command"] != "go test ./..." {
		t.Fatalf("expected command payload, got %#v", payload["command"])
	}
	if payload["exit_code"] != float64(0) {
		t.Fatalf("expected exit_code 0, got %#v", payload["exit_code"])
	}
}

func TestPlanFixtureNormalizesPlanEvents(t *testing.T) {
	events := normalizeFixture(t, "plan.jsonl")
	assertAgentEventTypes(t, events, []string{
		"agent.plan.delta",
		"agent.plan.delta",
		"agent.plan.completed",
	})

	payload := events[2].Payload.(map[string]any)
	if payload["item_type"] != "plan" {
		t.Fatalf("expected plan item type, got %#v", payload["item_type"])
	}
	if payload["text"] != "# Plan\n- Check the current transcript\n" {
		t.Fatalf("expected completed plan text, got %#v", payload["text"])
	}
}

func TestUnknownFixtureNormalizesProviderEvent(t *testing.T) {
	events := normalizeFixture(t, "unknown.jsonl")
	assertAgentEventTypes(t, events, []string{"provider.codex.event"})

	payload := events[0].Payload.(map[string]any)
	if payload["provider_event_type"] != "thread/compacted" {
		t.Fatalf("expected provider event type thread/compacted, got %#v", payload["provider_event_type"])
	}
	if payload["raw"] == nil {
		t.Fatal("expected raw payload")
	}
}

func TestInvalidJSONRPCProducesParseError(t *testing.T) {
	data, err := os.ReadFile("testdata/invalid.jsonl")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	incoming := readAppServer(strings.NewReader(string(data)), strings.NewReader(""))
	message, ok := <-incoming
	if !ok {
		t.Fatal("expected parse error message")
	}
	if message.ParseErr == nil {
		t.Fatalf("expected parse error, got %#v", message)
	}
	if message.ParseErr.Line != 1 {
		t.Fatalf("expected line 1, got %d", message.ParseErr.Line)
	}
}

func TestAgentRunsFakeAppServerSuccess(t *testing.T) {
	agent := fakeAppServerAgent(t, "success")
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID: "sess_test",
		Message:   "Say hello",
		Workdir:   t.TempDir(),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("run agent: %v", err)
	}

	assertAgentEventTypes(t, recorder.snapshot(), []string{
		"agent.run.started",
		"agent.status.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})
}

func TestAgentResumesExistingProviderSession(t *testing.T) {
	agent := fakeAppServerAgent(t, "success")
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID:         "sess_test",
		ProviderSessionID: "thread_fake",
		Message:           "Continue",
		Workdir:           t.TempDir(),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("run agent: %v", err)
	}

	events := recorder.snapshot()
	assertAgentEventTypes(t, events, []string{
		"agent.run.started",
		"agent.status.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})
	payload, ok := events[0].Payload.(map[string]any)
	if !ok {
		t.Fatalf("expected run started payload, got %#v", events[0].Payload)
	}
	if payload["provider_event_type"] != "thread/resume" {
		t.Fatalf("expected thread/resume provider event, got %#v", payload["provider_event_type"])
	}
}

func TestAgentOptionsProbeNormalizesCodexOptions(t *testing.T) {
	agent := fakeAppServerAgent(t, "options")

	options, err := agent.Options(context.Background())
	if err != nil {
		t.Fatalf("load options: %v", err)
	}

	if options.DefaultModel != "gpt-5.5" {
		t.Fatalf("expected default model gpt-5.5, got %q", options.DefaultModel)
	}
	if len(options.Models) != 1 {
		t.Fatalf("expected one model, got %#v", options.Models)
	}
	model := options.Models[0]
	if model.DisplayName != "GPT-5.5" || model.DefaultReasoningEffort != "medium" {
		t.Fatalf("unexpected model option %#v", model)
	}
	if len(model.ServiceTiers) != 1 || model.ServiceTiers[0].ID != "priority" {
		t.Fatalf("expected priority service tier, got %#v", model.ServiceTiers)
	}
	if len(options.CollaborationModes) != 2 || options.CollaborationModes[0].Mode != "plan" {
		t.Fatalf("expected collaboration modes, got %#v", options.CollaborationModes)
	}
}

func TestStartTurnAppliesRunOptions(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"turn":{"id":"turn_fake","status":"inProgress"}}`),
	}}

	run := &appServerRun{
		agent:    New(WithModel("gpt-default")),
		rpc:      newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming: incoming,
		process:  &processState{done: make(chan struct{})},
		emit: func(context.Context, agents.AgentEvent) error {
			return nil
		},
		normalizer: newNormalizer(),
		options: codexRunOptions{
			Model:           "gpt-5.5",
			ReasoningEffort: "xhigh",
			ServiceTier:     "priority",
			PlanningMode:    true,
		},
	}
	run.setThreadID("thread_fake")

	if err := run.startTurn(context.Background(), "Hello", "/tmp/workspace"); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	var request struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.Method != "turn/start" {
		t.Fatalf("expected turn/start request, got %q", request.Method)
	}
	if request.Params["model"] != "gpt-5.5" {
		t.Fatalf("expected model override, got %#v", request.Params["model"])
	}
	if request.Params["effort"] != "xhigh" {
		t.Fatalf("expected effort override, got %#v", request.Params["effort"])
	}
	if request.Params["serviceTier"] != "priority" {
		t.Fatalf("expected service tier override, got %#v", request.Params["serviceTier"])
	}
	sandboxPolicy, ok := request.Params["sandboxPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("expected sandbox policy, got %#v", request.Params["sandboxPolicy"])
	}
	if sandboxPolicy["type"] != "workspaceWrite" || sandboxPolicy["networkAccess"] != true {
		t.Fatalf("expected workspaceWrite sandbox with network access, got %#v", sandboxPolicy)
	}
	collaborationMode, ok := request.Params["collaborationMode"].(map[string]any)
	if !ok {
		t.Fatalf("expected collaboration mode, got %#v", request.Params["collaborationMode"])
	}
	if collaborationMode["mode"] != "plan" {
		t.Fatalf("expected plan collaboration mode, got %#v", collaborationMode["mode"])
	}
	settings, ok := collaborationMode["settings"].(map[string]any)
	if !ok {
		t.Fatalf("expected collaboration settings, got %#v", collaborationMode["settings"])
	}
	if settings["model"] != "gpt-5.5" || settings["reasoning_effort"] != "xhigh" {
		t.Fatalf("unexpected collaboration settings %#v", settings)
	}
	if settings["developer_instructions"] != nil {
		t.Fatalf("expected built-in collaboration instructions, got %#v", settings["developer_instructions"])
	}
}

func TestStartTurnSendsDefaultCollaborationMode(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"turn":{"id":"turn_fake","status":"inProgress"}}`),
	}}

	run := &appServerRun{
		agent:      New(WithModel("gpt-default")),
		rpc:        newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming:   incoming,
		process:    &processState{done: make(chan struct{})},
		emit:       func(context.Context, agents.AgentEvent) error { return nil },
		normalizer: newNormalizer(),
		options: codexRunOptions{
			Model:           "gpt-5.5",
			ReasoningEffort: "xhigh",
			PlanningMode:    false,
		},
	}
	run.setThreadID("thread_fake")

	if err := run.startTurn(context.Background(), "Hello", "/tmp/workspace"); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	var request struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.Method != "turn/start" {
		t.Fatalf("expected turn/start request, got %q", request.Method)
	}
	collaborationMode, ok := request.Params["collaborationMode"].(map[string]any)
	if !ok {
		t.Fatalf("expected collaboration mode, got %#v", request.Params["collaborationMode"])
	}
	if collaborationMode["mode"] != "default" {
		t.Fatalf("expected default collaboration mode, got %#v", collaborationMode["mode"])
	}
	settings, ok := collaborationMode["settings"].(map[string]any)
	if !ok {
		t.Fatalf("expected collaboration settings, got %#v", collaborationMode["settings"])
	}
	if settings["model"] != "gpt-5.5" || settings["reasoning_effort"] != "xhigh" {
		t.Fatalf("unexpected collaboration settings %#v", settings)
	}
	if settings["developer_instructions"] != nil {
		t.Fatalf("expected built-in collaboration instructions, got %#v", settings["developer_instructions"])
	}
}

func TestStartTurnCanDisableSandboxNetworkAccess(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"turn":{"id":"turn_fake","status":"inProgress"}}`),
	}}

	run := &appServerRun{
		agent:      New(WithSandbox("read-only"), WithNetworkAccess(false)),
		rpc:        newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming:   incoming,
		process:    &processState{done: make(chan struct{})},
		emit:       func(context.Context, agents.AgentEvent) error { return nil },
		normalizer: newNormalizer(),
	}
	run.setThreadID("thread_fake")

	if err := run.startTurn(context.Background(), "Hello", "/tmp/workspace"); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	var request struct {
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	sandboxPolicy, ok := request.Params["sandboxPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("expected sandbox policy, got %#v", request.Params["sandboxPolicy"])
	}
	if sandboxPolicy["type"] != "readOnly" || sandboxPolicy["networkAccess"] != false {
		t.Fatalf("expected readOnly sandbox without network access, got %#v", sandboxPolicy)
	}
}

func TestStartTurnCanRunDangerously(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"turn":{"id":"turn_fake","status":"inProgress"}}`),
	}}

	run := &appServerRun{
		agent:      New(WithSandbox("read-only"), WithNetworkAccess(false)),
		rpc:        newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming:   incoming,
		process:    &processState{done: make(chan struct{})},
		emit:       func(context.Context, agents.AgentEvent) error { return nil },
		normalizer: newNormalizer(),
		options:    codexRunOptions{RunDangerously: true},
	}
	run.setThreadID("thread_fake")

	if err := run.startTurn(context.Background(), "Hello", "/tmp/workspace"); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	var request struct {
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.Params["approvalPolicy"] != "never" {
		t.Fatalf("expected never approval policy, got %#v", request.Params["approvalPolicy"])
	}
	sandboxPolicy, ok := request.Params["sandboxPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("expected sandbox policy, got %#v", request.Params["sandboxPolicy"])
	}
	if sandboxPolicy["type"] != "dangerFullAccess" {
		t.Fatalf("expected dangerFullAccess sandbox, got %#v", sandboxPolicy)
	}
}

func TestStartTurnAddsImageAttachments(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"turn":{"id":"turn_fake","status":"inProgress"}}`),
	}}

	run := &appServerRun{
		agent:      New(),
		rpc:        newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming:   incoming,
		process:    &processState{done: make(chan struct{})},
		emit:       func(context.Context, agents.AgentEvent) error { return nil },
		normalizer: newNormalizer(),
		attachments: []agents.Attachment{
			{
				Name:      "diagram.png",
				MediaType: "image/png",
				DataURL:   "data:image/png;base64,aGVsbG8=",
				SizeBytes: 5,
			},
		},
	}
	run.setThreadID("thread_fake")

	if err := run.startTurn(context.Background(), "Describe this", "/tmp/workspace"); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	var request struct {
		Params struct {
			Input []map[string]any `json:"input"`
		} `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if len(request.Params.Input) != 2 {
		t.Fatalf("expected text and image inputs, got %#v", request.Params.Input)
	}
	if request.Params.Input[0]["type"] != "text" || request.Params.Input[0]["text"] != "Describe this" {
		t.Fatalf("expected text input, got %#v", request.Params.Input[0])
	}
	if request.Params.Input[1]["type"] != "image" || request.Params.Input[1]["url"] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("expected image input, got %#v", request.Params.Input[1])
	}
	if request.Params.Input[1]["detail"] != "auto" {
		t.Fatalf("expected auto image detail, got %#v", request.Params.Input[1]["detail"])
	}
}

func TestResumeThreadUsesExistingProviderSessionID(t *testing.T) {
	var written bytes.Buffer
	incoming := make(chan incomingMessage, 1)
	incoming <- incomingMessage{Message: &rpcMessage{
		ID:     json.RawMessage(`1`),
		Result: json.RawMessage(`{"thread":{"id":"thread_existing"}}`),
	}}

	run := &appServerRun{
		agent:      New(WithModel("gpt-default")),
		rpc:        newRPCClient(bufferWriteCloser{Buffer: &written}),
		incoming:   incoming,
		process:    &processState{done: make(chan struct{})},
		emit:       func(context.Context, agents.AgentEvent) error { return nil },
		normalizer: newNormalizer(),
		options: codexRunOptions{
			Model:       "gpt-5.5",
			ServiceTier: "priority",
		},
	}

	if err := run.resumeThread(context.Background(), "thread_existing", "/tmp/workspace"); err != nil {
		t.Fatalf("resume thread: %v", err)
	}

	var request struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(written.Bytes()), &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.Method != "thread/resume" {
		t.Fatalf("expected thread/resume request, got %q", request.Method)
	}
	if request.Params["threadId"] != "thread_existing" {
		t.Fatalf("expected thread id, got %#v", request.Params["threadId"])
	}
	if request.Params["model"] != "gpt-5.5" {
		t.Fatalf("expected model override, got %#v", request.Params["model"])
	}
	if request.Params["serviceTier"] != "priority" {
		t.Fatalf("expected service tier override, got %#v", request.Params["serviceTier"])
	}
	if got := run.getThreadID(); got != "thread_existing" {
		t.Fatalf("expected stored thread id thread_existing, got %q", got)
	}
}

func TestAgentEmitsFailedEventWhenAppServerExitsNonZero(t *testing.T) {
	agent := fakeAppServerAgent(t, "nonzero")
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID: "sess_test",
		Message:   "Fail",
		Workdir:   t.TempDir(),
	}, recorder.emit)
	if err == nil {
		t.Fatal("expected run error")
	}

	events := recorder.snapshot()
	if !hasAgentEvent(events, "agent.run.failed") {
		t.Fatalf("expected agent.run.failed in %#v", events)
	}
	assertTerminalCount(t, events, 1)
}

func TestAgentEmitsCancelledEventAfterInterrupt(t *testing.T) {
	agent := fakeAppServerAgent(t, "cancel")
	recorder := newEventRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)

	go func() {
		done <- agent.Run(ctx, agents.AgentInput{
			SessionID: "sess_test",
			Message:   "Wait",
			Workdir:   t.TempDir(),
		}, recorder.emit)
	}()

	recorder.waitFor(t, "agent.status.started")
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for cancelled run")
	}

	events := recorder.snapshot()
	if !hasAgentEvent(events, "agent.run.cancelled") {
		t.Fatalf("expected agent.run.cancelled in %#v", events)
	}
	assertTerminalCount(t, events, 1)
}

func TestAgentEmitsStderrAsLogEvent(t *testing.T) {
	agent := fakeAppServerAgent(t, "stderr")
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID: "sess_test",
		Message:   "Log",
		Workdir:   t.TempDir(),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("run agent: %v", err)
	}
	if !hasAgentEvent(recorder.snapshot(), "agent.log.delta") {
		t.Fatalf("expected agent.log.delta in %#v", recorder.snapshot())
	}
}

func TestAgentAnswersUserInputServerRequest(t *testing.T) {
	agent := fakeAppServerAgent(t, "user-input")
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID: "sess_test",
		Message:   "Ask",
		Workdir:   t.TempDir(),
		UserInput: autoAnswerBroker{
			response: agents.UserInputResponse{
				Answers: map[string]agents.UserInputQuestionAnswer{
					"fake_question": {Answers: []string{"Beta"}},
				},
			},
		},
	}, recorder.emit)
	if err != nil {
		t.Fatalf("run agent: %v", err)
	}

	events := recorder.snapshot()
	assertAgentEventTypes(t, events, []string{
		"agent.run.started",
		"agent.status.started",
		"agent.input.requested",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
	})
	payload, ok := events[2].Payload.(map[string]any)
	if !ok {
		t.Fatalf("expected request payload, got %#v", events[2].Payload)
	}
	if payload["request_id"] != "call_fake_question" {
		t.Fatalf("expected request id call_fake_question, got %#v", payload["request_id"])
	}
	assertTerminalCount(t, events, 1)
}

func fakeAppServerAgent(t *testing.T, mode string) *Agent {
	t.Helper()
	t.Setenv("GORCHESTRA_FAKE_CODEX_APP_SERVER", mode)
	return New(
		WithBinary(os.Args[0]),
		WithInterruptGrace(50*time.Millisecond),
		WithVersionChecker(func(context.Context, string) (string, error) {
			return "codex-cli fake", nil
		}),
	)
}

func normalizeFixture(t *testing.T, name string) []agents.AgentEvent {
	t.Helper()

	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	normalizer := newNormalizer()
	events := make([]agents.AgentEvent, 0)
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		message, err := parseRPCMessage([]byte(line))
		if err != nil {
			t.Fatalf("parse fixture line: %v", err)
		}
		for _, normalized := range normalizer.normalize(message.Method, message.Params) {
			events = append(events, normalized.Event)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan fixture: %v", err)
	}
	return events
}

func assertAgentEventTypes(t *testing.T, events []agents.AgentEvent, want []string) {
	t.Helper()

	if len(events) != len(want) {
		t.Fatalf("expected %d events, got %d: %#v", len(want), len(events), events)
	}
	for i, event := range events {
		if event.Type != want[i] {
			t.Fatalf("expected event %d type %q, got %q", i, want[i], event.Type)
		}
	}
}

func assertTerminalCount(t *testing.T, events []agents.AgentEvent, want int) {
	t.Helper()

	count := 0
	for _, event := range events {
		switch event.Type {
		case "agent.run.completed", "agent.run.failed", "agent.run.cancelled":
			count++
		}
	}
	if count != want {
		t.Fatalf("expected %d terminal events, got %d in %#v", want, count, events)
	}
}

func hasAgentEvent(events []agents.AgentEvent, eventType string) bool {
	for _, event := range events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}

type eventRecorder struct {
	mu     sync.Mutex
	events []agents.AgentEvent
}

type autoAnswerBroker struct {
	response agents.UserInputResponse
}

func (b autoAnswerBroker) OpenUserInput(context.Context, agents.UserInputRequest) (agents.UserInputWaiter, error) {
	return autoAnswerWaiter{response: b.response}, nil
}

type autoAnswerWaiter struct {
	response agents.UserInputResponse
}

func (w autoAnswerWaiter) Wait(context.Context) (agents.UserInputResponse, error) {
	return w.response, nil
}

func (w autoAnswerWaiter) Close() {}

func newEventRecorder() *eventRecorder {
	return &eventRecorder{}
}

func (r *eventRecorder) emit(_ context.Context, event agents.AgentEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	return nil
}

func (r *eventRecorder) snapshot() []agents.AgentEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]agents.AgentEvent(nil), r.events...)
}

func (r *eventRecorder) waitFor(t *testing.T, eventType string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s in %#v", eventType, r.snapshot())
		case <-ticker.C:
			if hasAgentEvent(r.snapshot(), eventType) {
				return
			}
		}
	}
}

type bufferWriteCloser struct {
	*bytes.Buffer
}

func (w bufferWriteCloser) Close() error {
	return nil
}

func runFakeAppServer(mode string) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var request rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		if mode == "user-input" && request.Method == "" && request.idKey() == "99" {
			var response agents.UserInputResponse
			if err := json.Unmarshal(request.Result, &response); err != nil {
				os.Exit(5)
			}
			answer := ""
			if questionAnswer := response.Answers["fake_question"]; len(questionAnswer.Answers) > 0 {
				answer = questionAnswer.Answers[0]
			}
			fakeNotify("item/agentMessage/delta", map[string]any{
				"threadId": "thread_fake",
				"turnId":   "turn_fake",
				"itemId":   "message_fake",
				"delta":    "Selected " + answer,
			})
			fakeNotify("item/completed", map[string]any{
				"threadId": "thread_fake",
				"turnId":   "turn_fake",
				"item": map[string]any{
					"type": "agentMessage",
					"id":   "message_fake",
					"text": "Selected " + answer,
				},
			})
			fakeNotify("turn/completed", map[string]any{
				"threadId": "thread_fake",
				"turn": map[string]any{
					"id":     "turn_fake",
					"status": "completed",
				},
			})
			return
		}

		switch request.Method {
		case "initialize":
			if mode == "stderr" {
				_, _ = os.Stderr.WriteString("codex log line\n")
			}
			fakeRespond(request.ID, map[string]any{"serverInfo": map[string]any{"name": "fake-codex"}})
		case "initialized":
		case "model/list":
			fakeRespond(request.ID, map[string]any{
				"data": []map[string]any{
					{
						"id":                     "gpt-5.5",
						"model":                  "gpt-5.5",
						"displayName":            "GPT-5.5",
						"description":            "Default Codex model",
						"hidden":                 false,
						"defaultReasoningEffort": "medium",
						"isDefault":              true,
						"supportedReasoningEfforts": []map[string]any{
							{"reasoningEffort": "low", "description": "Low"},
							{"reasoningEffort": "medium", "description": "Medium"},
							{"reasoningEffort": "xhigh", "description": "Extra high"},
						},
						"serviceTiers": []map[string]any{
							{"id": "priority", "name": "Fast", "description": "1.5x speed"},
						},
					},
				},
				"nextCursor": nil,
			})
		case "collaborationMode/list":
			fakeRespond(request.ID, map[string]any{
				"data": []map[string]any{
					{"name": "Plan", "mode": "plan", "model": nil, "reasoning_effort": "medium"},
					{"name": "Default", "mode": "default", "model": nil, "reasoning_effort": nil},
				},
			})
		case "thread/start":
			fakeRespond(request.ID, map[string]any{
				"thread": map[string]any{
					"id":        "thread_fake",
					"sessionId": "session_fake",
					"preview":   "",
					"ephemeral": false,
				},
			})
		case "thread/resume":
			fakeRespond(request.ID, map[string]any{
				"thread": map[string]any{
					"id":        "thread_fake",
					"sessionId": "session_fake",
					"preview":   "",
					"ephemeral": false,
				},
			})
		case "turn/start":
			fakeRespond(request.ID, map[string]any{
				"turn": map[string]any{
					"id":     "turn_fake",
					"status": "inProgress",
				},
			})
			fakeNotify("turn/started", map[string]any{
				"threadId": "thread_fake",
				"turn": map[string]any{
					"id":     "turn_fake",
					"status": "inProgress",
				},
			})
			switch mode {
			case "success", "stderr":
				fakeNotify("item/agentMessage/delta", map[string]any{
					"threadId": "thread_fake",
					"turnId":   "turn_fake",
					"itemId":   "message_fake",
					"delta":    "Hello",
				})
				fakeNotify("item/completed", map[string]any{
					"threadId": "thread_fake",
					"turnId":   "turn_fake",
					"item": map[string]any{
						"type": "agentMessage",
						"id":   "message_fake",
						"text": "Hello from fake Codex.",
					},
				})
				fakeNotify("turn/completed", map[string]any{
					"threadId": "thread_fake",
					"turn": map[string]any{
						"id":     "turn_fake",
						"status": "completed",
					},
				})
				return
			case "user-input":
				fakeWrite(map[string]any{
					"jsonrpc": "2.0",
					"id":      99,
					"method":  "item/tool/requestUserInput",
					"params": map[string]any{
						"threadId": "thread_fake",
						"turnId":   "turn_fake",
						"itemId":   "call_fake_question",
						"questions": []map[string]any{
							{
								"id":       "fake_question",
								"header":   "Choose",
								"question": "Pick one",
								"isOther":  true,
								"isSecret": false,
								"options": []map[string]any{
									{"label": "Alpha", "description": "First"},
									{"label": "Beta", "description": "Second"},
									{"label": "Gamma", "description": "Third"},
								},
							},
						},
					},
				})
			case "nonzero":
				os.Exit(42)
			case "cancel":
			default:
				os.Exit(3)
			}
		case "turn/interrupt":
			fakeRespond(request.ID, map[string]any{})
			fakeNotify("turn/completed", map[string]any{
				"threadId": "thread_fake",
				"turn": map[string]any{
					"id":     "turn_fake",
					"status": "interrupted",
				},
			})
			return
		default:
			fakeRespondError(request.ID, -32601, "unknown fake method")
		}
	}
}

func fakeRespond(id json.RawMessage, result any) {
	fakeWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      jsonID(id),
		"result":  result,
	})
}

func fakeRespondError(id json.RawMessage, code int, message string) {
	fakeWrite(map[string]any{
		"jsonrpc": "2.0",
		"id":      jsonID(id),
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func fakeNotify(method string, params any) {
	fakeWrite(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func fakeWrite(value any) {
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		os.Exit(4)
	}
}

func jsonID(raw json.RawMessage) any {
	var id any
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil
	}
	return id
}
