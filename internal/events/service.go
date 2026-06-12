package events

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"github.com/jgennari/gorchestra/internal/store"
)

const (
	DefaultBufferSize           = 1000
	DefaultSubscriberBufferSize = 64
)

type Store interface {
	AppendEvent(ctx context.Context, params store.AppendEventParams) (store.Event, error)
}

type AppendParams struct {
	SessionID string
	Type      string
	Role      string
	Status    store.EventStatus
	Payload   json.RawMessage
}

type Option func(*Service)

type Service struct {
	store                Store
	bufferSize           int
	subscriberBufferSize int

	mu               sync.Mutex
	buffers          map[string][]store.Event
	subscribers      map[string]map[uint64]chan store.Event
	appendLocks      map[string]*sync.Mutex
	nextSubscriberID uint64
}

func NewService(eventStore Store, options ...Option) (*Service, error) {
	if eventStore == nil {
		return nil, fmt.Errorf("events: store is required")
	}

	service := &Service{
		store:                eventStore,
		bufferSize:           DefaultBufferSize,
		subscriberBufferSize: DefaultSubscriberBufferSize,
		buffers:              make(map[string][]store.Event),
		subscribers:          make(map[string]map[uint64]chan store.Event),
		appendLocks:          make(map[string]*sync.Mutex),
	}

	for _, option := range options {
		option(service)
	}

	if service.bufferSize < 1 {
		service.bufferSize = DefaultBufferSize
	}
	if service.subscriberBufferSize < 1 {
		service.subscriberBufferSize = DefaultSubscriberBufferSize
	}

	return service, nil
}

func WithBufferSize(size int) Option {
	return func(service *Service) {
		service.bufferSize = size
	}
}

func WithSubscriberBufferSize(size int) Option {
	return func(service *Service) {
		service.subscriberBufferSize = size
	}
}

func (s *Service) Append(ctx context.Context, params AppendParams) (store.Event, error) {
	appendLock := s.appendLock(params.SessionID)
	appendLock.Lock()
	defer appendLock.Unlock()

	event, err := s.store.AppendEvent(ctx, store.AppendEventParams{
		SessionID: params.SessionID,
		Type:      params.Type,
		Role:      params.Role,
		Status:    params.Status,
		Payload:   params.Payload,
	})
	if err != nil {
		return store.Event{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.appendToBufferLocked(event)
	s.broadcastLocked(event)

	return event, nil
}

func (s *Service) appendLock(sessionID string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()

	appendLock := s.appendLocks[sessionID]
	if appendLock == nil {
		appendLock = &sync.Mutex{}
		s.appendLocks[sessionID] = appendLock
	}

	return appendLock
}

func (s *Service) Subscribe(sessionID string) (<-chan store.Event, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextSubscriberID++
	id := s.nextSubscriberID
	ch := make(chan store.Event, s.subscriberBufferSize)

	if s.subscribers[sessionID] == nil {
		s.subscribers[sessionID] = make(map[uint64]chan store.Event)
	}
	s.subscribers[sessionID][id] = ch

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.unsubscribe(sessionID, id)
		})
	}

	return ch, unsubscribe
}

func (s *Service) Recent(sessionID string) []store.Event {
	s.mu.Lock()
	defer s.mu.Unlock()

	events := s.buffers[sessionID]
	if len(events) == 0 {
		return nil
	}

	return append([]store.Event(nil), events...)
}

func (s *Service) appendToBufferLocked(event store.Event) {
	buffer := s.buffers[event.SessionID]
	insertAt := sort.Search(len(buffer), func(i int) bool {
		return buffer[i].Seq > event.Seq
	})

	buffer = append(buffer, store.Event{})
	copy(buffer[insertAt+1:], buffer[insertAt:])
	buffer[insertAt] = event

	if len(buffer) > s.bufferSize {
		buffer = append([]store.Event(nil), buffer[len(buffer)-s.bufferSize:]...)
	}
	s.buffers[event.SessionID] = buffer
}

func (s *Service) broadcastLocked(event store.Event) {
	sessionSubscribers := s.subscribers[event.SessionID]
	if len(sessionSubscribers) == 0 {
		return
	}

	for id, ch := range sessionSubscribers {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(sessionSubscribers, id)
		}
	}

	if len(sessionSubscribers) == 0 {
		delete(s.subscribers, event.SessionID)
	}
}

func (s *Service) unsubscribe(sessionID string, id uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sessionSubscribers := s.subscribers[sessionID]
	if len(sessionSubscribers) == 0 {
		return
	}

	ch, ok := sessionSubscribers[id]
	if !ok {
		return
	}

	close(ch)
	delete(sessionSubscribers, id)

	if len(sessionSubscribers) == 0 {
		delete(s.subscribers, sessionID)
	}
}
