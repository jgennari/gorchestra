package events

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

const (
	DefaultBufferSize           = 1000
	DefaultSubscriberBufferSize = 64
	DefaultSequenceBlockSize    = 1024
	MaxLiveSessionBytes         = 8 * 1024 * 1024
	MaxLiveTotalBytes           = 64 * 1024 * 1024
)

type Store interface {
	ReserveEventSequences(ctx context.Context, sessionID string, count int64) (int64, error)
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
	durableAppendMu      sync.Mutex

	mu               sync.Mutex
	buffers          map[string][]store.Event
	subscribers      map[string]map[uint64]chan store.Event
	allSubscribers   map[uint64]chan store.Event
	activityClients  map[string]activityClient
	liveEvents       map[string]map[string]store.Event
	liveBytes        map[string]int
	appendLocks      map[string]*sync.Mutex
	sequenceBlocks   map[string]sequenceBlock
	nextSubscriberID uint64
	activityStats    SessionActivityStats
}

type activityClient struct {
	id               uint64
	ch               chan store.Event
	watchedSessionID string
	includeDebug     bool
	allTransient     bool
}

type SessionActivityStats struct {
	ActiveSubscribers   int   `json:"active_subscribers"`
	DroppedSubscribers  int64 `json:"dropped_subscribers"`
	DurableDeliveries   int64 `json:"durable_deliveries"`
	TransientDeliveries int64 `json:"transient_deliveries"`
	LiveSessions        int   `json:"live_sessions"`
	LiveEvents          int   `json:"live_events"`
	LiveBytes           int   `json:"live_bytes"`
	LiveTruncations     int64 `json:"live_truncations"`
	SnapshotEvents      int64 `json:"snapshot_events"`
}

type SessionLiveSnapshot struct {
	Events     []store.Event
	Watermarks map[string]int64
}

