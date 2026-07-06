package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

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
	Enabled bool `json:"enabled"`
}

type notificationTestResponse struct {
	Sent bool `json:"sent"`
}

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
