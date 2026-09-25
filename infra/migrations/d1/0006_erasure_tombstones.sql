-- Erasure tombstones (§12): replayed after any restore so erased resources are never resurrected.
-- Expand-only.
CREATE TABLE IF NOT EXISTS erasure_tombstones (
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  erased_at INTEGER NOT NULL,
  PRIMARY KEY (resource_kind, resource_id)
);
