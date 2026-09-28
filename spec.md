# HEY-equivalent email and calendar platform

## Spec sketch — Cloudflare primitives, TypeScript, Effect v4, and Alchemy beta

**Version:** 0.7  
**Research baseline:** September 25, 2026  
**Status:** Implemented in this repository and validated in Node and local workerd (Miniflare); not deployed to Cloudflare or production-validated.  
**Implementation baseline:** Effect `4.0.0-rc.115`; Alchemy `2.0.0-beta.78`. Exact, deliberately selected prerelease pins—not floating distribution tags. [I1]

**Revision 0.2:** Replaces the Effect 3 implementation baseline with Effect v4, makes Alchemy v2 beta the infrastructure-as-code authority, and adds deployment state, binding, migration, preview, and release controls. The 47-row product parity ledger and mail correctness requirements are retained. The main changes are in §7, §13–14, and the new §15. Code is a specification-level sketch checked against documentation and selected source; it has not been compiled or deployed.

**Revision 0.2.1 — telemetry correction (September 25, 2026):** Corrects §15.7 and the state configuration in §15.3 against Alchemy's `v2.0.0-beta.78` source. Removes the unsupported requirement to fork or replace the default state backend solely for telemetry. This is a targeted source review, not a new audit of the other product/platform claims or a production egress test. [I15][I16]

**Revision 0.3 — implementation alignment (September 25, 2026):** Records decisions made while implementing this specification. Product and correctness requirements are unchanged.

- **Repository layout (§7.1):** `apps/cli` (formerly `cli-tui`); shared native code in `packages/native-shared`; `containers/scanner`; `infra/state` and `infra/foundation`.
- **Native clients (X01):** React Native on iOS and Android, and on desktop through react-native-macos and react-native-windows. Linux has no official React Native target, so Linux uses the PWA. The iOS app adds a native WidgetKit widget and a Share Extension.
- **Attachment scanning (§3.1, §10):** uses an isolated ClamAV Container bound to MailCore. Signatures come from a private R2 mirror filled by a cron-started cvdupdate container, the single egress point; the fallback is a daily CI-built image with signatures baked in.
- **Request logging (§15.7):** the `redactQueryString` observability setting does not reach the Worker at deploy time in beta.78. Automatic invocation logs are therefore disabled.
- **Optional state backend (§15.7):** an optional telemetry-free HTTP state backend is available. It is not required by this specification.
- **Runtime validation:** covered by a workerd test suite in addition to the Node harness.
- **Desktop sign-in (A03/X01):** browser-mediated passkey sign-in with authorization code + PKCE, rotating device sessions, and OS secure storage are specified in §10 “Desktop sign-in and device sessions” (acceptance DS01–DS12).

**Revision 0.4 — mail providers (September 26, 2026):** Folds in the former `spec.mail.md`. Mail travels through replaceable provider adapters while Bye's jobs, consent, suppression, and delivery records stay authoritative; provider records are external evidence and execution state, never permission to bypass Bye's policies.

- **Traffic classes (§5.3):** every dispatch carries an immutable traffic class and requires an enabled stage configuration. Newsletters use a separate `NewsletterProvider` and never fall back to individual-message APIs; `SubscriptionMailTransport` is retired.
- **Ambiguous operations (§5.2):** accepted, definitively not accepted, and unknown are distinct; retries happen only under documented provider idempotency or proven absence; there is no automatic cross-provider failover.
- **Newsletters (§5.5):** creator-scoped consent with revisions and history, restrictions kept apart from subscriptions, immutable publications, and cancellation reported with its coverage.
- **Provider events, runtime, and privacy (§5.6):** events are authenticated, account-bound, and persisted before acknowledgement; adapters use direct HTTPS; retention is a release decision.
- **Release gates (§5.4, §13, §14):** per-adapter qualification and the decisions that must be made before release.

**Revision 0.5 — native apps and self-hosting (September 26, 2026):** Folds in the former `spec.native-apps.md`. One released app per platform and one CLI package work with the hosted service or any compatible self-hosted instance; the server is runtime configuration.

- **Instance selection (§10):** a published compatibility document plus RFC 8414 issuer metadata, validated without credentials before anything is saved; one shared URL normalizer; "Open in Bye"/QR handoffs are add-instance requests only.
- **Authentication (§10):** sign-in attempts are bound to their instance and issuer, and callbacks carry RFC 9207 `iss`; credentials go only to the validated endpoint set.
- **Isolation and lifecycle (§10):** state keyed by base URL + issuer (+ account); sign-out, remove instance and delete account are distinct; the CLI's `BYE_API` precedence is defined.
- **Distribution and acceptance (§10, §13, §14):** release matrix, signing and store requirements, acceptance NA01–NA10, and the decisions still open before release.

**Revision 0.6 — Cloudflare onboarding (September 26, 2026):** Folds in the former `spec.onboarding.md`. Operators can deploy and run Bye in their own Cloudflare account through Bye's OAuth application; they own the resources, state, and data. Deployment approval is not approval to change domains or mail routing.

- **Flow and identity (§15.11):** review prerequisites, authorize, approve a pinned plan, deploy and verify, hand off to the native apps, then an optional manual domain/mail guide. One installation is bound to one operator, account, and stage before any deployment write.
- **Writes (§15.11):** only through the existing Alchemy stack and policies; approvals cover account, stage, release, configuration, actions, and migrations; one serialized writer; resume without blind replay or fresh state.
- **Credentials (§15.11):** least-privilege OAuth scopes with no DNS or Email Routing; encrypted at rest; disconnect blocks writes and revokes access without touching resources or state.
- **Acceptance and open decisions (§15.11, §14):** OB01–OB10, and the decisions required before release.

**Revision 0.7 — release requirements (September 28, 2026):** Folds in the former `hey-bye-parity-spec.md`. A capability is claimed only at the evidence level it has actually reached, and each release declares the profile whose gates it passes. `infra/EVIDENCE.md` remains the evidence register; `infra/PARITY.md` is the generated per-capability ledger.

- **Completion levels and ledger evidence (§2.4):** repository-complete, client-complete, integration-qualified, and production-accepted; ten evidence dimensions per ledger row; a tagged test is traceability, not acceptance.
- **Release profiles and priorities (§13.2):** private/self-hosted (A), hosted (B), and paid hosted (C) profiles; P0/P1/P2 priorities.
- **Release requirements (§13.3–13.5):** P0 production foundation (deployment, mail qualification, recovery, monitoring, security, performance, hosted obligations, billing, licensing); P1 product gaps, including conditional Bubble Up and send-and-pop (E09), the calendar cover panel (C09), and TUI parity (X02); P2 bounded limitations.
- **Gates, phases, and done (§13.6, §13.8):** gates G1–G10, four release phases, and a merged definition of done.
- **Licensing and scope (§10, §1):** MIT distribution requirements; release non-goals merged into the scope boundaries.

## 1. Decision summary

Build a **Cloudflare-first, multi-tenant email service**, not merely an email client. Target the publicly documented HEY experience across personal email, calendar, custom domains, collaboration, publishing, and programmatic clients. Use an original brand, interface implementation, and assets. HEY names below are feature identifiers for the parity checklist, not proposed product branding. [H0][H1][H2][H3][H5]

The core decomposition is:

- **Workers + TypeScript + Effect v4:** HTTP APIs, ingestion, application services, and asynchronous consumers.
- **Alchemy v2 beta:** typed Cloudflare resource declarations, bindings, deployment state, and lifecycle operations. Alchemy owns infrastructure; application Effects execute business logic. See §15.
- **SQLite-backed Durable Objects:** authoritative mailbox state, shared resources, calendar mutations, durable timers, and change streams.
- **R2:** immutable original messages, normalized content, attachments, exports, and explicitly published assets.
- **D1:** identity, organizations, domain/address directory, billing entitlements, and the resource catalog.
- **Queues + Durable Object alarms + Workflows:** background execution, deferred actions, and recoverable multi-step operations.
- **Email Routing:** inbound mail. **Pluggable delivery adapters:** outbound personal mail, transactional notifications, forwarding, and external send-as through `MailTransport`; newsletters through a separate `NewsletterProvider` (§5.3, §5.5).

**The main constraint is transport, not application hosting.** Cloudflare now offers Email Sending in beta, including arbitrary recipients after sending-domain onboarding. It is not accurate to describe its current outbound capability as verified-recipient-only. Cloudflare's own reference application, Agentic Inbox, uses exactly this pairing for a personal mailbox: Email Routing for inbound mail and the Email Service `send_email` binding for composing and replying to arbitrary recipients. Bye therefore uses Email Service sending for personal correspondence as well as transactional mail. Ordinary outbound messages are limited to 5 MiB and 50 combined recipients; inbound messages are limited to 25 MiB. [C1][C2][C3][C22]

Therefore define two deployment profiles:

| Profile                                   | Commitment                                                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare-first — recommended target** | All application compute and primary storage use Cloudflare. Narrow adapters cover approved personal/bulk mail transport, payments, device push, external send-as, and location lookup.                                                             |
| **Strict Cloudflare-only infrastructure** | Same application architecture, but full parity remains gated on personal-mail/bulk-use approval, transport capabilities, domain onboarding, and required external integrations. Do not advertise this profile as unconditionally feature complete. |

A transactional service supporting a `List-Unsubscribe` header does **not** establish permission to operate a newsletter service. Keep World-style subscription delivery behind a separate, qualified `NewsletterProvider` (§5.5). [C3][C4]