type sequenceBlock struct {
	next int64
	end  int64
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
		allSubscribers:       make(map[uint64]chan store.Event),
		activityClients:      make(map[string]activityClient),
		liveEvents:           make(map[string]map[string]store.Event),
		liveBytes:            make(map[string]int),
		appendLocks:          make(map[string]*sync.Mutex),
		sequenceBlocks:       make(map[string]sequenceBlock),
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

	transient := isTransientEventType(params.Type)
	if !transient {
		// SQLite serializes these writes already. Keep the persistence + broadcast
		// boundary serialized too so global subscribers can never observe cursor
		// N+1 before cursor N when different sessions append concurrently.
		s.durableAppendMu.Lock()
		defer s.durableAppendMu.Unlock()
	}
	var event store.Event
	var err error

	if transient {
		event, err = s.newTransientEvent(ctx, params)
		if err != nil {
			return store.Event{}, err
		}
	} else {
		seq, err := s.nextSequence(ctx, params.SessionID)
		if err != nil {
			return store.Event{}, err
		}
		event, err = s.store.AppendEvent(ctx, store.AppendEventParams{
			SessionID: params.SessionID,
			Seq:       seq,
			Type:      params.Type,
			Role:      params.Role,
			Status:    params.Status,
			Payload:   params.Payload,
		})
		if err != nil {
			return store.Event{}, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.appendToBufferLocked(event)
	s.updateLiveEventsLocked(event)
	s.broadcastLocked(event)

	return event, nil
}

func (s *Service) newTransientEvent(ctx context.Context, params AppendParams) (store.Event, error) {
	if err := ctx.Err(); err != nil {
		return store.Event{}, err
	}
	seq, err := s.nextSequence(ctx, params.SessionID)
	if err != nil {
		return store.Event{}, err
	}
	id, err := store.NewEventID()
	if err != nil {
		return store.Event{}, err
	}
	return store.Event{
		ID:        id,
		SessionID: params.SessionID,
		Seq:       seq,
		Type:      params.Type,
		Role:      params.Role,
		Status:    params.Status,
		Payload:   append(json.RawMessage(nil), params.Payload...),
		CreatedAt: time.Now().UTC(),
		Transient: true,
	}, nil
}

func (s *Service) nextSequence(ctx context.Context, sessionID string) (int64, error) {
	s.mu.Lock()
	block := s.sequenceBlocks[sessionID]
	if block.next > 0 && block.next <= block.end {
		seq := block.next
		block.next++
		s.sequenceBlocks[sessionID] = block
		s.mu.Unlock()
		return seq, nil
	}
	s.mu.Unlock()

	firstSeq, err := s.store.ReserveEventSequences(ctx, sessionID, DefaultSequenceBlockSize)
	if err != nil {
		return 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequenceBlocks[sessionID] = sequenceBlock{
		next: firstSeq + 1,
		end:  firstSeq + DefaultSequenceBlockSize - 1,
	}
	return firstSeq, nil
}

func isTransientEventType(eventType string) bool {
	return strings.HasSuffix(eventType, ".delta")
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

func (s *Service) SubscribeAll() (<-chan store.Event, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextSubscriberID++
	id := s.nextSubscriberID
	ch := make(chan store.Event, s.subscriberBufferSize)
	s.allSubscribers[id] = ch

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.unsubscribeAll(id)
		})
	}

	return ch, unsubscribe
}

// SubscribeSessionActivity creates the browser-wide subscription used by the
// global activity stream. Durable events from every session are delivered.
// Transient deltas are either limited to the watched session for compatibility
// or delivered for every session when allTransient is enabled. Reusing
// clientID replaces a stale connection without allowing its later cleanup to
// remove the replacement.
func (s *Service) SubscribeSessionActivity(
	clientID string,
	watchedSessionID string,
	includeDebug bool,
	allTransient bool,
) (<-chan store.Event, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextSubscriberID++
	id := s.nextSubscriberID
	ch := make(chan store.Event, s.subscriberBufferSize)
	if previous, ok := s.activityClients[clientID]; ok {
		close(previous.ch)
	}
	s.activityClients[clientID] = activityClient{
		id:               id,
		ch:               ch,
		watchedSessionID: watchedSessionID,
		includeDebug:     includeDebug,
		allTransient:     allTransient,
	}

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.unsubscribeSessionActivity(clientID, id)
		})
	}
	return ch, unsubscribe
}

// WatchSessionActivity changes the transient session routed to an existing
// browser subscription without reconnecting its SSE transport.
func (s *Service) WatchSessionActivity(clientID string, watchedSessionID string, includeDebug bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	client, ok := s.activityClients[clientID]
	if !ok {
		return false
	}
	client.watchedSessionID = watchedSessionID
	client.includeDebug = includeDebug
	s.activityClients[clientID] = client
	return true
}

func (s *Service) SessionActivityWatch(clientID string) (string, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	client, ok := s.activityClients[clientID]
	return client.watchedSessionID, client.includeDebug, ok
}

func (s *Service) SessionActivityReceivesAllTransient(clientID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activityClients[clientID].allTransient
}

// LiveSnapshot returns accumulated, non-durable activity for every running
// session. Callers use it to restore in-progress output after connecting.
func (s *Service) LiveSnapshot() SessionLiveSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.liveSnapshotLocked("")
}

func (s *Service) LiveSessionSnapshot(sessionID string) SessionLiveSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.liveSnapshotLocked(sessionID)
}

