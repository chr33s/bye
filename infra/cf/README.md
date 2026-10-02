# Cloudflare opt-in deployment

Set `BYE_DEPLOY_ENGINE=cf` to select the new deployment path. Unset it to
use the existing Alchemy rollback path. Root deploy/plan/drift/dev/logs/preflight
commands dispatch on this flag; explicit `cf:*` write commands also require it.
No live staging or production deployment has occurred. These stages are new
installations, so they do not need adoption of nonexistent resources.

## First deployment of staging or production

Persistent apply runs through CI or the onboarding service, preserving the shared
stage writer restriction. The commands below describe the reviewed job inputs.
Supply `STAGE`, the selected `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` explicitly. Production and nonproduction accounts remain
separate. Scripts do not automatically load `.env`. Set configuration and secret
inputs before planning, and keep them identical for apply.

```sh
export BYE_DEPLOY_ENGINE=cf STAGE=staging BYE_CF_INITIAL_STAGE=1
export BYE_CF_RESOURCE_MAP=/secure/staging.cf-resources.json
pnpm cf:new-map --initial-stage --out "$BYE_CF_RESOURCE_MAP"
pnpm build:deploy
pnpm cf:plan --initial-stage --out /secure/staging-plan.json
# Review staging-plan.json and its .discovery.json and .approval.json siblings.
pnpm cf:apply --initial-stage --approved-digest <reviewed-digest> --out /secure/staging-release
```

`new-map` creates local deterministic names and pending storage IDs. Discovery
checks live identities and name collisions before approval. Apply recomputes the
approval under the shared writer lease and permits this first-deployment path
only if every planned resource is a create. Provisioning resolves generated IDs
before any Worker build. New Workers require 100% rollout. Existing resources
require identity review/adoption; the initial-stage flag cannot bypass that gate.

Apply requires `BYE_CF_LOCK_URL`, `BYE_CF_LOCK_CREDENTIAL`, `PROBE_BASE_URL`,
the existing mail sandbox/webhook/provider-preview safety gates,
all required runtime values/secrets in `config/runtime.ts`, and
`SIGMIRROR_WRITE_TOKEN`. Set `SCANNER_SIGNATURES=baked` and digest-pinned
`SCANNER_IMAGE`, `MIME_IMAGE`, `SIGMIRROR_IMAGE` already available in the selected
account's registry. Content-addressed images allow final discovery to compare
the approved configuration. Local builds may use Docker contexts, but release
requires pinned images. Static Email Routing/MX changes require a separate
reviewed procedure and are rejected by this release path.

Store the release's `final.cf-resources.json` securely for subsequent releases.
Once deployed, unset `BYE_CF_INITIAL_STAGE`, discover/adopt the actual identities,
and review subsequent plans against that adoption:

```sh
pnpm cf:adopt --resource-map /secure/final.cf-resources.json --out /secure/staging-adoption.json
pnpm cf:plan --resource-map /secure/staging-adoption.json.resources.json --adoption /secure/staging-adoption.json --out /secure/next-plan.json
```

Review artifacts are exclusively created with mode 0600. Use a new output path
for every review. The subject binds source bytes, commit, dependency lock,
migrations, configuration, resource map, discovery, rollout inputs and plan.
Build Output is hashed and checked before upload and trigger reconciliation.
Secrets are uploaded through temporary 0600 files and removed in `finally`.

## Release and recovery

The release provisions reviewed account resources, builds Workers, applies D1
migrations, uploads versions, sets traffic and triggers, reconciles private R2
settings, runs version-pinned Queue/DO/Workflow probes, promotes a successful
canary, then requires a no-op final drift plan. Durable Object lifecycle changes
require acknowledgment and full rollout. Protected persistent identities cannot
be replaced/deleted as part of release.

A failed known canary can restore previous Worker traffic. A lost write response,
a failed new installation, or an unverified delete retains the shared lease and
records an unknown outcome. Re-read live state and reconcile before retrying;
do not release the lease merely to rerun the same command. Evidence records
include build/version identities and the lease ID where applicable. Runtime
trigger/account-setting rollback still requires operator reconciliation.

