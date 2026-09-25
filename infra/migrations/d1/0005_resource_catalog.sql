-- Partitioned catalog of provisioned authorities for independent Cron reconciliation (§6).
-- A catalog entry is provisioned before an address/resource is exposed to traffic.
CREATE TABLE resource_catalog (
  kind TEXT NOT NULL CHECK (kind IN ('mailbox', 'calendar', 'space', 'search', 'ingress', 'world')),
  id TEXT NOT NULL,
  shard INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  next_wake_hint INTEGER,
  provisioned_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX resource_catalog_shard ON resource_catalog (shard, kind, status);
