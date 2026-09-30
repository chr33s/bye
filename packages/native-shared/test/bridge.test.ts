import { describe, expect, it } from "vitest";
import pushToken from "../../contracts/test/fixtures/native/push-token.json" with { type: "json" };
import shareHandoff from "../../contracts/test/fixtures/native/share-handoff.json" with { type: "json" };
import webpush from "../../contracts/test/fixtures/native/webpush.json" with { type: "json" };
import widget from "../../contracts/test/fixtures/native/widget-snapshot.json" with { type: "json" };
import {
  decryptWebPush,
  encryptWebPush,
} from "../../platform-cloudflare/src/transport/push/webpush.ts";
import { SecureStoreError, sessionKey } from "../src/auth/store.ts";
import {
  decodePushToken,
  encodeWidgetSnapshot,
  hostSecureStore,
  type NativeSecureStoreModule,
  WIDGET_SNAPSHOT_MAX_BYTES,
} from "../src/bridge.ts";
import { deepLinkToRoute } from "../src/deeplink.ts";
import { secureStoreKey } from "../src/sealed-store.ts";
import type { WidgetSnapshot } from "../src/ui/platform.ts";
import { testInstance } from "./fixtures.ts";

// The JS half of the native bridge contracts in packages/contracts/test/fixtures/native. The Swift
// (ByeMobileTests) and Kotlin (app/src/test) suites assert the native half against the same files.

const fromB64u = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

describe("push token bridge (ByePush.requestToken)", () => {
  it.each(pushToken.produced)("[E23] reads what native emits: $name", ({ expected }) => {
    expect(decodePushToken(JSON.stringify(expected))).toEqual(expected);
  });

  it.each(pushToken.decoded)("[E23] normalizes: $name", ({ raw, expected }) => {
    expect(decodePushToken(raw)).toEqual(expected);
  });

  it.each(pushToken.invalid)("[E23] treats as no token: $name", ({ raw }) => {
    expect(decodePushToken(raw)).toBeNull();
  });
});

describe("widget snapshot bridge (ByeWidgetBridge.publish)", () => {
  it.each(widget.cases)("[C10] publishes the pinned JSON: $name", ({ snapshot, json }) => {
    expect(encodeWidgetSnapshot(snapshot as WidgetSnapshot)).toBe(json);
  });

  it("[C10] drops extra fields so nothing but the snapshot reaches the App Group", () => {
    // A value with more than the snapshot, as a caller holding a richer object might pass.
    const snapshot = {
      nextEvent: { title: "Standup", startMs: 1, attendees: ["a@bye.test"] },
      timer: null,
      unseen: 0,
      token: "secret",
    };

    expect(encodeWidgetSnapshot(snapshot)).toBe(
      '{"nextEvent":{"title":"Standup","startMs":1},"timer":null,"unseen":0}',
    );
  });

  it("[C10] refuses a snapshot the native side would silently drop", () => {
    expect(widget.maxBytes).toBe(WIDGET_SNAPSHOT_MAX_BYTES);
    // Multi-byte titles: the limit is UTF-8 bytes (iOS checks utf8.count), not UTF-16 length.
    const title = "☕".repeat(Math.ceil(WIDGET_SNAPSHOT_MAX_BYTES / 3));

    expect(
      encodeWidgetSnapshot({ nextEvent: { title, startMs: 0 }, timer: null, unseen: 0 }),
    ).toBeNull();
  });
});

describe("share handoff (iOS Share Extension → takePendingShare)", () => {
  it.each(shareHandoff.cases)(
    "[X01] routes the handoff link: $name",
    ({ link, route, text, url }) => {
      expect(deepLinkToRoute(link)).toBe(route);
      const params = new URLSearchParams(route.split("?")[1] ?? "");

      expect(params.get("text")).toBe(text);
      expect(params.get("url")).toBe(url);
    },
  );
});

describe("Web Push fixtures (native decryptors)", () => {
  const v = webpush.rfc8291;

  const receiver = {
    publicKey: fromB64u(v.uaPublic),
    privateKey: fromB64u(v.uaPrivate),
    auth: fromB64u(v.auth),
  };

  it("[E23] the Appendix A vector decrypts with the server's own decryptor", async () => {
    expect(new TextDecoder().decode(await decryptWebPush(receiver, fromB64u(v.body)))).toBe(
      v.plaintext,
    );
  });

  it.each(webpush.notices)(
    "[E23] the gateway payload is what the server encrypts: $name",
    async ({ payload, salt, message }) => {
      const encrypted = await encryptWebPush(
        { p256dh: v.uaPublic, auth: v.auth },
        new TextEncoder().encode(JSON.stringify(payload)),
        {
          salt: fromB64u(salt),
          serverKeys: { publicKey: fromB64u(v.asPublic), privateKey: fromB64u(v.asPrivate) },
        },
      );

      expect(b64u(encrypted)).toBe(message);
    },
  );
});

const memoryModule = () => {
  const data = new Map<string, string>();

  const module: NativeSecureStoreModule = {
    read: async (key) => {
      const value = data.get(key);

      if (value === undefined)
        throw Object.assign(new Error("missing"), { code: "MissingCredential" });

      return value;
    },
    write: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };

  return { data, module };
};

describe("host secure store (ByeSecureStore)", () => {
  it("[DS05] a missing native module is unavailable storage, never a plaintext fallback", async () => {
    const store = hostSecureStore(undefined);

    await expect(store.read("k")).rejects.toMatchObject({
      name: "SecureStoreError",
      kind: "StorageUnavailable",
      nativeCode: "module-missing",
    });
    await expect(store.write("k", "v")).rejects.toBeInstanceOf(SecureStoreError);
    await expect(store.remove("k")).resolves.toBeUndefined();
    // The drafts key lives in the same store: it can't be created, so drafts are never sealed
    // with a key that isn't in the OS keychain.
    await expect(secureStoreKey(store)()).rejects.toMatchObject({ kind: "StorageUnavailable" });
  });

  it("[DS05] native rejections keep their kind and sanitized code", async () => {
    const store = hostSecureStore({
      read: () =>
        Promise.reject(
          Object.assign(new Error("keychain StorageDenied (-34018)"), {
            code: "StorageDenied",
            userInfo: { nativeCode: "-34018" },
          }),
        ),
      write: () => Promise.reject(Object.assign(new Error("?"), { code: "SomethingElse" })),
      remove: async () => undefined,
    });

    await expect(store.read("k")).rejects.toMatchObject({
      kind: "StorageDenied",
      nativeCode: "-34018",
    });
    await expect(store.write("k", "v")).rejects.toMatchObject({ kind: "StorageUnavailable" });
  });

  it("[DS02] each instance gets its own credential slot in the one native store", async () => {
    const { data, module } = memoryModule();
    const store = hostSecureStore(module);
    const a = sessionKey(testInstance("https://a.bye.test").key);
    const b = sessionKey(testInstance("https://b.bye.test").key);
    // Same base URL, different issuer: still a different slot.
    const c = sessionKey(testInstance("https://a.bye.test", "https://issuer.bye.test").key);

    expect(new Set([a, b, c]).size).toBe(3);
    await store.write(a, "credential-a");
    await store.write(b, "credential-b");

    expect(await store.read(a)).toBe("credential-a");
    expect(await store.read(b)).toBe("credential-b");
    await expect(store.read(c)).rejects.toMatchObject({ kind: "MissingCredential" });

    await store.remove(a);
    expect([...data.keys()]).toEqual([b]);
  });
});
