# Infrastructure runbook

All commands use the pinned CLI through package scripts, which set `ALCHEMY_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 NO_TRACK=1` and run `infra/policies/guard-stage.ts` first. `deploy`, `deploy:plan` and `drift` also build the web client and the MIME container bundle (`pnpm build:deploy`: `build:web` + `build:mime`), because `containers/mime/Dockerfile` copies `dist/server.mjs`. `pnpm dev` runs the stack locally (readme "Local development"; `dev-<id>` stages only). `STAGE=<stage> pnpm logs` reads a deployed stage's Worker logs; add `-- --tail` to follow them.

## Account prerequisites (pre-flight, before the first deploy to an account)

Check each item in the dashboard for the target account (nonprod and prod separately) and record the result in the stage's change log. `check-config.ts` cannot see any of these. First run `pnpm preflight` (`alchemy provider check-env --provider cloudflare`), which confirms the Cloudflare credentials resolve (`✓ Cloudflare`) before anything else runs. Without `--provider` it checks every provider alchemy knows.

- [ ] **Workers Paid** plan: Durable Objects (SQLite), Queues, Workflows, Cron Triggers and Workers Logs persistence need it.
- [ ] **Containers** enabled for the account (Scanner, MIME parser, SigMirror job). Container image pushes go to Cloudflare's registry during `alchemy deploy`; confirm the egress proxy allows them (`infra/policies/egress-proxy.ts`).
- [ ] **`send_email` sender domain:** the transactional sender's domain is onboarded to Email Routing in this account, with the sender address verified; otherwise `TRANSACTIONAL_EMAIL` rejects every message.
- [ ] **Turnstile** available and the deploy token has Turnstile Write (see "First deploy: Turnstile").
- [ ] **Email Routing** permissions (Email Routing Rules Write, Zone Settings Write on `MAIL_ZONE`) are only needed at MX cutover; leave them off the token until then.
- [ ] **workers.dev subdomain** registered (previews and `dev-*` stages serve there).
- [ ] **Custom-domain zones** (`APP_DOMAIN`, `PUBLIC_DOMAIN`, and `PREVIEW_DOMAIN` for previews) are active zones in the account, and the token has Workers Routes Write on them.
- [ ] **GitHub environments** `preview`, `staging-plan`, `staging`, `prod-plan`, `prod` exist; `staging`/`prod` have required reviewers; every environment's deployment branches are restricted to `main` (previews: to PR refs).
- [ ] **Runtime secrets are environment-scoped**, never repository-level, and `preview` holds distinct nonproduction values (see "Previews").

## Bootstrap (foundation, explicit and authorized)

- `Cloudflare.state()` creates the state-store Worker on first use — including from a first `plan`. Bootstrap is a separate operator action with foundation credentials, never a side effect of a preview or CI plan.
- Record: backend contract/version, account, stack `MailboxPlatform`, stage IDs, physical resource mapping, and where the encryption material is escrowed.
- Foundation teardown is never coupled to deleting a preview stage.

## Self-hosted state backend (strict Cloudflare-only profile, §15.7)

The foundation stack `infra/foundation/stack.ts` (`ByeFoundation`) deploys `infra/state/worker.ts`: alchemy's HTTP state contract (v5) served from one SQLite Durable Object, AES-GCM at rest, bearer auth, no outbound network code, and daily encrypted snapshots to the private `StateBackups` bucket.

1. **Generate secrets** into protected config (never the repo): the state tokens (≥32 random bytes each, `pnpm generate:key`), `BYE_STATE_ENCRYPTION_KEY=v1:<64 hex>` and the operator-only `BYE_STATE_ADMIN_TOKEN`. Escrow them. Losing the encryption key makes state unrecoverable.
   - **Prod must not share a state credential with nonprod.** Either run a separate foundation (backend) for prod, or give the backend per-stage grants: `BYE_STATE_TOKEN=prod=<prod token>,staging|preview-*|dev-*=<nonprod token>` (grammar: `parseStateGrants` in `infra/state/core.ts`; a bare token reaches every stage and is for operators only). A request for a stage outside its grant gets 403; whole-stack deletes need an unscoped token.
   - In GitHub, put the nonprod grant in `secrets.BYE_STATE_TOKEN` / `vars.BYE_STATE_URL` (environments `preview`, `staging-plan`, `staging`) and the prod grant only in `secrets.PROD_BYE_STATE_TOKEN` / `vars.PROD_BYE_STATE_URL` (environments `prod-plan`, `prod`). `ci.yml` never maps the prod names into a job where PR code runs.
   - `BYE_STATE_ADMIN_TOKEN` is bound as `STATE_ADMIN_TOKEN` (empty = `/state/admin/*` disabled). It never goes to CI.
