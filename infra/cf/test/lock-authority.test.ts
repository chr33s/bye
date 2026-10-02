import { build } from "rolldown";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { resolve } from "node:path";

it("serializes cf and rollback writers in SQLite and refuses stale release/lease assertions", async () => {
  const bundle = await build({
    input: resolve(import.meta.dirname, "../lock-authority.ts"),
    platform: "neutral",
    write: false,
    output: { format: "esm" },
    logLevel: "silent",
  });

  const mf = new Miniflare({
    modules: true,
    script: bundle.output[0]!.code,
    compatibilityDate: "2026-07-30",
    durableObjects: { WRITER_LOCKS: { className: "WriterLock", useSQLite: true } },
    bindings: { LOCK_CREDENTIAL: "c".repeat(32), LOCK_ADMIN_CREDENTIAL: "d".repeat(32) },
  });

  const key = `bye:cf:${"a".repeat(32)}:staging:ci`;

  const call = (action: string, owner: string, leaseId: string, credential = "c".repeat(32)) =>
    mf.dispatchFetch(`https://locks.test/cf-locks/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ key, owner, leaseId }),
    });

  try {
    expect((await call("acquire", "cf", "lease-cf")).status).toBe(200);
    expect((await call("acquire", "rollback", "lease-old")).status).toBe(409);
    expect((await call("assert", "rollback", "lease-old")).status).toBe(409);
    expect((await call("release", "rollback", "lease-old")).status).toBe(409);
    expect((await call("assert", "cf", "lease-cf")).status).toBe(200);
    expect((await call("release", "cf", "lease-cf")).status).toBe(200);
    expect((await call("acquire", "rollback", "lease-old")).status).toBe(200);
    expect((await call("acquire", "cf", "lease-new", "wrong")).status).toBe(401);

    const recover = (credential: string, leaseId: string) =>
      mf.dispatchFetch("https://locks.test/cf-locks/recover", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}` },
        body: JSON.stringify({
          key,
          owner: "rollback",
          leaseId,
          reconciliationDigest: "e".repeat(64),
          approvedBy: "operator",
          ticket: "recovery-test",
        }),
      });

    expect((await recover("c".repeat(32), "lease-old")).status).toBe(401);
    expect((await recover("d".repeat(32), "stale-lease")).status).toBe(409);
    expect((await recover("d".repeat(32), "lease-old")).status).toBe(200);
    expect((await call("acquire", "cf", "lease-new")).status).toBe(200);
  } finally {
    await mf.dispose();
  }
});
