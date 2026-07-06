package notifications

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

func TestServiceSendsTerminalRunNotifications(t *testing.T) {
	ctx := context.Background()
	fakeStore := &memoryStore{
		keys: store.NotificationKeys{
			PublicKey:  "public",
			PrivateKey: "private",
		},
		session: store.Session{ID: "sess_1", Title: "Build release"},
		recentEvents: []store.Event{
			{Type: "agent.message.completed", Payload: []byte(`{"text":"The release build is complete and ready to verify."}`)},
		},
		subscriptions: []store.PushSubscription{
			{Endpoint: "endpoint-1", P256DH: "p256dh", Auth: "auth", Origin: "https://example.test"},
		},
	}
	sender := &recordingSender{responses: []*http.Response{testResponse(http.StatusCreated)}}
	service := NewService(fakeStore, WithSender(sender))

	service.notifyTerminalEvent(ctx, store.Event{
		SessionID: "sess_1",
		Seq:       8,
		Type:      "agent.run.completed",
		Status:    store.EventStatusCompleted,
	})

	if len(sender.payloads) != 1 {
		t.Fatalf("expected one push notification, got %d", len(sender.payloads))
	}
	if !bytes.Contains(sender.payloads[0], []byte(`"title":"Completed"`)) {
		t.Fatalf("expected completion title in payload, got %s", sender.payloads[0])
	}
	if !bytes.Contains(sender.payloads[0], []byte(`"web_push":8030`)) {
		t.Fatalf("expected declarative web push marker in payload, got %s", sender.payloads[0])
	}
	if !bytes.Contains(sender.payloads[0], []byte(`"navigate":"https://example.test/sessions/sess_1?notification_seq=8"`)) {
		t.Fatalf("expected absolute declarative navigate URL in payload, got %s", sender.payloads[0])
	}
	if !bytes.Contains(sender.payloads[0], []byte(`"seq":8`)) {
		t.Fatalf("expected terminal seq in payload, got %s", sender.payloads[0])
	}
	if !bytes.Contains(sender.payloads[0], []byte("Build release: The release build is complete")) {
		t.Fatalf("expected response excerpt in payload, got %s", sender.payloads[0])
	}
	if len(fakeStore.attempts) != 1 || fakeStore.attempts[0].HTTPStatus != http.StatusCreated {
		t.Fatalf("expected recorded delivery attempt, got %#v", fakeStore.attempts)
	}
}

func TestServiceDisablesGoneSubscriptions(t *testing.T) {
	ctx := context.Background()
	fakeStore := &memoryStore{
		keys: store.NotificationKeys{
			PublicKey:  "public",
			PrivateKey: "private",
		},
		subscriptions: []store.PushSubscription{
			{Endpoint: "endpoint-1", P256DH: "p256dh", Auth: "auth"},
		},
	}
	sender := &recordingSender{responses: []*http.Response{testResponse(http.StatusGone)}}
	service := NewService(fakeStore, WithSender(sender))

	if err := service.SendTest(ctx); err != nil {
		t.Fatalf("send test: %v", err)
	}

	if len(fakeStore.disabled) != 1 || fakeStore.disabled[0].Endpoint != "endpoint-1" {
		t.Fatalf("expected stale subscription disabled, got %#v", fakeStore.disabled)
	}
}

func TestServiceIgnoresNonTerminalEvents(t *testing.T) {
	fakeStore := &memoryStore{}
	sender := &recordingSender{}
	service := NewService(fakeStore, WithSender(sender))
	source := newMemoryEventSource()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	service.Start(ctx, source)
	source.events <- store.Event{SessionID: "sess_1", Type: "agent.message.delta", Status: store.EventStatusDelta}
	time.Sleep(20 * time.Millisecond)

	if len(sender.payloads) != 0 {
		t.Fatalf("expected no push notifications, got %d", len(sender.payloads))
	}
}

type memoryStore struct {
	keys          store.NotificationKeys
	session       store.Session
	recentEvents  []store.Event
	subscriptions []store.PushSubscription
	disabled      []store.DisablePushSubscriptionParams
	attempts      []store.RecordPushDeliveryAttemptParams
}

