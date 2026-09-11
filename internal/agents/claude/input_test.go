package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
)

const questionFixture = `{"questions":[{"question":"Which sections?","header":"Sections","options":[{"label":"Summary","description":"Overview"},{"label":"Tests","description":"Validation"}],"multiSelect":true},{"question":" Output format? ","header":"Format","options":[{"label":"Text"},{"label":"JSON"}],"multiSelect":false}],"metadata":{"source":"fixture"}}`

func runFakeClaudeControl(scenario string, decoder *json.Decoder, encoder *json.Encoder) {
	var input map[string]any
	_ = json.Unmarshal([]byte(questionFixture), &input)
	tool := "AskUserQuestion"
	if scenario == "permission" {
		tool = "Bash"
		input = map[string]any{"command": "pwd"}
	}
	_ = encoder.Encode(map[string]any{"type": "control_request", "request_id": "control_test", "request": map[string]any{
		"subtype": "can_use_tool", "tool_name": tool, "tool_use_id": "tool_test", "input": input,
		"permission_suggestions": []any{map[string]any{"type": "addRules", "destination": "userSettings"}},
	}})
	// The parent waits for this event before answering, proving that questions
	// do not block stream consumption.
	_ = encoder.Encode(map[string]any{"type": "system", "subtype": "status", "status": "question_pending"})
	switch scenario {
	case "withdraw":
		_ = encoder.Encode(map[string]any{"type": "control_cancel_request", "request_id": "control_test"})
		return
	case "crash":
		os.Exit(12)
	case "terminal":
		return
	}
	var response map[string]any
	if decoder.Decode(&response) != nil {
		os.Exit(22)
	}
	if capture := os.Getenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE"); capture != "" {
		data, _ := json.Marshal(response)
		_ = os.WriteFile(capture+".response", data, 0600)
	}
}

type questionBroker struct {
	opened  chan agents.UserInputRequest
	answers chan agents.UserInputResponse
	closed  chan struct{}
	once    sync.Once
}

func newQuestionBroker() *questionBroker {
	return &questionBroker{opened: make(chan agents.UserInputRequest, 1), answers: make(chan agents.UserInputResponse, 1), closed: make(chan struct{})}
}

func (b *questionBroker) OpenUserInput(_ context.Context, request agents.UserInputRequest) (agents.UserInputWaiter, error) {
	b.opened <- request
	return b, nil
}

func (b *questionBroker) Wait(ctx context.Context) (agents.UserInputResponse, error) {
	select {
	case answer := <-b.answers:
		return answer, nil
	case <-ctx.Done():
		return agents.UserInputResponse{}, ctx.Err()
	}
}

func (b *questionBroker) Close() { b.once.Do(func() { close(b.closed) }) }

func TestClaudeQuestionRoundTripInPlanMode(t *testing.T) {
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", "question")
	capture := filepath.Join(t.TempDir(), "input.json")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE", capture)
	broker := newQuestionBroker()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	recorder := newEventRecorder()
	streamed := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- fakeClaudeAgent(t).Run(ctx, agents.AgentInput{
			SessionID: "sess_test", Message: "Plan this", ProviderSessionID: "resume_me", UserInput: broker,
			Metadata: map[string]any{"claude_options": map[string]any{"permission_mode": "plan", "permission_policy": "ask"}},
		}, func(ctx context.Context, event agents.AgentEvent) error {
			if payload, ok := event.Payload.(map[string]any); ok && payload["status"] == "question_pending" {
				streamed <- struct{}{}
			}
			return recorder.emit(ctx, event)
		})
	}()
	var request agents.UserInputRequest
	select {
	case request = <-broker.opened:
	case <-ctx.Done():
		t.Fatal("question did not open")
	}
	if request.Provider != Type || request.ItemID != "tool_test" || len(request.Questions) != 2 || !request.Questions[0].MultiSelect || !request.Questions[1].IsOther {
		t.Fatalf("unexpected question: %#v", request)
	}
	select {
	case <-streamed:
	case <-ctx.Done():
		t.Fatal("question blocked stdout")
	}
	broker.answers <- agents.UserInputResponse{Answers: map[string]agents.UserInputQuestionAnswer{
		"question_1": {Answers: []string{"Summary", "Tests"}}, "question_2": {Answers: []string{"Custom format"}},
	}}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	response := capturedControlResponse(t, capture)
	if response["behavior"] != "allow" {
		t.Fatalf("unexpected response: %#v", response)
	}
	updated := response["updatedInput"].(map[string]any)
	if !reflect.DeepEqual(updated["answers"], map[string]any{"Which sections?": "Summary, Tests", " Output format? ": "Custom format"}) || updated["metadata"] == nil || len(updated["questions"].([]any)) != 2 {
		t.Fatalf("question input or answer mapping lost: %#v", updated)
	}
	for _, event := range recorder.snapshot() {
		if event.Event.Type == "agent.permission.requested" {
			t.Fatal("question became a permission prompt")
		}
	}
	select {
	case <-broker.closed:
	default:
		t.Fatal("question waiter leaked")
	}
}

