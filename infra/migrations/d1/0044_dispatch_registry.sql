-- Dispatch recovery registry (spec.md §16 C2). Expand-only. Lives in D1, outside every account
-- snapshot, so a point-in-time restore can't forget that a send was attempted:
-- - `send_attempts` is journaled before the provider is contacted; a failed journal write
--   prevents the attempt. Acceptance evidence stays in `send_acceptances` (0023).
-- - `dispatch_holds` stops new attempt admission for an authority while it is restored and
--   reconciled; a restored job's old alarm can't bypass it.
CREATE TABLE IF NOT EXISTS send_attempts (
  mailbox_id TEXT NOT NULL,
  send_job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (send_job_id, attempt)
);
CREATE INDEX IF NOT EXISTS send_attempts_mailbox ON send_attempts (mailbox_id, recorded_at);
CREATE TABLE IF NOT EXISTS dispatch_holds (
  mailbox_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
