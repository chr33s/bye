-- Runtime newsletter provider configuration (infra/onboarding/spec.md §22). An operator connects Resend
-- after deployment; the API key and the webhook signing secret are sealed with
-- NEWSLETTER_CONFIG_SEAL_KEY (AES-GCM, versioned) and never stored in plaintext. One row at most.
-- Expand-only.
CREATE TABLE IF NOT EXISTS newsletter_provider_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  provider TEXT NOT NULL,
  -- Stable local identifier for the provider account; events and refs bind to it.
  account_ref TEXT NOT NULL,
  provider_webhook_id TEXT,
  key_version INTEGER NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  webhook_secret_iv TEXT NOT NULL,
  webhook_secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

-- Provider-side effects whose local persistence failed or whose outcome is uncertain (a webhook
-- created but not recorded, a cleanup that could not be confirmed). Operator-visible; a retry lists
-- the provider's webhooks and reconciles instead of creating duplicates. Holds no secrets.
CREATE TABLE IF NOT EXISTS newsletter_provider_reconcile (
  endpoint TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_webhook_id TEXT,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
