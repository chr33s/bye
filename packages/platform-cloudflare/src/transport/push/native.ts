import { b64uEncode, pemToPkcs8, signJwt, utf8 } from "./encoding.ts";
import { classifyPushStatus, type PushFetch, type PushResult } from "./webpush.ts";

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

export const sendApns = async (
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
): Promise<PushResult> => {
  if (!/^[0-9a-f]{64,200}$/i.test(deviceToken)) return { _tag: "Rejected", status: 400 };

  const host = config.production
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

  const response = await fetchFn(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsProviderToken(config, now)}`,
      "apns-topic": config.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": notification.collapseId.slice(0, 64),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: { alert: { title: notification.title, body: notification.body }, sound: "default" },
      url: notification.url,
    }),
  });

  // APNs: 410 Unregistered → gone; 400 BadDeviceToken treated as rejected.
  return classifyPushStatus(response.status);
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

export const sendFcm = async (
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
): Promise<PushResult> => {
  const token = await fcmAccessToken(fetchFn, account, now);

  const response = await fetchFn(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: registrationToken,
          notification: { title: notification.title, body: notification.body },
          data: { url: notification.url },
          android: { collapse_key: notification.collapseId.slice(0, 64), priority: "high" },
        },
      }),
    },
  );

  // FCM: 404 UNREGISTERED → gone.
  return classifyPushStatus(response.status);
};

/** Reset cached provider tokens (tests / key rotation). */
export const resetPushTokenCaches = (): void => {
  apnsCache = null;
  fcmCache = null;
};

export const pushTopicFor = (value: string): string => b64uEncode(utf8(value)).slice(0, 32);
