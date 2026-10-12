-- JMAP PushSubscription (RFC 8620 §7.2; spec.md §16.5, A3). Expand-only. Subscriptions belong
-- to the user and the credential that created them; revoking the credential removes them.
-- A subscription receives StateChange pushes only after its verification code is echoed back.
CREATE TABLE IF NOT EXISTS jmap_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_client_id TEXT NOT NULL,
  url TEXT NOT NULL,
  keys_json TEXT,
  verification_code TEXT NOT NULL,
  verified_at INTEGER,
  expires_at INTEGER NOT NULL,
  types TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmap_push_subscriptions_user ON jmap_push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS jmap_push_subscriptions_session ON jmap_push_subscriptions (session_id);
