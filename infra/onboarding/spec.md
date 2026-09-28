# Bye: Minimal Cloudflare Onboarding + First-Use Newsletter Configuration

**Status:** Proposed implementation spec  
**Repository:** `chr33s/bye`  
**Baseline reviewed:** `main` at `8641599f4027c53e9a9bf3ca6aca1fb6fe19d9c6`  
**Target UX:** **Cloudflare account → Bye domain → first owner → optional incoming-email activation**  
**Newsletter UX:** Configure only when the newsletter feature is first opened/used.

---

## 1. Objective

Replace the current infrastructure-oriented onboarding flow with a normal-path onboarding experience containing only three required user-facing decisions:

1. **Connect/select a Cloudflare account**
2. **Choose the hostname where Bye will live**
3. **Create the first owner account**

After the first owner is created, Bye immediately offers a separate **incoming email activation** step for the selected root domain. This step is optional and may be completed later. It must never be silently bundled into **Create Bye**, because changing MX / Email Routing can disrupt an existing mail provider.

All infrastructure planning, provisioning, health checks, recovery metadata, and safe-resume behavior remain implemented, but are moved behind the flow rather than presented as mandatory setup screens.

Onboarding is hosted as a Cloudflare Worker, and the Alchemy run executes in a deployer provisioned in the user's own account after authorization (Part J).

Newsletter configuration must not appear during onboarding. When an operator first opens the newsletter feature, Bye prompts for a Resend API key, validates it, provisions the required Resend webhook automatically, stores the credentials encrypted, and then opens the feature.

---

## 2. Product principles

### Normal path

The required user-visible path is:

```text
Continue with Cloudflare
        ↓
Choose account if necessary
        ↓
Choose Bye hostname
bye.example.com
        ↓
Create Bye
        ↓
Provisioning…
        ↓
Create first owner
        ↓
Bye
        ↓
Enable incoming email?   ← optional / can skip
```

Newsletter:

```text
Open Newsletters for the first time
        ↓
Not configured
        ↓
Enter Resend API key
        ↓
Bye validates key + creates webhook
        ↓
Newsletter feature opens
```

### Rules

- No deployment-stage choice in the normal onboarding UX.
- No mandatory pre-flight screen.
- No normal-path deployment-plan review.
- No newsletter setup during onboarding.
- No MX, Email Routing, catch-all, or mail-domain cutover during infrastructure provisioning.
- Incoming-email activation is a distinct, explicit post-owner workflow with review, confirmation, verification, and rollback.
- The first account remains the instance operator and owner of its personal organization.
- Existing deployment safety rules remain authoritative.
- An unexpected or unsafe deployment plan breaks out of the minimal flow and requires explicit review.
- `workers.dev` remains available internally as the stable deployment/fallback surface where currently required, especially for the render origin.

---

## 3. Non-goals

This change does **not**:

- purchase/register a domain on the user's behalf;
- silently change MX records or replace an existing mail provider;
- enable Cloudflare Email Routing during infrastructure provisioning;
- make mail activation mandatory for completing the three-step onboarding flow;
- remove the recovery-kit mechanism;
- remove plan/release/state verification;
- build the entire newsletter authoring product if that UI is not yet exposed;
- remove legacy environment-based newsletter configuration for CI/operator-managed deployments in this release.

If the connected Cloudflare account has no eligible active zone, show a link to Cloudflare to add/register a domain and a **Refresh domains** action. Domain registration itself is outside this flow.

---

# Part A — Cloudflare account → Bye domain → first owner

## 4. Step 1 — Connect Cloudflare

### UI

Initial page:

```text
Set up Bye

Bye runs in your Cloudflare account.

[ Continue with Cloudflare ]
```

No prerequisites list is shown on the main path. A secondary **What Bye creates** disclosure may describe Workers, D1, R2, Queues, Durable Objects, Workflows, Containers, state, one Worker custom hostname, and the deployer Worker + container that runs the installation in the user's account (Part J).

### OAuth

Continue using the existing server-side Cloudflare OAuth + PKCE flow in:

- `infra/onboarding/oauth.ts`
- `infra/onboarding/service.ts`
- `infra/onboarding/server.ts`

After authorization:

- if exactly one eligible account is available, select it automatically and continue;
- if multiple accounts are available, show an account picker on the same flow;
- if no account is available, show a blocking error.

### Scope change

The current onboarding scope policy explicitly rejects zone/custom-domain access. Change it narrowly.

Add:

- `zone.read`
  - purpose: list active zones in the selected account and verify the selected zone still exists;
- `workers-routes.write`
  - purpose: attach/update the selected Worker custom domain.

Continue to forbid:

- `dns-records.write`;
- Email Routing permissions;
- email sending administration permissions;
- zone settings write;
- broad account settings/member/token/billing permissions.

The app-domain operation should rely on the Worker custom-domain mechanism already represented by `APP_DOMAIN`; do **not** grant broad DNS-write access just to create the application hostname.

### Files

Primary changes:

- `infra/onboarding/scopes.ts`
- `infra/onboarding/oauth.ts` if scope validation assumptions require it
- `infra/tests/onboarding.test.ts`

### Release gate

The new scopes must be verified against a real non-production Cloudflare account before persistent-stage release, following the existing onboarding release-record process.

The existing rule remains:

> Documentation does not prove OAuth compatibility; production onboarding stays blocked until the exact scope set has been exercised successfully.

---

## 5. Step 2 — Choose the Bye domain

### Terminology

Use **Bye address** or **Bye hostname** in UI, not "mail domain."

Example:

```text
Where should Bye live?

Domain
[ example.com        ▾ ]

Bye address
[ bye ] . example.com

Your Bye:
https://bye.example.com

[ Create Bye ]
```

Default label: `bye`.

The selected Cloudflare zone is also recorded as the initial **owner address domain**, e.g. `example.com`, but selecting it does **not** activate mail routing.

### Zone discovery

Extend `CloudflareReader` in `infra/onboarding/cloudflare.ts`:

```ts
interface Zone {
  id: string;
  name: string;
  status: string;
}

zones(token: string, accountId: string): Promise<ReadonlyArray<Zone>>
```

Fetch only zones belonging to the selected account. The onboarding UI should show active zones only.

Add an onboarding endpoint equivalent to:

```http
GET /api/zones?accountId=<id>
```

Response:

```json
{
  "zones": [
    {
      "id": "...",
      "name": "example.com"
    }
  ]
}
```

Do not expose the OAuth token.

### Hostname validation

Client validation:

- label is 1–63 lowercase DNS-label characters;
- no leading/trailing `-`;
- default `bye`;
- preview the complete hostname.

Server validation is authoritative.

Server must ensure:

- zone belongs to selected Cloudflare account;
- zone is active;
- hostname is a strict subdomain of that selected zone;
- selected zone/hostname cannot change after the first deployment write;
- hostname is normalized to lowercase without a trailing dot.

