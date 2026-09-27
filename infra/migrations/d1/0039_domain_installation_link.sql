-- Incoming-email activation for the onboarding-selected zone (infra/onboarding/spec.md §12–§15).
-- Expand-only: nullable columns on `domains`.
--   install_account_id / install_zone_id: the Cloudflare account and zone the installation was
--     onboarded with; a domain bound to them can never be re-pointed at another zone.
--   cutover_confirmed_at: when an admin explicitly confirmed replacing the current mail provider
--     (foreign MX, or Cloudflare Email Routing forwarding elsewhere).
--   cutover_snapshot: JSON of the pre-cutover MX, SPF, DKIM, DMARC and Email Routing state
--     (including the full catch-all and address rules), kept for "Restore previous mail setup".
--   zone_auth_method: how zone authorization was given (service-zone, delegated-token,
--     manual-records); a restarted onboarding Workflow resumes from it instead of waiting again.
--   mail_write_mode: `api` once Bye itself wrote DNS or Email Routing through the zone API, else
--     `manual`; rollback restores through the same path the change was made.
--   restore_pending: after a manual-records rollback, the recorded setup the customer still has to
--     put back by hand; kept (and reused as the next snapshot) until they acknowledge it.
--   inbound_probe_token / inbound_probe_at: end-to-end inbound check. Mail to
--     `bye-verify-<token>@<domain>` that reaches MailCore through the zone's MX and routing sets
--     inbound_probe_at; without zone API access it is the evidence inbound delivery works.
ALTER TABLE domains ADD COLUMN install_account_id TEXT;
ALTER TABLE domains ADD COLUMN install_zone_id TEXT;
ALTER TABLE domains ADD COLUMN cutover_confirmed_at INTEGER;
ALTER TABLE domains ADD COLUMN cutover_snapshot TEXT;
ALTER TABLE domains ADD COLUMN zone_auth_method TEXT;
ALTER TABLE domains ADD COLUMN mail_write_mode TEXT;
ALTER TABLE domains ADD COLUMN restore_pending TEXT;
ALTER TABLE domains ADD COLUMN inbound_probe_token TEXT;
ALTER TABLE domains ADD COLUMN inbound_probe_at INTEGER;
