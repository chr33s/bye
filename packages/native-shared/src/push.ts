import { ByeApiError, type ByeClient, type FetchLike } from "./client.ts";
import type { KeyValueStore } from "./drafts.ts";
import type { ValidatedInstance } from "./instance/discovery.ts";

// Native push registration (E23, spec P1.7). The app's APNs/FCM credentials live only in Bye's
// push gateway, so a device reaches every instance — hosted or self-hosted — the same way:
//
//   1. the OS bridge returns the device token plus this device's Web Push keys (RFC 8291; the
//      private key never leaves the OS keystore, where the notification extension/service reads it);
//   2. the gateway turns the token into a sealed Web Push endpoint bound to this instance's VAPID key;
//   3. the instance stores it as an ordinary Web Push subscription, bound to this device session.
//
// Instances then encrypt to the device and the gateway relays ciphertext. Sign-out or removing the
// server revokes the session, and the server drops the registration with it.

/** Bye's push gateway (workers/push-gateway). Not an instance setting: it holds the app's keys. */
export const PUSH_GATEWAY_URL = "https://push.bye.software";

/** What the native push bridge (ByePush on iOS and Android) answers once permission is granted. */
export interface DevicePushToken {
  readonly platform: "apns" | "fcm";
  readonly token: string;
  /** An APNs token from the sandbox environment (development-signed builds). */
  readonly sandbox: boolean;
  /** This device's Web Push public key and auth secret, base64url. */
  readonly p256dh: string;
  readonly auth: string;
}

/** Per-account record of this device's registration, in the account's scoped store. */
const REGISTRATION_KEY = "push:registration";

/** Whether the user turned notifications on for this account on this device. */
const ENABLED_KEY = "push:enabled";

interface StoredRegistration {
  readonly id: string;
  /**
   * What was registered: token, keys and the instance's VAPID key. A new token, new keys or a
   * redeployed instance key registers again.
   */
  readonly fingerprint: string;
}

const fingerprint = (t: DevicePushToken, vapidKey: string) =>
  `${t.platform}:${t.sandbox ? 1 : 0}:${t.token}:${t.p256dh}:${vapidKey}`;

const readStored = async (store: KeyValueStore): Promise<StoredRegistration | null> => {
  try {
    const raw = await store.getItem(REGISTRATION_KEY);

    return raw ? (JSON.parse(raw) as StoredRegistration) : null;
  } catch {
    return null;
  }
};

// One registration change at a time per account store: a token refresh racing the Settings switch
// would otherwise register twice and orphan one registration (duplicate notifications).
const queues = new WeakMap<KeyValueStore, Promise<void>>();

