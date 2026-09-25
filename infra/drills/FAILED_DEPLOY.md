# Interrupted / failed deploy recovery drill (§13, §15.6)

**Script:** `node --experimental-transform-types infra/drills/failed-deploy.ts` (exit 0 = pass). CI runs the same scenarios through `infra/tests/failed-deploy-drill.test.ts`.

## What it proves

It uses the production state backend (`infra/state/core.ts`: HTTP state contract, sealed entries, writer lease) and the CI lease client (`infra/state/lease.ts`). The apply engine is a model of Alchemy's resource lifecycle: a resource is recorded as `creating` with its physical ID before the provider call, and `created` after it.

1. **Crash.** Run 1 takes the stage lease, plans the release manifest, and dies half-way through the apply. The runner is lost, so the lease is never released. One resource is left `creating`, and the rest don't exist yet.
2. **Fail closed.** A second writer (run 2) is refused while run 1's lease is live. Nobody "repairs" the stage concurrently.
3. **Recover the lease.** Either:
   - the operator releases it as the recorded holder (`gha-<run id>`), or
   - it expires (lease TTL, at most 6 hours).
4. **Re-plan the same manifest.** The half-written resource _resumes_ in place with its recorded physical ID. Missing resources are _created_. No persistent resource (D1, R2, DO namespace, queue) is replaced.
5. **Re-deploy and converge.** Every resource ends `created` with the manifest's props, every physical ID recorded before the crash is kept, and a further plan is a no-op (the two-deploy invariant).

A negative control in the test changes a persistent resource's type and checks that the planner reports a `replace`, so the drill can fail.

## Against a real stage

This is `infra/EVIDENCE.md` #7, and it needs an account. On a disposable `dev-<id>` stage:

1. Start `pnpm run deploy` and kill the runner mid-apply.
2. Run the RUNBOOK "Interrupted deploy" procedure.
3. Record:
   - the lease holder;
   - the `deploy:plan` after recovery, which should contain no `replace` of D1, R2, DO or Queues resources;
   - the second deploy;
   - the final no-op plan.
