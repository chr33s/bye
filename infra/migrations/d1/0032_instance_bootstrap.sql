-- First-account bootstrap for self-hosted installations (spec.md §15.11, infra/onboarding).
-- One row at most: the single-use claim of BOOTSTRAP_TOKEN, and the operator it created. An
-- unfinished claim (user_id NULL) can be retaken after a short lease. Expand-only.
CREATE TABLE IF NOT EXISTS instance_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  claimed_at INTEGER NOT NULL,
  user_id TEXT
);
