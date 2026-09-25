-- The domain's CURRENT onboarding Workflow instance (O01). Retries create a new instance; status
-- and zone-authorization events must target it rather than the first instance. Expand-only.
ALTER TABLE domains ADD COLUMN workflow_instance TEXT;
