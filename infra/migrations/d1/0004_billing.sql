-- Entitlements and an idempotent billing ledger updated only by signed processor events (A01, A02).
CREATE TABLE entitlements (
  org_id TEXT PRIMARY KEY REFERENCES organizations (id),
  plan TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT 'annual' CHECK (interval IN ('monthly', 'annual')),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  seats INTEGER NOT NULL DEFAULT 1,
  trial_ends_at INTEGER,
  period_end INTEGER,
  credits_cents INTEGER NOT NULL DEFAULT 0,
  short_address INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE billing_events (
  provider_event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX billing_events_org ON billing_events (org_id, received_at);
