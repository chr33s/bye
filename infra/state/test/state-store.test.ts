import { Effect, Redacted } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDurableStorage } from "@bye/testing";
import {
  handleStateRequest,
  STATE_CONTRACT_VERSION,
  type StateEnv,
  StateStoreObject,
} from "../core.ts";

// Wire-compatibility tests: the real Alchemy HTTP state client (alchemy@2.0.0-beta.78
// `makeHttpStateStore`) talks to our state Worker through an in-process fetch, with
// SQLite-backed DO storage from node:sqlite. Global fetch is poisoned to prove no egress.

const TOKEN = "state-token-0123456789abcdef";

const KEY_V1 = `v1:${"11".repeat(32)}`;

const KEY_V2 = `v2:${"22".repeat(32)}`;

class Backups {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects.keys()].flatMap((key) => (key.startsWith(prefix) ? [{ key }] : [])),
    };
  }
  async delete(keys: string | Array<string>) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

const makeBackend = (encryptionKey = KEY_V1) => {
  const storage = new MemoryDurableStorage();
  const backups = new Backups();

  const env: StateEnv = {
    STATE_TOKEN: TOKEN,
    STATE_ENCRYPTION_KEY: encryptionKey,
    BACKUPS: backups,
    STATE: { getByName: () => object },
  };

  let object = new StateStoreObject({ storage: storage as never }, env);
  const serve = (request: Request) => handleStateRequest(request, env);

  const rekey = (key: string) => {
    Object.assign(env, { STATE_ENCRYPTION_KEY: key });
    object = new StateStoreObject({ storage: storage as never }, env);
  };

  return { storage, backups, env, serve, rekey, object: () => object };
};

