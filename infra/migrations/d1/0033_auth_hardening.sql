-- Authentication hardening and D1 retention (§10, §12). Expand-only.

-- Recovery-code hashes record the SESSION_KEY ring version whose pepper made them, so the key can
-- rotate: existing rows were all made under the single pre-ring key (version 1).
ALTER TABLE recovery_codes ADD COLUMN pepper_version INTEGER NOT NULL DEFAULT 1;

-- Per-user second-factor lockout: failures in the current window, and the lock expiry once the
-- failure budget is spent (control/auth.ts stepUpWithTotp).
CREATE TABLE IF NOT EXISTS auth_lockouts (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER,
  PRIMARY KEY (user_id, kind)
);

-- Retention sweeps (scheduled.ts pruneLedgers) delete in bounded pages by these columns.
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges (expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS device_sessions_expiry ON device_sessions (absolute_expires_at);
CREATE INDEX IF NOT EXISTS device_access_expiry ON device_access_tokens (expires_at);

-- Abandoned signups (an account that never registered a passkey) are found by age.
CREATE INDEX IF NOT EXISTS users_created ON users (status, created_at);
