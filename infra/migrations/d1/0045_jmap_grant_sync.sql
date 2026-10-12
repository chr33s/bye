-- Pending effective-grant convergence (spec.md §16 A3). Expand-only. A directory change to who
-- may use an organization's mailboxes marks each mailbox here before propagation starts; a row
-- is removed only once that account authority accepted a directory read at least as new as the
-- request, and the cron retries the rest with backoff, so a lost propagation can never leave a
-- removed member with access.
CREATE TABLE IF NOT EXISTS jmap_grant_sync (
  mailbox_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jmap_grant_sync_next ON jmap_grant_sync (next_at);
