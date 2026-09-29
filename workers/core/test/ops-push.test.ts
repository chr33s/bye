import { Match } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import {
  deliverNotification,
  appLink,
  makePushSender,
  opaqueTag,
  type NotificationRequest,
  type PushDeviceRow,
  RetryablePushFailure,
} from "../src/push.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness, executionContext } from "./harness.ts";

// Push delivery boundary (E23, C02/C10): device registration routes, at-most-once per device,
// dead registrations disabled, transient failures retried only for the devices that missed it.

const ctx = executionContext;

const signup = async (h: Harness, address: string) => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: "ana" },
  );

  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", true);

  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async <BodyValue>(
  h: Harness,
  cookie: string | null,
  method: string,
  path: string,
  body?: BodyValue,
) => {
  const headers = new Headers();

  if (cookie) headers.set("cookie", cookie);

  if (method !== "GET") {
    headers.set("origin", h.env.APP_ORIGIN);
    headers.set("content-type", "application/json");
  }

  const r = await handleFetch(
    new Request(
      `${h.env.APP_ORIGIN}${path}`,
      body !== undefined ? { method, headers, body: JSON.stringify(body) } : { method, headers },
    ),
    h.env,
    ctx,
  );

  const text = await r.text();

  return { status: r.status, body: text ? JSON.parse(text) : null };
};

const webpush = (n: number) => ({
  kind: "webpush",
  endpoint: `https://push.example.net/sub/${n}`,
  keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) },
  label: `browser ${n}`,
});

const note = (dedupeKey: string, userId: string): NotificationRequest => ({
  userId,
  kind: "mail.delivery",
  title: "New mail",
  body: "Lunch?",
  url: "https://app.bye.test/#/t/1",
  resource: "thr_1",
  dedupeKey,
});

