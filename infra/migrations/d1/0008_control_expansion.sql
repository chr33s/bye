-- Control-plane expansion (A02, A03, A04, O03, O04, X02, §10 abuse). Expand-only.

-- Commercial lifecycle (A02): processor checkout sessions, an append-only money ledger for credits
-- and refunds, referral codes and redemptions. Entitlements still change only from signed webhooks.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('subscription', 'plan-change', 'short-address')),
  plan TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT 'annual',
  seats INTEGER NOT NULL DEFAULT 1,
  address TEXT,
  referral_code TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired', 'cancelled')),
  provider_session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS checkout_sessions_org ON checkout_sessions (org_id, created_at);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credit', 'refund', 'referral-credit', 'plan-change-requested', 'cancel-requested')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  provider_event_id TEXT,
  actor_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_ledger_org ON billing_ledger (org_id, created_at);

ALTER TABLE entitlements ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS referral_codes_owner ON referral_codes (owner_user_id);

CREATE TABLE IF NOT EXISTS referral_redemptions (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  code TEXT NOT NULL REFERENCES referral_codes (code),
  redeemed_at INTEGER NOT NULL,
  credited_at INTEGER
);

-- Sending abuse controls (§10): windowed counters, suppression list, suspensions, anomaly signals.
CREATE TABLE IF NOT EXISTS sending_counters (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'domain', 'identity', 'platform')),
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  bounced INTEGER NOT NULL DEFAULT 0,
  complained INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);

CREATE TABLE IF NOT EXISTS suppressions (
  address TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('hard-bounce', 'complaint', 'manual', 'unsubscribe')),
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS sending_suspensions (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'domain', 'identity', 'platform')),
  key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lifted_at INTEGER,
  lifted_by TEXT,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS sending_signals (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  signal TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS sending_signals_open ON sending_signals (reviewed_at, created_at);

-- Audited support access (§10): user-consented, time-boxed, read-only; every use is audited.
CREATE TABLE IF NOT EXISTS support_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  reason TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS support_grants_user ON support_grants (user_id, expires_at);

CREATE TABLE IF NOT EXISTS support_sessions (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES support_grants (id),
  operator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Shared resources registry (O03, O04): which shared thread follows a mailbox thread, and which
-- space holds an extension mailbox's common history. Lets a delivery find its shared targets.
CREATE TABLE IF NOT EXISTS shared_thread_registry (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  shared_thread_id TEXT NOT NULL,
  include_future INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id, space_id)
);

CREATE TABLE IF NOT EXISTS extension_spaces (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes (id),
  space_id TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Spaces belong to organizations; membership is mirrored for discovery (the DO stays authoritative).
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  kind TEXT NOT NULL CHECK (kind IN ('team', 'extension')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_org ON spaces (org_id);
