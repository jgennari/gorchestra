package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) GetNotificationKeys(ctx context.Context) (NotificationKeys, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT public_key, private_key, created_at, updated_at
		 FROM notification_keys
		 WHERE id = 1`,
	)

	keys, err := scanNotificationKeys(row)
	if err != nil {
		return NotificationKeys{}, err
	}

	return keys, nil
}

func (s *Store) SetNotificationKeys(ctx context.Context, params SetNotificationKeysParams) (NotificationKeys, error) {
	publicKey := strings.TrimSpace(params.PublicKey)
	privateKey := strings.TrimSpace(params.PrivateKey)
	if publicKey == "" {
		return NotificationKeys{}, fmt.Errorf("%w: public_key is required", ErrInvalidArgument)
	}
	if privateKey == "" {
		return NotificationKeys{}, fmt.Errorf("%w: private_key is required", ErrInvalidArgument)
	}

	now := s.now()
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO notification_keys (id, public_key, private_key, created_at, updated_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
		publicKey,
		privateKey,
		formatTime(now),
		formatTime(now),
	); err != nil {
		return NotificationKeys{}, fmt.Errorf("set notification keys: %w", err)
	}

	return s.GetNotificationKeys(ctx)
}

func (s *Store) SavePushSubscription(ctx context.Context, params SavePushSubscriptionParams) (PushSubscription, error) {
	endpoint := strings.TrimSpace(params.Endpoint)
	p256dh := strings.TrimSpace(params.P256DH)
	auth := strings.TrimSpace(params.Auth)
	if endpoint == "" {
		return PushSubscription{}, fmt.Errorf("%w: endpoint is required", ErrInvalidArgument)
	}
	if p256dh == "" {
		return PushSubscription{}, fmt.Errorf("%w: p256dh is required", ErrInvalidArgument)
	}
	if auth == "" {
		return PushSubscription{}, fmt.Errorf("%w: auth is required", ErrInvalidArgument)
	}

	now := s.now()
	origin := strings.TrimSpace(params.Origin)
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, origin, created_at, updated_at, last_error, disabled_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = excluded.user_agent,
		   origin = excluded.origin,
		   updated_at = excluded.updated_at,
		   last_error = NULL,
		   disabled_at = NULL`,
		endpoint,
		p256dh,
		auth,
		strings.TrimSpace(params.UserAgent),
		origin,
		formatTime(now),
		formatTime(now),
	); err != nil {
		return PushSubscription{}, fmt.Errorf("save push subscription: %w", err)
	}

	return s.getPushSubscription(ctx, endpoint)
}

func (s *Store) DeletePushSubscription(ctx context.Context, endpoint string) error {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return fmt.Errorf("%w: endpoint is required", ErrInvalidArgument)
	}

	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}

	return nil
}

func (s *Store) DisablePushSubscription(ctx context.Context, params DisablePushSubscriptionParams) error {
	endpoint := strings.TrimSpace(params.Endpoint)
	if endpoint == "" {
		return fmt.Errorf("%w: endpoint is required", ErrInvalidArgument)
	}

	now := s.now()
	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE push_subscriptions
		 SET disabled_at = ?, last_error = ?, updated_at = ?
		 WHERE endpoint = ?`,
		formatTime(now),
		strings.TrimSpace(params.LastError),
		formatTime(now),
		endpoint,
	); err != nil {
		return fmt.Errorf("disable push subscription: %w", err)
	}

	return nil
}

func (s *Store) ListPushSubscriptions(ctx context.Context) ([]PushSubscription, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT endpoint, p256dh, auth, user_agent, origin, created_at, updated_at, last_error, disabled_at
		 FROM push_subscriptions
		 WHERE disabled_at IS NULL
		 ORDER BY updated_at DESC, endpoint ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list push subscriptions: %w", err)
	}
	defer rows.Close()

	subscriptions := make([]PushSubscription, 0)
	for rows.Next() {
		subscription, err := scanPushSubscription(rows)
		if err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list push subscriptions rows: %w", err)
	}

	return subscriptions, nil
}

func (s *Store) getPushSubscription(ctx context.Context, endpoint string) (PushSubscription, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT endpoint, p256dh, auth, user_agent, origin, created_at, updated_at, last_error, disabled_at
		 FROM push_subscriptions
		 WHERE endpoint = ?`,
		endpoint,
	)

	subscription, err := scanPushSubscription(row)
	if err != nil {
		return PushSubscription{}, err
	}

	return subscription, nil
}

