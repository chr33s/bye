# Pre-production TODO

Last updated 2026-09-26 on branch `prod-readiness-fixes`. `pnpm verify` passes: 122 test files, 1,524 tests (1 skipped). **The stack has never been deployed to Cloudflare.**

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
  - Runtime secrets: `SESSION_KEY`, `PROXY_SIGNING_KEY`, `BILLING_WEBHOOK_SECRET` (at least 32 characters), `SEND_EVENTS_WEBHOOK_SECRET` (at least 32 characters), `TURNSTILE_SECRET`, `PERSONAL_MAIL_API_KEY`, `SIGMIRROR_WRITE_TOKEN`, `PROBE_TOKEN`, `OPS_TOKEN`.
- [ ] **Create the vars:** `BYE_STATE_URL`, `PROD_BYE_STATE_URL`, `PREVIEW_DOMAIN`, `APP_ORIGIN`, `MAIL_RENDER_ORIGIN`, `APP_DOMAIN`, `PUBLIC_DOMAIN`, `MAIL_ZONE`, `PERSONAL_MAIL_ENDPOINT`, `PROVIDER_SENT_PREVIEWS=disabled`, `SCANNER_SIGNATURES`/`SCANNER_IMAGE`, `MAIL_SANDBOX_DOMAINS`, `TURNSTILE_SITEKEY`.
- [ ] **Run the account pre-flight** (RUNBOOK "Account prerequisites"): Workers Paid, Containers, `send_email` sender domain, Turnstile, Email Routing permissions, and Workers Routes Write on `PREVIEW_DOMAIN`.
- [ ] **Bootstrap the foundation and state backend** (RUNBOOK "Self-hosted state backend").
  - Generate and escrow `BYE_STATE_TOKEN`, `BYE_STATE_ENCRYPTION_KEY` and `BYE_STATE_ADMIN_TOKEN`.
  - Deploy with `BYE_STATE_DOMAIN` and `BYE_SERVICE_ZONE`, then escrow `.alchemy/`.
  - Decide between per-stage grants on one backend and a separate prod backend.
- [ ] **Do the two-phase first deploy for Turnstile** (RUNBOOK "First deploy: Turnstile"). Afterwards, set `TURNSTILE_SECRET` and `TURNSTILE_SITEKEY`.
- [ ] **MX cutover:** follow RUNBOOK "MX cutover" after the first prod deploy has stabilized. Keep `BYE_MX_CUTOVER` unset until then.
- [ ] **Onboarding host:** create a Cloudflare Access application (set `BYE_ONBOARDING_ACCESS_TEAM_DOMAIN` and `BYE_ONBOARDING_ACCESS_AUD`) and a tunnel. The server binds to `127.0.0.1` by default. Escrow `BYE_ONBOARDING_KEYS`, and register and verify the OAuth client (README "Open before release").

### Mail providers

