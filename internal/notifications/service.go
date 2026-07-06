package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jgennari/gorchestra/internal/store"
)

const (
	defaultSubscriber = "mailto:gorchestra@localhost"
	sendTimeout       = 15 * time.Second
)

type Store interface {
	GetNotificationKeys(ctx context.Context) (store.NotificationKeys, error)
	SetNotificationKeys(ctx context.Context, params store.SetNotificationKeysParams) (store.NotificationKeys, error)
	SavePushSubscription(ctx context.Context, params store.SavePushSubscriptionParams) (store.PushSubscription, error)
	DeletePushSubscription(ctx context.Context, endpoint string) error
	DisablePushSubscription(ctx context.Context, params store.DisablePushSubscriptionParams) error
	ListPushSubscriptions(ctx context.Context) ([]store.PushSubscription, error)
	GetSession(ctx context.Context, id string) (store.Session, error)
}

type EventSource interface {
	SubscribeAll() (<-chan store.Event, func())
}

type SubscriptionInput struct {
	Endpoint  string
	P256DH    string
	Auth      string
	UserAgent string
}

type Sender interface {
	Send(ctx context.Context, keys store.NotificationKeys, subscription store.PushSubscription, payload []byte) (*http.Response, error)
}

type Service struct {
	store      Store
	sender     Sender
	subscriber string
	logger     *log.Logger
}

type Option func(*Service)

func WithSender(sender Sender) Option {
	return func(s *Service) {
		if sender != nil {
			s.sender = sender
		}
	}
}

func WithLogger(logger *log.Logger) Option {
	return func(s *Service) {
		if logger != nil {
			s.logger = logger
		}
	}
}

func WithSubscriber(subscriber string) Option {
	return func(s *Service) {
		if strings.TrimSpace(subscriber) != "" {
			s.subscriber = strings.TrimSpace(subscriber)
		}
	}
}

func NewService(store Store, opts ...Option) *Service {
	service := &Service{
		store:      store,
		sender:     webPushSender{subscriber: defaultSubscriber},
		subscriber: defaultSubscriber,
		logger:     log.Default(),
	}
	for _, opt := range opts {
		opt(service)
	}
	if sender, ok := service.sender.(webPushSender); ok {
		sender.subscriber = service.subscriber
		service.sender = sender
	}
	return service
}

func (s *Service) PublicKey(ctx context.Context) (string, error) {
	keys, err := s.ensureKeys(ctx)
	if err != nil {
		return "", err
	}
	return keys.PublicKey, nil
}

func (s *Service) SaveSubscription(ctx context.Context, input SubscriptionInput) (store.PushSubscription, error) {
	return s.store.SavePushSubscription(ctx, store.SavePushSubscriptionParams{
		Endpoint:  input.Endpoint,
		P256DH:    input.P256DH,
		Auth:      input.Auth,
		UserAgent: input.UserAgent,
	})
}

func (s *Service) DeleteSubscription(ctx context.Context, endpoint string) error {
	return s.store.DeletePushSubscription(ctx, endpoint)
}

func (s *Service) SendTest(ctx context.Context) error {
	payload, err := json.Marshal(notificationPayload{
		Title: "Gorchestra notifications enabled",
		Body:  "You will be notified when a session stops.",
		URL:   "/",
		Tag:   "gorchestra-test",
	})
	if err != nil {
		return err
	}
	return s.sendToActiveSubscriptions(ctx, payload)
}

func (s *Service) Start(ctx context.Context, source EventSource) {
	if source == nil {
		return
	}

	events, unsubscribe := source.SubscribeAll()
	go func() {
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				if !isTerminalRunEvent(event.Type) {
					continue
				}
				go s.notifyTerminalEvent(ctx, event)
			}
		}
	}()
}

