-- Identity, credentials, sessions and scoped tokens (§10 Authentication and tenancy).
-- Expand-only: later migrations add columns/tables, never drop or rename.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  primary_address TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  public_key_jwk TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- TOTP secrets are encrypted with a versioned key-encryption key held in Worker secrets.
CREATE TABLE totp_secrets (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  key_version INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_step INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users (id),
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  step_up_at INTEGER,
  rotated_to TEXT,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'cli')),
  label TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate', 'step-up')),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