const clientFor = (serve: (r: Request) => Promise<Response>, authToken = TOKEN) =>
  makeHttpStateStore({ url: "https://state.bye.internal", authToken, id: "bye-http" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, ((input: RequestInfo | URL, init?: RequestInit) =>
      serve(new Request(input, init))) as typeof fetch),
  );

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("HTTP state backend (§15.6/§15.7)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error("egress attempted");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports the same contract version alchemy's client expects", async () => {
    expect(STATE_CONTRACT_VERSION).toBe(STATE_STORE_VERSION);
    const { serve } = makeBackend();
    const store = await run(clientFor(serve));
    expect(await run(store.getVersion())).toBe(STATE_STORE_VERSION);
  });

  it("round-trips resource state, outputs, listings and deletes through the real client", async () => {
    const { serve } = makeBackend();
    const store = await run(clientFor(serve));
    const fqn = "MailboxPlatform/Mailboxes/ns%2Fweird key";

    const value = {
      status: "created",
      kind: "Cloudflare.DurableObject",
      logicalId: "Mailboxes",
      props: { className: "MailboxDO" },
      attr: { id: "abc" },
    };

    expect(
      await run(store.get({ stack: "MailboxPlatform", stage: "staging", fqn })),
    ).toBeUndefined();
    await run(
      store.set({ stack: "MailboxPlatform", stage: "staging", fqn, value: value as never }),
    );
    await run(
      store.set({
        stack: "MailboxPlatform",
        stage: "prod",
        fqn: "a",
        value: { ...value, status: "replaced" } as never,
      }),
    );
    expect(await run(store.get({ stack: "MailboxPlatform", stage: "staging", fqn }))).toEqual(
      value,
    );
    expect(await run(store.listStacks())).toEqual(["MailboxPlatform"]);
    expect([...(await run(store.listStages("MailboxPlatform")))].sort()).toEqual([
      "prod",
      "staging",
    ]);
    expect(await run(store.list({ stack: "MailboxPlatform", stage: "staging" }))).toEqual([fqn]);
    expect(
      (await run(store.getReplacedResources({ stack: "MailboxPlatform", stage: "prod" }))).map(
        (r) => (r as { status: string }).status,
      ),
    ).toEqual(["replaced"]);

    expect(
      await run(store.getOutput({ stack: "MailboxPlatform", stage: "staging" })),
    ).toBeUndefined();
    await run(
      store.setOutput({
        stack: "MailboxPlatform",
        stage: "staging",
        value: { coreUrl: "https://core" },
      }),
    );
    expect(await run(store.getOutput({ stack: "MailboxPlatform", stage: "staging" }))).toEqual({
      coreUrl: "https://core",
    });

    await run(store.delete({ stack: "MailboxPlatform", stage: "staging", fqn }));
    expect(
      await run(store.get({ stack: "MailboxPlatform", stage: "staging", fqn })),
    ).toBeUndefined();
    await run(store.deleteStack({ stack: "MailboxPlatform", stage: "prod" }));
    expect(await run(store.list({ stack: "MailboxPlatform", stage: "prod" }))).toEqual([]);
    await run(store.deleteStack({ stack: "MailboxPlatform" }));
    expect(await run(store.listStacks())).toEqual([]);
  });

  it("preserves Redacted secrets through alchemy's state encoding", async () => {
    const { serve } = makeBackend();
    const store = await run(clientFor(serve));
    await run(
      store.set({
        stack: "s",
        stage: "dev-1",
        fqn: "Secret",
        value: { status: "created", attr: { token: Redacted.make("hunter2") } } as never,
      }),
    );

    const back: { attr: { token: Redacted.Redacted<string> } } = (await run(
      store.get({ stack: "s", stage: "dev-1", fqn: "Secret" }),
    )) as never;

    expect(Redacted.isRedacted(back.attr.token)).toBe(true);
    expect(Redacted.value(back.attr.token as Redacted.Redacted<string>)).toBe("hunter2");
  });

  it("rejects missing or wrong bearer tokens without touching storage", async () => {
    const { serve, storage } = makeBackend();
    const bad = await run(clientFor(serve, "wrong-token"));
    const failure = await Effect.runPromise(Effect.flip(bad.listStacks()));
    expect(failure.http?.status).toBe(401);
    expect((await serve(new Request("https://state/state/stacks"))).status).toBe(401);
    expect(storage.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
    // The version probe is intentionally public, as in alchemy's contract.
    expect((await serve(new Request("https://state/version"))).status).toBe(200);
  });

  it("stores values encrypted at rest and supports key rotation", async () => {
    const backend = makeBackend(KEY_V1);
    const store = await run(clientFor(backend.serve));
    await run(
      store.set({
        stack: "s",
        stage: "prod",
        fqn: "Db",
        value: { status: "created", attr: { password: "plaintext-marker" } } as never,
      }),
    );
    const raw = JSON.stringify(backend.storage.db.prepare("SELECT value FROM entries").all());
    expect(raw).not.toContain("plaintext-marker");
    backend.rekey(`${KEY_V2},${KEY_V1}`);
    const rotated = await run(clientFor(backend.serve));
    expect(await run(rotated.get({ stack: "s", stage: "prod", fqn: "Db" }))).toMatchObject({
      attr: { password: "plaintext-marker" },
    });
    await run(
      rotated.set({ stack: "s", stage: "prod", fqn: "Db2", value: { status: "created" } as never }),
    );

    const versions = (
      backend.storage.db.prepare("SELECT value FROM entries ORDER BY fqn").all() as Array<{
        value: string;
      }>
    ).map((r) => r.value.split(".")[0]);

    expect(versions).toEqual(["v1", "v2"]);
  });

  it("writes encrypted snapshots on the backup alarm and restores from them", async () => {
    const backend = makeBackend();
    const store = await run(clientFor(backend.serve));
    await run(
      store.set({
        stack: "s",
        stage: "prod",
        fqn: "R2",
        value: { status: "created", attr: { bucket: "originals" } } as never,
      }),
    );
    expect(await backend.storage.getAlarm()).not.toBeNull();
    await backend.object().alarm();
    const [key] = [...backend.backups.objects.keys()];
    const snapshot = JSON.parse(backend.backups.objects.get(key!)!);
    expect(JSON.stringify(snapshot)).not.toContain("originals");

    const fresh = makeBackend();
    expect(fresh.object().restore(snapshot)).toBe(1);
    const restored = await run(clientFor(fresh.serve));
    expect(await run(restored.get({ stack: "s", stage: "prod", fqn: "R2" }))).toMatchObject({
      attr: { bucket: "originals" },
    });
  });

  it("keeps at most the retention window of snapshots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const backend = makeBackend();

      for (let i = 0; i < 35; i++) {
        vi.setSystemTime(Date.UTC(2026, 0, 1) + i * 86_400_000);
        await backend.object().alarm();
      }

      expect(backend.backups.objects.size).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no outbound network or telemetry code in the worker source", async () => {
    const { readFileSync } = await import("node:fs");

    const source = readFileSync(new URL("../core.ts", import.meta.url).pathname, "utf8").replace(
      /\/\/.*$/gm,
      "",
    );

    // The DO's own `fetch` handler and the stub call are allowed; any other fetch call is egress.
    expect(source).not.toMatch(/(?<!async |\.)\bfetch\s*\((?!request: Request\))/);
    expect(source).not.toMatch(/globalThis\.fetch|connect\(/);
    expect(source).not.toMatch(/otlp|axiom|opentelemetry|sendBeacon|WebSocket/i);
    expect(source).not.toMatch(/from\s+["'](alchemy|effect|node:)/);
  });
});

describe("state backend bundle", () => {
  it("bundles for workerd with no imports and no telemetry or egress code", async () => {
    const { checkWorkerBundle } = await import("../../policies/check-bundle.ts");
    const result = await checkWorkerBundle(new URL("../worker.ts", import.meta.url).pathname);
    expect(result.violations).toEqual([]);
    expect(result.imports).toEqual([]);
  });
});

describe("state backend selection", () => {
  it("defaults to the Cloudflare state store and accepts only known backends", async () => {
    const { stateBackendFrom } = await import("../client.ts");
    expect(stateBackendFrom(undefined)).toBe("cloudflare");
    expect(stateBackendFrom("http")).toBe("http");
    expect(() => stateBackendFrom("s3")).toThrow();
  });

  it("the foundation stack binds only the state object, backups, secrets and its build hash — no egress bindings", async () => {
    const { stateEnv } = await import("../../foundation/stack.ts");
    expect(Object.keys(stateEnv).sort()).toEqual([
      "BACKUPS",
      "STATE",
      "STATE_ADMIN_TOKEN",
      "STATE_BUILD_HASH",
      "STATE_ENCRYPTION_KEY",
      "STATE_TOKEN",
    ]);
    expect(stateEnv.STATE_BUILD_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
