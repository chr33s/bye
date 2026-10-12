-- JMAP recovery generations (spec.md §16 C1/C2). Expand-only. A point-in-time restore advances
-- the authority's generation here, outside the snapshot being restored, before the restore runs;
-- state tokens bind it, so a token minted before the restore can never match a rewound revision.
CREATE TABLE IF NOT EXISTS authority_generations (
  kind TEXT NOT NULL CHECK (kind IN ('mailbox', 'calendar', 'space')),
  authority_id TEXT NOT NULL,
  restore_generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, authority_id)
);
