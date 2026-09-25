-- Organizations, memberships, mailbox/calendar ownership and audit (§3.2, O02, A01).
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'domain', 'family')),
  seat_limit INTEGER NOT NULL DEFAULT 1,
  reassignment_policy TEXT NOT NULL DEFAULT 'retain' CHECK (reassignment_policy IN ('retain', 'reassign-to-admin', 'forward-then-close')),
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  address TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);

-- Mailbox authority instances. Personal mailboxes have one owner; extensions (shared
-- addresses) grant access through mailbox_access. Family billing never inserts rows here.
CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  owner_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'extension')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at INTEGER NOT NULL
);

CREATE TABLE mailbox_access (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  can_send INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX mailbox_access_user ON mailbox_access (user_id);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_org ON audit_log (org_id, created_at);
