package hosting

import (
	"io"
	"sync"
	"time"
)

const logSubscriberBuffer = 256

type logFilter struct {
	service string
}

type logSubscriber struct {
	filter logFilter
	ch     chan LogChunk
}

type logBuffer struct {
	mu          sync.Mutex
	limit       int
	bytes       int
	nextSeq     uint64
	chunks      []LogChunk
	nextSubID   uint64
	subscribers map[uint64]logSubscriber
	now         func() time.Time
}

func newLogBuffer(limit int, now func() time.Time) *logBuffer {
	if limit <= 0 {
		limit = DefaultLogLimit
	}
	return &logBuffer{
		limit:       limit,
		subscribers: make(map[uint64]logSubscriber),
		now:         now,
	}
}

func (b *logBuffer) append(service string, stream LogStream, data []byte) {
	if len(data) == 0 {
		return
	}
	// Writes from os/exec are normally modest, but bounding individual chunks
	// keeps one pathological write from temporarily exceeding the ring limit.
	if len(data) > b.limit {
		data = data[len(data)-b.limit:]
	}
	chunkData := string(append([]byte(nil), data...))

	b.mu.Lock()
	b.nextSeq++
	chunk := LogChunk{
		Seq:       b.nextSeq,
		Service:   service,
		Stream:    stream,
		Data:      chunkData,
		CreatedAt: b.now().UTC(),
	}
	b.chunks = append(b.chunks, chunk)
	b.bytes += len(chunkData)
	for b.bytes > b.limit && len(b.chunks) > 0 {
		b.bytes -= len(b.chunks[0].Data)
		b.chunks[0] = LogChunk{}
		b.chunks = b.chunks[1:]
	}
	for _, subscriber := range b.subscribers {
		if !subscriber.filter.match(chunk) {
			continue
		}
		select {
		case subscriber.ch <- chunk:
		default:
			// Slow subscribers reconnect with their last sequence and replay from
			// the ring. Never let log consumers stall a child process.
		}
	}
	b.mu.Unlock()
}

func (b *logBuffer) cursor() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.nextSeq
}

func (b *logBuffer) snapshot(after uint64, service string) LogSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.snapshotLocked(after, logFilter{service: service})
}

func (b *logBuffer) snapshotLocked(after uint64, filter logFilter) LogSnapshot {
	result := LogSnapshot{LastSeq: b.nextSeq}
	if len(b.chunks) > 0 {
		result.FirstSeq = b.chunks[0].Seq
		result.Truncated = after > 0 && after < result.FirstSeq-1
	}
	for _, chunk := range b.chunks {
		if chunk.Seq > after && filter.match(chunk) {
			result.Chunks = append(result.Chunks, chunk)
		}
	}
	if result.Chunks == nil {
		result.Chunks = []LogChunk{}
	}
	return result
}

func (b *logBuffer) subscribe(after uint64, service string) (LogSnapshot, <-chan LogChunk, func()) {
	b.mu.Lock()
	replay := b.snapshotLocked(after, logFilter{service: service})
	b.nextSubID++
	id := b.nextSubID
	ch := make(chan LogChunk, logSubscriberBuffer)
	b.subscribers[id] = logSubscriber{filter: logFilter{service: service}, ch: ch}
	b.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			b.mu.Lock()
			if subscriber, ok := b.subscribers[id]; ok {
				delete(b.subscribers, id)
				close(subscriber.ch)
			}
			b.mu.Unlock()
		})
	}
	return replay, ch, unsubscribe
}

func (f logFilter) match(chunk LogChunk) bool {
	return f.service == "" || f.service == chunk.Service
}

type serviceLogWriter struct {
	buffer  *logBuffer
	service string
	stream  LogStream
}

func (w serviceLogWriter) Write(data []byte) (int, error) {
	w.buffer.append(w.service, w.stream, data)
	return len(data), nil
}

var _ io.Writer = serviceLogWriter{}