- [ ] **Get written provider approval** for each traffic class: personal, subscription, forwarding and newsletter (EVIDENCE #1). Set `PERSONAL_MAIL_ENDPOINT` and the key together; `check-config` refuses one without the other.
- [ ] **Turn off sent-email previews** in each provider console, then attest with `PROVIDER_SENT_PREVIEWS=disabled`.
- [ ] **Switch the send-events provider webhook** to the new scheme: `x-bye-signature: t=<unix>,v1=<hex HMAC of "t.body">`, signed with `SEND_EVENTS_WEBHOOK_SECRET`.

### Evidence on a real account (`infra/EVIDENCE.md`)

- [ ] **#6:** deploy a fresh `dev-<id>` stage twice; the second plan must be no-op or update only (the first real run of the CI `steady` job).
- [ ] **#7:** on staging, run migrations and roll back with queued work and in-flight Workflows.
- [ ] **#8:** state restore, lease serialization under concurrent deploys, `verify-worker`, and `alchemy deploy` behind the egress proxy.
- [ ] **#2, #3, #4:** SMTP retry and fault behaviour, wire Message-ID and threading in Gmail, Outlook and Apple Mail, and end-to-end customer-zone onboarding.
- [ ] **#5:** deployed load test against the spec §12 targets, and restore drills on staging.
- [ ] **Verify these on the first real deploy:**
  - the `Cloudflare-Workers-Version-Overrides` header format, and that `coreVersionId` appears in the stage outputs;
  - that the foundation `http_ratelimit` rule values are accepted on the zone's plan;
  - that the egress proxy allows container image pull and push;
  - retention, via a staging destroy-plan dry run;
  - that the D1 migrations apply, including the new `0033_auth_hardening.sql` and the DO kernel migration v3.

### Native apps and store submission

- [ ] **Android:** create the upload keystore, set `BYE_UPLOAD_STORE_FILE`, `BYE_UPLOAD_STORE_PASSWORD`, `BYE_UPLOAD_KEY_ALIAS`, `BYE_UPLOAD_KEY_PASSWORD` and `BYE_BUILD_NUMBER`, and enroll in Play App Signing. Run `pnpm --filter <mobile> android:release` once to confirm R8 passes with the new keep rules.
- [ ] **Apple:**
  - Set `DEVELOPMENT_TEAM` and Distribution signing on the app, the widget, the share extension and the macOS target.
  - Register the App IDs `email.bye.app(.widget|.share)` and `email.bye.desktop`, the app group `group.email.bye`, and the associated domain (serve an AASA file on `app.bye.email`).
  - Replace `REPLACE_WITH_TEAM_ID` in `apps/mobile/ios/ExportOptions.plist`.
  - Set up macOS notarization. There is no macOS archive script yet.
  - Check that Debug builds still attach now that the hardened runtime is on.
- [ ] **Windows:** set the `Package.appxmanifest` Identity Name and Publisher from Partner Center, and set up a signing certificate.
- [ ] **App icons:** design icons for iOS, macOS, Android (including an adaptive icon) and Windows. The `AppIcon.appiconset` files are empty and the Android and Windows icons are the templates. The web PNGs were generated from `icon.svg`.
- [ ] **Compile and test the native code on real devices.** No gradle or xcode build was run for the new signing, R8 or privacy-manifest changes, and the Swift and Kotlin code for Keychain, Keystore and the widget has never been compiled. Run the signed DS02/05/12 tests: relaunch, reboot, upgrade.
- [ ] **Store metadata:** privacy policy URL, App Privacy and Data Safety answers (email content and account data are collected), screenshots and descriptions.
- [ ] **Choose a license.** There is no LICENSE file, and `apps/cli/package.json` says `UNLICENSED`. Pick one before publishing the CLI or the apps.

---

## P1: Before real users

### Needs a design decision or more work

- [ ] **Native OAuth redirect.** Mobile and macOS still use the custom-scheme redirect `bye://oauth/callback`. Move to Universal Links or App Links on mobile (`ASWebAuthenticationSession` on iOS) and a loopback redirect on desktop; the sandboxed Mac app needs `com.apple.security.network.server`. This needs AASA and `assetlinks.json` hosting and a server redirect allowlist.
- [ ] **Security review of native draft encryption.** `packages/native-shared/src/sealed-store.ts` uses a custom construction: HMAC-SHA256 in counter mode plus an HMAC tag, because Hermes has no WebCrypto. Get it reviewed, or replace it with a native AES-GCM module.
- [ ] **Choose a crash reporter.** Web and native have a pluggable reporter (`setErrorReporter`), but it is a no-op by default. Install one, and upload `apps/web/sourcemaps/` and the dSYMs.
- [ ] **Set up alerting.**
  - Add Cloudflare Notifications for Worker errors, queue backlog, DLQ depth and container failures.
  - Set up on-call routing.
  - Build a dashboard for the `COST_MODEL.md` counters.
  - Decide whether to enable Logpush to a retained sink. Invocation logs are deliberately off, and prod log sampling is now 1.
- [ ] **Off-account backups:** create the bucket and token (RUNBOOK "Backups"), turn on R2 lock or replication for Originals and the `_erasure/` ledger, and run a staging restore drill.
- [ ] **Scale the cron catalog sweep.** It won't scale past tens of thousands of users (`workers/core/src/scheduled.ts:125-139`); fan it out through queue messages or Workflows.
- [ ] **Choose the scanner signature path for prod** (mirror or baked), and document the accepted risk of the SigMirror job container's general internet egress.
- [ ] **Pin apt package versions** in the three Dockerfiles. The base images and pip packages are already pinned. Add image scanning and signing.
- [ ] **Accept or reduce the prerelease dependency risk.** `alchemy@2.0.0-beta.79` and `effect@4.0.0-rc.117` are in the prod path. Name an owner, and re-run evidence #6 and #8 on every bump.

### Known limitations of the fixes

- [ ] **Recurring events with a DURATION drift across DST.** Later occurrences of a DURATION-based series reuse the series length in milliseconds, so they can be off by an hour across DST, because `CalDuration` has no nominal-days kind.
- [ ] **Calendar contract validation.** Time zone and date bounds are checked in the store and dispatcher, not in `contracts/src/calendar.ts`, because the v1 golden fixtures contain invalid values. Tighten the schema when v2 contracts are introduced.
- [ ] **ICS import isn't resumable.** A crash mid-import leaves earlier batches committed; a retry re-imports everything and upserts by UID, which is safe. There's no checkpoint cursor.
- [ ] **Very long COUNT rules.** Rules beyond about 20,000 periods can hide occurrences, because of the existing `calExpand` `maxPeriods` bound.
- [ ] **Newsletter mail images.** Published pages proxy remote images, but newsletter mail (`workers/core/src/newsletter.ts`) still uses `publicHtml` with direct image URLs. Posts published before this change keep direct URLs until the author next publishes.
- [ ] **Recipient caps.** The contract allows 100 recipients per field and 100 in total, but the Cloudflare adapter's limit is 50 combined. Check that users see a clear error between 51 and 100.

### Test gaps

- [ ] **Sending budget release** after a lost claim race (claim returns null after Proceed) has no test.
- [ ] **The `json_each` `NOT IN` query** in `workers/core/src/topics/shared.ts` is only tested with an empty key list.

---

## P2: Soon after launch

- [ ] **Account closure doesn't start erasure** (gap-analysis §4.4).
- [ ] **Decide the retention period for unmapped newsletter events** (RUNBOOK: "pending the retention decision"). Audit log retention is set to 400 days by assumption; confirm it meets any compliance requirement.
- [ ] **Add tests for the 13 "Resolved, untested" rows** in `gap-analysis.md`.
- [ ] **Confirm D1 migration numbering gaps (0015–0019, 0027–0029) are intentional,** and that no environment applied the removed files.
- [ ] **Decide on metadata sharding.** Mailbox metadata sharding is a probe plus a plan; decide whether to automate it before the largest mailboxes reach 50% of the budget.
- [ ] **Run a full native accessibility audit** (Dynamic Type, contrast, screen-reader order).
