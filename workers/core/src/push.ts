import { Match } from "effect";
import { toBase64Url, utf8 } from "@bye/domain";
import { isForbiddenProxyTarget } from "@bye/mail-codec";
import {
  apnsConfigFrom,
  fcmAccountFrom,
  type PushResult,
  sendApns,
  sendFcm,
  sendWebPush,
  type VapidKeys,
} from "@bye/platform-cloudflare";
import { type DohFetch, forbiddenResolution } from "./dns.ts";
import type { CoreEnv } from "./env.ts";
import { metric } from "./metrics.ts";

// Notification delivery boundary (§5.1 step 7, E23, C02/C10). Callers describe WHAT to notify;
// this module decides whether and HOW (device registrations, Web Push/APNs/FCM). Mailbox
// notification preferences (quiet default, opt-ins, quiet hours) are applied by the mailbox
// authority BEFORE it emits a notify event; device-level enablement is applied here.

export interface NotificationRequest {
  readonly userId: string;
  /** Stable kind, e.g. "mail.delivery", "calendar.reminder", "calendar.invitation". */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** In-app deep link (bye://… or https://app…/#/…). */
  readonly url: string;
  /** Opaque resource ID for collapse/topic. */
  readonly resource: string;
  /** Idempotency key: the same key is delivered at most once per device. */
  readonly dedupeKey: string;
}

export interface PushDeviceRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: "webpush" | "apns" | "fcm";
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
  readonly label: string;
  readonly created_at: number;
  readonly last_success_at: number | null;
  /** APNs environment of the token: 1 sandbox, 0 production, null when the client didn't say. */
  readonly apns_sandbox: number | null;
  /** The credential that registered it; null for registrations from before that was recorded. */
  readonly session_id: string | null;
}

export class RetryablePushFailure extends Error {
  override readonly name = "RetryablePushFailure";
}

const MAX_FAILURES = 5;

const vapidKeys = (env: CoreEnv): VapidKeys | null =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT || `mailto:ops@${new URL(env.APP_ORIGIN).hostname}`,
      }
    : null;

type Sender = (device: PushDeviceRow, request: NotificationRequest) => Promise<PushResult | null>;

/**
 * What a provider that can read the payload is shown (spec P1.7): APNs and FCM carry notifications
 * in the clear to Apple/Google, so they get the kind of event only — never a sender, subject or
 * address. Web Push payloads are end-to-end encrypted to the device (RFC 8291), including through
 * the native push gateway, so they carry the full content.
 */
export const providerVisibleText = (kind: string): { title: string; body: string } =>
  kind.startsWith("mail.")
    ? { title: "bye", body: "New mail" }
    : kind.includes("invitation")
      ? { title: "bye", body: "Calendar invitation" }
      : kind.includes("reminder")
        ? { title: "bye", body: "Reminder" }
        : { title: "bye", body: "New notification" };

/**
 * Web Push text limits. The whole encrypted message must fit one push-service record, and Bye's
 * push gateway accepts at most 2800 bytes; at 4 bytes per character in the worst case, these keep
 * the JSON payload well under that.
 */
export const PUSH_TEXT_LIMITS = { title: 120, body: 240, url: 1024, collapseId: 64 } as const;

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * Whether an APNs token belongs to the sandbox: as registered, or, when the client didn't say
 * (older builds, rows from before it was recorded), the old rule of sandbox on `.test` origins.
 */
const apnsSandbox = (env: CoreEnv, device: PushDeviceRow): boolean =>
  device.apns_sandbox === null ? env.APP_ORIGIN.includes(".test") : device.apns_sandbox === 1;

/**
 * A tag for grouping notifications about one resource that reveals nothing about it: SHA-256 of
 * the instance and resource ID, base64url, 32 characters (within APNs' 64-byte collapse-id limit).
 */
