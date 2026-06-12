package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

func TestAppendPersistsBuffersAndBroadcastsInOrder(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()

	var service *Service
	ch, subscribe := func() (<-chan store.Event, func()) {
		var err error
		service, err = NewService(fake)
		if err != nil {
			t.Fatalf("new service: %v", err)
		}
		return service.Subscribe("sess_one")
	}()
	defer subscribe()

	fake.afterPersist = func(event store.Event) {
		if got := service.Recent(event.SessionID); len(got) != 0 {
			t.Fatalf("expected no buffered event before store append returns, got %d", len(got))
		}
		assertNoEvent(t, ch)
	}

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	if event.ID == "" {
		t.Fatal("expected persisted event ID")
	}

	recent := service.Recent("sess_one")
	if len(recent) != 1 {
		t.Fatalf("expected one buffered event, got %d", len(recent))
	}
	if recent[0].ID != event.ID {
		t.Fatalf("expected buffered event %q, got %q", event.ID, recent[0].ID)
	}

	delivered := receiveEvent(t, ch)
	if delivered.ID != event.ID {
		t.Fatalf("expected delivered event %q, got %q", event.ID, delivered.ID)
	}
}

func TestAppendFailurePreventsBufferingAndBroadcast(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	fake.err = errors.New("store unavailable")
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	_, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if !errors.Is(err, fake.err) {
		t.Fatalf("expected store error, got %v", err)
	}

	if got := service.Recent("sess_one"); len(got) != 0 {
		t.Fatalf("expected no buffered events, got %d", len(got))
	}
	assertNoEvent(t, ch)
}

func TestSubscribersReceiveOnlyTheirSessionEvents(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	if _, err := service.Append(ctx, appendParams("sess_two", "agent.message.delta")); err != nil {
		t.Fatalf("append other session: %v", err)
	}
	assertNoEvent(t, ch)

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append subscribed session: %v", err)
	}

	delivered := receiveEvent(t, ch)
	if delivered.ID != event.ID {
		t.Fatalf("expected event %q, got %q", event.ID, delivered.ID)
	}
}

func TestEventsAreDeliveredInAppendOrder(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	for i := 0; i < 3; i++ {
		if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	seqs := []int64{
		receiveEvent(t, ch).Seq,
		receiveEvent(t, ch).Seq,
		receiveEvent(t, ch).Seq,
	}
	if want := []int64{1, 2, 3}; !reflect.DeepEqual(seqs, want) {
		t.Fatalf("expected delivered seqs %v, got %v", want, seqs)
	}
}

func TestUnsubscribeClosesChannelAndStopsDelivery(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")

	unsubscribe()
	assertClosed(t, ch)

	if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta")); err != nil {
		t.Fatalf("append after unsubscribe: %v", err)
	}

	service.mu.Lock()
	defer service.mu.Unlock()
	if got := len(service.subscribers["sess_one"]); got != 0 {
		t.Fatalf("expected no subscribers, got %d", got)
	}
}

func TestUnsubscribeIsIdempotent(t *testing.T) {
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")

	unsubscribe()
	unsubscribe()
	assertClosed(t, ch)
}

func TestFullSubscriberChannelIsRemovedAndClosed(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake, WithSubscriberBufferSize(1))
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	first, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append first: %v", err)
	}

	if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta")); err != nil {
		t.Fatalf("append second: %v", err)
	}

	delivered, ok := <-ch
	if !ok {
		t.Fatal("expected buffered first event before channel close")
	}
	if delivered.ID != first.ID {
		t.Fatalf("expected first event %q, got %q", first.ID, delivered.ID)
	}
	assertClosed(t, ch)

	service.mu.Lock()
	defer service.mu.Unlock()
	if got := len(service.subscribers["sess_one"]); got != 0 {
		t.Fatalf("expected full subscriber to be removed, got %d subscribers", got)
	}
}

func TestRecentBufferTrimsToDefaultSizeAndRemainsOrdered(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)

	for i := 0; i < DefaultBufferSize+5; i++ {
		if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	recent := service.Recent("sess_one")
	if len(recent) != DefaultBufferSize {
		t.Fatalf("expected buffer size %d, got %d", DefaultBufferSize, len(recent))
	}
	if recent[0].Seq != 6 {
		t.Fatalf("expected oldest retained seq 6, got %d", recent[0].Seq)
	}
	if recent[len(recent)-1].Seq != int64(DefaultBufferSize+5) {
		t.Fatalf("expected newest retained seq %d, got %d", DefaultBufferSize+5, recent[len(recent)-1].Seq)
	}
	assertAscending(t, recent)
}

