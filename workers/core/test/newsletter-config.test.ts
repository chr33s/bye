import { hmacSha256 } from "@bye/domain";
import {
  ControlAuth,
  ControlDirectory,
  RESEND_WEBHOOK_EVENTS,
  mapResendEvent,
} from "@bye/platform-cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import type { CoreEnv } from "../src/env.ts";
import { newsletterSetup } from "../src/newsletter.ts";
import {
  configureNewsletterProvider,
  loadRuntimeNewsletterConfig,
  newsletterSealKeys,
  openField,
  sealField,
} from "../src/newsletter-config.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness, executionContext } from "./harness.ts";

// infra/onboarding/spec.md §38: runtime newsletter configuration on first use — operator-only setup with
// one Resend API key, automatic webhook provisioning/recovery, sealed storage, runtime-over-env
// precedence without mixing, qualification gating and webhook verification with the stored secret.

const ctx = executionContext;

const API_KEY = "re_live_KEYKEYKEYKEYKEY123";

const SEAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const SECRET_BYTES = new TextEncoder().encode("runtime-webhook-secret");

const SIGNING_SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

const LEGACY_SECRET = `whsec_${btoa("legacy-secret-bytes")}`;

interface Hook {
  id: string;
  endpoint: string;
  events: ReadonlyArray<string>;
}

/** A minimal Resend webhook API. */
const fakeResend = () => {
  const hooks = new Map<string, Hook>();
  const calls: Array<string> = [];
  let seq = 0;

  const state = {
    exposeSecret: true,
    fault: undefined as ((method: string, path: string) => Response | undefined) | undefined,
  };

  const json = <BodyValue>(status: number, body: BodyValue) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);

    if (new Headers(init?.headers).get("authorization") !== `Bearer ${API_KEY}`)
      return json(401, { name: "invalid_api_key" });
    const injected = state.fault?.(method, path);

    if (injected) return injected;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/webhooks")
      return json(200, {
        data: [...hooks.values()].map((w) => ({
          id: w.id,
          endpoint: w.endpoint,
          events: w.events,
        })),
      });

    if (method === "POST" && path === "/webhooks") {
      const body = JSON.parse(init?.body as string) as { endpoint: string; events: Array<string> };
      const id = `wh_${++seq}`;
      hooks.set(id, { id, endpoint: body.endpoint, events: body.events });

      return json(201, { object: "webhook", id, signing_secret: SIGNING_SECRET });
    }

    if ((m = /^\/webhooks\/([^/]+)$/.exec(path)) && method === "GET") {
      const w = hooks.get(m[1]!);

      if (!w) return json(404, { name: "not_found" });

      return json(200, state.exposeSecret ? { ...w, signing_secret: SIGNING_SECRET } : { ...w });
    }

    if ((m = /^\/webhooks\/([^/]+)$/.exec(path)) && method === "DELETE") {
      hooks.delete(m[1]!);

      return json(200, { object: "webhook", id: m[1], deleted: true });
    }

    return json(404, { name: "not_found" });
  }) as typeof fetch;

  return { hooks, calls, fetchFn, state };
};

const signWebhook = async (bytes: Uint8Array, id: string, body: string, at = Date.now()) => {
  const ts = String(Math.floor(at / 1000));

  const sig = btoa(
    String.fromCharCode(...(await hmacSha256(bytes as never, `${id}.${ts}.${body}`))),
  );

  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
};

