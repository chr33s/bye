<img width="1280" height="320" alt="header" src="https://github.com/user-attachments/assets/54142617-c397-4d7f-b450-4d2c3ad1fa9b" />

# Bye.

### _Say bye to what matters, and hey to the rest._

**Bye** is an open-source email and calendar platform inspired by HEY's public feature set. It is built in TypeScript on Cloudflare primitives, with Effect v4 and Alchemy. Core flows have been validated locally in Node, workerd and cloudflare in production.tmutmu

- **Email:** a screened Inbox, Newsletters, Receipts, follow-ups, search, drafts and more.
- **Calendar:** events, invitations, tasks, reminders and time tracking.
- **Client apps:** a PWA, CLI/TUI, and React Native apps for mobile and desktop.
- **Open source:** MIT licensed; the code is available here for you to inspect and run.

https://github.com/user-attachments/assets/ba2b19e1-0675-4500-9c8d-58ff4973fe1c

Source for the demo reel: [`demo-reel/`](./demo-reel)

<table>
  <tr>
    <td><img height="480" alt="web-mobile" src="https://github.com/user-attachments/assets/9469b2d2-8df2-4032-b735-c5d81b171b8c" /></td>
    <td><img height="480" alt="web-desktop" src="https://github.com/user-attachments/assets/2f2847fd-899b-4cc0-95c2-a899bb222183" /></td>
    <td><img height="480" alt="mobile-ios" src="https://github.com/user-attachments/assets/6ed3c46d-8687-4de6-913f-a82b22f0bad6" /></td>
    <td><img height="480" alt="mobile-android" src="https://github.com/user-attachments/assets/90db78b8-382e-499a-8866-ef5433259750" /></td>
  </tr>
</table>

---

The product and architecture are specified in [`spec.md`](./spec.md); this repository implements that design on Cloudflare primitives. Alchemy v2 beta defines the deployment, which has not yet been run against Cloudflare.

Pinned baseline: `effect@4.0.0-rc.117`, `alchemy@2.0.0-beta.79`, Node 24.18.1, pnpm 11.20.0 (see `.mise.toml`). Every dependency is an exact version; the Effect family is pinned through `pnpm-workspace.yaml` overrides.

## Layout

```text
alchemy.run.ts                 stack entry (re-exports infra/stack.ts)
infra/resources/               Workers, DO namespaces, D1, R2, Queues+DLQs, Workflows, email routing
infra/policies/                version, boundary, bundle, plan, stage and telemetry gates
infra/onboarding/              Cloudflare onboarding service: OAuth, reviewed deploys into an operator's account
infra/migrations/d1/           ordered, expand-only control-plane SQL
infra/migrations/durable/      DO class-migration manifest
infra/tests/                   plan policy, inventory, bindings, parity ledger, repo checks
workers/core/                  MailCore: HTTP API, email ingress, queue consumers, cron, DO hosts,
                               Workflows, render origin, image proxy, PublicGateway RPC entrypoint
workers/public/                published World sites and share links (no private bindings)
packages/domain/               ids, routing precedence, send state machine, transport contract, parity ledger
packages/contracts/            versioned Effect Schemas: mail/calendar/control/shared commands, queue payloads
packages/application/          Effect v4 use cases and service interfaces (auth, mail, calendar, sharing)
packages/platform-cloudflare/  SQLite DO stores (mailbox, calendar, shared space, World, search, ingress
                               journal), durable kernel, D1 control plane, R2/Queue/transport adapters
packages/mail-codec/           MIME parse/build, sanitizer, threading, Speakeasy, proxy signing, MBOX, vCard
packages/calendar-engine/      time zones, RRULE, ICS, iTIP, layout, free time, reminders
packages/testing/              node:sqlite DO storage, D1 shim, clocks, fixtures, workerd module shims
apps/web/                      PWA (served as MailCore static assets)
apps/cli/                      `bye` CLI and TUI for people and agents
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm verify          # versions, boundaries, 6 typecheck programs, tests, Worker bundle gate
pnpm test            # vitest across packages, workers, apps and infra
pnpm build:web       # build the PWA into apps/web/dist
pnpm build:deploy    # PWA + MIME container bundle (run by deploy, deploy:plan and drift)
pnpm exec bye --help
pnpm exec bye instance add https://mail.example.com   # validate and save a self-hosted instance
STAGE=dev-<id> pnpm dev   # whole stack in local workerd (alchemy dev), live reload
pnpm preflight            # check Cloudflare credentials before anything else runs
STAGE=<stage> pnpm logs   # fetch logs from a deployed stage (append -- --tail to follow)
```