2. **Bootstrap** as an operator with foundation credentials: `ALCHEMY_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 NO_TRACK=1 BYE_STATE_DOMAIN=<state host> BYE_SERVICE_ZONE=<zone>[,<zone>…] alchemy deploy infra/foundation/stack.ts --stage foundation`. Every zone listed in `BYE_SERVICE_ZONE` gets the custom WAF rules and the auth-path rate-limiting rule (`http_ratelimit` phase; the rule uses the 10-second period every plan accepts, raise it on Pro/Business zones). The foundation stack keeps its own state in local `.alchemy/`, not in any Cloudflare state Worker. Archive that directory with the escrowed secrets.
3. **Verify:** `curl https://<state host>/version` returns `{"version":5}`, and `/state/stacks` without the token returns 401.
   - Set the repository variable `BYE_DEPLOY=true` once the `preview` environment holds these values: the `preview`, `preview-destroy` and `steady` jobs in `ci.yml` are skipped until then (a job-level condition cannot read environment-scoped variables).
4. **Switch the application stack:** set `STATE_BACKEND=http`, `BYE_STATE_URL=https://<state host>` and `BYE_STATE_TOKEN` in the CI environments (prod: the `PROD_` names, above). To move existing state from the default backend, export it with alchemy's state export under the old backend, then import it with the new one before the first deploy. Confirm that `deploy:plan` shows no changes.
5. **Rotate the encryption key:** set `BYE_STATE_ENCRYPTION_KEY=v2:<new>,v1:<old>` and redeploy the foundation. New writes use v2 and old entries remain readable. Remove v1 only after rewriting every entry, which re-running a no-op deploy does.
6. **Restore:** snapshots live at `StateBackups/snapshots/<ISO time>.json`. Entries in them stay sealed. Call `StateStoreObject.restore(snapshot)` through a one-off, operator-only script bound to the same DO namespace. It needs the same encryption keys. Afterwards, run `deploy:plan` for every stage and confirm there are no unexpected changes.

## Deploy

### Cloudflare deployment token

`CLOUDFLARE_API_TOKEN` is Alchemy's control-plane credential. It is used to create and update
Cloudflare resources; it is never bound into a Worker. Use a scoped API token, restrict it to the
Cloudflare account used by this deployment, and use separate tokens for production and
nonproduction accounts. Cloudflare's dashboard may label permissions **Edit** where API docs or
older screens say **Write**.

For the application stack, grant these account permissions:

| Permission               | Used for                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account Settings Read    | Cloudflare account discovery by the provider.                                                                                                                                                                 |
| Workers Scripts Write    | MailCore, PublicSite and SigMirror Workers, including their bindings, Durable Objects and Workflows.                                                                                                          |
| Workers KV Storage Write | The ConfigCache namespace.                                                                                                                                                                                    |
| D1 Write                 | The Directory database.                                                                                                                                                                                       |
| Workers R2 Storage Write | Mail, export, published-content and ClamAV-signature buckets.                                                                                                                                                 |
| Queues Write             | Mail processing and dead-letter queues and consumers.                                                                                                                                                         |
| Containers Write         | Scanner, MIME parser and signature-update containers.                                                                                                                                                         |
| Turnstile Write          | The signup widget, when `APP_DOMAIN` is configured.                                                                                                                                                           |
| Secrets Store Write      | Default state backend only: `Cloudflare.state()` bootstraps a secrets store. Without it, bootstrap fails with a bare `Unauthorized: Authentication error` (code 10000). Not needed with `STATE_BACKEND=http`. |

The Worker `send_email` binding is part of the Worker deployment. The separate Email Sending API
permission applies when calling Cloudflare's REST email API directly; this stack does not call that
API.

Add only the following permissions when deploying those optional resources:

| Permission                                        | Scope and condition                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers Routes Write                              | Zone permission for each zone receiving a Worker custom domain (`APP_DOMAIN` or `PUBLIC_DOMAIN`). Cloudflare requires it when adding or changing Worker routes or custom domains. |
| Email Routing Rules Write and Zone Settings Write | Zone permissions for `MAIL_ZONE` when enabling Email Routing and its catch-all rule (`BYE_MX_CUTOVER=approved`).                                                                  |
| Zone Read                                         | The existing service zone named by `BYE_SERVICE_ZONE`, when deploying the foundation stack.                                                                                       |
| Account Rulesets Write (or Account WAF Write)     | Account permission for the foundation stack's zone WAF ruleset.                                                                                                                   |

