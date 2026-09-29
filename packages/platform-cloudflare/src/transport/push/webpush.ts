import { Option, Schema } from "effect";
import {
  b64uDecode,
  b64uEncode,
  type Bytes,
  concat,
  signJwt,
  utf8,
  type WebKey,
} from "./encoding.ts";

interface EcJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly d?: string;
  readonly ext: boolean;
}

// Web Push: message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID (RFC 8292), sent per
// RFC 8030. Pure WebCrypto so it runs in Workers; tested against the RFC 8291 Appendix A vector.

export interface WebPushSubscription {
  readonly endpoint: string;
  /** Base64url uncompressed P-256 public key (65 bytes) from PushSubscription.getKey("p256dh"). */
  readonly p256dh: string;
  /** Base64url 16-byte authentication secret. */
  readonly auth: string;
}

export interface VapidKeys {
  /** Base64url uncompressed P-256 public key (65 bytes). */
  readonly publicKey: string;
  /** Base64url 32-byte private scalar. */
  readonly privateKey: string;
  /** `mailto:` or `https:` contact (RFC 8292 §2.1). */
  readonly subject: string;
}

const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
};

const ecJwk = (publicKey: Bytes, d?: Bytes): EcJwk => {
  const base = {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(publicKey.slice(1, 33)),
    y: b64uEncode(publicKey.slice(33, 65)),
  } as const;

  return d ? { ...base, d: b64uEncode(d), ext: true } : { ...base, ext: true };
};

export interface EncryptOptions {
  /** For tests: fixed 16-byte salt and application-server ECDH key pair. */
  readonly salt?: Bytes;
  readonly serverKeys?: { readonly publicKey: Bytes; readonly privateKey: Bytes };
  /** Record size (default 4096). Payload must fit one record. */
  readonly recordSize?: number;
}

/** Encrypt a push payload for a subscription (single aes128gcm record). */
export const encryptWebPush = async (
  subscription: Pick<WebPushSubscription, "p256dh" | "auth">,
  plaintext: Bytes,
  options: EncryptOptions = {},
): Promise<Bytes> => {
  const uaPublic = b64uDecode(subscription.p256dh);
  const authSecret = b64uDecode(subscription.auth);

  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 4) throw new Error("invalid p256dh key");

  if (authSecret.byteLength !== 16) throw new Error("invalid auth secret");
  const recordSize = options.recordSize ?? 4096;

  if (plaintext.byteLength + 1 + 16 > recordSize)
    throw new Error("payload too large for one record");

  let asPublic: Bytes;
  let asPrivate: WebKey;

  if (options.serverKeys) {
    asPublic = options.serverKeys.publicKey;
    asPrivate = await crypto.subtle.importKey(
      "jwk",
      ecJwk(asPublic, options.serverKeys.privateKey) as never,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as { publicKey: WebKey; privateKey: WebKey };

    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    asPrivate = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as never, asPrivate, 256),
  );

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt ?? (crypto.getRandomValues(new Uint8Array(16)) as Bytes);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([0x02])); // last-record delimiter, no padding
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.byteLength;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
};

/** RFC 8292 `Authorization: vapid t=<jwt>, k=<public key>` for the endpoint's origin. */
export const vapidAuthorization = async (
  endpoint: string,
  keys: VapidKeys,
  now = Date.now(),
  ttlSeconds = 12 * 3600,
): Promise<string> => {
  const publicKey = b64uDecode(keys.publicKey);

  const key = await crypto.subtle.importKey(
    "jwk",
    ecJwk(publicKey, b64uDecode(keys.privateKey)) as never,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const jwt = await signJwt(
    { typ: "JWT", alg: "ES256" },
    {
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600),
      sub: keys.subject,
    },
    key,
    { name: "ECDSA", hash: "SHA-256" },
  );

  return `vapid t=${jwt}, k=${keys.publicKey}`;
};

const decodeVapidHeader = Schema.decodeUnknownOption(
  Schema.Struct({ alg: Schema.Literal("ES256") }),
);

const decodeVapidClaims = Schema.decodeUnknownOption(
  Schema.Struct({ aud: Schema.String, exp: Schema.Number }),
);

/**
 * Verify an RFC 8292 `vapid t=<jwt>, k=<key>` authorization as a push service does: an ES256 JWT
 * signed by `k`, addressed to `audience` (this push service's origin), unexpired and at most 24h
 * out. Answers the application server's public key, or null.
 */
