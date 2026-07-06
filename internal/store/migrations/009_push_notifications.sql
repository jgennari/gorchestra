CREATE TABLE notification_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  last_error TEXT,
  disabled_at DATETIME
);

CREATE INDEX idx_push_subscriptions_disabled_at ON push_subscriptions(disabled_at);