func (s *Service) liveSnapshotLocked(onlySessionID string) SessionLiveSnapshot {
	snapshot := SessionLiveSnapshot{Watermarks: make(map[string]int64, len(s.buffers))}
	for sessionID, sessionEvents := range s.liveEvents {
		if onlySessionID != "" && sessionID != onlySessionID {
			continue
		}
		for _, event := range sessionEvents {
			snapshot.Events = append(snapshot.Events, cloneEvent(event))
		}
	}
	for sessionID, events := range s.buffers {
		if onlySessionID != "" && sessionID != onlySessionID {
			continue
		}
		if len(events) > 0 {
			snapshot.Watermarks[sessionID] = events[len(events)-1].Seq
		}
	}
	s.activityStats.SnapshotEvents += int64(len(snapshot.Events))
	sort.Slice(snapshot.Events, func(left, right int) bool {
		if snapshot.Events[left].SessionID == snapshot.Events[right].SessionID {
			return snapshot.Events[left].Seq < snapshot.Events[right].Seq
		}
		return snapshot.Events[left].SessionID < snapshot.Events[right].SessionID
	})
	return snapshot
}

func (s *Service) SessionActivityStats() SessionActivityStats {
	s.mu.Lock()
	defer s.mu.Unlock()

	stats := s.activityStats
	stats.ActiveSubscribers = len(s.activityClients)
	stats.LiveSessions = len(s.liveEvents)
	for _, events := range s.liveEvents {
		stats.LiveEvents += len(events)
	}
	for _, bytes := range s.liveBytes {
		stats.LiveBytes += bytes
	}
	return stats
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
	if len(sessionSubscribers) > 0 {
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

	if !event.Transient {
		for id, ch := range s.allSubscribers {
			select {
			case ch <- event:
			default:
				close(ch)
				delete(s.allSubscribers, id)
			}
		}
	}

	for clientID, client := range s.activityClients {
		if event.Transient && !client.allTransient && event.SessionID != client.watchedSessionID {
			continue
		}
		select {
		case client.ch <- event:
			if event.Transient {
				s.activityStats.TransientDeliveries++
			} else {
				s.activityStats.DurableDeliveries++
			}
		default:
			close(client.ch)
			delete(s.activityClients, clientID)
			s.activityStats.DroppedSubscribers++
		}
	}
}

func (s *Service) updateLiveEventsLocked(event store.Event) {
	if event.Transient {
		key := liveEventKey(event)
		sessionEvents := s.liveEvents[event.SessionID]
		if sessionEvents == nil {
			sessionEvents = make(map[string]store.Event)
			s.liveEvents[event.SessionID] = sessionEvents
		}
		previous, exists := sessionEvents[key]
		candidate := cloneEvent(event)
		if exists {
			candidate.Payload = mergeLivePayload(previous.Payload, event.Payload)
		}
		sessionEvents[key] = candidate
		s.liveBytes[event.SessionID] = liveEventBytes(sessionEvents)
		if s.liveBytes[event.SessionID] > MaxLiveSessionBytes {
			if !payloadBool(previous.Payload, "_gorchestra_live_truncated") {
				s.activityStats.LiveTruncations++
			}
			s.truncateLiveSessionLocked(event.SessionID, key, MaxLiveSessionBytes)
		}
		s.trimLiveTotalLocked()
		return
	}

	if event.Type == "agent.run.completed" || event.Type == "agent.run.failed" || event.Type == "agent.run.cancelled" {
		delete(s.liveEvents, event.SessionID)
		delete(s.liveBytes, event.SessionID)
		return
	}
	deltaType := completedDeltaType(event.Type)
	if deltaType == "" {
		return
	}
	sessionEvents := s.liveEvents[event.SessionID]
	key := liveEventKeyFor(deltaType, event.Payload)
	if previous, ok := sessionEvents[key]; ok {
		s.liveBytes[event.SessionID] -= len(previous.Payload)
		delete(sessionEvents, key)
	}
	if len(sessionEvents) == 0 {
		delete(s.liveEvents, event.SessionID)
		delete(s.liveBytes, event.SessionID)
	}
}

func (s *Service) truncateLiveSessionLocked(sessionID, preferredKey string, limit int) {
	sessionEvents := s.liveEvents[sessionID]
	preferred, ok := sessionEvents[preferredKey]
	if !ok {
		return
	}

	for {
		otherBytes := liveEventBytes(sessionEvents) - len(preferred.Payload)
		available := limit - otherBytes
		truncated := markLiveTruncated(preferred, available)
		if len(truncated.Payload) <= available || len(sessionEvents) == 1 {
			sessionEvents[preferredKey] = truncated
			s.liveBytes[sessionID] = otherBytes + len(truncated.Payload)
			return
		}

		oldestKey := oldestLiveEventKey(sessionEvents, preferredKey)
		if oldestKey == "" {
			sessionEvents[preferredKey] = markLiveTruncated(preferred, limit)
			s.liveBytes[sessionID] = len(sessionEvents[preferredKey].Payload)
			return
		}
		delete(sessionEvents, oldestKey)
	}
}

func (s *Service) trimLiveTotalLocked() {
	for totalLiveBytes(s.liveBytes) > MaxLiveTotalBytes {
		oldestSessionID := ""
		var oldest time.Time
		for sessionID, sessionEvents := range s.liveEvents {
			if s.liveBytes[sessionID] <= 1024 {
				continue
			}
			latest := time.Time{}
			for _, event := range sessionEvents {
				if event.CreatedAt.After(latest) {
					latest = event.CreatedAt
				}
			}
			if oldestSessionID == "" || latest.Before(oldest) {
				oldestSessionID = sessionID
				oldest = latest
			}
		}
		if oldestSessionID == "" {
			for sessionID, sessionEvents := range s.liveEvents {
				latest := time.Time{}
				for _, event := range sessionEvents {
					if event.CreatedAt.After(latest) {
						latest = event.CreatedAt
					}
				}
				if oldestSessionID == "" || latest.Before(oldest) {
					oldestSessionID = sessionID
					oldest = latest
				}
			}
			if oldestSessionID == "" {
				return
			}
			delete(s.liveEvents, oldestSessionID)
			delete(s.liveBytes, oldestSessionID)
			s.activityStats.LiveTruncations++
			continue
		}
		previousBytes := s.liveBytes[oldestSessionID]
		sessionEvents := s.liveEvents[oldestSessionID]
		newestKey := newestLiveEventKey(sessionEvents)
		newest := sessionEvents[newestKey]
		if !payloadBool(newest.Payload, "_gorchestra_live_truncated") {
			s.activityStats.LiveTruncations++
		}
		newest = markLiveTruncated(newest, 1024)
		s.liveEvents[oldestSessionID] = map[string]store.Event{newestKey: newest}
		s.liveBytes[oldestSessionID] = len(newest.Payload)
		if s.liveBytes[oldestSessionID] >= previousBytes {
			delete(s.liveEvents, oldestSessionID)
			delete(s.liveBytes, oldestSessionID)
		}
	}
}

func liveEventBytes(events map[string]store.Event) int {
	total := 0
	for _, event := range events {
		total += len(event.Payload)
	}
	return total
}

func oldestLiveEventKey(events map[string]store.Event, except string) string {
	oldestKey := ""
	var oldest time.Time
	for key, event := range events {
		if key == except {
			continue
		}
		if oldestKey == "" || event.CreatedAt.Before(oldest) {
			oldestKey = key
			oldest = event.CreatedAt
		}
	}
	return oldestKey
}

func newestLiveEventKey(events map[string]store.Event) string {
	newestKey := ""
	var newest time.Time
	for key, event := range events {
		if newestKey == "" || event.CreatedAt.After(newest) {
			newestKey = key
			newest = event.CreatedAt
		}
	}
	return newestKey
}

func totalLiveBytes(bySession map[string]int) int {
	total := 0
	for _, bytes := range bySession {
		total += bytes
	}
	return total
}

func liveEventKey(event store.Event) string { return liveEventKeyFor(event.Type, event.Payload) }

func liveEventKeyFor(eventType string, payload json.RawMessage) string {
	var values map[string]any
	_ = json.Unmarshal(payload, &values)
	runID, _ := values["run_id"].(string)
	prefix := eventType + ":" + runID + ":"
	for _, key := range []string{"tool_call_id", "file_change_id", "item_id", "message_id", "plan_id", "id", "path", "file_path"} {
		if value, ok := values[key].(string); ok && value != "" {
			return prefix + value
		}
	}
	return prefix
}

func completedDeltaType(eventType string) string {
	switch eventType {
	case "agent.message.completed":
		return "agent.message.delta"
	case "agent.plan.completed":
		return "agent.plan.delta"
	case "agent.thinking.completed":
		return "agent.thinking.delta"
	case "tool.call.completed":
		return "tool.call.delta"
	case "file.change.completed":
		return "file.change.delta"
	default:
		return ""
	}
}

func mergeLivePayload(previous, next json.RawMessage) json.RawMessage {
	var left, right map[string]any
	if json.Unmarshal(previous, &left) != nil || json.Unmarshal(next, &right) != nil {
		return append(json.RawMessage(nil), next...)
	}
	previousText, _ := left["text"].(string)
	nextText, _ := right["text"].(string)
	for key, value := range right {
		if key == "text" && left["_gorchestra_live_truncated"] == true {
			continue
		}
		left[key] = value
	}
	if left["_gorchestra_live_truncated"] != true && (previousText != "" || nextText != "") {
		left["text"] = previousText + nextText
	}
	encoded, err := json.Marshal(left)
	if err != nil {
		return append(json.RawMessage(nil), next...)
	}
	return encoded
}

func markLiveTruncated(event store.Event, maxPayloadBytes int) store.Event {
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		payload = map[string]any{}
	}
	payload["_gorchestra_live_truncated"] = true
	const notice = "\n\n[Live output truncated while this session was in the background.]"
	originalText, hasText := payload["text"].(string)
	if hasText && !strings.HasSuffix(originalText, notice) {
		payload["text"] = originalText + notice
	}
	encoded, _ := json.Marshal(payload)
	if maxPayloadBytes > 0 && len(encoded) > maxPayloadBytes && hasText {
		keep := len(originalText) - (len(encoded) - maxPayloadBytes)
		if keep < 0 {
			keep = 0
		}
		if keep < len(originalText) {
			for keep > 0 && originalText[keep]&0xc0 == 0x80 {
				keep--
			}
			payload["text"] = originalText[:keep] + notice
			encoded, _ = json.Marshal(payload)
		}
	}
	if maxPayloadBytes > 0 && len(encoded) > maxPayloadBytes {
		compact := map[string]any{
			"_gorchestra_live_truncated": true,
			"text":                       strings.TrimSpace(notice),
		}
		for _, key := range []string{"provider", "run_id", "tool_call_id", "file_change_id", "item_id", "message_id", "plan_id", "id", "path", "file_path"} {
			if value, ok := payload[key].(string); ok && value != "" {
				compact[key] = truncateUTF8(value, 128)
			}
		}
		encoded, _ = json.Marshal(compact)
	}
	event.Payload = encoded
	return event
}

func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	for limit > 0 && value[limit]&0xc0 == 0x80 {
		limit--
	}
	return value[:limit]
}

func cloneEvent(event store.Event) store.Event {
	event.Payload = append(json.RawMessage(nil), event.Payload...)
	return event
}

func payloadBool(payload json.RawMessage, key string) bool {
	var values map[string]any
	if json.Unmarshal(payload, &values) != nil {
		return false
	}
	value, _ := values[key].(bool)
	return value
}

func (s *Service) unsubscribeSessionActivity(clientID string, id uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	client, ok := s.activityClients[clientID]
	if !ok || client.id != id {
		return
	}
	close(client.ch)
	delete(s.activityClients, clientID)
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

func (s *Service) unsubscribeAll(id uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch, ok := s.allSubscribers[id]
	if !ok {
		return
	}

	close(ch)
	delete(s.allSubscribers, id)
}
