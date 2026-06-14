package session

import (
	"context"
	"errors"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestManagerRegistersAndCleansUpRun(t *testing.T) {
	manager := NewManager()

	ctx, cleanup, err := manager.Register(context.Background(), "sess_one")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	if !manager.Active("sess_one") {
		t.Fatal("expected run to be active")
	}
	if err := ctx.Err(); err != nil {
		t.Fatalf("expected active context, got %v", err)
	}

	cleanup()
	cleanup()

	if manager.Active("sess_one") {
		t.Fatal("expected run to be cleaned up")
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("expected context canceled after cleanup, got %v", ctx.Err())
	}
}

func TestManagerRejectsDuplicateRegistration(t *testing.T) {
	manager := NewManager()
	_, cleanup, err := manager.Register(context.Background(), "sess_one")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	defer cleanup()

	_, _, err = manager.Register(context.Background(), "sess_one")
	if !errors.Is(err, ErrRunAlreadyActive) {
		t.Fatalf("expected ErrRunAlreadyActive, got %v", err)
	}
}

func TestManagerCancelsRunOnce(t *testing.T) {
	manager := NewManager()
	ctx, cleanup, err := manager.Register(context.Background(), "sess_one")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	defer cleanup()

	if err := manager.Cancel("sess_one"); err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("expected canceled context, got %v", ctx.Err())
	}

	err = manager.Cancel("sess_one")
	if !errors.Is(err, ErrRunAlreadyCanceled) {
		t.Fatalf("expected ErrRunAlreadyCanceled, got %v", err)
	}
}

func TestManagerCancelMissingRun(t *testing.T) {
	manager := NewManager()

	err := manager.Cancel("sess_missing")
	if !errors.Is(err, ErrRunNotActive) {
		t.Fatalf("expected ErrRunNotActive, got %v", err)
	}
}

func TestManagerAnswersUserInputRequest(t *testing.T) {
	manager := NewManager()
	ctx, cleanup, err := manager.Register(context.Background(), "sess_test")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	defer cleanup()

	waiter, err := manager.OpenUserInput(ctx, agents.UserInputRequest{
		SessionID: "sess_test",
		RequestID: "call_test",
		Questions: []agents.UserInputQuestion{
			{ID: "question_test", Question: "Pick one"},
		},
	})
	if err != nil {
		t.Fatalf("open user input: %v", err)
	}
	defer waiter.Close()

	pending, err := manager.PendingUserInput("sess_test", "call_test")
	if err != nil {
		t.Fatalf("pending user input: %v", err)
	}
	if pending.Questions[0].ID != "question_test" {
		t.Fatalf("unexpected pending request %#v", pending)
	}

	response := agents.UserInputResponse{
		Answers: map[string]agents.UserInputQuestionAnswer{
			"question_test": {Answers: []string{"A"}},
		},
	}
	if err := manager.AnswerUserInput("sess_test", "call_test", response); err != nil {
		t.Fatalf("answer user input: %v", err)
	}

	got, err := waiter.Wait(ctx)
	if err != nil {
		t.Fatalf("wait user input: %v", err)
	}
	if got.Answers["question_test"].Answers[0] != "A" {
		t.Fatalf("unexpected answer %#v", got)
	}
	if _, err := manager.PendingUserInput("sess_test", "call_test"); !errors.Is(err, ErrUserInputNotActive) {
		t.Fatalf("expected ErrUserInputNotActive after answer, got %v", err)
	}
}

func TestManagerUserInputWaitReturnsContextError(t *testing.T) {
	manager := NewManager()
	ctx, cleanup, err := manager.Register(context.Background(), "sess_test")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	defer cleanup()

	waiter, err := manager.OpenUserInput(ctx, agents.UserInputRequest{
		SessionID: "sess_test",
		RequestID: "call_test",
	})
	if err != nil {
		t.Fatalf("open user input: %v", err)
	}
	defer waiter.Close()

	waitCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := waiter.Wait(waitCtx); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}