func TestClaudeQuestionCleanup(t *testing.T) {
	for _, scenario := range []string{"withdraw", "crash", "terminal", "stop"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", scenario)
			broker := newQuestionBroker()
			agent := fakeClaudeAgent(t)
			agent.interruptGrace = 20 * time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			recorder := newEventRecorder()
			done := make(chan error, 1)
			go func() {
				done <- agent.Run(ctx, agents.AgentInput{SessionID: "sess_test", Message: "ask", UserInput: broker}, recorder.emit)
			}()
			select {
			case <-broker.opened:
			case <-ctx.Done():
				t.Fatal("question did not open")
			}
			if scenario == "stop" {
				cancel()
			}
			err := <-done
			if scenario == "stop" && !errors.Is(err, context.Canceled) {
				t.Fatalf("stop: %v", err)
			}
			if scenario == "crash" && (err == nil || !strings.Contains(err.Error(), "exited before terminal")) {
				t.Fatalf("crash: %v", err)
			}
			if (scenario == "withdraw" || scenario == "terminal") && err != nil {
				t.Fatal(err)
			}
			select {
			case <-broker.closed:
			default:
				t.Fatal("question waiter leaked")
			}
			if scenario == "withdraw" {
				found := false
				for _, event := range recorder.snapshot() {
					found = found || event.Event.Type == "agent.input.cancelled"
				}
				if !found {
					t.Fatal("withdrawal was not persisted as an event")
				}
			}
		})
	}
}

func TestClaudeMissingQuestionBrokerDeniesWithoutHanging(t *testing.T) {
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", "question")
	capture := filepath.Join(t.TempDir(), "input.json")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE", capture)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	recorder := newEventRecorder()
	if err := fakeClaudeAgent(t).Run(ctx, agents.AgentInput{Message: "ask"}, recorder.emit); err != nil {
		t.Fatal(err)
	}
	if capturedControlResponse(t, capture)["behavior"] != "deny" {
		t.Fatal("missing broker must deny")
	}
	for _, event := range recorder.snapshot() {
		if event.Event.Type == "agent.input.requested" {
			t.Fatal("unanswerable card emitted")
		}
	}
}

func TestClaudeImagesUseStdinInEveryPermissionMode(t *testing.T) {
	for _, policy := range []string{"ask", "deny", "bypass"} {
		t.Run(policy, func(t *testing.T) {
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
			capture := filepath.Join(t.TempDir(), "input.json")
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE", capture)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			attachment := agents.Attachment{MediaType: "image/png", DataURL: "data:image/png;base64,aW1hZ2U="}
			if err := fakeClaudeAgent(t).Run(ctx, agents.AgentInput{
				Skills:  []agents.SkillReference{{Name: "review", Path: "/repo with spaces/.claude/skills/review/SKILL.md"}},
				Message: "inspect", Context: "Runtime context", Attachments: []agents.Attachment{attachment, attachment},
				Metadata: map[string]any{"claude_options": map[string]any{"permission_policy": policy}},
			}, newEventRecorder().emit); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var user struct {
				Message struct {
					Content []struct {
						Type   string
						Text   string
						Source map[string]any
					}
				}
			}
			if err := json.Unmarshal(data, &user); err != nil {
				t.Fatal(err)
			}
			blocks := user.Message.Content
			if len(blocks) != 3 || blocks[0].Type != "text" || !strings.Contains(blocks[0].Text, "Runtime context") || !strings.Contains(blocks[0].Text, "/repo with spaces/.claude/skills/review/SKILL.md") || !strings.Contains(blocks[0].Text, "Use each selected skill") || blocks[1].Type != "image" || blocks[2].Source["data"] != "aW1hZ2U=" || blocks[2].Source["media_type"] != "image/png" {
				t.Fatalf("invalid content blocks: %s", data)
			}
		})
	}
}

func TestClaudeImageContentValidation(t *testing.T) {
	for _, attachment := range []agents.Attachment{
		{MediaType: "image/svg+xml", DataURL: "data:image/svg+xml;base64,aW1hZ2U="},
		{MediaType: "image/png", DataURL: "data:image/jpeg;base64,aW1hZ2U="},
		{MediaType: "image/png", DataURL: "https://example.com/image.png"},
		{MediaType: "image/png", DataURL: "data:image/png;base64,invalid!"},
		{MediaType: "image/png", DataURL: "data:image/png;base64,"},
	} {
		if _, err := userMessageContent("", []agents.Attachment{attachment}); err == nil {
			t.Fatalf("accepted invalid attachment %#v", attachment)
		}
	}
	content, err := userMessageContent("", []agents.Attachment{{MediaType: "image/webp", DataURL: "data:image/webp;base64,aW1hZ2U="}})
	if err != nil || len(content.([]map[string]any)) != 1 {
		t.Fatalf("image-only prompt: %#v %v", content, err)
	}
}

