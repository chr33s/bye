-- Provider acceptance index (§5.2, §5.3): maps provider/acceptance IDs back to send jobs so that
-- asynchronous provider events (webhooks, Cloudflare send events) can resolve outcomes and
-- Unknown submissions. Expand-only.
CREATE TABLE IF NOT EXISTS send_acceptances (
  provider_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  send_job_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS send_acceptances_job ON send_acceptances (mailbox_id, send_job_id);

-- Submissions whose outcome is Unknown, pending provider reconciliation.
CREATE TABLE IF NOT EXISTS send_unknowns (
  mailbox_id TEXT NOT NULL,
  send_job_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT,
  PRIMARY KEY (mailbox_id, send_job_id)
);
