package notifications

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

const foregroundAckTTL = 2 * time.Minute
const maxForegroundAcks = 1024

type acknowledgementKey struct {
	endpoint  string
	sessionID string
	seq       int64
}

// Acknowledge records that this subscription's foreground client has already
// seen this exact event. No lasting presence state or device-wide mute is kept.
func (s *Service) Acknowledge(ctx context.Context, endpoint, sessionID string, seq int64) error {
	endpoint = strings.TrimSpace(endpoint)
	sessionID = strings.TrimSpace(sessionID)
	if endpoint == "" || len(endpoint) > 4096 || sessionID == "" || len(sessionID) > 128 || seq <= 0 {
		return fmt.Errorf("%w: endpoint, session_id, and positive seq are required", store.ErrInvalidArgument)
	}
	subscriptions, err := s.store.ListPushSubscriptions(ctx)
	if err != nil {
		return err
	}
	known := false
	for _, subscription := range subscriptions {
		if subscription.Endpoint == endpoint {
			known = true
			break
		}
	}
	if !known {
		return fmt.Errorf("%w: subscription is not active", store.ErrInvalidArgument)
	}

	now := time.Now()
	s.ackMu.Lock()
	defer s.ackMu.Unlock()
	s.pruneAcknowledgements(now)
	if s.foregroundAcks == nil {
		s.foregroundAcks = make(map[acknowledgementKey]time.Time)
	}
	key := acknowledgementKey{endpoint, sessionID, seq}
	if _, exists := s.foregroundAcks[key]; !exists && len(s.foregroundAcks) >= maxForegroundAcks {
		var oldestKey acknowledgementKey
		var oldest time.Time
		for key, expires := range s.foregroundAcks {
			if oldest.IsZero() || expires.Before(oldest) {
				oldestKey, oldest = key, expires
			}
		}
		delete(s.foregroundAcks, oldestKey)
	}
	s.foregroundAcks[key] = now.Add(foregroundAckTTL)
	return nil
}

func (s *Service) acknowledged(endpoint, sessionID string, seq int64, now time.Time) bool {
	s.ackMu.Lock()
	defer s.ackMu.Unlock()
	s.pruneAcknowledgements(now)
	return s.foregroundAcks[acknowledgementKey{endpoint, sessionID, seq}].After(now)
}

// Caller holds ackMu. Entries also expire when sending, not just receiving ACKs.
func (s *Service) pruneAcknowledgements(now time.Time) {
	for key, expires := range s.foregroundAcks {
		if !expires.After(now) {
			delete(s.foregroundAcks, key)
		}
	}
}