func (s *memoryStore) GetNotificationKeys(context.Context) (store.NotificationKeys, error) {
	if s.keys.PublicKey == "" {
		return store.NotificationKeys{}, store.ErrNotFound
	}
	return s.keys, nil
}

func (s *memoryStore) SetNotificationKeys(_ context.Context, params store.SetNotificationKeysParams) (store.NotificationKeys, error) {
	s.keys = store.NotificationKeys{PublicKey: params.PublicKey, PrivateKey: params.PrivateKey}
	return s.keys, nil
}

func (s *memoryStore) SavePushSubscription(_ context.Context, params store.SavePushSubscriptionParams) (store.PushSubscription, error) {
	subscription := store.PushSubscription{
		Endpoint:  params.Endpoint,
		P256DH:    params.P256DH,
		Auth:      params.Auth,
		UserAgent: params.UserAgent,
		Origin:    params.Origin,
	}
	s.subscriptions = append(s.subscriptions, subscription)
	return subscription, nil
}

func (s *memoryStore) DeletePushSubscription(context.Context, string) error {
	return nil
}

func (s *memoryStore) DisablePushSubscription(_ context.Context, params store.DisablePushSubscriptionParams) error {
	s.disabled = append(s.disabled, params)
	return nil
}

func (s *memoryStore) ListPushSubscriptions(context.Context) ([]store.PushSubscription, error) {
	return s.subscriptions, nil
}

func (s *memoryStore) RecordPushDeliveryAttempt(_ context.Context, params store.RecordPushDeliveryAttemptParams) (store.PushDeliveryAttempt, error) {
	s.attempts = append(s.attempts, params)
	return store.PushDeliveryAttempt{
		ID:             int64(len(s.attempts)),
		EndpointHash:   params.EndpointHash,
		Origin:         params.Origin,
		PayloadKind:    params.PayloadKind,
		SessionID:      params.SessionID,
		EventType:      params.EventType,
		HTTPStatus:     params.HTTPStatus,
		ResponseStatus: params.ResponseStatus,
		Error:          params.Error,
		CreatedAt:      time.Now(),
	}, nil
}

func (s *memoryStore) ListPushDeliveryAttempts(context.Context, int) ([]store.PushDeliveryAttempt, error) {
	attempts := make([]store.PushDeliveryAttempt, 0, len(s.attempts))
	for index, attempt := range s.attempts {
		attempts = append(attempts, store.PushDeliveryAttempt{
			ID:             int64(index + 1),
			EndpointHash:   attempt.EndpointHash,
			Origin:         attempt.Origin,
			PayloadKind:    attempt.PayloadKind,
			SessionID:      attempt.SessionID,
			EventType:      attempt.EventType,
			HTTPStatus:     attempt.HTTPStatus,
			ResponseStatus: attempt.ResponseStatus,
			Error:          attempt.Error,
			CreatedAt:      time.Now(),
		})
	}
	return attempts, nil
}

func (s *memoryStore) GetSession(context.Context, string) (store.Session, error) {
	return s.session, nil
}

func (s *memoryStore) ListRecentEvents(context.Context, string, int) ([]store.Event, error) {
	return s.recentEvents, nil
}

type recordingSender struct {
	responses []*http.Response
	payloads  [][]byte
}

func (s *recordingSender) Send(_ context.Context, _ store.NotificationKeys, _ store.PushSubscription, payload []byte) (*http.Response, error) {
	s.payloads = append(s.payloads, append([]byte(nil), payload...))
	if len(s.responses) == 0 {
		return testResponse(http.StatusCreated), nil
	}
	response := s.responses[0]
	s.responses = s.responses[1:]
	return response, nil
}

type memoryEventSource struct {
	events chan store.Event
}

func newMemoryEventSource() *memoryEventSource {
	return &memoryEventSource{events: make(chan store.Event, 1)}
}

func (s *memoryEventSource) SubscribeAll() (<-chan store.Event, func()) {
	return s.events, func() {}
}

func testResponse(statusCode int) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Status:     http.StatusText(statusCode),
		Body:       io.NopCloser(bytes.NewReader(nil)),
	}
}