func (s *Service) notifyTerminalEvent(parent context.Context, event store.Event) {
	ctx, cancel := context.WithTimeout(parent, sendTimeout)
	defer cancel()

	session, err := s.store.GetSession(ctx, event.SessionID)
	if err != nil {
		s.logf("notification session lookup failed: %v", err)
		return
	}

	payload, err := json.Marshal(notificationPayload{
		Title:     "Gorchestra",
		Body:      terminalNotificationBody(session, event.Type),
		URL:       "/sessions/" + event.SessionID,
		Tag:       "gorchestra-session-" + event.SessionID,
		SessionID: event.SessionID,
		EventType: event.Type,
		Status:    string(event.Status),
	})
	if err != nil {
		s.logf("notification payload failed: %v", err)
		return
	}

	if err := s.sendToActiveSubscriptions(ctx, payload); err != nil {
		s.logf("notification send failed: %v", err)
	}
}

func (s *Service) sendToActiveSubscriptions(ctx context.Context, payload []byte) error {
	keys, err := s.ensureKeys(ctx)
	if err != nil {
		return err
	}

	subscriptions, err := s.store.ListPushSubscriptions(ctx)
	if err != nil {
		return err
	}
	if len(subscriptions) == 0 {
		return nil
	}

	var errs []error
	for _, subscription := range subscriptions {
		response, err := s.sender.Send(ctx, keys, subscription, payload)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", subscription.Endpoint, err))
			continue
		}
		if response == nil {
			continue
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			continue
		}
		statusText := response.Status
		if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound {
			if err := s.store.DisablePushSubscription(ctx, store.DisablePushSubscriptionParams{
				Endpoint:  subscription.Endpoint,
				LastError: statusText,
			}); err != nil {
				errs = append(errs, fmt.Errorf("disable stale subscription %s: %w", subscription.Endpoint, err))
			}
			continue
		}
		errs = append(errs, fmt.Errorf("%s: push service returned %s", subscription.Endpoint, statusText))
	}

	return errors.Join(errs...)
}

func (s *Service) ensureKeys(ctx context.Context) (store.NotificationKeys, error) {
	keys, err := s.store.GetNotificationKeys(ctx)
	if err == nil {
		return keys, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return store.NotificationKeys{}, err
	}

	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return store.NotificationKeys{}, fmt.Errorf("generate vapid keys: %w", err)
	}

	return s.store.SetNotificationKeys(ctx, store.SetNotificationKeysParams{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
	})
}

func (s *Service) logf(format string, args ...any) {
	if s.logger == nil {
		return
	}
	s.logger.Printf(format, args...)
}

type notificationPayload struct {
	Title     string `json:"title"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	Tag       string `json:"tag"`
	SessionID string `json:"session_id,omitempty"`
	EventType string `json:"event_type,omitempty"`
	Status    string `json:"status,omitempty"`
}

type webPushSender struct {
	subscriber string
}

func (s webPushSender) Send(ctx context.Context, keys store.NotificationKeys, subscription store.PushSubscription, payload []byte) (*http.Response, error) {
	return webpush.SendNotificationWithContext(
		ctx,
		payload,
		&webpush.Subscription{
			Endpoint: subscription.Endpoint,
			Keys: webpush.Keys{
				P256dh: subscription.P256DH,
				Auth:   subscription.Auth,
			},
		},
		&webpush.Options{
			Subscriber:      s.subscriber,
			VAPIDPublicKey:  keys.PublicKey,
			VAPIDPrivateKey: keys.PrivateKey,
			TTL:             60 * 60 * 24,
			Urgency:         webpush.UrgencyNormal,
		},
	)
}

func isTerminalRunEvent(eventType string) bool {
	return eventType == "agent.run.completed" || eventType == "agent.run.failed" || eventType == "agent.run.cancelled"
}

func terminalNotificationBody(session store.Session, eventType string) string {
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = "Untitled session"
	}

	switch eventType {
	case "agent.run.completed":
		return title + " completed."
	case "agent.run.cancelled":
		return title + " was cancelled."
	default:
		return title + " failed."
	}
}
