// First-account bootstrap for onboarding installations (workers/core/src/bootstrap.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/api.ts";
import { BOOTSTRAP_CLAIM_LEASE_MS, resetBootstrapCache } from "../src/bootstrap.ts";
import type { CoreEnv } from "../src/env.ts";
import { Effect } from "effect";
import { Authorization } from "@bye/application";
import { controlAdapters, policyLayers } from "../src/services.ts";
import { makeHarness } from "./harness.ts";

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const TOKEN = "b".repeat(43);

const signup = async (env: CoreEnv, body: Record<string, unknown>) => {
  const r = await handleFetch(
    new Request(`${env.APP_ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { origin: env.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Op", ...body }),
    }),
    env,
    ctx,
  );
  return {
    status: r.status,
    body: (await r.json().catch(() => null)) as { userId?: string } | null,
  };
};

describe("first-account bootstrap", () => {
  let turnstileCalls = 0;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    resetBootstrapCache();
    turnstileCalls = 0;
    globalThis.fetch = (async () => {
      turnstileCalls++;
      return Response.json({ success: false });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  const harness = (token = TOKEN) => {
    const h = makeHarness();
    (h.env as { BOOTSTRAP_TOKEN?: string }).BOOTSTRAP_TOKEN = token;
    return h;
  };

  it("creates the first account without Turnstile, once, and makes it an operator", async () => {
    const { env } = harness();
    const first = await signup(env, { address: "operator@bye.test", bootstrap: TOKEN });
    expect(first.status).toBe(201);
    expect(turnstileCalls).toBe(0);
    expect((await controlAdapters(env)).operators).toContain(first.body!.userId);
    // The same operator on the non-HTTP policy path (inbound resolution, dispatch claim).
    const isOperator = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Authorization).isOperator(first.body!.userId!);
      }).pipe(Effect.provide(await policyLayers(env))),
    );
    expect(isOperator).toBe(true);

    // Single use: the same link can't create a second account.
    expect((await signup(env, { address: "second@bye.test", bootstrap: TOKEN })).status).toBe(403);
    // Ordinary signup still needs Turnstile (which fails here).
    expect((await signup(env, { address: "third@bye.test", turnstile: "t" })).status).toBe(403);
    expect(turnstileCalls).toBe(1);
  });

  it("refuses wrong tokens, disabled instances, and instances that already have users", async () => {
    const { env } = harness();
    expect(
      (await signup(env, { address: "operator@bye.test", bootstrap: "x".repeat(43) })).status,
    ).toBe(403);
    expect((await signup(env, { address: "operator@bye.test" })).status).toBe(403); // neither proof

    const off = harness("");
    expect((await signup(off.env, { address: "operator@bye.test", bootstrap: TOKEN })).status).toBe(
      403,
    );
    expect(await controlAdapters(off.env).then((a) => a.operators)).toEqual([]);

    const used = harness();
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    expect((await signup(used.env, { address: "someone@bye.test", turnstile: "t" })).status).toBe(
      201,
    );
    expect(
      (await signup(used.env, { address: "operator@bye.test", bootstrap: TOKEN })).status,
    ).toBe(403);
  });

  it("frees the claim when signup fails, and lets a stale claim be retaken", async () => {
    const { env } = harness();
    // A reserved address fails after the claim; the slot is released for a retry.
    expect((await signup(env, { address: "postmaster@bye.test", bootstrap: TOKEN })).status).toBe(
      403,
    );
    expect((await signup(env, { address: "operator@bye.test", bootstrap: TOKEN })).status).toBe(
      201,
    );

    // A claim abandoned mid-signup (Worker died) blocks until its lease passes.
    const h2 = harness();
    await h2.d1
      .prepare("INSERT INTO instance_bootstrap (id, claimed_at, user_id) VALUES (1, ?, NULL)")
      .bind(Date.now())
      .run();
    expect((await signup(h2.env, { address: "operator@bye.test", bootstrap: TOKEN })).status).toBe(
      403,
    );
    await h2.d1
      .prepare("UPDATE instance_bootstrap SET claimed_at = ?")
      .bind(Date.now() - BOOTSTRAP_CLAIM_LEASE_MS - 1)
      .run();
    expect((await signup(h2.env, { address: "operator@bye.test", bootstrap: TOKEN })).status).toBe(
      201,
    );
  });
});
