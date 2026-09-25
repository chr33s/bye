-- Provider webhook de-duplication (P02, §5.3): a retried delivery of the same event is applied once.
-- Expand-only.
CREATE TABLE IF NOT EXISTS webhook_events (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (source, event_id)
);
