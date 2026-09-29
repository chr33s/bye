-- Push registrations bound to the credential that made them (spec P1.7). Expand-only.
-- `session_id` is the browser session or device session that registered; revoking it (sign-out,
-- device revoke, refresh reuse) deletes its registrations, and a browser session rotation moves
-- them to the successor. NULL for registrations made before this column existed.
-- `apns_sandbox` records the APNs environment the token was issued for (development-signed builds
-- get sandbox tokens): 1 sandbox, 0 production, NULL unknown (the client didn't say; delivery then
-- keeps the old rule of sandbox on `.test` origins).
ALTER TABLE push_devices ADD COLUMN session_id TEXT;
ALTER TABLE push_devices ADD COLUMN apns_sandbox INTEGER;
CREATE INDEX IF NOT EXISTS push_devices_session ON push_devices (session_id);
