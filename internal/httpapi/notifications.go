package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jgennari/gorchestra/internal/notifications"
	"github.com/jgennari/gorchestra/internal/store"
)

type notificationPublicKeyResponse struct {
	PublicKey string `json:"public_key"`
	Supported bool   `json:"supported"`
}

type notificationSubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type deleteNotificationSubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
}

type notificationStateResponse struct {
	Enabled      bool   `json:"enabled"`
	EndpointHash string `json:"endpoint_hash,omitempty"`
}

type notificationTestResponse struct {
	Sent bool `json:"sent"`
}

type notificationDebugResponse struct {
	PublicKeyFingerprint string                                  `json:"public_key_fingerprint"`
	Subscriptions        []notificationDebugSubscriptionResponse `json:"subscriptions"`
	RecentAttempts       []notificationDebugAttemptResponse      `json:"recent_attempts"`
	ClientDiagnostics    []notificationClientDiagnosticResponse  `json:"client_diagnostics,omitempty"`
}

type notificationDebugSubscriptionResponse struct {
	EndpointHash string `json:"endpoint_hash"`
	Origin       string `json:"origin"`
	UserAgent    string `json:"user_agent"`
	LastError    string `json:"last_error,omitempty"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	DisabledAt   string `json:"disabled_at,omitempty"`
}

type notificationDebugAttemptResponse struct {
	ID             int64  `json:"id"`
	EndpointHash   string `json:"endpoint_hash"`
	Origin         string `json:"origin"`
	PayloadKind    string `json:"payload_kind"`
	SessionID      string `json:"session_id,omitempty"`
	EventType      string `json:"event_type,omitempty"`
	HTTPStatus     int    `json:"http_status,omitempty"`
	ResponseStatus string `json:"response_status,omitempty"`
	Error          string `json:"error,omitempty"`
	CreatedAt      string `json:"created_at"`
}

type notificationClientDiagnosticRequest struct {
	CreatedAt        int64           `json:"createdAt,omitempty"`
	UserAgent        string          `json:"userAgent,omitempty"`
	PayloadWebPush   any             `json:"payloadWebPush,omitempty"`
	Declarative      bool            `json:"declarative,omitempty"`
	Badge            json.RawMessage `json:"badge,omitempty"`
	AttentionCount   int             `json:"attentionCount,omitempty"`
	ShowNotification json.RawMessage `json:"showNotification,omitempty"`
	SessionID        string          `json:"sessionID,omitempty"`
	Seq              int64           `json:"seq,omitempty"`
}

type notificationClientDiagnosticResponse struct {
	CreatedAt        string          `json:"created_at"`
	ReceivedAt       string          `json:"received_at"`
	UserAgent        string          `json:"user_agent,omitempty"`
	PayloadWebPush   any             `json:"payload_web_push,omitempty"`
	Declarative      bool            `json:"declarative"`
	Badge            json.RawMessage `json:"badge,omitempty"`
	AttentionCount   int             `json:"attention_count,omitempty"`
	ShowNotification json.RawMessage `json:"show_notification,omitempty"`
	SessionID        string          `json:"session_id,omitempty"`
	Seq              int64           `json:"seq,omitempty"`
}

type notificationClientDiagnosticRecord struct {
	request    notificationClientDiagnosticRequest
	receivedAt time.Time
}

var notificationClientDiagnostics = struct {
	sync.Mutex
	records []notificationClientDiagnosticRecord
}{}

func (api API) notificationPublicKeyHandler(w http.ResponseWriter, r *http.Request) {
	publicKey, err := api.notifications.PublicKey(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, notificationPublicKeyResponse{
		PublicKey: publicKey,
		Supported: true,
	})
}

func (api API) saveNotificationSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	var request notificationSubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	_, err := api.notifications.SaveSubscription(r.Context(), notifications.SubscriptionInput{
		Endpoint:  strings.TrimSpace(request.Endpoint),
		P256DH:    strings.TrimSpace(request.Keys.P256DH),
		Auth:      strings.TrimSpace(request.Keys.Auth),
		UserAgent: r.UserAgent(),
		Origin:    requestOrigin(r),
	})
	if err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, notificationStateResponse{Enabled: true})
}

func (api API) deleteNotificationSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	var request deleteNotificationSubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if err := api.notifications.DeleteSubscription(r.Context(), strings.TrimSpace(request.Endpoint)); err != nil {
		if errors.Is(err, store.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, notificationStateResponse{Enabled: false})
}

func (api API) testNotificationHandler(w http.ResponseWriter, r *http.Request) {
	if err := api.notifications.SendTest(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, notificationTestResponse{Sent: true})
}

func (api API) notificationDebugHandler(w http.ResponseWriter, r *http.Request) {
	state, err := api.notifications.Debug(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	response := notificationDebugResponse{
		PublicKeyFingerprint: state.PublicKeyFingerprint,
		Subscriptions:        make([]notificationDebugSubscriptionResponse, 0, len(state.Subscriptions)),
		RecentAttempts:       make([]notificationDebugAttemptResponse, 0, len(state.RecentAttempts)),
		ClientDiagnostics:    recentNotificationClientDiagnostics(),
	}
	for _, subscription := range state.Subscriptions {
		item := notificationDebugSubscriptionResponse{
			EndpointHash: subscription.EndpointHash,
			Origin:       subscription.Origin,
			UserAgent:    subscription.UserAgent,
			LastError:    subscription.LastError,
			CreatedAt:    formatAPITime(subscription.CreatedAt),
			UpdatedAt:    formatAPITime(subscription.UpdatedAt),
		}
		if subscription.DisabledAt != nil {
			item.DisabledAt = formatAPITime(*subscription.DisabledAt)
		}
		response.Subscriptions = append(response.Subscriptions, item)
	}
	for _, attempt := range state.RecentAttempts {
		response.RecentAttempts = append(response.RecentAttempts, notificationDebugAttemptResponse{
			ID:             attempt.ID,
			EndpointHash:   attempt.EndpointHash,
			Origin:         attempt.Origin,
			PayloadKind:    attempt.PayloadKind,
			SessionID:      attempt.SessionID,
			EventType:      attempt.EventType,
			HTTPStatus:     attempt.HTTPStatus,
			ResponseStatus: attempt.ResponseStatus,
			Error:          attempt.Error,
			CreatedAt:      formatAPITime(attempt.CreatedAt),
		})
	}

	writeJSON(w, http.StatusOK, response)
}

func (api API) saveNotificationClientDiagnosticHandler(w http.ResponseWriter, r *http.Request) {
	var request notificationClientDiagnosticRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	request.UserAgent = strings.TrimSpace(request.UserAgent)
	request.SessionID = strings.TrimSpace(request.SessionID)
	saveNotificationClientDiagnostic(request)
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func saveNotificationClientDiagnostic(request notificationClientDiagnosticRequest) {
	notificationClientDiagnostics.Lock()
	defer notificationClientDiagnostics.Unlock()

	notificationClientDiagnostics.records = append([]notificationClientDiagnosticRecord{{
		request:    request,
		receivedAt: time.Now(),
	}}, notificationClientDiagnostics.records...)
	if len(notificationClientDiagnostics.records) > 20 {
		notificationClientDiagnostics.records = notificationClientDiagnostics.records[:20]
	}
}

func recentNotificationClientDiagnostics() []notificationClientDiagnosticResponse {
	notificationClientDiagnostics.Lock()
	defer notificationClientDiagnostics.Unlock()

	response := make([]notificationClientDiagnosticResponse, 0, len(notificationClientDiagnostics.records))
	for _, record := range notificationClientDiagnostics.records {
		createdAt := record.receivedAt
		if record.request.CreatedAt > 0 {
			createdAt = time.UnixMilli(record.request.CreatedAt)
		}
		response = append(response, notificationClientDiagnosticResponse{
			CreatedAt:        formatAPITime(createdAt),
			ReceivedAt:       formatAPITime(record.receivedAt),
			UserAgent:        record.request.UserAgent,
			PayloadWebPush:   record.request.PayloadWebPush,
			Declarative:      record.request.Declarative,
			Badge:            record.request.Badge,
			AttentionCount:   record.request.AttentionCount,
			ShowNotification: record.request.ShowNotification,
			SessionID:        record.request.SessionID,
			Seq:              record.request.Seq,
		})
	}
	return response
}

func requestOrigin(r *http.Request) string {
	if origin := cleanOrigin(r.Header.Get("Origin")); origin != "" {
		return origin
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return ""
	}
	proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return cleanOrigin(proto + "://" + host)
}

func cleanOrigin(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func formatAPITime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}
