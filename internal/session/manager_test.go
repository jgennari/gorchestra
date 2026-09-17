package session

import (
	"context"
	"errors"
	"testing"
	"time"

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

	cancellation := Cancellation{Source: "web_ui", Reason: "stop_button"}
	if err := manager.Cancel("sess_one", cancellation); err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("expected canceled context, got %v", ctx.Err())
	}

	got, ok := manager.Cancellation("sess_one")
	if !ok || got != cancellation {
		t.Fatalf("expected cancellation %#v, got %#v, %t", cancellation, got, ok)
	}

	err = manager.Cancel("sess_one", cancellation)
	if !errors.Is(err, ErrRunAlreadyCanceled) {
		t.Fatalf("expected ErrRunAlreadyCanceled, got %v", err)
	}
}

func TestManagerCancelMissingRun(t *testing.T) {
	manager := NewManager()

	err := manager.Cancel("sess_missing", Cancellation{})
	if !errors.Is(err, ErrRunNotActive) {
		t.Fatalf("expected ErrRunNotActive, got %v", err)
	}
}

func TestManagerCancelRunRejectsStaleRunIdentity(t *testing.T) {
	manager := NewManager()
	ctx, cleanup, err := manager.RegisterRun(context.Background(), "sess_one", "run_new")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err := manager.CancelRun("sess_one", "run_old", Cancellation{}); !errors.Is(err, ErrRunNotActive) {
		t.Fatalf("expected stale identity rejection, got %v", err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("stale cancellation stopped active run")
	default:
	}
	if !manager.ActiveRun("sess_one", "run_new") || manager.ActiveRun("sess_one", "run_old") {
		t.Fatal("active run identity lookup is incorrect")
	}
	if err := manager.CancelRun("sess_one", "run_new", Cancellation{Source: "cli", Reason: "requested"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("exact cancellation did not stop run")
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

func TestManagerResolvesPermissionRequestByStableOptionID(t *testing.T) {
	manager := NewManager()
	ctx, cleanup, err := manager.Register(context.Background(), "sess_test")
	if err != nil {
		t.Fatalf("register run: %v", err)
	}
	defer cleanup()
	waiter, err := manager.OpenPermission(ctx, agents.PermissionRequest{SessionID: "sess_test", RequestID: "perm_test", Options: []agents.PermissionOption{{ID: "allow-session", Decision: "allow", Scope: "session"}}})
	if err != nil {
		t.Fatalf("open permission: %v", err)
	}
	defer waiter.Close()
	pending, err := manager.PendingPermission("sess_test", "perm_test")
	if err != nil || pending.Options[0].ID != "allow-session" {
		t.Fatalf("unexpected pending permission: %#v, %v", pending, err)
	}
	if err := manager.ResolvePermission("sess_test", "perm_test", agents.PermissionResponse{OptionID: "allow-session"}); err != nil {
		t.Fatalf("resolve permission: %v", err)
	}
	response, err := waiter.Wait(ctx)
	if err != nil || response.OptionID != "allow-session" {
		t.Fatalf("unexpected permission response: %#v, %v", response, err)
	}
	if _, err := manager.PendingPermission("sess_test", "perm_test"); !errors.Is(err, ErrPermissionNotActive) {
		t.Fatalf("expected inactive permission, got %v", err)
	}
}
