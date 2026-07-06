UPDATE push_subscriptions
SET disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = 'disabled legacy originless subscription'
WHERE disabled_at IS NULL
  AND (origin IS NULL OR trim(origin) = '');
