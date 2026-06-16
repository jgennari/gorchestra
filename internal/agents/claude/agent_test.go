package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestMain(m *testing.M) {
	if os.Getenv("GORCHESTRA_FAKE_CLAUDE_STREAM") != "" {
		runFakeClaude()
		return
	}
	os.Exit(m.Run())
}

func TestAvailabilityDetection(t *testing.T) {
	agent := New(
		WithBinary("claude-test"),
		WithVersionChecker(func(_ context.Context, binary string) (string, error) {
			if binary != "claude-test" {
				t.Fatalf("expected binary claude-test, got %q", binary)
			}
			return "2.1.128", nil
		}),
	)

	version, err := agent.CheckAvailability(context.Background())
	if err != nil {
		t.Fatalf("check availability: %v", err)
	}
	if version != "2.1.128" {
		t.Fatalf("expected version 2.1.128, got %q", version)
	}
	if err := agent.Available(); err != nil {
		t.Fatalf("expected available agent, got %v", err)
	}
}

func TestAvailabilityDetectionWrapsUnavailable(t *testing.T) {
	agent := New(
		WithBinary("missing-claude"),
		WithVersionChecker(func(context.Context, string) (string, error) {
			return "", errors.New("not found")
		}),
	)

	_, err := agent.CheckAvailability(context.Background())
	if !errors.Is(err, agents.ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
}

func TestCommandConstructionUsesStreamJSONPromptAndResume(t *testing.T) {
	agent := New(WithBinary("/opt/bin/claude"), WithModel("claude-opus-4-7"))
	cmd := agent.command("hello", "session_1", "/tmp/workspace")

	if cmd.Path != "/opt/bin/claude" {
		t.Fatalf("expected path /opt/bin/claude, got %q", cmd.Path)
	}
	wantArgs := []string{
		"/opt/bin/claude",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", "claude-opus-4-7",
		"--resume", "session_1",
		"-p", "hello",
	}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("expected args %#v, got %#v", wantArgs, cmd.Args)
	}
	if cmd.Dir != "/tmp/workspace" {
		t.Fatalf("expected dir /tmp/workspace, got %q", cmd.Dir)
	}
}

func TestCommandConstructionCanSkipPermissionsDangerously(t *testing.T) {
	agent := New(WithBinary("/opt/bin/claude"))
	cmd := agent.commandWithOptions("hello", "", "/tmp/workspace", claudeRunOptions{
		RunDangerously: true,
		Model:          "opus",
		Effort:         "high",
		PermissionMode: "plan",
	})

	wantArgs := []string{
		"/opt/bin/claude",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", "opus",
		"--effort", "high",
		"--permission-mode", "plan",
		"--allow-dangerously-skip-permissions",
		"-p", "hello",
	}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("expected args %#v, got %#v", wantArgs, cmd.Args)
	}
}

func TestRunOptionsFromMetadataReadsDangerousMode(t *testing.T) {
	options := runOptionsFromMetadata(map[string]any{
		"claude_options": map[string]any{
			"run_dangerously": true,
			"model":           "opus",
			"effort":          "high",
			"permission_mode": "plan",
		},
	})

	if !options.RunDangerously {
		t.Fatal("expected run dangerously option")
	}
	if options.Model != "opus" || options.Effort != "high" || options.PermissionMode != "plan" {
		t.Fatalf("unexpected options %#v", options)
	}
}

func TestSampleStreamNormalizesExpectedEvents(t *testing.T) {
	events := normalizeLines(t, []string{
		`{"type":"system","subtype":"init","cwd":"/Users/joey/Source/life","session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","tools":["Task","Bash"],"model":"claude-opus-4-7[1m]"}`,
		`{"type":"system","subtype":"status","status":"requesting","uuid":"4b039800-2856-4239-9254-a943ea47521a","session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed"}`,
		`{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-7","id":"msg_01","type":"message","role":"assistant","content":[]}},"session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","uuid":"e779a1c9-0a9a-4cad-acc3-c970df94042f"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}},"session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","uuid":"4f64f00f-42ea-4b54-8ff8-3f65b5ad7af7"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Joey, what's up?"}},"session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","uuid":"29f8a13a-e721-40d9-945c-9c338974af17"}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-7","id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"Hey Joey, what's up?"}]},"session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","uuid":"8bfd0948-daac-461b-a1af-1e81f6516029"}`,
		`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"},"uuid":"6f16750f-be14-4330-8211-05f68ed80b56","session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed"}`,
		`{"type":"result","subtype":"success","is_error":false,"duration_ms":4286,"result":"Hey Joey, what's up?","stop_reason":"end_turn","session_id":"2fe74369-4b15-49f9-8025-517ed6e52fed","total_cost_usd":0.0175095}`,
	})

	assertAgentEventTypes(t, events, []string{
		"agent.run.started",
		"provider.claude.event",
		"agent.status.started",
		"agent.message.delta",
		"agent.message.delta",
		"agent.message.completed",
		"provider.claude.event",
		"agent.run.completed",
	})
	assertTerminalCount(t, events, 1)

	startPayload := events[0].Event.Payload.(map[string]any)
	if startPayload["provider_session_id"] != "2fe74369-4b15-49f9-8025-517ed6e52fed" {
		t.Fatalf("expected provider session id, got %#v", startPayload)
	}
	deltaPayload := events[3].Event.Payload.(map[string]any)
	if deltaPayload["text"] != "Hey" {
		t.Fatalf("expected delta text Hey, got %#v", deltaPayload["text"])
	}
	if deltaPayload["message_id"] != "msg_01" {
		t.Fatalf("expected delta message id, got %#v", deltaPayload["message_id"])
	}
	completedPayload := events[5].Event.Payload.(map[string]any)
	if completedPayload["text"] != "Hey Joey, what's up?" {
		t.Fatalf("expected completed text, got %#v", completedPayload["text"])
	}
}