Do not require DNS-read scope solely to pre-check records. The actual custom-domain plan/apply remains authoritative for conflicts.

### Atomic target binding

Replace the current user-facing account+stage bind with a single immutable install target.

Suggested service input:

```ts
interface InstallTargetInput {
  accountId: string;
  zoneId: string;
  zoneName: string;
  appHostname: string;
}
```

Internally:

```text
stage = "prod"
```

The normal onboarding UI must not ask for a stage.

Keep `staging` / `dev-*` support only for internal/test/operator pathways if needed.

### Installation record

Extend `Installation` in `infra/onboarding/store.ts` with:

```ts
zoneId: string | null;
zoneName: string | null;
appHostname: string | null;
ownerAddressDomain: string | null;
```

Once `firstWriteAt` is non-null, these are immutable for the standard onboarding flow.

`ownerAddressDomain` initially equals `zoneName`.

### Worker naming

Retain the existing generated Worker name:

```text
bye-<installation-id-prefix>
```

This remains separate from the public custom hostname.

### URL construction

The current onboarding implementation derives the instance URL from `workers.dev`.

Change first-install URL construction to:

```ts
urls.app = `https://${appHostname}`;
```

Continue to derive the render Worker URL from `workers.dev`, unless/until a separate render custom hostname is explicitly designed.

Recommended result:

```text
APP_ORIGIN=https://bye.example.com
APP_DOMAIN=bye.example.com

MAIL_RENDER_ORIGIN=https://<worker>-render.<account>.workers.dev
PUBLIC_DOMAIN=
MAIL_ZONE=
BYE_MX_CUTOVER=
```

The public World worker may remain on its current `workers.dev` address for this change. Do not introduce a second domain decision.

---

## 6. Provision automatically after "Create Bye"

The **Create Bye** click is the user's explicit install intent.

It should trigger:

1. immutable target bind;
2. recovery secret generation;
3. plan generation;
4. plan safety validation;
5. automatic approval only if the plan is a standard clean first install;
6. apply;
7. health checks;
8. redirect to first-owner setup.

### UI

Show progress rather than infrastructure configuration:

```text
Creating Bye at bye.example.com

✓ Preparing your Cloudflare account
✓ Creating Bye
• Connecting bye.example.com
  Checking everything…

[ Details ]
```

`Details` may expose current operation step, health checks, and resource outcomes.

### Do not remove internal review

The current review machinery remains. The change is that a safe standard first install is reviewed by policy automatically after the user has explicitly requested that fixed install.

### Install intent

Persist an `InstallIntent` before planning, bound to:

- installation ID;
- Cloudflare account ID;
- zone ID;
- zone name;
- app hostname;
- fixed stage `prod`;
- pinned release identity;
- timestamp;
- operator identity.

The `Create Bye` action is consent to this exact standard installation target.

### Automatic-approval criteria

A plan may be auto-approved only when **all** are true:

- this is the first deployment (`firstWriteAt === null`);
- there are no review blockers;
- every action is `create`;
- there are no `replace` or `delete` actions;
- no prohibited DNS/MX/Email Routing/zone mutation appears;
- the only custom-domain/route operation is the one implied by the selected `APP_DOMAIN`;
- scope coverage is verified for persistent stages;
- release identity still matches the install intent;
- account/zone/hostname still match the install intent;
- migrations are exactly those expected from the pinned first-install release;
- the normal plan policy passes.

If any condition fails, set an exceptional state:

```text
needs-review
```

and present the existing detailed review UI.

The system must never auto-approve an unexpected resource type merely because it is a `create`.

Maintain a reviewed allowlist for the standard first-install resource graph or derive it from the repository inventory with a test that fails when the graph changes without review.

---

## 7. Custom-domain plan changes

### `infra/onboarding/executor.ts`

Currently `APP_DOMAIN` is forcibly blank.

Change:

- remove `APP_DOMAIN` from `FORCED_EMPTY`;
- keep `PUBLIC_DOMAIN`, `MAIL_ZONE`, `BYE_MX_CUTOVER`, service-zone inputs, customer DNS tokens, and mail-routing inputs empty.

The execution config must explicitly set:

```ts
APP_DOMAIN: installation.appHostname;
APP_ORIGIN: `https://${installation.appHostname}`;
```

### `infra/onboarding/review.ts`

Currently Worker custom domains/routes are prohibited.

Change the boundary:

Still prohibit:

- DNS records;
- zone creation/settings;
- Email Routing;
- catch-all email routing;
- email-address resources;
- customer mail changes;
- unrelated routes/domains.

Permit the resource type(s) produced by the pinned Alchemy release for the selected MailCore custom domain.

Any custom-domain plan row on retry/upgrade remains covered by the same account/zone/hostname configuration digest.

Do not broadly remove `"route"` or `"customdomain"` from prohibition logic without replacing it with a narrow permitted-operation check.

### `infra/onboarding/scopes.ts`

Map the custom-domain resource type to `workers-routes.write`.

`zone.read` covers discovery only and should not authorize a plan write.

---

## 8. Recovery kit

Keep the recovery kit.

Move it out of the critical onboarding path.

The kit may be generated/available once the immutable install target is bound, but the onboarding flow must not block on downloading it.

Update kit contents to include:

```json
{
  "account": { "id": "...", "name": "..." },
  "zone": { "id": "...", "name": "example.com" },
  "appHostname": "bye.example.com",
  "ownerAddressDomain": "example.com"
}
```

Keep the existing guarantee that it contains no Cloudflare OAuth credential.

Expose recovery-kit download later from an operator/admin/recovery screen.

---

## 9. Step 3 — Create the first owner

The existing bootstrap mechanism is retained:

- single-use `BOOTSTRAP_TOKEN`;
- accepted only while there are no users;
- created account becomes a platform operator;
- personal organization membership is created as `owner`;
- abandoned claims retain the existing lease/retry behavior.

### Redirect automatically

After deployment health passes:

```text
https://bye.example.com/#bootstrap=<token>&domain=example.com
```

Both values are in the URL fragment and therefore are not sent in the HTTP request.

The onboarding page should navigate to this URL automatically, with a fallback button:

```text
[ Create your owner account ]
```

### Fix current hostname-derived domain behavior

Current web bootstrap derives the requested address domain from the application hostname:

```ts
location.hostname.replace(/^app\./, "");
```

This fails for the desired hostname `bye.example.com`.

Change bootstrap UI to use the selected `domain` fragment value for display/prefill:

```text
Create your owner account

Address
[ chris ] @ example.com

Name
[ Chris ]

