-- Tombstones are re-verified only when something may have resurrected data (§12): after a
-- restore or when a previous replay did not finish. Routine sweeps skip verified tombstones.
-- Expand-only.
ALTER TABLE erasure_tombstones ADD COLUMN verified_at INTEGER;
