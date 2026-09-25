import { describe, expect, it } from "vitest";
import { MemoryDurableStorage } from "@bye/testing";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { STATE_WORKER_SOURCES, stateBuildHash } from "../build-hash.ts";
import {
  handleStateRequest,
  parseStateGrants,
  stageAllowed,
  type StateEnv,
  StateStoreObject,
} from "../core.ts";
import {
  acquireLease,
  heartbeatLease,
  LEASE_TTL_MS,
  type LeaseFetcher,
  releaseLease,
  renewLease,
} from "../lease.ts";
import { envLines, readStackOutput } from "../output.ts";
import { verifyStateWorker } from "../verify-worker.ts";

// CI gates around the self-hosted state backend (§15.6 serialized writers, §15.7 deployed-artifact check).

const TOKEN = "state-token-0123456789abcdef";

const backend = (build?: string) => {
  const env: StateEnv = {
    STATE_TOKEN: TOKEN,
    STATE_ENCRYPTION_KEY: `v1:${"22".repeat(32)}`,
    ...(build ? { STATE_BUILD_HASH: build } : {}),
    STATE: { getByName: () => object },
  };
  const object = new StateStoreObject({ storage: new MemoryDurableStorage() as never }, env);
  const fetcher = async (
    url: string,
    init: Parameters<LeaseFetcher>[1] = { method: "GET", headers: {} },
  ): ReturnType<LeaseFetcher> => {
    const r = await handleStateRequest(
      new Request(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body ? { body: init.body } : {}),
      }),
      env,
    );
    const text = await r.text();
    return { status: r.status, json: async () => (text ? JSON.parse(text) : {}) };
  };
  return { fetcher };
};

describe("state backend CI scripts", () => {
  it("[A04] the build hash covers every local module the state Worker imports", () => {
    const dir = join(import.meta.dirname, "..");
    const seen = new Set<string>();
    const visit = (file: string): void => {
      const path = normalize(file);
      if (seen.has(path)) return;
      seen.add(path);
      for (const [, spec] of readFileSync(join(dir, path), "utf8").matchAll(
        /^import[^"']*["'](\.[^"']+)["']/gm,
      ))
        visit(join(dirname(path), spec!));
    };
    visit("worker.ts");
    expect([...seen].sort()).toEqual(STATE_WORKER_SOURCES.map((f) => normalize(f)).sort());
  });

  it("[A04] verify-worker accepts only the pinned contract and the reviewed source build", async () => {
    const hash = stateBuildHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await verifyStateWorker("https://state.test", (u) => backend(hash).fetcher(u))).ok,
    ).toBe(true);
    const drifted = await verifyStateWorker("https://state.test", (u) =>
      backend("0".repeat(64)).fetcher(u),
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.problems.join()).toContain("reviewed source");
    expect((await verifyStateWorker("https://state.test", (u) => backend().fetcher(u))).ok).toBe(
      false,
    );
    const down = await verifyStateWorker("https://state.test", async () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(down.problems.join()).toContain("unreachable");
  });

  it("[A04] lease: a competing writer waits and then fails closed; the holder releases; expired release is tolerated", async () => {
    const { fetcher } = backend(stateBuildHash());
    const o = {
      baseUrl: "https://state.test",
      token: TOKEN,
      fetcher,
      waitMs: 25,
      pollMs: 10,
      sleep: async () => undefined,
    };
    expect(await acquireLease(o, "MailboxPlatform", "prod", "gha-1")).toMatchObject({ ok: true });
    const second = await acquireLease(o, "MailboxPlatform", "prod", "gha-2");
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("gha-1");
    expect((await releaseLease(o, "MailboxPlatform", "prod", "gha-1")).ok).toBe(true);
    expect(await acquireLease(o, "MailboxPlatform", "prod", "gha-2")).toMatchObject({ ok: true });
    // Releasing a lease we no longer hold (e.g. it expired) must not fail the job.
    expect((await releaseLease(o, "MailboxPlatform", "prod", "gha-1")).ok).toBe(true);
    const badToken = await acquireLease(
      { ...o, token: "wrong" },
      "MailboxPlatform",
      "prod",
      "gha-3",
    );
    expect(badToken).toMatchObject({ ok: false, detail: "lease request failed with 401" });
  });

  it("[A04] lease heartbeat: renewals keep a long deploy's lease; a lost lease stops the heartbeat", async () => {
    const { fetcher } = backend(stateBuildHash());
    const calls: Array<string> = [];
    const counting: LeaseFetcher = async (url, init) => {
      calls.push(`${init.method} ${init.body ?? ""}`);
      return fetcher(url, init);
    };
    const o = { baseUrl: "https://state.test", token: TOKEN, fetcher: counting };
    expect(await acquireLease(o, "MailboxPlatform", "prod", "gha-1")).toMatchObject({ ok: true });
    // Every request asks for the full TTL, so each renewal pushes expiry out again.
    expect(calls[0]).toContain(`"ttlMs":${LEASE_TTL_MS}`);
    expect(await renewLease(o, "MailboxPlatform", "prod", "gha-1")).toMatchObject({
      ok: true,
      lost: false,
    });
    // A competitor cannot take a lease that is being renewed.
    expect(await renewLease(o, "MailboxPlatform", "prod", "gha-2")).toMatchObject({
      ok: false,
      lost: true,
      detail: "lease lost to gha-1",
    });

    // Heartbeat: three ticks, then the job ends (abort) — the lease was renewed each tick.
    const stop = new AbortController();
    let ticks = 0;
    const beat = await heartbeatLease(
      {
        ...o,
        sleep: async () => {
          if (++ticks > 3) stop.abort();
        },
      },
      "MailboxPlatform",
      "prod",
      "gha-1",
      { signal: stop.signal },
    );
    expect(beat).toEqual({ ok: true, detail: "stopped", renewals: 3 });

    // The heartbeat of a holder that lost its lease (expired and taken) stops and reports it.
    const lost = await heartbeatLease(
      { ...o, sleep: async () => undefined },
      "MailboxPlatform",
      "prod",
      "gha-stale",
    );
    expect(lost).toMatchObject({ ok: false, renewals: 0, detail: "lease lost to gha-1" });

    // Transient failures are retried, never treated as a lost lease.
    const flaky = await renewLease(
      { ...o, fetcher: async () => Promise.reject(new Error("ECONNRESET")) },
      "MailboxPlatform",
      "prod",
      "gha-1",
    );
    expect(flaky).toMatchObject({ ok: false, lost: false });
    expect((await releaseLease(o, "MailboxPlatform", "prod", "gha-1")).ok).toBe(true);
  });
});