[ Create account with a passkey ]
```

### Server-side enforcement

Do not trust the fragment.

Introduce a non-secret runtime setting generated by onboarding:

```text
BOOTSTRAP_ADDRESS_DOMAIN=example.com
```

Declare it in the Worker environment.

During bootstrap signup:

- normalize the requested address;
- require `domainOf(address) === BOOTSTRAP_ADDRESS_DOMAIN`;
- reject another domain;
- keep existing token and "no users yet" checks.

This setting does not activate MX or Email Routing.

### After signup

On successful bootstrap:

- existing operator creation remains authoritative;
- personal-org membership remains `owner`;
- clear the bootstrap token from browser state as currently done;
- route directly to the main application.

No separate "getting started" screen is required by this spec.

---

# Part B — Incoming email activation after first owner

## 10. Desired UX

Immediately after the first owner account is created, show a non-blocking setup card:

```text
Set up incoming email

Bye is running at bye.example.com.

To receive mail at @example.com, Bye needs to configure
Cloudflare Email Routing and your domain's mail DNS.

[ Review mail setup ]
[ Do this later ]
```

This step is **optional** for completing account setup.

If the user skips it:

- the Bye application remains fully reachable at `https://bye.example.com`;
- the owner can use non-mail features;
- mail addresses on `@example.com` must not be presented as active/receiving;
- the same setup action remains available from admin/domain settings.

Do not make the user re-enter the domain. Use the zone selected during onboarding.

---

## 11. Why mail activation is separate

`Create Bye` provisions application infrastructure and the application hostname.

Mail activation changes the customer's live mail delivery path and may affect:

- Google Workspace;
- Microsoft 365 / Exchange;
- Fastmail;
- another SMTP/mailbox provider;
- existing forwarding;
- existing SPF/DKIM/DMARC policy.

Therefore:

- MX changes require a separate explicit confirmation;
- existing foreign MX records are never replaced silently;
- health of the Bye application does not imply mail readiness;
- failure or cancellation of mail activation must not roll back the working Bye application.

The existing repository domain state machine already models this separation and should be reused rather than reimplemented.

Relevant current implementation:

- `packages/platform-cloudflare/src/control/domains.ts`
- `packages/platform-cloudflare/src/control/onboarding.ts`
- `workers/core/src/workflows/domain.ts`
- `workers/core/src/routes/admin.ts`

---

## 12. Mail activation flow

### State 1 — Inspect

When the owner chooses **Review mail setup**:

1. create or reuse the customer's domain resource for the selected zone;
2. read current DNS/mail state;
3. generate a proposed DNS/routing plan;
4. classify the domain as:
   - **new / no foreign MX**
   - **existing mail provider**
   - **conflicted / unsupported**
5. show the proposed changes before any write.

UI:

```text
Incoming email for example.com

Current mail provider
Google Workspace

Bye proposes:
• Enable Cloudflare Email Routing
• Route incoming mail to Bye
• Update MX records
• Merge Bye into SPF
• Add Bye DKIM
• Keep your existing DMARC policy

No changes have been made yet.

[ Continue ]
[ Cancel ]
```

For a domain with no current MX provider:

```text
No existing mail provider detected.

Bye can configure incoming email automatically.

[ Enable incoming email ]
```

### State 2 — Ownership / authorization

Because onboarding already authenticated the Cloudflare account and selected the zone, do not ask the user to prove control again if the current authorization can securely establish ownership of that exact zone.

Persist an explicit link between:

```text
installation.accountId
installation.zoneId
installation.zoneName
domain resource
```

If authorization no longer reaches the selected zone:

```text
Reconnect Cloudflare to continue mail setup.
```

### State 3 — Explicit cutover confirmation

Before any MX replacement or Email Routing activation, require confirmation:

```text
Switch incoming email to Bye?

Mail sent to @example.com will begin routing to Bye.

Your current provider:
Google Workspace

This changes the domain's MX records.

[ Switch incoming email to Bye ]
[ Cancel ]
```

For foreign MX records, this confirmation is mandatory even if every resulting DNS operation is otherwise safe.

No generic "Approve deployment" language should be shown.

### State 4 — Apply

After confirmation:

1. authorize the zone for the existing `ProvisionDomainWorkflow`;
2. enable Cloudflare Email Routing;
3. configure the catch-all Worker route required by Bye;
4. apply the reviewed mail DNS plan;
5. never overwrite an unreviewed DNS conflict;
6. preserve non-owned DNS records.

Expected records include:

- Cloudflare Email Routing MX;
- SPF merge/update;
- Bye DKIM;
- DMARC creation only if absent, otherwise preserve the existing DMARC policy;
- ownership verification record if still required by the domain state machine.

### State 5 — Verify

Do not mark incoming mail active immediately after DNS writes.

Run:

- ownership DNS check;
- MX check;
- SPF check;
- DKIM check;
- DMARC check;
- external inbound delivery test;
- stored-message retrieval test;
- unknown-recipient rejection test where applicable.

UI:

```text
Setting up incoming email

✓ Cloudflare Email Routing enabled
✓ MX records updated
✓ SPF configured
✓ DKIM configured
• Testing incoming delivery…

[ Details ]
```

Only when the required end-to-end checks pass:

```text
Incoming email is ready

example.com
Receiving mail in Bye
```

Set the domain state to `active`.

### State 6 — Rollback / failure

Before cutover, record:

- current MX records;
- current Email Routing state;
- existing SPF;
- existing DKIM records relevant to the change;
- existing DMARC;
- any routing rules affected by the operation.

If verification fails after cutover, offer:

```text
Incoming email setup could not be verified.

[ Retry checks ]
[ Restore previous mail setup ]
```

Rollback must:

- restore the recorded MX/routing configuration;
- preserve mail already accepted by Bye;
- not delete the Bye application deployment;
- retain diagnostic/audit history.

---

## 13. Cloudflare permissions for mail activation

Do **not** broaden the initial infrastructure provisioning write boundary just because mail activation exists.

Recommended authorization model:

### During initial Cloudflare connection

Request the exact verified scopes required for:

- infrastructure provisioning;
- zone discovery;
- Worker custom domain.

### At mail activation

If Cloudflare supports incremental/re-authorization for the required zone-scoped permissions, request the additional mail permissions only when the owner chooses **Review mail setup** / **Enable incoming email**.

Required mail permissions are those already documented by the repository for:

- Email Routing Rules Write;
- Zone Settings Write where enabling Email Routing requires it;
- DNS Write for the selected customer zone if automated DNS application is used.

The permission must be constrained to the selected zone wherever Cloudflare's authorization model permits.

Do not request:

- Global API Key;
- broad all-zone DNS write;
- token-management permissions;
- unrelated account administration.

If incremental OAuth cannot safely express the required zone-scoped grant, the release must document the exact limitation and either:

- use a separately entered narrowly scoped Cloudflare token for mail activation, or
- fall back to a manual-records mode.

