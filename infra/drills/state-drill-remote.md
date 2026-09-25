# State backup/restore drill against the deployed backend (§15.6, EVIDENCE.md #8)

`infra/drills/state-drill.ts` runs these steps against the real state Worker in local workerd. This is the same drill against the **deployed** foundation backend. Run it quarterly, and after any change to `infra/state/**` or the encryption keys.

**Prerequisites:** foundation credentials; `BYE_STATE_URL`, `BYE_STATE_TOKEN` and `BYE_STATE_ADMIN_TOKEN` (operator-only, never CI); the escrowed `BYE_STATE_ENCRYPTION_KEY`; and a maintenance window with no deploys in flight. Check with `lease.ts`: every stage lease must be free.

1. **Verify the build.** Run `node --experimental-strip-types infra/state/verify-worker.ts`. The contract version and build hash must match the reviewed source.
2. **Take the drill lease.** For each stage, run `node --experimental-strip-types infra/state/lease.ts acquire MailboxPlatform <stage> drill-<date>`. CI deploys now wait.
3. **Snapshot.** `curl -X POST -H "authorization: Bearer $BYE_STATE_TOKEN" -H "x-bye-admin-token: $BYE_STATE_ADMIN_TOKEN" $BYE_STATE_URL/state/admin/snapshot` returns `{"key":"snapshots/<time>.json"}`. Record the key, and confirm the object exists in the private `StateBackups` bucket.
4. **Record the baseline.** For every stack and stage, list the resources (`GET /state/stacks/<stack>/stages/<stage>/resources`) and save the list and each entry's digest (SHA-256 of the response body) to `evidence/<date>-state-drill/baseline.json`.
5. **Simulate the loss on a drill stack only.** Never delete production stacks for a drill. Write a throwaway `DrillStack` with a few entries, snapshot again, `DELETE /state/stacks/DrillStack`, then restore:
   `curl -X POST … -d '{"key":"<snapshot key>"}' $BYE_STATE_URL/state/admin/restore`.
6. **Verify.** `DrillStack` entries read back identically. Every baseline entry from step 4 is unchanged. `STAGE=<stage> pnpm deploy:plan` shows no changes for each stage.
7. **Escrow check.** Decrypt the latest foundation escrow with `infra/drills/escrow-foundation-state.ts` and the escrowed key in an isolated workspace. It must reproduce the foundation `.alchemy/` directory.
8. **Release** the drill leases, delete `DrillStack`, and archive the evidence folder. It holds names, digests and snapshot keys, never state values or secrets.

**Pass criteria:**

- The restore reproduces every entry.
- No stage plans any change afterwards.
- CI writers were blocked by the lease for the whole drill.
- The escrow decrypts.
