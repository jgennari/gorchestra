package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	eventservice "github.com/jgennari/gorchestra/internal/events"
)

const (
	maximumClientPerformanceBatches = 50
	maximumLongTasksPerBatch        = 25
	maximumRememberedStreamClients  = 4096
)

type clientLongTask struct {
	StartTime  float64 `json:"start_time"`
	DurationMS float64 `json:"duration_ms"`
}

type clientPerformanceRequest struct {
	CapturedAt int64            `json:"captured_at"`
	Route      string           `json:"route"`
	SessionID  string           `json:"session_id,omitempty"`
	LongTasks  []clientLongTask `json:"long_tasks"`
}

type clientPerformanceRecord struct {
	CapturedAt string           `json:"captured_at"`
	ReceivedAt string           `json:"received_at"`
	Route      string           `json:"route"`
	SessionID  string           `json:"session_id,omitempty"`
	UserAgent  string           `json:"user_agent,omitempty"`
	LongTasks  []clientLongTask `json:"long_tasks"`
}

type sessionActivityTransportStats struct {
	ActiveConnections   int     `json:"active_connections"`
	ConnectionsTotal    int64   `json:"connections_total"`
	ReconnectsTotal     int64   `json:"reconnects_total"`
	ReplayEvents        int64   `json:"replay_events"`
	ReplayBytes         int64   `json:"replay_bytes"`
	LiveDurableEvents   int64   `json:"live_durable_events"`
	LiveTransientEvents int64   `json:"live_transient_events"`
	LiveBytes           int64   `json:"live_bytes"`
	ResyncsTotal        int64   `json:"resyncs_total"`
	LatencySamples      int64   `json:"latency_samples"`
	LatencyTotalMS      float64 `json:"latency_total_ms"`
	LatencyMaximumMS    float64 `json:"latency_maximum_ms"`
}

type performanceDiagnosticsStore struct {
	sync.Mutex
	records           []clientPerformanceRecord
	stream            sessionActivityTransportStats
	seenStreamClients map[string]struct{}
	streamClientOrder []string
}

func (api API) saveClientPerformanceHandler(w http.ResponseWriter, r *http.Request) {
	var request clientPerformanceRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	request.Route = strings.TrimSpace(request.Route)
	request.SessionID = strings.TrimSpace(request.SessionID)
	if len(request.Route) > 512 || len(request.SessionID) > 128 || len(request.LongTasks) == 0 || len(request.LongTasks) > maximumLongTasksPerBatch {
		writeError(w, http.StatusBadRequest, "invalid performance sample")
		return
	}
	for _, task := range request.LongTasks {
		if math.IsNaN(task.StartTime) || math.IsInf(task.StartTime, 0) || task.StartTime < 0 ||
			math.IsNaN(task.DurationMS) || math.IsInf(task.DurationMS, 0) || task.DurationMS < 50 || task.DurationMS > 60_000 {
			writeError(w, http.StatusBadRequest, "invalid long task")
			return
		}
	}

	receivedAt := time.Now().UTC()
	capturedAt := receivedAt
	if request.CapturedAt > 0 {
		capturedAt = time.UnixMilli(request.CapturedAt).UTC()
	}
	record := clientPerformanceRecord{
		CapturedAt: formatAPITime(capturedAt),
		ReceivedAt: formatAPITime(receivedAt),
		Route:      request.Route,
		SessionID:  request.SessionID,
		UserAgent:  strings.TrimSpace(r.UserAgent()),
		LongTasks:  append([]clientLongTask(nil), request.LongTasks...),
	}
	api.performance.Lock()
	api.performance.records = append([]clientPerformanceRecord{record}, api.performance.records...)
	if len(api.performance.records) > maximumClientPerformanceBatches {
		api.performance.records = api.performance.records[:maximumClientPerformanceBatches]
	}
	api.performance.Unlock()
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func (api API) performanceDiagnosticsHandler(w http.ResponseWriter, _ *http.Request) {
	api.performance.Lock()
	records := append([]clientPerformanceRecord(nil), api.performance.records...)
	streamStats := api.performance.stream
	api.performance.Unlock()

	stats := eventservice.SessionActivityStats{}
	if statsService, ok := api.events.(SessionActivityStatsService); ok {
		stats = statsService.SessionActivityStats()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_activity":  stats,
		"stream_transport":  streamStats,
		"client_long_tasks": records,
	})
}

func (p *performanceDiagnosticsStore) streamConnected(clientID string, legacyReconnect bool) {
	p.Lock()
	defer p.Unlock()
	reconnect := legacyReconnect
	if clientID = strings.TrimSpace(clientID); clientID != "" {
		if p.seenStreamClients == nil {
			p.seenStreamClients = make(map[string]struct{})
		}
		_, reconnect = p.seenStreamClients[clientID]
		if !reconnect {
			p.seenStreamClients[clientID] = struct{}{}
			p.streamClientOrder = append(p.streamClientOrder, clientID)
			if len(p.streamClientOrder) > maximumRememberedStreamClients {
				oldest := p.streamClientOrder[0]
				p.streamClientOrder = p.streamClientOrder[1:]
				delete(p.seenStreamClients, oldest)
			}
		}
	}
	p.stream.ActiveConnections++
	p.stream.ConnectionsTotal++
	if reconnect {
		p.stream.ReconnectsTotal++
	}
}

func (p *performanceDiagnosticsStore) streamDisconnected() {
	p.Lock()
	defer p.Unlock()
	if p.stream.ActiveConnections > 0 {
		p.stream.ActiveConnections--
	}
}

func (p *performanceDiagnosticsStore) streamReplay(eventBytes int) {
	p.Lock()
	defer p.Unlock()
	p.stream.ReplayEvents++
	p.stream.ReplayBytes += int64(eventBytes)
}

func (p *performanceDiagnosticsStore) streamLive(eventBytes int, transient bool, latency time.Duration) {
	p.Lock()
	defer p.Unlock()
	if transient {
		p.stream.LiveTransientEvents++
	} else {
		p.stream.LiveDurableEvents++
	}
	p.stream.LiveBytes += int64(eventBytes)
	if latency < 0 {
		latency = 0
	}
	latencyMS := float64(latency) / float64(time.Millisecond)
	p.stream.LatencySamples++
	p.stream.LatencyTotalMS += latencyMS
	if latencyMS > p.stream.LatencyMaximumMS {
		p.stream.LatencyMaximumMS = latencyMS
	}
}

func (p *performanceDiagnosticsStore) streamResync() {
	p.Lock()
	p.stream.ResyncsTotal++
	p.Unlock()
}
