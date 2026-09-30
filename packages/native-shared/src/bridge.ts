import { Predicate } from "effect";
import { nativeSecureStore, SecureStoreError, type SecureSessionStore } from "./auth/store.ts";
import type { DevicePushToken } from "./push.ts";
import type { WidgetSnapshot } from "./ui/platform.ts";

// What crosses the React Native bridge to the OS modules, kept free of react-native so it runs in
// Node tests. The shapes are pinned by packages/contracts/test/fixtures/native/*.json, which the
// Swift (ByeMobileTests) and Kotlin (app/src/test) suites read too, so neither side can drift.

/** The native modules drop a snapshot at or above this size (App Group / SharedPreferences). */
export const WIDGET_SNAPSHOT_MAX_BYTES = 16_384;

const nonEmpty = (value: unknown): value is string => Predicate.isString(value) && value !== "";

/**
 * ByePush.requestToken (ByePush.swift / ByePushModule.kt) answers the token as JSON; anything that
 * is not a complete APNs/FCM token with both Web Push keys is treated as "no token".
 */
export const decodePushToken = (raw: string | null | undefined): DevicePushToken | null => {
  if (!raw) return null;

  try {
    const t = JSON.parse(raw) as Partial<DevicePushToken> | null;

    return t &&
      (t.platform === "apns" || t.platform === "fcm") &&
      nonEmpty(t.token) &&
      nonEmpty(t.p256dh) &&
      nonEmpty(t.auth)
      ? {
          platform: t.platform,
          token: t.token,
          sandbox: t.sandbox === true,
          p256dh: t.p256dh,
          auth: t.auth,
        }
      : null;
  } catch {
    return null;
  }
};

/** The JSON ByeWidgetBridge.publish stores for the widget, or null when the widget would drop it. */
export const encodeWidgetSnapshot = (snapshot: WidgetSnapshot): string | null => {
  // Only the snapshot's own fields reach the App Group, in a fixed order.
  const wire = {
    nextEvent: snapshot.nextEvent
      ? { title: snapshot.nextEvent.title, startMs: snapshot.nextEvent.startMs }
      : null,
    timer: snapshot.timer
      ? { label: snapshot.timer.label, startedAtMs: snapshot.timer.startedAtMs }
      : null,
    unseen: snapshot.unseen,
  };

  const json = JSON.stringify(snapshot.server ? { ...wire, server: snapshot.server } : wire);

  return new TextEncoder().encode(json).byteLength < WIDGET_SNAPSHOT_MAX_BYTES ? json : null;
};

export interface NativeSecureStoreModule {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A missing native module is a build defect: surface it as unavailable storage, never plaintext. */
export const unavailableSecureStore: SecureSessionStore = {
  read: () => Promise.reject(new SecureStoreError("StorageUnavailable", "module-missing")),
  write: () => Promise.reject(new SecureStoreError("StorageUnavailable", "module-missing")),
  remove: async () => undefined,
};

/** The host's ByeSecureStore module wrapped with typed errors, or the unavailable store. */
export const hostSecureStore = (module: NativeSecureStoreModule | undefined): SecureSessionStore =>
  module ? nativeSecureStore(module) : unavailableSecureStore;
