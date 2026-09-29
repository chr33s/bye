import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "@bye/domain";
import {
  decryptWebPush,
  type PushFetch,
  resetPushTokenCaches,
  sendWebPush,
  type TokenFetch,
} from "@bye/platform-cloudflare";
import {
  type GatewayEnv,
  handleGateway,
  MAX_RELAY_BODY,
  type RelayDeps,
  relayStatus,
} from "../src/index.ts";

// Native push gateway (P1.7): relays an instance's Web Push to APNs/FCM without reading it, only
// for the instance the device registered with.

const NOW = Date.UTC(2026, 8, 30, 12);

// RFC 8291 Appendix A application-server keys stand in for an instance's VAPID pair.
const INSTANCE = {
  publicKey:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  subject: "mailto:ops@bye.test",
};

const OTHER_INSTANCE_KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

const pem = async (key: CryptoKey) =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
    (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer,
  ).toString("base64")}\n-----END PRIVATE KEY-----`;

const makeEnv = async (): Promise<GatewayEnv> => {
  const apns = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
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

  return {
    GATEWAY_ORIGIN: "https://push.bye.test",
    RELAY_SEAL_KEY: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    APNS_KEY_P8: await pem(apns.privateKey),
    APNS_KEY_ID: "KEY1",
    APNS_TEAM_ID: "TEAM1",
    APNS_TOPIC: "email.bye.app",
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "bye-app",
      client_email: "push@bye-app.iam",
      private_key: await pem(rsa.privateKey),
    }),
  };
};

/** A device's Web Push keys, as the native shells generate them. */
const deviceKeys = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;

  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );

  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;

  return {
    publicKey,
    privateKey: fromBase64Url(jwk.d!),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
};

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const provider = (status = 200, errorBody = "") => {
  const sent: Array<Sent> = [];

  const fetchFn = (async (
    url: string,
    init: { headers: Record<string, string>; body?: string },
  ) => {
    sent.push({ url, headers: init.headers, body: String(init.body ?? "") });

    return url.includes("oauth2")
      ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
      : new Response(errorBody || null, { status });
  }) as PushFetch & TokenFetch;

  return { sent, deps: { fetch: fetchFn, now: () => NOW } satisfies RelayDeps };
};

const register = async (env: GatewayEnv, body: Readonly<Record<string, string | boolean>>) => {
  const r = await handleGateway(
    new Request(`${env.GATEWAY_ORIGIN}/v1/register`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env,
  );

  return { status: r.status, body: (await r.json()) as { endpoint?: string } };
};

/** The instance side: its real Web Push sender, with the network routed into the gateway. */
const instancePush = (env: GatewayEnv, deps: RelayDeps, vapid = INSTANCE) => {
  const statuses: Array<number> = [];

  const toGateway: PushFetch = async (url, init) => {
    const r = await handleGateway(
      new Request(url, { method: init.method, headers: init.headers, body: init.body ?? null }),
      env,
      deps,
    );

    statuses.push(r.status);

    return r;
  };

  return {
    statuses,
    send: (endpoint: string, keys: Awaited<ReturnType<typeof deviceKeys>>, payload: string) =>
      sendWebPush(
        toGateway,
        { endpoint, p256dh: toBase64Url(keys.publicKey), auth: toBase64Url(keys.auth) },
        { note: payload },
        vapid,
        { topic: "thr_1", urgency: "high", ttlSeconds: 600, now: NOW },
      ),
  };
};

describe("push gateway", () => {
  it("[P1.7] relays an instance's encrypted push to APNs unread; the device decrypts it", async () => {
    resetPushTokenCaches();
    const env = await makeEnv();
    const keys = await deviceKeys();
    const { sent, deps } = provider();

    const reg = await register(env, {
      platform: "apns",
      token: "ab".repeat(32),
      sandbox: true,
      vapidKey: INSTANCE.publicKey,
    });

    expect(reg.status).toBe(201);
    const endpoint = reg.body.endpoint!;
    expect(endpoint.startsWith("https://push.bye.test/v1/relay/")).toBe(true);
    // The endpoint carries no readable device token.
    expect(endpoint).not.toContain("abab");

    const push = instancePush(env, deps);
    expect(await push.send(endpoint, keys, "Lunch? from ana@bye.test")).toEqual({
      _tag: "Delivered",
    });

    const apns = sent.find((s) => s.url.includes("push.apple.com"))!;
    expect(new URL(apns.url).host).toBe("api.sandbox.push.apple.com");
    expect(apns.url.endsWith(`/3/device/${"ab".repeat(32)}`)).toBe(true);
    expect(apns.headers["apns-topic"]).toBe("email.bye.app");
    expect(apns.headers["apns-collapse-id"]).toBe("thr_1");
    expect(apns.headers["apns-priority"]).toBe("10");
    expect(apns.headers["apns-expiration"]).toBe(String(NOW / 1000 + 600));
    // Apple sees ciphertext and a generic fallback only.
    expect(apns.body).not.toContain("Lunch");
    expect(apns.body).not.toContain("ana@bye.test");

    const payload = JSON.parse(apns.body) as {
      aps: { "mutable-content": number };
      bye: { v: number; p: string };
    };

    expect(payload.aps["mutable-content"]).toBe(1);
    const plain = await decryptWebPush(keys, fromBase64Url(payload.bye.p));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({
      note: "Lunch? from ana@bye.test",
    });
  });

  it("[P1.7] relays to FCM as a data-only message", async () => {
    resetPushTokenCaches();
    const env = await makeEnv();
    const keys = await deviceKeys();
    const { sent, deps } = provider();
    const token = `fcm:${"x".repeat(60)}`;

    const reg = await register(env, { platform: "fcm", token, vapidKey: INSTANCE.publicKey });
    expect((await instancePush(env, deps).send(reg.body.endpoint!, keys, "hi"))._tag).toBe(
      "Delivered",
    );

    const fcm = sent.find((s) => s.url.includes("fcm.googleapis.com"))!;
    expect(fcm.url).toContain("/projects/bye-app/messages:send");

    const { message } = JSON.parse(fcm.body) as {
      message: {
        token: string;
        notification?: never;
        data: { p: string };
        android: { priority: string; ttl: string; collapse_key: string };
      };
    };

    expect(message.token).toBe(token);
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual({ priority: "high", ttl: "600s", collapse_key: "thr_1" });
    const plain = await decryptWebPush(keys, fromBase64Url(message.data.p));
    expect(new TextDecoder().decode(plain)).toBe(JSON.stringify({ note: "hi" }));
  });

  it("[P1.7] only the registering instance can push; tampered endpoints are gone", async () => {
    resetPushTokenCaches();
    const env = await makeEnv();
    const keys = await deviceKeys();
    const { sent, deps } = provider();

    const endpoint = (
      await register(env, {
        platform: "apns",
        token: "cd".repeat(32),
        vapidKey: OTHER_INSTANCE_KEY,
      })
    ).body.endpoint!;

    const push = instancePush(env, deps);
    expect((await push.send(endpoint, keys, "x"))._tag).toBe("Rejected");
    expect(push.statuses).toEqual([403]);

    const tampered = `${endpoint.slice(0, -4)}AAAA`;
    expect((await push.send(tampered, keys, "x"))._tag).toBe("Gone");
    expect(sent).toHaveLength(0);

    const noAuth = await handleGateway(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-encoding": "aes128gcm" },
        body: "x",
      }),
      env,
      deps,
    );

    expect(noAuth.status).toBe(401);
  });

  it("[P1.7] maps provider outcomes to push-service statuses and bounds the payload", async () => {
    resetPushTokenCaches();
    const env = await makeEnv();
    const keys = await deviceKeys();

    const endpoint = (
      await register(env, {
        platform: "apns",
        token: "ef".repeat(32),
        vapidKey: INSTANCE.publicKey,
      })
    ).body.endpoint!;

    const gone = provider(410);
    expect((await instancePush(env, gone.deps).send(endpoint, keys, "x"))._tag).toBe("Gone");
    const busy = provider(503);
    expect((await instancePush(env, busy.deps).send(endpoint, keys, "x"))._tag).toBe("Retry");
    const big = provider();
    const tooBig = instancePush(env, big.deps);
    expect((await tooBig.send(endpoint, keys, "x".repeat(MAX_RELAY_BODY)))._tag).toBe("Dropped");
    expect(tooBig.statuses).toEqual([413]);
    expect(big.sent).toHaveLength(0);
  });

  it("[P1.7] the seal key rotates without breaking registered devices", async () => {
    resetPushTokenCaches();
    const env = await makeEnv();
    const keys = await deviceKeys();
    const { deps } = provider();
    const register1 = { platform: "apns", token: "ab".repeat(32), vapidKey: INSTANCE.publicKey };
    const old = (await register(env, register1)).body.endpoint!;
    const next = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const rotated = { ...env, RELAY_SEAL_KEY: `v2:${next},v1:${env.RELAY_SEAL_KEY}` };

    // Endpoints sealed under v1 still relay; new ones are sealed under v2.
    expect((await instancePush(rotated, deps).send(old, keys, "x"))._tag).toBe("Delivered");
    const fresh = (await register(rotated, register1)).body.endpoint!;
    expect(fromBase64Url(fresh.split("/").pop()!)[0]).toBe(2);
    expect((await instancePush(rotated, deps).send(fresh, keys, "x"))._tag).toBe("Delivered");

    // Retiring v1 retires its endpoints: the instance prunes them as gone.
    const retired = { ...env, RELAY_SEAL_KEY: `v2:${next}` };
    expect((await instancePush(retired, deps).send(old, keys, "x"))._tag).toBe("Gone");
  });

  it("[P1.7] only device or message faults answer 4xx; gateway faults never disable devices", async () => {
    expect(relayStatus({ _tag: "Rejected", status: 400 })).toBe(400); // e.g. BadDeviceToken
    expect(relayStatus({ _tag: "Dropped", status: 413 })).toBe(413);
    expect(relayStatus({ _tag: "Retry", status: 403 })).toBe(503); // provider auth: our key
    expect(relayStatus({ _tag: "Gone" })).toBe(410);
    expect(relayStatus({ _tag: "Retry", status: 429 })).toBe(429);

    // A platform the gateway has no credentials for is retryable, not the device's fault.
    const { APNS_KEY_P8: _key, ...env } = await makeEnv();
    const keys = await deviceKeys();

    const endpoint = (
      await register(env, {
        platform: "apns",
        token: "ab".repeat(32),
        vapidKey: INSTANCE.publicKey,
      })
    ).body.endpoint!;

    const push = instancePush(env, provider().deps);
    expect((await push.send(endpoint, keys, "x"))._tag).toBe("Retry");
    expect(push.statuses).toEqual([503]);

    // A wrong bundle ID on the gateway: APNs answers 400 TopicDisallowed for every device.
    resetPushTokenCaches();
    const configured = await makeEnv();

    const own = (
      await register(configured, {
        platform: "apns",
        token: "ab".repeat(32),
        vapidKey: INSTANCE.publicKey,
      })
    ).body.endpoint!;

    const misconfigured = instancePush(
      configured,
      provider(400, JSON.stringify({ reason: "TopicDisallowed" })).deps,
    );

    expect((await misconfigured.send(own, keys, "x"))._tag).toBe("Retry");
    expect(misconfigured.statuses).toEqual([503]);
  });

  it("[P1.7] refuses malformed registrations", async () => {
    const env = await makeEnv();

    for (const body of [
      { platform: "apns", token: "nothex", vapidKey: INSTANCE.publicKey },
      { platform: "fcm", token: "short", vapidKey: INSTANCE.publicKey },
      { platform: "apns", token: "ab".repeat(32), vapidKey: "AAAA" },
      { platform: "wns", token: "ab".repeat(32), vapidKey: INSTANCE.publicKey },
    ])
      expect((await register(env, body)).status).toBe(400);

    const get = await handleGateway(new Request(`${env.GATEWAY_ORIGIN}/v1/register`), env);
    expect(get.status).toBe(405);
  });
});
