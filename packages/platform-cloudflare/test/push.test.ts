import { describe, expect, it } from "vitest";
import {
  apnsProviderToken,
  classifyApns,
  classifyFcm,
  classifyPushStatus,
  decryptWebPush,
  encryptWebPush,
  fcmAccessToken,
  resetPushTokenCaches,
  sendApns,
  sendFcm,
  sendWebPush,
  vapidAuthorization,
  verifyVapid,
} from "@bye/platform-cloudflare";

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64u = (v: string) =>
  Uint8Array.from(
    atob(
      v
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(v.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );

// RFC 8291 Appendix A
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const ecPrivateJwk = (pub: string, d: string) => {
  const p = fromB64u(pub);

  return {
    kty: "EC",
    crv: "P-256",
    x: b64u(p.slice(1, 33)),
    y: b64u(p.slice(33, 65)),
    d,
    ext: true,
  };
};

describe("Web Push (RFC 8291 / RFC 8292)", () => {
  it("[E23] decrypts the RFC 8291 Appendix A message (the native shells' algorithm)", async () => {
    const plain = await decryptWebPush(
      {
        publicKey: fromB64u(V.uaPublic) as Uint8Array<ArrayBuffer>,
        privateKey: fromB64u(V.uaPrivate) as Uint8Array<ArrayBuffer>,
        auth: fromB64u(V.auth) as Uint8Array<ArrayBuffer>,
      },
      fromB64u(V.body) as Uint8Array<ArrayBuffer>,
    );

    expect(new TextDecoder().decode(plain)).toBe(V.plaintext);
  });

  it("[E23] verifies VAPID as a push service: key, audience and expiry", async () => {
    const keys = { publicKey: V.asPublic, privateKey: V.asPrivate, subject: "mailto:ops@bye.test" };
    const now = Date.UTC(2026, 8, 30);
    const auth = await vapidAuthorization("https://push.bye.test/v1/relay/x", keys, now);
    expect(await verifyVapid(auth, "https://push.bye.test", now)).toBe(V.asPublic);
    expect(await verifyVapid(auth, "https://other.test", now)).toBeNull();
    expect(await verifyVapid(auth, "https://push.bye.test", now + 25 * 3600_000)).toBeNull();
    expect(
      await verifyVapid(auth.replace(V.asPublic, V.uaPublic), "https://push.bye.test", now),
    ).toBeNull();
    expect(await verifyVapid(null, "https://push.bye.test", now)).toBeNull();
    expect(await verifyVapid("vapid t=a.b.c, k=zz", "https://push.bye.test", now)).toBeNull();
  });

  it("[E23] encrypts exactly as RFC 8291 Appendix A", async () => {
    const body = await encryptWebPush(
      { p256dh: V.uaPublic, auth: V.auth },
      new TextEncoder().encode(V.plaintext) as Uint8Array<ArrayBuffer>,
      {
        salt: fromB64u(V.salt) as Uint8Array<ArrayBuffer>,
        serverKeys: {
          publicKey: fromB64u(V.asPublic) as Uint8Array<ArrayBuffer>,
          privateKey: fromB64u(V.asPrivate) as Uint8Array<ArrayBuffer>,
        },
      },
    );

    expect(b64u(body)).toBe(V.body);
  });

  it("[E23] a random-key message decrypts with the user agent's keys", async () => {
    const body = await encryptWebPush(
      { p256dh: V.uaPublic, auth: V.auth },
      new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer>,
    );

    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const ciphertext = body.slice(21 + idlen);

    const uaPriv = await crypto.subtle.importKey(
      "jwk",
      ecPrivateJwk(V.uaPublic, V.uaPrivate),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );

    const asKey = await crypto.subtle.importKey(
      "raw",
      asPublic,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );

    const ecdh = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPriv, 256),
    );

    const hk = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) },
          await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]),
          len * 8,
        ),
      );

    const enc = new TextEncoder();

    const keyInfo = new Uint8Array([
      ...enc.encode("WebPush: info\0"),
      ...fromB64u(V.uaPublic),
      ...asPublic,
    ]);

    const ikm = await hk(fromB64u(V.auth), ecdh, keyInfo, 32);
    const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
        ciphertext,
      ),
    );

    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe("hello");
    expect(plain.at(-1)).toBe(2);
  });

  it("[E23] VAPID tokens are ES256 JWTs bound to the push service origin and verify with the public key", async () => {
    const header = await vapidAuthorization(
      "https://push.example.net/send/abc",
      { publicKey: V.asPublic, privateKey: V.asPrivate, subject: "mailto:ops@bye.test" },
      Date.UTC(2026, 8, 25),
    );

    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(V.asPublic);
    const [h, c, s] = jwt!.split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(c!)));
    expect(claims).toMatchObject({ aud: "https://push.example.net", sub: "mailto:ops@bye.test" });
    expect(claims.exp - Date.UTC(2026, 8, 25) / 1000).toBeLessThanOrEqual(24 * 3600);

    const pub = await crypto.subtle.importKey(
      "raw",
      fromB64u(V.asPublic),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pub,
        fromB64u(s!),
        new TextEncoder().encode(`${h}.${c}`),
      ),
    ).toBe(true);
  });

  it("[E23] sends with aes128gcm headers and classifies push-service responses", async () => {
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      redirect?: string;
      signal?: AbortSignal;
    }> = [];

    const result = await sendWebPush(
      async (url, init) => (
        calls.push({ url, headers: init.headers, redirect: init.redirect, signal: init.signal }),
        { status: 201 }
      ),
      { endpoint: "https://push.example.net/x", p256dh: V.uaPublic, auth: V.auth },
      { title: "t" },
      {
        publicKey: V.asPublic,
        privateKey: V.asPrivate,
        subject: "mailto:ops@bye.test",
      },
      { topic: "thread:thr 1!" },
    );

    expect(result._tag).toBe("Delivered");
    expect(calls[0]!.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      urgency: "normal",
      topic: "threadthr1",
    });
    // The endpoint is user-registered: redirects are never followed and the send is time-boxed.
    expect(calls[0]!.redirect).toBe("manual");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(classifyPushStatus(302)._tag).toBe("Rejected");
    expect(classifyPushStatus(410)._tag).toBe("Gone");
    expect(classifyPushStatus(404)._tag).toBe("Gone");
    expect(classifyPushStatus(429)._tag).toBe("Retry");
    expect(classifyPushStatus(400)._tag).toBe("Rejected");
  });
});

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

