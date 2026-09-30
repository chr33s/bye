// Service worker wiring (E23): the handlers sw.ts registers, driven against a fake worker scope.
// The policy itself (what is cached, notice text, click targets) is covered in logic.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSETS, SHELL, SKIP_WAITING } from "../src/lib/sw-policy.ts";

const ORIGIN = "https://bye.example.test";

/** The event fields sw.ts reads, per event type. */
interface EventFields {
  readonly data?: { readonly type?: string } | null;
  readonly request?: { readonly method: string; readonly url: string; readonly mode: string };
  readonly notification?: {
    readonly close: () => void;
    readonly data: { readonly url?: string } | null;
  };
  readonly oldSubscription?: {
    readonly options: { readonly applicationServerKey: Uint8Array };
  } | null;
  readonly newSubscription?: null;
}

interface FakeEvent extends EventFields {
  readonly waitUntil: (p: Promise<unknown>) => void;
  readonly respondWith: (p: Promise<unknown>) => void;
}

type Handler = (event: FakeEvent) => void;

interface Scope {
  handlers: Map<string, Handler>;
  cache: { addAll: ReturnType<typeof vi.fn> };
  caches: Record<"open" | "keys" | "delete" | "match", ReturnType<typeof vi.fn>>;
  clients: Record<"claim" | "matchAll" | "openWindow", ReturnType<typeof vi.fn>>;
  registration: {
    showNotification: ReturnType<typeof vi.fn>;
    pushManager: { subscribe: ReturnType<typeof vi.fn> };
  };
  skipWaiting: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

let scope: Scope;

// A non-literal specifier keeps sw.ts (WebWorker lib, tsconfig.sw.json) out of this DOM program.
const SW = "../src/sw.ts";

beforeEach(async () => {
  vi.resetModules();
  const handlers = new Map<string, Handler>();
  const cache = { addAll: vi.fn(async () => undefined) };

  scope = {
    handlers,
    cache,
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => [SHELL, "bye-shell-old", "other"]),
      delete: vi.fn(async () => true),
      match: vi.fn(async () => undefined),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    },
    registration: {
      showNotification: vi.fn(async () => undefined),
      pushManager: { subscribe: vi.fn() },
    },
    skipWaiting: vi.fn(async () => undefined),
    fetch: vi.fn(),
  };

  vi.stubGlobal("self", {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: scope.skipWaiting,
    clients: scope.clients,
    registration: scope.registration,
  });
  vi.stubGlobal("caches", scope.caches);
  vi.stubGlobal("location", new URL(`${ORIGIN}/sw.js`));
  vi.stubGlobal("fetch", scope.fetch);
  await import(/* @vite-ignore */ SW);
});

/** Dispatch an extendable event and wait for everything it handed to waitUntil/respondWith. */
const dispatch = async (type: string, fields: EventFields = {}) => {
  const pending: Array<Promise<unknown>> = [];

  const event: FakeEvent = {
    ...fields,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    respondWith: (p: Promise<unknown>) => void pending.push(p),
  };

  scope.handlers.get(type)!(event);

  const results = await Promise.all(pending);

  return { responded: results[0], waited: pending.length > 0 };
};

describe("service worker", () => {
  it("[E23] precaches the shell on install and drops other caches on activate", async () => {
    await dispatch("install");
    expect(scope.caches.open).toHaveBeenCalledWith(SHELL);
    expect(scope.cache.addAll).toHaveBeenCalledWith([...ASSETS]);

    await dispatch("activate");
    expect(scope.caches.delete.mock.calls.map(([k]) => k)).toEqual(["bye-shell-old", "other"]);
    expect(scope.clients.claim).toHaveBeenCalledOnce();
  });

  it("activates a waiting build only when the page asks", async () => {
    await dispatch("message", { data: { type: "other" } });
    await dispatch("message", { data: null });
    expect(scope.skipWaiting).not.toHaveBeenCalled();

    await dispatch("message", { data: { type: SKIP_WAITING } });
    expect(scope.skipWaiting).toHaveBeenCalledOnce();
  });

  it("never intercepts API requests", async () => {
    const { waited } = await dispatch("fetch", {
      request: { method: "GET", url: `${ORIGIN}/v1/me`, mode: "cors" },
    });

    expect(waited).toBe(false);
    expect(scope.fetch).not.toHaveBeenCalled();
  });

  it("serves the network first, then the cached shell for an offline navigation", async () => {
    const live = new Response("live");
    scope.fetch.mockResolvedValueOnce(live);
    const request = { method: "GET", url: `${ORIGIN}/`, mode: "navigate" };
    expect((await dispatch("fetch", { request })).responded).toBe(live);

    const shell = new Response("shell");
    scope.fetch.mockRejectedValueOnce(new TypeError("offline"));
    scope.caches.match.mockImplementation(async (key: string) =>
      key === "/index.html" ? shell : undefined,
    );
    expect((await dispatch("fetch", { request })).responded).toBe(shell);
  });

  it("answers a network error when an offline asset is not cached", async () => {
    scope.fetch.mockRejectedValueOnce(new TypeError("offline"));

    const { responded } = await dispatch("fetch", {
      request: { method: "GET", url: `${ORIGIN}/styles.css`, mode: "no-cors" },
    });

    expect((responded as Response).type).toBe("error");
  });

  it("[E23] shows a notification for every push, even an unreadable one", async () => {
    await dispatch("push", { data: null });
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ icon: "/icon-192.png", data: { url: expect.any(String) } }),
    );
  });

  it("focuses and routes an open window on click, else opens one", async () => {
    const open = {
      url: `${ORIGIN}/#/mail/imbox`,
      focus: vi.fn(async () => undefined),
      navigate: vi.fn(async () => Promise.reject(new Error("uncontrolled"))),
    };

    const close = vi.fn();
    scope.clients.matchAll.mockResolvedValueOnce([
      { url: "https://elsewhere.test/", focus: vi.fn() },
      open,
    ]);
    await dispatch("notificationclick", {
      notification: { close, data: { url: `${ORIGIN}/#/thread/t1` } },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(open.focus).toHaveBeenCalledOnce();
    expect(open.navigate).toHaveBeenCalledWith(`${ORIGIN}/#/thread/t1`);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();

    await dispatch("notificationclick", { notification: { close, data: null } });
    expect(scope.clients.openWindow).toHaveBeenCalledOnce();
  });

  it("re-subscribes with the old server key and re-registers after a rotation", async () => {
    const key = new Uint8Array([1, 2, 3]);
    scope.registration.pushManager.subscribe.mockResolvedValueOnce({
      toJSON: () => ({ endpoint: "https://push.test/new", keys: { p256dh: "p", auth: "a" } }),
    });
    scope.fetch.mockResolvedValueOnce(new Response("{}"));
    await dispatch("pushsubscriptionchange", {
      oldSubscription: { options: { applicationServerKey: key } },
      newSubscription: null,
    });

    expect(scope.registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    const [url, init] = scope.fetch.mock.calls[0]!;
    expect(url).toBe("/v1/push/subscriptions");
    expect(JSON.parse(init.body)).toEqual({
      kind: "webpush",
      endpoint: "https://push.test/new",
      keys: { p256dh: "p", auth: "a" },
      label: "Browser",
    });
  });

  it("does nothing on a rotation without an old key or a new subscription", async () => {
    await dispatch("pushsubscriptionchange", { oldSubscription: null, newSubscription: null });

    expect(scope.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(scope.fetch).not.toHaveBeenCalled();
  });
});
