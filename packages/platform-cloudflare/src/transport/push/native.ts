import { Option, Schema } from "effect";
import { b64uEncode, pemToPkcs8, signJwt, utf8 } from "./encoding.ts";
import type { PushFetch, PushResult } from "./webpush.ts";

// Native push adapters: APNs provider-token auth (ES256 JWT) and FCM HTTP v1 (service-account
// OAuth). Credentials come from Worker secrets; tokens are cached per isolate only for their
// documented lifetime and never logged.

export interface ApnsConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** PEM (PKCS#8) contents of the .p8 key. */
  readonly privateKeyPem: string;
  /** App bundle ID used as apns-topic. */
  readonly topic: string;
  readonly production: boolean;
}

let apnsCache: { key: string; jwt: string; issuedAt: number } | null = null;

/** APNs provider token; Apple requires refresh between 20 and 60 minutes. */
export const apnsProviderToken = async (config: ApnsConfig, now = Date.now()): Promise<string> => {
  const cacheKey = `${config.teamId}:${config.keyId}`;

  if (apnsCache && apnsCache.key === cacheKey && now - apnsCache.issuedAt < 40 * 60_000)
    return apnsCache.jwt;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(config.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const jwt = await signJwt(
    { alg: "ES256", kid: config.keyId },
    { iss: config.teamId, iat: Math.floor(now / 1000) },
    key,
    { name: "ECDSA", hash: "SHA-256" },
  );

  apnsCache = { key: cacheKey, jwt, issuedAt: now };

  return jwt;
};

/** The provider's error body, bounded; empty when there is none or it can't be read. */
const errorText = async (response: { readonly status: number; text?(): Promise<string> }) => {
  if (response.status < 300 || !response.text) return "";

  try {
    return (await response.text()).slice(0, 2048);
  } catch {
    return "";
  }
};

const decodeApnsError = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Schema.optional(Schema.String) }),
);

