-- Index of shared-space memberships (§12 erasure coverage, O03/O04). The authoritative membership
-- lives in each SharedSpaceDO; this index lets erasure and account closure find every space a
-- user belongs to without scanning all spaces. Maintained by SharedSpaceDO after each change.
CREATE TABLE IF NOT EXISTS space_memberships (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS space_memberships_user ON space_memberships (user_id);