Do not silently broaden the original OAuth grant beyond the reviewed scope model.

---

## 14. Reuse the existing domain workflow

Do not create a second mail-domain implementation.

Use the existing sequence:

```text
requested
→ ownership-proven
→ zone-authorized
→ dns-configured
→ inbound-tested
→ outbound-tested
→ active
```

Adapt the first two steps for an onboarding-selected Cloudflare zone where ownership is already established by the connected account/zone relationship.

The state machine remains resumable and idempotent.

### Existing conflict semantics

Retain current behavior from `planMailDns`:

- merge with an existing SPF record;
- detect multiple SPF records as a conflict;
- preserve an existing DMARC policy;
- never silently replace foreign MX;
- detect DKIM-selector conflicts;
- keep foreign/unrelated DNS records.

---

## 15. Domain resource creation after first owner

The existing customer-domain API requires an organization and an authenticated admin.

That is appropriate after the first owner account exists.

On **Review mail setup**:

1. resolve the owner's organization;
2. create/reuse the domain resource for `installation.zoneName`;
3. associate it with the installation/selected zone;
4. launch/resume `ProvisionDomainWorkflow`.

This avoids creating application-domain tenant state before the first owner exists.

The infrastructure onboarding service should expose the selected zone to the deployed instance as non-secret bootstrap metadata, but the application remains authoritative for the customer-domain resource.

---

## 16. Incoming-address activation

Creating the first owner before MX cutover raises one important product rule:

> The owner's account may exist before `@example.com` can actually receive mail.

Therefore distinguish:

```text
account address claimed
```

from:

```text
mail delivery active
```

Until domain state is `active`:

- do not imply that external mail can reach the mailbox;
- show a visible `Incoming email not set up` state;
- sending flows that depend on authorized domain delivery must remain behind their existing authorization/qualification gates;
- internal account authentication remains valid.

The first-owner bootstrap address may still be `owner@example.com` because domain ownership is established through Cloudflare, but that address's inbound-delivery capability is inactive until mail activation completes.

---

## 17. Mail activation API surface

Prefer reusing existing domain endpoints rather than creating onboarding-only mail APIs:

```http
POST /v1/domains
GET  /v1/domains/:id
GET  /v1/domains/:id/dns
POST /v1/domains/:id/authorize-zone
POST /v1/domains/:id/retry
PATCH /v1/domains/:id
```

Add only what is required to bind the selected installation zone to the domain resource without re-entering it.

Suggested request for the onboarding-selected zone:

```http
POST /v1/domains/from-installation
```

Response:

```json
{
  "domainId": "dom_...",
  "name": "example.com",
  "state": "ownership-proven"
}
```

Authorization:

- current user must be the bootstrap-created platform operator;
- user must be owner/admin of the target org;
- installation metadata must name the same zone;
- require step-up before the cutover confirmation/write.

If this binding can be represented cleanly through the existing `POST /v1/domains`, prefer extending that contract rather than adding a new route.

---

## 18. Mail activation acceptance criteria

### UX

A new user can:

1. connect Cloudflare;
2. choose `bye.example.com`;
3. create Bye;
4. create the first owner;
5. click **Do this later** and immediately use the application.

Mail activation is never required to finish account setup.

### New domain / no existing MX

The owner can click:

```text
Enable incoming email
```

and, after one explicit confirmation, Bye configures and verifies the domain.

### Existing provider

The owner sees:

- detected current provider / current MX;
- exact proposed changes;
- explicit cutover warning;
- separate confirmation.

No foreign MX is replaced before confirmation.

### Safety

A mail activation failure:

- does not mark the domain active;
- does not mark the overall Bye deployment failed;
- provides retry/rollback;
- does not delete already accepted mail;
- does not change unrelated DNS records.

---

# Part C — Newsletter config on first use

## 19. Desired UX

Newsletter configuration is completely absent from onboarding.

When a user opens the newsletter feature:

### If configured

Open the newsletter feature immediately.

### If unconfigured and user is a platform operator

Render:

```text
Set up newsletters

Bye uses Resend to send newsletters.
Create a Resend API key with the access required for contacts,
broadcasts and webhook management.

Resend API key
[ re_•••••••••••••••••••• ]

[ Connect Resend ]
```

Secondary link:

```text
Open Resend API Keys
```

### If unconfigured and user is not an operator

Render:

```text
Newsletters aren't configured yet.

An instance operator needs to connect Resend before newsletters can be used.
```

### If the release/stage is not qualified for newsletter dispatch

Render a feature-unavailable state. Do not let the user override qualification by entering a key.

---

## 20. Feature entry point

The current web app does not expose a newsletter view.

Create a dedicated feature entry point:

```text
#/newsletters
```

Recommended files:

- new `apps/web/src/views/newsletters.ts`;
- add `["newsletters", "newsletters"]` to `apps/web/src/lib/router.ts`;
- add the handler in `apps/web/src/main.ts`.

Whether the primary nav exposes **Newsletters** immediately or links to it from World/publishing is a product choice. The first-view configuration gate is the same either way.

This spec covers the configuration gate, not the full newsletter authoring UI.

---

## 21. Why newsletter config must become runtime configuration

Current newsletter configuration is deployment environment state:

```text
NEWSLETTER_PROVIDER
NEWSLETTER_ACCOUNT
NEWSLETTER_API_KEY
NEWSLETTER_WEBHOOK_SECRET
NEWSLETTER_QUALIFIED
```

`workers/core/src/newsletter.ts` reads those synchronously from `env`.

That cannot support an API key entered after deployment without redeploying the Worker.

For self-hosted onboarding installations, move the provider credential to encrypted runtime application configuration.

Keep `NEWSLETTER_QUALIFIED` as an operator/release-controlled safety gate.

---

## 22. Secret-storage design

### New sealing key

Add a generated per-installation secret:

```text
NEWSLETTER_CONFIG_SEAL_KEY
```

Requirements:

- 32 random bytes;
- generated once by onboarding;
- declared as a redacted Worker binding;
- included in the recovery kit;
- never exposed to browser APIs;
- never logged.

Do not use the Cloudflare management OAuth token for this purpose.

A generic future `PROVIDER_CONFIG_SEAL_KEY` is acceptable if this release deliberately generalizes provider-secret storage. For the smallest change, use the newsletter-specific name.

### Database table

Add an expand-only D1 migration, for example:

```sql
CREATE TABLE newsletter_provider_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  provider_webhook_id TEXT,
  key_version INTEGER NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  webhook_secret_iv TEXT NOT NULL,
  webhook_secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_verified_at INTEGER
);
```

Do not store:

- plaintext API key;
- plaintext signing secret;
- Cloudflare management token.

`account_ref` is a stable local identifier for the configured provider account. It need not be derived from the API key.

### Encryption

