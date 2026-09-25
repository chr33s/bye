// Service worker: offline app shell only. API responses and message content are never cached.
import { ASSETS, servesFromShell, SHELL, SKIP_WAITING } from "./lib/sw-policy.ts";

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
