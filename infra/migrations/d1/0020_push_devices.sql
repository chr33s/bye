-- Push notification devices (§5.1 step 7, E23, C10). Expand-only.
-- Web Push subscriptions (endpoint + p256dh + auth), APNs device tokens, FCM registration tokens.
CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('webpush', 'apns', 'fcm')),
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices (user_id, enabled);

-- At-most-once per device per dedupe key.
CREATE TABLE IF NOT EXISTS push_deliveries (
  dedupe_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (dedupe_key, device_id)
);