Reuse the versioned AES-GCM sealing primitives already used for stored external identity credentials:

- `sealWithKey`
- `openWithKey`
- versioned key shape

Use table/field context as associated data if supported by the sealing abstraction; otherwise preserve the existing implementation pattern and add isolation tests.

---

## 23. Newsletter configuration API

Add operator-only endpoints.

### Status

```http
GET /v1/newsletter/config
```

Authenticated response, no secrets:

```json
{
  "provider": "resend",
  "status": "unconfigured",
  "qualified": true,
  "canConfigure": true
}
```

Configured:

```json
{
  "provider": "resend",
  "status": "ready",
  "qualified": true,
  "canConfigure": true,
  "configuredAt": 1790500000000
}
```

Possible statuses:

- `unconfigured`
- `ready`
- `blocked`
- `needs-attention`

The API must never return the API key or webhook signing secret.

### Configure

```http
POST /v1/newsletter/config
Content-Type: application/json

{
  "provider": "resend",
  "apiKey": "re_..."
}
```

Authorization:

- `requireOperatorAccess()`;
- `requireStepUp("admin")`.

This is an instance-level provider, not ordinary organization settings.

### Initial version behavior

Allow this endpoint only when no active config exists.

Credential replacement/rotation should use a separate explicit route or later settings flow because provider replacement can strand existing newsletter operations.

---

## 24. Resend setup transaction

The user should enter **one value only**: the Resend API key.

Bye provisions the webhook automatically.

Current Resend documentation supports programmatic webhook creation and returns a signing secret from the API. Use that capability rather than asking the user to paste a webhook secret separately.

Webhook endpoint:

```text
https://bye.example.com/webhooks/newsletter
```

### Configure sequence

1. Verify release/stage newsletter qualification.
2. Validate API-key format only as a cheap early check; provider response is authoritative.
3. List Resend webhooks.
4. Look for a Bye-owned webhook whose endpoint exactly matches:
   `APP_ORIGIN + "/webhooks/newsletter"`.
5. If found and the API provides its signing secret, reuse it.
6. Otherwise create the webhook with the event set required by the current newsletter adapter.
7. Capture:
   - provider webhook ID;
   - webhook signing secret.
8. Create a random stable local `account_ref`.
9. Encrypt API key and signing secret.
10. Insert the configuration row atomically.
11. Return `ready`.

### Partial failure

Provider mutation + D1 commit cannot be one atomic transaction.

Required recovery:

- if webhook creation succeeds but local persistence fails, attempt to delete the just-created webhook;
- if deletion outcome is uncertain, persist an operator-visible reconciliation record or return `needs-attention`;
- retry must first list matching webhooks and reuse/reconcile rather than blindly creating duplicates.

Do not blindly create another webhook after an ambiguous result.

### Webhook events

Use exactly the event set required by the current `mapResendEvent` implementation and newsletter lifecycle. Keep it in one exported constant shared by setup tests and provider integration.

---

## 25. Resend key requirements

Bye's existing Resend newsletter adapter manages:

- segments;
- topics;
- contacts;
- broadcasts;
- webhook event verification.

The first-use UI must tell the operator to create a Resend key with sufficient access for those resources and webhook management.

A sending-only key is insufficient for this integration.

Do not collect the operator's Resend username/password.

---

## 26. Runtime newsletter provider loading

Refactor `workers/core/src/newsletter.ts`.

Current:

```ts
newsletterSetup(env): NewsletterSetup
```

Target:

```ts
newsletterSetup(env, fetchFn?): Promise<NewsletterSetup>
```

or an Effect service with equivalent async resolution.

### Resolution order

For compatibility:

1. active encrypted runtime `newsletter_provider_config`, if present;
2. legacy deployment env config (`NEWSLETTER_*`) for existing CI/operator-managed deployments;
3. blocked/unconfigured.

Never merge half of one source with half of the other.

### Qualification

`NEWSLETTER_QUALIFIED` remains a deployment/release evidence gate.

It is **not** supplied by the end user and is never writable through the config API.

Runtime config can produce a provider object while dispatch remains blocked when qualification is absent, so reconciliation/removal behavior can remain consistent with the existing design where appropriate.

### Decryption lifetime

Decrypt provider secrets only in the request/task that needs them.

Do not put plaintext provider credentials into:

- KV `ConfigCache`;
- logs;
- metrics;
- error strings;
- API responses;
- Durable Object state unless explicitly encrypted.

---

## 27. Webhook verification

`/webhooks/newsletter` currently verifies using `env.NEWSLETTER_WEBHOOK_SECRET`.

Refactor it to resolve the same active provider configuration used by newsletter dispatch.

Requirements:

- raw request body remains unchanged before signature verification;
- lookup/decrypt is bounded;
- missing config returns authentication failure rather than accepting an unsigned webhook;
- runtime config and legacy env config cannot both verify the same request through fallback ambiguity.

Keep existing duplicate-event/idempotency behavior.

---

## 28. Configuration ownership and lifecycle

Configuration is instance-global.

Only platform operators may:

- configure;
- rotate;
- disconnect;
- repair.

Normal users may read only enough state to render:

```text
configured / not configured / unavailable
```

### Disconnect

Do not make disconnect part of the first-use UI.

When implemented, preserve the existing newsletter invariant:

> disabling credentials must not silently abandon provider work.

A disconnect must be blocked while open publications, provider-side broadcasts, pending removals, unknown operations, or unreconciled events require the current credentials.

---

# Part D — APIs and data contracts

## 29. Onboarding HTTP surface

Recommended simplified browser-facing endpoints:

```http
POST /api/authorize
GET  /api/status
GET  /api/accounts
GET  /api/zones?accountId=<id>
POST /api/install
GET  /api/operations/:id
GET  /api/first-account
```

`POST /api/install`:

```json
{
  "accountId": "...",
  "zoneId": "...",
  "label": "bye"
}
```

Server computes:

```text
zoneName
appHostname
ownerAddressDomain
stage=prod
```

Do not accept `zoneName`, `appHostname`, or stage from the browser as authoritative if they can be derived from Cloudflare + validated server-side.

### Response

```json
{
  "operationId": "...",
  "appUrl": "https://bye.example.com"
}
```

If plan validation requires manual review:

```json
{
  "status": "needs-review",
  "reviewId": "..."
}
```

---

## 30. Installation state machine

Normal states:

```text
new
→ authorized
→ target-selected
→ planning
→ deploying
→ verifying
→ ready
→ owner-created
```

Exceptional states:

```text
needs-review
failed
interrupted
disconnected
```

Do not report `ready` until required health checks pass on the custom app origin.

Retries resume the recorded installation and target; they never silently select a new account/zone/hostname.

---

# Part E — Security invariants

## 31. Cloudflare

