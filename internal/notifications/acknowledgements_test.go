package notifications

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

func TestForegroundAcknowledgementOnlySuppressesExactDeviceAndEvent(t *testing.T) {
	for _, eventType := range []string{"agent.run.completed", "agent.run.failed", "agent.run.cancelled", "agent.permission.requested"} {
		t.Run(eventType, func(t *testing.T) {
			ctx := context.Background()
			fakeStore := &memoryStore{
				keys:          store.NotificationKeys{PublicKey: "public", PrivateKey: "private"},
				session:       store.Session{ID: "sess_1", Title: "Example"},
				subscriptions: []store.PushSubscription{{Endpoint: "phone"}, {Endpoint: "tablet"}},
			}
			sender := &recordingSender{}
			service := NewService(fakeStore, WithSender(sender))
			service.foregroundGrace = 0
			for range 2 {
				if err := service.Acknowledge(ctx, "phone", "sess_1", 8); err != nil {
					t.Fatal(err)
				}
			}
			notify := func(sessionID string, seq int64) {
				event := store.Event{SessionID: sessionID, Seq: seq, Type: eventType}
				if eventType == "agent.permission.requested" {
					service.notifyPermissionEvent(ctx, event)
				} else {
					service.notifyTerminalEvent(ctx, event)
				}
			}
			notify("sess_1", 8)
			if len(fakeStore.attempts) != 1 || fakeStore.attempts[0].EndpointHash != endpointFingerprint("tablet") {
				t.Fatalf("only the other device should receive push: %+v", fakeStore.attempts)
			}
			if len(fakeStore.attention) != 1 {
				t.Fatal("delivery to the other device must still record attention")
			}
			notify("sess_1", 9)
			notify("sess_2", 8)
			if len(sender.payloads) != 5 {
				t.Fatalf("different sequence and session must still notify both devices; got %d pushes", len(sender.payloads))
			}
		})
	}
}

func TestAcknowledgedEventDoesNotCreateDeliveryOrAttention(t *testing.T) {
	ctx := context.Background()
	fakeStore := &memoryStore{
		keys:          store.NotificationKeys{PublicKey: "public", PrivateKey: "private"},
		subscriptions: []store.PushSubscription{{Endpoint: "phone"}},
	}
	sender := &recordingSender{}
	service := NewService(fakeStore, WithSender(sender))
	service.foregroundGrace = 0
	if err := service.Acknowledge(ctx, "phone", "sess_1", 8); err != nil {
		t.Fatal(err)
	}
	if err := service.sendToActiveSubscriptions(ctx, notificationInput{SessionID: "sess_1", Seq: 8}); err != nil {
		t.Fatal(err)
	}
	if len(sender.payloads)+len(fakeStore.attempts)+len(fakeStore.attention) != 0 {
		t.Fatal("an already-viewed event should not send or manufacture notification attention")
	}
	if err := service.SendTest(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sender.payloads) != 1 {
		t.Fatal("explicit test notifications must remain available")
	}
}

func TestAcknowledgementValidation(t *testing.T) {
	service := NewService(&memoryStore{subscriptions: []store.PushSubscription{{Endpoint: "phone"}}})
	for _, input := range []acknowledgementKey{
		{"", "sess_1", 1}, {"unknown", "sess_1", 1}, {"phone", "", 1},
		{"phone", "sess_1", 0}, {"phone", "sess_1", -1},
		{strings.Repeat("x", 4097), "sess_1", 1}, {"phone", strings.Repeat("x", 129), 1},
	} {
		if err := service.Acknowledge(context.Background(), input.endpoint, input.sessionID, input.seq); !errors.Is(err, store.ErrInvalidArgument) {
			t.Fatalf("expected invalid argument for %+v, got %v", input, err)
		}
	}
	if len(service.foregroundAcks) != 0 {
		t.Fatal("invalid ACKs must not change notification delivery")
	}
}

