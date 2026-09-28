import { Predicate } from "effect";
import { hmacSha256 } from "@bye/domain";
import { ControlAuth, ControlDirectory, type WorldStore } from "@bye/platform-cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { approveNewsletter, ledgerOf, runNewsletter } from "../src/newsletter.ts";
import { FanoutWorkflow } from "../src/workflows/fanout.ts";
import { newsletterSealKeys, sealField } from "../src/newsletter-config.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  makeHarness,
  executionContext,
  type StepResult,
  type JsonRecord,
} from "./harness.ts";

// spec.md §13 mail acceptance over in-memory bindings with a fake Resend API: routing/capabilities,
// consent consistency, broadcast recovery, event authentication and provider recovery.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = executionContext;

const SECRET_BYTES = new TextEncoder().encode("webhook-secret-bytes");

const WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

interface FakeBroadcast {
  id: string;
  name: string;
  segment_id: string;
  topic_id?: string;
  from: string;
  subject: string;
  html: string;
  status: string;
  body: JsonRecord;
}

/** A minimal Resend: segments, topics, contacts (global) and broadcasts. */
const fakeResend = () => {
  const contacts = new Map<
    string,
    { segments: Set<string>; topics: Map<string, string>; unsubscribed: boolean }
  >();

  const broadcasts = new Map<string, FakeBroadcast>();
  const calls: Array<string> = [];
  let seq = 0;
  /** Return a Response to short-circuit a call (fault injection). */
  let fault: ((method: string, path: string) => Response | undefined) | undefined;

  const json = <BodyValue>(status: number, body: BodyValue) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);

    if (!new Headers(init?.headers).get("user-agent")) return json(403, { name: "missing_ua" });
    const injected = fault?.(method, path);

    if (injected) return injected;
    const body = Predicate.isString(init?.body) ? JSON.parse(init.body) : undefined;
    let m: RegExpExecArray | null;

    if (method === "POST" && path === "/segments") return json(201, { id: `seg_${++seq}` });

    if (method === "POST" && path === "/topics") {
      expect(body.default_subscription).toBe("opt_out");

      return json(201, { id: `top_${++seq}` });
    }

    if (method === "POST" && path === "/contacts") {
      contacts.set(body.email, {
        segments: new Set(body.segments.map((s: { id: string }) => s.id)),
        topics: new Map(
          body.topics.map((t: { id: string; subscription: string }) => [t.id, t.subscription]),
        ),
        unsubscribed: false,
      });
      expect(body).not.toHaveProperty("unsubscribed");

      return json(201, { id: `ct_${++seq}` });
    }

    if ((m = /^\/contacts\/([^/]+)\/topics$/.exec(path)) && method === "PATCH") {
      const c = contacts.get(decodeURIComponent(m[1]!));

      if (!c) return json(404, { name: "not_found" });

      for (const t of body as Array<{ id: string; subscription: string }>)
        c.topics.set(t.id, t.subscription);

      return json(200, { id: "x" });
    }

    if ((m = /^\/contacts\/([^/]+)\/segments\/([^/]+)$/.exec(path)) && method === "POST") {
      contacts.get(decodeURIComponent(m[1]!))!.segments.add(decodeURIComponent(m[2]!));

      return json(200, { id: m[2] });
    }

    if (method === "POST" && path === "/broadcasts") {
      const id = `bc_${++seq}`;
      broadcasts.set(id, { id, ...body, status: "draft", body });

      return json(201, { id });
    }

    if (method === "GET" && path === "/broadcasts")
      return json(200, { data: [...broadcasts.values()] });

    if ((m = /^\/broadcasts\/([^/]+)$/.exec(path)) && method === "GET") {
      const b = broadcasts.get(m[1]!);

      return b ? json(200, b) : json(404, { name: "not_found" });
    }

    if ((m = /^\/broadcasts\/([^/]+)\/send$/.exec(path)) && method === "POST") {
      broadcasts.get(m[1]!)!.status = "queued";

      return json(200, { id: m[1] });
    }

    if ((m = /^\/broadcasts\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
      const b = broadcasts.get(m[1]!)!;

      if (b.status !== "queued" && b.status !== "scheduled") return json(422, { name: "invalid" });
      b.status = "canceled";

      return json(200, { id: m[1] });
    }

    return json(404, { name: "not_found" });
  }) as typeof fetch;

  return {
    fetchFn,
    contacts,
    broadcasts,
    calls,
    setFault: (f: typeof fault) => void (fault = f),
  };
};

