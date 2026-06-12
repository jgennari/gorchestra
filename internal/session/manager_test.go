package session

import (
	"context"
	"errors"
	"testing"
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
