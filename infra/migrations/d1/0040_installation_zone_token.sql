-- Installation zone token (infra/onboarding/spec.md §13 fallback). Expand-only. At most one row:
-- a Cloudflare API token the owner created for exactly the installation's zone, validated before
-- it is stored, sealed with ZONE_TOKEN_SEAL_KEY (workers/core/src/zone-token.ts). Never plaintext.
CREATE TABLE IF NOT EXISTS installation_zone_token (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  zone_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  token_iv TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER
);
