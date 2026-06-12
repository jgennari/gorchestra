package codex

import (
	"bufio"
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
	wantArgs := []string{"/opt/bin/codex", "app-server", "--stdio"}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("expected args %#v, got %#v", wantArgs, cmd.Args)
	}
	if cmd.Dir != "/tmp/workspace" {
		t.Fatalf("expected dir /tmp/workspace, got %q", cmd.Dir)
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

func runFakeAppServer(mode string) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var request rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}

		switch request.Method {
		case "initialize":
			if mode == "stderr" {
				_, _ = os.Stderr.WriteString("codex log line\n")
			}
			fakeRespond(request.ID, map[string]any{"serverInfo": map[string]any{"name": "fake-codex"}})
		case "initialized":
		case "thread/start":
			fakeRespond(request.ID, map[string]any{
				"thread": map[string]any{
					"id":        "thread_fake",
					"sessionId": "session_fake",
					"preview":   "",
					"ephemeral": true,
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