func TestAcknowledgementsExpireAndStayBounded(t *testing.T) {
	service := NewService(&memoryStore{subscriptions: []store.PushSubscription{{Endpoint: "phone"}}})
	for seq := int64(1); seq <= maxForegroundAcks+10; seq++ {
		if err := service.Acknowledge(context.Background(), "phone", "sess_1", seq); err != nil {
			t.Fatal(err)
		}
	}
	if len(service.foregroundAcks) != maxForegroundAcks {
		t.Fatalf("ACK cache is not bounded: %d", len(service.foregroundAcks))
	}
	if service.acknowledged("phone", "sess_1", 1, time.Now()) {
		t.Fatal("oldest entry should have been evicted")
	}
	if !service.acknowledged("phone", "sess_1", maxForegroundAcks+10, time.Now()) {
		t.Fatal("newest entry should be retained")
	}
	if err := service.Acknowledge(context.Background(), "phone", "sess_1", maxForegroundAcks+10); err != nil {
		t.Fatal(err)
	}
	if len(service.foregroundAcks) != maxForegroundAcks {
		t.Fatal("repeated ACK should not evict an unrelated entry")
	}
	if service.acknowledged("phone", "sess_1", maxForegroundAcks+10, time.Now().Add(foregroundAckTTL)) || len(service.foregroundAcks) != 0 {
		t.Fatal("expired ACKs must not silence later delivery")
	}
}

func TestForegroundGraceAcceptsAcknowledgementBeforeDelivery(t *testing.T) {
	ctx := context.Background()
	fakeStore := &acknowledgementBarrierStore{
		memoryStore: &memoryStore{
			keys:          store.NotificationKeys{PublicKey: "public", PrivateKey: "private"},
			subscriptions: []store.PushSubscription{{Endpoint: "phone"}},
		},
		listed: make(chan struct{}),
	}
	sender := &recordingSender{}
	service := NewService(fakeStore, WithSender(sender))
	done := make(chan error, 1)
	go func() {
		done <- service.sendToActiveSubscriptions(ctx, notificationInput{SessionID: "sess_1", Seq: 8})
	}()
	<-fakeStore.listed
	if err := service.Acknowledge(ctx, "phone", "sess_1", 8); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(sender.payloads) != 0 {
		t.Fatal("foreground ACK arriving during grace should stop delivery")
	}
}

func TestCancelledForegroundGraceDoesNotSend(t *testing.T) {
	sender := &recordingSender{}
	service := NewService(&memoryStore{
		keys:          store.NotificationKeys{PublicKey: "public", PrivateKey: "private"},
		subscriptions: []store.PushSubscription{{Endpoint: "phone"}},
	}, WithSender(sender))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.sendToActiveSubscriptions(ctx, notificationInput{SessionID: "sess_1", Seq: 8}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if len(sender.payloads) != 0 {
		t.Fatal("shutdown must not send a pending push")
	}
}

func TestConcurrentForegroundAcknowledgements(t *testing.T) {
	service := NewService(&memoryStore{subscriptions: []store.PushSubscription{{Endpoint: "phone"}}})
	var workers sync.WaitGroup
	for worker := range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for n := range 30 {
				seq := int64(worker*30 + n + 1)
				if err := service.Acknowledge(context.Background(), "phone", "sess_1", seq); err != nil {
					t.Error(err)
				}
				if !service.acknowledged("phone", "sess_1", seq, time.Now()) {
					t.Error("missing concurrent ACK")
				}
			}
		}()
	}
	workers.Wait()
}

type acknowledgementBarrierStore struct {
	*memoryStore
	listed chan struct{}
	once   sync.Once
}

func (s *acknowledgementBarrierStore) ListPushSubscriptions(ctx context.Context) ([]store.PushSubscription, error) {
	s.once.Do(func() { close(s.listed) })
	return s.memoryStore.ListPushSubscriptions(ctx)
}
