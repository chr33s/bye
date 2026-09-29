import AsyncStorage from "@react-native-async-storage/async-storage";
import { Linking, NativeModules } from "react-native";
import {
  CUSTOM_SCHEME_REDIRECT,
  DESKTOP_CLIENT_ID,
  nativeSecureStore,
  SecureStoreError,
  type SecureSessionStore,
  SessionClient,
} from "../auth/index.ts";
import { secureStoreKey } from "../sealed-store.ts";
import type { Platform } from "./platform.ts";

export type { Platform, WidgetSnapshot } from "./platform.ts";

// The host adapter every native shell shares (spec §10 device sessions, X01).
// Sign-in is the device-session flow against the *selected* instance: the system browser runs the
// passkey ceremony on that instance's web origin and returns a single-use authorization code to
// bye://oauth/callback (PKCE, RFC 8252; issuer-checked, RFC 9207). The access token stays in
// memory; the rotating refresh credential is kept by the native ByeSecureStore module (Keychain on
// iOS/macOS, Android Keystore, Windows Credential Manager), one slot per instance. No cookie jar,
// no plaintext. Each app supplies only what is OS-specific: its name, device label, client and
// bridges. No server address is compiled in beyond the hosted default offered on first use.

interface NativeSecureStoreModule {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A missing native module is a build defect: surface it as unavailable storage, never plaintext. */
const unavailableStore: SecureSessionStore = {
  read: () => Promise.reject(new SecureStoreError("StorageUnavailable", "module-missing")),
  write: () => Promise.reject(new SecureStoreError("StorageUnavailable", "module-missing")),
  remove: async () => undefined,
};

export interface NativeHostOptions {
  readonly name: Platform["name"];
  /** Shown in the account's device list (e.g. "iPhone app"). */
  readonly deviceName: string;
  /** OAuth client; omitted means the desktop client. */
  readonly clientId?: string;
  readonly widgets?: Platform["widgets"];
  readonly urls?: Platform["urls"];
  readonly push?: Platform["push"];
}

export const makeNativePlatform = (options: NativeHostOptions): Platform => {
  const secure = NativeModules.ByeSecureStore as NativeSecureStoreModule | undefined;
  const store = secure ? nativeSecureStore(secure) : unavailableStore;
  const clientId = options.clientId ?? DESKTOP_CLIENT_ID;
  return {
    name: options.name,
    // Registry, drafts and UI preferences only; credentials never go to AsyncStorage, and drafts
    // are sealed with a key held in the secure store (sealed-store.ts) before they get there.
    storage: AsyncStorage,
    draftKey: secureStoreKey(store),
    clientId,
    redirectUri: CUSTOM_SCHEME_REDIRECT,
    probeFetch: (url, init) => fetch(url, init as RequestInit),
    createSession: (instance) =>
      new SessionClient({
        instance,
        clientId,
        redirectUri: CUSTOM_SCHEME_REDIRECT,
        deviceName: options.deviceName,
        fetch: (url, init) => fetch(url, init as RequestInit),
        store,
        openBrowser: async (url) => {
          await Linking.openURL(url);
        },
      }),
    openUrl: async (url) => {
      await Linking.openURL(url);
    },
    ...(options.widgets ? { widgets: options.widgets } : {}),
    ...(options.urls ? { urls: options.urls } : {}),
    ...(options.push ? { push: options.push } : {}),
  };
};