Intended provider roles: Cloudflare Email Routing for inbound Worker routing; Cloudflare Email Service sending for transactional mail and personal correspondence (as in Cloudflare's Agentic Inbox [C22]), DKIM-signed by Bye; Resend under evaluation for programmatic broadcasts; Loops or others only after qualification. These are intended roles, not validated compatibility claims. Forwarding still needs its own qualified route, and bulk or subscription mail never goes through Email Service sending.

### Scope boundaries

“Feature complete” means the public feature baseline is covered by executable acceptance tests on supported clients. It does not claim knowledge of HEY's private implementation or undocumented behavior. Where public descriptions leave details unspecified, this document proposes explicit behavior.

Include ordinary email correctness, account operations, accessibility, exports, abuse handling, and recovery—not only the distinctive inbox screens. Exclude from the parity requirement: hosting IMAP/POP servers; arbitrary third-party mailbox synchronization or historical-mail import; built-in generative AI; HEY branding, trade dress, private implementation, or proprietary assets; a native Linux application (the PWA is the documented Linux client, X01); paid checkout for a private self-hosted release (§13.2); and newsletter email delivery when only World web/RSS publishing is advertised (P1.5). HEY itself documents a custom-client model without IMAP/POP and a fresh-start approach rather than historical-mail import. Calendar import and external send-as remain in scope. [H16][H3]

## 2. Product parity ledger

Every row is a release requirement, not an MVP omission. “Acceptance contract” describes the proposed clone's behavior. Related details are grouped to keep this a sketch rather than a screen-by-screen PRD.

### 2.1 Email and personal organization

Core feature inventory: [H1]. Later additions and smaller interaction features: [H4].

| ID  | Capability                            | Acceptance contract                                                                                                                                                                                                                           |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01 | Screener                              | Unknown senders wait outside normal mail views. Approve/reject individually or in bulk; approve-and-reply and approve-as-seen work in one action. Clearing the pending list must not silently approve its senders.                            |
| E02 | Sender and domain policies            | Exact-address and explicit domain rules control screening, destination, bundling, labels, and notifications. Exact rules override domain defaults. Users can inspect and reverse decisions.                                                   |
| E03 | Speakeasy                             | A rotatable secret in the subject bypasses screening only. It never bypasses malware checks, spoofing checks, tenant boundaries, or sending authorization. [H10]                                                                              |
| E04 | Imbox                                 | Separate New For You from Previously Seen. New replies become new without requiring archive discipline. Mark-one and mark-all-as-seen respect the view's observed revision.                                                                   |
| E05 | Feed                                  | Expanded, chronological newsletter reading with collapse/expand, remembered position, new-since-last-visit markers, and safe lazy rendering.                                                                                                  |
| E06 | Paper Trail                           | Receipt/transaction view with sender rules, filters, bundles, remembered position, and independent visit markers.                                                                                                                             |
| E07 | Reply Later / Focus & Reply           | Persistent reply queue; distraction-free sequential replies; queue membership survives navigation, app restarts, and device changes. [H17][H18]                                                                                               |
| E08 | Set Aside                             | A persistent reference pile with explicit completion and send-and-mark-done. It is not implemented as deleting or archiving the message.                                                                                                      |
| E09 | Bubble Up                             | Schedule a return or pin now; support Pop and send-and-pop. New incoming replies surface promptly rather than remaining hidden until the timer. [H11]                                                                                         |
| E10 | Read Together / Power Through New     | Open selected conversations together; triage and reply inline. New arrivals do not reorder the batch while the user is working through it.                                                                                                    |
| E11 | Thread controls                       | Unfollow, locally rename subjects, and manually merge threads. Preserve original messages and original wire threading; expose a reversible local merge history.                                                                               |
| E12 | Bundles, labels, and automatic filing | Group a sender's messages into one row without physically merging them. Support multi-label assignment and deterministic rules using available sender/recipient metadata.                                                                     |
| E13 | Workflows                             | User-defined stages, ordered cards, thread membership, completion, and extension-triggered enrollment. These are product workflow boards, not Cloudflare Workflows instances. [H8]                                                            |
| E14 | Collections                           | Named multi-thread timelines; personal collections and explicitly shared team collections. Permissions apply to every included message and attachment. [H9]                                                                                   |
| E15 | Notes and clips                       | Separate private thread notes with files, Imbox sticky notes, cover-art stickies, and a searchable clips library with source links. None enters outbound MIME. [H20]                                                                          |
| E16 | Contacts                              | Address books, groups, searchable notes, sender/domain history, From/To filters, recent-recipient suggestions, vCard import/export, and permissioned device-contact lookup.                                                                   |
| E17 | Composer                              | Rich/plain text, links, lists, quotes, inline replies, code blocks, formatting/highlights, inline images, signatures/snippets, To/Cc/Bcc editing, recipient groups, pop-out compose, and draft autosave.                                      |
| E18 | Sending controls                      | Reply, reply-all, forward, independent same-reply-to-many actions, undo window, Send Later, cancellation, and explicit per-recipient failure information. Same-reply-to-many must not combine unrelated recipients into one message.          |
| E19 | Identities and linked accounts        | Default From identity, external send-as, identity badges, unified views, and explicit redelivery between authorized accounts. Preserve which account owns every action. [H19]                                                                 |
| E20 | Attachments                           | Attachment library, metadata filters, safe previews, individual/bulk downloads, multipart upload, and large-file download links. A large-file link is not a large MIME attachment. [H7]                                                       |
| E21 | Search                                | Search messages, contacts, notes, clips, labels, and files by metadata; include exact terms, phrases, exclusions, sender/recipient/date/view filters, attachments, and explicit Trash search. Support recent searches and actions on results. |
| E22 | Away replies and forwarding           | Scheduled autoresponder, sender cooldowns, loop protection, verified forwarding destinations, and sender-specific forwarding/redelivery rules.                                                                                                |
| E23 | Privacy and notifications             | Tracker blocking and an image proxy; quiet email notifications by default with contact/domain/thread opt-in, device preferences, and quiet hours. [H12][H13]                                                                                  |
| E24 | Retention and presentation            | Spam, Screened Out, Trash, restore, empty actions, configurable recycling, cover art, themes, keyboard shortcuts, printable messages/threads, and accessible empty/error states.                                                              |

### 2.2 Calendar and personal planning

The calendar is a first-class product. HEY's public scope includes day/week-oriented navigation, habits, time tracking, journal, flexible weekly tasks, and calendar interoperability. Its updates also add year view, widgets, calendar search, and multiple reminders. [H2][H4]

| ID  | Capability                            | Acceptance contract                                                                                                                                                                              |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C01 | Views and navigation                  | Continuous day timeline, week view, agenda, year overview, month/date picker, overlapping-event layout, collapsible night hours, and remembered navigation.                                      |
| C02 | Events                                | Timed, all-day, multi-day, recurring, and exception events; descriptions, locations, links, attendees, highlighting, countdowns, and multiple reminders.                                         |
| C03 | Recurrence and time zones             | Repeat forever, until a date, or for a count. Edit one occurrence, future occurrences, or the series. Support IANA zones, travel-aware display, configurable first weekday, and 12/24-hour time. |
| C04 | Invitations                           | Receive, create, update, accept/tentative/decline, and cancel invitations; distinguish organizer and attendee authority; deduplicate repeated and out-of-order updates.                          |
| C05 | Calendar interoperability             | ICS import/export, external subscription feeds, outbound private feed URLs, color-coded calendars, and calendar sharing. An ICS subscription is read-only, not two-way synchronization.          |
| C06 | Sometime this week                    | Week-associated tasks without invented timestamps; reorder, complete, move between weeks, and optionally convert to a scheduled event.                                                           |
| C07 | Habits and time tracking              | Recurring habit definitions, dated completions/history, start/stop/manual time entries, one active timer per account, and cross-device reconciliation.                                           |
| C08 | Personal day context                  | Day names/labels, background photos, private journal entries, event highlights, countdowns, and uninterrupted free-time calculations.                                                            |
| C09 | Email integration                     | Invitation actions inside email; create an event from a message with a permission-checked backlink; optional calendar cover panel in the mail application.                                       |
| C10 | Search, location, and device surfaces | Search events/tasks/journal/tracked time/day labels; location autocomplete through an adapter; mobile widgets, timer surfaces, deep links, and reminder controls.                                |

### 2.3 Domains, teams, publishing, and account lifecycle

Domain collaboration is documented separately from personal accounts; CLI/TUI and agent access are part of the current public product. [H3][H5]

| ID  | Capability                     | Acceptance contract                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O01 | Custom domains                 | Ownership verification, MX/SPF/DKIM/DMARC onboarding, status diagnostics, aliases, plus-addressing, catch-all, migration checks, and safe domain removal.                                                                                                                                                                                                                                           |
| O02 | Team administration            | Owner/admin/member roles; invite/suspend/remove users; mailbox reassignment policies; seats, billing, quota visibility, and auditable administrative changes.                                                                                                                                                                                                                                       |
| O03 | Extensions/shared addresses    | Group addresses with authorized send-as, common conversation history, membership controls, private comments, and automatic workflow enrollment.                                                                                                                                                                                                                                                     |
| O04 | Shared threads and collections | Share history and subsequent replies without external forwarding. Keep teammate discussion separate from email recipients. Revoke access to future server reads.                                                                                                                                                                                                                                    |
| O05 | Public thread links            | Explicit bearer-link sharing of the selected thread and future replies, optional expiry, and revocation. Exclude Bcc and private notes/comments. [H21]                                                                                                                                                                                                                                              |
| P01 | World-style publishing         | An authenticated internal email action publishes a post to a public author page; support drafts/previews, edit/unpublish, media, code formatting, and RSS. [H6]                                                                                                                                                                                                                                     |
| P02 | World subscriptions            | Email subscriptions, confirmation, unsubscribe, subscriber export, consent-preserving CSV invitations, fanout tracking, and bounce/complaint handling. [H6][H4]                                                                                                                                                                                                                                     |
| A01 | Account types                  | Personal, domain, and family entitlements; family billing never grants access to another member's mailbox or calendar.                                                                                                                                                                                                                                                                              |
| A02 | Commercial lifecycle           | Trials, annual/monthly plans, seat changes, cancellation, refunds/credits, optional referral/footer-credit rules, and configurable short-address pricing. Prices and branding are our own product decisions. [H15][H4]                                                                                                                                                                              |
| A03 | Authentication and recovery    | Passkeys/security keys, second factors, recovery codes, device/session management, and independent recovery that does not require access to the locked mailbox. [H12]                                                                                                                                                                                                                               |
| A04 | Portability and closure        | MBOX email export, vCard contacts, ICS calendars, and a separate export for notes/tasks/settings. Provide the address-reservation and post-cancellation forwarding entitlement equivalent. [H16]                                                                                                                                                                                                    |
| X01 | Clients                        | Web/PWA; installable macOS, Windows, Linux, iOS, and Android applications; tablet layouts, offline drafts, attachment handling, share sheets, and platform notifications. Native clients use React Native (iOS/Android) and react-native-macos/react-native-windows (desktop) over the same `/v1` contracts; Linux is served by the PWA because React Native has no official Linux target. [H0][H4] |
| X02 | CLI, TUI, and agents           | Authenticated TypeScript clients covering mail, screening, workflows, search, and calendar, with structured output, scoped credentials, and auditable write actions. [H5]                                                                                                                                                                                                                           |

A PWA alone is an intermediate release, not complete parity with native widgets, share extensions, and system integration. Small platform-specific bridges may be required; application and service logic remain TypeScript.

### 2.4 Completion levels and ledger evidence

A tagged test provides traceability, not proof that every acceptance clause works: a test titled `[E09] send-and-pop …` once exercised send-and-bubble because send-and-pop did not exist. Claim each capability only at the highest level it has actually reached:

| Level                 | Meaning                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository-complete   | Domain behavior and contracts are implemented, material behaviors have executable tests, and no known limitation contradicts advertised behavior.                                                                   |
| Client-complete       | The full workflow is usable on the client, including loading, empty, validation, permission, failure, persistence, and accessibility states. Backend support alone does not complete an advertised client workflow. |
| Integration-qualified | Stage-scoped configuration is documented; provider approval exists where required; real-provider happy and failure paths are exercised; event authenticity and replay are tested; limits are recorded.              |
| Production-accepted   | Every applicable repository, client, integration, security, performance, operational, and recovery gate passes in a production-like environment.                                                                    |

Integrations qualify independently: personal sending, forwarding, external send-as, newsletters, push, payments, and location each need their own evidence.

**Ledger.** `infra/PARITY.md` has one row per capability above, each naming an owner, and one column per evidence dimension below. Each cell is `—` (not applicable), `open`, a link to a test file or `evidence/…` run, or `excluded` with a reason. A row's level is the lowest reached across its applicable cells. The file is generated by `pnpm parity:ledger` from this ledger, the `[ID]` tags in test titles, and the hand-kept owners and evidence in `infra/parity-evidence.json`; `infra/tests/parity.test.ts` fails when it is stale or when a row reaches production-accepted without an `evidence/` run.

| Dimension          | Required evidence                                                    |
| ------------------ | -------------------------------------------------------------------- |
| Domain/application | Material state-transition tests                                      |
| API                | Validation, authorization, idempotency tests                         |
| Web                | User-visible workflow acceptance                                     |
| Native             | UI tests plus signed-device evidence where platform behavior matters |
| CLI                | Command and structured-output tests                                  |
| TUI                | Interactive acceptance for the P1.3 workflows                        |
| Provider           | Real-provider evidence for external boundaries                       |
| Recovery           | Restart/retry/replay behavior                                        |
| Security           | Authorization, isolation, revocation, unsafe-input tests             |
| Accessibility      | Client-appropriate audit/evidence                                    |

A row is never production-accepted solely because its ID appears in a test title, and Bye is never declared feature-complete from the 47-row ledger alone.

**Evidence register.** `infra/EVIDENCE.md` is the single register of evidence and status. Its rows EV1–EV8 track the corresponding §14 decisions, and it maps each §13 release requirement to them; new evidence rows are added there rather than tracked elsewhere. Every acceptance run is recorded under `evidence/<date>-<item>/` in the release artifact bucket (never in git) with commit, lockfile digest, stage, date, operator, and the pass/fail result per acceptance clause; the register links the latest run per row.

## 3. Cloudflare architecture

```text
                    Web / desktop / mobile / CLI / TUI
                                   |
                      Worker API + Effect application
                                   |
              +--------------------+---------------------+
              |                    |                     |
             D1               MailboxDO            CalendarDO
       identity/directory    personal state       events/invites
       entitlements/catalog      + outbox             + jobs
                                   |
                       SharedSpaceDO / ThreadDO
                       grants + shared history
                                   |
                    durable outbox -> Cloudflare Queues
                                   |
                 +-----------------+-------------------+
                 |                 |                   |
             indexing          send dispatch       media/exports
                 |                 |                   |
           SearchShardDO     MailTransport          R2 + Containers
             SQLite FTS5       adapters             when necessary

 Internet SMTP -> Email Routing -> Ingress Worker -> R2 originals
                                         |
                                  IngressJournalDO
                                         |
                                      Queues
                                         |
                              parse/scan -> mailbox commit

 DO alarms: send-later, bubble-up, reminders, outbox wake-ups
 Cron: independent reconciliation and retention sweeps
 Workflows: provisioning, exports, deletion, rebuilds, large fanouts
 Public Worker: published posts and permission-checked share links
```

### 3.1 Primitive assignments

| Primitive                        | Responsibility                                                                                                                | Explicit non-responsibility                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Workers / Static Assets          | TypeScript UI delivery, Fetch APIs, service-binding boundaries, ingress and consumers                                         | No always-running process or self-hosted Internet SMTP daemon                                 |
| SQLite Durable Objects           | Single-authority mutations, local transactions, outbox, sequence numbers, resource grants, timers                             | No cross-object transaction or globally distributed low-latency SQL illusion                  |
| D1                               | Low-volume control plane, address-to-mailbox routing, organization membership, billing receipts, provisioned-resource catalog | Not the global message-body database; no duplicate mailbox authority                          |
| R2                               | Private binary/content storage, original MIME, exports, published copies                                                      | Not the database for mutable read state or sender decisions                                   |
| Queues                           | Small retryable work references and event fanout, with dead-letter queues                                                     | Not the source of truth or a calendar-length timer service                                    |
| Workflows                        | Checkpointed multi-stage provisioning/export/delete/reindex/fanout                                                            | Not a replacement for Effect inside an invocation or a guarantee of exactly-once side effects |
| KV                               | Versioned non-sensitive configuration/cache hints                                                                             | Never sessions, authoritative permissions, screening policy, or revocation state              |
| Containers                       | Isolated antivirus, exceptional MIME processing, document previews, and heavy conversion. [C20]                               | No persistent local data; not required on every ordinary message                              |
| WAF / Turnstile / rate limits    | Signup, login, public-link, and abuse protection                                                                              | Not mail reputation, sender authentication, or content safety by themselves                   |
| Workers secrets                  | Service credentials and key-encryption material                                                                               | No credentials in frontend bundles, queues, traces, or source control                         |
| Observability / Analytics Engine | Operational counters, traces, resource usage, queue lag                                                                       | No subjects, bodies, attachment names, or full addresses in ordinary analytics                |

SQLite-backed Durable Objects support FTS5. Their documented per-object storage limit is 10 GB; SQL row/string limits also matter. D1 likewise has a per-database ceiling, so neither should be treated as an unbounded shared mail store. KV is eventually consistent, which is why it is excluded from authorization decisions. [C5][C6][C7][C8]

### 3.2 Resource ownership and consistency

**One authoritative writer per mutable resource.** `MailboxDO(mailboxId)` owns personal organization and draft/send intent. `CalendarDO(calendarId)` owns a calendar. A `SharedSpaceDO(spaceId)` owns shared collections, extension settings, and resource grants; large shared conversations can live in dedicated thread objects.

D1 owns organizational membership and account suspension. Resource-level grants live only in their owning object. Each request checks both current account/membership status and the resource grant. Use primary-consistent D1 reads for these decisions; do not rely on a stale replica or KV cache. Workers construct the principal from verified credentials rather than trusting a tenant ID in client JSON.

Sharing does not mutate everyone's mailbox into one global thread. Maintain shared content/grants plus per-user read, attention, and notification overlays. Grant removal blocks subsequent reads, blob downloads, and search hydration. Already downloaded content cannot be recalled.

Cross-object propagation is explicitly asynchronous: source transaction → durable outbox → queue → idempotent target transaction. UI may display a pending state. No feature relies on an atomic D1 + DO + R2 + Queue write.

## 4. Data model and state semantics

### 4.1 Core records

| Authority           | Principal records                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1                  | `User`, `Credential`, `Session`, `Organization`, `Membership`, `Domain`, `AddressRoute`, `Entitlement`, `BillingEvent`, `ResourceCatalog`                                                                          |
| MailboxDO           | `SenderPolicy`, `Delivery`, `Thread`, `ThreadMembership`, `ReadCursor`, `AttentionState`, `DraftRevision`, `SendJob`, `Label`, `Rule`, `Contact`, `ContactGroup`, `Note`, `Clip`, `WorkflowBoard`, `WorkflowStage` |
| Shared resource DO  | `SharedThread`, `SharedMessageRef`, `Collection`, `CollectionItem`, `Grant`, `PrivateComment`, `Extension`, `MembershipVersion`                                                                                    |
| CalendarDO          | `Calendar`, `EventSeries`, `EventException`, `Attendee`, `InvitationRevision`, `ReminderJob`, `WeekTask`, `Habit`, `HabitCompletion`, `TimeEntry`, `DayDecoration`, `JournalEntry`                                 |
| Durable authorities | `CommandReceipt`, `OutboxEvent`, `ChangeEvent`, `ScheduledJob`, `MigrationVersion`                                                                                                                                 |
| R2                  | Original `.eml`, normalized body documents, attachments, scan results, export snapshots, published asset copies                                                                                                    |

A `Message` is immutable content. A `Delivery` is its presence in one mailbox. A `Thread` is a local presentation grouping. These are not interchangeable: two recipients may see the same content but have different screening, read state, notes, and permissions.

Use opaque identifiers and tenant-scoped blob keys. RFC `Message-ID` is untrusted metadata, not a database primary key or an authorization token. Preserve envelope recipients separately from visible To/Cc; never infer hidden Bcc recipients.

### 4.2 Orthogonal state

```ts
type SenderDecision = "unknown" | "allowed" | "blocked";
type Destination = "imbox" | "feed" | "paper-trail";
type Disposition = "active" | "screening" | "screened-out" | "spam" | "trash";
type BubbleState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Scheduled"; readonly at: number; readonly generation: number }
  | { readonly _tag: "Pinned" };

type AttentionState = {
  readonly replyLater: boolean;
  readonly setAside: boolean;
  readonly unfollowed: boolean;
  readonly bubble: BubbleState;
};
```

Do not encode all of this as one folder field. Labels, visibility, attention, sender policy, notification preferences, and actual reading are independent.

**Proposed routing precedence:** recipient validity/account eligibility → malware/spoofing/spam policy → explicit sender block → exact sender allow → domain policy → valid Speakeasy bypass → Screener. Allowed mail then receives its destination, labels, bundling, and workflow actions. Reading a message in the Screener does not itself approve its sender.

**Read concurrency:** `MarkSeen` carries the observed message/revision boundary. It never marks a concurrently arriving reply as read. Bulk operations capture a bounded snapshot; new arrivals are not swept into an old user action.

**Bubble semantics:** a new incoming reply returns the thread to New For You and invalidates its prior bubble job. It produces one row, not a second copied thread. Timer jobs carry generations so an old scheduled job cannot resurrect a cancelled action.

**Local threading:** use References/In-Reply-To only within authorized mailbox content, with conservative fallback grouping. Manual merges maintain an explicit local mapping. Do not rewrite original wire headers to implement a renamed or merged thread.

## 5. Mail ingestion and delivery

### 5.1 Inbound pipeline

1. **Resolve the envelope recipient.** One catch-all Worker route per onboarded domain can dispatch application aliases without allocating a Cloudflare rule per user. Exact aliases precede enabled plus-address fallback and an optional tenant catch-all. Unknown recipients are rejected; directory outages are not treated as “unknown user.”
2. **Register receipt intent.** Allocate an ingestion ID and durable journal entry before expensive processing. Record envelope information and an opaque R2 key; minimize logged identifiers.
3. **Store original bytes.** Stream original MIME to R2, then mark the journal entry blob-ready. Do not load multiple copies of a maximum-sized message in an isolate. Preserve originals even if parsing fails.
4. **Enqueue by reference.** The journal retains delivery intent until mailbox commit. Queue messages contain ingestion ID, recipient/target references, object key, and schema version—not MIME or attachments.
5. **Parse and inspect.** Decode MIME and charsets, extract parts, sanitize display content, check attachments, identify calendar data, and record authentication evidence. Route exceptional large/complex inputs to a bounded Container task.
6. **Commit to the mailbox.** A local transaction inserts the delivery, applies current policy, records the queue deduplication receipt, advances the change sequence, and writes downstream outbox events.
7. **Project and notify.** Index content, propagate authorized shared views, and send eligible notifications. A queue acknowledgment follows the committed result, never precedes it.

The documented handler exposes raw MIME, raw size, envelope addresses, and permanent rejection. It does not document a complete durable-redelivery guarantee for every handler/storage failure. **Before production, test SMTP behavior under thrown errors, timeouts, and unavailable R2/journal storage, and obtain an acceptable retry/recovery contract.** Do not translate transient failures into `setReject()`, which is permanent, or pretend that `waitUntil()` makes ingestion durable. [C9]

The application guarantee starts when both original bytes and receipt metadata are durably committed. Await durable storage of the complete original MIME, then commit an ingestion receipt with envelope addresses, storage reference, and recoverable processing state before treating ingestion as successful. First persistence is never background-only. Processing must be discoverable from the receipt if queue publication fails: a journal reconciler handles blob-ready receipts that never reached a queue or mailbox. Recover interrupted storage/receipt writes without treating partial objects as accepted messages. Provider-level acceptance before that point is a separate launch gate. A successful handler return is not evidence of completed downstream processing, and a permanent rejection is not a temporary retry mechanism.

Deduplicate repeated processing of the same ingestion/recipient ID, and deduplicate transport redeliveries only when proven, within the installation and recipient scope. Do not discard independent SMTP deliveries solely because their `Message-ID` or body matches: legitimate messages can reuse either. When identity is ambiguous, preserve the message rather than silently discarding it. Internal replay deduplication and imperfect Internet-mail duplicate detection are distinct problems. Parsing failure leaves the original recoverable; enforce documented size and processing limits and treat message content as untrusted.

### 5.2 Outbound pipeline

```text
Draft -> Scheduled / UndoWindow -> Ready -> Submitting -> AcceptedByTransport
                    |                         |                 |
                 Cancelled                 Unknown        recipient outcomes
                                                          delivered / bounced
                                                          deferred / rejected
```

The send command freezes a draft revision and atomically records the send job, idempotency receipt, and outbox entry. Enforce one send intent per draft revision even when two devices use different request keys. An intentional resend creates a new intent.

Dispatch validates the sender identity and current membership, attachment scan status, quotas, and transport capabilities again. The undo window is a real pre-submission delay. Once `Submitting` wins the local transaction, cancellation may be too late; the UI must say so.

After provider acceptance, let the provider own SMTP delivery retries. An application consumer must not resubmit simply because a recipient is temporarily deferred. Track outcomes per recipient, and never present provider acceptance as proof of inbox placement or reading. Cloudflare exposes sending lifecycle events through event subscriptions, but these are not equivalent to all inbound/routing events. [C10][C11]

**Ambiguous send:** a timeout after submission may mean the provider accepted the email. Unless that adapter provides verified idempotency or reconciliation, move to `Unknown`, inspect provider evidence, and require an explicit decision before resending. A local lock alone cannot guarantee exactly-once Internet delivery.

**Ambiguous operations (all providers and operations).** Distinguish accepted, definitively not accepted, and unknown outcomes. Retry only when the same immutable request remains covered by documented provider idempotency, or reconciliation proves another attempt safe; record the provider's scope and expiry for that protection. A timeout, expired key, absent event, or inconclusive lookup is not proof of non-acceptance. Hold uncertain operations for reconciliation and operator review; never automatically fail them over to another provider. Preserve partial-recipient outcomes rather than retrying an entire accepted group. Back off safe retries within declared rate limits; expiry or exhausted retries leave a visible, durable outcome.

Persist each accepted outbound job and its immutable operation identity before calling a provider: installation/stage, traffic class, provider configuration version, payload fingerprint, recipient scope, attempt history, and returned identifiers. Serialize dispatch per logical operation, including restart recovery. Queue redelivery resumes that operation; it never creates another one.

### 5.3 Transport capability contract

`MailTransport` carries individual messages. Assign an explicit traffic class before dispatch; retries cannot change it. Dispatch requires an enabled installation/stage configuration for that class, an authorized sender and recipients, and a qualified adapter; a disabled, unauthorized, or incompatible route is rejected before any provider call. Newsletters use `NewsletterProvider` (§5.5), never an individual-message API.

Each adapter declares: permitted traffic classes, message/recipient/attachment limits, MIME/calendar support, sender-domain authorization, acceptance-ID semantics, wire-Message-ID access, idempotency support, event/reconciliation support, and forwarding behavior. `NewsletterProvider` declares capabilities **per operation** (contact sync, unsubscribe sync, broadcast create/send/schedule/cancel, lookup, events), not per provider: MIME/header preservation, encoded size and recipient limits, sender restrictions, idempotency scope/window, reconciliation evidence, event coverage, and cancellation limits. Reject unsupported requirements before side effects; never silently strip them.

Keep credentials encrypted and installation/stage-scoped. Recheck current authorization and suppression policy before dispatch. Disabling sends blocks new dispatch but does not assert cancellation of in-flight or provider-scheduled work; preserve reconciliation and cancellation access where credentials permit. Provider replacement must reconcile old work and synchronize applicable suppressions before enabling new sends.

Required adapters are:

| Adapter                            | Purpose                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CloudflareTransactionalTransport` | Product notifications and other transactional mail over the Email Service `send_email` binding                           |
| `CloudflarePersonalTransport`      | User correspondence over the same binding, one envelope recipient per send, DKIM-signed with the installation key [C22]  |
| `NewsletterProvider`               | World subscriber sync, consent changes, broadcasts, cancellation, and event reconciliation (§5.5); not a `MailTransport` |
| `ExternalIdentityTransport`        | User-authorized Gmail/Outlook APIs or authenticated SMTP for externally hosted addresses                                 |
| `ForwardingTransport`              | Forwarding preserving appropriate envelope/authentication behavior; not ordinary resend with a forged From               |

Cloudflare controls outbound `Message-ID`, `Date`, MIME-related headers, and Return-Path, while allowing reply-thread headers. Store an internal message ID separately from the provider acceptance ID and the actual wire `Message-ID`; do not assume those last two are identical. Verify round-trip threading and invitation MIME in delivered fixtures. Raw-message API support is not evidence of unrestricted header preservation. [C4][C12]

Workers do not provide an inbound TCP listener, and outbound port 25 is blocked by default. Use bindings/HTTPS APIs, or permitted authenticated submission connections for external send-as—not a Worker-based Internet MTA. [C13]

### 5.4 Transport-specific release gates

| Gate                           | Required evidence                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal and subscription mail | Provider acceptance of each traffic class, quotas, complaint handling, and abuse responsibilities                                                                                                                                                                                             |
| Adapter qualification          | Each enabled adapter passes real-domain MIME, attachments, recipient privacy, threading, unsubscribe, delivery-event, and recovery checks in the target Workers runtime; adapter/API versions, supported operations, limits, and evidence recorded. Unsupported operations remain unavailable |
| MIME and invitations           | Gmail/Outlook/Apple fixtures preserve ordinary replies, inline parts, Bcc privacy, and REQUEST/REPLY/CANCEL invitations                                                                                                                                                                       |
| Limits                         | Capability-aware composer validation; large-file links; clear refusal or alternate adapter for oversized messages/recipient lists                                                                                                                                                             |
| Inbound durability             | Observed retry/rejection behavior and recovery procedure for ingress failures, including storage failure, before production cutover                                                                                                                                                           |
| Domain onboarding              | An authorized operational path for every customer zone; no assumption that an arbitrary customer's existing Cloudflare zone is already in our account                                                                                                                                         |
| Forwarding                     | Ownership verification, loop prevention, replay constraints, SRS/ARC-compatible behavior, and capacity beyond account-level verified-destination limits                                                                                                                                       |

### 5.5 Newsletters

**Consent and suppression.** Maintain creator-specific subscription records with consent evidence, source, timestamp, and revision. Creating or importing a provider contact is not consent. Preserve unsubscribe and suppression history during sync and provider changes. A stale positive update cannot reactivate an unsubscribe; re-subscription requires new recorded consent. Keep creator-level unsubscribe separate from broader provider restrictions: do not broaden a scoped unsubscribe or narrow a provider-wide restriction. Unresolved event ordering or scope blocks affected newsletter eligibility until reconciled.

Record bounces and complaints separately from subscriptions, including their scope and reason. Apply provider restrictions as a minimum; Bye may be stricter. The cross-traffic-class suppression and clearance policy is a release decision, not an adapter default. Neither contact sync nor re-consent automatically clears a bounce/complaint restriction.

**Synchronization and dispatch.** Synchronize only the data the configured newsletter service needs. Commit a Bye-origin unsubscribe and block subsequent Bye dispatch before acknowledging it to the subscriber; queue provider synchronization durably. Authenticate provider-origin changes, persist receipt before acknowledging the event, and apply them through the same subscription/suppression rules. Measure provider-event-to-Bye lag separately from local processing and Bye-to-provider sync lag.

Before submitting a broadcast, verify consent, applicable suppressions, creator/audience mapping, and synchronization freshness. The selected provider must enforce the relevant recipient exclusions at its documented dispatch boundary. An unsubscribe received after submission or scheduling is synchronized to the provider and excludes the recipient only if it lands before the provider dispatches to them; a local state change never recalls an already submitted email. Disable autonomous provider scheduling unless its unsubscribe behavior meets the approved contract (Bye holds the schedule and submits at send time). Pause new affected broadcasts when freshness or eligibility cannot be established.

**Publishing and cancellation.** Bind a publication to an immutable campaign revision, sender, content, intended recipient population, and schedule. Later unsubscribes/suppressions can remove recipients; later subscriptions cannot silently expand an approved publication. Create a provider draft separately from sending, persist its identity, and verify it still matches the publication before submitting it. Apply ambiguous-operation handling (§5.2) independently to create, send, schedule, and cancel. A timeout must not trigger another campaign or a full-audience resend.

Track publication intent, provider-observed state, and recipient outcomes separately. Report cancellation as requested, confirmed with its coverage, unsupported, or uncertain; cancellation does not erase partial sends. Every newsletter carries a working, creator-scoped unsubscribe path; verify provider-required headers and links on delivered mail.

**Resend adapter notes.** Resend contacts are account-global, and their `unsubscribed` flag excludes a contact from every broadcast. The adapter never writes that flag; each creator is a segment plus an opt-out-default topic, and consent is the contact's topic opt-in. Broadcast create/send accept no idempotency key, so their unknown outcomes are reconciled by broadcast name or observed status, or held. Broadcasts carry no custom headers; unsubscribe uses the provider's per-recipient, topic-scoped link. Topic-level unsubscribes are not reported by any documented event, which is a declared coverage gap.

### 5.6 Provider events, runtime, and privacy

**Delivery and events.** Separate job execution from delivery observations and recipient eligibility. Provider acceptance is not delivery confirmation, and a delivered event does not clear suppression. Authenticate incoming webhooks or queue events with the relevant transport mechanism and bind them to the configured provider account and installation. Persist events before acknowledgement; deduplicate retries/replays and handle out-of-order observations without regressing newer state. Retain unknown event mappings for reconciliation; never apply them to another creator or installation.

Declare missing event coverage. Reconcile missed events using supported provider evidence; where recovery is unavailable, expose stale/unknown state rather than inventing delivery or consent outcomes. Monitor ingestion failures, unknown sends, oldest queued work, event lag, suppression-sync lag, and cancellation uncertainty. Configure alert thresholds and recovery runbooks before enabling the affected capability.

**Runtime and privacy.** Prefer direct Workers-compatible HTTPS adapters; supported Worker bindings may remain behind an adapter. Node/Bun-only SDKs are not runtime dependencies for MailCore. Enforce installation/stage authorization for stored MIME, attachments, events, and subscriber records. Keep credentials, message content, and subscriber lists out of operational logs. Specify retention/deletion rules for originals, event evidence, provider copies, and minimal consent/suppression history before release.

## 6. Scheduling, queues, and recovery

Use **persisted jobs plus the next due Durable Object alarm** for undo, Send Later, Bubble Up, and reminders. Store timestamps and a job generation in SQL. The alarm drains a bounded due batch, writes outbox work, and schedules the next wake-up. Revalidate the generation and current resource state at execution time.

Cloudflare Queues delivers at least once; its documented maximum message size is 128 KB and maximum delay is 24 hours. An email can be much larger, and a reminder can be months away. Queue payloads therefore stay small, and long-term schedules stay in durable storage. [C14][C15]

Every authority has a local outbox. The consumer deduplicates by `(eventId, targetId)`. A crash after queue publication but before marking the outbox sent produces a harmless repeat, not lost work.

Setting an alarm or updating a cross-service scheduling hint is not assumed atomic with a SQL transaction. An independent Cron reconciler probes a partitioned catalog of provisioned authorities, including ones whose hints were never updated. Provision the catalog entry before exposing an address/resource to traffic. Missed alarm registration must be recoverable without a user reopening the app.

Use Cloudflare Workflows for domain provisioning, bulk exports, erasure, reindexing, and large publishing fanout. Run Effect programs **inside durable steps**; persist only serializable results and references. Do not keep Effect fibers or in-memory runtime state across Workflow sleeps. Retried steps still need idempotent side effects. [C16][C17]

| Failure                                                   | Required outcome                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Blob saved; queue publish fails                           | Receipt journal republishes; no lost acknowledged content                                             |
| Mailbox committed; consumer crashes before acknowledgment | Replayed event returns the existing result                                                            |
| Job committed; alarm setup fails                          | Independent catalog reconciliation restores wake-up                                                   |
| Send response lost after provider acceptance              | `Unknown`, not a blind retry                                                                          |
| Indexing unavailable                                      | Mail continues to ingest; search reports lag; index can rebuild                                       |
| Shared-resource propagation delayed                       | Source remains committed; UI shows pending state; replay catches up                                   |
| Poison MIME or archive bomb                               | Original preserved, quarantined state visible, bounded processing, operator diagnostics               |
| Queue retention exceeded                                  | Reconstruct outstanding work from journals/outboxes rather than claiming the queue is a permanent log |

## 7. TypeScript and Effect v4 design

### 7.1 Version policy and package boundaries

Use **Effect v4 throughout the application and Alchemy infrastructure code**, with TypeScript strict mode. The selected baseline is `effect@4.0.0-rc.115` and `alchemy@2.0.0-beta.78`; Alchemy's beta.78 release requires Effect `>=4.0.0-rc.115`. This is a documented compatibility baseline, not a claim that every transitive integration has already passed the project's tests. [I1]

Use exact dependency versions, one committed workspace lockfile, and a pinned package-manager/runtime toolchain. Do not deploy from floating `@beta`, `@rc`, `@next`, `@latest`, caret, or tilde ranges. Upgrade Alchemy and the Effect dependency family in a dedicated change, checking the resolved dependency graph rather than suppressing peer errors. Do not introduce Effect 3 into an application-facing service graph.

The package manifest fragment below shows the relevant version contract, not the complete repository dependencies:

```json
{
  "dependencies": {
    "effect": "4.0.0-rc.115"
  },
  "devDependencies": {
    "alchemy": "2.0.0-beta.78",
    "@effect/platform-bun": "4.0.0-rc.115",
    "@effect/platform-node": "4.0.0-rc.115"
  }
}
```

Alchemy runs in the deployment toolchain; the production application runs in Workers. The Node/Bun platform packages above are toolchain dependencies, **not permission to import Node/Bun runtimes into Workers**. Where needed, use the same tested Effect release for `@effect/vitest` and provider-specific SQL drivers. Effect v4 consolidates many former standalone packages into `effect/unstable/*`; keep HTTP API, RPC, SQL, and CLI integrations behind internal modules so their unstable APIs do not become persisted or public contracts. [F6][I1]

```text
alchemy.run.ts                 root stack entry (re-exports infra/stack.ts)
infra/resources/               Workers, DO namespaces, D1, R2, Queues, Workflows, Containers, email routing
infra/policies/                version, boundary, bundle, plan, stage, telemetry gates
infra/migrations/d1/           ordered control-plane SQL migrations
infra/migrations/durable/      per-class SQLite migrations and compatibility fixtures
infra/state/                   optional telemetry-free HTTP state backend (Worker + SQLite DO)
infra/foundation/              foundation stack: state backend bootstrap and shared dependencies
infra/tests/                   plan, binding, deployment, state recovery, drift, parity tests
apps/                          web (PWA), mobile (React Native iOS/Android), desktop (react-native-macos/-windows), cli (CLI + TUI)
containers/scanner/            isolated ClamAV scanning Container
workers/core/                  MailCore: API, inbound, consumers, scheduler, DO hosts, Workflows, render origin
workers/public/                published posts and permission-checked share links
packages/domain/               pure policy, reducers, state machines, branded identifiers
packages/contracts/            versioned Effect Schema requests, responses, events
packages/application/          Effect v4 use cases and service interfaces
packages/platform-cloudflare/  native D1, DO, R2, Queue, transport adapters and layers
packages/mail-codec/           MIME, sanitization, threading, calendar parts
packages/calendar-engine/      recurrence, time zones, invitation interpretation
packages/native-shared/        React Native screens, API client, offline drafts, deep links
packages/testing/              fake layers, in-memory bindings, recorded mail/calendar fixtures
```

Domain code must not import Alchemy, Cloudflare globals, Node/Bun APIs, or deployment modules; issue `fetch`; read environment variables; or call a clock directly. Infrastructure enters through Effect services: `MailboxRepository`, `BlobStore`, `MailTransport`, `Policy`, `CalendarRepository`, `JobStore`, `Directory`, `Authorization`, and notification/billing/location adapters. Adapters depend on narrow binding interfaces so tests do not need a whole Worker environment.

### 7.2 API conventions at the selected v4 release

Do not translate from an early v4 beta tutorial mechanically. Names changed during the prerelease series; the pinned source and installed declarations take precedence. In particular, this baseline uses **`Context.Service` and `Schema.TaggedError`**, not early-beta `ServiceMap.Service` or `Schema.TaggedErrorClass`. [F2][F4][I12]

| Concern                 | Required convention                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service keys            | `Context.Service<Self, Shape>()("app/ServiceName")`; retrieve dependencies with `yield* ServiceName`. Give every service a stable, unique key. [F2]           |
| Implementations         | Compose explicit `Layer.succeed` / `Layer.effect` implementations. Do not copy the old `Effect.Service` automatic-default pattern into v4 code. [F7]          |
| Expected error outcomes | `Effect.result(operation)` and `Result.isFailure(result)`; read `.failure` or `.success`. Replace the old `Effect.either`/Left/Right pattern. [F5]            |
| Error classes           | `Schema.TaggedError<Self>()("Tag", fields)` at rc.115. Domain failures are structured; they are not arbitrary provider errors. [F4]                           |
| Literal choices         | `Schema.Literals(["a", "b"])`; use array arguments for v4 `Schema.Union` and `Schema.Tuple`. A single fixed value still uses `Schema.Literal(value)`. [F4]    |
| Boundary decoding       | `Schema.decodeUnknownEffect(schema)` and explicit encoding codecs. Validate wire data before calling application services. [F4]                               |
| Configuration           | PascalCase constructors such as `Config.String`, `Config.Number`, and `Config.Redacted`; no lowercase constructors copied from older examples. [I1]           |
| Catching failures       | Use v4 `Effect.catch`, `Effect.catchTag`, or `Effect.catchCause` deliberately. Do not indiscriminately turn defects or interruption into domain success. [F8] |
| Runtime execution       | Use `Effect.runPromise` at native invocation boundaries after dependencies are provided. Do not base the design on removed v3 `Runtime<R>` construction. [F3] |

Use `effect/unstable/httpapi` and `effect/unstable/rpc` only where they improve the internal transport implementation; HTTP and JSON contracts remain independently versioned. No new Effect cluster or durable-workflow backend is required: **Cloudflare Workflows and Durable Objects remain the durable execution mechanisms**.

### 7.3 Contract sketch

This example updates the original dispatch contract to the selected v4 API. It intentionally keeps the original safety invariant: provider acceptance, transport uncertainty, and durable job persistence are different events.

```ts
import { Context, Effect, Result, Schema } from "effect";

export class TransportFailure extends Schema.TaggedError<TransportFailure>()("TransportFailure", {
  kind: Schema.Literals(["Rejected", "RetryableBeforeAcceptance", "Unknown"]),
  detail: Schema.String,
}) {}

export interface Submission {
  readonly sendJobId: string;
  readonly identityId: string;
  readonly contentKey: string;
  readonly envelopeRecipients: ReadonlyArray<string>;
}

export interface Acceptance {
  readonly providerId: string;
  readonly wireMessageId?: string;
}

export class MailTransport extends Context.Service<
  MailTransport,
  {
    readonly submit: (submission: Submission) => Effect.Effect<Acceptance, TransportFailure>;
  }
>()("mail/MailTransport") {}

export class JobStoreFailure extends Schema.TaggedError<JobStoreFailure>()("JobStoreFailure", {
  detail: Schema.String,
}) {}

export class JobStore extends Context.Service<
  JobStore,
  {
    // Persist Submitting atomically; duplicates and in-flight jobs are no-ops.
    readonly claim: (sendJobId: string) => Effect.Effect<Submission | null, JobStoreFailure>;
    readonly accepted: (
      sendJobId: string,
      receipt: Acceptance,
    ) => Effect.Effect<void, JobStoreFailure>;
    readonly failed: (
      sendJobId: string,
      failure: TransportFailure,
    ) => Effect.Effect<void, JobStoreFailure>;
  }
>()("mail/JobStore") {}

export const DispatchCommand = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sendJobId: Schema.String,
});

export const decodeDispatchCommand = Schema.decodeUnknownEffect(DispatchCommand);

export const dispatch = (sendJobId: string) =>
  Effect.gen(function* () {
    const jobs = yield* JobStore;
    const transport = yield* MailTransport;
    const submission = yield* jobs.claim(sendJobId);
    if (submission === null) return;

    const outcome = yield* Effect.result(transport.submit(submission));
    if (Result.isFailure(outcome)) {
      yield* jobs.failed(sendJobId, outcome.failure);
    } else {
      yield* jobs.accepted(sendJobId, outcome.success);
    }
  }).pipe(Effect.withSpan("mail.dispatch"));
```

`claim` validates state and persists `Submitting` before external I/O. If the process dies between submission and `accepted`, reconciliation treats the stale job as uncertain; it must **not** simply release a lease and resubmit. A store failure after successful submission cannot be treated as a retryable transport failure. `failed` persists the classified outcome and any next durable attempt before its caller acknowledges work. Persist encoded error fields, not live `Error` instances or provider response objects.

`Effect.result` captures the expected error channel; it is not a blanket conversion of defects or interruption into a normal result. A crash or interruption after claiming leaves evidence for reconciliation. Do not wrap the entire `dispatch` effect in an automatic transport retry. [F5]

The command schema above shows versioning; production schemas additionally constrain identifiers, sizes, and allowed combinations. Use Effect Schema at HTTP, queue, webhook, RPC, Workflow-result, configuration, and persisted-record trust boundaries. JSON crosses those boundaries; Effects, contexts, layers, functions, and live streams do not. A v4 library upgrade must not silently change stored discriminators, timestamp formats, omitted/null semantics, or public error envelopes.

### 7.4 Runtime, scope, and durability rules

Use native Cloudflare `fetch`, `email`, `queue`, DO RPC/alarm, and Workflow-step entrypoints as thin adapters around Effect application programs. Alchemy provisions these entrypoints and their bindings (§15); it does not replace their platform lifecycle. Effect-native Alchemy Worker definitions are permitted where validated, but mixing provisioning Effects with request execution is not.

| Concern             | Rule                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundary execution  | Run `Effect.runPromise` only at a native invocation boundary, with all dependencies supplied. An Effect-native Alchemy handler already has a runner; do not start a redundant nested runtime.                                                                                               |
| Scopes              | Use a scope for request-owned resources and finalizers. For streaming HTTP responses, close it on stream completion/cancellation—not merely when headers are returned.                                                                                                                      |
| Request isolation   | Construct layers containing the principal, request, execution context, or per-request credentials for each invocation. Never memoize one user's authorization context in an isolate-global runtime.                                                                                         |
| Shared construction | Cache only demonstrably safe, request-independent construction. A long-lived DO may own instance-local services; request principals and response streams still cannot leak between calls.                                                                                                   |
| Errors              | Map expected tagged failures to public error envelopes. Surface and redact defects; do not report success after a caught queue-processing failure.                                                                                                                                          |
| Transactions        | Native DO SQL mutations remain synchronous inside their local transaction; fully consume SQL cursors before an `await`. Wrap the native atomic operation in an adapter, not an async callback inside a synchronous transaction. Driver adoption requires equivalent transaction tests. [C5] |
| Cancellation        | Propagate abort signals for cancellable reads. Client disconnect does not prove that a send or durable mutation did not commit. Reconcile persisted intentions.                                                                                                                             |
| Retries             | Allow short, bounded retries only for known transient/pre-acceptance work. Queue/Workflow policies own durable retries; record a retry budget to prevent multiplication across layers.                                                                                                      |
| Concurrency         | Bound parsing, indexing, provider calls, and fanout explicitly. No unbounded `Effect.all` or stream parallelism over messages, recipients, or attachments.                                                                                                                                  |
| Background work     | Never implement durable work with detached fibers, `setTimeout`, or only `ctx.waitUntil`. Persist the intent/outbox first; use Cloudflare wake-up mechanisms.                                                                                                                               |
| Workflow steps      | Run a fresh, fully provided Effect within each step; persist only versioned serializable outputs. No fibers, scopes, native cursors, streams, or runtime state across a sleep/checkpoint.                                                                                                   |
| Observability       | Use structured spans with opaque IDs. Keep message bodies, addresses, authorization headers, secret values, and provider payloads out of logs and exported traces.                                                                                                                          |
| Tests               | Supply deterministic clocks and fake layers for use-case tests, then run native adapters in the Workers runtime. Tests must exercise failure, interruption, scope closure, and replay—not only success.                                                                                     |

### 7.5 Migration acceptance for this revision

Before merging the implementation, type-check application and IaC packages against the exact dependency graph. Prove that no runtime path imports Alchemy management providers, a Node/Bun platform runtime, or a second incompatible Effect version. A type-only `Cloudflare.InferEnv` import may connect resource declarations to native Worker environment types; verify that it erases from the deployed JavaScript. [I3]

Preserve fixtures for old and new JSON records, queue events, HTTP responses, and Workflow step results. Tests must prove round-trip encoding, previous-record decoding, service substitution, no cross-user context reuse, finalization on cancellation, safe ambiguous sends, and per-message queue retry/acknowledgment behavior. Upgrading the runtime is not a reason to rewrite mailbox data or replay already accepted sends.

## 8. Search, synchronization, and clients

### Search

Use **SQLite FTS5 SearchShardDOs** as rebuildable lexical indexes, partitioned by privacy scope and bounded storage. Start with one shard per mailbox/scope; roll over well below 10 GB, with size-aware period/bucket partitioning. Chunk long text below SQL row limits. Never put raw MIME or attachment binaries in FTS. [C5][C6]

Index subject, participants, normalized visible body text, authorized notes/clips, contact notes, and attachment names/types. Search attachment contents only when extraction is explicitly supported; OCR and semantic embeddings are optional enhancements, not hidden requirements.

Parse user search into a typed query AST. Bind parameters; escape FTS syntax separately. Test Unicode, diacritics, CJK text, addresses, punctuation, phrases, and exclusions. Fan out within a bounded set of authorized shards; merge with stable date ordering or rank fusion rather than comparing unrelated shard-local scores as though they were global.

Every candidate is reauthorized and hydrated from current authoritative state before returning its snippet, body, or attachment. Stale indexes may omit a new result but must not reveal a revoked one. Deletion tombstones and index versions make replays safe. Show an indexing watermark when results may be incomplete.

### Synchronization

Each authority emits a monotonic change sequence. A client stores a per-resource cursor vector, not a fictitious global transaction number. Responses include resource revisions; mutations include command IDs and expected versions.

Use hibernating Durable Object WebSockets for small invalidation/change notifications, backed by an HTTP changes API. Reconnect resumes from cursors; expired cursors trigger a snapshot refresh. WebSockets are an optimization, not the sole delivery path. [C18]

Draft autosave uses optimistic revisions and conflict recovery; never last-write-wins away a long offline draft. Optimistic read/label changes can replay idempotently. Offline send means “queued on this device” until the server records a send intent, not “sent.”

### API sketch

| Endpoint family                                       | Contract                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /v1/mailboxes/:id/views/:view`                   | Cursor pagination and a snapshot boundary                                            |
| `POST /v1/mailboxes/:id/commands`                     | Typed screening, attention, labels, rules, notes, merge, workflow, and bulk commands |
| `POST/PATCH /v1/drafts`                               | Draft revision and conflict response                                                 |
| `POST /v1/drafts/:id/send`                            | Idempotency key; frozen revision; returns a send-job ID, not a delivery guarantee    |
| `POST /v1/send-jobs/:id/cancel`                       | Atomic pre-submission cancellation or an explicit too-late result                    |
| `/v1/uploads`                                         | Quota reservation, multipart upload, completion verification, scan status            |
| `GET /v1/mailboxes/:id/deliveries/:id/text`           | Plain-text body for terminal and agent clients; HTML-only mail converted server-side |
| `/v1/calendars/:id/events`                            | Versioned event/series/exception operations                                          |
| `GET /v1/calendars/:id/invitations`                   | Invitations one delivery carried: occurrence key and the owner's current answer      |
| `/v1/collections`, `/v1/shared-threads`, `/v1/grants` | Resource-specific permission checks                                                  |
| `/v1/world/posts`, `/v1/world/subscriptions`          | Explicit publish intent and subscriber consent state                                 |
| `/v1/domains`, `/v1/memberships`, `/v1/exports`       | Administrative/long-running operations with status resources                         |
| `GET /v1/changes`, `GET /v1/live`                     | Cursor-based catch-up and WebSocket upgrade                                          |

Web, mobile, desktop, CLI, and TUI use the same command contracts. Provide machine-readable output and stable exit codes. Agent credentials have explicit read, draft, send, screen, delete, calendar, and publish scopes. Default agent access should be read/draft, with separate authorization for consequential actions. Treat email content and attachments as untrusted data, never as instructions granting tool authority.

## 9. Calendar correctness

Use iCalendar and iTIP-compatible data and invitation behavior rather than a naïve events table. These protocols define recurrence, occurrence exceptions, organizer/attendee roles, and scheduling messages. [R1][R2]

Store timed events with their original wall-clock representation and time zone, plus derived instants where appropriate. Store all-day dates as dates, not midnight UTC. Expand recurrence in a bounded requested window; do not pre-generate infinite rows.

A series stores UID, DTSTART/TZID, recurrence rule, inclusion/exclusion dates, organizer, attendee state, and revision/SEQUENCE. Exceptions identify the original occurrence with RECURRENCE-ID. Editing future occurrences splits the series deliberately and preserves mapping for invitation updates.

Reject unauthorized organizer changes and ignore older repeated invitation revisions. Accept/decline creates the appropriate reply, not a normal prose email pretending to be an RSVP. An invitation from a screened-out sender must not silently populate the calendar or trigger notifications.

Reminder jobs reference event ID, occurrence ID, reminder offset, and event generation. An edit, cancellation, or time-zone change invalidates obsolete jobs. Distinguish UTC deadlines from local-calendar semantics. Test both repeated and nonexistent daylight-saving times.

Journal, habits, day photos, and time tracking are private by default even when an event calendar is shared. Week tasks use `(local week anchor, user week-start preference)` and an ordering key, not a fake appointment. Free-time calculation respects visible calendars, busy/transparent status, all-day behavior, and a configurable waking window.

External ICS subscriptions use bounded periodic fetching, validators, item limits, and SSRF protection. Private outbound feed tokens are revocable bearer credentials and must not expose journals, notes, or private annotations. Location autocomplete is a separate data/provider adapter, not a capability invented for D1.

## 10. Privacy, security, and operational mail safety

### Message rendering and attachments

Render sanitized mail on a separate origin in a sandboxed document. Remove scripts, forms, unsafe URLs, active embeds, and unsafe CSS; rewrite CID resources and external image references. App session cookies must never be available to message HTML or public publishing origins.

Block known tracking URLs/pixels and proxy permitted remote images without user cookies, referrers, or user IP forwarding. Validate every redirect, content type, decoded size, and destination; block private/link-local/metadata destinations and defend against DNS rebinding. Reject active SVG or rasterize through a controlled pipeline. [H13]

A proxy hides direct client network details but does not inherently hide the first fetch of a unique tracking URL. Provide remote-images-off and explain that proxying is not a promise to eliminate all timing-based tracking.

Attachments remain private R2 objects. Uploads reserve quota, enforce declared and actual sizes, and enter scanning before publication/sending. Content-type claims and filename extensions are not trusted. Bound archive expansion, recursion, decompression ratios, parser time, and memory. Serve active formats as downloads; render previews in isolated workers/containers.

Large-file links carry an unguessable, revocable grant and optional expiry. Authorization is checked on new requests rather than exposing indefinitely public R2 URLs. Previously downloaded bytes are outside server revocation control.

### Authentication and tenancy

Require strong authentication for mail access and step-up for account recovery, new sending identities, forwarding changes, sharing, and administrative actions. Use HTTP-only secure cookies, CSRF/origin protection, session rotation, revocation, recovery codes, and audited support access. Keep recovery independent of the hosted mailbox.

Server-side search and mail delivery require server-side processing; this design is **not end-to-end encrypted**. Require encryption at rest and in transit, separate private/public buckets, scoped operational access, and credential encryption with versioned keys. Additional envelope encryption for blobs does not make a plaintext search index zero-knowledge.

### Desktop sign-in and device sessions

Desktop clients (X01) authenticate with the same passkeys as the web, without asking the user to copy a reusable mailbox token. A particular React Native passkey package lacking desktop support does not justify pasted tokens: native apps can sign in through the system browser, macOS and Windows expose WebAuthn, and both provide persistent secure credential storage. A mobile-only package is evidence about that package, not about the framework. [N1][N6][N10][N12][N13][N15][N16]

Three concerns are separate and must not be conflated: authenticating the user, granting a session to the desktop application, and restoring that session on a later launch.

**Flow (normative).**

```text
First sign-in
  app creates PKCE verifier/challenge (S256) and a transaction-bound state
    -> opens the selected instance's validated authorization endpoint in the system browser
       (never an embedded WebView)
    -> browser runs the WebAuthn ceremony on the product's HTTPS origin; user approves the device
    -> short-lived, single-use code returns to the registered callback with the issuer (`iss`)
    -> app validates state and issuer, exchanges code + verifier at that instance's token endpoint
    -> refresh credential -> OS secure store; access credential -> memory only
Later launch
  app reads the refresh credential -> renews under server policy -> resumes without a new ceremony
```

- **Authorization code.**
  - Require PKCE S256 with independent random verifier and state values. [N2]
  - Accept only exactly registered redirects: a claimed/private scheme, or a loopback IP literal on any port with a fixed path. Never `localhost`. [N1]
  - Codes are short-lived and single-use, and are consumed atomically before any further check.
  - A replayed code revokes whatever session it issued.
  - No access or refresh token ever appears in a callback URL.
  - Invalid client or redirect errors are shown to the user, never redirected. [N1][N3]
- **Relying party.** The WebAuthn relying party is the fixed HTTPS authentication origin, not the desktop callback. The server verifies challenge, origin, RP ID, signature and user verification. [N5]
- **Consent.** The approval page is unframeable and accepts only same-origin POSTs.
- **Device session.**
  - The desktop receives its own revocable per-device session and never copies browser cookies.
  - Access credentials are short-lived. Refresh credentials rotate on every use, and replaying a rotated one revokes the whole device session (reuse detection). [N3]
  - Idle and absolute expiry, revocation and step-up remain separate controls; persisting a refresh credential does not imply indefinite authorization.
  - Device sessions never carry step-up; consequential actions still require a fresh browser ceremony.
- **Management.** Users can list and revoke device sessions.
- **Fallback.** Where no usable callback exists, the only permitted fallback is the device-authorization grant (short verification code; the device code stays in the app). [N4] A custom copy/paste pairing protocol would need separate review. A full-mailbox reusable token is never the normal sign-in path.
- **Native bridges.** Browser launch, callback activation and secure storage need small native adapters; this does not require a native passkey module. Use the tested React Native desktop platform (e.g. react-native-macos) and, if a native macOS browser bridge is chosen, AppAuth-style redirect handling. [N9][N21] Native passkey UI is an optional enhancement: on macOS it needs `ASAuthorizationPlatformPublicKeyCredentialProvider` and a `webcredentials` associated domain, and on Windows the Win32 WebAuthn API (Windows 10 1903+). [N6][N7][N15]

**Secure storage (normative).** Store only a compact, opaque refresh credential in OS secure storage, namespaced per instance (base URL + issuer) and account. Never use AsyncStorage, preferences or plaintext, and never fall back to plaintext when the secure store fails. [N14]

| Platform | Mechanism                                                                                      | Requirements                                                                                                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Keychain generic password                                                                      | `kSecAttrSynchronizable = false`; this-device-only accessibility. A device-session secret is not synced, which is distinct from the user's passkey provider syncing passkeys. Signing identity, entitlements and keychain query attributes are release-test inputs. [N8][N11]                                                                       |
| Windows  | Credential Manager `CredWriteW`/`CredReadW`, `CRED_TYPE_GENERIC`, `CRED_PERSIST_LOCAL_MACHINE` | Persists for the same Windows user across logons on that computer; "local machine" does not grant other users access. `CRED_PERSIST_SESSION` means the Windows logon session, not the process. DPAPI `CRYPTPROTECT_LOCAL_MACHINE` would let other users decrypt, and `PasswordVault` can roam, so neither is the default. [N16][N17][N18][N19][N20] |

Map native errors to typed states: `MissingCredential`, `StorageUnavailable` (locked or logon session unavailable), `StorageDenied` (entitlement or access), `CorruptCredential`, `UserCancelled`, `CallbackMismatch`, `SessionExpired`, `SessionRevoked`, `NetworkUnavailable`. Record only sanitized native error codes, never credentials.

**Lifecycle.**

| Event                               | Required behavior                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Initial sign-in                     | Await and verify the secure-store write before reporting persistent sign-in.                                    |
| Relaunch / reboot                   | Restore from the stored refresh credential once the user's credential store is available.                       |
| Access expiry                       | Renew without user interaction; serialize refreshes across windows/processes.                                   |
| Offline / 5xx                       | Keep the credential; show a recoverable offline state.                                                          |
| Store locked/unavailable            | Explain and allow retry or browser re-authentication; no plaintext fallback.                                    |
| Rotation saved-failure              | Enter an explicit recovery state; never claim persistence; keep replay detection.                               |
| Expired / revoked / `invalid_grant` | Clear local state and return to browser sign-in.                                                                |
| Sign-out                            | Revoke server-side when reachable; otherwise keep a pending revoke and complete it later; remove local secrets. |
| Session-only mode                   | Never persist the refresh credential; disclose that relaunch requires sign-in.                                  |

**Acceptance (DS01–DS12).** These extend A03/X01. TypeScript checks and JavaScript mocks alone do not satisfy DS02, DS05 and DS12.

| ID   | Required outcome                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DS01 | First sign-in uses a supported browser/passkey combination and returns to the correct app; no reusable token and no clipboard.                                 |
| DS02 | A valid device session survives full process exit and relaunch (closing to the tray does not count), a supported signed upgrade, and an OS reboot.             |
| DS03 | Replayed or expired codes, a wrong state or verifier, unregistered callbacks and duplicate redemption cannot authorize a session.                              |
| DS04 | Cancellation and timeout are recoverable; a second attempt never resumes the first.                                                                            |
| DS05 | Absent, denied, corrupt, locked or unavailable storage and missing entitlements are distinct, actionable states; nothing falls back to plaintext.              |
| DS06 | Refresh is serialized per account; concurrent requests, rotation races and crashes during persistence are tested, with no silent claim of persistence.         |
| DS07 | An expired access credential with a valid refresh credential renews without user interaction.                                                                  |
| DS08 | An offline launch or transient server failure never discards credentials.                                                                                      |
| DS09 | Explicit logout, remote revocation and account switch invalidate and isolate sessions; no credential is reused across accounts.                                |
| DS10 | A restricted browser or callback, and session-only mode, have clear recovery or the authorized fallback; never a downgrade to static-token login.              |
| DS11 | Logs, traces, crash reports, analytics, clipboard, URLs (beyond the code callback), settings storage and IaC state contain no codes, verifiers or credentials. |
| DS12 | Tests run on the actual supported framework versions, native-module architecture, minimum OS, signing and packaging configuration.                             |

Family billing and linked-account convenience must not become implicit permission grants. Public share creation is a consequential action with a preview of what becomes visible. Exclude private comments/notes, hidden recipients, unrelated attachments, and mailbox-specific annotations.

### Instance selection, self-hosting, and distribution

One CLI package and one app per supported platform work with Bye's hosted service or any compatible self-hosted instance. Users never need a build per server; distribution channels may need different signed artifacts, but never server-specific ones. The server URL is runtime configuration, not a build-time constant.

A **compatible instance** implements the published compatibility and authentication profile below. HTTPS reachability or a recognizable name does not establish compatibility or operator trust.

**Compatibility profile (normative).** Each instance publishes, without authentication:

| Document                                                                  | Contents                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/bye-instance` (schema `bye.instance/1`)                 | Canonical base URL, `/v1` compatibility range, authorization issuer, registered native client IDs with their exact redirect URIs, capability names, and account-deletion/support routes.                                                               |
| `GET {issuer origin}/.well-known/oauth-authorization-server{issuer path}` | RFC 8414 metadata naming the exact issuer; authorization, token, revocation and device-authorization endpoints; `S256` only; `token_endpoint_auth_methods_supported: ["none"]`; `authorization_response_iss_parameter_supported: true`. [N1][N22][N23] |

Clients require the `device-session` and `authorization-response-iss` capabilities to sign in; other features are capability-gated. Unknown capability names are ignored.

**Add, validate, and select.**

- Default to the hosted service on first use (validated like any other instance). Allow adding an instance by URL, "Open in Bye" link or QR code, and switching between saved instances. Keep the selected server visible before sign-in and wherever an action's destination could be ambiguous. An unreachable selected instance never causes fallback to hosted.
- The onboarding handoff (`bye://add-instance?url=<https URL>`, or a QR code holding the bare HTTPS URL) is an **add-instance request**, never authentication or permission to act. Any other parameter rejects it. It is handled apart from the OAuth callback, and manual URL entry remains available.
- One shared parser normalizes every address: HTTPS and platform TLS validation only; no embedded credentials, query or fragment; nondefault ports and base paths are part of the identity; trailing-dot, IDN, numeric-IPv4 shorthand and dot-segment forms are rejected rather than rewritten. Private, loopback and link-local literals need an explicit policy (off by default). There is no certificate-validation bypass.
- Probes carry no credentials, cookies, client certificates or account headers, and are size- and time-bounded. A redirect, or a document naming a different canonical base URL, stops validation and presents the new destination for separate validation.
- Metadata is fetched only from the issuer-derived location and must name that exact issuer. Every credential endpoint must be on the issuer's origin, so a candidate cannot pair another issuer's authorization endpoint with its own token endpoint.
- Before saving, show the normalized address and any distinct sign-in origin. Server branding is untrusted. Confirmation saves and selects the instance and permits a new sign-in there; it never reuses another instance's credentials. A changed base URL, issuer or credential endpoint requires revalidation and new authorization: the old credentials are discarded locally without being sent anywhere.

**Authentication across instances.** The device-session flow above applies per instance, with these additions. [N1][N3][N23]

- Distributed apps and the CLI are public clients (PKCE `S256`, no shared secret). Each compatible instance registers the published client IDs (`bye-desktop`, `bye-mobile`, `bye-cli`) and their approved callbacks: `bye://oauth/callback`, the desktop loopback exception, and the device-authorization grant for the CLI.
- Passkeys run in the selected instance's web flow in the system browser; the app never collects credentials in an embedded WebView. Native passkey integration is optional and must not make compatibility depend on listing every self-hosted domain in the binary. [N24][N25]
- Each attempt is bound to its instance, issuer, client ID, redirect URI, single-use `state`, PKCE verifier and a 10-minute expiry. The authorization response carries RFC 9207 `iss`, compared exactly before any code exchange. A missing or wrong issuer, state or redirect, an expired or replayed callback, or a callback after process restart fails without an exchange. The visible selector never decides where a code is redeemed.
- API calls, refresh, revocation and sign-out use only the validated endpoint set for that instance. Bearer requests never follow redirects. Refresh is serialized per session; if it cannot restore a session, the app requires sign-in rather than trying another instance.
- Cloudflare deployment authorization stays separate from Bye sign-in. Handoffs and QR codes carry no Cloudflare credentials, app credentials, codes or tokens.

**Isolation and lifecycle.**

- Instance records are keyed by normalized base URL plus validated issuer; account state additionally by the server's account ID. Names and email addresses are never cross-instance keys. Credentials, preferences, drafts, caches, pending writes and background work are isolated per instance/account; a server claiming another's issuer gains nothing of that server's local state, and a second saved server may not claim a saved issuer with different endpoints.
- The instance/account context is fixed when an operation starts. Switching never retargets in-flight requests or queued writes, cancels unfinished sign-in attempts and rejects their late callbacks; results of already-submitted work affect only their originating context.
- Secure storage holds one refresh-credential slot per instance. When it is unavailable, persistence fails explicitly. Backup/restore behavior and reauthentication are documented per platform.
- **Sign out** stops authenticated work for that session, attempts revocation, clears local credentials and account caches regardless of connectivity, and reports unconfirmed revocation separately. It does not claim the browser or identity-provider session was cleared.
- **Remove instance** also clears its configuration and all local account state after confirmation. It never deletes a server account, deployed resources or server data.
- **Delete account** is a distinct, confirmed operation on the named instance/account, opened on that instance's deletion route, showing server-confirmed pending, completed or failed status. [N29][N30]

**CLI.** `BYE_API` takes precedence, then the saved default (`bye instance use` or `bye login --api`), then hosted on first use. An override applies to one invocation, never rewrites the saved default, and uses only credentials saved for exactly that instance (or `BYE_TOKEN`). An invalid override fails rather than falling back. An unconfigured target fails locally (exit 3), with no browser prompt and nothing sent. `bye instance show` reports the effective target on request; `--verbose` reports it on stderr, never in command output. `bye instance add` validates before saving. Plain-HTTP loopback targets need `BYE_INSECURE_LOOPBACK=1`; private-network HTTPS needs `BYE_PRIVATE_NETWORK=allow`.

**Shared client.** Product UI, API contracts, instance validation and authentication state transitions live in `packages/native-shared`; the CLI shares contracts and behavior, not rendering. Platform shells provide secure storage, browser sessions and callbacks, deep links, widgets, share actions and OS integration. Every shell entry point carries an explicit instance/account context: widgets and share actions never read a mutable global server setting to choose a write destination, and widget snapshots name their server. The same rule applies to notifications and background work if shipped. No executable code, privileged shell instructions or updater configuration is ever loaded from an instance.

**Distribution.**

- Keep stable public package and bundle IDs, one app per platform, and in-app self-host setup. Publish a release matrix: supported OS versions and architectures, channels, artifact versions, identifiers, signing ownership and lineage, callback registrations, secure-storage behavior, and supported API range. "Same app identity" does not mean identical binaries or automatically compatible channel transitions.
- Desktop installers are signed, with verified updates for every declared target; the update authority is the distribution channel, never the selected instance. Store builds use their store's update mechanism. Migrations must not mix instances.
- The CLI package is published with workspace dependencies resolved, and the packed artifact is installed and run in a clean environment (entry point, version, instance configuration, sign-in).
- Android ships through Play and signed APK downloads with a compatible application ID and signing lineage, increasing version codes, and tested advertised transitions. Don't confuse the Play upload key with the app-signing key; record signing fingerprints used by native-auth associations and developer-verification requirements. [N26][N27]
- iOS ships through the App Store. Web distribution requires confirmed authorization, eligible users and OS versions, a registered domain and current notarization rules. [N28]
- Provide accurate privacy disclosures (native-client collection separate from instance-operator processing), support details, and a reviewer demo instance with reproducible clean-device sign-in and self-host selection, without production data or an authentication bypass.
- Where account creation is offered, provide in-app deletion initiation and the store-required web deletion route, routed to the selected instance/account. [N29][N30]

**Licensing.** Bye is MIT licensed; the standard text is in `LICENSE` at the repository root. These requirements apply whenever source or builds are distributed publicly (P0.10); a private self-hosted deployment does not need them.

- Every workspace manifest declares `"license": "MIT"`, and the readme identifies the license.
- Third-party notices are preserved and aggregated in `THIRD_PARTY_NOTICES.md` (model: `demo-reel/THIRD_PARTY_NOTICES.md`); dependency licenses are checked for MIT compatibility.
- `design.pdf`, `screenshots/`, demo-reel audio, and any other committed media contain no HEY/37signals-derived assets, and the product name is checked for trademark confusion with HEY before public distribution.
- Nothing represents MIT as licensing HEY/37signals trademarks, branding, or proprietary assets.
- User-facing text uses generic names, never HEY's coined feature names: Inbox (Imbox), Newsletters (The Feed), Receipts (The Paper Trail), New Senders (Screener), Follow Up (Bubble Up), Passcode (Speakeasy), Blog (HEY World), Reply Queue (Focus & Reply), Read All (Read Together). The HEY names remain only in this spec, as references for the §2 parity ledger, and in internal identifiers (view names, command tags) that are wire contracts. "HEY" appears only to describe the inspiration, with a non-affiliation notice, never as branding or in a tagline.

**Acceptance (NA01–NA10).** These extend X01/X02. Evidence names the exact artifacts, OS versions, instance versions and expected/observed results. A development-only build or an unspecified "platform review check" satisfies nothing.

| ID   | Required outcome                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NA01 | The same released artifact connects to hosted and two independent self-hosted instances (one on a domain absent from the build): passkey sign-in, an API call, refresh, switching, restart and sign-out. Repeated account names/IDs across servers don't merge state.                                                   |
| NA02 | URL entry, "Open in Bye" and QR input share validation and confirmation. Malformed URLs, invalid certificates, unexpected redirects, unsupported metadata and injected authentication payloads fail without changing the active instance or sending credentials.                                                        |
| NA03 | Sign-in started on A, a switch to B, then A's callback: rejected without an exchange on B or a change to B's session. Wrong/missing issuer, wrong state/redirect, replay, expiry and process restart fail safely; mixing issuers' endpoints yields no credentials.                                                      |
| NA04 | Switching during API requests, refresh, queued writes and a shipped shell action cancels the work or keeps it in its original context; it never uses the new server with old credentials or fills the wrong account's UI or cache.                                                                                      |
| NA05 | The CLI shows its precedence and effective target. `BYE_API` doesn't change the saved default, fall back to hosted, or reuse another target's credentials. An unconfigured noninteractive target fails without a browser prompt or credential disclosure.                                                               |
| NA06 | Locked or unavailable storage creates no plaintext. Sign-out and removal work offline, clear the required local state and block late refresh/callback results; unconfirmed revocation is reported. Backups, logs, crash reports and extension storage leak no secrets or cross-instance data.                           |
| NA07 | Current, oldest supported and unsupported instance versions are tested; incompatible servers get actionable errors without rerouting. Updates preserve instance selection and isolation; every advertised channel transition passes install/update, sign-in and secure-storage checks with the real signing identities. |
| NA08 | Clean installs of each declared desktop/mobile artifact and the packed CLI succeed; signature, integrity, platform-authorization and packaging checks pass; tampered or wrongly signed updates are rejected.                                                                                                            |
| NA09 | A clean-device reviewer completes documented sign-in and self-host setup. Deleting an account on A never affects B; app and web deletion routes show the right operator, scope and status; removing A locally is never presented as server deletion. Disclosures match shipped behavior.                                |
| NA10 | With the hosted service down, an already-configured self-hosted instance completes the baseline sign-in and API flow. Any optional central dependency is documented and never changes where credentials go.                                                                                                             |

### Abuse and deliverability

Implement per-user, per-domain, per-identity, and platform sending budgets; new-account ramp-up; complaint/bounce monitoring; suppression policies; compromise detection; outbound suspension; and operator review. Separate interpersonal, product-notification, and subscription streams where transport policy permits.

Trust only authenticated transport evidence for SPF/DKIM/DMARC/ARC decisions, not an arbitrary `Authentication-Results` header supplied by a sender. Sender approval never overrides a detected forgery. Maintain explicit false-positive recovery and quarantined-original access.

Away replies do not answer empty envelope senders, automated mail, list traffic, spam, or other away replies. Apply cooldowns and an `Auto-Submitted` indication. Forwarding uses a verified destination and loop markers/hop limits; forwarding configuration is not an open relay.

Review provider-side content logging as well as our own logs: Cloudflare documents sent-email previews enabled by default for new sending domains. Disable them for private mail unless an explicit operational policy justifies them. [C19]

## 11. Domains, collaboration, publishing, and billing details

### Domains

Provision with a resumable state machine:

```text
requested -> ownership-proven -> zone-authorized -> dns-configured
          -> inbound-tested -> outbound-tested -> active
```

Reserve addresses transactionally before exposing routes. Preserve existing DNS records and show changes before applying them. Test DKIM alignment, SPF/DMARC outcomes, inbound mail, outbound replies, and externally hosted send-as separately. DNS API access is narrowly scoped and revocable.

Domain onboarding shows the selected zone, previous and proposed MX/routing configuration, verification steps, and rollback procedure, then requires separate explicit confirmation. The first-release cutover is manual (§15.11); this specification does not authorize DNS automation for it. Verify external delivery and stored-message retrieval before declaring readiness, and preserve mail accepted during cutover or rollback. Previews never receive production mail, credentials, or subscriber data.

Cloudflare's documented onboarding selects a domain in the configured Cloudflare account. Customer-controlled zones and arbitrary DNS providers need an explicit supported onboarding model; do not promise “paste these MX records anywhere” without validation. Existing mail-provider MX coexistence is not the default migration strategy. [C19]

Support aliases in the application directory, not by exhausting per-domain routing rules. Catch-all is opt-in and does not grant sending authority for arbitrary local parts. Suspending a member immediately disables sending and interactive access while applying a documented inbound retention/forwarding policy.

### Shared content

Sharing history grants access to explicitly selected existing content. Future-reply inclusion is visible in the sharing UI. Each read rechecks current grants; private comments stay inside the shared resource and never enter the MIME builder. Collections reference threads and aggregate their timelines without creating uncontrolled forwarding copies.

Internal redelivery between accounts validates both account permissions and uses an idempotent transfer record. It is not an SMTP round trip. Moving versus copying is explicit, including treatment of source notes and labels.

### Publishing

Intercept the special publishing address only from an authenticated internal send/publish operation. A forged external From header must never publish a post. Copy only selected content into a public-content namespace; do not make the original private R2 object public.

Public posts use a separate Worker/origin with controlled caching, RSS, content revisions, unpublish, and cache invalidation. Subscriber imports invite confirmation rather than silently creating an opted-in audience. Each post version becomes at most one newsletter publication with an immutable recipient snapshot, delivered through `NewsletterProvider` (§5.5); subscribers never see each other's addresses. Eligibility, freshness, and publication state are checked again before every provider step.

### Billing and closure

A payment processor is an explicit external boundary. Its signed events update an idempotent D1 billing ledger and entitlements; checkout success in a browser does not prove payment. Family seats affect payment, not data access.

Keep paid-address reservation and forwarding eligibility as durable records independent of an active mailbox subscription. Account deletion, cancellation, and domain removal are different operations. Before committing to indefinite forwarding, fund its storage, verification, abuse, and transport costs; do not silently substitute address recycling for the targeted feature. [H16]

## 12. Capacity, lifecycle, and recovery targets

These are proposed engineering targets, not Cloudflare guarantees or measured results.

| Measure              | Initial target / operating rule                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Availability         | 99.95% monthly application API target, tracked separately from external delivery                                               |
| Mailbox interactions | p95 under 500 ms in the tested client-to-authority geography; report cross-region latency separately                           |
| Inbound visibility   | p95 under 5 seconds after durable receipt, excluding quarantine/heavy-processing paths                                         |
| Search freshness     | p95 under 10 seconds; visible backlog watermark during degradation                                                             |
| Scheduled actions    | p99 dispatched within 60 seconds of due time under healthy dependencies; device receipt is not guaranteed                      |
| Blob quota           | Configurable per plan; include originals, extracted parts, large-file uploads, and retained exports in accounting              |
| Storage safety       | Alert at 50% of a shard budget; split/rebuild before 70%; leave headroom for indexes, migrations, and recovery                 |
| Recovery objective   | No acknowledged-content loss for replayable application-stage failures; separately validate regional/platform disaster RPO/RTO |

**Sizing scenario, not forecast:** 10,000 users × 100 incoming messages/day × 30 days = 30 million incoming messages/month. At an assumed 200 KB average original wire size, that is about 6 TB/month of new original storage before deletion. This average already includes encoded attachments; add extracted copies and indexes separately, rather than counting the same attachment twice without explanation. At 10 outbound messages/user/day, the scenario adds 3 million outbound submissions/month.

Build a cost model from retained R2 byte-months, blob operations, DO rows read/written and duration, FTS write amplification, D1 control-plane operations, queue operations/retries, Workflow steps, Container CPU/memory, transports, push, and observability. Do not estimate the business from Worker request pricing alone. Shared Cloudflare sending quotas/reputation can couple otherwise separate tenants. [C2]

Mail bodies stay out of mailbox SQL so large attachments do not consume the 10 GB object budget. Search is independently sharded. If mailbox metadata itself approaches its budget, migrate to a coordinator plus stable thread-keyed metadata shards using versioned routing, copy/catch-up, and a fenced cutover. That migration must ship before the supported mailbox envelope can exceed a single authority's capacity; no “unlimited mailbox” promise is justified by unlimited object count. [C6]

Use checkpoints and retained change/outbox history for mutable-state recovery, plus immutable message originals. Restore drills must cover a mailbox, an organization/shared resource, a calendar, and a complete export. A raw `.eml` archive alone cannot restore sender policies, private notes, jobs, or grants.

Proposed retention defaults: Trash 30 days; Spam and Screened Out 90 days; user-configured recycling for other eligible mail. These mirror publicly described defaults where documented. [H4] Blob garbage collection is reference-aware and delayed; shared/public copies have distinct ownership. Erasure writes tombstones across indexes, blobs, grants, and job queues, with backup-expiry rules and tombstone replay after restore to prevent resurrection.

## 13. Delivery sequence and release acceptance

Release acceptance is behavioral, not checklist coverage (§2.4). Mail correctness comes first: ambiguous delivery stays `unknown` and is never blindly retried (§5.2). Cross-client gaps are product gaps, and deployment, backups, recovery, migrations, monitoring, performance, and failure handling are release requirements.

### 13.1 Incremental build sequence

| Stage                                  | Deliverable                                                                                                                                                                                | Exit gate                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Feasibility                         | Pinned Effect v4/Alchemy beta toolchain; isolated Alchemy stack and state bootstrap; typed bindings; real domain, ingress journal, R2 originals, outbound adapters, MIME/calendar fixtures | Dependency/API compatibility, SQLite DO provisioning, queue consumer wiring, Workflow checkpointing, transport policy, failure behavior, and round-trip threading validated |
| 1. Durable mail core                   | Identity, mailbox authority, screening, primary views, draft/send jobs, attachments, search, replay                                                                                        | Injected crashes do not lose committed mail or silently duplicate send intents                                                                                              |
| 2. Personal feature parity             | Attention piles, Bubble Up, notes/clips, workflows, rules, external identities, privacy, exports                                                                                           | E01–E24 pass on web and client contracts                                                                                                                                    |
| 3. Calendar                            | Calendar engine, invitations, sharing/feeds, weekly tasks, habits, journal, timers                                                                                                         | C01–C10 pass including recurrence and time-zone fixtures                                                                                                                    |
| 4. Domains and collaboration           | Onboarding, administration, extensions, shared threads/collections, public links                                                                                                           | O01–O05 pass with adversarial permission tests                                                                                                                              |
| 5. Publishing and commercial lifecycle | World, subscriber delivery, family/seat billing, closure and forwarding                                                                                                                    | P01–P02 and A01–A04 pass; qualified newsletter provider operational (§5.4)                                                                                                  |
| 6. Client parity                       | Desktop/mobile surfaces, offline behavior, CLI/TUI, scoped agent actions                                                                                                                   | X01–X02 and NA01–NA10 pass; a PWA does not stand in for unimplemented native surfaces                                                                                       |
| 7. Production hardening                | Load, D1/DO migrations, Alchemy state restore and drift drills, preview isolation, release/rollback controls, erasure, accessibility, monitoring                                           | All feature IDs pass; transport gates signed off; no unintended resource replacement, secret leakage, or unapproved telemetry                                               |

### 13.2 Release profiles and priorities

Every release declares a release profile. Release profiles describe who is served and what is sold; they are independent of the §1 deployment profiles, which describe infrastructure.

| Priority | Meaning                                                                                |
| -------- | -------------------------------------------------------------------------------------- |
| **P0**   | Blocks the applicable production release, paid launch, or primary-mail claim.          |
| **P1**   | Required before broad adoption or advertising the affected feature/client as complete. |
| **P2**   | Bounded post-launch work whose limitation is documented.                               |

Some P0 items apply only to certain profiles or advertised surfaces; this table is authoritative:

| Item                      |  A — private/self-hosted  | B — hosted, no paid checkout |     C — paid hosted     |
| ------------------------- | :-----------------------: | :--------------------------: | :---------------------: |
| P0.1 Deployment           |             ✓             |              ✓               |            ✓            |
| P0.2 Personal outbound    |             ✓             |              ✓               |            ✓            |
| P0.3 Inbound retry        |             ✓             |              ✓               |            ✓            |
| P0.4 Recovery             |             ✓             |              ✓               |            ✓            |
| P0.5 Monitoring           |             ✓             |              ✓               |            ✓            |
| P0.6a Server/web security | ✓ (pen test not required) |              ✓               |            ✓            |
| P0.6b Native security     |   if native advertised    |     if native advertised     |  if native advertised   |
| P0.7 Performance          |             ✓             |              ✓               |            ✓            |
| P0.8 Hosted obligations   |                           |              ✓               |            ✓            |
| P0.9 Billing              |                           |                              |            ✓            |
| P0.10 MIT licensing       |  if distributed publicly  |              ✓               |            ✓            |
| P1 items                  |  for advertised surfaces  |   for advertised surfaces    | for advertised surfaces |

Regardless of profile, P1.5 is required before World email subscriptions are advertised as production-ready; web/RSS publishing may reach an earlier, independent milestone.

Each item names the `infra/EVIDENCE.md` rows (EV*n*) that carry its evidence (§2.4).

### 13.3 P0 — production foundation

**P0.1 Real Cloudflare deployment (EV6, EV8).** Deploy to a real non-production Cloudflare account before production release. A fresh `dev-*` deploy succeeds; a second deploy is a no-op or expected update only; staging succeeds through reviewed CI; declared resources match the plan; D1/DO migrations apply; state backup/restore works; concurrent deploys serialize or fail closed (§15.6, §15.10).

**P0.2 Personal outbound mail qualification (EV1, EV3).** The provider is Cloudflare Email Service sending (§1); any other personal transport qualifies separately under this item.

- Sending-domain onboarding is approved for arbitrary recipients; the §1 limits (5 MiB, 50 recipients) are recorded and enforced before submission.
- DKIM passes and SPF/DMARC align for the supported sending-domain configurations.
- New, reply, reply-all, forward, undo, and Send Later work against external mailboxes; EV3's Gmail/Outlook/Apple Mail procedure passes (threading, Bcc envelope-only, wire `Message-ID` recorded).
- Post-submission timeouts become `unknown` rather than blind retries, and the user sees a clear `unknown` state with guidance; provider-exposed per-recipient failures are surfaced.
- Provider sent-email previews are disabled and attested (`PROVIDER_SENT_PREVIEWS=disabled`, §10).

**P0.3 Inbound SMTP retry behavior (EV2).** External SMTP delivery is tested against handler, storage, and timeout faults (`BYE_FAULT_INGRESS`). Temporary faults yield retryable behavior; a retry commits exactly once; stored-but-uncommitted receipts reconcile; transient faults never become permanent sender rejection.

**P0.4 Recovery (EV7, EV8).** The §15.9 rollback interval is N−1: readers and queue consumers accept the prior release's wire and schema version, and at least 14 days pass before a contract step removes N−1 support. State and representative mailbox, organization/shared-resource, calendar, and full-export data restore (§12); rollback is tested with queued work and running Workflows; N−1 Workflows, send jobs, and messages survive the window; lost alarms/jobs reconstruct; erasure tombstones replay after restore; off-account critical backups exist; at least one staging restore drill (`infra/drills/*`) is recorded.

**P0.5 Monitoring (EV8).** Each alert below has a threshold, routes to a named on-call owner, and has fired at least once in staging.

| Signal                    | Initial threshold                                             |
| ------------------------- | ------------------------------------------------------------- |
| Worker error rate         | > 1% of requests over 5 min                                   |
| Queue backlog             | oldest message > 5 min                                        |
| DLQ depth                 | > 0                                                           |
| Reconciliation failure    | any failed run, or no successful run in 2 scheduled intervals |
| Container failure         | scanner/MIME container unhealthy > 5 min                      |
| Scheduled-action lateness | p99 > 60 s (§12)                                              |
| Shard storage             | > 50% of budget (§12)                                         |

Cost/capacity counters have a dashboard; ordinary telemetry excludes subjects, bodies, attachment names, and full addresses; advertised clients have crash/error reporting or a documented exception.

**P0.6a Server and web security (all profiles).**

- HTML mail rendering is sanitized and isolated; CSP blocks script execution and remote content by default; the tracking-pixel/remote-image policy is enforced (§10).
- Authorization and tenant-isolation tests cover every `/v1` route and RPC entrypoint, including revoked grants and suspended members.
- Session/device management, passkeys, and recovery (A03) pass adversarial tests.
- Attachment scanning fails closed.
- An independent security review or penetration test of the web client and API is completed before Profile B.

**P0.6b Native security (only when a native client is advertised).**

- Sealed native draft storage (`packages/native-shared/src/sealed-store.ts`) uses an audited AEAD. Hermes lacks `crypto.subtle`, so use an audited pure-JS implementation such as `@noble/ciphers` XChaCha20-Poly1305 with 24-byte random nonces, or a vetted native crypto module; legacy `s1.` records migrate on read. A custom construction is acceptable only after an independent cryptographic review.
- Production OAuth redirects are platform-appropriate; callbacks remain instance/issuer-bound; secrets use OS secure storage (§10).
- Signed-build relaunch, reboot, upgrade, sign-out, and instance-removal behavior is verified under P1.6 for each advertised platform.

**P0.7 Performance (EV5).** The §12 targets are met against staging under a documented load profile (k6 or equivalent, sized from the §12 scenario); `BYE_BENCH_MESSAGES=50000 pnpm evidence:bench` passes; results and the maximum tested scale are recorded.

**P0.8 Hosted service obligations (Profiles B and C).**

- **Account lifecycle:** sign-up, invitation, suspension, cancellation, account deletion, and domain removal are distinct, tested operations (§11), with erasure tombstones as in §12.
- **Data portability:** A04 exports (MBOX, vCard, ICS, and notes/tasks/settings) are available to users.
- **Abuse and deliverability:** the §10 controls are tested against a simulated compromised account.
- **Policies:** published terms of service, privacy policy, acceptable-use policy, and a data-processing statement listing subprocessors (Cloudflare, mail providers, push, payments).
- **Support:** a support contact, an operator runbook for account recovery and abuse reports, and a status page.

**P0.9 Paid-hosted billing (Profile C).** Users can purchase and manage the supported plan; entitlements follow the signed-event billing ledger (§11); renewal, cancellation, failure, seat, and refund flows reconcile; webhook replay is idempotent; delayed or duplicate webhooks cannot incorrectly grant or remove access; billing state is visible; family billing never grants data access (A01).

**P0.10 MIT licensing and distribution (when distributed publicly).** The §10 licensing requirements pass.

### 13.4 P1 — product gaps

**P1.1 E09 — conditional Bubble Up and send-and-pop.** Scheduling, pin, pop, clear, and send-and-bubble are not sufficient: E09 also requires conditional no-reply resurfacing and send-and-pop.

```ts
type BubbleCondition = "always" | "if-no-reply";

type BubbleSchedule = {
  at: number;
  condition: BubbleCondition;
  generation: number; // assigned by the mailbox authority, never by clients
};

type AfterSend =
  | { _tag: "None" }
  | { _tag: "MarkDone" }
  | { _tag: "BubbleUp"; at: number; condition?: BubbleCondition } // absent = "always"
  | { _tag: "ClearBubble" }; // send-and-pop: the reply resolves the bubble without resurfacing
```

Send jobs persist `afterSend` as JSON. `condition` is optional and defaults to `"always"` so jobs queued by the previous release still parse; readers accept `ClearBubble` before any client emits it (expand → migrate → contract within the P0.4 window).

A **qualifying reply** suppresses an `if-no-reply` bubble: a message delivered to the thread after the triggering send, from a sender that is not one of the user's own identities, and not an auto-reply (`Auto-Submitted` other than `no`, or an out-of-office pattern), a delivery status notification or bounce (empty envelope sender, `multipart/report`), or mail classified as spam or screened out. A reply from any one original recipient qualifies; the user's own sends from other clients never do.

Acceptance: an unconditional bubble resurfaces on time; a no-reply bubble is suppressed by a qualifying reply and by none of the excluded cases; an incoming reply surfaces promptly despite a later timer; rescheduling fences old generations; retries are idempotent; the after-send action executes only on `AcceptedByTransport`; send-and-pop has an explicit tested transition; N−1 send jobs without `condition` behave as `"always"`; advertised clients expose consistent semantics.

**P1.2 C09 — email/calendar integration.** The calendar cover panel is an optional collapsible panel in the mail view showing today's agenda and the next event, with a link into the calendar; the user can hide it, and the preference persists. Acceptance: invitation email supports accept/tentative/decline; RSVP emits valid iTIP and updates state; create-event-from-message uses a permission-checked backlink; native clients expose the same actions as web; the cover panel meets this definition on each advertised client; duplicate or out-of-order invitation updates remain safe.

**P1.3 X02 — TUI parity.** X02 claims both CLI and TUI, so the TUI (`apps/cli/src/tui.ts`) needs parity alongside the CLI, not only a mail-list/triage surface.

- **Reading:** complete thread bodies; message and attachment metadata navigation.
- **Writing:** compose, reply, reply-all, and forward, with undo and Send Later.
- **Triage:** screening and attention actions (including Bubble Up per P1.1); trash, spam, and restore.
- **Search:** mail search.
- **Calendar:** agenda and day views; basic event create/edit; invitation response (C09).
- **Safety:** structured errors; terminal-control sanitization of all rendered mail content.
- **Accessibility:** works without a mouse, at 80×24, and in a monochrome terminal.
- **Tests:** interactive acceptance tests cover each workflow above.

**P1.4 Domains, forwarding, external identities (EV4).** Customer-domain onboarding (§11) succeeds on a disposable real zone; unrelated DNS records survive; DKIM/SPF/DMARC checks pass; removal preserves other routing; forwarding destination verification, loop protection, and failures are tested; external send-as authority is rechecked at dispatch; revoked authority blocks subsequent sends.

**P1.5 World subscription delivery (EV1).** A `NewsletterProvider` is qualified (§5.4); newsletter traffic never falls back to personal transport; the recipient remains opted in at dispatch; a pre-dispatch unsubscribe excludes delivery; confirmation and unsubscribe work; webhooks authenticate and persist before acknowledgement; bounces and complaints update suppression; cancellation reports coverage; exports preserve consent metadata.

**P1.6 Native release matrix (EV5).** A native platform is supported only after a signed release build passes: compile; signing; fresh install; upgrade; relaunch/reboot auth behavior; sign-out/remove-instance semantics; secure storage (P0.6b); attachments; push if advertised (P1.7); share surface, widget/timer, and deep links if advertised; accessibility audit. This complements DS01–DS12 and NA01–NA10 (§10). Linux is PWA-only (§1) and documented as such.

**P1.7 Push notifications (when advertised on any client).** APNs/FCM/WNS credentials are stage-scoped; registration, rotation, and revocation on sign-out or instance removal work; payloads contain no subject, body, or full address unless the user opts in; delivery failures and invalid tokens prune registrations; notifications respect screening and attention state; tested on signed builds.

**P1.8 Location lookup (C10, when autocomplete is advertised).** The adapter is stage-configured with recorded quota and cost; queries are not linked to user identity beyond what the provider requires; it fails soft (free-text locations still work); rate limits are enforced per user.

### 13.5 P2 — bounded limitations

- **P2.1 C03 long recurrence rules:** document and validate supported recurrence bounds, or redesign expansion so valid long-count rules remain discoverable. Accepted events never silently lose future occurrences without a visible warning.
- **P2.2 C05 resumable ICS import:** durable checkpoints for large imports. A restart resumes after the last committed batch; replay remains idempotent; checkpoint identity, cleanup, and cancellation semantics are specified.
- **P2.3 Mailbox metadata sharding:** monitor against the §12 storage-safety rule; the §12 shard migration preserves authority and ordering guarantees and is benchmarked before production mailboxes approach 50%.
- **P2.4 Reconciliation scale:** load-test scheduled catalog reconciliation and record the maximum tested scale and duration. If one invocation cannot meet targets safely, partition through queues/Workflows; reconciliation remains idempotent.

### 13.6 Release gates and phases

A production release must not claim full parity until every applicable gate passes:

| Gate | Name         | Satisfied by                                             |
| ---- | ------------ | -------------------------------------------------------- |
| G1   | Deployment   | P0.1                                                     |
| G2   | Mail         | P0.2, P0.3, and P1.4/P1.5 where advertised               |
| G3   | Recovery     | P0.4                                                     |
| G4   | Security     | P0.6a, and P0.6b where native is advertised              |
| G5   | Clients      | P1.1–P1.3, P1.6, and §2.4 rows for the advertised matrix |
| G6   | Integrations | P1.4, P1.5, P1.7, P1.8 for each advertised adapter       |
| G7   | Operations   | P0.5, and P0.8 for hosted profiles                       |
| G8   | Performance  | P0.7                                                     |
| G9   | License      | P0.10 where applicable                                   |
| G10  | Commercial   | P0.9, paid hosted only                                   |

Release work follows four phases. They order what is proven and advertised; they do not replace the build stages in §13.1. For the first real-user release, dependable mail delivery, security, and recovery come first, then the E09/C09 gaps, then a wider advertised client and integration matrix.

| Phase                                         | Scope                                                                                                                                  | Exit                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1. Prove the service                          | P0.1–P0.7, and P0.10 if distributing publicly                                                                                          | Bye can safely carry real mail in a controlled release (Profile A)               |
| 2. Close core workflow gaps                   | P1.1 (E09), P1.2 (C09), P1.3 (TUI parity), behavioral acceptance for under-tested UI paths; `infra/PARITY.md` populated                | Advertised core mail/calendar workflows are behaviorally complete                |
| 3. Release clients, integrations, and hosting | Native platforms (P1.6, P0.6b), custom domains and forwarding (P1.4), push (P1.7), optional location (P1.8), hosted obligations (P0.8) | Every advertised surface has explicit acceptance evidence (Profile B)            |
| 4. Commercial and publishing                  | Billing (P0.9), newsletter-provider qualification (P1.5), bounded P2 scale/calendar gaps                                               | Commercial and publishing promises match the accepted implementation (Profile C) |

### 13.7 Minimum adversarial acceptance suite

| Area                     | Required tests                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screening                | Unknown sender; approved sender spoof; domain allow versus exact block; Speakeasy rotation; approval racing arrival                                                                                                        |
| Seen state               | Two devices; new reply during mark-all; unfollowed replies; read in Screener without approval                                                                                                                              |
| Deferred actions         | Cancellation racing dispatch; stale generations; object eviction; missed alarm registration; DST change                                                                                                                    |
| Sending                  | Double click with same/different keys; two devices on one draft; timeout after acceptance; partial recipient failure; provider event reordering                                                                            |
| MIME                     | Mixed encodings, malformed boundaries, nested messages, long References, inline CID, hidden recipients, signed/opaque attachments                                                                                          |
| Attachments              | Size limits, interrupted multipart upload, archive bombs, scan failure, revocation, cross-tenant key guessing                                                                                                              |
| Privacy                  | Script/CSS/URL abuse; image redirect/rebinding; unique tracker URL behavior; no private data in public shares or logs                                                                                                      |
| Search                   | Exact addresses, phrases, Unicode/CJK, punctuation, exclusion filters, Trash, late index events, revoked-grant results                                                                                                     |
| Calendar                 | All-day across zones; DST gap/fold; recurrence exceptions; series split; invitation updates/cancellations; unauthorized organizer                                                                                          |
| Collaboration            | Sharing and revoking while a client is connected; private-note leakage; membership suspension; future replies; copied versus moved ownership                                                                               |
| World                    | Forged publish mail; confirmation/unsubscribe races; imported audience consent; duplicate fanout; unpublish cache purge                                                                                                    |
| Mail routing             | Disabled, unauthorized, or incompatible routes rejected before a provider call; personal, transactional, forwarding, and newsletter paths tested independently; no newsletter-to-transactional fallback                    |
| Inbound durability       | Failures injected during original storage, receipt commit, and queue publication; accepted messages retrievable and processing resumes; transport redelivery distinguished from distinct messages sharing a `Message-ID`   |
| Cutover and isolation    | Reviewed manual cutover and rollback on a test domain; external test mail received and retrieved; previews cannot reach production routes, credentials, or data                                                            |
| Retry safety             | Concurrency, process loss, rate limiting, and timeouts before/after acceptance; covered retries reuse the operation; ambiguous and expired protection stay visible; partial success never resends accepted recipients      |
| Newsletter consent       | Unsubscribe from creator A while subscribed to B; stale subscribe, duplicate unsubscribe, bounce/complaint replays; correct scope, no reactivation, bounded convergence; unsubscribe just before and after submission      |
| Broadcast recovery       | Draft creation, sending, scheduling, and cancellation interrupted independently; the same publication resumes or reconciles; partial delivery, audience changes, and cancellation racing dispatch                          |
| Provider events          | Unauthenticated or cross-installation events rejected; replay and reordering tolerated; supported missed events recovered; unresolvable gaps exposed; provider replaced/disabled without losing history or replaying       |
| Portability              | MBOX/vCard/ICS round trips; export consistency during new arrivals; notes/settings export; post-cancellation reservation/forwarding                                                                                        |
| Operations               | Queue expiration/DLQ replay; lost scheduling hints; capacity limits; key rotation; shard migration; backup restore with erasure tombstones                                                                                 |
| Clients                  | Keyboard-only, screen readers, small/large layouts, offline draft conflict, device logout, widget/timer state, CLI permission boundaries; instance switching races, cross-instance callbacks and issuer mix-up (NA02–NA05) |
| Effect v4                | Exact dependency resolution; schema compatibility; expected failures versus defects; aborted streams/finalizers; two concurrent principals; interrupted send reconciliation                                                |
| Alchemy infrastructure   | Two clean deploys without persistent resource replacement; typed binding completeness; SQLite namespace creation; cross-worker namespace identity; explicit queue consumer/DLQ wiring; no runtime management credentials   |
| Infrastructure lifecycle | D1/DO expand-contract migrations; failed deploy recovery; serialized deployment writers; state backend/key recovery; preview destruction cannot touch production; deletion/replacement policy rejects unsafe plans         |
| Deployment privacy       | CLI opt-out verified; deployed state-Worker version/artifact and exporter bindings checked independently; opaque resource names; secret redaction; no unapproved external observability egress                             |

### 13.8 Definition of done

A parity release is done when:

1. Every advertised feature has an acceptance contract, and no unimplemented parity row is hidden behind the phrase “later”.
2. Every advertised client has a passing support matrix for those features, and every client limitation is visible.
3. All P0 items applicable to the release profile (§13.2) are closed.
4. P1 items are closed, or the affected capability is explicitly excluded from advertised scope.
5. Remaining P2 limitations are bounded and documented.
6. All transport and durability gates have evidence, including real-provider evidence for every enabled external traffic or integration class.
7. Mutable state, original content, and deployment state can be restored, and restore and rollback drills have passed against staging.
8. Operational alerts and ownership are active, and §12 performance targets are met against staging.
9. Pinned application/IaC builds pass, and the product's privacy claims match its actual runtime and deployment architecture.
10. Where distributed, the release is MIT licensed with compatible notices (§10).
11. Release notes describe the supported release profile, clients, integrations, and known limitations, and each capability is claimed only at the completion level it reached (§2.4), never by equating tagged test coverage with production acceptance.

## 14. Decisions still requiring implementation evidence

The architecture is sketched, but the following are not established by public documentation alone:

1. Approval and operational limits for general hosted personal mail and World subscription sending, and the enabled traffic-class/provider matrix. Resolve the missing personal/forwarding routes without silently dropping those goals.
2. Exact ingress retry/SMTP behavior under handler, storage, and platform failures.
3. Wire `Message-ID` retrieval, MIME normalization, and invite rendering for each chosen transport.
4. A scalable, authorized customer-zone onboarding and forwarding model.
5. Real performance, parser resource usage, lexical-search quality, native surface coverage, and recovery results.
6. Exact Effect v4/Alchemy beta dependency compatibility, Worker bundle boundaries, and support for every resource option in the selected release.
7. Stable DO namespace ownership, generated SQLite class migrations, D1/DO data migration behavior, and rollback with queued work and in-flight Workflows.
8. Alchemy state backup/bootstrap recovery, access controls, deployment serialization, and independently verified telemetry behavior.
9. Consent/event synchronization deadlines, stale-state thresholds, send expiry, retry/reconciliation horizons, and the policy for missed schedules.
10. Cross-class suppression scope, restriction clearance rules, and retention/deletion policy for originals, event evidence, provider copies, and consent/suppression history.
11. Proven inbound failure/acceptance behavior and each enabled broadcast operation's recovery semantics.
12. **Instance compatibility contract:** approval of `bye.instance/1`, the supported API range and capability names, canonicalization and base-path rules, the private-network/custom-trust policy, request bounds, and any approved distinct API/authentication origins (currently every credential endpoint must be on the issuer's origin).
13. **Native authentication profile:** approval of the browser baseline and the RFC 9207 requirement; final client IDs and callback profiles per platform; passkey recovery; token lifecycle, including audience-limited access tokens; headless CLI sign-in. Arbitrary-domain sign-in must be proven on every supported platform without new entitlements or a hosted relay.
14. **Release matrix:** supported platforms, OS versions and architectures; official identifiers; channel and signing owners; update paths; secure-storage and backup behavior; the shell integrations actually shipped.
15. **Operational ownership:** instance/client support and privacy responsibilities, the deletion protocol and statuses, reviewer demo access, store submission evidence and website-distribution eligibility. Optional channels and features may be deferred explicitly; baseline isolation and authentication requirements may not be waived.
16. **Cloudflare onboarding (§15.11):** the supported Alchemy version, state backend and bootstrap, executor location, and ownership of encryption, retention and recovery, including operator recovery after onboarding-service loss or disconnect. The authoritative operator identity, allowed stages, first-run access to the deployed app, existing-installation collision behavior, and whether guided upgrades are exposed. Bye's OAuth client registration, a verified scope-to-operation matrix for the pinned stack, account prerequisites, and end-to-end authorization, refresh, revocation and unattended-execution tests; documentation alone does not prove compatibility. Required health endpoints, dependency checks, expected results, timeouts and safe test data, with success defined without a mail cutover or reading customer messages.

A capability remains blocked while its required decision or evidence is missing.

Resolve these through the Stage 0 fixture deployment and later acceptance tests, not by assuming that the presence of a Cloudflare binding proves product parity.

## 15. Alchemy beta infrastructure as code

### 15.1 Decision and ownership

**Alchemy v2 beta is the sole desired-state authority for application infrastructure.** Declare Cloudflare resources with the v2 `Alchemy.Stack`, `Cloudflare.providers()`, and resource APIs; do not mix in older v1 Promise-style examples or use a second provisioning tool against the same resources. Wrangler may be used for diagnostics, generated configuration, or an explicitly controlled recovery operation; hand-edited Wrangler deployment files are not a parallel source of truth. [I2][I3]

Separate three lifecycles:

| Lifecycle              | Responsibility                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment evaluation  | Alchemy builds/reconciles the resource graph, provisions bindings, and records infrastructure state. Cloud management credentials exist here only.                                                                        |
| Application invocation | Effect programs handle HTTP, mail, queue, alarms, RPC, and Workflow steps using already-provisioned runtime bindings. No infrastructure provisioning in a user's request.                                                 |
| Customer provisioning  | Versioned application operations allocate mailbox IDs, DO instances, tenant routing, and authorized domain records. Reconcile dynamic resources in an explicit ownership model; never create a new IaC stack per mailbox. |

An Alchemy resource declaration and an Effect application service are not interchangeable dependencies. Use resource outputs to establish a binding, then wrap that binding in the application's `BlobStore`, `Directory`, `JobStore`, or other service layer. A typed binding does not establish tenant authorization; every operation still checks the current principal and resource grants.

### 15.2 Stack boundaries and stable identities

Use an independently administered **foundation stack** for state-backend bootstrap and shared account/zone dependencies, and an **application stack per stage** for the mail platform. Shared resources have one owner; other stacks reference them explicitly. A feature branch must never claim ownership of a production resource.

Maintain `dev-<opaque-id>`, `preview-<number>`, `staging`, and `prod` stage classes with validated names. Prefer separate Cloudflare accounts for production and nonproduction; where an account is shared, stage isolation must cover every resource and secret, not just Worker names. Stack names, resource logical IDs, DO class exports, host Worker names, and persisted namespace mappings are compatibility-sensitive identities.

Create a DO namespace per authority class, not a resource declaration per mailbox. Individual mailbox/calendar/shared/search object instances are selected dynamically by opaque, versioned IDs. When separate Workers bind the same authority, reuse the same namespace and designate one host Worker; do not accidentally create one independent namespace in each consumer. Cross-worker bindings and host transfers must be tested with existing data before use. [I4][C21]

### 15.3 Representative v2 resource graph

This sketch demonstrates one native-boundary mail-core unit: a control-plane database, immutable-content bucket, queue, mailbox namespace, Worker, and queue consumer. The real stack expands it using the inventory in §15.4. The entrypoint and DO class are planned application modules, not supplied implementations; this is not a complete deployable mail host.

```ts
// alchemy.run.ts — deployment code, not a runtime application import.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";
import type { MailboxDO as MailboxClass } from "./workers/core/MailboxDO.ts";

export const Directory = Cloudflare.D1.Database("Directory", {
  migrations: "./infra/migrations/d1",
});

export const Originals = Cloudflare.R2.Bucket("Originals", {
  forceDestroy: false,
});

export const Ingest = Cloudflare.Queues.Queue("Ingest");

export const Mailboxes = Cloudflare.DurableObject<MailboxClass>("Mailboxes", {
  className: "MailboxDO",
});

export const Core = Cloudflare.Worker("MailCore", {
  main: "./workers/core/index.ts",
  compatibility: { date: "2026-09-25" },
  env: {
    APP_ORIGIN: Config.String("APP_ORIGIN"),
    DIRECTORY: Directory,
    ORIGINALS: Originals,
    INGEST: Ingest,
    MAILBOXES: Mailboxes,
  },
});

export type CoreEnv = Cloudflare.InferEnv<typeof Core>;

export default Alchemy.Stack(
  "MailboxPlatform",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const queue = yield* Ingest;
    const core = yield* Core;

    yield* Cloudflare.Queues.Consumer("IngestConsumer", {
      queueId: queue.queueId,
      scriptName: core.workerName,
      settings: {
        batchSize: 10,
        maxRetries: 3,
        maxWaitTimeMs: 5000,
      },
    });

    return { coreUrl: core.url.as<string>() };
  }),
);
```

The native Worker entrypoint exports `MailboxDO` and its `fetch`/`queue` handlers, receives `CoreEnv`, provides adapter layers, and runs application Effects as described in §7. Type-only imports may link the declarations and Worker environment; actual deployment modules must not enter the Worker bundle. The v2 native Worker/DO/queue wiring follows the pinned beta.78 example, with non-destructive bucket intent and application-specific identities. Worker compatibility uses the `compatibility` object, not a copied v1 top-level property. D1's migration-directory integration is documented separately. [I3][I5][I6]

**Conditions before production:** verify SQLite-backed namespace creation in the generated class migration; attach a tested dead-letter queue and retention/replay policy; apply the complete binding inventory; configure routes and prevent unintended public `workers.dev` exposure; validate the chosen compatibility date/flags; supply secrets from protected configuration; and satisfy the version-specific telemetry verification rules in §15.7. The pinned `Cloudflare.state()` API takes no options; disable CLI telemetry separately. [I16][I17][I18] `forceDestroy: false` is not a universal retain/protect policy.

The example uses a single core Worker to make namespace ownership unambiguous. Splitting API, mailbox hosts, and consumers must preserve those physical namespaces. Production consumers follow the partitioning in §3; no change to the mailbox transaction model is implied by this illustrative co-location.

### 15.4 Required infrastructure inventory

Every row must appear in the reviewed graph or have an explicitly recorded external owner. A placeholder binding or a manual dashboard checkbox is not completion.

| Resource group             | Declarations and binding contract                                                                                                          | Lifecycle requirement                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| API and clients            | Worker entrypoints, static assets, service bindings, domains/routes; application Effect layers                                             | Authenticated APIs; release-compatible assets; no secret-bearing frontend environment                 |
| Inbound mail               | Email Routing enablement/rules/catch-all for service-owned zones; inbound Worker; receipt journal, R2, ingestion queue                     | Preserve current MX service until a tested cutover; rollback must not disable another owner's routing |
| Authoritative state        | SQLite-backed namespaces for MailboxDO, CalendarDO, SharedSpaceDO, receipt/job authorities, and SearchShardDO; owning Worker class exports | Stable namespace IDs; reviewed class migrations; preserve object data across code moves               |
| Control plane              | D1 account/domain/address/resource directory and migration history                                                                         | Ordered, backward-compatible SQL migrations; no content-heavy mailbox tables moved into D1            |
| Content storage            | Distinct private originals/parts/exports and published-copy R2 buckets or tightly scoped namespaces; lifecycle/CORS/multipart rules        | No public originals; no force-empty on teardown; GC and retention governed by application ownership   |
| Work delivery              | Ingest, parse/scan, indexing, dispatch, notification, and publishing queues with explicit consumers and DLQs                               | Bounded batches/retries; replay from source journals; no queue considered the permanent record        |
| Long-running orchestration | Cloudflare Workflow resources, entrypoint class exports, and bindings for provision/export/erase/reindex/fanout                            | Versioned parameters and step names; old instances remain executable during rollouts                  |
| Scheduling                 | DO alarms plus independent Cron-triggered reconciliation Workers                                                                           | Alarms are runtime state, not one IaC resource per timer; catalog recovery remains independent        |
| Media and scans            | Media Worker, isolated Container-backed heavy processing where required, image/preview bindings                                            | Resource/memory limits, sandboxing, no customer data retained on local Container disk                 |
| Protection and caching     | WAF/rate-limit/Turnstile declarations, limited KV caches, public-content cache controls                                                    | Fail closed for authorization; caches do not become session or grant authorities                      |
| Transport and integrations | Approved email-sending bindings, transport credentials, signed webhook routes, push/payment keys                                           | No Cloudflare management token in application Workers; traffic-class and domain approvals still apply |
| Observability              | Worker logs/metrics configuration and approved tracing destination                                                                         | Redaction and telemetry egress checks; operational identity separate from customer identity           |

Use the beta provider's documented D1, R2, Worker, Durable Object, Queue, Workflow, and Email resources. Effect-native queue consumption can generate consumer wiring, while native handlers need an explicit consumer resource as above. Choose one mechanism per consumer; do not create both for the same subscription. Mixed-success batches must preserve per-message acknowledgment/retry semantics. [I3][I4][I6][I7][I8][I9]

Verify provider support at the pinned release for every required option, including DLQs, routing rules, custom domains, Cron triggers, Container settings, and security resources. If an option is missing, implement a small, versioned Alchemy provider/resource with schema-checked inputs, stable IDs, read/diff/create/update/delete behavior, idempotency, and lifecycle tests—or record an external owner. Do not hide an untracked mutation in stack evaluation or silently fall back to v1 APIs.

### 15.5 Deploy-time configuration and runtime privileges

Use Alchemy profiles for developer authentication and protected CI credentials for automation. Scope `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to approved accounts/resources. The production deploy identity must not be present in any Worker environment or resource output. State-backend bootstrap privileges are separate from ordinary application deployment privileges. [I10]

Declare required config at stack/Worker construction or in its explicit `env` mapping. For example, `Config.Redacted("PERSONAL_MAIL_API_KEY")` belongs only on the dispatch Worker that needs it. An Effect-native Worker must discover configuration/bindings during construction rather than requesting an undeclared deployment secret for the first time inside `fetch`. Runtime application config is then injected through narrow services. [I11]

`Redacted` helps prevent accidental printing; it does not replace encrypted storage, access control, rotation, or a log-scrubbing policy. Never return a secret to prove a binding works. Validate configuration without exposing its value. Keep secret material out of outputs, artifacts, branch previews, source control, plain environment dumps, and recorded HTTP fixtures.

Public publishing Workers must not receive private mailbox/blob bindings. Indexers need only permitted index inputs and authoritative validation services. Scanners need temporary object references rather than tenant-wide management access. Administrative domain operations run through a separately authorized control plane, not the ordinary API's ambient credential set.

### 15.6 State, recovery, and destructive-change controls

`Cloudflare.state()` uses a Cloudflare-hosted state service. The tutorial documents bootstrap infrastructure and warns that first use can create it, including from an initial plan. Therefore perform bootstrap as an explicit authorized operation; do not promise that a fresh-account `plan` is inherently side-effect-free. Foundation teardown must never be coupled to deleting a preview stage. [I2]

Treat infrastructure state as privileged operational data, separate from application databases and user exports. Record the backend contract/version, account, stack/stage IDs, physical resource mappings, and recovery procedure. Retain encrypted, access-controlled state checkpoints where supported, plus recoverable authentication/encryption material. Test restore/adoption against the pinned backend; do not claim that downloading a manifest alone can restore the encrypted state or recreate lost mailbox data.

Serialize deployments for each stack/stage in CI. Verify backend lock behavior under competing writers; do not rely on undocumented locking. Restrict foundation/state maintenance to a separate operator path. Preserve the reviewed commit, dependency lockfile digest, configuration version, plan, and resource identity manifest for each release.

A production plan **fails policy review** if it unexpectedly deletes/replaces R2 content, D1 databases, DO namespaces/hosts, active Workflow definitions, domain routing, or state-backend infrastructure. Require a separately approved migration/decommission record for such changes. Do not invent a universal Alchemy `retain` or `protect` option: enforce this requirement through tested resource-specific controls, plan checks, restricted credentials, and operator approval.

`forceDestroy: false` avoids the example's explicit destructive bucket behavior but is not blanket protection for all resource types. Never run unconditional production `destroy`; preview cleanup validates account, stage class, resource ownership, and the reviewed deletion set first. Monitor and reconcile emergency console changes so they do not become invisible drift.

### 15.7 Telemetry and the Cloudflare-only profile

**Version-specific finding:** In Alchemy `2.0.0-beta.78`, the state-store Worker's hard-coded OTLP endpoints, exporter layer, and `Effect.provide(TelemetryLive)` are commented out. The claim that this version unavoidably exports state-store telemetry is incorrect. [I15]

The live privacy page still describes that exporter as active and advises a fork/custom backend. It conflicts with the pinned source and must not establish this release's behavior. The relay itself does forward OTLP requests to Axiom; its existence does not demonstrate that this Worker sends requests to it. [I13][I20]

The exported state factory takes no arguments. Use `Cloudflare.state()` as in §15.3, not the older `noTrack` option shown in the privacy page. The internal account-hash annotation helper still checks `NO_TRACK`, but that is separate from exporter configuration. [I16]

**CLI telemetry is separate.** The CLI opt-out check recognizes `ALCHEMY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `NO_TRACK`, and the persisted `~/.alchemy/telemetry-disabled` marker. When disabled, its telemetry layer returns `Layer.empty` rather than constructing exporters. [I17][I18]

Run the pinned local CLI with this environment setting for deployment and bootstrap operations:

```sh
export ALCHEMY_TELEMETRY_DISABLED=1
# Run the project's pinned Alchemy CLI with this environment inherited.
```

This switch controls Alchemy CLI telemetry; it is not a universal network-egress switch for dependency downloads, provider requests, custom application exporters, or other tools. Application telemetry is separately configured through exporter layers/bindings and is not enabled merely by declaring an ordinary Worker. [I19]

**Release requirements:** Preserve the exact package/lockfile and deployed state-Worker artifact identities. Inspect bootstrap and normal operations, including failure paths, for external observability traffic. Inspect application exporter bindings separately. For an existing account, verify the actually deployed state Worker instead of assuming that a local dependency change replaced it. Repeat these checks on upgrades.

**Request-URL logging (implementation finding):** Share-link, feed and render bearer tokens travel in request paths. The Cloudflare API accepts an observability `redactQueryString` flag, but beta.78's script upload metadata does not carry it, so it is silently dropped. Disable automatic invocation logs (`logs.invocationLogs: false`) and emit only structured, opaque-ID application logs. A repository test guards this setting.

**Optional custom backend:** `infra/state` provides a telemetry-free HTTP state backend that is wire-compatible with Alchemy's `HttpStateStore` client, selected with `STATE_BACKEND=http` and deployed by the foundation stack. It is available for strict egress policies. Per the decision below, it is not required.

**Architecture decision:** Do not require a fork/custom backend solely to remove the disabled beta.78 state-store exporter. Treat the alleged unavoidable telemetry blocker as withdrawn, not as proof of complete Cloudflare-only compliance. Keep the other transport/integration gates in §1 and §14. Use opaque resource names, redact sensitive logs, and explicitly approve any external telemetry destinations. Source inspection here does not verify the published package's bytes or live network behavior.

### 15.8 Stages, previews, and domain ownership

Previews receive isolated D1 databases, R2 storage, queues/consumers, DO namespaces, Workflow instances, and secrets. Use synthetic fixtures, sandbox mail delivery, denied arbitrary external recipients, and disposable domains. Never attach production mailbox storage, session keys, payment webhooks, or customer-domain MX routes to a branch preview. A preview URL alone does not establish data isolation.

Alchemy beta.78 supports Worker previews, but the project must verify all attached resources and cross-worker references, not just the preview Worker's own identity. Use full stage resource graphs where that makes isolation clearer. Preview expiration triggers reviewed cleanup; it must not delete a shared foundation resource. [I1]

Separate service-owned DNS/IaC from customer-owned domain onboarding. Dynamic customer routing has an application provisioning record, least-privilege authorization, retry/reconciliation, and a single declared owner. Do not let an Alchemy zone-wide declaration delete runtime-managed rules as undeclared drift. A customer mailbox is not a Cloudflare verified forwarding-destination resource. Email Routing teardown can disable zone routing, so DNS/routing ownership is a specific destructive-change gate. [I9]

### 15.9 Data migrations and release compatibility

D1 migrations live in ordered SQL files and are tracked through the selected Alchemy D1 integration. Review the SQL and migration history independently of a Worker code diff. Where stack deployment can apply migrations before traffic changes, make that ordering explicit and safe. A code rollback does not roll back database contents. [I6]

DO namespace/class migrations and **in-object application SQL migrations are separate concerns**. The former register/transfer class storage; the latter upgrade existing mailbox/calendar schemas under an initialization gate with a local schema version. Use synchronous, bounded schema changes and resumable background backfills rather than one long transaction over every mailbox. Generated namespace migration success is not proof that mailbox data was migrated safely.

Use expand → migrate/backfill → verify → contract. Readers and queue consumers support the prior wire/schema version for the supported rollback interval. Keep event discriminators, send-job generations, permission semantics, and R2 keys stable. Version Workflow entrypoints or preserve old step behavior while old instances finish; redeploying an Effect program does not migrate its persisted checkpoints.

A release canary covers HTTP and asynchronous paths: routing only a fraction of HTTP traffic is not enough when queue consumers, alarms, RPC hosts, and Workflows also changed. Rollback must stop new bad work without blindly replaying already accepted sends or deleting durable state.

### 15.10 Deployment sequence and completion criteria

The project implements the following CI workflow around the pinned Alchemy CLI; it is not a claim that all checks are built into the tool. The CLI exposes planning, deployment, drift, state, development, and destruction operations. [I14]

| Step                  | Required gate                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve and build     | Frozen lockfile; exact version/peer checks; strict type-check; platform import boundaries; no management SDK or secret material in Worker assets                             |
| Test contracts        | Effect unit/property tests; historical schema fixtures; native Workers adapter tests; lint resource identities and stage ownership                                           |
| Prepare state         | Authorized bootstrap already completed; expected backend/account/stage verified; writer serialization acquired; recovery metadata current                                    |
| Review desired state  | Generate a plan from the release commit/config; reject forbidden deletions/replacements, missing bindings, public private-data routes, and production references in previews |
| Deploy isolated stage | Apply graph and migrations; exercise ingress, queue/DLQ, DO SQL, Workflow checkpoint/resume, typed environment, and secret binding behavior                                  |
| Approve production    | Review transport gates, state/data recovery, telemetry, schema compatibility, and the exact release inputs; no unreviewed lock/config change between plan and deployment     |
| Deploy and verify     | Use the pinned CLI from the reviewed commit; reconcile actual resources, run smoke tests and asynchronous probes, monitor data correctness and backlog                       |
| Retain or recover     | Record artifact/plan/state identifiers; rollback only within schema/namespace compatibility rules; investigate drift; destroy approved previews only                         |

Alchemy completion means a clean stage can be provisioned from reviewed code/config, deployed a second time without replacing persistent resources, updated with compatible D1/DO migrations, and recovered after an interrupted deployment or lost operator session. Production completion additionally requires the full §2 acceptance ledger, explicit transport approval, and the §13 durability/privacy tests. Adopting Alchemy or Effect v4 does not weaken any of those requirements.

### 15.11 Cloudflare onboarding

Operators can deploy and run Bye in their own Cloudflare account. They own the resources, the Alchemy state, and the data. Deployment approval is not approval to change domains or mail routing.

**Flow.**

1. **Review prerequisites.** Show the pinned release, the Cloudflare access required, account prerequisites, planned resources, and manual steps.
2. **Authorize Cloudflare.** Connect through Bye's OAuth application. Verify and display the selected account before any deployment write. Authorization alone never starts a deployment.
3. **Review and approve the plan.** Choose a policy-valid stage. Show the account, stage, release, resource changes, migration implications, and blockers. Require explicit approval before applying. Domain configuration is not part of this first-release flow.
4. **Deploy and verify.** Apply through the existing Alchemy stack. Show durable progress, resource links, URLs, health results, and actionable errors. Mark the installation ready only when the required deployment health checks pass.
5. **Connect native apps.** Offer an "Open in Bye" link and QR code containing only the ready instance's HTTPS URL (§10 "Instance selection, self-hosting, and distribution"). The native app validates and displays the instance, then asks the user to confirm before saving it. The handoff never includes Cloudflare credentials, app credentials, or session tokens.
6. **Offer the manual domain/mail guide.** Keep app/public-domain setup separate from the mail cutover (§11 Domains), including cutover checks and deliberate operator action. Skipping the guide does not prevent deployment success. The first release executes no domain or routing changes, even after confirmation.

**Existing stack and installation identity.**

- The existing Alchemy stack, stage policies, migrations, retention, recovery, and decommission procedures (§15.2–15.10) are the source of truth. Onboarding maintains no second resource definition.
- One installation is bound to one operator identity, account, and stage. Its identity and Alchemy state reference persist before any deployment write. Retries and reauthorization return to that installation, never to a new account, stage, or state namespace.
- State, credentials, and execution context are isolated per installation, and collisions with another installation are rejected. Changing the account or stage after deployment requires a separately reviewed workflow, not a retry.

**Plan approval and deployment writes.**

- Pin a published Bye release to an immutable artifact identity. Record approval against the account, stage, release, configuration, resource actions, and migration implications shown to the operator.
- Before applying, revalidate prerequisites and current state. Changed inputs or unapproved actions require a fresh review. Retries may continue approved remaining actions, but never silently deploy a newer release.
- Serialize deployment writes per installation across the initial deployment, retries, and upgrades. A duplicate submission reuses the active operation or is rejected without starting another writer.
- Resume durable Alchemy state with stable resource identities. Preserve persistent resources after a failure and report completed, failed, or uncertain work. If state is untrustworthy, stop for the existing recovery procedure; never substitute fresh state, replay mutations blindly, or tear down automatically.

**OAuth, credentials, and disconnect.**

- Request only the verified scopes the first-release stack needs, excluding customer-zone DNS-write and Email Routing permissions. Unsupported separation or missing API coverage blocks release; access is never silently broadened.
- Exchange the authorization code server-side and validate callbacks against the initiating operator session. Prevent callback replay. Document and test the supported redirect, PKCE, token-refresh, and revocation behavior before release.
- Encrypt stored OAuth credentials. Management tokens never appear in Worker bindings, browser-visible responses, plans, logs, or error messages (§15.5). Credential access is limited to the installation's management operations.
- On disconnect, block new and queued deployment operations, retries, and credential refresh. Stop active work before any further deployment API call; requests already submitted may still complete. Delete stored and cached credentials, attempt provider revocation where supported, and report revocation failures or uncertain in-flight work without restoring access.
- Disconnect deletes no resources or Alchemy state. A running Bye instance never depends on onboarding's management credentials. After expiry or revocation, require valid authorization before any further management write; reconnection targets the existing installation and reviews any newly discovered changes.
- The native-app handoff carries only the public instance URL. Cloudflare OAuth authorizes deployment management; the native app signs in to Bye separately, directly with the selected instance (§10).

**Safety and operational visibility.**

- No first-release onboarding path, including retry, recovery, and upgrades, may change customer DNS, MX, Email Routing, or catch-all routing. Confirmation cannot enable an out-of-scope operation.
- Previews stay isolated from production secrets, data, and mail routing (§15.8). Destructive changes are shown and require explicit review; approval does not override retention or decommission policy (§15.6).
- Persist status and recovery metadata: installation, account, stage, release, approval reference, operation, timestamps, and resource outcomes. Events never contain tokens, secrets, message content, or customer payloads.
- Progress, deployment health, and authorization status are distinct. Failures and timeouts never appear as success. Show the failed step and the safe next action; reopening onboarding recovers the recorded status. Deployment health does not establish inbound-mail readiness.

**Hosting and execution.** The onboarding page and its records run on a Cloudflare Worker (`onboarding.<DOMAIN>`, one Durable Object with SQLite storage). Deployment writes never run there: after authorization, onboarding provisions a deployer Worker + Container in the operator's account, copies the pinned release images into that account's container registry, and runs the existing Alchemy stack inside it with the access token passed per request. Compute, images, state, and the deployer all belong to the operator's account (infra/onboarding/spec.md Part J).

**First release.** Supports one self-hosted installation per operator, workers.dev URLs, OAuth connection and reauthorization, reviewed deployment, safe resume, health checks, disconnect, and a manual domain/mail guide. Automated domain/DNS changes, MX cutover, billing, hosted multi-tenant runtime operations, and teardown are deferred. Any exposed upgrade uses the same approval, serialization, migration, and recovery safeguards; there are no automatic upgrades.

Release requires resolving §14 item 16, a successful nonproduction deployment, and recovery from partial provisioning and from process loss. Record the tested Bye release, Alchemy version, scope set, and results.

**Acceptance (OB01–OB10).**

| ID   | Scenario                                                                                | Required outcome                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| OB01 | A new operator authorizes and approves.                                                 | No manually created API token is needed. The approved release is identifiable, expected URLs work, and required checks pass.                       |
| OB02 | Consent or approval is withheld, or a known blocking prerequisite is missing.           | No deployment writes begin; a clear next action is shown.                                                                                          |
| OB03 | The account, stage, release, configuration, or effects change after approval.           | The old approval cannot authorize new effects; review is required again.                                                                           |
| OB04 | A submission repeats or deployments overlap.                                            | Only one writer operates per installation; repeat requests do not duplicate or replace persistent resources.                                       |
| OB05 | The process stops after a resource write, before its outcome is recorded.               | Recovery reconciles existing resources and state or stops for documented intervention; resources are not blindly recreated.                        |
| OB06 | A required health check fails or times out.                                             | The installation is not marked ready; the failed check and safe recovery action are shown.                                                         |
| OB07 | The operator disconnects during queued or active work, then reconnects.                 | New writes are blocked, uncertainty is disclosed, credentials are removed, resources are retained, and reconnection targets the same installation. |
| OB08 | Installation, retry, recovery, or an available upgrade runs with existing mail routing. | Customer DNS and routing remain unchanged. Skipping the manual guide does not block deployment success.                                            |
| OB09 | Preview, destructive-plan, and error paths are exercised.                               | Production isolation holds, unapproved or prohibited destruction is blocked, and outputs contain no management credentials or customer payloads.   |
| OB10 | A ready installation is opened or scanned in a native app.                              | The handoff contains only the HTTPS instance URL; the app validates and displays the server before saving it and signing in directly with it.      |

## Sources

The HEY/Cloudflare product and transport baseline is retained from revision 0.1. Revision 0.2 checks Effect v4 and Alchemy v2 beta against the primary release notes, documentation, and selected source below. Revision 0.2.1 corrects only the Alchemy telemetry/state-factory claims using additional pinned sources. Live documentation can advance beyond, or lag behind, the pinned packages; the installed declarations, versioned source, and acceptance tests control implementation. Recheck limits and product availability before launch.

### HEY product baseline

[H0]: https://www.hey.com/ "HEY product overview"
[H1]: https://www.hey.com/features/ "HEY feature index"
[H2]: https://www.hey.com/calendar/ "HEY Calendar"
[H3]: https://www.hey.com/domains/ "HEY for Domains"
[H4]: https://www.hey.com/new/ "HEY product updates"
[H5]: https://www.hey.com/agents/ "HEY CLI, TUI, and agent access"
[H6]: https://www.hey.com/features/email-the-web/ "Email the web / HEY World"
[H7]: https://www.hey.com/features/big-files/ "Large-file links"
[H8]: https://www.hey.com/features/workflows/ "Product workflows"
[H9]: https://www.hey.com/features/collections/ "Collections"
[H10]: https://www.hey.com/features/speakeasy/ "Speakeasy"
[H11]: https://www.hey.com/features/bubble-up/ "Bubble Up"
[H12]: https://www.hey.com/security/ "HEY security"
[H13]: https://www.hey.com/image-proxy/ "HEY image proxy"
[H15]: https://www.hey.com/pricing/ "Account plans and commercial lifecycle"
[H16]: https://www.hey.com/faqs/ "HEY compatibility, exports, and address retention"
[H17]: https://www.hey.com/features/reply-later/ "Reply Later"
[H18]: https://www.hey.com/features/reply-mode/ "Focus and Reply"
[H19]: https://www.hey.com/features/send-as/ "External send-as"
[H20]: https://www.hey.com/features/clips-highlights/ "Clips"
[H21]: https://www.hey.com/features/sharable-links/ "Public thread links"

### Cloudflare

[C1]: https://developers.cloudflare.com/email-service/ "Email Service overview and beta status"
[C2]: https://developers.cloudflare.com/email-service/platform/limits/ "Sending, receiving, recipient, and routing limits"
[C3]: https://developers.cloudflare.com/email-service/reference/faq/ "Transactional-only intended use"
[C4]: https://developers.cloudflare.com/email-service/reference/headers/ "Controlled and permitted headers"
[C5]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ "SQLite APIs, FTS5, and cursor behavior"
[C6]: https://developers.cloudflare.com/durable-objects/platform/limits/ "Durable Object limits"
[C7]: https://developers.cloudflare.com/d1/platform/limits/ "D1 limits"
[C8]: https://developers.cloudflare.com/kv/concepts/how-kv-works/ "KV consistency model"
[C9]: https://developers.cloudflare.com/email-service/api/route-emails/email-handler/ "Inbound email handler API"
[C10]: https://developers.cloudflare.com/email-service/concepts/email-lifecycle/ "Email delivery lifecycle"
[C11]: https://developers.cloudflare.com/email-service/platform/event-subscriptions/ "Outbound email lifecycle events"
[C12]: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ "Email sending binding and raw-message support"
[C13]: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ "Workers TCP restrictions"
[C14]: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ "Queue delivery guarantees"
[C15]: https://developers.cloudflare.com/queues/platform/limits/ "Queue payload, retention, and delay limits"
[C16]: https://developers.cloudflare.com/workflows/build/rules-of-workflows/ "Durable step and idempotency rules"
[C17]: https://developers.cloudflare.com/durable-objects/api/alarms/ "Durable Object alarms"
[C18]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ "WebSocket hibernation"
[C19]: https://developers.cloudflare.com/email-service/configuration/domains/ "Domain onboarding, forwarding DNS, and email previews"
[C20]: https://developers.cloudflare.com/containers/ "Cloudflare Containers"
[C21]: https://developers.cloudflare.com/durable-objects/api/namespace/ "Namespace and dynamic object instances"

### Effect v4

[F1]: https://effect.website/ "Effect documentation and release channel"
[F2]: https://raw.githubusercontent.com/Effect-TS/effect/effect@4.0.0-rc.115/packages/effect/src/Context.ts "Pinned v4 Context.Service source"
[F3]: https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/runtime.md "Runtime migration guide; validate against selected release"
[F4]: https://raw.githubusercontent.com/Effect-TS/effect/effect@4.0.0-rc.115/packages/effect/src/Schema.ts "Pinned v4 schema constructors and codec APIs"
[F5]: https://raw.githubusercontent.com/Effect-TS/effect/effect@4.0.0-rc.115/packages/effect/src/Effect.ts "Pinned v4 Effect result and execution APIs"
[F6]: https://raw.githubusercontent.com/Effect-TS/effect-smol/main/MIGRATION.md "v4 package consolidation and migration index"
[F7]: https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/services.md "Service and explicit Layer migration guide"
[F8]: https://raw.githubusercontent.com/Effect-TS/effect-smol/main/migration/error-handling.md "v4 error-handling migration guide"

### Alchemy v2 beta

[I1]: https://alchemy.run/blog/2026-09-17-beta-78/ "Alchemy beta.78: Effect rc.115 peer, Config changes, Worker previews"
[I2]: https://alchemy.run/cloudflare/tutorial/part-1/ "Stack, Cloudflare provider/state configuration, and bootstrap"
[I3]: https://alchemy.run/cloudflare/compute/workers/ "Worker entrypoints, native environments, and compatibility configuration"
[I4]: https://alchemy.run/cloudflare/compute/durable-objects/ "Durable Object resources and runtime integration"
[I5]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/examples/cloudflare-worker-async/alchemy.run.ts "Pinned beta.78 native Worker, DO, Queue, and Consumer example"
[I6]: https://alchemy.run/cloudflare/data/d1/ "D1 resources, bindings, and migrations"
[I7]: https://alchemy.run/cloudflare/messaging/queues/ "Queue bindings and consumer provisioning"
[I8]: https://alchemy.run/cloudflare/compute/workflows/ "Cloudflare Workflow bindings and execution"
[I9]: https://alchemy.run/cloudflare/email/send-and-receive/ "Email Routing resource lifecycle and bindings"
[I10]: https://alchemy.run/cloudflare/setup/ "Profiles and Cloudflare authentication"
[I11]: https://alchemy.run/cloudflare/security/secrets-env/ "Deployment/runtime config and secret binding behavior"
[I12]: https://alchemy.run/blog/2026-08-12-beta-71/ "Prerelease schema rename back to TaggedError"
[I13]: https://alchemy.run/privacy/ "Privacy page: state-store telemetry and noTrack guidance conflict with the beta.78 source; see I15-I18"
[I14]: https://alchemy.run/cli/ "Alchemy CLI operations"
[I15]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/packages/alchemy/src/Cloudflare/StateStore/Api.ts "Pinned state-store Worker: OTLP configuration and provider commented out"
[I16]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/packages/alchemy/src/Cloudflare/StateStore/State.ts "Pinned zero-argument state factory, bootstrap version checks, and NO_TRACK account-hash handling"
[I17]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/packages/alchemy/src/Telemetry/Attributes.ts "Pinned CLI telemetry environment/file opt-out checks"
[I18]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/packages/alchemy/src/Telemetry/Layer.ts "Pinned CLI exporter returns Layer.empty when telemetry is disabled"
[I19]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/packages/alchemy/src/Telemetry.ts "Application telemetry is explicitly configured through exporter layers and bindings"
[I20]: https://raw.githubusercontent.com/alchemy-run/alchemy/v2.0.0-beta.78/stacks/otel/Ingester.ts "Pinned relay implementation forwards OTLP signals to Axiom"

### Desktop authentication and secure storage

[N1]: https://www.rfc-editor.org/rfc/rfc8252 "RFC 8252 OAuth 2.0 for Native Apps (external user agent, redirects, loopback)"
[N2]: https://www.rfc-editor.org/rfc/rfc7636.html "RFC 7636 Proof Key for Code Exchange"
[N3]: https://www.rfc-editor.org/rfc/rfc9700.html "RFC 9700 OAuth 2.0 Security BCP (refresh rotation/sender-constraining, §2.2.2, §4.14)"
[N4]: https://www.rfc-editor.org/rfc/rfc8628.html "RFC 8628 Device Authorization Grant"
[N5]: https://www.w3.org/TR/webauthn-2/ "W3C Web Authentication Level 2 (relying-party verification)"
[N6]: https://developer.apple.com/documentation/authenticationservices/supporting-passkeys "Apple: Supporting passkeys (macOS native/web; webcredentials association)"
[N7]: https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession "Apple: ASWebAuthenticationSession"
[N8]: https://support.apple.com/guide/keychain-access/what-is-keychain-access-kyca1083/mac "Apple: Keychain on Mac"
[N9]: https://github.com/openid/AppAuth-iOS "OpenID AppAuth native SDK (macOS redirects)"
[N10]: https://github.com/f-23/react-native-passkey "react-native-passkey (iOS/Android only; no desktop implementation)"
[N11]: https://github.com/oblador/react-native-keychain "react-native-keychain (declares an osx target; cloudSync defaults false)"
[N12]: https://reactnative.dev/docs/native-platform "React Native: Native Platform integration"
[N13]: https://reactnative.dev/docs/out-of-tree-platforms "React Native: Out-of-tree platforms (Windows, macOS)"
[N14]: https://reactnative.dev/docs/security "React Native: Security (no bundled secure storage; AsyncStorage unsuitable for tokens)"
[N15]: https://learn.microsoft.com/en-us/windows/win32/webauthn/-webauthn-portal "Microsoft: WebAuthn API for Win32 apps (Windows 10 1903+)"
[N16]: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew "Microsoft: CredWriteW"
[N17]: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw "Microsoft: CredReadW (distinguishes missing credential vs unavailable logon session)"
[N18]: https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw "Microsoft: CREDENTIALW (generic credentials, persistence modes)"
[N19]: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata "Microsoft: CryptProtectData (CRYPTPROTECT_LOCAL_MACHINE caveat)"
[N20]: https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker "Microsoft: Credential Locker / PasswordVault (roaming)"
[N21]: https://github.com/microsoft/react-native-macos "Microsoft: React Native for macOS"
[N22]: https://www.rfc-editor.org/rfc/rfc8414.html "RFC 8414 OAuth 2.0 Authorization Server Metadata (issuer-derived discovery, §3.1–3.3, §6.2)"
[N23]: https://www.rfc-editor.org/rfc/rfc9207.html "RFC 9207 OAuth 2.0 Authorization Server Issuer Identification (mix-up defense)"
[N24]: https://developer.android.com/identity/credential-manager/prerequisites?hl=en "Android: Credential Manager prerequisites (Digital Asset Links for passkeys)"
[N25]: https://developer.apple.com/videos/play/wwdc2022/10092/ "Apple: Meet passkeys, WWDC22 (associated domains)"
[N26]: https://developer.android.com/studio/publish/app-signing "Android: Sign your app (Play App Signing, upload vs app-signing keys)"
[N27]: https://developer.android.com/developer-verification "Android: developer verification requirements"
[N28]: https://developer.apple.com/support/web-distribution-eu/ "Apple: Web Distribution in the EU (authorization, registered domains, notarization)"
[N29]: https://developer.apple.com/support/offering-account-deletion-in-your-app/ "Apple: Offering account deletion in your app"
[N30]: https://support.google.com/googleplay/android-developer/answer/13327111?hl=en "Google Play: app account deletion requirements (in-app and web paths)"

### Protocols

[R1]: https://www.rfc-editor.org/info/rfc5545/ "iCalendar data format"
[R2]: https://www.rfc-editor.org/info/rfc5546/ "iTIP scheduling interoperability"
[C22]: https://github.com/cloudflare/agentic-inbox "Cloudflare Agentic Inbox: Email Routing inbound, Email Service send_email outbound for a self-hosted mailbox"