describe("push notifications", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[E23] registers, lists and removes devices; rejects private endpoints and bad keys", async () => {
    const ana = await signup(h, "ana@bye.test");
    expect((await call(h, null, "POST", "/v1/push/subscriptions", webpush(1))).status).toBe(401);
    const created = await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    expect(created.status).toBe(201);
    // Re-registering the same endpoint is an upsert, not a second device.
    expect((await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1))).body.id).toBe(
      created.body.id,
    );
    expect(
      (
        await call(h, ana.cookie, "POST", "/v1/push/subscriptions", {
          ...webpush(2),
          endpoint: "https://127.0.0.1/x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, ana.cookie, "POST", "/v1/push/subscriptions", {
          ...webpush(3),
          endpoint: "http://push.example.net/x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, ana.cookie, "POST", "/v1/push/subscriptions", {
          ...webpush(4),
          keys: { p256dh: "short", auth: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, ana.cookie, "POST", "/v1/push/subscriptions", {
          kind: "apns",
          endpoint: "ab".repeat(32),
        })
      ).status,
    ).toBe(201);
    // The body is decoded with its contract: an unknown kind or a non-string endpoint never reaches validation.
    expect(
      (await call(h, ana.cookie, "POST", "/v1/push/subscriptions", { kind: "sms", endpoint: "x" }))
        .status,
    ).toBe(400);
    expect(
      (await call(h, ana.cookie, "POST", "/v1/push/subscriptions", { kind: "apns", endpoint: 42 }))
        .status,
    ).toBe(400);
    const list = await call(h, ana.cookie, "GET", "/v1/push/subscriptions");
    expect(list.body.items.map((d: { kind: string }) => d.kind).sort()).toEqual([
      "apns",
      "webpush",
    ]);
    expect(JSON.stringify(list.body)).not.toContain("push.example.net"); // endpoints are capabilities; never echoed
    expect(
      (await call(h, ana.cookie, "DELETE", `/v1/push/subscriptions/${created.body.id}`)).status,
    ).toBe(200);
    expect(
      (await call(h, ana.cookie, "DELETE", `/v1/push/subscriptions/${created.body.id}`)).status,
    ).toBe(404);
  });

  it("[E23] exposes the VAPID public key only when configured", async () => {
    expect((await call(h, null, "GET", "/v1/push/vapid-key")).status).toBe(404);
    (h.env as { VAPID_PUBLIC_KEY: string }).VAPID_PUBLIC_KEY = "BPub";
    expect((await call(h, null, "GET", "/v1/push/vapid-key")).body).toEqual({ publicKey: "BPub" });
  });

  it("[C10] delivers at most once per device, disables gone devices, retries only the transient ones", async () => {
    const ana = await signup(h, "ana@bye.test");

    for (const n of [1, 2, 3])
      await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(n));

    const outcomes = new Map<string, Array<"Delivered" | "Gone" | "Retry">>([
      ["1", ["Delivered"]],
      ["2", ["Gone"]],
      ["3", ["Retry", "Delivered"]],
    ]);

    const sends: Array<string> = [];

    const sender = async (device: PushDeviceRow) => {
      const n = device.endpoint.split("/").pop()!;
      sends.push(n);
      const tag = outcomes.get(n)!.shift() ?? "Delivered";

      return Match.value(tag).pipe(
        Match.when("Retry", () => ({ _tag: "Retry" as const, status: 503 })),
        Match.when("Gone", () => ({ _tag: "Gone" as const, status: 410 })),
        Match.orElse(() => ({ _tag: "Delivered" as const, status: 201 })),
      );
    };

    await expect(
      deliverNotification(h.env, note("evt-1", ana.userId), sender as never),
    ).rejects.toBeInstanceOf(RetryablePushFailure);
    expect(sends.sort()).toEqual(["1", "2", "3"]);
    sends.length = 0;
    // Queue retry: only device 3 (released) is attempted; device 2 is disabled; device 1 deduped.
    expect(await deliverNotification(h.env, note("evt-1", ana.userId), sender as never)).toEqual({
      delivered: 1,
    });
    expect(sends).toEqual(["3"]);
    const list = await call(h, ana.cookie, "GET", "/v1/push/subscriptions");
    expect(list.body.items.filter((d: { enabled: boolean }) => !d.enabled)).toHaveLength(1);
    sends.length = 0;
    await deliverNotification(h.env, note("evt-2", ana.userId), sender as never);
    expect(sends.sort()).toEqual(["1", "3"]);
  });

  it("[C10] unconfigured transports leave the device untouched and do not consume the dedupe slot", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    expect(await deliverNotification(h.env, note("evt-3", ana.userId))).toEqual({ delivered: 0 });

    const delivered = await h.env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS n FROM push_deliveries",
    ).first<{ n: number }>();

    expect(delivered?.n).toBe(0);
  });

  it("[E23] only the account holder's own session registers or removes push devices (never agent tokens)", async () => {
    const ana = await signup(h, "ana@bye.test");

    const agent = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).createApiToken(ana.userId, { kind: "agent", label: "bot" });

    const bearer = async <BodyValue>(method: string, path: string, body?: BodyValue) => {
      const headers = {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
      };

      return (
        await handleFetch(
          new Request(
            `${h.env.APP_ORIGIN}${path}`,
            body !== undefined
              ? { method, headers, body: JSON.stringify(body) }
              : { method, headers },
          ),
          h.env,
          ctx,
        )
      ).status;
    };

    expect(await bearer("POST", "/v1/push/subscriptions", webpush(9))).toBe(403);

    const n = await h.env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM push_devices").first<{
      n: number;
    }>();

    expect(n?.n).toBe(0);
    const own = await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    expect(own.status).toBe(201);
    expect(await bearer("DELETE", `/v1/push/subscriptions/${own.body.id}`)).toBe(403);
    expect(
      (await call(h, ana.cookie, "DELETE", `/v1/push/subscriptions/${own.body.id}`)).status,
    ).toBe(200);
  });

  it("[E23] Web Push sends resolve the endpoint host first and refuse non-public answers", async () => {
    // RFC 8291 Appendix A keys: a valid VAPID pair and user-agent subscription.
    Object.assign(h.env, {
      VAPID_PUBLIC_KEY:
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    });

    const device: PushDeviceRow = {
      id: "pd_1",
      user_id: "usr_1",
      kind: "webpush",
      endpoint: "https://rebind.example.net/sub/1",
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
      label: "",
      created_at: 0,
      last_success_at: null,
      apns_sandbox: 0,
      session_id: "ses_1",
    };

    const doh = (ip: string) => async (url: string) =>
      new Response(
        JSON.stringify({
          Status: 0,
          Answer: url.includes("type=A&") || url.endsWith("type=A") ? [{ type: 1, data: ip }] : [],
        }),
      );

    const sent: Array<RequestInit | undefined> = [];

    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(init);

      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const internal = makePushSender(h.env, fetchFn, doh("10.0.0.1"));
    expect(await internal(device, note("evt-r", "usr_1"))).toEqual({ _tag: "Rejected", status: 0 });
    expect(sent).toHaveLength(0);
    const failing = makePushSender(h.env, fetchFn, async () => new Response("", { status: 502 }));
    expect((await failing(device, note("evt-r", "usr_1")))?._tag).toBe("Retry");
    expect(sent).toHaveLength(0);
    const pub = makePushSender(h.env, fetchFn, doh("93.184.216.34"));
    expect((await pub(device, note("evt-r", "usr_1")))?._tag).toBe("Delivered");
    expect(sent[0]?.redirect).toBe("manual");
  });
  it("[E23] Web Push links open on this instance's origin, bye:// deep links included", () => {
    const origin = "https://app.bye.test";
    expect(appLink(origin, `${origin}/#/thread/thr_1`)).toBe(`${origin}/#/thread/thr_1`);
    expect(appLink(origin, "bye://calendar/event/evt_1?occurrence=k")).toBe(
      `${origin}/#/calendar/event/evt_1?occurrence=k`,
    );
    expect(appLink(origin, "https://evil.test/#/x")).toBe(`${origin}/`);
    expect(appLink(origin, "")).toBe(`${origin}/`);
  });

  it("[P1.7] APNs and FCM see the kind of event only; sandbox tokens go to the sandbox host", async () => {
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;

    const rsa = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign"],
    )) as CryptoKeyPair;

    const pem = async (key: CryptoKey) =>
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
        (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer,
      ).toString("base64")}\n-----END PRIVATE KEY-----`;

    Object.assign(h.env, {
      APNS_KEY_P8: await pem(ec.privateKey),
      APNS_KEY_ID: "KEY1",
      APNS_TEAM_ID: "TEAM1",
      APNS_TOPIC: "email.bye.app",
      FCM_SERVICE_ACCOUNT: JSON.stringify({
        project_id: "bye",
        client_email: "push@bye.iam",
        private_key: await pem(rsa.privateKey),
      }),
    });

    const sent: Array<{ url: string; body: string; collapse: string | null }> = [];

    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = new Request(u).url;
      sent.push({
        url,
        body: await new Response(init?.body ?? null).text(),
        collapse: new Headers(init?.headers).get("apns-collapse-id"),
      });

      return url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response(null, { status: 200 });
    }) as typeof fetch;

    const send = makePushSender(h.env, fetchFn);

    const device = (kind: "apns" | "fcm", sandbox: number | null): PushDeviceRow => ({
      id: `pd_${kind}${sandbox}`,
      user_id: "usr_1",
      kind,
      endpoint: kind === "apns" ? "ab".repeat(32) : "f".repeat(40),
      p256dh: null,
      auth: null,
      label: "",
      created_at: 0,
      last_success_at: null,
      apns_sandbox: sandbox,
      session_id: "ses_1",
    });

    const secret = { ...note("evt-p", "usr_1"), title: "boss@corp.example", body: "Layoffs" };
    expect((await send(device("apns", 1), secret))?._tag).toBe("Delivered");
    expect((await send(device("apns", 0), secret))?._tag).toBe("Delivered");
    expect((await send(device("fcm", 0), secret))?._tag).toBe("Delivered");
    // Environment not given (older clients, older rows): the old rule, `.test` → sandbox.
    expect((await send(device("apns", null), secret))?._tag).toBe("Delivered");
    const pushes = sent.filter((r) => !r.url.includes("oauth2"));
    expect(pushes.map((r) => new URL(r.url).host)).toEqual([
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
      "fcm.googleapis.com",
      "api.sandbox.push.apple.com",
    ]);

    // Notifications about one thread still replace each other, through a tag that hides the thread.
    const tag = await opaqueTag(h.env.APP_ORIGIN, "thr_1");
    expect(tag).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(tag).not.toBe(await opaqueTag(h.env.APP_ORIGIN, "thr_2"));
    expect(pushes[0]!.collapse).toBe(await opaqueTag(h.env.APP_ORIGIN, note("x", "u").resource));

    for (const r of pushes) {
      expect(r.body).not.toContain("boss@corp.example");
      expect(r.body).not.toContain("Layoffs");
      // Nor which conversation: the link is the app root.
      expect(r.body).not.toContain("thr_1");
      expect(r.body).not.toContain("#/");
      expect(r.body).toContain("New mail");
    }
  });

  it("[P1.7] ended sessions' registrations are pruned when listed, freeing the device limit", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    await h.env.DIRECTORY.prepare("UPDATE sessions SET expires_at = 0").run();

    const again = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(ana.userId, "test", true);

    const cookie = `__Host-session=${again.token}`;
    expect((await call(h, cookie, "GET", "/v1/push/subscriptions")).body.items).toEqual([]);
  });

  it("[P1.7] a browser removes its registration by endpoint; re-registering keeps a known APNs environment", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(2));

    const removed = await call(h, ana.cookie, "POST", "/v1/push/subscriptions/unregister", {
      endpoint: webpush(1).endpoint,
    });

    expect(removed.status).toBe(200);
    const left = await call(h, ana.cookie, "GET", "/v1/push/subscriptions");
    expect(left.body.items.map((d: { label: string }) => d.label)).toEqual(["browser 2"]);
    // Unknown endpoints are fine (already gone).
    expect(
      (
        await call(h, ana.cookie, "POST", "/v1/push/subscriptions/unregister", {
          endpoint: "https://push.example.net/sub/none",
        })
      ).status,
    ).toBe(200);

    const apns = { kind: "apns", endpoint: "cd".repeat(32) };
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", { ...apns, sandbox: true });
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", apns);

    const row = await h.env.DIRECTORY.prepare(
      "SELECT apns_sandbox FROM push_devices WHERE kind = 'apns'",
    ).first<{ apns_sandbox: number | null }>();

    expect(row?.apns_sandbox).toBe(1);
  });

  it("[P1.7] registrations of expired sessions get nothing", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    const sends: Array<string> = [];

    const sender = async (device: PushDeviceRow) => {
      sends.push(device.id);

      return { _tag: "Delivered" as const };
    };

    expect(await deliverNotification(h.env, note("evt-live", ana.userId), sender)).toEqual({
      delivered: 1,
    });
    await h.env.DIRECTORY.prepare("UPDATE sessions SET expires_at = 0").run();
    expect(await deliverNotification(h.env, note("evt-dead", ana.userId), sender)).toEqual({
      delivered: 0,
    });
    expect(sends).toHaveLength(1);
  });

  it("[P1.7] APNs registrations record their environment only when the client says", async () => {
    const ana = await signup(h, "ana@bye.test");
    const apns = (n: number) => ({ kind: "apns", endpoint: `${n}`.repeat(64) });
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", { ...apns(1), sandbox: true });
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", { ...apns(2), sandbox: false });
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", apns(3));

    const rows = await h.env.DIRECTORY.prepare(
      "SELECT apns_sandbox FROM push_devices ORDER BY endpoint",
    ).all<{ apns_sandbox: number | null }>();

    expect(rows.results.map((r) => r.apns_sandbox)).toEqual([1, 0, null]);
  });

  it("[P1.7] a payload the push service calls too large never disables the device", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    const tooLarge = async () => ({ _tag: "Dropped" as const, status: 413 });

    for (let i = 0; i < 8; i++)
      await deliverNotification(h.env, note(`evt-big-${i}`, ana.userId), tooLarge);

    const row = await h.env.DIRECTORY.prepare("SELECT enabled, failures FROM push_devices").first<{
      enabled: number;
      failures: number;
    }>();

    expect(row).toEqual({ enabled: 1, failures: 0 });
  });

  it("[P1.7] long senders and subjects are clipped to fit the push gateway", async () => {
    Object.assign(h.env, {
      VAPID_PUBLIC_KEY:
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    });

    const sizes: Array<number> = [];

    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      sizes.push((await new Response(init?.body ?? null).arrayBuffer()).byteLength);

      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const doh = async () =>
      new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }));

    const send = makePushSender(h.env, fetchFn, doh);

    const device: PushDeviceRow = {
      id: "pd_1",
      user_id: "usr_1",
      kind: "webpush",
      endpoint: "https://push.example.net/sub/1",
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
      label: "",
      created_at: 0,
      last_success_at: null,
      apns_sandbox: 0,
      session_id: "ses_1",
    };

    // Four-byte characters: the worst case for UTF-8 size.
    const huge = { ...note("evt-huge", "usr_1"), title: "𝔸".repeat(3000), body: "𝔹".repeat(3000) };
    expect((await send(device, huge))?._tag).toBe("Delivered");
    expect(sizes[0]).toBeLessThanOrEqual(2800);
  });

  it("[P1.7] a registration follows its credential: sign-out removes it, rotation moves it", async () => {
    const ana = await signup(h, "ana@bye.test");

    const other = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(ana.userId, "second browser", true);

    const second = `__Host-session=${other.token}`;
    await call(h, ana.cookie, "POST", "/v1/push/subscriptions", webpush(1));
    await call(h, second, "POST", "/v1/push/subscriptions", webpush(2));

    const sessions = async () =>
      (
        await h.env.DIRECTORY.prepare(
          "SELECT endpoint, session_id FROM push_devices ORDER BY endpoint",
        ).all<{ endpoint: string; session_id: string | null }>()
      ).results;

    expect((await sessions()).map((r) => r.session_id)).toEqual([
      expect.any(String),
      other.session.id,
    ]);

    // Rotation moves them in the same transaction that revokes the old session.
    const rotated = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).rotateSession(other.token);

    expect((await sessions())[1]?.session_id).toBe(rotated.session.id);

    const logout = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/auth/logout`, {
        method: "POST",
        headers: { cookie: ana.cookie, origin: h.env.APP_ORIGIN },
      }),
      h.env,
      ctx,
    );

    expect(logout.status).toBe(200);
    expect((await sessions()).map((r) => r.endpoint)).toEqual(["https://push.example.net/sub/2"]);
  });
});