- Cloudflare OAuth credentials remain sealed in onboarding storage only. The in-account deployer (Part J) receives the access token per request and never stores it.
- OAuth credentials never become Worker bindings (the deployer's only secret binding is its per-installation request secret).
- The application Worker receives no Cloudflare deployment-management token.
- Zone access is read-only.
- Custom-hostname write access is narrowly scoped through Workers Routes.
- DNS write remains forbidden.
- Email Routing permissions remain forbidden during infrastructure onboarding.
- Disconnect still leaves deployed resources/data intact.

## 32. First owner

- Bootstrap token remains single-use.
- Bootstrap works only before the first user exists.
- Bootstrap address domain is server-enforced.
- Fragment metadata is display input only.
- The created user remains a platform operator.
- Personal organization role remains `owner`.

## 33. Newsletter

- API key is accepted only over authenticated HTTPS.
- API key body must not be logged.
- API key is write-only from the browser's perspective.
- API key and webhook secret are encrypted at rest.
- Configuration mutation requires platform-operator access + step-up.
- Provider qualification cannot be enabled by a user.
- Webhook signing secret is created/retrieved server-side, never shown in UI.
- Provider replacement cannot silently remap in-flight publications.

---

# Part F — Implementation map

## 34. Expected files to modify

### Onboarding

- `infra/onboarding/ui.ts`
  - replace six-section flow with connect → domain → progress;
  - remove stage selection from normal UI;
  - remove newsletter/manual-domain setup from onboarding;
  - exceptional review stays available.

- `infra/onboarding/cloudflare.ts`
  - add zone listing;
  - verify zone/account relationship.

- `infra/onboarding/scopes.ts`
  - add `zone.read`;
  - add `workers-routes.write`;
  - continue to reject DNS/email/broad settings scopes.

- `infra/onboarding/store.ts`
  - installation target fields;
  - install intent if implemented as a distinct record.

- `infra/onboarding/service.ts`
  - fixed prod normal path;
  - target binding;
  - `APP_DOMAIN`;
  - automatic standard-plan review/apply;
  - custom app URL;
  - first-owner redirect metadata;
  - generate `NEWSLETTER_CONFIG_SEAL_KEY`.

- `infra/onboarding/executor.ts`
  - allow `APP_DOMAIN`;
  - continue forcing mail/DNS controls empty.

- `infra/onboarding/review.ts`
  - narrowly permit selected custom-domain resource;
  - add standard-first-install auto-approval classifier.

- `infra/onboarding/README.md`
  - replace first-release manual-domain description;
  - document exact new scopes and recovery behavior.

- `infra/tests/onboarding.test.ts`
  - update acceptance tests.

### Stack / runtime

- `infra/resources/workers.ts`
  - declare `BOOTSTRAP_ADDRESS_DOMAIN`;
  - declare `NEWSLETTER_CONFIG_SEAL_KEY`.

- `workers/core/src/env.ts`
  - corresponding environment types.

- `infra/migrations/d1/<next>_newsletter_provider_config.sql`
  - encrypted provider config table.

### First owner

- `workers/core/src/bootstrap.ts`
  - enforce bootstrap address domain.

- `apps/web/src/views/auth.ts`
  - parse explicit bootstrap domain from fragment;
  - stop deriving it from `location.hostname`.

- `workers/core/test/bootstrap.test.ts`
  - domain enforcement.

### Incoming email activation

- `packages/platform-cloudflare/src/control/domains.ts`
  - preserve current DNS diff/conflict semantics;
  - support installation-zone ownership shortcut where safe.

- `packages/platform-cloudflare/src/control/onboarding.ts`
  - reuse/resume the domain workflow for the onboarding-selected zone.

- `workers/core/src/workflows/domain.ts`
  - preserve idempotent provisioning + verification.

- `workers/core/src/routes/admin.ts`
  - create/reuse domain from selected installation zone;
  - cutover authorization;
  - retry/rollback entry points as required.

- `apps/web/src/views/admin.ts`
  - post-owner incoming-mail setup card;
  - DNS preview;
  - cutover confirmation;
  - progress/verification/rollback states.

- onboarding/runtime installation metadata
  - expose selected zone/account binding to the deployed app without exposing OAuth credentials.

### Newsletter

- new `workers/core/src/newsletter-config.ts`
  - encrypted config load/store;
  - Resend webhook provisioning;
  - safe status projection.

- `workers/core/src/newsletter.ts`
  - async/dynamic configuration source.

- newsletter webhook route file / shared routes
  - dynamic signing-secret resolution.

- `workers/core/src/routes/admin.ts` or a dedicated newsletter-config route module
  - config status/setup API.

- new `apps/web/src/views/newsletters.ts`
  - first-use configuration gate.

- `apps/web/src/lib/router.ts`
  - newsletter route.

- `apps/web/src/main.ts`
  - route handler/navigation.

- `workers/core/test/newsletter.test.ts`
  - runtime config precedence and qualification.

- new integration/unit tests for provider setup and partial failure.

---

# Part G — Test requirements

## 35. Onboarding tests

Add/modify tests covering:

1. OAuth requests the new exact scope set.
2. `dns-records.write` remains rejected.
3. Email Routing scopes remain rejected.
4. Zone list is filtered to selected account/active zones.
5. Single account can auto-advance.
6. Multiple accounts require selection.
7. `bye` is the default hostname label.
8. Invalid labels are rejected server-side.
9. A zone from another account is rejected.
10. Normal install binds `stage=prod`.
11. `APP_DOMAIN` reaches the Alchemy plan/apply environment.
12. `PUBLIC_DOMAIN`, `MAIL_ZONE`, `BYE_MX_CUTOVER`, DNS tokens stay empty.
13. Standard create-only first install auto-approves after install intent.
14. Any unexpected resource type enters `needs-review`.
15. Any replace/delete enters `needs-review` or is blocked according to existing policy.
16. Retry cannot change account/zone/hostname.
17. Health checks use `https://bye.<zone>`.
18. Recovery kit contains zone/hostname but no Cloudflare credentials.
19. Disconnect behavior remains unchanged.
20. Interrupted deployment resumes without replacing persistent resources.

## 36. First-owner tests

1. Setup link contains bootstrap token + selected zone in fragment.
2. Browser removes secret bootstrap fragment from history after reading it.
3. UI displays `user@example.com` when app is `bye.example.com`.
4. Server refuses bootstrap signup on another email domain.
5. Server refuses reused bootstrap token.
6. Server refuses bootstrap after any user exists.
7. Created user is a platform operator.
8. Created personal-org membership is `owner`.
9. Account may exist while the domain's incoming-mail state is not yet `active`.
10. UI does not claim incoming email is ready before domain activation.

## 37. Incoming-email activation tests

1. Owner can skip mail activation without affecting application readiness.
2. Selected onboarding zone is reused; user does not re-enter the domain.
3. Domain resource cannot bind to a different account/zone than the installation.
4. Existing foreign MX is detected and shown before write.
5. Foreign MX is never replaced without explicit cutover confirmation.
6. No-MX domain can follow the simplified activation path.
7. Existing SPF is merged, not duplicated.
8. Multiple SPF records produce a conflict.
9. Existing DMARC is preserved.
10. Missing DMARC may be created according to the approved profile.
11. DKIM-selector collision produces a conflict.
12. Email Routing activation is separately authorized.
13. Unrelated DNS records remain untouched.
14. Domain is not `active` until inbound verification succeeds.
15. External delivery is verified end-to-end.
16. Unknown-recipient behavior is verified.
17. Verification failure leaves the application deployment healthy.
18. Retry resumes the recorded workflow idempotently.
19. Rollback restores recorded MX/routing state.
20. Rollback preserves mail already accepted by Bye.
21. Mail activation credentials/permissions are not present in normal application Worker bindings.
22. OAuth/token scope escalation follows the explicit mail-activation path only.

## 38. Newsletter-config tests

1. Opening feature when unconfigured returns `unconfigured`.
2. Non-operator cannot configure.
3. Operator without recent step-up cannot configure.
4. API key is never returned.
5. API key is not persisted plaintext.
6. Webhook secret is not persisted plaintext.
7. Setup lists/reuses an existing matching Bye webhook when safe.
8. Setup creates webhook when missing.
9. Create response signing secret is sealed.
10. Local persistence failure triggers webhook cleanup/reconciliation.
11. Retry after uncertain create does not blindly duplicate webhooks.
12. Runtime config is preferred over legacy env config.
13. Partial runtime config never falls through and mixes with env config.
14. Unqualified stage blocks new dispatch regardless of valid key.
15. Webhook route verifies with dynamically loaded secret.
16. Wrong signature is refused.
17. Missing config is refused.
18. Newsletter operations continue to honor existing unknown/held/reconciliation semantics.
19. Existing env-configured deployments still work.
20. Provider config secrets are absent from logs/error output.

---

# Part H — Acceptance criteria

## 39. UX acceptance

A new self-hosted user with one Cloudflare account and one domain can complete normal setup with:

1. **Continue with Cloudflare**
2. **Create Bye at `bye.example.com`**
3. **Create account with a passkey**

After that, **Set up incoming email** is offered but may be skipped.

There is no required interaction for:

- deployment stage;
- plan review;
- recovery kit;
- health checks;
- Worker naming;
- MX/mail cutover;
- newsletters.

Provisioning progress is visible but requires no choice unless a failure/exception occurs.

## 40. Functional acceptance

After required setup:

- `https://bye.example.com` serves the Bye app;
- required health checks pass against that custom origin;
- first account is the platform operator;
- first account's personal organization role is owner;
- no MX or Email Routing change has occurred unless the owner separately activated incoming email;
- newsletter provider remains unconfigured;
- opening Newsletters prompts the operator to connect Resend;
- entering one valid Resend API key is sufficient for Bye to create/recover the webhook and reach `ready`;
- subsequent newsletter views do not prompt again.
- if the owner activates incoming email, `example.com` does not become `active` until the domain workflow's required end-to-end delivery checks pass.

## 41. Safety acceptance

The change is not releasable until:

- the exact Cloudflare OAuth scope set has been validated against real Cloudflare;
- a real custom-domain onboarding deploy succeeds;
- interrupted custom-domain provisioning recovers safely;
- no plan path can mutate MX/Email Routing during infrastructure provisioning;
- MX / Email Routing writes occur only through the explicit post-owner mail activation workflow;
- Resend webhook create/list/recovery has been exercised against a real Resend account;
- provider qualification evidence required by the existing newsletter gate is satisfied before production newsletter dispatch is enabled.

---

# Part I — Recommended delivery sequence

## Phase 1 — Custom-domain target model

- installation target fields;
- Cloudflare zone listing;
- new OAuth scopes;
- `APP_DOMAIN` pass-through;
- review-policy changes;
- tests.

No UX simplification yet.

## Phase 2 — Minimal onboarding orchestration

- new three-step UI;
- fixed prod normal path;
- install intent;
- safe auto-approval;
- provisioning progress;
- recovery-kit deferral.

## Phase 3 — First-owner handoff

- explicit selected-zone address domain;
- bootstrap server enforcement;
- automatic redirect.

## Phase 4 — Incoming email activation

- post-owner setup card;
- installation-zone → customer-domain binding;
- reuse existing domain workflow;
- current MX/provider inspection;
- explicit cutover review + confirmation;
- Email Routing/DNS authorization;
- apply + verify;
- retry + rollback.

## Phase 5 — Runtime newsletter configuration

- migration;
- sealing key;
- provider-config service;
- Resend webhook provisioning/recovery;
- dynamic `newsletterSetup`;
- webhook verification refactor.

## Phase 6 — Newsletter first-use gate

- newsletter route/view;
- operator setup form;
- safe status states;
- regression/integration tests.

---

## External implementation note: Resend

As of September 2026, Resend supports programmatic webhook create/retrieve/list/update/delete, and webhook creation returns a signing secret. This permits Bye to ask the operator for only a Resend API key and automate the webhook configuration.

References:

- https://resend.com/changelog/managing-webhooks-via-api
- https://resend.com/changelog/headless-webhook-api
- https://resend.com/features/webhooks
- https://resend.com/changelog/new-api-key-permissions

The implementation must still pin/test the actual API behavior used by the release rather than relying solely on documentation.

---

# Part J — Hosting: onboarding Worker and in-account deployer

Onboarding is offered as a public page (`https://onboarding.<DOMAIN>`) so a new user needs nothing but a browser and a Cloudflare account. The page and its state run on a Cloudflare Worker in Bye's account. The Alchemy run that creates the installation runs **in the user's own account**, in a deployer Worker + Container that onboarding provisions after Cloudflare authorization.

## 42. Topology

```text
onboarding.<DOMAIN>   (Bye's account)
  Onboarding Worker ──▶ OnboardingDO (one per service, SQLite storage)
                          · OnboardingService (unchanged ordering and safety rules)
                          · DurableObjectStore (installations, reviews, approvals, operations, events)
                          · RemoteExecutor ─┐
                                            │ Cloudflare API (the user's OAuth token)
                                            ▼
user's account
  registry.cloudflare.com/<account>/bye-{deployer,scanner,mime,sigmirror}@sha256:…
  <worker>-deployer  Worker ──▶ Deployer DO ──▶ Container (Node + the pinned release checkout)
                                                   └─ pnpm run deploy (Alchemy) ──▶ the Bye stack
  Alchemy state: Cloudflare.state() in the same account (unchanged)
```

- The onboarding Worker never runs Alchemy. The deployer never stores the OAuth token: every plan/apply request carries it, and it lives only in that request's child-process environment (`executor.ts` `childEnv`, unchanged).
- The same `fetchHandler` (`http.ts`) serves the hosted Worker and the self-hosted Node process (`server.ts`), so routes, CSRF, host and cookie rules are identical.

## 43. Operator identity (hosted)

- **Session mode** (hosted default): the operator is the signed session (`__Host-bye-onboarding`, HMAC with a Worker secret). Anyone can start; only that browser session can act on its installation. API calls without an established session are refused (a crawler never creates installations).
- **Access mode** stays available (`BYE_ONBOARDING_ACCESS_*`) for an operator-only deployment.
- **Re-attach.** Losing the session cookie never loses the installation. A new session that connects Cloudflare, and has no installation of its own yet, is offered **Resume your Bye** for each standard (`prod`) installation bound to an account its fresh grant reaches (`GET /api/reattach`). Confirming (`POST /api/reattach`) moves the installation to the new session:
  - The proof is the grant itself: whoever holds a grant to that account could deploy there anyway, so re-attach adds no authority. A grant that cannot reach the bound account is refused.
  - The previous session loses access (one operator per installation). The new grant is sealed for the installation and the one it replaces is revoked (best effort); the new session's empty record is deleted.
  - Nothing is deployed, retried or re-issued: a running deployment keeps running, and the recovery kit stays issued once. The event log records `installation.reattached` without session identifiers.
  - Never silent: the page asks first, and a session that already has a bound installation cannot take another.

## 44. Deployer bootstrap

Runs on every plan, before the first Alchemy call, with the user's OAuth token. It is idempotent: a deployer already at the pinned release is left alone.

Provisioning is a write into the user's account, so it is treated as one. The service records `provisionedAt` on the installation before the first bootstrap, which fixes the target from then on (the deployer and images live in that account). A target that fails its prerequisites is refused before anything is created. `firstWriteAt` keeps meaning the stack's first apply. The standard path's consent is the **Create Bye** click; the "What Bye creates" disclosure lists the deployer.

1. **Images.** Copy each pinned image (`deployer`, `scanner`, `mime`, `sigmirror`) from the public release registry (GHCR) into `registry.cloudflare.com/<account>/bye-<name>` over the OCI distribution API, using registry credentials from `POST /accounts/:id/containers/registries/registry.cloudflare.com/credentials` (`containers.write`). Manifests are copied byte-for-byte, so the digest in the user's registry equals the pinned digest; any mismatch stops the bootstrap. Cloudflare Containers only run images from the account's own registry, and neither the Worker nor the deployer can run Docker, so this copy replaces `docker pull/push`.
2. **Deployer Worker.** Upload `<BYE_WORKERS_DEV_NAME>-deployer` (a dependency-free module, `deployer/worker.ts`) with one container-backed Durable Object class (`Deployer`, SQLite), a `DEPLOYER_SECRET` secret binding, the release and image as plain bindings, and tags `bye-deployer` and `bye-install:<installation>`. A script with that name that lacks the installation tag is someone else's: bootstrap stops with a blocker instead of overwriting it.
3. **workers.dev.** Enable the script's workers.dev route (previews off); the deployer is reached at `https://<name>-deployer.<subdomain>.workers.dev`.
4. **Container application.** Create or update `<name>-deployer` bound to the `Deployer` namespace, `max_instances: 1`, the copied deployer image by digest, and roll it out. A container update or rollout that failed after the Worker upload is retried on the next plan; a rollout this process started recently is left to finish.
5. **Readiness.** Poll `GET /health` with the secret until the running container reports the release commit (the container's own answer, not the Worker's bindings, so a rollout in progress is waited for).

`DEPLOYER_SECRET` is `HMAC-SHA256(BYE_ONBOARDING_DEPLOYER_KEY, installation id)`: never stored, reproducible after a restart, different per installation.

## 45. Stack images and release identity

- The stack accepts digest-pinned `MIME_IMAGE` and `SIGMIRROR_IMAGE` next to `SCANNER_IMAGE` (`SCANNER_SIGNATURES=baked`). With them set, Alchemy deploys the images as-is (they are already in the target registry) and never builds a container.
- The pinned release (`release-pin.ts`, written by `release-manifest.ts` at release time) is the tag, commit, lockfile digest, the four image digests, the release's migrations, required stack configuration and qualification evidence. The image digests are part of `ReleaseRef`, so an approval covers them and a new image needs a fresh review.
- The user-registry image references reach the stack through the installation configuration, so they are part of the configuration digest too.
- Images are built for `linux/amd64` as single-platform manifests (`--provenance=false`); an index is refused.

## 46. Open before release (hosting)

- Bye's Cloudflare OAuth client registration with redirect `https://onboarding.<DOMAIN>/oauth/callback` (unchanged gate).
- Verify on a nonproduction account that `containers.write` covers registry credentials and that `workers-scripts.write` covers script upload, workers.dev and container applications; record it with the scope verification.
- Measure a full first deploy through the deployer (bootstrap copy + Alchemy run) against one access-token lifetime.
- A plan job still running on the deployer when the service restarts makes the resumed revalidate fail with "another job is running"; retrying after it finishes succeeds.
- Deployer teardown on disconnect (today the deployer stays in the user's account and holds nothing without a request).

## 47. Resuming after a restart

A deployment outlives the Durable Object that started it, because the apply runs as a job on the deployer. The onboarding service keeps enough on the operation to continue:

- `planned` (the approved actions of this run) is saved before any write; `job` (`{id, endpoint, next}`) as soon as the deployer accepts the apply, with `next` advanced every 20 lines; `applied` (the job's result) as soon as it is known.
- The heartbeat alarm stays armed while an operation runs, so an evicted object wakes up again. Its constructor runs `recover()`, which continues each queued or running operation where that is safe and otherwise marks it `interrupted` (the existing rule):

| Left at                             | Continues with                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| queued, or `revalidate`             | revalidate from the start (nothing was written)                                  |
| `apply` with a recorded job         | following the job from `next` (only the deployer secret; no Cloudflare API call) |
| `apply` done, `reconcile`, `health` | reconcile and health again (both read-only)                                      |
| `apply` without a recorded job      | `interrupted`                                                                    |
| authorization not `connected`       | `interrupted`                                                                    |

- A job the deployer no longer has (its container restarted, so the Alchemy run died with it) ends the operation as failed with an uncertain outcome after the usual reconcile; the next action is a retry with the same approval, which re-plans. Nothing is replayed blindly.
- The writer lock stays with the resumed operation; approvals are not re-checked on resume (the apply they covered was already checked against a fresh plan before its first write).
- The self-hosted Node executor has no detached jobs, so the Node process keeps the old rule: every operation left running is `interrupted`.
