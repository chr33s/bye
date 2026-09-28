# Pre-production TODO

Last updated 2026-09-28 on `main`. `pnpm verify` passes: 134 test files, 1,677 tests (1 skipped). **The stack has never been deployed to Cloudflare.**

Everything that could be fixed in code has been removed from this list. What remains needs accounts, credentials, artwork, real devices or a real deployment, or it is a design decision or a known limitation of a fix. Paths are relative to the repository root.

**Priority:**

- **P0:** blocks the first prod deploy or store submission.
- **P1:** fix before real users.
- **P2:** fix soon after launch.

---

## P0: Blockers

### GitHub and Cloudflare setup (manual)

- [ ] **Create the GitHub environments:** `preview`, `staging-plan`, `staging`, `prod-plan`, `prod`.
  - Require reviewers on `staging` and `prod`.
  - Restrict deployment branches to `main`.
  - Enable Dependabot in the repo settings (`.github/dependabot.yml` exists).
- [ ] **Create the secrets.**
  - Deploy and state credentials:
    - `BYE_STATE_TOKEN`, in the nonprod-scoped grant form (for example `staging|preview-*|dev-*=<token>`).
    - `PROD_BYE_STATE_TOKEN`, in the prod environments only.
    - `NONPROD_`/`PROD_CLOUDFLARE_ACCOUNT_ID` and `NONPROD_`/`PROD_CLOUDFLARE_API_TOKEN`, with scopes per `infra/RUNBOOK.md`.
  - Runtime secrets: `SESSION_KEY`, `PROXY_SIGNING_KEY`, `BILLING_WEBHOOK_SECRET` (at least 32 characters), `SEND_EVENTS_WEBHOOK_SECRET` (at least 32 characters), `TURNSTILE_SECRET`, `MAIL_DKIM_PRIVATE_KEY`, `SIGMIRROR_WRITE_TOKEN`, `PROBE_TOKEN`, `OPS_TOKEN`.
- [ ] **Create the vars:** `BYE_STATE_URL`, `PROD_BYE_STATE_URL`, `PREVIEW_DOMAIN`, `APP_ORIGIN`, `MAIL_RENDER_ORIGIN`, `APP_DOMAIN`, `PUBLIC_DOMAIN`, `MAIL_ZONE`, `MAIL_TRAFFIC_CLASSES`, `PROVIDER_SENT_PREVIEWS=disabled`, `SCANNER_SIGNATURES`/`SCANNER_IMAGE`, `MAIL_SANDBOX_DOMAINS`, `TURNSTILE_SITEKEY`.
- [ ] **Run the account pre-flight** (RUNBOOK "Account prerequisites"): Workers Paid, Containers, `send_email` sender domain, Turnstile, Email Routing permissions, and Workers Routes Write on `PREVIEW_DOMAIN`.
- [ ] **Bootstrap the foundation and state backend** (RUNBOOK "Self-hosted state backend").
  - Generate and escrow `BYE_STATE_TOKEN`, `BYE_STATE_ENCRYPTION_KEY` and `BYE_STATE_ADMIN_TOKEN`.
  - Deploy with `BYE_STATE_DOMAIN` and `BYE_SERVICE_ZONE`, then escrow `.alchemy/`.
  - Decide between per-stage grants on one backend and a separate prod backend.
