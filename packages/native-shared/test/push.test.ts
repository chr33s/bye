import { describe, expect, it } from "vitest";
import { ByeClient, type FetchLike } from "../src/client.ts";
import type { KeyValueStore } from "../src/drafts.ts";
import {
  type DevicePushToken,
  notificationTarget,
  PUSH_GATEWAY_URL,
  PushGatewayError,
  pushEnabled,
  registerDevicePush,
  unregisterDevicePush,
} from "../src/push.ts";
import { testInstance } from "./fixtures.ts";

// Native push registration (E23, P1.7): gateway endpoint first, then an ordinary Web Push
// registration with the instance; idempotent per token and keys; taps resolve to saved servers only.

const memory = (): KeyValueStore & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>();

  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

const TOKEN: DevicePushToken = {
  platform: "apns",
  token: "ab".repeat(32),
  sandbox: true,
  p256dh: `B${"A".repeat(86)}`,
  auth: "A".repeat(22),
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
}

const setup = (options: { vapid?: number } = {}) => {
  const calls: Array<Call> = [];
  // Server-side registrations: id → enabled.
  const server = new Map<string, boolean>();
  const state = { vapidKey: "BInstanceKey" };
  let ids = 0;

  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body as string | undefined,
      headers: init.headers,
    });

    const reply = (status: number, body: Readonly<Record<string, string>>) => ({
      status,
      text: async () => JSON.stringify(body),
    });

    if (url.endsWith("/v1/push/vapid-key"))
      return options.vapid === 404
        ? reply(404, { error: "not configured" })
        : reply(200, { publicKey: state.vapidKey });

    if (url === `${PUSH_GATEWAY_URL}/v1/register`)
      return reply(201, { endpoint: `${PUSH_GATEWAY_URL}/v1/relay/sealed${calls.length}` });

    if (url.endsWith("/v1/push/subscriptions") && init.method === "POST") {
      const id = `pd_${++ids}`;
      server.set(id, true);

      return reply(201, { id });
    }

    if (url.endsWith("/v1/push/subscriptions") && init.method === "GET")
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ items: [...server].map(([id, enabled]) => ({ id, enabled })) }),
      };

    const removed = /\/v1\/push\/subscriptions\/(pd_\d+)$/.exec(url);

    if (removed && init.method === "DELETE")
      return server.delete(removed[1]!)
        ? reply(200, { ok: "true" })
        : reply(404, { error: "not found" });

    return reply(200, { ok: "true" });
  };

  const client = new ByeClient({ origin: "https://app.bye.test", token: "tok", fetch });
  const store = memory();

  return {
    calls,
    server,
    state,
    client,
    store,
    deps: { client, store, gatewayFetch: fetch, label: "iPhone app" },
  };
};

