package session

import (
	"context"
	"errors"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestSteeringIsRunBoundAndPersistsBeforeDelivery(t *testing.T) {
	m := NewManager()
	ctx, cleanup, err := m.Register(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	persisted, delivered := false, 0
	unregister, err := m.RegisterSteering(ctx, "s", "run1", func(_ context.Context, input agents.SteeringInput) error {
		if !persisted || input.Message != "change course" {
			t.Error("delivery preceded persistence or changed text")
		}
		delivered++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unregister()
	persist := func() error { persisted = true; return nil }
	input := agents.SteeringInput{Message: "change course"}
	if err := m.SteerWithPersistence(ctx, "s", "stale", input, persist); !errors.Is(err, ErrSteeringUnavailable) || persisted {
		t.Fatalf("stale target: %v", err)
	}
	if err := m.SteerWithPersistence(ctx, "s", "run1", input, func() error { return errors.New("disk full") }); err == nil || delivered != 0 {
		t.Fatal("failed persistence delivered")
	}
	if err := m.SteerWithPersistence(ctx, "s", "run1", input, persist); err != nil || delivered != 1 {
		t.Fatalf("valid delivery: %v", err)
	}
	// A competing call cannot enter while persistence/delivery is pending.
	if err := m.SteerWithPersistence(ctx, "s", "run1", input, func() error {
		if err := m.SteerWithPersistence(ctx, "s", "run1", input, persist); !errors.Is(err, ErrSteeringUnavailable) {
			t.Errorf("concurrent input: %v", err)
		}
		return m.Cancel("s", Cancellation{})
	}); !errors.Is(err, ErrRunNotActive) || delivered != 1 {
		t.Fatalf("cancel race: %v", err)
	}
	unregister()
	cleanup()
	next, finish, err := m.Register(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	removeNext, err := m.RegisterSteering(next, "s", "run2", func(context.Context, agents.SteeringInput) error { delivered++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer removeNext()
	unregister() // old cleanup cannot remove the new run's handler
	if err := m.SteerWithPersistence(next, "s", "run1", input, persist); !errors.Is(err, ErrSteeringUnavailable) {
		t.Fatalf("steered successor: %v", err)
	}
	if err := m.SteerWithPersistence(next, "s", "run2", input, persist); err != nil || delivered != 2 {
		t.Fatalf("successor handler: %v", err)
	}
}