func (s *Store) RecordPushDeliveryAttempt(ctx context.Context, params RecordPushDeliveryAttemptParams) (PushDeliveryAttempt, error) {
	endpointHash := strings.TrimSpace(params.EndpointHash)
	payloadKind := strings.TrimSpace(params.PayloadKind)
	if endpointHash == "" {
		return PushDeliveryAttempt{}, fmt.Errorf("%w: endpoint_hash is required", ErrInvalidArgument)
	}
	if payloadKind == "" {
		return PushDeliveryAttempt{}, fmt.Errorf("%w: payload_kind is required", ErrInvalidArgument)
	}

	now := s.now()
	result, err := s.db.ExecContext(
		ctx,
		`INSERT INTO push_delivery_attempts (
		   endpoint_hash, origin, payload_kind, session_id, event_type,
		   http_status, response_status, error, created_at
		 )
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		endpointHash,
		strings.TrimSpace(params.Origin),
		payloadKind,
		strings.TrimSpace(params.SessionID),
		strings.TrimSpace(params.EventType),
		params.HTTPStatus,
		strings.TrimSpace(params.ResponseStatus),
		strings.TrimSpace(params.Error),
		formatTime(now),
	)
	if err != nil {
		return PushDeliveryAttempt{}, fmt.Errorf("record push delivery attempt: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return PushDeliveryAttempt{}, fmt.Errorf("read push delivery attempt id: %w", err)
	}

	return PushDeliveryAttempt{
		ID:             id,
		EndpointHash:   endpointHash,
		Origin:         strings.TrimSpace(params.Origin),
		PayloadKind:    payloadKind,
		SessionID:      strings.TrimSpace(params.SessionID),
		EventType:      strings.TrimSpace(params.EventType),
		HTTPStatus:     params.HTTPStatus,
		ResponseStatus: strings.TrimSpace(params.ResponseStatus),
		Error:          strings.TrimSpace(params.Error),
		CreatedAt:      now,
	}, nil
}

func (s *Store) MarkNotificationAttention(ctx context.Context, params MarkNotificationAttentionParams) error {
	sessionID := strings.TrimSpace(params.SessionID)
	if sessionID == "" {
		return fmt.Errorf("%w: session_id is required", ErrInvalidArgument)
	}
	if params.Seq <= 0 {
		return fmt.Errorf("%w: seq is required", ErrInvalidArgument)
	}

	now := s.now()
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO notification_attention (session_id, seq, event_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   seq = CASE WHEN excluded.seq > notification_attention.seq THEN excluded.seq ELSE notification_attention.seq END,
		   event_type = CASE WHEN excluded.seq >= notification_attention.seq THEN excluded.event_type ELSE notification_attention.event_type END,
		   updated_at = excluded.updated_at`,
		sessionID,
		params.Seq,
		strings.TrimSpace(params.EventType),
		formatTime(now),
		formatTime(now),
	); err != nil {
		return fmt.Errorf("mark notification attention: %w", err)
	}

	return nil
}

