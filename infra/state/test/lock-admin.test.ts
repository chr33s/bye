import { describe, expect, it } from "vitest";
import { MemoryDurableStorage } from "@bye/testing";
import { handleStateRequest, type StateEnv, StateStoreObject } from "../core.ts";
import { runStateDrill } from "../../drills/state-drill.ts";

// Writer lease (§15.6 serialized deployments) and operator-only admin routes.

const TOKEN = "state-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef";

const backend = (admin: string | null = ADMIN) => {
  const storage = new MemoryDurableStorage();
  const puts = new Map<string, string>();
  const env: StateEnv = {
    STATE_TOKEN: TOKEN,
    STATE_ENCRYPTION_KEY: `v1:${"11".repeat(32)}`,
    ...(admin ? { STATE_ADMIN_TOKEN: admin } : {}),
    BACKUPS: {
      put: async (k: string, v: string) => void puts.set(k, v),
      get: async (k: string) => (puts.has(k) ? { text: async () => puts.get(k)! } : null),
      list: async ({ prefix }) => ({
        objects: [...puts.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
      delete: async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) puts.delete(k);
      },
    },
    STATE: { getByName: () => object },
  };
  const object = new StateStoreObject({ storage: storage as never }, env);
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    handleStateRequest(
      new Request(`https://state.test${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          ...headers,
        },
      }),
      env,
    );
  return { object, call };
};

describe("state backend writer lease and admin routes", () => {
  it("serializes competing writers: second holder gets 409 until release or expiry", () => {
    const { object } = backend();
    const t0 = 1_000_000;
    expect(object.acquireLock("S", "prod", "run-1", 60_000, t0).ok).toBe(true);
    const contended = object.acquireLock("S", "prod", "run-2", 60_000, t0 + 1);
    expect(contended).toMatchObject({ ok: false, holder: "run-1" });
    expect(object.acquireLock("S", "staging", "run-2", 60_000, t0).ok).toBe(true);
    // Renewal by the holder succeeds; release by a stale non-holder is refused.
    expect(object.acquireLock("S", "prod", "run-1", 60_000, t0 + 2).ok).toBe(true);
    expect(object.releaseLock("S", "prod", "run-2")).toBe(false);
    expect(object.releaseLock("S", "prod", "run-1")).toBe(true);
    expect(object.acquireLock("S", "prod", "run-2", 60_000, t0 + 3).ok).toBe(true);
    // An abandoned lease (crashed CI job) expires.
    expect(object.acquireLock("S", "prod", "run-3", 60_000, t0 + 3 + 60_001).ok).toBe(true);
  });

  it("exposes the lease over HTTP behind the bearer token", async () => {
    const { call } = backend();
    const a = await call("/state/locks/S/prod", {
      method: "POST",
      body: JSON.stringify({ holder: "a" }),
    });
    const b = await call("/state/locks/S/prod", {
      method: "POST",
      body: JSON.stringify({ holder: "b" }),
    });
    expect([a.status, b.status]).toEqual([200, 409]);
    expect((await call("/state/locks/S/prod?holder=b", { method: "DELETE" })).status).toBe(409);
    expect((await call("/state/locks/S/prod?holder=a", { method: "DELETE" })).status).toBe(204);
  });

  it("admin routes need the separate admin token and are disabled without one", async () => {
    const { call } = backend();
    expect((await call("/state/admin/snapshot", { method: "POST" })).status).toBe(403);
    expect(
      (await call("/state/admin/snapshot", { method: "POST" }, { "x-bye-admin-token": "wrong" }))
        .status,
    ).toBe(403);
    // Path tricks the Durable Object normalizes away still require the admin secret.
    for (const path of [
      "/state//admin/snapshot",
      "/state/%61dmin/snapshot",
      "/state/Admin/snapshot",
      "/state/admin//restore",
    ]) {
      expect((await call(path, { method: "POST" })).status).toBe(403);
    }
    expect((await call("/state/%E0%A4%A/x", { method: "POST" })).status).toBe(400);
    expect(
      (await call("/state/admin/snapshot", { method: "POST" }, { "x-bye-admin-token": ADMIN }))
        .status,
    ).toBe(200);
    const disabled = backend(null);
    expect(
      (
        await disabled.call(
          "/state/admin/snapshot",
          { method: "POST" },
          { "x-bye-admin-token": ADMIN },
        )
      ).status,
    ).toBe(403);
  });

  it("[A04] drill: real state Worker in workerd — write via alchemy client, snapshot, lose everything, restore, verify", async () => {
    const report = await runStateDrill();
    expect(report.mismatches).toEqual([]);
    expect(report.restored).toBeGreaterThanOrEqual(report.written);
    expect(report.lockContended).toBe(true);
  }, 120_000);
});

describe("state Worker entry module", () => {
  it("exports only handlers and classes (workerd rejects primitive exports from the main module)", async () => {
    const mod = (await import("../worker.ts")) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      expect(
        typeof value === "function" || (typeof value === "object" && value !== null),
        `export ${name}`,
      ).toBe(true);
    }
  });
});
