-- Device-authorization grant (DS10, RFC 8628). Expand-only.
-- An input-constrained client obtains a device code and shows a short user code; the user approves
-- it in a signed-in browser. Both codes are stored only as hashes; a code is single-use and expires.
CREATE TABLE IF NOT EXISTS device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id TEXT REFERENCES users (id),
  session_id TEXT,
  interval_s INTEGER NOT NULL,
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_codes_expiry ON device_codes (expires_at);
