-- Reference-aware, delayed blob garbage collection (§12). Expand-only.
-- Producers record intents; the daily sweep deletes only after the delay AND a fresh reference check.
CREATE TABLE IF NOT EXISTS blob_gc_intents (
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  not_before INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleted', 'retained')),
  checked_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, object_key)
);
CREATE INDEX IF NOT EXISTS blob_gc_due ON blob_gc_intents (state, not_before);

-- Explicit pins from holders that reference a blob outside its owning mailbox (shares, exports,
-- published copies). A pinned key is never collected.
CREATE TABLE IF NOT EXISTS blob_pins (
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, object_key, holder_kind, holder_id)
);