export const opaqueTag = async (origin: string, resource: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${origin}\n${resource}`))),
  ).slice(0, 32);

/**
 * The https link a Web Push notification opens. `bye://` deep links name no server, so browsers
 * can't open them and a phone signed in to several servers couldn't tell which one; they become
 * the same route on this instance's app origin (`bye://calendar/event/x` → `<origin>/#/calendar/event/x`).
 */
export const appLink = (origin: string, url: string): string => {
  if (url.startsWith(`${origin}/`)) return url;

  if (url.startsWith("bye://")) return `${origin}/#/${url.slice("bye://".length)}`;

  return `${origin}/`;
};

/**
 * Transport selection per device kind; null = the kind is not configured in this environment.
 * Web Push endpoints are user-registered URLs: the host is resolved over DoH and refused when any
 * answer is non-public (rebinding defense, as for the image proxy) before every send, and the send
 * itself never follows redirects (sendWebPush). APNs/FCM hosts are fixed.
 */
export const makePushSender = (
  env: CoreEnv,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
  doh: DohFetch = (u, i) => fetch(u, i),
): Sender => {
  const vapid = vapidKeys(env);
  // Production per device: the registration says which APNs environment issued its token.
  const apns = apnsConfigFrom(env, true);
  const fcm = fcmAccountFrom(env);
  const f = fetchFn as never;

  return async (device, request) => {
    const note = {
      title: clip(request.title, PUSH_TEXT_LIMITS.title),
      body: clip(request.body, PUSH_TEXT_LIMITS.body),
      url: request.url,
      collapseId: request.resource.slice(0, PUSH_TEXT_LIMITS.collapseId),
    };

    // Apple and Google see the kind of event and the app, nothing else: no sender, subject, thread
    // or route (P1.7). Notifications about the same thread or event still replace each other,
    // through an opaque tag.
    const opaque = {
      ...providerVisibleText(request.kind),
      url: `${env.APP_ORIGIN}/`,
      collapseId: await opaqueTag(env.APP_ORIGIN, request.resource),
    };

    switch (device.kind) {
      case "webpush":
        if (!vapid || !device.p256dh || !device.auth) return null;
        {
          const refused = await forbiddenResolution(new URL(device.endpoint).hostname, doh);

          // A failed lookup is transient (retry); a non-public answer counts toward disabling.
          if (refused === "resolution failed") return { _tag: "Retry", status: 0 };

          if (refused) return { _tag: "Rejected", status: 0 };
        }

        return sendWebPush(
          f,
          { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
          {
            ...note,
            url: appLink(env.APP_ORIGIN, request.url).slice(0, PUSH_TEXT_LIMITS.url),
            kind: request.kind.slice(0, 64),
          },
          vapid,
          {
            topic: request.resource,
            urgency: request.kind.startsWith("calendar.") ? "high" : "normal",
          },
        );
      case "apns":
        return apns
          ? sendApns(f, { ...apns, production: !apnsSandbox(env, device) }, device.endpoint, opaque)
          : null;
      case "fcm":
        return fcm ? sendFcm(f, fcm, device.endpoint, opaque) : null;
    }
  };
};

/** SQL: the row's `session_id` is a live browser session or device session (binds `now` ×3). */
const LIVE_SESSION = `(EXISTS (SELECT 1 FROM sessions s WHERE s.id = push_devices.session_id AND s.revoked_at IS NULL AND s.expires_at > ?)
  OR EXISTS (SELECT 1 FROM device_sessions d WHERE d.id = push_devices.session_id AND d.revoked_at IS NULL AND d.idle_expires_at > ? AND d.absolute_expires_at > ?))`;

/**
 * Deliver to every enabled device of the user. At most once per (dedupeKey, device). Dead
 * registrations (404/410) are disabled; transient failures are released and re-thrown so the
 * queue retries only the devices that did not receive it.
 */
export const deliverNotification = async (
  env: CoreEnv,
  request: NotificationRequest,
  send: Sender = makePushSender(env),
): Promise<{ readonly delivered: number }> => {
  const db = env.DIRECTORY;

  const now = Date.now();

  // A registration lives only as long as the credential that made it (P1.7). Sign-out and
  // revocation delete rows; this also skips those whose session simply expired.
  const devices = await db
    .prepare(
      `SELECT id, user_id, kind, endpoint, p256dh, auth, label, created_at, last_success_at, apns_sandbox, session_id FROM push_devices WHERE user_id = ? AND enabled = 1 AND disabled_at IS NULL AND (session_id IS NULL OR ${LIVE_SESSION})`,
    )
    .bind(request.userId, now, now, now)
    .all<PushDeviceRow>();

  let delivered = 0;
  let retry = false;

  for (const device of devices.results) {
    const claim = await db
      .prepare(
        "INSERT OR IGNORE INTO push_deliveries (dedupe_key, device_id, delivered_at) VALUES (?, ?, ?)",
      )
      .bind(request.dedupeKey, device.id, now)
      .run();

    if (claim.meta.changes !== 1) continue;
    let result: PushResult | null;

    try {
      result = await send(device, request);
    } catch {
      result = { _tag: "Retry", status: 0 };
    }

    if (result === null) {
      await db
        .prepare("DELETE FROM push_deliveries WHERE dedupe_key = ? AND device_id = ?")
        .bind(request.dedupeKey, device.id)
        .run();
      continue;
    }

    await Match.value(result).pipe(
      Match.tagsExhaustive({
        Delivered: async () => {
          delivered++;
          await db
            .prepare("UPDATE push_devices SET last_success_at = ?, failures = 0 WHERE id = ?")
            .bind(now, device.id)
            .run();
        },
        Gone: async () => {
          await db
            .prepare("UPDATE push_devices SET enabled = 0, disabled_at = ? WHERE id = ?")
            .bind(now, device.id)
            .run();
        },
        Retry: async () => {
          retry = true;
          await db
            .prepare("DELETE FROM push_deliveries WHERE dedupe_key = ? AND device_id = ?")
            .bind(request.dedupeKey, device.id)
            .run();
        },
        // The message was refused (too large, malformed): the device is fine.
        Dropped: async () => undefined,
        Rejected: async () => {
          await db
            .prepare(
              "UPDATE push_devices SET failures = failures + 1, enabled = CASE WHEN failures + 1 >= ? THEN 0 ELSE enabled END, disabled_at = CASE WHEN failures + 1 >= ? THEN ? ELSE disabled_at END WHERE id = ?",
            )
            .bind(MAX_FAILURES, MAX_FAILURES, now, device.id)
            .run();
        },
      }),
    );
  }

  metric("push.delivered", delivered, { kind: request.kind });

  if (retry) throw new RetryablePushFailure("some devices need retry");

  return { delivered };
};

/** Users who should hear about activity in a mailbox (active members with access). */
export const mailboxAudience = async (
  env: CoreEnv,
  mailboxId: string,
): Promise<ReadonlyArray<string>> =>
  (
    await env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT DISTINCT a.user_id FROM mailbox_access a JOIN mailboxes m ON m.id = a.mailbox_id
         JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id JOIN users u ON u.id = a.user_id
         WHERE a.mailbox_id = ? AND m.status = 'active' AND ms.status = 'active' AND u.status = 'active'`,
      )
      .bind(mailboxId)
      .all<{ user_id: string }>()
  ).results.map((r) => r.user_id);

export interface PushRegistration {
  readonly kind: "webpush" | "apns" | "fcm";
  readonly endpoint: string;
  readonly p256dh?: string;
  readonly auth?: string;
  readonly label?: string;
  readonly sandbox?: boolean;
}

/**
 * Remove the user's registrations whose session has ended (expired rather than signed out, so
 * nothing deleted them). Run where registrations are listed or counted, so an expired browser
 * shows push as off and dead rows never fill the device limit; delivery skips them anyway.
 */
export const pruneEndedRegistrations = async (env: CoreEnv, userId: string): Promise<void> => {
  const now = Date.now();

  await env.DIRECTORY.prepare(
    `DELETE FROM push_devices WHERE user_id = ? AND session_id IS NOT NULL AND NOT (${LIVE_SESSION})`,
  )
    .bind(userId, now, now, now)
    .run();
};

/**
 * A revoked credential (sign-out, device revoke, refresh-token reuse) takes the push registrations
 * it made with it (spec P1.7): a signed-out device must stop receiving notifications even when it
 * never got the chance to unregister. Best effort, like closing its live sockets.
 */
export const revokeCredentialPush = async (env: CoreEnv, credentialId: string): Promise<void> => {
  try {
    await env.DIRECTORY.prepare("DELETE FROM push_devices WHERE session_id = ?")
      .bind(credentialId)
      .run();
  } catch {
    console.warn(JSON.stringify({ level: "warn", op: "push.revoke-failed" }));
  }
};

/** Validate a device registration. Web Push endpoints must be public HTTPS (no SSRF targets). */
export const validateRegistration = (r: PushRegistration): string | null => {
  if (!["webpush", "apns", "fcm"].includes(r.kind)) return "unknown kind";

  if (r.kind === "webpush") {
    let url: URL;

    try {
      url = new URL(r.endpoint);
    } catch {
      return "invalid endpoint";
    }

    if (url.protocol !== "https:" || isForbiddenProxyTarget(r.endpoint))
      return "endpoint must be a public https URL";

    if (
      !r.p256dh ||
      !/^[A-Za-z0-9_-]{86,88}$/.test(r.p256dh) ||
      !r.auth ||
      !/^[A-Za-z0-9_-]{21,24}$/.test(r.auth)
    )
      return "missing or invalid keys";
  } else if (r.kind === "apns") {
    if (!/^[0-9a-f]{64,200}$/i.test(r.endpoint)) return "invalid device token";
  } else if (!/^[A-Za-z0-9:_-]{20,4096}$/.test(r.endpoint)) return "invalid registration token";

  return null;
};
