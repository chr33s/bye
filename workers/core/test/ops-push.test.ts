import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import {
  deliverNotification,
  type NotificationRequest,
  type PushDeviceRow,
  RetryablePushFailure,
} from "../src/push.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness } from "./harness.ts";

// Push delivery boundary (E23, C02/C10): device registration routes, at-most-once per device,
// dead registrations disabled, transient failures retried only for the devices that missed it.

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

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

const call = async (
  h: Harness,
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
) => {
  const r = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === "GET"
          ? {}
          : { origin: h.env.APP_ORIGIN, "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
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
    const outcomes: Record<string, Array<"Delivered" | "Gone" | "Retry">> = {
      "1": ["Delivered"],
      "2": ["Gone"],
      "3": ["Retry", "Delivered"],
    };
    const sends: Array<string> = [];
    const sender = async (device: PushDeviceRow) => {
      const n = device.endpoint.split("/").pop()!;
      sends.push(n);
      const tag = outcomes[n]!.shift() ?? "Delivered";
      return tag === "Retry"
        ? { _tag: "Retry" as const, status: 503 }
        : tag === "Gone"
          ? { _tag: "Gone" as const, status: 410 }
          : { _tag: "Delivered" as const, status: 201 };
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
});