func TestRecentReturnsACopy(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	recent := service.Recent("sess_one")
	recent[0].ID = "mutated"

	nextRecent := service.Recent("sess_one")
	if nextRecent[0].ID != event.ID {
		t.Fatalf("expected internal buffer to remain %q, got %q", event.ID, nextRecent[0].ID)
	}
}

func TestConcurrentAppendsAreRaceSafe(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	const appendCount = 100

	var wg sync.WaitGroup
	errc := make(chan error, appendCount)
	for i := 0; i < appendCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
			errc <- err
		}()
	}
	wg.Wait()
	close(errc)

	for err := range errc {
		if err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	recent := service.Recent("sess_one")
	if len(recent) != appendCount {
		t.Fatalf("expected %d events, got %d", appendCount, len(recent))
	}
	assertAscending(t, recent)
}

func TestConcurrentAppendsDeliverLiveEventsInSequenceOrder(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	const appendCount = 100
	service := newTestService(t, fake, WithSubscriberBufferSize(appendCount))
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	var wg sync.WaitGroup
	errc := make(chan error, appendCount)
	for i := 0; i < appendCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
			errc <- err
		}()
	}
	wg.Wait()
	close(errc)

	for err := range errc {
		if err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	delivered := make([]store.Event, 0, appendCount)
	for i := 0; i < appendCount; i++ {
		delivered = append(delivered, receiveEvent(t, ch))
	}
	assertAscending(t, delivered)
}

type fakeStore struct {
	mu           sync.Mutex
	nextID       int
	nextSeq      map[string]int64
	err          error
	afterPersist func(store.Event)
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		nextSeq: make(map[string]int64),
	}
}

func (f *fakeStore) AppendEvent(ctx context.Context, params store.AppendEventParams) (store.Event, error) {
	if err := ctx.Err(); err != nil {
		return store.Event{}, err
	}

	f.mu.Lock()
	if f.err != nil {
		defer f.mu.Unlock()
		return store.Event{}, f.err
	}

	f.nextID++
	f.nextSeq[params.SessionID]++
	event := store.Event{
		ID:        fmt.Sprintf("evt_%06d", f.nextID),
		SessionID: params.SessionID,
		Seq:       f.nextSeq[params.SessionID],
		Type:      params.Type,
		Role:      params.Role,
		Status:    params.Status,
		Payload:   append(json.RawMessage(nil), params.Payload...),
		CreatedAt: time.Now().UTC(),
	}
	afterPersist := f.afterPersist
	f.mu.Unlock()

	if afterPersist != nil {
		afterPersist(event)
	}

	return event, nil
}

func newTestService(t *testing.T, eventStore Store, options ...Option) *Service {
	t.Helper()

	service, err := NewService(eventStore, options...)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	return service
}

func appendParams(sessionID string, eventType string) AppendParams {
	return AppendParams{
		SessionID: sessionID,
		Type:      eventType,
		Role:      "assistant",
		Status:    store.EventStatusDelta,
		Payload:   json.RawMessage(`{"text":"hello"}`),
	}
}

func receiveEvent(t *testing.T, ch <-chan store.Event) store.Event {
	t.Helper()

	select {
	case event, ok := <-ch:
		if !ok {
			t.Fatal("expected event, channel closed")
		}
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
		return store.Event{}
	}
}

func assertNoEvent(t *testing.T, ch <-chan store.Event) {
	t.Helper()

	select {
	case event, ok := <-ch:
		t.Fatalf("expected no event, got %#v with channel open=%v", event, ok)
	default:
	}
}

func assertClosed(t *testing.T, ch <-chan store.Event) {
	t.Helper()

	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("expected closed channel")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for closed channel")
	}
}

func assertAscending(t *testing.T, events []store.Event) {
	t.Helper()

	for i := 1; i < len(events); i++ {
		if events[i-1].Seq >= events[i].Seq {
			t.Fatalf("expected ascending seqs, got %d before %d at index %d", events[i-1].Seq, events[i].Seq, i)
		}
	}
}
