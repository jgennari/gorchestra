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
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, updated_at, last_error, disabled_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = excluded.user_agent,
		   updated_at = excluded.updated_at,
		   last_error = NULL,
		   disabled_at = NULL`,
		endpoint,
		p256dh,
		auth,
		strings.TrimSpace(params.UserAgent),
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
		`SELECT endpoint, p256dh, auth, user_agent, created_at, updated_at, last_error, disabled_at
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
		`SELECT endpoint, p256dh, auth, user_agent, created_at, updated_at, last_error, disabled_at
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
	var lastError sql.NullString
	var disabledAt sql.NullString
	var createdAt string
	var updatedAt string

	if err := row.Scan(
		&subscription.Endpoint,
		&subscription.P256DH,
		&subscription.Auth,
		&userAgent,
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
