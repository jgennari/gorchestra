package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
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

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
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

	_, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
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

	if _, err := service.Append(ctx, appendParams("sess_two", "agent.message.completed")); err != nil {
		t.Fatalf("append other session: %v", err)
	}
	assertNoEvent(t, ch)

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append subscribed session: %v", err)
	}

	delivered := receiveEvent(t, ch)
	if delivered.ID != event.ID {
		t.Fatalf("expected event %q, got %q", event.ID, delivered.ID)
	}
}

func TestAllSubscribersReceiveEverySessionEvent(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.SubscribeAll()
	defer unsubscribe()

	first, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append first: %v", err)
	}
	second, err := service.Append(ctx, appendParams("sess_two", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append second: %v", err)
	}

	if delivered := receiveEvent(t, ch); delivered.ID != first.ID {
		t.Fatalf("expected first event %q, got %q", first.ID, delivered.ID)
	}
	if delivered := receiveEvent(t, ch); delivered.ID != second.ID {
		t.Fatalf("expected second event %q, got %q", second.ID, delivered.ID)
	}
}

func TestTransientDeltasBroadcastOnlyToSessionSubscribers(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	sessionCh, unsubscribeSession := service.Subscribe("sess_one")
	defer unsubscribeSession()
	allCh, unsubscribeAll := service.SubscribeAll()
	defer unsubscribeAll()

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append delta: %v", err)
	}

	if !event.Transient {
		t.Fatal("expected delta event to be transient")
	}
	if event.Seq != 1 {
		t.Fatalf("expected reserved seq 1, got %d", event.Seq)
	}
	if delivered := receiveEvent(t, sessionCh); delivered.ID != event.ID || !delivered.Transient {
		t.Fatalf("expected transient session delivery %#v, got %#v", event, delivered)
	}
	assertNoEvent(t, allCh)

	fake.mu.Lock()
	persisted := len(fake.persisted)
	fake.mu.Unlock()
	if persisted != 0 {
		t.Fatalf("expected no persisted delta events, got %d", persisted)
	}
}

func TestDurableEventAfterTransientUsesNextSequence(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)

	delta, err := service.Append(ctx, appendParams("sess_one", "agent.message.delta"))
	if err != nil {
		t.Fatalf("append delta: %v", err)
	}
	completed, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append completed: %v", err)
	}

	if delta.Seq != 1 || completed.Seq != 2 {
		t.Fatalf("expected transient/durable seqs 1 and 2, got %d and %d", delta.Seq, completed.Seq)
	}
	if completed.Transient {
		t.Fatal("expected completed event to be durable")
	}

	fake.mu.Lock()
	persisted := append([]store.Event(nil), fake.persisted...)
	fake.mu.Unlock()
	if len(persisted) != 1 || persisted[0].Seq != completed.Seq {
		t.Fatalf("expected only completed event persisted, got %#v", persisted)
	}
}

func TestEventsAreDeliveredInAppendOrder(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)
	ch, unsubscribe := service.Subscribe("sess_one")
	defer unsubscribe()

	for i := 0; i < 3; i++ {
		if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed")); err != nil {
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

	if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed")); err != nil {
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

	first, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append first: %v", err)
	}

	if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed")); err != nil {
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

func TestFullAllSubscriberChannelIsRemovedAndClosed(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake, WithSubscriberBufferSize(1))
	ch, unsubscribe := service.SubscribeAll()
	defer unsubscribe()

	first, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
	if err != nil {
		t.Fatalf("append first: %v", err)
	}
	if _, err := service.Append(ctx, appendParams("sess_two", "agent.message.completed")); err != nil {
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
	if got := len(service.allSubscribers); got != 0 {
		t.Fatalf("expected full all-subscriber to be removed, got %d subscribers", got)
	}
}

func TestRecentBufferTrimsToDefaultSizeAndRemainsOrdered(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	service := newTestService(t, fake)

	for i := 0; i < DefaultBufferSize+5; i++ {
		if _, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed")); err != nil {
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

	event, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
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
			_, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
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
			_, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
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

func TestConcurrentSessionsBroadcastInGlobalSequenceOrder(t *testing.T) {
	ctx := context.Background()
	fake := newFakeStore()
	firstPersisted := make(chan struct{})
	releaseFirst := make(chan struct{})
	fake.afterPersist = func(event store.Event) {
		if event.GlobalSeq == 1 {
			close(firstPersisted)
			<-releaseFirst
		}
	}
	service := newTestService(t, fake)
	ch, unsubscribe := service.SubscribeAll()
	defer unsubscribe()

	errCh := make(chan error, 2)
	go func() {
		_, err := service.Append(ctx, appendParams("sess_one", "agent.message.completed"))
		errCh <- err
	}()
	<-firstPersisted
	go func() {
		_, err := service.Append(ctx, appendParams("sess_two", "agent.message.completed"))
		errCh <- err
	}()

	assertNoEvent(t, ch)
	close(releaseFirst)
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	first := receiveEvent(t, ch)
	second := receiveEvent(t, ch)
	if first.GlobalSeq != 1 || second.GlobalSeq != 2 {
		t.Fatalf("expected global seqs 1 then 2, got %d then %d", first.GlobalSeq, second.GlobalSeq)
	}
}

type fakeStore struct {
	mu            sync.Mutex
	nextID        int
	nextGlobalSeq int64
	nextSeq       map[string]int64
	persisted     []store.Event
	err           error
	afterPersist  func(store.Event)
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		nextSeq: make(map[string]int64),
	}
}

func (f *fakeStore) ReserveEventSequences(ctx context.Context, sessionID string, count int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	first := f.nextSeq[sessionID] + 1
	f.nextSeq[sessionID] += count
	return first, nil
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
	if params.Seq <= 0 {
		f.nextSeq[params.SessionID]++
		params.Seq = f.nextSeq[params.SessionID]
	}
	event := store.Event{
		ID:        fmt.Sprintf("evt_%06d", f.nextID),
		SessionID: params.SessionID,
		Seq:       params.Seq,
		GlobalSeq: f.nextGlobalSeq + 1,
		Type:      params.Type,
		Role:      params.Role,
		Status:    params.Status,
		Payload:   append(json.RawMessage(nil), params.Payload...),
		CreatedAt: time.Now().UTC(),
	}
	f.nextGlobalSeq = event.GlobalSeq
	f.persisted = append(f.persisted, event)
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
		Status:    eventStatusForType(eventType),
		Payload:   json.RawMessage(`{"text":"hello"}`),
	}
}

func eventStatusForType(eventType string) store.EventStatus {
	switch {
	case strings.HasSuffix(eventType, ".started"):
		return store.EventStatusStarted
	case strings.HasSuffix(eventType, ".completed"):
		return store.EventStatusCompleted
	case strings.HasSuffix(eventType, ".failed"):
		return store.EventStatusFailed
	case strings.HasSuffix(eventType, ".cancelled"):
		return store.EventStatusCancelled
	default:
		return store.EventStatusDelta
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