export const verifyVapid = async (
  authorization: string | null,
  audience: string,
  now = Date.now(),
): Promise<string | null> => {
  const m =
    /^vapid\s+t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+),\s*k=([A-Za-z0-9_-]+)$/.exec(
      authorization?.trim() ?? "",
    );

  if (!m) return null;
  const [, jwt = "", k = ""] = m;

  try {
    const publicKey = b64uDecode(k);

    if (publicKey.byteLength !== 65 || publicKey[0] !== 4) return null;
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    const h = decodeVapidHeader(JSON.parse(new TextDecoder().decode(b64uDecode(header))));
    const c = decodeVapidClaims(JSON.parse(new TextDecoder().decode(b64uDecode(claims))));
    const seconds = Math.floor(now / 1000);

    if (
      Option.isNone(h) ||
      Option.isNone(c) ||
      c.value.aud !== audience ||
      c.value.exp <= seconds ||
      c.value.exp > seconds + 24 * 3600
    )
      return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      ecJwk(publicKey) as never,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64uDecode(signature),
      utf8(`${header}.${claims}`),
    );

    return valid ? k : null;
  } catch {
    return null;
  }
};

/**
 * Decrypt a single-record aes128gcm Web Push message as the user agent does (RFC 8291 §3.4). The
 * native shells implement the same steps (ByePushCrypto.swift / ByePushCrypto.kt) against the RFC
 * Appendix A vector this is tested with.
 */
export const decryptWebPush = async (
  receiver: { readonly publicKey: Bytes; readonly privateKey: Bytes; readonly auth: Bytes },
  message: Bytes,
): Promise<Bytes> => {
  if (message.byteLength < 21) throw new Error("truncated push message");
  const salt = message.slice(0, 16);
  const idLength = message[20]!;
  const asPublic = message.slice(21, 21 + idLength);
  const ciphertext = message.slice(21 + idLength);

  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    ecJwk(receiver.publicKey, receiver.privateKey) as never,
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

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, uaPrivate, 256),
  );

  const keyInfo = concat(utf8("WebPush: info\0"), receiver.publicKey, asPublic);
  const ikm = await hkdf(receiver.auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);

  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext),
  );

  // Strip padding back to the last-record delimiter (0x02).
  let end = record.byteLength - 1;

  while (end >= 0 && record[end] === 0) end--;

  if (end < 0 || record[end] !== 2) throw new Error("invalid record delimiter");

  return record.slice(0, end);
};

/**
 * One send's outcome, by whose fault a failure is:
 * - `Gone`: the registration is dead (disable it);
 * - `Rejected`: this registration was refused (counts toward disabling it);
 * - `Dropped`: this message was refused (too large, malformed); the device is fine;
 * - `Retry`: transient, or the sender's own fault (credentials, configuration): try again later.
 */
export type PushResult =
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Retry"; readonly status: number }
  | { readonly _tag: "Rejected"; readonly status: number }
  | { readonly _tag: "Dropped"; readonly status: number };

export type PushFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array | string;
    redirect?: "manual";
    signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; text?(): Promise<string> }>;

/** A push service answers promptly; a stalled endpoint must not hold the notify consumer. */
export const WEB_PUSH_TIMEOUT_MS = 10_000;

/** Notification content serialized into the encrypted push body. */
export type WebPushPayload = Readonly<Record<string, string | number | boolean>>;

type PushRequestHeaders = {
  authorization: string;
  "content-encoding": string;
  "content-type": string;
  ttl: string;
  urgency: string;
  topic?: string;
};

/** Deliver one encrypted Web Push message. 404/410 mean the subscription is gone (RFC 8030 §7.3). */
export const sendWebPush = async (
  fetchFn: PushFetch,
  subscription: WebPushSubscription,
  payload: WebPushPayload,
  vapid: VapidKeys,
  options: {
    readonly ttlSeconds?: number;
    readonly urgency?: "very-low" | "low" | "normal" | "high";
    readonly topic?: string;
    readonly now?: number;
  } = {},
): Promise<PushResult> => {
  const body = await encryptWebPush(subscription, utf8(JSON.stringify(payload)));

  const headers: PushRequestHeaders = {
    authorization: await vapidAuthorization(subscription.endpoint, vapid, options.now),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(options.ttlSeconds ?? 86_400),
    urgency: options.urgency ?? "normal",
  };

  if (options.topic) headers.topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);

  const response = await fetchFn(subscription.endpoint, {
    method: "POST",
    headers,
    body,
    // The endpoint is user-registered: a redirect is never followed (it could point anywhere the
    // registration-time check refused); a 3xx classifies as Rejected.
    redirect: "manual",
    signal: AbortSignal.timeout(WEB_PUSH_TIMEOUT_MS),
  });

  return classifyPushStatus(response.status);
};

/**
 * RFC 8030 push-service statuses. A 401/403 here is about this subscription (it was made for
 * another application-server key), so it counts against the registration.
 */
export const classifyPushStatus = (status: number): PushResult =>
  status >= 200 && status < 300
    ? { _tag: "Delivered" }
    : status === 404 || status === 410
      ? { _tag: "Gone" }
      : status === 413
        ? { _tag: "Dropped", status }
        : status === 429 || status >= 500
          ? { _tag: "Retry", status }
          : { _tag: "Rejected", status };
