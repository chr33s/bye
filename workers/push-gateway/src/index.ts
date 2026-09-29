import { fromBase64Url, toBase64Url, utf8 } from "@bye/domain";
import {
  apnsConfigFrom,
  fcmAccountFrom,
  parseSecretRing,
  type PushCredentialsEnv,
  type PushFetch,
  type PushResult,
  sendApnsRequest,
  sendFcmMessage,
  type TokenFetch,
  verifyVapid,
} from "@bye/platform-cloudflare";
import { Match, Option, Schema } from "effect";

// Native push gateway (spec P1.7, X01). APNs keys and the FCM project belong to whoever publishes
// the app, so a self-hosted instance can't reach an iPhone or Android device directly. The gateway
// is the only holder of those credentials, and it relays without reading:
//
//   device ── POST /v1/register {platform, token, vapidKey} ──▶ gateway ── {endpoint} ──▶ device
//   device ── POST /v1/push/subscriptions {kind: "webpush", endpoint, p256dh, auth} ──▶ instance
//   instance ── Web Push (RFC 8291 ciphertext + RFC 8292 VAPID) ──▶ gateway ──▶ APNs / FCM ──▶ device
//
// The endpoint path is a sealed envelope of the device token, its APNs environment and the
// instance's VAPID key, so the gateway keeps no table, and only the instance the device registered
// with can push to it. Payloads stay end-to-end encrypted to the device's own keys; the gateway
// forwards the ciphertext, and the iOS Notification Service Extension or the Android messaging
// service decrypts it on the device.

export interface GatewayEnv extends PushCredentialsEnv {
  /** This service's public origin, e.g. https://push.bye.software (the VAPID audience). */
  readonly GATEWAY_ORIGIN: string;
  /**
   * AES-256-GCM keys (base64url, 32 bytes) that seal relay endpoints, as a key ring:
   * `v2:<new>,v1:<old>`, newest first. New endpoints use the first; older versions stay readable, so
   * rotation never invalidates devices already registered. A plain value is version 1.
   */
  readonly RELAY_SEAL_KEY: string;
  readonly REGISTER_RATE_LIMIT?: RateLimit;
  readonly RELAY_RATE_LIMIT?: RateLimit;
}

/** Fits a single aes128gcm record whose base64url form still leaves room in a 4 KiB APNs payload. */
export const MAX_RELAY_BODY = 2800;

const MAX_TTL_SECONDS = 28 * 86_400;

const SEAL_AAD = utf8("bye-push-relay/1");

const Platform = Schema.Literals(["apns", "fcm"]);

const RegisterBody = Schema.Struct({
  platform: Platform,
  token: Schema.String,
  sandbox: Schema.optional(Schema.Boolean),
  vapidKey: Schema.String,
});

const Sealed = Schema.Struct({
  p: Platform,
  t: Schema.String,
  s: Schema.Boolean,
  k: Schema.String,
});

type Sealed = typeof Sealed.Type;

const decodeRegister = Schema.decodeUnknownOption(RegisterBody);

const decodeSealed = Schema.decodeUnknownOption(Sealed);

const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,512}$/;

const B64U = /^[A-Za-z0-9_-]+$/;

const json = (body: Readonly<Record<string, string>>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const problem = (status: number, message: string) => json({ error: message }, status);

/** The sealing key for `version` (the endpoint's first byte), or null if the ring lacks it. */
const sealKey = (env: GatewayEnv, version: number) => {
  const secret = parseSecretRing(env.RELAY_SEAL_KEY).secrets[version];

  return secret === undefined
    ? null
    : crypto.subtle.importKey("raw", fromBase64Url(secret), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
};

export const sealRegistration = async (env: GatewayEnv, value: Sealed): Promise<string> => {
  const version = parseSecretRing(env.RELAY_SEAL_KEY).current;
  const key = sealKey(env, version);

  if (version > 255 || !key) throw new Error("RELAY_SEAL_KEY: current version must be 1–255");
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: SEAL_AAD },
      await key,
      utf8(JSON.stringify(value)),
    ),
  );

  const out = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
  out[0] = version;
  out.set(iv, 1);
  out.set(ciphertext, 13);

  return toBase64Url(out);
};

export const openRegistration = async (env: GatewayEnv, id: string): Promise<Sealed | null> => {
  if (!B64U.test(id) || id.length > 1024) return null;

  try {
    const bytes = fromBase64Url(id);

    // A version dropped from the ring means the endpoint is gone for good (the instance prunes it).
    const key = sealKey(env, bytes[0] ?? 0);

    if (!key || bytes.byteLength < 1 + 12 + 16) return null;

    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13), additionalData: SEAL_AAD },
      await key,
      bytes.slice(13),
    );

    return Option.getOrNull(decodeSealed(JSON.parse(new TextDecoder().decode(plain))));
  } catch {
    return null;
  }
};

const validVapidKey = (key: string) => {
  if (!B64U.test(key)) return false;

  try {
    const raw = fromBase64Url(key);

    return raw.byteLength === 65 && raw[0] === 4;
  } catch {
    return false;
  }
};