func (s *Store) ClearNotificationAttention(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return fmt.Errorf("%w: session_id is required", ErrInvalidArgument)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM notification_attention WHERE session_id = ?`, sessionID); err != nil {
		return fmt.Errorf("clear notification attention: %w", err)
	}
	return nil
}

func (s *Store) ListPushDeliveryAttempts(ctx context.Context, limit int) ([]PushDeliveryAttempt, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id, endpoint_hash, origin, payload_kind, session_id, event_type,
		        http_status, response_status, error, created_at
		 FROM push_delivery_attempts
		 ORDER BY created_at DESC, id DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list push delivery attempts: %w", err)
	}
	defer rows.Close()

	attempts := make([]PushDeliveryAttempt, 0)
	for rows.Next() {
		attempt, err := scanPushDeliveryAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list push delivery attempts rows: %w", err)
	}

	return attempts, nil
}

func scanNotificationKeys(row rowScanner) (NotificationKeys, error) {
	var keys NotificationKeys
	var createdAt string
	var updatedAt string

	if err := row.Scan(&keys.PublicKey, &keys.PrivateKey, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return NotificationKeys{}, ErrNotFound
		}
		return NotificationKeys{}, fmt.Errorf("scan notification keys: %w", err)
	}

	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return NotificationKeys{}, fmt.Errorf("parse notification keys created_at: %w", err)
	}
	parsedUpdatedAt, err := parseTime(updatedAt)
	if err != nil {
		return NotificationKeys{}, fmt.Errorf("parse notification keys updated_at: %w", err)
	}

	keys.CreatedAt = parsedCreatedAt
	keys.UpdatedAt = parsedUpdatedAt
	return keys, nil
}

func scanPushSubscription(row rowScanner) (PushSubscription, error) {
	var subscription PushSubscription
	var userAgent sql.NullString
	var origin sql.NullString
	var lastError sql.NullString
	var disabledAt sql.NullString
	var createdAt string
	var updatedAt string

	if err := row.Scan(
		&subscription.Endpoint,
		&subscription.P256DH,
		&subscription.Auth,
		&userAgent,
		&origin,
		&createdAt,
		&updatedAt,
		&lastError,
		&disabledAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PushSubscription{}, ErrNotFound
		}
		return PushSubscription{}, fmt.Errorf("scan push subscription: %w", err)
	}

	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return PushSubscription{}, fmt.Errorf("parse push subscription created_at: %w", err)
	}
	parsedUpdatedAt, err := parseTime(updatedAt)
	if err != nil {
		return PushSubscription{}, fmt.Errorf("parse push subscription updated_at: %w", err)
	}

	subscription.CreatedAt = parsedCreatedAt
	subscription.UpdatedAt = parsedUpdatedAt
	if userAgent.Valid {
		subscription.UserAgent = userAgent.String
	}
	if origin.Valid {
		subscription.Origin = origin.String
	}
	if lastError.Valid {
		subscription.LastError = lastError.String
	}
	if disabledAt.Valid {
		parsedDisabledAt, err := parseTime(disabledAt.String)
		if err != nil {
			return PushSubscription{}, fmt.Errorf("parse push subscription disabled_at: %w", err)
		}
		subscription.DisabledAt = &parsedDisabledAt
	}

	return subscription, nil
}

func scanPushDeliveryAttempt(row rowScanner) (PushDeliveryAttempt, error) {
	var attempt PushDeliveryAttempt
	var origin sql.NullString
	var sessionID sql.NullString
	var eventType sql.NullString
	var httpStatus sql.NullInt64
	var responseStatus sql.NullString
	var errorMessage sql.NullString
	var createdAt string

	if err := row.Scan(
		&attempt.ID,
		&attempt.EndpointHash,
		&origin,
		&attempt.PayloadKind,
		&sessionID,
		&eventType,
		&httpStatus,
		&responseStatus,
		&errorMessage,
		&createdAt,
	); err != nil {
		return PushDeliveryAttempt{}, fmt.Errorf("scan push delivery attempt: %w", err)
	}

	parsedCreatedAt, err := parseTime(createdAt)
	if err != nil {
		return PushDeliveryAttempt{}, fmt.Errorf("parse push delivery attempt created_at: %w", err)
	}

	attempt.CreatedAt = parsedCreatedAt
	if origin.Valid {
		attempt.Origin = origin.String
	}
	if sessionID.Valid {
		attempt.SessionID = sessionID.String
	}
	if eventType.Valid {
		attempt.EventType = eventType.String
	}
	if httpStatus.Valid {
		attempt.HTTPStatus = int(httpStatus.Int64)
	}
	if responseStatus.Valid {
		attempt.ResponseStatus = responseStatus.String
	}
	if errorMessage.Valid {
		attempt.Error = errorMessage.String
	}

	return attempt, nil
}