Limit zone-scoped permissions to the specific app, public, and mail zones in use. Do not grant
Global API Key access, token-management permissions, or broad DNS write to this deployment token.
Customer-domain onboarding and public-site cache purges use separate Worker secrets: `CF_DNS_API_TOKEN`
needs only DNS Write on the customer zones it manages, and `CF_CACHE_PURGE_TOKEN` needs Cache Purge
on the public zone. See [Cloudflare's API token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), and [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/).

This list follows the current resource declarations. Alchemy or Cloudflare API changes can require
additional permissions; validate a new token with a nonproduction deployment before using it for
production.

1. `pnpm verify` (versions, boundaries, typecheck, tests including the parity ledger).
2. `STAGE=<stage> pnpm deploy:plan` to read the plan. For the gate, export and check it exactly as CI does: `pnpm build:deploy && node --experimental-strip-types infra/policies/plan-export.ts plan-out deploy`, then `pnpm check:plan --mode deploy plan-out/plan-export.json`. Destructive changes to D1/R2/DO/Workflows/email routing/state need an entry in `infra/policies/decommissions.json` (stage, logicalId, action, approver, ticket).
3. `STAGE=<stage> pnpm run deploy`. Production deploys only from CI (`environment: prod`, approval required, one writer per stage via `concurrency` and the state-backend lease, kept alive by `lease.ts heartbeat` and re-checked with `lease.ts renew` before each write).
   - **Canary:** `release-deploy` deploys MailCore at `canary_percent`, reads the new version id from the stage output (`infra/state/output.ts`), and runs the probes with `Cloudflare-Workers-Version-Overrides` pinned to it, then promotes to 100 or rolls back to 0. The first release of a stage (no `release-<stage>-*` tag yet) and any Durable Object class-migration change deploy at 100%. A promoted release pushes the tag `release-<stage>-<run id>`, which is the next release's changed-files baseline.
   - The release fails before deploying when `PROBE_TOKEN` or `vars.APP_ORIGIN` is empty, so a misconfigured probe can never roll back a healthy release.
4. Smoke: HTTP health, one synthetic ingress through queue → DO commit, a DLQ probe, a Workflow checkpoint/resume.
5. Deploy the same commit twice; the second plan must show no replacement of persistent resources. CI does this on every push to `main` in the `steady` job, on an ephemeral `dev-<run id>` stage.

## State backup and recovery

- State is privileged operational data, separate from user data and exports. Keep encrypted checkpoints and the manifest per release (CI uploads `release-manifest.json` with the `release-<stage>-<sha>` artifact).
- A manifest alone cannot restore encrypted state or mailbox data. Rehearse restore/adoption against the pinned backend each quarter.
- Lost operator session / interrupted deploy: follow "Interrupted deploy" below. Never hand-edit state.
- Inspect state read-only with the raw CLI (the scripts don't wrap it): `pnpm exec alchemy state list [path]` and `pnpm exec alchemy state read <path> [--recursive]`. Set the telemetry opt-outs first.
- Retained resources: `prod`/`staging` data resources use `retain`, so removing or replacing them leaves the cloud resource in place. Such a resource is cleaned up only through an approved decommission (`infra/policies/decommissions.json`). Delete the cloud resource in the dashboard, then drop its record with `pnpm exec alchemy state delete <path>`, which deletes state records only and never cloud resources. `state delete` is the one sanctioned state edit, and only for a record whose resource is already gone.

## Interrupted deploy (failed-deploy recovery, §13)

Rehearsed by `infra/drills/failed-deploy.ts` (see `infra/drills/FAILED_DEPLOY.md`); CI runs it in `infra/tests/failed-deploy-drill.test.ts`.

1. **Stop.** Do not start another deploy to the stage. The crashed run's writer lease still blocks every other CI writer, by design.
2. **Identify.** Record the failed run's ID, commit, lease holder (`gha-<run id>`) and release manifest. `GET /state/stacks/MailboxPlatform/stages/<stage>/resources` shows which resources exist; entries left `creating` are the half-applied ones.
3. **Recover the lease.** Once you are certain the runner is dead, release it as the recorded holder: `node --experimental-strip-types infra/state/lease.ts release MailboxPlatform <stage> gha-<run id>`. Or let it expire: a live job renews it every 5 minutes (`lease.ts heartbeat`), so a dead runner's lease lapses within its 60-minute TTL. A release by any other holder is refused.
4. **Re-plan the same commit.** From the recorded commit (release: the approved manifest), run `plan-export` → `check:plan`.
   - Expect creates for missing resources and in-place resumes or updates for half-applied ones.
   - **Any `replace` or `delete` of a persistent type (D1, R2, DO namespace, Workflows, queues, email routing, state) is a stop**: it needs a decommission record and a separate review, never a retry.
   - For prod, release-deploy re-verifies the manifest against this plan, so a drifted input fails here.
5. **Re-deploy** through the normal pipeline (re-run the failed job). Then confirm a second `deploy:plan` is a no-op (the CI `steady` invariant) and run `infra/probes/run.ts`.
6. **Data.** Code/infra recovery doesn't roll back D1 or object data. If the crash happened after a migration step, readers already support N-1 (`adversarial-migrations-compat.test.ts`). Re-run the failed deploy rather than rolling back code across a migration.

## Onboarding installations (spec.md §15.11)

Installations created by `infra/onboarding` run the same stack with `BYE_WORKERS_DEV_NAME` set, in the operator's account, with `Cloudflare.state()` state there.

- **Never change `BYE_WORKERS_DEV_NAME`** for an existing installation. It fixes the Worker names, and a rename replaces the Workers and their Durable Object data.
- **Interrupted onboarding deploys** follow "Interrupted deploy" above. The onboarding service marks the operation `interrupted`, and a retry re-plans against the recorded state. Any `replace` or `delete` of a persistent type stops it.
- **First account:** the one-time setup link (`BOOTSTRAP_TOKEN`) creates the first user, who becomes an operator. It stops working once any user exists. To add more operators, use `OPERATOR_USER_IDS`.
- **Disconnect** removes the service's credentials only. To take over management, use a scoped deployment token in the operator's account and the installation's recorded stage and generated secrets. The operator's one-time recovery kit (`bye.recovery-kit.v1`) holds that configuration and those secrets. The onboarding store keeps a sealed copy, so also escrow `BYE_ONBOARDING_KEYS`.

## Provider sent-email previews (§10)

The sending providers' dashboards can keep and show message content ("sent email previews" / "activity content"). No provider API toggles this, so it is a console step for each provider account and stage:

1. In each approved provider's console (personal mail, subscription mail, forwarding), turn off storing and showing sent-message content, keeping metadata only.
2. Record the setting, date and operator in the stage's change log.
3. Set `PROVIDER_SENT_PREVIEWS=disabled` in the stage's protected environment variables (`vars`).
   `infra/policies/check-config.ts` refuses a staging or prod deploy that holds any mail credential without this attestation. The policy source is `PROVIDER_PREVIEW_POLICY` in `packages/platform-cloudflare/src/control/sending.ts`. Re-check after every provider plan or account change.

## Drift

- `.github/workflows/drift.yml` runs every Monday (and on demand) for `staging` and `prod` with the read-only `<stage>-plan` credentials, behind the egress proxy with the telemetry opt-outs. It uploads `STAGE=<stage> pnpm drift` (`alchemy drift`, read-only, never `--repair`) and fails when the plan of `main` against the deployed stage is not all no-op (`check:plan --mode drift`).
- Locally: `STAGE=<stage> pnpm drift`. Console changes are reconciled into code or reverted; they never become invisible drift.
- Runtime-managed customer email routing rules are application-owned and must not be "fixed" by IaC.

## Previews

- Stage `preview-<PR number>`: isolated D1/R2/queues/DOs/Workflows/secrets; synthetic data; no MX routing, customer domains, payment webhooks, or production session keys.
- Hosts: each preview gets `pr-<n>.<PREVIEW_DOMAIN>` (MailCore custom domain, `APP_ORIGIN`, probe base URL) and `render-pr-<n>.<PREVIEW_DOMAIN>` as its render origin; the public site stays on workers.dev. `vars.PREVIEW_DOMAIN` must be a zone in the nonprod account; without it the preview refuses to deploy (empty `APP_ORIGIN`). The render host is not served on previews (MailCore has one custom domain), so rendered-message links are not exercised there.
- Secrets on previews: the `preview` and `preview-destroy` jobs run PR-head code (install scripts, `check-config.ts`, `build:deploy`, `deploy`), so every value they can resolve is readable by any same-repository PR author. Runtime application secrets (`SESSION_KEY`, `PROXY_SIGNING_KEY`, `PROBE_TOKEN`, the webhook secrets, `SIGMIRROR_WRITE_TOKEN`, `TURNSTILE_SECRET`, and every optional secret such as `OPS_TOKEN`, `CF_DNS_API_TOKEN`, `CF_CACHE_PURGE_TOKEN`, `ARC_SIGNING_KEY`, `SRS_SECRET`, `EXTERNAL_IDENTITY_SEAL_KEY`, push and provider API keys) must be **environment secrets only** (on `preview`, `staging-plan`, `staging`, `prod-plan`, `prod`), never repository-level or organization secrets, and the `preview` environment must hold distinct, preview-only values (never a staging/prod value). `ci.yml` maps only the required secrets and the sandboxed `SEND_EVENTS_WEBHOOK_SECRET` into the preview env and pins every other optional secret to `""` (`previewSecretOverreach`, `infra/tests/check-config.test.ts`); leave those names unset in the `preview` environment. Workflow edits in a PR can still name any secret the job can resolve, so the hosted scoping is the actual control: audit it (Settings → Secrets and variables → Actions → Repository secrets must list none of the runtime names) when setting up and after each rotation.
- Turnstile on previews: each preview creates its own widget for its host, so set the preview environment's `TURNSTILE_SECRET` to Cloudflare's always-pass test secret (`1x0000000000000000000000000000000AA`); never a real secret.
- Mail sandbox: every ephemeral stage (`preview-*`, `dev-*`) that holds a mail credential must set `MAIL_SANDBOX_DOMAINS` (the disposable test domains it may mail). `check-config.ts` refuses the deploy otherwise, and the CI `preview` and `steady` jobs map it from `vars.MAIL_SANDBOX_DOMAINS`.
- Cleanup: `STAGE=preview-<n> pnpm destroy:preview`. The guard refuses `prod`/`staging`. The script passes `--yes` so CI can run it headlessly, so review the deletion set first, as CI does: `node --experimental-strip-types infra/policies/plan-export.ts plan-out destroy`, then `pnpm check:plan --mode destroy plan-out/plan-export.json`.

## Rollback

- Roll back code only within schema/namespace compatibility (readers support the prior version for the rollback interval).
- Code rollback does not roll back D1 or object data. Never replay already accepted sends; stop new bad work (pause consumers, disable routes) and reconcile.
- DO class removal/rename or Workflow retirement needs a manifest step in `infra/migrations/durable` plus a decommission record; old Workflow instances must finish first.

## Newsletters (spec.md §5.5)

- **Enable:** set `NEWSLETTER_PROVIDER=resend`, `NEWSLETTER_ACCOUNT`, `NEWSLETTER_API_KEY` and `NEWSLETTER_WEBHOOK_SECRET`. Point the Resend webhook at `/webhooks/newsletter`. Nothing dispatches until `NEWSLETTER_QUALIFIED` names this stage's qualification evidence (`infra/EVIDENCE.md` #1).
- **Disable:** clear `NEWSLETTER_QUALIFIED`. New audiences, additions, drafts and sends stop. Removal sync, event intake, reconciliation and cancellation of submitted broadcasts continue. Disabling never cancels provider-side work; cancel each publication explicitly.
- **Held or unknown work:** the cron logs `newsletter.review` and emits `newsletter.ops.unknown`, `newsletter.ops.held`, `newsletter.sync.lag_ms`, `newsletter.event.lag_ms` and `newsletter.cancel.uncertain`.
  - Inspect with `GET /v1/operator/newsletters/:handle`.
  - Check the provider dashboard for the broadcast named after the publication ID.
  - Resolve with `POST /v1/operator/newsletters/:handle/resolve` (`opId`, `resolution`, `note`, optional `providerRef`), then the publication resumes from its recorded outcomes. Never re-send to resolve uncertainty, and never fail over to another provider.
- **Provider replacement:** a creator mapped to another provider/account is blocked until it is reconciled. Finish or cancel open publications, then sync removals.
- **Unmapped events:** rows in `newsletter_events` with state `unmapped` are kept for review. Applied events are pruned after 90 days; this period is pending the retention decision.

## First deploy: Turnstile (two phases)

`TURNSTILE_SECRET` is required config, but the `SignupChallenge` widget that issues it is created by the same stack when `APP_DOMAIN` is set. On a stage's first deploy:

1. **Phase 1:** set `TURNSTILE_SECRET` to Cloudflare's always-fail test secret (`2x0000000000000000000000000000000AA`) so signup stays closed, and deploy. The stack creates the widget (retained on persistent stages) and reports `turnstileSitekey` in its output.
2. Copy the widget's secret from the dashboard (Turnstile → the `SignupChallenge` widget → Settings) into the stage's protected `TURNSTILE_SECRET`, and put `turnstileSitekey` into the web client (`apps/web/public/index.html`).
3. **Phase 2:** deploy again (a normal release). Verify one signup end to end. From then on, rotating the widget secret is "Secret rotation" below.

## MX cutover

Referenced by `infra/stack.ts` and the onboarding guide. Enabling Email Routing takes over the zone's MX records, so it is a separate, reviewed step. **Keep `BYE_MX_CUTOVER` unset for the first prod deploy**; the stack never touches MX until it is `approved`.

1. **Lower TTLs** (at least 48 hours ahead): MX, SPF (`TXT`), DKIM and DMARC records of `MAIL_ZONE` to 300 s. Record the old values for rollback.
2. **Pre-checks on staging:** inbound on a staging mail zone end to end (MX → Email Routing → MailCore → journal → mailbox), outbound transactional and personal sends, bounce handling, forwarding with SRS/ARC. `infra/EVIDENCE.md` items #2–#4 closed.
3. **Records to publish** (in the order below, on `MAIL_ZONE`):
   - **SPF:** one `TXT v=spf1 include:_spf.mx.cloudflare.net ~all` (covers Email Routing and Email Service sending, which also carries personal mail; merge with existing senders; never two SPF records; stay under 10 DNS lookups).
   - **DKIM:** `<selector>._domainkey` `TXT` with `v=DKIM1; k=rsa; p=<MAIL_DKIM_PUBLIC_KEY>` for Bye-signed mail, plus each provider's own DKIM records. Set `MAIL_DKIM_PUBLIC_KEY` in the stage config so the domain workflow publishes the same key for customer zones.
   - **DMARC:** `_dmarc` `TXT v=DMARC1; p=none; rua=mailto:<reports address>` first; move to `quarantine`/`reject` only after two weeks of clean aggregate reports.
   - **MTA-STS:** `_mta-sts` `TXT v=STSv1; id=<date>` and the policy at `https://mta-sts.<zone>/.well-known/mta-sts.txt` with `mode: testing`, `mx: route1.mx.cloudflare.net` (and the other Cloudflare MX hosts), `max_age: 86400`; switch to `mode: enforce` after a clean week. Add `_smtp._tls` `TXT v=TLSRPTv1; rua=mailto:<reports address>`.
4. **Cut over:** grant the deploy token Email Routing Rules Write and Zone Settings Write on `MAIL_ZONE`, set `BYE_MX_CUTOVER=approved` in the stage's protected vars, and run a release. The stack enables Email Routing (which publishes Cloudflare's MX records) and the catch-all to MailCore.
5. **Verify:** `dig MX <zone>` shows only Cloudflare MX hosts; send from Gmail, Outlook and Apple Mail and confirm arrival, threading and `Authentication-Results` (SPF/DKIM/DMARC pass); a DMARC aggregate report arrives within 48 hours; check the DLQ and `ingress` metrics for rejects.
6. **Rollback:** unset `BYE_MX_CUTOVER` and release (the stack stops managing routing; the resources are retained, so disable Email Routing in the dashboard if needed), then restore the recorded MX records. Mail accepted by MailCore stays in the journal. With the lowered TTL, senders switch back within minutes. Restore normal TTLs (3600 s+) only after a stable week.

## Incoming email for an onboarding installation

The zone chosen during Cloudflare onboarding (`INSTALL_ZONE_NAME`/`INSTALL_ZONE_ID`/`INSTALL_ACCOUNT_ID`) becomes a customer domain only when the owner chooses **Review mail setup** (`POST /v1/domains/from-installation`, operator + org admin + step-up). Onboarding established that the account holds the zone, so the domain starts at `ownership-proven`, and it can never be re-linked to another zone. Skipping it leaves the app fully usable; mail on the zone is shown as "Incoming email not set up" until the domain is `active`.

- **Review:** `GET /v1/domains/:id/dns` returns the current MX/provider, the proposed changes (`planMailDns`) and a classification: `new`, `existing-provider` (foreign MX, or Cloudflare Email Routing whose catch-all or address rules forward elsewhere — or whose rules Bye can't read) or `conflicted` (several SPF records, DKIM selector in use). With zone access it reads the authoritative zone records and routing rules, otherwise public DNS. Nothing is written.
- **Cutover:** `POST /v1/domains/:id/authorize-zone` records the current MX, SPF, DKIM, DMARC and (with zone access) the full Email Routing state, including the exact catch-all rule, first. With an existing provider it is refused unless the body carries `confirmCutover: true` ("Switch incoming email to Bye"); only then does the workflow add Bye's MX, then remove the previous provider's, and replace a catch-all that delivers elsewhere. If the provider only shows up after authorization, the domain page shows "Confirm the switch to continue" and the same call (at `zone-authorized` onwards) records the confirmation and restarts setup. Email Routing is enabled only in the inbound step.
- **Workflow restarts:** authorization is recorded on the domain. **Retry checks** / **Restart setup** (`POST /v1/domains/:id/retry`) stops any live instance and starts a fresh one that resumes from the recorded state and authorization; authorize-zone and from-installation also start a fresh instance when the recorded one finished, errored, was stopped or is missing.
- **Permissions:** onboarding's OAuth grant never includes DNS or Email Routing scopes, and the deployed Worker never receives it; Cloudflare OAuth offers no incremental, zone-scoped grant Bye could request at this point. Automation therefore uses a separately created, narrowly scoped Cloudflare API token, in this order: the deployment's `CF_DNS_API_TOKEN` (set through a reviewed deploy), else a token the owner enters under **Let Bye make the changes** (`POST /v1/installation/mail/token`, operator + org admin + step-up). The entered token must grant Zone → DNS → Edit, Zone → Email Routing Rules → Edit and Zone → Zone Settings → Edit on the installation zone only; Bye checks against Cloudflare that it reaches that zone, lists no other zone, and can read its DNS and Email Routing before storing it sealed with `ZONE_TOKEN_SEAL_KEY` (table `installation_zone_token`). It is used only for the installation zone, decrypted per request or Workflow step, and never returned or logged; write permissions are proven on first use. Removing it (`DELETE`, refused while setup is writing through it) returns to **manual-records** mode: the owner publishes the shown records and enables Email Routing with a catch-all to the MailCore Worker in the dashboard, and Bye verifies with a test message. Rotate by entering a new token (it replaces the old one), then revoke the old token in Cloudflare.
- **Verify:** the domain becomes `active` only after the workflow's DNS, inbound and outbound checks pass; failure never affects the application deployment. In manual-records mode MX alone is not enough: the owner sends a message from another mailbox to the domain's `bye-verify-<token>@<zone>` address, and inbound passes only once MailCore receives it (proof the MX, Email Routing and catch-all deliver to Bye). The message is recorded and dropped. With zone access the routing is checked and set through the API.
- **Rollback:** `POST /v1/domains/:id/rollback` (step-up) first checks a restore is possible (recorded snapshot, state, zone access), then stops the workflow (refusing, with nothing restored, if it can't be stopped), and restores through the path the change was made. If Bye wrote through the zone API it recreates the recorded MX before removing its own, restores SPF, the exact catch-all rule (forward, drop or worker) and Email Routing, and removes the DKIM/DMARC records it added. Otherwise the recorded setup stays on the domain (`restore_pending`) and the domain page lists it until the owner clicks "I've restored these"; a new setup attempt reuses it as its snapshot. Mailboxes, address routes and accepted mail are untouched; the domain returns to `ownership-proven` and setup can start again.

## Secret rotation

Rotate on a schedule (at least yearly), on staff change, and immediately on suspected exposure. Always: generate with `pnpm generate:key`, update the protected environment (never the repo), release through CI, verify, then remove the old value. Record each rotation in the stage's change log.

| Secret                                                                              | Procedure                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_KEY`                                                                       | Keyring: set `v2:<new>,v1:<old>` (newest first; a plain value is v1). New sessions, capability links and TOTP seals use v2; v1 still verifies. The daily cron re-seals TOTP secrets (`rotateTotpSeals`); once it logs no more `totp.rotated` and the longest capability/session TTL has passed, set `v2:<new>` alone. |
| `PROXY_SIGNING_KEY`                                                                 | Signs image-proxy URLs in rendered mail. Replace and release; links minted with the old key stop loading images (re-render fixes them). Rotate off-peak.                                                                                                                                                              |
| `PROBE_TOKEN`                                                                       | Replace in every environment that probes (CI secret and Worker binding are the same value), release, and confirm the next probe run passes.                                                                                                                                                                           |
| `OPS_TOKEN`                                                                         | Replace, release, update the operators' tooling. Old token stops working at deploy.                                                                                                                                                                                                                                   |
| `SIGMIRROR_WRITE_TOKEN`                                                             | Replace and release; the next mirror job run uses the new value (the job receives it at start).                                                                                                                                                                                                                       |
| `SEND_EVENTS_WEBHOOK_SECRET`, `NEWSLETTER_WEBHOOK_SECRET`, `BILLING_WEBHOOK_SECRET` | Rotate at the provider and here in the same window; deliveries signed with the old secret during the gap are refused and retried by the provider.                                                                                                                                                                     |
| `TURNSTILE_SECRET`                                                                  | Dashboard → widget → rotate secret (Cloudflare keeps the old one valid for a grace period), set the new value, release.                                                                                                                                                                                               |
| `EXTERNAL_IDENTITY_SEAL_KEY`                                                        | Seals stored external-provider credentials: prepend a new version the same way as `SESSION_KEY` when the ring format is supported by the release; otherwise schedule a re-link of external identities.                                                                                                                |
| `NEWSLETTER_API_KEY`, `FORWARDING_API_KEY`, `BILLING_API_KEY`, `LOCATION_API_KEY`   | Create the new key at the provider, set it, release, verify one call, revoke the old key.                                                                                                                                                                                                                             |
| `MAIL_DKIM_PRIVATE_KEY` (with `MAIL_DKIM_PUBLIC_KEY`)                               | Generate a new key pair, publish the new public key under a new selector first, then switch the private key and selector in one release; keep the old record until mail signed with it has aged out.                                                                                                                  |
| `CF_DNS_API_TOKEN`, `CF_CACHE_PURGE_TOKEN`                                          | Roll the token in the Cloudflare dashboard (same scopes), set, release, verify one domain check / purge.                                                                                                                                                                                                              |
| `CLOUDFLARE_API_TOKEN` (NONPROD/PROD)                                               | Create a new token with the same scopes (see "Cloudflare deployment token"), update the GitHub secret, run a plan, then delete the old token.                                                                                                                                                                         |
| `BYE_STATE_TOKEN` / `PROD_BYE_STATE_TOKEN`                                          | Add the new grant next to the old (`prod=<new>,prod=<old>,…`), redeploy the foundation, switch the GitHub secret, then remove the old grant and redeploy.                                                                                                                                                             |
| `BYE_STATE_ENCRYPTION_KEY`                                                          | "Self-hosted state backend" step 5.                                                                                                                                                                                                                                                                                   |
| `BYE_STATE_ADMIN_TOKEN`                                                             | Replace and redeploy the foundation; only operators hold it.                                                                                                                                                                                                                                                          |
| `BYE_ONBOARDING_KEYS`                                                               | Prepend `v2:<hex>`; old sealed records stay readable. Re-escrow the ring.                                                                                                                                                                                                                                             |

## Backups (off-account)

Point-in-time recovery (D1 Time Travel, DO PITR) lasts 30 days and lives in the same account, as do the state snapshots. Keep an off-account copy so an account compromise or loss is recoverable:

1. **Target:** an R2 bucket (or S3-compatible store) in a **separate** Cloudflare account with object lock / versioning, written by a dedicated token that can only put objects.
2. **D1:** `wrangler d1 export <Directory database> --remote --output directory-<date>.sql` weekly (and before every migration release); encrypt (`age -r <escrowed recipient>`) and upload.
3. **R2:** replicate `Originals`, `Parts`, `Exports`, `Published` and the `_erasure/` ledger with R2 Super Slurper / `rclone sync --immutable` into the backup account (erasure deletions are replayed from the ledger after a restore, never skipped).
4. **State:** copy `StateBackups/snapshots/` (already encrypted) and the escrowed foundation `.alchemy/` archive.
5. **Durable Object data** (mailbox metadata) has no export API: it is covered by the in-account PITR only. Record that residual risk; the account-level export workflow (user exports) is the user-facing recovery path.
6. **Restore drill** quarterly into a `dev-*` stage in the nonprod account (`infra/drills/DATA_RESTORE.md`), and record the result.