- [ ] **Do the two-phase first deploy for Turnstile** (RUNBOOK "First deploy: Turnstile"). Afterwards, set `TURNSTILE_SECRET` and `TURNSTILE_SITEKEY`.
- [ ] **MX cutover:** follow RUNBOOK "MX cutover" after the first prod deploy has stabilized. Keep `BYE_MX_CUTOVER` unset until then.
- [ ] **Onboarding host:** create a Cloudflare Access application (set `BYE_ONBOARDING_ACCESS_TEAM_DOMAIN` and `BYE_ONBOARDING_ACCESS_AUD`) and a tunnel. The server binds to `127.0.0.1` by default. Escrow `BYE_ONBOARDING_KEYS`, and register and verify the OAuth client (see `infra/onboarding/README.md`; the readme's "Open before release" section no longer exists).

### Mail providers

- [ ] **Get written provider approval** for each traffic class: personal, subscription, forwarding and newsletter (EVIDENCE #1). Personal mail then only needs `personal` in `MAIL_TRAFFIC_CLASSES` (Cloudflare Email Sending) and a DKIM key pair.
- [ ] **Turn off sent-email previews** in each provider console, then attest with `PROVIDER_SENT_PREVIEWS=disabled`.
- [ ] **Switch the send-events provider webhook** to the new scheme: `x-bye-signature: t=<unix>,v1=<hex HMAC of "t.body">`, signed with `SEND_EVENTS_WEBHOOK_SECRET`.

### Evidence on a real account (`infra/EVIDENCE.md`)

- [ ] **#6:** deploy a fresh `dev-<id>` stage twice; the second plan must be no-op or update only (the first real run of the CI `steady` job).
- [ ] **#7:** on staging, run migrations and roll back with queued work and in-flight Workflows.
- [ ] **#8:** state restore (real-backend run per `infra/drills/state-drill-remote.md`), lease serialization under concurrent deploys, `verify-worker`, and `alchemy deploy` behind the egress proxy.
- [ ] **#2, #3, #4:** SMTP retry and fault behaviour (set `BYE_FAULT_INGRESS` by hand on a dedicated `dev-evidence<n>` stage only; there is no gated live suite, gap-analysis §5.4), wire Message-ID and threading in Gmail, Outlook and Apple Mail, and end-to-end customer-zone onboarding.
- [ ] **#5:** deployed load test against the spec §12 targets, and restore drills on staging. No load-test script exists yet (only local benchmarks in `pnpm test`); write the k6 (or equivalent) profile first (gap-analysis §14.5).
- [ ] **Verify these on the first real deploy:**
  - the `Cloudflare-Workers-Version-Overrides` header format, and that `coreVersionId` appears in the stage outputs;
  - that the foundation `http_ratelimit` rule values are accepted on the zone's plan;
  - that the egress proxy allows container image pull and push;
  - retention, via a staging destroy-plan dry run;
  - that the D1 migrations apply, including the newer ones (`0033_auth_hardening.sql`, `0036`, `0037`, `0039_domain_installation_link.sql`, `0040_installation_zone_token.sql`) and the DO kernel migrations in `infra/migrations/durable`.

### Native apps and store submission

- [ ] **Android:** create the upload keystore, set `BYE_UPLOAD_STORE_FILE`, `BYE_UPLOAD_STORE_PASSWORD`, `BYE_UPLOAD_KEY_ALIAS`, `BYE_UPLOAD_KEY_PASSWORD` and `BYE_BUILD_NUMBER`, and enroll in Play App Signing. Run `pnpm --filter <mobile> android:release` once to confirm R8 passes with the new keep rules.
- [ ] **Apple:**
  - Set `DEVELOPMENT_TEAM` and Distribution signing on the app, the widget, the share extension and the macOS target.
  - Register the App IDs `email.bye.app(.widget|.share)` and `email.bye.desktop`, the app group `group.email.bye`, and the associated domain (serve an AASA file on `app.bye.software`).
  - Replace `REPLACE_WITH_TEAM_ID` in `apps/mobile/ios/ExportOptions.plist`.
  - Set up macOS notarization. There is no macOS archive script yet.
  - Check that Debug builds still attach now that the hardened runtime is on.
- [ ] **Windows:** set the `Package.appxmanifest` Identity Name and Publisher from Partner Center, and set up a signing certificate.
- [ ] **App icons:** design icons for iOS, macOS, Android (including an adaptive icon) and Windows. The `AppIcon.appiconset` files are empty and the Android and Windows icons are the templates. The web PNGs were generated from `icon.svg`.
- [ ] **Compile and test the native code on real devices.** CI builds unsigned only, and the JS relaunch/storage mocks are all that exist for DS02/05/12. No gradle or xcode build was run for the new signing, R8 or privacy-manifest changes, and the Swift and Kotlin code for Keychain, Keystore and the widget has never been compiled. Run the signed DS02/05/12 tests: relaunch, reboot, upgrade.
- [ ] **Store metadata:** privacy policy URL, App Privacy and Data Safety answers (email content and account data are collected), screenshots and descriptions.
- [ ] **Choose a license.** There is no LICENSE file, and `apps/cli/package.json` says `UNLICENSED`. Pick one before publishing the CLI or the apps.

---

## P1: Before real users

### Needs a design decision or more work

- [ ] **Native OAuth redirect.** Mobile and macOS still use the custom-scheme redirect `bye://oauth/callback`. Move to Universal Links or App Links on mobile (`ASWebAuthenticationSession` on iOS) and a loopback redirect on desktop; the sandboxed Mac app needs `com.apple.security.network.server`. This needs AASA and `assetlinks.json` hosting and a server redirect allowlist.
- [ ] **Choose a crash reporter.** Web and native have a pluggable reporter (`setErrorReporter`), but it is a no-op by default. Install one, and upload `apps/web/sourcemaps/` and the dSYMs.
- [ ] **Set up alerting.**
  - Add Cloudflare Notifications for Worker errors, queue backlog, DLQ depth and container failures.
  - Set up on-call routing.
  - Build a dashboard for the `COST_MODEL.md` counters.
  - Decide whether to enable Logpush to a retained sink. Invocation logs are deliberately off, and prod log sampling is now 1.
- [ ] **Day-photo scan fallback and metadata sharding are documented limits.** Photos with no scan verdict are re-queued on read, and mailbox metadata sharding is a probe plus a plan (see P2); confirm both are acceptable at launch.
- [ ] **Off-account backups:** create the bucket and token (RUNBOOK "Backups"), turn on R2 lock or replication for Originals and the `_erasure/` ledger, and run a staging restore drill.
- [ ] **Scale the cron catalog sweep.** It is now sharded (`shardsForRun`) and paged, but each run still reconciles serially in one invocation (`workers/core/src/scheduled.ts:130-146`). Load-test it (evidence #5) and fan out through queue messages or Workflows if it doesn't fit.
- [ ] **Choose the scanner signature path for prod** (mirror or baked), and document the accepted risk of the SigMirror job container's general internet egress.
- [ ] **Pin apt package versions** in the three Dockerfiles (`containers/{mime,scanner,sigmirror}`; `apt-get install` is unpinned in scanner and sigmirror). The base images and pip packages are already pinned. Add image scanning and signing.
- [ ] **Accept or reduce the prerelease dependency risk.** `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117` are in the prod path. Name an owner, and re-run evidence #6 and #8 on every bump.

### Known limitations of the fixes

- [ ] **Calendar contract validation.** Time zone and date bounds are checked in the store and dispatcher, not in `contracts/src/calendar.ts`, because the v1 golden fixtures contain invalid values. Tighten the schema when v2 contracts are introduced.

---

## P2: Soon after launch

- [ ] **Decide the retention period for unmapped newsletter events** (RUNBOOK: "pending the retention decision"). Audit log retention is set to 400 days by assumption; confirm it meets any compliance requirement.
- [ ] **Add tests for the 7 remaining "Resolved, untested" rows** in `gap-analysis.md`, then mark them Resolved and update its counts:
  - DS01: Devices screen labelled CLI/agent only (`apps/web/src/main.ts`).
  - E01: Screener bulk bar (store behavior is tested, the UI is not).
  - E24/E08/E09: Spam and Screened Out views, Restore/Empty, Set Aside, Bubble controls in the web UI.
  - C09: RSVP and create-event actions in the web thread view.
  - DS: Devices page list and revoke (routes are tested, the UI is not).
  - §12: `infra/COST_MODEL.md` counters (add a check that each named counter is emitted).
  - §8 snapshot boundary: no client reads `changedSinceBoundary` on continuation pages, so it has no effect yet. Wire a client, then test it.
- [ ] **Confirm D1 migration numbering gaps (0015–0019, 0027–0029, 0034–0035, 0038) are intentional,** and that no environment applied the removed files.
- [ ] **Decide on metadata sharding.** Mailbox metadata sharding is a probe plus a plan; decide whether to automate it before the largest mailboxes reach 50% of the budget.
- [ ] **Finish the calendar thread UI.** C09 has no cover panel, and the native thread view lacks the RSVP and create-event actions the web has.
- [ ] **Wire the remaining mail adapters.** Forwarding, Subscription and External-identity are added only when their own secret or key is set; nothing deploys them by default, so confirm each is configured for the traffic classes you approve (gap-analysis §5.3).
- [ ] **Run a full native accessibility audit** (Dynamic Type, contrast, screen-reader order).