func TestResultErrorNormalizesFailedTerminal(t *testing.T) {
	events := normalizeLines(t, []string{
		`{"type":"result","subtype":"error_max_turns","is_error":true,"result":"max turns exceeded","session_id":"session_1"}`,
	})

	assertAgentEventTypes(t, events, []string{"agent.run.failed"})
	if events[0].Terminal != terminalFailed {
		t.Fatalf("expected failed terminal, got %#v", events[0].Terminal)
	}
	payload := events[0].Event.Payload.(map[string]any)
	if payload["error"] != "max turns exceeded" {
		t.Fatalf("expected result error, got %#v", payload)
	}
}

func TestInvalidJSONProducesParseError(t *testing.T) {
	incoming := readStream(strings.NewReader("{"), strings.NewReader(""))
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

func TestAgentRunsFakeClaudeStream(t *testing.T) {
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
	agent := fakeClaudeAgent(t)
	recorder := newEventRecorder()

	err := agent.Run(context.Background(), agents.AgentInput{
		SessionID: "sess_test",
		Message:   "hello",
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

func normalizeLines(t *testing.T, lines []string) []normalizedEvent {
	t.Helper()
	normalizer := newNormalizer()
	events := make([]normalizedEvent, 0)
	for _, line := range lines {
		event, err := parseStreamEvent([]byte(line))
		if err != nil {
			t.Fatalf("parse fixture line: %v", err)
		}
		events = append(events, normalizer.normalize(event)...)
	}
	return events
}

func assertAgentEventTypes(t *testing.T, events []normalizedEvent, want []string) {
	t.Helper()
	got := make([]string, 0, len(events))
	for _, event := range events {
		got = append(got, event.Event.Type)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected event types %#v, got %#v", want, got)
	}
}

func assertTerminalCount(t *testing.T, events []normalizedEvent, want int) {
	t.Helper()
	got := 0
	for _, event := range events {
		if event.Terminal != terminalNone {
			got++
		}
	}
	if got != want {
		t.Fatalf("expected %d terminal events, got %d", want, got)
	}
}

func fakeClaudeAgent(t *testing.T) *Agent {
	t.Helper()
	return New(
		WithBinary(os.Args[0]),
		WithVersionChecker(func(context.Context, string) (string, error) {
			return "2.1.128", nil
		}),
	)
}

type eventRecorder struct {
	mu     sync.Mutex
	events []normalizedEvent
}

func newEventRecorder() *eventRecorder {
	return &eventRecorder{}
}

func (r *eventRecorder) emit(_ context.Context, event agents.AgentEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, normalizedEvent{Event: event})
	return nil
}

func (r *eventRecorder) snapshot() []normalizedEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]normalizedEvent(nil), r.events...)
}

func runFakeClaude() {
	encoder := json.NewEncoder(os.Stdout)
	_ = encoder.Encode(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "session_fake",
	})
	_ = encoder.Encode(map[string]any{
		"type":       "stream_event",
		"session_id": "session_fake",
		"event": map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id":    "msg_fake",
				"model": "claude-test",
			},
		},
	})
	_ = encoder.Encode(map[string]any{
		"type":       "stream_event",
		"session_id": "session_fake",
		"event": map[string]any{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]any{
				"type": "text_delta",
				"text": "Hello",
			},
		},
	})
	_ = encoder.Encode(map[string]any{
		"type":       "assistant",
		"session_id": "session_fake",
		"message": map[string]any{
			"id":    "msg_fake",
			"model": "claude-test",
			"content": []map[string]any{
				{"type": "text", "text": "Hello"},
			},
		},
	})
	_ = encoder.Encode(map[string]any{
		"type":       "result",
		"subtype":    "success",
		"is_error":   false,
		"result":     "Hello",
		"session_id": "session_fake",
	})
}
