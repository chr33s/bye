-- Storage accounting beyond the mailbox authority (§12 blob quota): extracted parts, bodies,
-- and retained exports, per owner. Expand-only.
CREATE TABLE IF NOT EXISTS storage_usage (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('mailbox', 'user')),
  owner_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('parts', 'bodies', 'exports')),
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, category)
);
