-- Restore holds record the authority's session epoch once the restore is armed (spec.md §16 C2).
-- Expand-only. The restore-hold sweep reconciles only after that epoch changed (the object is
-- serving the restored storage), so a slow restore is never reconciled against its old state.
ALTER TABLE dispatch_holds ADD COLUMN armed_epoch TEXT;