describe("per-stage state tokens (prod state unreachable from nonprod CI)", () => {
  const PROD = "prod-token-0123456789abcdef";
  const NONPROD = "nonprod-token-0123456789abcdef";
  const OPERATOR = "operator-token-0123456789abcdef";
  const scoped = () => {
    const env: StateEnv = {
      STATE_TOKEN: `prod=${PROD}, staging|preview-*|dev-*=${NONPROD},${OPERATOR}`,
      STATE_ENCRYPTION_KEY: `v1:${"33".repeat(32)}`,
      STATE: { getByName: () => object },
    };
    const object = new StateStoreObject({ storage: new MemoryDurableStorage() as never }, env);
    return (token: string, method: string, path: string, body?: unknown) =>
      handleStateRequest(
        new Request(`https://state.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      ).then((r) => r.status);
  };

  it("parses bare and scoped grants; padded base64 stays a bare token", () => {
    expect(parseStateGrants(`prod=${PROD},preview-*|dev-*=${NONPROD},${OPERATOR}`)).toEqual([
      { token: PROD, stages: ["prod"] },
      { token: NONPROD, stages: ["preview-*", "dev-*"] },
      { token: OPERATOR, stages: null },
    ]);
    expect(parseStateGrants("abcdefghijklmnopqrstuvwx==")).toEqual([
      { token: "abcdefghijklmnopqrstuvwx==", stages: null },
    ]);
    expect(stageAllowed({ token: "t", stages: ["preview-*"] }, "preview-12")).toBe(true);
    expect(stageAllowed({ token: "t", stages: ["preview-*"] }, "prod")).toBe(false);
    expect(stageAllowed({ token: "t", stages: ["prod"] }, "prod-2")).toBe(false);
  });

  it("a nonprod token reaches preview/dev/staging state and leases, never prod", async () => {
    const call = scoped();
    const res = (stage: string) => `/state/stacks/MailboxPlatform/stages/${stage}/resources/a%2Fb`;
    expect(await call(NONPROD, "PUT", res("preview-7"), { status: "created" })).toBe(200);
    expect(await call(NONPROD, "GET", res("preview-7"))).toBe(200);
    expect(await call(NONPROD, "PUT", res("prod"), { status: "created" })).toBe(403);
    expect(await call(NONPROD, "GET", res("prod"))).toBe(403);
    expect(await call(NONPROD, "GET", "/state/stacks/MailboxPlatform/stages/prod/output")).toBe(
      403,
    );
    expect(await call(NONPROD, "POST", "/state/locks/MailboxPlatform/prod", { holder: "x" })).toBe(
      403,
    );
    expect(
      await call(NONPROD, "POST", "/state/locks/MailboxPlatform/preview-7", { holder: "x" }),
    ).toBe(200);
    // Whole-stack deletes need an unscoped grant; stage-scoped deletes follow the stage rule.
    expect(await call(NONPROD, "DELETE", "/state/stacks/MailboxPlatform")).toBe(403);
    expect(await call(NONPROD, "DELETE", "/state/stacks/MailboxPlatform?stage=prod")).toBe(403);
    expect(await call(NONPROD, "DELETE", "/state/stacks/MailboxPlatform?stage=dev-abc123")).toBe(
      204,
    );
    // Name listings are allowed for any valid grant.
    expect(await call(NONPROD, "GET", "/state/stacks")).toBe(200);
    expect(await call(NONPROD, "GET", "/state/stacks/MailboxPlatform/stages")).toBe(200);
  });

  it("the prod token reaches only prod; the unscoped operator token reaches everything", async () => {
    const call = scoped();
    const res = (stage: string) => `/state/stacks/MailboxPlatform/stages/${stage}/resources/x`;
    expect(await call(PROD, "PUT", res("prod"), { v: 1 })).toBe(200);
    expect(await call(PROD, "GET", res("staging"))).toBe(403);
    expect(await call(OPERATOR, "GET", res("prod"))).toBe(200);
    expect(await call(OPERATOR, "GET", res("staging"))).toBe(200);
    expect(await call("not-a-token-at-all-xxxx", "GET", res("prod"))).toBe(401);
    // Percent-encoded stage segments are scoped on their decoded name.
    expect(
      await call(NONPROD, "GET", "/state/stacks/MailboxPlatform/stages/%70rod/resources/x"),
    ).toBe(403);
  });
});

describe("stack output reader (canary version pin)", () => {
  it("reads the deployed stage output and emits only present, single-line string fields", async () => {
    const env: StateEnv = {
      STATE_TOKEN: TOKEN,
      STATE_ENCRYPTION_KEY: `v1:${"44".repeat(32)}`,
      STATE: { getByName: () => object },
    };
    const object = new StateStoreObject({ storage: new MemoryDurableStorage() as never }, env);
    const fetcher = async (
      url: string,
      init: { headers: Record<string, string>; method?: string; body?: string },
    ) => handleStateRequest(new Request(url, init), env);
    const path = "https://state.test/state/stacks/MailboxPlatform/stages/prod/output";
    await fetcher(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ coreWorkerName: "core-w", coreVersionId: "abcd-1234", n: 1 }),
    });
    const output = await readStackOutput(
      { baseUrl: "https://state.test", token: TOKEN, fetcher },
      "MailboxPlatform",
      "prod",
    );
    expect(
      envLines(output, [
        "coreWorkerName=PROBE_WORKER_NAME",
        "coreVersionId=PROBE_VERSION_ID",
        "n=N",
        "missing=MISSING",
      ]),
    ).toEqual(["PROBE_WORKER_NAME=core-w", "PROBE_VERSION_ID=abcd-1234"]);
    expect(() => envLines(output, ["coreWorkerName=bad name"])).toThrow();
    await expect(
      readStackOutput({ baseUrl: "https://state.test", token: "wrong", fetcher }, "S", "prod"),
    ).rejects.toThrow("401");
  });
});
