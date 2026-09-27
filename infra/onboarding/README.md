# Cloudflare onboarding service

Implements [`spec.md` §15.11](../../spec.md): an operator connects Cloudflare through Bye's OAuth application, reviews and approves a plan, and Bye deploys the pinned release into the operator's own account. The service then verifies the deployment, hands the instance URL to the native apps, and offers a manual domain/mail guide.

It has not been run against Cloudflare. The acceptance scenarios (OB01–OB10) pass against fakes in `infra/tests/onboarding.test.ts`. The release gates below are still open.

## Run

```sh
BYE_ONBOARDING_ORIGIN=https://onboard.example.com \
BYE_ONBOARDING_DATA_DIR=/var/lib/bye-onboarding \
BYE_ONBOARDING_KEYS=v1:$(openssl rand -hex 32) \
BYE_ONBOARDING_OPERATOR_HEADER=cf-access-authenticated-user-email \
BYE_ONBOARDING_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com \
BYE_ONBOARDING_ACCESS_AUD=<Access application AUD tag> \
CLOUDFLARE_OAUTH_CLIENT_ID=… \
BYE_RELEASE_DIR=/srv/bye-release BYE_RELEASE_VERSION=v1.0.0 \
pnpm onboarding
```

- **`BYE_RELEASE_DIR`** is a clean checkout of the published tag `BYE_RELEASE_VERSION`, with dependencies installed (`pnpm install --frozen-lockfile`). The release identity is the tagged commit plus the lockfile digest. If the checkout moves, every later deploy fails revalidation until the operator approves the new release.
- **`BYE_ONBOARDING_KEYS`** encrypts stored OAuth credentials and generated runtime secrets. It uses the same `v2:<hex>,v1:<hex>` rotation shape as the state backend, and the installation ID is the AAD. Escrow it: losing it loses the generated secrets (`SESSION_KEY` etc.) needed for later upgrades.
- **Operator identity** comes from Cloudflare Access: the service verifies the `Cf-Access-Jwt-Assertion` JWT on every request (RS256 signature against the team's `/cdn-cgi/access/certs` keys, cached; `iss` = the team domain; `aud` = `BYE_ONBOARDING_ACCESS_AUD`; `exp`/`nbf`) and uses its `email`. The identity header named by `BYE_ONBOARDING_OPERATOR_HEADER`, if present, must agree; on its own it is never trusted (`access.ts`). `BYE_ONBOARDING_LOCAL_OPERATOR=<name>` runs a single-operator local instance instead. With no identity proxy in front, local mode makes the peer prove it is the operator: it refuses to start on a non-loopback `HOST`, and at startup prints a per-process bearer token and a one-time login URL (`<origin>/login?code=…`). Opening the URL once sets an authenticated session cookie (always a fresh session; a pre-existing cookie is never promoted), and API clients send `Authorization: Bearer <token>`. Every `/api/*` route and the OAuth callback refuse other peers with 401, even when they forge `Origin`; only the static page and its assets are served without it. Both values die with the process; restart to get a new login link.
- **Host check:** every request's `Host` must equal the host of `BYE_ONBOARDING_ORIGIN` (else 421), so a DNS-rebinding page can't read even the GET routes. A proxy or tunnel in front must forward the public host unchanged; in local mode set the origin to the URL you open (for example `http://localhost:8788`).
- **Network:** the server listens on `127.0.0.1` by default; publish it through a Cloudflare Tunnel protected by the Access application. Set `HOST` (for example `0.0.0.0`) only in Access mode when another trusted proxy must reach it, and never expose the origin without Access in front.
- **Sessions:** the `__Host-` session cookie is HMAC-signed by the server (per-process key), so a client can't choose or plant a session id (session fixation); an unsigned or forged cookie is replaced. The OAuth callback must come from the same session **and** the operator who owns the installation. The service needs HTTPS (or `localhost`).
- **Pending OAuth state** (PKCE verifiers) expires after 10 minutes and is swept at startup, every 10 minutes and on each new authorization.
- **CSP:** the page's script and styles are served same-origin (`/app.js`, `/app.css`); the policy has no `'unsafe-inline'`.
- **Startup:** operations left `queued`/`running` by a previous process are marked `interrupted` and their writer locks released.

## How it maps to the spec

| Spec requirement                                                     | Where                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Alchemy stack, no second resource definition                | `executor.ts`: `plan-export.ts` for plans, `pnpm run deploy` (build, `guard-stage.ts`, `alchemy deploy`) for writes, run inside the release checkout                                                                      |
| One installation per operator/account/stage, bound before writes     | `service.ts` `bind`: records account, stage, Worker names, URLs, `stateRef`, generated secrets. `firstWriteAt` persists before the first apply. Rebinding and account/stage collisions are refused                        |
| Isolated state, credentials, execution                               | State: `Cloudflare.state()` in the operator's account (`stateRef`). Credentials: sealed per installation. Execution: a child process with its own `HOME`, allowlisted env, and domain/mail inputs forced empty            |
| Approval covers account, stage, release, config, actions, migrations | `review.ts` `subjectDigest`. `approvalCovers` re-checks against a fresh plan before every apply. A retry may only continue approved actions (an approved `create` may resume as `update`)                                 |
| Serialized writes, duplicate submissions                             | `store.acquireWriter` (exclusive lock file in `FileStore`). A second `deploy` returns the active operation                                                                                                                |
| Resume, never blind replay or fresh state                            | Reconcile step re-plans after apply and records each action as `completed`/`pending`/`uncertain`. Plan failures stop with the RUNBOOK "Interrupted deploy" procedure                                                      |
| OAuth: server-side exchange, PKCE, session-bound single-use callback | `oauth.ts`. `store.takePending` is an atomic rename                                                                                                                                                                       |
| Scopes, no DNS/Email Routing                                         | `scopes.ts` matrix. Grants with forbidden scopes are refused and revoked. Plan types without verified coverage block persistent stages                                                                                    |
| Disconnect                                                           | `service.disconnect`: blocks writes and refresh, aborts the active child, cancels queued work, deletes credentials, revokes at Cloudflare, reports failures and in-flight uncertainty. Resources and state are left alone |
| No DNS/MX/Email Routing/catch-all changes                            | `review.ts` `PROHIBITED_TYPES` blocks any such plan row. `executor.ts` `FORCED_EMPTY` blanks `MAIL_ZONE`, `BYE_MX_CUTOVER`, domains and DNS tokens                                                                        |
| Health, ready only when checks pass                                  | `health.ts`: discovery documents, OAuth metadata, render-origin isolation, public site, and the existing `infra/probes/run.ts` probes on synthetic data, each with a timeout                                              |
| Native handoff carries only the URL                                  | `service.handoffFor`: `bye://add-instance?url=…` via `@bye/native-shared`, plus a QR code of the bare URL (`qr.ts`, checked bit-for-bit against a reference encoder). The apps already validate and confirm handoffs      |
| Manual domain/mail guide                                             | `guide.ts`. Optional; it never gates readiness                                                                                                                                                                            |

### Stack changes

`BYE_WORKERS_DEV_NAME`, which only onboarding sets, fixes the Worker names so the workers.dev origins are known before the first deploy:

- MailCore is `<name>`, PublicSite `<name>-site`, and the new `RenderOrigin` forwarder `<name>-render`.
- workers.dev stays enabled on persistent stages. Version preview URLs stay off.
- `RenderOrigin` gives the separate render origin (§10) a second hostname without a custom domain. Its only binding is MailCore, which serves just `/render/*` and `/img` on that host.

Unset (every CI-managed stage), the stack is unchanged. `guard-stage.ts` accepts `BYE_DEPLOY_WRITER=onboarding` in place of `CI=true` for shared stages. Production still needs `BYE_RELEASE_MANIFEST_VERIFIED=1`, which the service sets only after the approval digest matches a fresh plan.

### First account and recovery

- **First account:** onboarding generates `BOOTSTRAP_TOKEN` with the other secrets. Once the instance is ready, the operator opens `https://<app>/#bootstrap=<token>`. The token sits in the URL fragment, so it never reaches a server, and the web app drops it from the address bar on load. The instance accepts it once, in place of Turnstile, only while it has no users; the account it creates becomes an operator. The claim is a single D1 row (`0032_instance_bootstrap.sql`, `workers/core/src/bootstrap.ts`). A signup that fails after claiming releases the slot, and a claim abandoned mid-signup can be retaken after five minutes. With the token unset (every CI-managed stage), signup is unchanged.
- **Recovery kit:** after binding, the operator downloads the kit once (`POST /api/recovery-kit`). It holds the account, stage, state reference, URLs, release, and the full stack configuration with the generated secrets, so the installation can be redeployed without this service. It contains no Cloudflare credentials. The service records when it was issued, never its contents, and refuses a second download. Recovery is therefore the operator's: the kit, plus resources and Alchemy state in their own account.

## Provisional decisions

The open decisions in spec.md §14 item 16 are resolved provisionally as follows. Each needs sign-off before release.

- **State backend:** `Cloudflare.state()` in the operator's account, so the operator owns state too. The strict profile's HTTP backend is not offered.
- **Executor location:** the onboarding host, one child process per operation.
- **Stages:** `prod`, `staging`, or a `dev-<id>` trial. `preview-*` belongs to CI.
- **Existing installation:** a first deploy whose plan contains anything but creates is blocked. Onboarding does not adopt another deployment.
- **Upgrades:** no separate upgrade flow. Pinning a newer release makes the next review show its actions and migrations, and the same approval, serialization and recovery rules apply. Nothing upgrades automatically.
- **Health:** the checks above. They say nothing about inbound mail.

## Open before release

- **OAuth client:** Bye's Cloudflare OAuth client registration, redirect URI, and whether a client secret is issued. The endpoints default to the dashboard ones Wrangler uses.
- **Scope verification:** scope IDs follow Cloudflare's OAuth catalog as mirrored in Alchemy (`alchemy/src/Cloudflare/Auth/OAuthScopes.ts`), and every plan type is covered, including R2 (`workers-r2.write`) and the state store's Secrets Store. Every entry is still `verified: false`, so `prod`/`staging` reviews stay blocked until a nonproduction deploy with exactly this set succeeds. Record it below and flip the flags.
- **Token lifetime:** Alchemy's Cloudflare client sends an OAuth access token and an API token identically (`Authorization: Bearer`), so `CLOUDFLARE_API_TOKEN` works as the carrier. Alchemy treats that env token as non-expiring and cannot refresh it. The service therefore refreshes right before each run, and a single plan or deploy must finish within one access-token lifetime (about an hour). Measure a full first deploy, containers included, during the nonproduction run.
- **Account prerequisites:** the Workers plan needed for Containers, Durable Objects and Queues is shown to the operator but not checked by the API.
- **Short addresses on the first account:** addresses of four characters or fewer are a paid product, and signup refuses them without a completed checkout, which a self-hosted instance can't provide. The first account needs a longer address.

## Release record

Fill in after the nonproduction run the spec requires, including recovery from partial provisioning and process loss:

| Field                         | Value           |
| ----------------------------- | --------------- |
| Bye release (tag, commit)     |                 |
| Alchemy version               | `2.0.0-beta.79` |
| Scope set granted             |                 |
| Stage / account class         |                 |
| Partial-provisioning recovery |                 |
| Process-loss recovery         |                 |
| Health results                |                 |
| Date, operator                |                 |
