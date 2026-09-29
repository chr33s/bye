import type { SessionClient } from "../auth/session.ts";
import type { KeyValueStore } from "../drafts.ts";
import type { ProbeFetch, ValidatedInstance } from "../instance/discovery.ts";
import type { DevicePushToken } from "../push.ts";

/**
 * Native capabilities each host (iOS, Android, macOS, Windows) supplies to the shared app. The
 * server is runtime configuration: nothing here names an instance. Every entry point (deep links,
 * share, widgets) is resolved against the explicitly selected instance/account by the shared app.
 */
export interface Platform {
  readonly name: "ios" | "android" | "macos" | "windows";
  /** Non-secret app storage: the instance registry and per-instance/account scoped state. */
  readonly storage: KeyValueStore;
  /** The OAuth client this build is registered as, and its one approved callback. */
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * The device's drafts key, kept in the OS secure store (created on first use). When present,
   * drafts and other scoped state are sealed before they reach `storage`; absent only in tests.
   */
  readonly draftKey?: () => Promise<Uint8Array>;
  /** Credential-free fetch for instance validation (no cookies, no auth headers). */
  readonly probeFetch: ProbeFetch;
  /**
   * Device session for one validated instance (every host): browser passkey sign-in with PKCE; the
   * access token stays in memory and the rotating refresh credential lives in the OS secure store
   * (Keychain on iOS/macOS, Android Keystore, Windows Credential Manager). Absent only in tests.
   */
  readonly createSession?: (instance: ValidatedInstance) => SessionClient;
  /** Open an https page (instance support/deletion) in the system browser. */
  readonly openUrl?: (url: string) => Promise<void>;
  /** Extra deep-link source where React Native's Linking isn't wired (Windows protocol activation). */
  readonly urls?: {
    initial(): Promise<string | null>;
    subscribe(listener: (url: string) => void): () => void;
  };
  /** Publish a snapshot for home-screen widgets (iOS WidgetKit, Android App Widgets); optional. */
  readonly widgets?: {
    publish(snapshot: WidgetSnapshot): void;
    takePendingShare(): Promise<string | null>;
  };
  /** OS notifications (APNs on iOS, FCM on Android) through Bye's push gateway; optional. */
  readonly push?: PushBridge;
}

export interface PushBridge {
  /** Shown in the account's list of devices receiving push (e.g. "iPhone app"). */
  readonly label: string;
  /**
   * Ask for notification permission (the OS prompts once) and answer the device token with this
   * device's Web Push keys; null when the user declined or the OS has no push service.
   */
  requestToken(): Promise<DevicePushToken | null>;
  /** The OS rotated the token: registrations should be refreshed. */
  onTokenRefresh(listener: () => void): () => void;
  /** The URL of a notification whose tap launched the app, once. */
  initialOpen(): Promise<string | null>;
  /** The URL of a notification tapped while the app runs. */
  onOpen(listener: (url: string) => void): () => void;
}

export interface WidgetSnapshot {
  readonly nextEvent: { readonly title: string; readonly startMs: number } | null;
  readonly timer: { readonly label: string; readonly startedAtMs: number } | null;
  readonly unseen: number;
  /** The server the snapshot came from; widgets show it so data is never attributed elsewhere. */
  readonly server?: string;
}