const serial = <T>(store: KeyValueStore, run: () => Promise<T>): Promise<T> => {
  const next = (queues.get(store) ?? Promise.resolve()).then(run, run);
  queues.set(
    store,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
};

const notFound = (error: Error | ByeApiError) =>
  error instanceof ByeApiError && error.status === 404;

/**
 * Whether the server still has this registration enabled. It can drop one without the device
 * knowing (removed from another device's settings, disabled after the push service answered
 * gone). Unreachable counts as present: an offline launch must not churn registrations.
 */
const liveOnServer = async (client: ByeClient, id: string): Promise<boolean> => {
  try {
    return (await client.pushDevices()).items.some((d) => d.id === id && d.enabled);
  } catch {
    return true;
  }
};

export const pushEnabled = async (store: KeyValueStore): Promise<boolean> =>
  (await store.getItem(ENABLED_KEY).catch(() => null)) === "1";

export type PushRegistrationOutcome =
  | { readonly _tag: "Registered"; readonly id: string }
  | { readonly _tag: "Unchanged"; readonly id: string }
  /** The server has no Web Push key configured. */
  | { readonly _tag: "Unsupported" };

export class PushGatewayError extends Error {
  override readonly name = "PushGatewayError";

  constructor(readonly status: number) {
    super(`The push service couldn't register this device (${status}).`);
  }
}

export interface PushRegistrationDeps {
  readonly client: ByeClient;
  /** The account's scoped store (cleared with the account on sign-out). */
  readonly store: KeyValueStore;
  /** Credential-free fetch for the gateway: it never sees an instance credential. */
  readonly gatewayFetch: FetchLike;
  readonly gateway?: string;
  /** Shown in the account's device list. */
  readonly label: string;
}

/**
 * Register this device with the signed-in instance through the gateway. Idempotent: when the
 * token, keys and instance key are unchanged and the server still has the registration, it is kept.
 */
export const registerDevicePush = (
  deps: PushRegistrationDeps,
  token: DevicePushToken,
): Promise<PushRegistrationOutcome> =>
  serial(deps.store, async (): Promise<PushRegistrationOutcome> => {
    let vapidKey: string;

    try {
      vapidKey = (await deps.client.pushVapidKey()).publicKey;
    } catch (error) {
      if (error instanceof ByeApiError && error.status === 404) return { _tag: "Unsupported" };
      throw error;
    }

    const print = fingerprint(token, vapidKey);
    const stored = await readStored(deps.store);

    if (stored && stored.fingerprint === print && (await liveOnServer(deps.client, stored.id)))
      return { _tag: "Unchanged", id: stored.id };

    const gateway = deps.gateway ?? PUSH_GATEWAY_URL;

    const response = await deps.gatewayFetch(`${gateway}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: token.platform,
        token: token.token,
        sandbox: token.sandbox,
        vapidKey,
      }),
      credentials: "omit",
      redirect: "error",
    });

    if (response.status !== 201) throw new PushGatewayError(response.status);
    const { endpoint } = JSON.parse(await response.text()) as { endpoint: string };

    if (!endpoint.startsWith(`${gateway}/`)) throw new PushGatewayError(502);

    const { id } = await deps.client.registerPush({
      kind: "webpush",
      endpoint,
      keys: { p256dh: token.p256dh, auth: token.auth },
      label: deps.label,
    });

    // Replacing a registration (new token, keys or instance key): the old one stops at once.
    if (stored && stored.id !== id) await deps.client.removePush(stored.id).catch(() => undefined);

    await deps.store.setItem(
      REGISTRATION_KEY,
      JSON.stringify({ id, fingerprint: print } satisfies StoredRegistration),
    );

    await deps.store.setItem(ENABLED_KEY, "1");

    return { _tag: "Registered", id };
  });

/**
 * Turn notifications off for this account on this device (the OS permission is left alone). A
 * registration the server already dropped counts as removed.
 */
export const unregisterDevicePush = (client: ByeClient, store: KeyValueStore): Promise<void> =>
  serial(store, async () => {
    const stored = await readStored(store);

    if (stored)
      await client.removePush(stored.id).catch((error: Error) => {
        if (!notFound(error)) throw error;
      });

    await store.removeItem(REGISTRATION_KEY);
    await store.removeItem(ENABLED_KEY);
  });

/** Where a tapped notification leads: which saved server, and the hash route there. */
export interface NotificationTarget {
  readonly instanceKey: string;
  /** Hash route, e.g. `#/thread/thr_1` (for `parseRoute`). */
  readonly route: string;
}

/**
 * Resolve a notification's URL (`https://<instance>/#/<route>`) against the saved servers. A URL
 * for a server that isn't saved on this device opens nothing: a notification never adds a server
 * or picks a different account than the one that registered.
 */
export const notificationTarget = (
  url: string,
  saved: ReadonlyArray<ValidatedInstance>,
): NotificationTarget | null => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  const instance = saved.find((i) => new URL(i.baseUrl).origin === parsed.origin);

  if (!instance) return null;

  return {
    instanceKey: instance.key,
    route: parsed.hash.startsWith("#/") ? parsed.hash : "#/",
  };
};
