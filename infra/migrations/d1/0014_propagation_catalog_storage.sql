-- Delayed shared propagation (§6 row 6): one row per (target space, source delivery) until the
-- space has applied the copy. Pending rows are visible to space members ("syncing") and are
-- replayed from source state by the Cron reconciler when their queue message was lost.
-- Expand-only.
CREATE TABLE IF NOT EXISTS shared_propagation (
  event_key TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extension', 'reply')),
  shared_thread_id TEXT,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'dropped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_propagation_pending ON shared_propagation (state, updated_at);
CREATE INDEX IF NOT EXISTS shared_propagation_space ON shared_propagation (space_id, state);

-- Authority storage probe (§12 metadata budget): last measured SQLite size per authority and its
-- level against the budget (ok / alert at 50% / rollover at 70%). Operator-visible.
CREATE TABLE IF NOT EXISTS authority_storage (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ok', 'alert', 'rollover')),
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS authority_storage_level ON authority_storage (level, kind);

-- Catalog backfill (§6 row 3): spaces created before catalog registration. The shard only
-- distributes reconciliation work; any value in [0, 64) is valid.
INSERT OR IGNORE INTO resource_catalog (kind, id, shard, provisioned_at)
  SELECT 'space', id, unicode(substr(id, -1)) % 64, created_at FROM spaces;