describe("[infra/onboarding/spec.md §38] newsletter configuration on first use", () => {
  let h: Harness;
  let resend: ReturnType<typeof fakeResend>;

  const signup = async (address: string, steppedUp = true) => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "test", steppedUp);

    return { ...account, cookie: `__Host-session=${session.token}` };
  };

  const call = async <JsonValue>(
    cookie: string | null,
    method: string,
    path: string,
    json?: JsonValue,
  ) => {
    const requestHeaders = new Headers();

    if (cookie) requestHeaders.set("cookie", cookie);

    if (method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

    if (json !== undefined) requestHeaders.set("content-type", "application/json");

    const r = await handleFetch(
      new Request(
        `${h.env.APP_ORIGIN}${path}`,
        json !== undefined
          ? { method, headers: requestHeaders, body: JSON.stringify(json) }
          : { method, headers: requestHeaders },
      ),
      h.env,
      ctx,
    );

    const text = await r.text();

    return { status: r.status, text, body: text ? (JSON.parse(text) as any) : null };
  };

  const postWebhook = async (headers: Record<string, string>, body: string) =>
    (
      await handleFetch(
        new Request(`${h.env.APP_ORIGIN}/webhooks/newsletter`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
        h.env,
        ctx,
      )
    ).status;

  const operator = async (steppedUp = true) => {
    const op = await signup("op@bye.test", steppedUp);
    (h.env as { OPERATOR_USER_IDS?: string }).OPERATOR_USER_IDS = op.userId;

    return op;
  };

  const configure = (fetchFn = resend.fetchFn) =>
    configureNewsletterProvider(
      h.env,
      { provider: "resend", apiKey: API_KEY, actorId: "u_op" },
      fetchFn,
    );

  const endpoint = () => `${h.env.APP_ORIGIN}/webhooks/newsletter`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 27, 12));
    h = makeHarness();
    resend = fakeResend();
    vi.stubGlobal("fetch", resend.fetchFn);
    Object.assign(h.env as object, {
      NEWSLETTER_CONFIG_SEAL_KEY: SEAL_KEY,
      NEWSLETTER_QUALIFIED: "evidence://staging/resend-2026-09",
      MAIL_SANDBOX_DOMAINS: "",
      NEWSLETTER_PROVIDER: "",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("subscribes to exactly the events the adapter maps", () => {
    for (const type of RESEND_WEBHOOK_EVENTS) {
      const kind = mapResendEvent("e", { type, data: { unsubscribed: true } }).kind;
      expect(["unmapped", "informational"]).not.toContain(kind);
    }
  });

  it("reports unconfigured, and only an operator may configure", async () => {
    const op = await operator();
    const ana = await signup("ana@bye.test");
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body).toEqual({
      provider: "resend",
      status: "unconfigured",
      qualified: true,
      canConfigure: true,
    });
    expect((await call(ana.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "unconfigured",
      canConfigure: false,
    });
    expect((await call(null, "GET", "/v1/newsletter/config")).status).toBe(401);

    const refused = await call(ana.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: API_KEY,
    });

    expect([refused.status, refused.body.error.code, refused.body.error.details?.stepUp]).toEqual([
      403,
      "forbidden",
      undefined,
    ]);
    expect(resend.calls).toEqual([]);
  });

  it("requires a recent step-up", async () => {
    const op = await operator(false);

    const r = await call(op.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: API_KEY,
    });

    expect([r.status, r.body.error.details?.stepUp]).toEqual([403, true]);
    expect(resend.calls).toEqual([]);
  });

  it("creates the webhook, seals both secrets, never returns or logs the key, then stays configured", async () => {
    const logs: Array<string> = [];

    for (const level of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, level).mockImplementation(
        (...a: Array<unknown>) => void logs.push(a.join(" ")),
      );
    const op = await operator();

    const r = await call(op.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: API_KEY,
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ready", qualified: true, canConfigure: false });
    expect(r.text).not.toContain(API_KEY);
    expect(r.text).not.toContain(SIGNING_SECRET);
    expect([...resend.hooks.values()]).toEqual([
      { id: "wh_1", endpoint: endpoint(), events: [...RESEND_WEBHOOK_EVENTS] },
    ]);

    const row = await h.d1
      .prepare("SELECT * FROM newsletter_provider_config WHERE id = 'default'")
      .first<Record<string, string | number | null>>();

    const dump = JSON.stringify(row);
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(SIGNING_SECRET);
    expect(row).toMatchObject({ provider: "resend", provider_webhook_id: "wh_1", status: "ready" });
    const keys = newsletterSealKeys(h.env)!;

    const sealed = (field: "api_key" | "webhook_secret") => ({
      keyVersion: row!.key_version as number,
      iv: row![`${field}_iv`] as string,
      ciphertext: row![`${field}_ciphertext`] as string,
    });

    expect(await openField(keys, "webhook_secret", sealed("webhook_secret"))).toBe(SIGNING_SECRET);
    expect(await openField(keys, "api_key", sealed("api_key"))).toBe(API_KEY);
    // Field isolation: a ciphertext moved to the other column does not open as that column.
    await expect(openField(keys, "api_key", sealed("webhook_secret"))).rejects.toThrow();

    for (const l of logs) {
      expect(l).not.toContain(API_KEY);
      expect(l).not.toContain(SIGNING_SECRET);
    }

    // Subsequent views do not prompt again; a second setup is refused.
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body.status).toBe("ready");

    const again = await call(op.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: API_KEY,
    });

    expect([again.status, again.body.error.code]).toEqual([409, "conflict"]);
    expect(resend.calls.filter((c) => c === "POST /webhooks")).toHaveLength(1);
  });

  it("an unusable stored config is not a lock-out: operators see needs-attention and can repair it", async () => {
    const op = await operator();
    const ana = await signup("ana@bye.test");
    expect(await configure()).toMatchObject({ _tag: "Ready" });

    const before = await h.d1
      .prepare("SELECT account_ref FROM newsletter_provider_config WHERE id = 'default'")
      .first<{ account_ref: string }>();

    // The stored credentials stop opening (e.g. a different seal key after a restore).
    (h.env as { NEWSLETTER_CONFIG_SEAL_KEY?: string }).NEWSLETTER_CONFIG_SEAL_KEY =
      SEAL_KEY.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    expect((await loadRuntimeNewsletterConfig(h.env))._tag).toBe("Unusable");
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "needs-attention",
      canConfigure: true,
    });
    expect((await call(ana.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "needs-attention",
      canConfigure: false,
    });

    // Repair with the same single key: the old webhook is reused (secret retrievable) and the row
    // replaced with a new account reference, so work bound to the old one stays held.
    const r = await call(op.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: API_KEY,
    });

    expect([r.status, r.body.status]).toEqual([200, "ready"]);

    const after = await h.d1
      .prepare("SELECT account_ref FROM newsletter_provider_config WHERE id = 'default'")
      .first<{ account_ref: string }>();

    expect(after!.account_ref).not.toBe(before!.account_ref);
    expect(await loadRuntimeNewsletterConfig(h.env)).toMatchObject({ _tag: "Present" });
    expect(resend.hooks.size).toBe(1);
    // Usable again: a further setup is refused.
    expect(
      (
        await call(op.cookie, "POST", "/v1/newsletter/config", {
          provider: "resend",
          apiKey: API_KEY,
        })
      ).status,
    ).toBe(409);
  });

  it("repair removes the previous row's webhook when it is no longer the one in use", async () => {
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    // The stored row points at an old webhook (e.g. a previous endpoint) and is not ready.
    resend.hooks.set("wh_prev", {
      id: "wh_prev",
      endpoint: "https://old.example/hook",
      events: [],
    });
    await h.d1
      .prepare(
        "UPDATE newsletter_provider_config SET status = 'needs-attention', provider_webhook_id = 'wh_prev'",
      )
      .run();
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    expect(resend.hooks.has("wh_prev")).toBe(false);
    expect(await loadRuntimeNewsletterConfig(h.env)).toMatchObject({ _tag: "Present" });
  });

  it("a missing seal key blocks setup and repair alike", async () => {
    const op = await operator();
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    (h.env as { NEWSLETTER_CONFIG_SEAL_KEY?: string }).NEWSLETTER_CONFIG_SEAL_KEY = "";
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "blocked",
      canConfigure: false,
    });
  });

  it("decodes the body with the contract schema and never echoes the key on a bad request", async () => {
    const op = await operator();

    for (const body of [
      { provider: "mailchimp", apiKey: API_KEY },
      { provider: "resend" },
      { provider: "resend", apiKey: 42 },
    ]) {
      const r = await call(op.cookie, "POST", "/v1/newsletter/config", body);
      expect([r.status, r.body.error.code]).toEqual([400, "bad_request"]);
      expect(r.text).not.toContain(API_KEY);
    }

    const long = `re_${"x".repeat(600)}`;

    const r = await call(op.cookie, "POST", "/v1/newsletter/config", {
      provider: "resend",
      apiKey: long,
    });

    expect(r.status).toBe(400);
    expect(r.text).not.toContain(long);
    expect(resend.calls).toEqual([]);
  });

  it("reuses a matching Bye webhook whose secret the API returns", async () => {
    resend.hooks.set("wh_old", { id: "wh_old", endpoint: endpoint(), events: [] });
    resend.hooks.set("wh_other", {
      id: "wh_other",
      endpoint: "https://other.example/hook",
      events: [],
    });
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    expect(resend.calls).not.toContain("POST /webhooks");
    expect(resend.hooks.has("wh_other")).toBe(true);
    const runtime = await loadRuntimeNewsletterConfig(h.env);
    expect(runtime).toMatchObject({
      _tag: "Present",
      credentials: { webhookSecret: SIGNING_SECRET },
    });
  });

  it("replaces an unrecoverable matching webhook instead of duplicating it", async () => {
    resend.state.exposeSecret = false;
    resend.hooks.set("wh_old", { id: "wh_old", endpoint: endpoint(), events: [] });
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    expect([...resend.hooks.keys()]).toEqual(["wh_1"]);
  });

  it("cleans up the created webhook when local persistence fails", async () => {
    const failing = {
      ...h.env,
      DIRECTORY: new Proxy(h.env.DIRECTORY, {
        get: (t, k) =>
          k === "batch"
            ? async () => {
                throw new Error("D1 unavailable");
              }
            : ((t as any)[k]?.bind?.(t) ?? (t as any)[k]),
      }),
    } as CoreEnv;

    const r = await configureNewsletterProvider(
      failing,
      { provider: "resend", apiKey: API_KEY, actorId: "u_op" },
      resend.fetchFn,
    );

    expect(r).toMatchObject({ _tag: "Rejected", code: "unavailable" });
    expect(resend.hooks.size).toBe(0);
    expect(resend.calls).toContain("DELETE /webhooks/wh_1");

    // Cleanup that cannot be confirmed leaves an operator-visible reconciliation record.
    resend.state.fault = (m) => (m === "DELETE" ? new Response("", { status: 502 }) : undefined);

    const r2 = await configureNewsletterProvider(
      failing,
      { provider: "resend", apiKey: API_KEY, actorId: "u_op" },
      resend.fetchFn,
    );

    expect(r2._tag).toBe("NeedsAttention");
    const op = await operator();
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "needs-attention",
      canConfigure: true,
    });
    // The retry reconciles (reuses the existing webhook) rather than creating another.
    resend.state.fault = undefined;
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    expect(resend.hooks.size).toBe(1);
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body.status).toBe("ready");
  });

  it("an uncertain create is not blindly repeated", async () => {
    resend.state.fault = (m, p) => {
      if (m === "POST" && p === "/webhooks") {
        resend.hooks.set("wh_lost", { id: "wh_lost", endpoint: endpoint(), events: [] });

        return new Response("", { status: 504 });
      }

      return undefined;
    };

    expect((await configure())._tag).toBe("NeedsAttention");
    resend.state.fault = undefined;
    expect(await configure()).toMatchObject({ _tag: "Ready" });
    expect(resend.calls.filter((c) => c === "POST /webhooks")).toHaveLength(1);
    expect([...resend.hooks.keys()]).toEqual(["wh_lost"]);
  });

  it("an invalid key is refused and nothing is stored", async () => {
    const r = await configureNewsletterProvider(
      h.env,
      { provider: "resend", apiKey: "re_wrong_key_value_123", actorId: "u" },
      resend.fetchFn,
    );

    expect(r).toMatchObject({ _tag: "Rejected", code: "bad_request" });
    expect(await loadRuntimeNewsletterConfig(h.env)).toEqual({ _tag: "None" });
  });

  it("an unqualified stage cannot be configured, and dispatch stays blocked regardless of a valid key", async () => {
    (h.env as { NEWSLETTER_QUALIFIED: string }).NEWSLETTER_QUALIFIED = "";
    expect(await configure()).toMatchObject({ _tag: "Rejected", code: "forbidden" });
    const op = await operator();
    expect((await call(op.cookie, "GET", "/v1/newsletter/config")).body).toMatchObject({
      status: "blocked",
      qualified: false,
      canConfigure: false,
    });
    // Configured while qualified, then the release loses qualification: provider, no dispatch.
    (h.env as { NEWSLETTER_QUALIFIED: string }).NEWSLETTER_QUALIFIED = "evidence://x";
    await configure();
    (h.env as { NEWSLETTER_QUALIFIED: string }).NEWSLETTER_QUALIFIED = "";
    const setup = await newsletterSetup(h.env, resend.fetchFn);
    expect(setup).toMatchObject({
      _tag: "Ready",
      dispatchBlocked: "newsletter provider not qualified for this stage",
    });
  });

  it("prefers runtime config over legacy env, and never mixes the two", async () => {
    Object.assign(h.env as object, {
      NEWSLETTER_PROVIDER: "resend",
      NEWSLETTER_ACCOUNT: "acct-legacy",
      NEWSLETTER_API_KEY: "re_legacy",
      NEWSLETTER_WEBHOOK_SECRET: LEGACY_SECRET,
    });
    // Legacy env deployments still work, and count as configured.
    expect(await newsletterSetup(h.env)).toMatchObject({
      _tag: "Ready",
      config: { account: "acct-legacy" },
    });
    expect(await configure()).toMatchObject({ _tag: "Rejected", code: "conflict" });

    // A runtime row (written directly, as an earlier setup would have) wins over the env.
    const keys = newsletterSealKeys(h.env)!;
    const k = await sealField(keys, "api_key", API_KEY);
    const s = await sealField(keys, "webhook_secret", SIGNING_SECRET);
    await h.d1
      .prepare(
        "INSERT INTO newsletter_provider_config (id, provider, account_ref, provider_webhook_id, key_version, api_key_iv, api_key_ciphertext, webhook_secret_iv, webhook_secret_ciphertext, status, configured_by, created_at, updated_at) VALUES ('default', 'resend', 'resend_rt', 'wh_9', 1, ?, ?, ?, ?, 'ready', 'u', 1, 1)",
      )
      .bind(k.iv, k.ciphertext, s.iv, s.ciphertext)
      .run();
    expect(await newsletterSetup(h.env)).toMatchObject({
      _tag: "Ready",
      config: { account: "resend_rt" },
    });

    // Runtime row that cannot be opened: blocked, never the env credentials instead.
    (h.env as { NEWSLETTER_CONFIG_SEAL_KEY: string }).NEWSLETTER_CONFIG_SEAL_KEY = "";
    expect(await newsletterSetup(h.env)).toMatchObject({ _tag: "Blocked" });
    (h.env as { NEWSLETTER_CONFIG_SEAL_KEY: string }).NEWSLETTER_CONFIG_SEAL_KEY = SEAL_KEY;
    await h.d1
      .prepare("UPDATE newsletter_provider_config SET api_key_ciphertext = ?")
      .bind(s.ciphertext)
      .run();
    expect(await newsletterSetup(h.env)).toEqual({
      _tag: "Blocked",
      reason: "newsletter credentials could not be opened",
    });

    // And the webhook no longer verifies with either secret.
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {},
    });

    expect(await postWebhook(await signWebhook(SECRET_BYTES, "m1", body), body)).toBe(401);
  });

  it("verifies provider webhooks with the dynamically loaded secret; wrong or missing config is refused", async () => {
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { broadcast_id: "bc_x", to: ["x@example.net"] },
    });

    // Missing config: authentication failure, never accepted unsigned.
    expect(await postWebhook(await signWebhook(SECRET_BYTES, "m1", body), body)).toBe(401);
    await configure();
    expect(await postWebhook(await signWebhook(SECRET_BYTES, "m1", body), body)).toBe(200);
    expect(
      await postWebhook(
        await signWebhook(new TextEncoder().encode("legacy-secret-bytes"), "m2", body),
        body,
      ),
    ).toBe(401);

    const rows = await h.d1
      .prepare("SELECT account, state FROM newsletter_events WHERE event_id = 'm1'")
      .first<{ account: string; state: string }>();

    expect(rows?.account).toMatch(/^resend_/);
  });
});