### Local development

`pnpm dev` runs every Worker, Durable Object, D1 database, R2 bucket, KV namespace, queue and container locally through `alchemy dev`. MailCore serves the PWA and the API on one origin, `http://localhost:1337`. PublicSite uses 1338 and SigMirror 1339; a Worker fails to start rather than move to another port. Set `APP_ORIGIN=http://localhost:1337` so the instance document names that origin, and `MAIL_RENDER_ORIGIN=http://127.0.0.1:1337` so message rendering gets a separate origin on the same Worker. `DOMAIN` doesn't cover `dev-*` stages. `STAGE` must be `dev-<id>`: the guard refuses other stages, and alchemy's own default (`dev_$USER`) is not a valid stage name. Logs are written to `.alchemy/log/<stage>/<Resource>`. To point the CLI at it, use `BYE_INSECURE_LOOPBACK=1` with `BYE_API=http://localhost:1337` or `bye instance add http://localhost:1337`.

Clients are not built per server. The apps and CLI default to the hosted service and can add any compatible instance: they validate its `/.well-known/bye-instance` document and RFC 8414 metadata without credentials, then sign in there with PKCE and an issuer-checked callback (RFC 9207). Onboarding hands off with `bye://add-instance?url=<https URL>`. In the CLI, `BYE_API` overrides the saved default for one invocation.

Operators without a CI pipeline can deploy into their own Cloudflare account through the onboarding service: hosted as a Worker at `https://onboarding.<DOMAIN>` (its own stack: `pnpm deploy:onboarding`, or `vars.BYE_ONBOARDING` in CI), which runs each installation's deploy in a deployer it provisions in that user's account, or self-hosted with `pnpm onboarding`. See [`infra/onboarding/README.md`](./infra/onboarding/README.md). It has not yet been run against Cloudflare.

Push notifications reach browsers through Web Push, signed with the instance's VAPID key (onboarding generates one). The iOS and Android apps get them through Bye's push gateway (`workers/push-gateway`, `https://push.<DOMAIN>`, its own stack: `pnpm deploy:push-gateway`, or `vars.BYE_PUSH_GATEWAY` in CI). The gateway is the only holder of the app's APNs key and FCM service account, so hosted and self-hosted instances reach phones the same way. Payloads are end-to-end encrypted to each device (RFC 8291). The gateway forwards ciphertext to APNs or FCM, and the iOS Notification Service Extension or the Android messaging service decrypts it on the device. Android builds take the Firebase client config from `BYE_FIREBASE_APP_ID`, `BYE_FIREBASE_PROJECT_ID`, `BYE_FIREBASE_API_KEY` and `BYE_FIREBASE_SENDER_ID` (gradle properties or environment); without them the build has no push.

Deployment goes through `pnpm deploy:plan` / `pnpm run deploy` with `STAGE` set to `dev-<id>`, `preview-<n>`, `staging` or `prod`. The scripts disable CLI telemetry, and production runs only from CI. Read [`infra/RUNBOOK.md`](./infra/RUNBOOK.md) first: bootstrapping the state backend is an explicit, authorized operation.

## How it fits together

- **Inbound:** Email Routing → `email()` resolves the recipient in D1 → registers the receipt in `IngressJournalDO` → streams the original to R2 → enqueues a reference. The queue consumer then parses and sanitizes the message, derives a safety verdict (trusting only our own `Authentication-Results`), and commits to `MailboxDO`. It acks only after the commit.
- **Mailbox:** single-writer SQLite DO per mailbox. It covers screening, views, attention piles, Bubble Up, threading, rules, workflows, notes, contacts, drafts, send jobs, uploads, away replies, forwarding and retention. Commands are idempotent by command ID; every mutation writes a change event and a durable outbox.
- **Outbound:**
  - A draft revision is frozen into one send intent, which waits out the undo window or Send Later time as a persisted job with a generation.
  - The dispatch consumer renders MIME with Bcc kept envelope-only, re-checks send-as authority, and submits through a transport router that enforces each traffic class's capability limits.
  - A timeout after submission becomes `unknown`, never a blind retry.
