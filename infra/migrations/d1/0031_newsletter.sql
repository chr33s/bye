-- Newsletter provider routing (spec.md §5.5–5.6). Bye's per-creator ledger lives in each WorldDO; these
-- D1 rows only route authenticated provider events to the right creator and persist them before
-- acknowledgement. Expand-only.

-- Provider references owned by a creator: its audience and each broadcast Bye created.
CREATE TABLE IF NOT EXISTS newsletter_refs (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('audience', 'broadcast')),
  ref TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, account, kind, ref)
);
CREATE INDEX IF NOT EXISTS newsletter_refs_run ON newsletter_refs (kind, last_run_at);
CREATE INDEX IF NOT EXISTS newsletter_refs_handle ON newsletter_refs (handle);

-- Which creators synced a contact to the provider (routes account-wide contact events).
CREATE TABLE IF NOT EXISTS newsletter_contacts (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  address TEXT NOT NULL,
  handle TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, account, address, handle)
);
CREATE INDEX IF NOT EXISTS newsletter_contacts_handle ON newsletter_contacts (handle);

-- Authenticated provider events, persisted before the webhook is acknowledged. `received` rows
-- are (re)applied by the reconciler; `unmapped` rows are retained for operator review.
CREATE TABLE IF NOT EXISTS newsletter_events (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  raw_type TEXT NOT NULL,
  scope TEXT,
  address TEXT,
  broadcast_ref TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received', 'applied', 'unmapped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, account, event_id)
);
CREATE INDEX IF NOT EXISTS newsletter_events_state ON newsletter_events (state, received_at);