describe("native push registration", () => {
  it("[P1.7] registers through the gateway without instance credentials, then with the instance", async () => {
    const h = setup();
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Registered", id: "pd_1" });
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://app.bye.test/v1/push/vapid-key",
      `POST ${PUSH_GATEWAY_URL}/v1/register`,
      "POST https://app.bye.test/v1/push/subscriptions",
    ]);

    const gateway = h.calls[1]!;
    expect(gateway.headers.authorization).toBeUndefined();
    expect(JSON.parse(gateway.body!)).toEqual({
      platform: "apns",
      token: TOKEN.token,
      sandbox: true,
      vapidKey: "BInstanceKey",
    });

    expect(JSON.parse(h.calls[2]!.body!)).toEqual({
      kind: "webpush",
      endpoint: `${PUSH_GATEWAY_URL}/v1/relay/sealed2`,
      keys: { p256dh: TOKEN.p256dh, auth: TOKEN.auth },
      label: "iPhone app",
    });

    expect(await pushEnabled(h.store)).toBe(true);
  });

  it("[P1.7] is idempotent per token; a rotated token replaces the old registration", async () => {
    const h = setup();
    await registerDevicePush(h.deps, TOKEN);
    h.calls.length = 0;
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Unchanged", id: "pd_1" });
    // Checked with the instance, never re-registered with the gateway.
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://app.bye.test/v1/push/vapid-key",
      "GET https://app.bye.test/v1/push/subscriptions",
    ]);

    expect(await registerDevicePush(h.deps, { ...TOKEN, token: "cd".repeat(32) })).toEqual({
      _tag: "Registered",
      id: "pd_2",
    });

    expect(h.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://app.bye.test/v1/push/subscriptions/pd_1",
    });
  });

  it("[P1.7] reports servers without push, and gateway failures", async () => {
    const off = setup({ vapid: 404 });
    expect(await registerDevicePush(off.deps, TOKEN)).toEqual({ _tag: "Unsupported" });
    expect(await pushEnabled(off.store)).toBe(false);

    const h = setup();

    const failing: FetchLike = async (url, init) =>
      url.startsWith(PUSH_GATEWAY_URL)
        ? { status: 429, text: async () => "" }
        : h.deps.gatewayFetch(url, init);

    await expect(
      registerDevicePush({ ...h.deps, gatewayFetch: failing }, TOKEN),
    ).rejects.toBeInstanceOf(PushGatewayError);
  });

  it("[P1.7] registers again when the server dropped it or the instance key changed", async () => {
    const h = setup();
    await registerDevicePush(h.deps, TOKEN);
    h.server.set("pd_1", false); // disabled by the server (push service answered gone)
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Registered", id: "pd_2" });
    h.server.delete("pd_2"); // removed from another device's settings
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Registered", id: "pd_3" });
    h.state.vapidKey = "BRedeployedKey";
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Registered", id: "pd_4" });
    expect(await registerDevicePush(h.deps, TOKEN)).toEqual({ _tag: "Unchanged", id: "pd_4" });
  });

  it("[P1.7] concurrent refreshes register once", async () => {
    const h = setup();

    const results = await Promise.all([
      registerDevicePush(h.deps, TOKEN),
      registerDevicePush(h.deps, TOKEN),
      registerDevicePush(h.deps, TOKEN),
    ]);

    expect(results.map((r) => r._tag)).toEqual(["Registered", "Unchanged", "Unchanged"]);
    expect([...h.server.keys()]).toEqual(["pd_1"]);
  });

  it("[P1.7] turning it off works even when the server already removed it", async () => {
    const h = setup();
    await registerDevicePush(h.deps, TOKEN);
    h.server.delete("pd_1");
    await unregisterDevicePush(h.client, h.store);
    expect(await pushEnabled(h.store)).toBe(false);
    expect(h.store.data.size).toBe(0);
  });

  it("[P1.7] turning it off removes the registration and the switch", async () => {
    const h = setup();
    await registerDevicePush(h.deps, TOKEN);
    await unregisterDevicePush(h.client, h.store);
    expect(h.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://app.bye.test/v1/push/subscriptions/pd_1",
    });
    expect(await pushEnabled(h.store)).toBe(false);
    expect(h.store.data.size).toBe(0);
  });

  it("[X01] a tap opens a route on a saved server only", () => {
    const saved = [testInstance("https://app.bye.test"), testInstance("https://mail.example.org")];
    expect(notificationTarget("https://mail.example.org/#/thread/thr_1", saved)).toEqual({
      instanceKey: saved[1]!.key,
      route: "#/thread/thr_1",
    });
    expect(notificationTarget("https://app.bye.test/", saved)).toEqual({
      instanceKey: saved[0]!.key,
      route: "#/",
    });
    expect(notificationTarget("https://unknown.example/#/thread/thr_1", saved)).toBeNull();
    expect(notificationTarget("http://app.bye.test/#/thread/thr_1", saved)).toBeNull();
    expect(notificationTarget("not a url", saved)).toBeNull();
  });
});