const decodeFcmError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.optional(
      Schema.Struct({
        status: Schema.optional(Schema.String),
        details: Schema.optional(
          Schema.Array(Schema.Struct({ errorCode: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  }),
);

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as Parameters<typeof decodeApnsError>[0];
  } catch {
    return null;
  }
};

/** APNs reasons that are about this device's token. */
const APNS_DEVICE_REASONS: ReadonlySet<string> = new Set(["BadDeviceToken", "MissingDeviceToken"]);

/** APNs reasons that are about this message, not the device or the sender. */
const APNS_MESSAGE_REASONS: ReadonlySet<string> = new Set([
  "PayloadTooLarge",
  "PayloadEmpty",
  "BadCollapseId",
  "BadExpirationDate",
  "BadMessageId",
  "BadPriority",
  "BadPushType",
  "DuplicateHeaders",
]);

/**
 * An APNs answer by whose fault it is. Topic and provider-token problems (BadTopic,
 * TopicDisallowed, DeviceTokenNotForTopic, InvalidProviderToken, …) are the sender's configuration:
 * with a wrong bundle ID or key every device would fail at once, so they are retried, never
 * counted against a device.
 */
export const classifyApns = (status: number, reason: string): PushResult => {
  if (status >= 200 && status < 300) return { _tag: "Delivered" };

  if (status === 410 || reason === "Unregistered" || reason === "ExpiredToken")
    return { _tag: "Gone" };

  if (status === 413 || APNS_MESSAGE_REASONS.has(reason)) return { _tag: "Dropped", status };

  if (status === 400 && (APNS_DEVICE_REASONS.has(reason) || reason === ""))
    return { _tag: "Rejected", status };

  return { _tag: "Retry", status };
};

/**
 * An FCM v1 answer by whose fault it is. UNREGISTERED and SENDER_ID_MISMATCH (a token from another
 * Firebase project) are dead registrations; INVALID_ARGUMENT is counted against the registration
 * (it's how FCM reports a malformed token); authentication and quota problems are the sender's and
 * are retried.
 */
export const classifyFcm = (status: number, code: string): PushResult => {
  if (status >= 200 && status < 300) return { _tag: "Delivered" };

  if (status === 404 || code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH")
    return { _tag: "Gone" };

  if (status === 413) return { _tag: "Dropped", status };

  if (status === 400 || code === "INVALID_ARGUMENT") return { _tag: "Rejected", status };

  return { _tag: "Retry", status };
};

/** A JSON value in a provider request body. */
export type PushJson =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<PushJson>
  | { readonly [key: string]: PushJson };

export interface ApnsRequest {
  /** The JSON body: `aps` plus custom keys. */
  readonly payload: { readonly [key: string]: PushJson };
  readonly collapseId?: string | undefined;
  /** 10 = immediate, 5 = power-considerate. */
  readonly priority?: 5 | 10;
  /** Unix seconds after which APNs drops the notification; 0 = deliver once or not at all. */
  readonly expiration?: number;
}

type ApnsHeaders = {
  authorization: string;
  "apns-topic": string;
  "apns-push-type": string;
  "apns-priority": string;
  "content-type": string;
  "apns-collapse-id"?: string;
  "apns-expiration"?: string;
};

/** One APNs alert request (provider-token auth). 410 Unregistered → Gone. */
export const sendApnsRequest = async (
  fetchFn: PushFetch,
  config: ApnsConfig,
  deviceToken: string,
  request: ApnsRequest,
  now = Date.now(),
): Promise<PushResult> => {
  if (!/^[0-9a-f]{64,200}$/i.test(deviceToken)) return { _tag: "Rejected", status: 400 };

  const host = config.production
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

  const headers: ApnsHeaders = {
    authorization: `bearer ${await apnsProviderToken(config, now)}`,
    "apns-topic": config.topic,
    "apns-push-type": "alert",
    "apns-priority": String(request.priority ?? 10),
    "content-type": "application/json",
  };

  if (request.collapseId) headers["apns-collapse-id"] = request.collapseId.slice(0, 64);

  if (request.expiration !== undefined) headers["apns-expiration"] = String(request.expiration);

  const response = await fetchFn(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers,
    body: JSON.stringify(request.payload),
  });

  const reason = Option.match(decodeApnsError(parseJson(await errorText(response))), {
    onNone: () => "",
    onSome: (e) => e.reason ?? "",
  });

  return classifyApns(response.status, reason);
};

export const sendApns = (
  fetchFn: PushFetch,
  config: ApnsConfig,
  deviceToken: string,
  notification: {
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly collapseId: string;
  },
  now = Date.now(),
): Promise<PushResult> =>
  sendApnsRequest(
    fetchFn,
    config,
    deviceToken,
    {
      payload: {
        aps: { alert: { title: notification.title, body: notification.body }, sound: "default" },
        url: notification.url,
      },
      collapseId: notification.collapseId,
    },
    now,
  );

/** The provider credentials a Worker is configured with (secrets and vars; empty = unset). */
export interface PushCredentialsEnv {
  readonly APNS_KEY_P8?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  /** The app's bundle ID. */
  readonly APNS_TOPIC?: string;
  /** Service-account JSON of the app's Firebase project. */
  readonly FCM_SERVICE_ACCOUNT?: string;
}

/** APNs provider-token config, or null when any part is unset. `production` picks the host. */
export const apnsConfigFrom = (env: PushCredentialsEnv, production: boolean): ApnsConfig | null =>
  env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
    ? {
        privateKeyPem: env.APNS_KEY_P8,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        topic: env.APNS_TOPIC,
        production,
      }
    : null;

const decodeServiceAccount = Schema.decodeUnknownOption(
  Schema.Struct({
    project_id: Schema.String,
    client_email: Schema.String,
    private_key: Schema.String,
    token_uri: Schema.optional(Schema.String),
  }),
);

/** The FCM service account, or null when unset or malformed. */
export const fcmAccountFrom = (env: PushCredentialsEnv): FcmServiceAccount | null => {
  if (!env.FCM_SERVICE_ACCOUNT) return null;

  try {
    return Option.getOrNull(decodeServiceAccount(JSON.parse(env.FCM_SERVICE_ACCOUNT)));
  } catch {
    return null;
  }
};

export interface FcmServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

let fcmCache: { email: string; token: string; expiresAt: number } | null = null;

export interface FcmTokenBody {
  readonly access_token?: string;
  readonly expires_in?: number;
}

export type TokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ readonly status: number; json(): Promise<FcmTokenBody> }>;

/** OAuth 2.0 JWT-bearer grant for the FCM scope (RFC 7523). */
export const fcmAccessToken = async (
  fetchFn: TokenFetch,
  account: FcmServiceAccount,
  now = Date.now(),
): Promise<string> => {
  if (fcmCache && fcmCache.email === account.client_email && fcmCache.expiresAt - 60_000 > now)
    return fcmCache.token;
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const iat = Math.floor(now / 1000);

  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    },
    key,
    { name: "RSASSA-PKCS1-v1_5" },
  );

  const response = await fetchFn(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
  });

  if (response.status !== 200) throw new Error(`fcm token http ${response.status}`);
  const body = await response.json();

  if (!body.access_token) throw new Error("fcm token missing");
  fcmCache = {
    email: account.client_email,
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  };

  return body.access_token;
};

/** The FCM v1 `message` minus its target token. */
export type FcmMessage = { readonly [key: string]: PushJson };

/** One FCM HTTP v1 send. 404 UNREGISTERED → Gone. */
export const sendFcmMessage = async (
  fetchFn: PushFetch & TokenFetch,
  account: FcmServiceAccount,
  registrationToken: string,
  message: FcmMessage,
  now = Date.now(),
): Promise<PushResult> => {
  const token = await fcmAccessToken(fetchFn, account, now);

  const response = await fetchFn(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { ...message, token: registrationToken } }),
    },
  );

  // The FCM-specific code (details[].errorCode) is more precise than the canonical status.
  const code = Option.match(decodeFcmError(parseJson(await errorText(response))), {
    onNone: () => "",
    onSome: (e) => e.error?.details?.find((d) => d.errorCode)?.errorCode ?? e.error?.status ?? "",
  });

  return classifyFcm(response.status, code);
};

export const sendFcm = (
  fetchFn: PushFetch & TokenFetch,
  account: FcmServiceAccount,
  registrationToken: string,
  notification: {
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly collapseId: string;
  },
  now = Date.now(),
): Promise<PushResult> =>
  sendFcmMessage(
    fetchFn,
    account,
    registrationToken,
    {
      notification: { title: notification.title, body: notification.body },
      data: { url: notification.url },
      android: { collapse_key: notification.collapseId.slice(0, 64), priority: "high" },
    },
    now,
  );

/** Reset cached provider tokens (tests / key rotation). */
export const resetPushTokenCaches = (): void => {
  apnsCache = null;
  fcmCache = null;
};

export const pushTopicFor = (value: string): string => b64uEncode(utf8(value)).slice(0, 32);
