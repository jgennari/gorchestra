package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestAsyncInputClaimPrecedesPersistenceAndDelivery(t *testing.T) {
	m := NewManager()
	ctx, cleanup, _ := m.Register(context.Background(), "session")
	defer cleanup()
	persisted := false
	delivered := false
	waiter, err := m.OpenAsyncUserInput(ctx, agents.UserInputRequest{SessionID: "session", RequestID: "question"}, func(context.Context, agents.UserInputResponse) error {
		if !persisted {
			t.Error("delivered before persistence")
		}
		delivered = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- m.AnswerUserInputWithPersistence(ctx, "session", "question", agents.UserInputResponse{}, func() error {
			close(entered)
			<-release
			persisted = true
			return nil
		})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no persistence attempt")
	}
	if err := m.AnswerUserInputWithPersistence(ctx, "session", "question", agents.UserInputResponse{}, func() error { t.Error("duplicate was persisted"); return nil }); !errors.Is(err, ErrUserInputNotActive) {
		t.Fatalf("duplicate: %v", err)
	}
	close(release)
	if err := <-done; err != nil || !delivered {
		t.Fatalf("delivery: %v %t", err, delivered)
	}
	if _, err := m.PendingUserInput("session", "question"); !errors.Is(err, ErrUserInputNotActive) {
		t.Fatalf("still pending: %v", err)
	}
}

func TestAsyncInputPersistenceFailureCanRetryButDeliveryFailureCannot(t *testing.T) {
	m := NewManager()
	ctx, cleanup, _ := m.Register(context.Background(), "session")
	defer cleanup()
	attempts := 0
	waiter, err := m.OpenAsyncUserInput(ctx, agents.UserInputRequest{SessionID: "session", RequestID: "question"}, func(context.Context, agents.UserInputResponse) error {
		attempts++
		return errors.New("disconnected after sending")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Close()
	if err := m.AnswerUserInputWithPersistence(ctx, "session", "question", agents.UserInputResponse{}, func() error { return errors.New("disk full") }); err == nil || attempts != 0 {
		t.Fatalf("persist failure: %v %d", err, attempts)
	}
	if _, err := m.PendingUserInput("session", "question"); err != nil {
		t.Fatal(err)
	}
	if err := m.AnswerUserInput("session", "question", agents.UserInputResponse{}); err == nil || attempts != 1 {
		t.Fatalf("delivery failure: %v %d", err, attempts)
	}
	if err := m.AnswerUserInput("session", "question", agents.UserInputResponse{}); !errors.Is(err, ErrUserInputNotActive) || attempts != 1 {
		t.Fatalf("resent uncertain delivery: %v %d", err, attempts)
	}
}

func TestAsyncInputCancellationDuringPersistencePreventsDelivery(t *testing.T) {
	m := NewManager()
	ctx, cleanup, _ := m.Register(context.Background(), "session")
	defer cleanup()
	waiter, err := m.OpenAsyncUserInput(ctx, agents.UserInputRequest{SessionID: "session", RequestID: "question"}, func(context.Context, agents.UserInputResponse) error {
		t.Error("delivered to cancelled run")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Close()
	err = m.AnswerUserInputWithPersistence(ctx, "session", "question", agents.UserInputResponse{}, func() error { return m.Cancel("session", Cancellation{}) })
	if !errors.Is(err, ErrUserInputNotActive) {
		t.Fatalf("cancellation: %v", err)
	}
}
