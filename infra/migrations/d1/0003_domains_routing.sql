-- Custom domains and the application address directory (O01, §5.1 step 1, §11 Domains).
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('requested', 'ownership-proven', 'zone-authorized', 'dns-configured', 'inbound-tested', 'outbound-tested', 'active', 'removing', 'removed')),
  verification_token TEXT NOT NULL,
  plus_addressing INTEGER NOT NULL DEFAULT 1,
  catch_all_mailbox_id TEXT,
  last_diagnostics TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per exact address. Aliases live here, not as per-user Email Routing rules.
CREATE TABLE address_routes (
  address TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes (id),
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'alias', 'extension')),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX address_routes_mailbox ON address_routes (mailbox_id);

-- Paid-address reservation and post-cancellation forwarding are independent of an active
-- mailbox subscription (A04, §11 Billing and closure).
CREATE TABLE address_reservations (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('paid-address', 'closure-hold')),
  reserved_until INTEGER,
  forwarding_to TEXT,
  forwarding_verified_at INTEGER,
  forwarding_until INTEGER,
  created_at INTEGER NOT NULL
);
