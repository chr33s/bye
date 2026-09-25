-- Billing out-of-order guard (A02): compare processor event times with the processor time of the
-- event that produced the current state, never with the local receipt time (`updated_at`).
ALTER TABLE entitlements ADD COLUMN processor_event_at INTEGER;
