-- Calendar sharing directory (C05). The owning CalendarDO is the authority for grants; this index
-- only lets a grantee discover calendars shared with them. Maintained idempotently from the
-- calendar outbox (`calendar.grant`). Expand-only.
CREATE TABLE IF NOT EXISTS calendar_grants (
  space_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'write')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, calendar_id, grantee_user_id)
);
CREATE INDEX IF NOT EXISTS calendar_grants_grantee ON calendar_grants (grantee_user_id);