The operator-owned authority is the typed project in `workers/deploy-lock`.
Bootstrap it separately with an explicit account, `BYE_CF_LOCK_WORKER` and
`BYE_CF_LOCK_DOMAIN`, and independent secrets `LOCK_CREDENTIAL` and
`LOCK_ADMIN_CREDENTIAL` of at least 32 characters. Configure the same authority
for cf and rollback writers. The rollback CI lane reads `BYE_CF_LOCK_URL` and
`BYE_CF_LOCK_CREDENTIAL` from its protected environment; preview/steady jobs use
`NONPROD_CF_LOCK_CREDENTIAL`. Map these to the same nonproduction authority used
by the cf staging lane. A failed rollback retains its lease for reconciliation. It stores non-expiring ownership leases in SQLite
Durable Objects, not a resource state database. CI only receives the writer
credential. Administrative POST `/cf-locks/inspect` and `/cf-locks/recover`
require the separate administrator credential and an exact key, owner, lease ID,
64-character reconciliation digest, ticket and approver. Recovery records an
audit entry and refuses stale ownership. Inspect uses the same review body.

Ephemeral `cf:destroy` requires an explicit resource map, per-resource
`--decommissions` and a reviewed destruction digest; it verifies absence after
every deletion. Persistent destroy is rejected. `cf:foundation --rules <path>`
plans only explicitly adopted Bye-owned rules, checks zone/ruleset identity and
updates individual rules after digest review. Zones and unrelated rules remain
operator owned; no zone creation/deletion is implemented.

## CI and onboarding

The manually dispatched `cf-opt-in.yml` lane selects a reviewed commit, stage,
operation and optional first-deployment flag. Use `initial_stage=true` for the
undeployed staging/production stacks. Protected environment configuration supplies
credentials, maps (or generated initial maps), pinned images, runtime values and
writer authority. Apply requires the reviewed plan digest. Existing workflows
remain available until live acceptance gates pass.

The onboarding executor/review selects cf with explicit opt-in, binds the cf
approval digest, excludes legacy state credentials, and uses a separate
`infra/onboarding/deployer/Dockerfile.cf`. The release-images manual dispatch
input `cf_deployer=true` builds it as the separate `deployer-cf` image; pin that
digest explicitly when qualifying an opt-in onboarding release. Its candidate
OAuth scope matrix has
`verified: false`; persistent hosted onboarding remains blocked until disposable
account install/upgrade/destroy and least-privilege tests verify those scopes.
The default onboarding image remains the rollback image. A first cf onboarding
installation generates an initial map in its private HOME. A successful release
persists its resolved map/adoption for upgrade planning. Failed writes retain
evidence and require reconciliation before another initial-install attempt.

## Contract coverage and outstanding live evidence

Pinned versions are `cf@1.0.0-beta.10`, `cf/config`'s
`@cloudflare/config@0.22.0`, and the locked Vite beta plugin. Typed configurations
cover MailCore, PublicSite, SigMirror and onboarding RenderOrigin, including
SQLite exports, queue/cron triggers, privacy settings, assets, and standard
Container scheduling with existing instance types/limits. The documented unsafe
local DO binding encoding avoids beta.10 emitting a remote self binding.

Discovery covers D1/KV/Queues, private R2 settings, Worker versions/bindings,
DO namespace/storage, Workflow hosts, Container applications, custom domains,
cron and observability. It rejects missing metadata, unstable deployments and
ambiguous ownership. A narrow tested read-only API exception in `metadata.ts`
covers legacy Worker settings/domain/schedule/subdomain/route GETs missing from
the pinned CLI. Arbitrary API writes are not permitted. Unsupported route and
email/widget ownership must be reviewed separately; these are not evidence of
a clean complete migration.

Local tests, builds and dry runs do not prove live identity/data continuity,
Container rollout, OAuth least privilege, foundation no-op behavior, interruption
recovery, onboarding install/upgrade or successful production operation. Complete
those live checks and the specified soak before switching the default engine,
removing Alchemy, archiving state or decommissioning its backend. No Cloudflare
resource write or state retirement has been performed as part of implementation.
