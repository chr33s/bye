// Service worker: the offline app shell and push notifications (E23). API responses and message
// content are never cached.
import {
  ASSETS,
  clickTarget,
  pushNotice,
  servesFromShell,
  SHELL,
  SKIP_WAITING,
} from "./lib/sw-policy.ts";

declare const self: ServiceWorkerGlobalScope;

// A new build installs alongside the running one and waits; the page offers "Reload" and posts
// SKIP_WAITING, so an open tab never mixes shell files from two builds.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll([...ASSETS])));
});

self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === SKIP_WAITING) void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (!servesFromShell(event.request.method, event.request.url, location.origin)) return;
  event.respondWith(
    fetch(event.request).catch(
      async () =>
        (await caches.match(event.request)) ??
        (event.request.mode === "navigate" ? await caches.match("/index.html") : undefined) ??
        Response.error(),
    ),
  );
});

// Push (E23): the payload is encrypted to this browser by its own server (RFC 8291). Every push
// shows a notification; a silent one would cost the site its push permission.
self.addEventListener("push", (event) => {
  const notice = pushNotice(event.data?.text() ?? null, location.origin);

  event.waitUntil(
    self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: notice.url },
    }),
  );
});

// Focus an open app window and route it to the notification's page, else open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | null;
  const url = clickTarget(data?.url ?? "/", location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === location.origin);

      if (open) {
        await open.focus();
        await open.navigate(url).catch(() => undefined);

        return;
      }

      await self.clients.openWindow(url);
    })(),
  );
});

interface SubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

// The push service rotated or expired the subscription: subscribe again with the same server key
// and re-register, so the device keeps receiving without a visit to Settings. The old endpoint is
// pruned by the server when it answers 404/410.
self.addEventListener("pushsubscriptionchange", ((event: SubscriptionChangeEvent) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options.applicationServerKey;

      const next =
        event.newSubscription ??
        (key
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            })
          : null);

      if (!next) return;
      const json = next.toJSON();

      await fetch("/v1/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "webpush",
          endpoint: json.endpoint,
          keys: json.keys,
          label: "Browser",
        }),
      });
    })().catch(() => undefined),
  );
}) as EventListener);