- **Calendar:** one `CalendarDO` per account, running on the calendar engine. Invitations from approved senders arrive through the propagate queue. Invitation replies leave as iTIP `text/calendar` messages through the owner's mailbox.
- **Search:** per-mailbox FTS5 `SearchShardDO`, fed by index outbox events. Every hit is rehydrated from the mailbox, so a stale index can omit a result but never reveal one.
- **Sharing and publishing:** `SharedSpaceDO` holds shared threads, collections, grants and public links. A per-handle World store holds posts and subscribers. The public Worker reaches them only through the narrow `PublicGateway` RPC entrypoint.
- **Recovery:** DO alarms are re-derived from persisted jobs. A 5-minute cron walks a partitioned resource catalog to restore lost alarms and fence stale submissions, and republishes ingress receipts that were stored but never committed.

## Parity status

All 47 ledger rows in §2 have at least one tagged executable test; `infra/tests/parity.test.ts` fails otherwise. A tag records test coverage, not production acceptance. Key open gates:

| Area                           | Current status                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native clients                 | iOS simulator, macOS and JavaScript bundles for all four platforms verified locally. Android and Windows builds run in CI. Device, signing, upgrade and some Windows credential tests remain open. Linux uses the PWA.                                                                                                                                                                                                                                        |
| Personal and subscription mail | No provider is approved. Personal sending goes through Cloudflare Email Sending (the same `send_email` binding as transactional mail) only where `MAIL_TRAFFIC_CLASSES` includes `personal`, DKIM-signed with `MAIL_DKIM_PRIVATE_KEY` (selector `bye1`) when set. This is the same pairing Cloudflare's own [Agentic Inbox](https://github.com/cloudflare/agentic-inbox) uses (Email Routing in, Email Service `send_email` out). World fanout stays pending. |
| Scanning and MIME              | ClamAV scan flows pass local smoke tests; the scanner reaches only the private SigMirror (`enableInternet: false`, not yet asserted by a test). Messages over 8 MB parse in the bounded MIME container. Sandboxed attachment previews exist.                                                                                                                                                                                                                  |
| External integrations          | Push: Web Push to browsers, and to the iOS/Android apps through the push gateway (APNs/FCM, end-to-end encrypted). It is covered by tests and the iOS simulator build, not yet by a signed build on a device (P1.7). Location autocomplete (Mapbox) has a provider adapter. Both stay off until their keys are configured. The billing ledger and signed webhook are implemented; the payments UI is not.                                                     |
| Previews                       | Each PR deploys an isolated `preview-<n>` stage on its own host (`pr-<n>.<PREVIEW_DOMAIN>`) with the mail sandbox, probes, and a gated destroy on close.                                                                                                                                                                                                                                                                                                      |
| DNS rebinding                  | URL and redirect checks exist. Resolved-address checks need deployment egress controls.                                                                                                                                                                                                                                                                                                                                                                       |
| Runtime validation             | Workerd tests cover inbound mail, search, calendar layout, draft dispatch and publishing. Production ingress retries, wire Message-ID, customer-zone onboarding and performance remain unverified.                                                                                                                                                                                                                                                            |
| Strict Cloudflare-only profile | A self-hosted state backend (per-stage tokens, encrypted snapshots) is implemented but not deployed. The default Alchemy state backend uses an upstream Worker.                                                                                                                                                                                                                                                                                               |

See [spec.md](./spec.md) for the full parity requirements and deployment gates (release profiles and acceptance gates are in §13), [infra/PARITY.md](./infra/PARITY.md) for per-capability evidence, and [infra/RUNBOOK.md](./infra/RUNBOOK.md) for deployment and recovery procedures.

## License

Bye is released under the [MIT License](./LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). HEY is a trademark of 37signals; Bye is an independent project and is not affiliated with or endorsed by 37signals.