const register = async (request: Request, env: GatewayEnv): Promise<Response> => {
  if (env.REGISTER_RATE_LIMIT) {
    const { success } = await env.REGISTER_RATE_LIMIT.limit({
      key: request.headers.get("cf-connecting-ip") ?? "unknown",
    });

    if (!success) return problem(429, "rate limited");
  }

  const text = await request.text();

  if (text.length > 4096) return problem(413, "request too large");
  let raw: Parameters<typeof decodeRegister>[0];

  try {
    raw = JSON.parse(text);
  } catch {
    return problem(400, "invalid json");
  }

  const body = decodeRegister(raw);

  if (Option.isNone(body)) return problem(400, "invalid registration");
  const { platform, token, sandbox, vapidKey } = body.value;

  if (!(platform === "apns" ? APNS_TOKEN : FCM_TOKEN).test(token))
    return problem(400, "invalid device token");

  if (!validVapidKey(vapidKey)) return problem(400, "invalid vapidKey");

  const id = await sealRegistration(env, {
    p: platform,
    t: token,
    s: platform === "apns" && sandbox === true,
    k: vapidKey,
  });

  return json({ endpoint: `${env.GATEWAY_ORIGIN}/v1/relay/${id}` }, 201);
};

/** RFC 8030 §5.2 TTL, bounded; absent or malformed means deliver-now-or-drop (0). */
const ttlOf = (request: Request) => {
  const ttl = Number.parseInt(request.headers.get("ttl") ?? "0", 10);

  return Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_TTL_SECONDS) : 0;
};

/**
 * The relay answers in push-service terms, and instances disable a device after repeated 4xx. The
 * provider classifiers already put the sender's own faults (credentials, bundle ID, quota) under
 * Retry, so only a refused registration answers 400, a refused message 413, and everything the
 * gateway or provider must fix 503, which instances retry without counting against the device.
 */
export const relayStatus = (result: PushResult): number =>
  Match.value(result).pipe(
    Match.tagsExhaustive({
      Delivered: () => 201,
      Gone: () => 410,
      Rejected: () => 400,
      Dropped: () => 413,
      Retry: (r) => (r.status === 429 ? 429 : 503),
    }),
  );

const pushStatus = (result: PushResult): Response =>
  new Response(null, { status: relayStatus(result) });

/** The gateway itself can't serve this platform: not the device's fault, so retryable. */
const unavailable = (message: string) => problem(503, message);

export interface RelayDeps {
  readonly fetch: PushFetch & TokenFetch;
  readonly now: () => number;
}

const relay = async (
  request: Request,
  env: GatewayEnv,
  id: string,
  deps: RelayDeps,
): Promise<Response> => {
  const target = await openRegistration(env, id);

  // Unknown or tampered endpoints are gone for good: the instance disables the registration.
  if (!target) return new Response(null, { status: 404 });

  if (env.RELAY_RATE_LIMIT) {
    const { success } = await env.RELAY_RATE_LIMIT.limit({ key: id.slice(0, 64) });

    if (!success) return new Response(null, { status: 429 });
  }

  const vapid = await verifyVapid(
    request.headers.get("authorization"),
    env.GATEWAY_ORIGIN,
    deps.now(),
  );

  if (vapid === null) return problem(401, "invalid VAPID authorization");

  if (vapid !== target.k) return problem(403, "endpoint belongs to another application server");

  if (request.headers.get("content-encoding") !== "aes128gcm")
    return problem(415, "aes128gcm required");

  const body = new Uint8Array(await request.arrayBuffer());

  if (body.byteLength === 0 || body.byteLength > MAX_RELAY_BODY)
    return problem(413, "payload too large");

  const ttl = ttlOf(request);
  const urgency = request.headers.get("urgency") ?? "normal";

  const topic = request.headers
    .get("topic")
    ?.replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32);

  const p = toBase64Url(body);

  if (target.p === "apns") {
    const config = apnsConfigFrom(env, !target.s);

    if (!config) return unavailable("apns not configured");

    return pushStatus(
      await sendApnsRequest(
        deps.fetch,
        config,
        target.t,
        {
          // The alert shown if the extension can't decrypt; the extension replaces it.
          payload: {
            aps: {
              alert: { title: "bye", body: "New notification" },
              sound: "default",
              "mutable-content": 1,
            },
            bye: { v: 1, p },
          },
          collapseId: topic || undefined,
          priority: urgency === "low" || urgency === "very-low" ? 5 : 10,
          expiration: ttl === 0 ? 0 : Math.floor(deps.now() / 1000) + ttl,
        },
        deps.now(),
      ),
    );
  }

  const account = fcmAccountFrom(env);

  if (!account) return unavailable("fcm not configured");

  const android: FcmAndroidConfig = {
    priority: urgency === "high" || urgency === "normal" ? "high" : "normal",
    ttl: `${ttl}s`,
  };

  if (topic) android.collapse_key = topic;

  return pushStatus(
    await sendFcmMessage(
      deps.fetch,
      account,
      target.t,
      {
        // Data-only: the app's messaging service decrypts and builds the notification itself.
        data: { v: "1", p },
        android,
      },
      deps.now(),
    ),
  );
};

/** The FCM v1 `android` block the relay sets. */
type FcmAndroidConfig = {
  readonly priority: "high" | "normal";
  readonly ttl: string;
  collapse_key?: string;
};

const RELAY_PATH = /^\/v1\/relay\/([A-Za-z0-9_-]{1,1024})$/;

export const handleGateway = async (
  request: Request,
  env: GatewayEnv,
  deps: RelayDeps = {
    fetch: ((url, init) => fetch(url, init as RequestInit)) as PushFetch & TokenFetch,
    now: () => Date.now(),
  },
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/v1/register")
    return request.method === "POST" ? register(request, env) : problem(405, "method not allowed");

  const relayMatch = RELAY_PATH.exec(url.pathname);

  if (relayMatch)
    return request.method === "POST"
      ? relay(request, env, relayMatch[1]!, deps)
      : problem(405, "method not allowed");

  return problem(404, "not found");
};

export default {
  fetch: (request, env) => handleGateway(request, env),
} satisfies ExportedHandler<GatewayEnv>;
