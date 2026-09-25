-- Desktop device sessions (A03/X01; RFC 8252, RFC 7636, RFC 9700). Expand-only.
-- Browser-mediated passkey sign-in issues a single-use authorization code bound to a PKCE
-- challenge; the code is exchanged for a revocable per-device session with a rotating refresh
-- credential and short-lived access credentials. Only hashes are stored.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  client_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS device_sessions_user ON device_sessions (user_id);

CREATE TABLE IF NOT EXISTS device_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES device_sessions (id),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS device_refresh_session ON device_refresh_tokens (session_id);

CREATE TABLE IF NOT EXISTS device_access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES device_sessions (id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_access_session ON device_access_tokens (session_id);
