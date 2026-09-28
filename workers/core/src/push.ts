import { Match } from "effect";
import { isForbiddenProxyTarget } from "@bye/mail-codec";
import {
  type ApnsConfig,
  type FcmServiceAccount,
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

const apnsConfig = (env: CoreEnv): ApnsConfig | null =>
  env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
    ? {
        privateKeyPem: env.APNS_KEY_P8,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        topic: env.APNS_TOPIC,
        production: !env.APP_ORIGIN.includes(".test"),
      }
    : null;

const fcmAccount = (env: CoreEnv): FcmServiceAccount | null => {
  if (!env.FCM_SERVICE_ACCOUNT) return null;

  try {
    return JSON.parse(env.FCM_SERVICE_ACCOUNT) as FcmServiceAccount;
  } catch {
    return null;
  }
};

type Sender = (device: PushDeviceRow, request: NotificationRequest) => Promise<PushResult | null>;

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
  const apns = apnsConfig(env);
  const fcm = fcmAccount(env);
  const f = fetchFn as never;

  return async (device, request) => {
    const note = {
      title: request.title,
      body: request.body,
      url: request.url,
      collapseId: request.resource,
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
          { ...note, kind: request.kind },
          vapid,
          {
            topic: request.resource,
            urgency: request.kind.startsWith("calendar.") ? "high" : "normal",
          },
        );
      case "apns":
        return apns ? sendApns(f, apns, device.endpoint, note) : null;
      case "fcm":
        return fcm ? sendFcm(f, fcm, device.endpoint, note) : null;
    }
  };
};

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

  const devices = await db
    .prepare(
      "SELECT id, user_id, kind, endpoint, p256dh, auth, label, created_at, last_success_at FROM push_devices WHERE user_id = ? AND enabled = 1 AND disabled_at IS NULL",
    )
    .bind(request.userId)
    .all<PushDeviceRow>();

  let delivered = 0;
  let retry = false;
  const now = Date.now();

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
}

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