type KeyPair = { publicKey: Key; privateKey: Key };

const pkcs8Pem = async (key: Key) => {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);

  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
};

describe("native push adapters", () => {
  it("[E23] APNs uses a cached ES256 provider token and the device-token path", async () => {
    resetPushTokenCaches();

    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as KeyPair;

    const config = {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyPem: await pkcs8Pem(pair.privateKey),
      topic: "app.bye.mobile",
      production: false,
    };

    const t1 = await apnsProviderToken(config, 0);
    expect(await apnsProviderToken(config, 30 * 60_000)).toBe(t1);
    expect(await apnsProviderToken(config, 45 * 60_000)).not.toBe(t1);
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

    const r = await sendApns(
      async (url, init) => (
        calls.push({ url, headers: init.headers, body: String(init.body) }),
        { status: 200 }
      ),
      config,
      "a".repeat(64),
      { title: "New mail", body: "From Ana", url: "bye://mail/imbox", collapseId: "thr_1" },
    );

    expect(r._tag).toBe("Delivered");
    expect(calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${"a".repeat(64)}`);
    expect(calls[0]!.headers["apns-topic"]).toBe("app.bye.mobile");
    expect(JSON.parse(calls[0]!.body).aps.alert.title).toBe("New mail");
    expect(
      (
        await sendApns(async () => ({ status: 410 }), config, "b".repeat(64), {
          title: "",
          body: "",
          url: "",
          collapseId: "",
        })
      )._tag,
    ).toBe("Gone");
    expect(
      (
        await sendApns(async () => ({ status: 200 }), config, "not-a-token", {
          title: "",
          body: "",
          url: "",
          collapseId: "",
        })
      )._tag,
    ).toBe("Rejected");
  });

  it("[E23] FCM exchanges a service-account JWT once, then sends HTTP v1 messages", async () => {
    resetPushTokenCaches();

    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as KeyPair;

    const account = {
      project_id: "bye-prod",
      client_email: "push@bye.iam.example",
      private_key: await pkcs8Pem(pair.privateKey),
    };

    let tokenCalls = 0;
    const sent: Array<unknown> = [];

    const fetchFn = async (url: string, init: { body?: unknown }) => {
      if (url.includes("oauth2")) {
        tokenCalls++;
        expect(String(init.body)).toContain(
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
        );

        return {
          status: 200,
          json: async () => ({ access_token: "ya29.token", expires_in: 3600 }),
        };
      }

      sent.push(JSON.parse(String(init.body)));

      return { status: 200, json: async () => ({}) };
    };

    await sendFcm(
      fetchFn as never,
      account,
      "reg-token",
      { title: "Reminder", body: "Standup", url: "bye://calendar", collapseId: "evt_1" },
      0,
    );
    await sendFcm(
      fetchFn as never,
      account,
      "reg-token",
      { title: "Reminder", body: "Standup", url: "bye://calendar", collapseId: "evt_1" },
      60_000,
    );
    expect(tokenCalls).toBe(1);
    expect(sent[0]).toMatchObject({
      message: {
        token: "reg-token",
        notification: { title: "Reminder" },
        data: { url: "bye://calendar" },
      },
    });
    await expect(
      fcmAccessToken(
        async () => ({ status: 401, json: async () => ({}) }),
        { ...account, client_email: "other@x" },
        0,
      ),
    ).rejects.toThrow("401");
  });
});

describe("provider outcomes by whose fault they are (P1.7)", () => {
  it("[P1.7] APNs: token faults count against the device; configuration faults are retried", () => {
    expect(classifyApns(200, "")).toEqual({ _tag: "Delivered" });
    expect(classifyApns(410, "Unregistered")).toEqual({ _tag: "Gone" });
    expect(classifyApns(400, "BadDeviceToken")).toEqual({ _tag: "Rejected", status: 400 });

    // A wrong bundle ID or key would fail every device at once: never the device's fault.
    for (const [status, reason] of [
      [400, "TopicDisallowed"],
      [400, "BadTopic"],
      [400, "DeviceTokenNotForTopic"],
      [403, "InvalidProviderToken"],
      [403, "ExpiredProviderToken"],
      [429, "TooManyProviderTokenUpdates"],
      [503, "ServiceUnavailable"],
    ] as const)
      expect(classifyApns(status, reason)._tag).toBe("Retry");
    expect(classifyApns(413, "PayloadTooLarge")._tag).toBe("Dropped");
    expect(classifyApns(400, "BadCollapseId")._tag).toBe("Dropped");
  });

  it("[P1.7] FCM: dead and foreign tokens are gone; credential and quota faults are retried", () => {
    expect(classifyFcm(404, "UNREGISTERED")._tag).toBe("Gone");
    expect(classifyFcm(403, "SENDER_ID_MISMATCH")._tag).toBe("Gone");
    expect(classifyFcm(400, "INVALID_ARGUMENT")._tag).toBe("Rejected");
    expect(classifyFcm(401, "THIRD_PARTY_AUTH_ERROR")._tag).toBe("Retry");
    expect(classifyFcm(403, "PERMISSION_DENIED")._tag).toBe("Retry");
    expect(classifyFcm(429, "QUOTA_EXCEEDED")._tag).toBe("Retry");
    expect(classifyFcm(413, "")._tag).toBe("Dropped");
  });

  it("[P1.7] Web Push: 413 drops the message; 401/403 are about the subscription", () => {
    expect(classifyPushStatus(413)._tag).toBe("Dropped");
    expect(classifyPushStatus(403)._tag).toBe("Rejected");
  });

  it("[P1.7] reads the APNs reason from the response", async () => {
    resetPushTokenCaches();

    const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] };

    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
      (await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer,
    ).toString("base64")}\n-----END PRIVATE KEY-----`;

    const config = {
      teamId: "T",
      keyId: "K",
      privateKeyPem: pem,
      topic: "wrong.app",
      production: true,
    };

    const answer = (reason: string) => async () =>
      new Response(JSON.stringify({ reason }), { status: 400 });

    const note = { title: "t", body: "b", url: "https://app.bye.test/", collapseId: "c" };
    expect((await sendApns(answer("TopicDisallowed"), config, "ab".repeat(32), note))._tag).toBe(
      "Retry",
    );
    expect((await sendApns(answer("BadDeviceToken"), config, "ab".repeat(32), note))._tag).toBe(
      "Rejected",
    );
  });
});