const signWebhook = async (id: string, body: string, at = Date.now()) => {
  const ts = String(Math.floor(at / 1000));

  const sig = btoa(
    String.fromCharCode(...(await hmacSha256(SECRET_BYTES as never, `${id}.${ts}.${body}`))),
  );

  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
};

const postWebhook = async (h: Harness, headers: Record<string, string>, body: string) => {
  const r = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}/webhooks/newsletter`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
    h.env,
    ctx,
  );

  return { status: r.status, body: await r.json<JsonRecord | null>().catch(() => null) };
};

const configure = (h: Harness, qualified = "evidence://staging/resend-2026-09") => {
  Object.assign(h.env as object, {
    NEWSLETTER_PROVIDER: "resend",
    NEWSLETTER_ACCOUNT: "acct-main",
    NEWSLETTER_API_KEY: "re_test",
    NEWSLETTER_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NEWSLETTER_QUALIFIED: qualified,
    MAIL_SANDBOX_DOMAINS: "",
  });
};

/** Runtime (operator-entered) configuration, sealed as POST /v1/newsletter/config stores it. */
const configureRuntime = async (h: Harness, qualified = "evidence://staging/resend-2026-09") => {
  Object.assign(h.env as object, {
    NEWSLETTER_CONFIG_SEAL_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
    NEWSLETTER_QUALIFIED: qualified,
    MAIL_SANDBOX_DOMAINS: "",
  });
  const keys = newsletterSealKeys(h.env)!;
  const k = await sealField(keys, "api_key", "re_runtime_key_0001");
  const s = await sealField(keys, "webhook_secret", WEBHOOK_SECRET);
  await h.d1
    .prepare(
      "INSERT INTO newsletter_provider_config (id, provider, account_ref, provider_webhook_id, key_version, api_key_iv, api_key_ciphertext, webhook_secret_iv, webhook_secret_ciphertext, status, configured_by, created_at, updated_at) VALUES ('default', 'resend', 'resend_runtime', 'wh_1', 1, ?, ?, ?, ?, 'ready', 'u', 1, 1)",
    )
    .bind(k.iv, k.ciphertext, s.iv, s.ciphertext)
    .run();
};

describe("[P02] newsletters (§5.5)", () => {
  let h: Harness;
  let resend: ReturnType<typeof fakeResend>;
  let postId: string;
  let store: WorldStore;

  const subscribe = async (a: string) => {
    const { confirmToken } = await store.subscribe(a);
    await store.confirm(confirmToken!);
  };

  const pass = () => runNewsletter(h.env, "ana", resend.fetchFn);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
    resend = fakeResend();

    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "test", true);

    const created = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/v1/world/posts`, {
        method: "POST",
        headers: {
          cookie: `__Host-session=${session.token}`,
          origin: h.env.APP_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: "ana@bye.test", title: "Hi", html: "<p>hi</p>", text: "hi" }),
      }),
      h.env,
      ctx,
    );

    expect(created.status).toBe(201);
    postId = ((await created.json()) as { postId: string }).postId;
    store = (
      h.namespaces.SHARED_SPACES.instance("world:ana") as { worldStore(): WorldStore }
    ).worldStore();
    await subscribe("a@example.net");
    await subscribe("b@example.net");
  });
  afterEach(() => vi.useRealTimers());

  it("is blocked without a qualified provider and never falls back to individual messages", async () => {
    expect(await approveNewsletter(h.env, "ana", postId, 1)).toEqual({
      blocked: "no newsletter provider configured",
    });
    configure(h, "");
    expect(await approveNewsletter(h.env, "ana", postId, 1)).toEqual({
      blocked: "newsletter provider not qualified for this stage",
    });
    expect((await pass()).blocked).toBe("newsletter provider not qualified for this stage");
    expect(resend.calls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  describe("FanoutWorkflow transport gate", () => {
    const runFanout = async () => {
      const instance = h.workflows.FANOUT?.find((w) => w.id.startsWith(`fan-ana-${postId}-r`));
      expect(instance).toBeDefined();
      const executed: Array<string> = [];

      const step = {
        do: async (name: string, ...args: ReadonlyArray<unknown>) => (
          executed.push(name),
          (args.at(-1) as () => Promise<StepResult>)()
        ),
        sleep: async () => undefined,
      };

      const result = await new FanoutWorkflow({} as never, h.env).run(
        { payload: instance!.params, instanceId: instance!.id, timestamp: new Date() } as never,
        step as never,
      );

      return { result, executed };
    };

    it("sends nothing until a qualified provider approves it, and never through individual mail", async () => {
      vi.stubGlobal("fetch", resend.fetchFn);

      try {
        let r = await runFanout();
        expect(r.result).toEqual({ blocked: "no newsletter provider configured" });
        expect(r.executed.some((n) => n.startsWith("v2:pass"))).toBe(false);
        configure(h, "");
        r = await runFanout();
        expect(r.result).toEqual({ blocked: "newsletter provider not qualified for this stage" });
        expect(resend.calls).toEqual([]);
        expect(h.sent).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("when qualified, approves one publication and submits it through the provider only", async () => {
      vi.stubGlobal("fetch", resend.fetchFn);

      try {
        configure(h);
        const r = await runFanout();
        expect(r.executed).toContain("v2:approve");
        expect(r.executed).toContain("v2:pass:0");
        expect(r.result).toMatchObject({ blocked: null });
        expect([...resend.broadcasts.values()]).toHaveLength(1);
        expect(h.sent).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("syncs creator-scoped topic consent, then creates, verifies and sends one broadcast", async () => {
    configure(h);
    const p = await approveNewsletter(h.env, "ana", postId, 1);
    expect(p).toMatchObject({ state: "approved", recipients: 2 });
    await subscribe("late@example.net");

    let r = await pass();
    expect(r.publication?.state).toBe("drafted");
    const [segment] = [...resend.contacts.values()][0]!.segments;
    expect([...resend.contacts.keys()].sort()).toEqual(["a@example.net", "b@example.net"]);

    for (const c of resend.contacts.values()) {
      expect([...c.topics.values()]).toEqual(["opt_in"]);
      expect(c.unsubscribed).toBe(false);
    }

    const [b] = [...resend.broadcasts.values()];
    expect(b).toMatchObject({ segment_id: segment, name: `pub_${postId}_r1`, status: "draft" });
    expect(b!.topic_id).toMatch(/^top_/);
    expect(b!.body).not.toHaveProperty("headers");
    expect(b!.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");

    r = await pass();
    expect(r.publication?.state).toBe("submitted");
    b!.status = "sent";
    r = await pass();
    expect(r.publication?.state).toBe("sent");
    // The late subscriber reaches the provider only after the publication closed.
    expect(resend.contacts.has("late@example.net")).toBe(false);
    await pass();
    expect(resend.contacts.has("late@example.net")).toBe(true);
    expect(resend.calls.filter((c) => c.endsWith("/send"))).toHaveLength(1);
    expect(h.sent).toEqual([]);
  });

  it("holds an ambiguous send for review instead of replaying it", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    resend.setFault((method, path) =>
      method === "POST" && path.endsWith("/send") ? new Response("", { status: 502 }) : undefined,
    );
    let r = await pass();
    expect(r.publication?.state).toBe("submit-pending");
    resend.setFault(undefined);
    r = await pass();
    // The broadcast is still a draft: that proves nothing, so it is held, never re-sent.
    expect(r.publication).toMatchObject({ state: "held" });
    await pass();
    expect(resend.calls.filter((c) => c.endsWith("/send"))).toHaveLength(1);
    const L = ledgerOf(h.env, "ana");
    expect((await L("heldOps")).map((o) => [o.kind, o.state])).toEqual([["send", "held"]]);
    expect((await L("health")).heldOps).toBe(1);
  });

  it("reconciles an ambiguous send the provider actually accepted", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    resend.setFault((method, path) => {
      if (method === "POST" && path.endsWith("/send")) {
        for (const b of resend.broadcasts.values()) b.status = "queued";

        return new Response("", { status: 504 });
      }

      return undefined;
    });
    await pass();
    resend.setFault(undefined);
    const r = await pass();
    expect(r.publication?.state).toBe("submitted");
    expect(resend.calls.filter((c) => c.endsWith("/send"))).toHaveLength(1);
  });

  it("cancels a submitted broadcast and reports coverage", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    await pass();
    await ledgerOf(h.env, "ana")("requestCancel", `pub_${postId}_r1`);
    const r = await pass();
    expect(r.publication?.state).toBe("cancelled");
    const p = await ledgerOf(h.env, "ana")("publication", `pub_${postId}_r1`);
    expect(p?.cancel).toEqual({ _tag: "Confirmed", coverage: "complete" });
  });

  it("authenticates, persists and applies provider events once, bound to the account", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    await pass();
    const [b] = [...resend.broadcasts.values()];

    const complaint = JSON.stringify({
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: { broadcast_id: b!.id, email_id: "em_1", to: ["a@example.net"] },
    });

    expect((await postWebhook(h, { "svix-id": "msg_1" }, complaint)).status).toBe(401);
    const forged = await signWebhook("msg_1", complaint);
    expect(
      (await postWebhook(h, { ...forged, "svix-signature": "v1,AAAA" }, complaint)).status,
    ).toBe(401);
    const stale = await signWebhook("msg_1", complaint, Date.now() - 10 * 60_000);
    expect((await postWebhook(h, stale, complaint)).status).toBe(401);

    const headers = await signWebhook("msg_1", complaint);
    expect((await postWebhook(h, headers, complaint)).status).toBe(200);
    expect((await postWebhook(h, headers, complaint)).status).toBe(200);

    const rows = await h.d1
      .prepare("SELECT state, kind FROM newsletter_events WHERE event_id = 'msg_1'")
      .all<{ state: string; kind: string }>();

    expect(rows.results).toEqual([{ state: "applied", kind: "complaint" }]);
    expect(store.subscriberStatus("a@example.net")).toBe("suppressed");
    // The creator-scoped complaint never entered the platform-wide suppression list.
    expect(
      await h.d1.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{ n: number }>(),
    ).toEqual({ n: 0 });

    // Account-wide contact unsubscribe → provider-scope restriction for every creator with the contact.
    const unsub = JSON.stringify({
      type: "contact.updated",
      created_at: new Date().toISOString(),
      data: { email: "b@example.net", unsubscribed: true },
    });

    await postWebhook(h, await signWebhook("msg_2", unsub), unsub);
    expect(store.newsletter.restrictions("b@example.net")).toEqual([
      { kind: "provider-unsubscribe", scope: "provider", reason: "provider contact.updated" },
    ]);

    // Events for broadcasts or contacts Bye does not know are retained, never applied elsewhere.
    const foreign = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { broadcast_id: "bc_someone_else", to: ["x@example.net"] },
    });

    await postWebhook(h, await signWebhook("msg_3", foreign), foreign);
    expect(
      await h.d1
        .prepare("SELECT state FROM newsletter_events WHERE event_id = 'msg_3'")
        .first<{ state: string }>(),
    ).toEqual({ state: "unmapped" });
  });

  it("a Bye unsubscribe commits before the response and reaches the provider as a topic opt-out", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    await store.unsubscribe("a@example.net", await store.unsubscribeToken("a@example.net"));
    expect(store.newsletter.eligible("a@example.net")).toBe(false);
    await pass();
    expect([...resend.contacts.get("a@example.net")!.topics.values()]).toEqual(["opt_out"]);
    expect(resend.contacts.get("a@example.net")!.unsubscribed).toBe(false);
  });

  it("disabling dispatch keeps removals and reconciliation running", async () => {
    configure(h);
    await approveNewsletter(h.env, "ana", postId, 1);
    await pass();
    await pass();
    configure(h, "");
    await store.unsubscribe("b@example.net", await store.unsubscribeToken("b@example.net"));
    const [b] = [...resend.broadcasts.values()];
    b!.status = "sent";
    const r = await pass();
    expect(r.publication?.state).toBe("sent");
    expect([...resend.contacts.get("b@example.net")!.topics.values()]).toEqual(["opt_out"]);
  });
  it("a runtime-configured provider keeps the same ledger, hold and reconciliation semantics", async () => {
    await configureRuntime(h);
    const p = await approveNewsletter(h.env, "ana", postId, 1);
    expect(p).toMatchObject({ state: "approved", account: "resend_runtime" });
    await pass();
    resend.setFault((method, path) =>
      method === "POST" && path.endsWith("/send") ? new Response("", { status: 502 }) : undefined,
    );
    expect((await pass()).publication?.state).toBe("submit-pending");
    resend.setFault(undefined);
    expect((await pass()).publication).toMatchObject({ state: "held" });
    expect(resend.calls.filter((c) => c.endsWith("/send"))).toHaveLength(1);

    // Events verify with the runtime secret and bind to the runtime account.
    const ev = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {},
    });

    expect((await postWebhook(h, await signWebhook("rt_1", ev), ev)).status).toBe(200);
    expect(
      await h.d1
        .prepare("SELECT account FROM newsletter_events WHERE event_id = 'rt_1'")
        .first<{ account: string }>(),
    ).toEqual({ account: "resend_runtime" });
  });
});
