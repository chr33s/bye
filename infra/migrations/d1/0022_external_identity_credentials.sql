-- External send-as credentials (§5.3 ExternalIdentityTransport, E19). Expand-only.
-- Secrets are sealed with a versioned key (AES-GCM); only ciphertext is stored.
CREATE TABLE IF NOT EXISTS external_identity_credentials (
  mailbox_id TEXT NOT NULL,
  address TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'graph', 'http')),
  endpoint TEXT,
  key_version INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (mailbox_id, address)
);
