-- Dead-letter records (§6): messages drained from queue DLQs, kept for operator inspection and
-- validated replay. Queues are not the permanent record; source journals/outboxes are. Expand-only.
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  message_type TEXT NOT NULL,
  event_id TEXT,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'replayed', 'discarded', 'obsolete')),
  resolved_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS dead_letters_state ON dead_letters (state, received_at);