func TestClaudeRejectsAmbiguousQuestionInput(t *testing.T) {
	for _, raw := range []string{`{}`, `{"questions":[]}`, `{"questions":[{"question":""}]}`, `{"questions":[{"question":"same"},{"question":"same"}]}`, `{"questions":[{"question":"Pick","options":[{"label":"same"},{"label":"same"}]}]}`} {
		var input map[string]any
		_ = json.Unmarshal([]byte(raw), &input)
		if _, err := claudeQuestions(input); err == nil {
			t.Fatalf("accepted malformed question %s", raw)
		}
	}
}

func capturedControlResponse(t *testing.T, capture string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(capture + ".response")
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Type     string
		Response struct {
			Subtype   string
			RequestID string `json:"request_id"`
			Response  map[string]any
		}
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Type != "control_response" || envelope.Response.Subtype != "success" || envelope.Response.RequestID != "control_test" {
		t.Fatalf("invalid envelope: %s", data)
	}
	return envelope.Response.Response
}

type permissionBroker struct {
	calls  int
	option string
}

func (b *permissionBroker) OpenPermission(_ context.Context, _ agents.PermissionRequest) (agents.PermissionWaiter, error) {
	b.calls++
	return b, nil
}
func (b *permissionBroker) Wait(context.Context) (agents.PermissionResponse, error) {
	return agents.PermissionResponse{OptionID: b.option}, nil
}
func (b *permissionBroker) Close() {}

func TestClaudeStreamingPreservesPermissionDecisions(t *testing.T) {
	for _, test := range []struct {
		policy, mode, option, behavior string
		prompted                       bool
	}{
		{"ask", "", "allow-once", "allow", true},
		{"ask", "plan", "allow-session", "allow", true},
		{"ask", "", "deny", "deny", true},
		{"ask", "", "cancel", "deny", true},
		{"deny", "", "allow-once", "deny", false},
		{"bypass", "", "allow-once", "deny", false},
		{"bypass", "plan", "allow-once", "deny", false},
	} {
		t.Run(test.policy+test.mode+test.option, func(t *testing.T) {
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", "permission")
			capture := filepath.Join(t.TempDir(), "input.json")
			t.Setenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE", capture)
			broker := &permissionBroker{option: test.option}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := fakeClaudeAgent(t).Run(ctx, agents.AgentInput{Message: "check", Permissions: broker,
				Metadata: map[string]any{"claude_options": map[string]any{"permission_policy": test.policy, "permission_mode": test.mode}},
			}, newEventRecorder().emit)
			if err != nil {
				t.Fatal(err)
			}
			if (broker.calls == 1) != test.prompted {
				t.Fatalf("permission prompt count %d", broker.calls)
			}
			response := capturedControlResponse(t, capture)
			if response["behavior"] != test.behavior {
				t.Fatalf("wrong decision: %#v", response)
			}
			if test.behavior == "allow" && response["updatedInput"].(map[string]any)["command"] != "pwd" {
				t.Fatal("tool input changed")
			}
			if test.option == "allow-session" && test.prompted {
				updates := response["updatedPermissions"].([]any)
				if updates[0].(map[string]any)["destination"] != "session" {
					t.Fatal("permission escaped session scope")
				}
			}
			if test.option == "cancel" && response["interrupt"] != true {
				t.Fatal("stop did not interrupt")
			}
		})
	}
}

func TestClaudeQuestionPersistenceFailureClosesWaiter(t *testing.T) {
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", "question")
	capture := filepath.Join(t.TempDir(), "input.json")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CAPTURE", capture)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	broker := newQuestionBroker()
	persistenceError := errors.New("event persistence failed")
	err := fakeClaudeAgent(t).Run(ctx, agents.AgentInput{Message: "ask", UserInput: broker}, func(_ context.Context, event agents.AgentEvent) error {
		if event.Type == "agent.input.requested" {
			return persistenceError
		}
		return nil
	})
	if !errors.Is(err, persistenceError) {
		t.Fatalf("lost persistence failure: %v", err)
	}
	select {
	case <-broker.closed:
	default:
		t.Fatal("question waiter leaked")
	}
	if _, err := os.Stat(capture + ".response"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("response sent before question persistence")
	}
}

func TestClaudeCancellationUnblocksLargeImageWrite(t *testing.T) {
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_STREAM", "1")
	t.Setenv("GORCHESTRA_FAKE_CLAUDE_CONTROL", "ignore_stdin")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	err := fakeClaudeAgent(t).Run(ctx, agents.AgentInput{Message: "inspect", Attachments: []agents.Attachment{{MediaType: "image/png", DataURL: "data:image/png;base64," + strings.Repeat("aW1n", 300000)}}}, newEventRecorder().emit)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked stdin cancellation: %v", err)
	}
}
