-- Full-account export requests (A04): one in flight per user and a cooldown between requests,
-- so repeated POST /v1/exports cannot start unbounded concurrent full copies. Expand-only.
CREATE TABLE IF NOT EXISTS account_exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS account_exports_user ON account_exports (user_id, created_at);
