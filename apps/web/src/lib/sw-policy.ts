// Service-worker caching policy, kept pure so it is testable outside a worker scope.

/**
 * Injected by build.ts (rolldown `define`): the content hash of this build and its hashed shell
 * files. Absent when the module is imported directly (tests, type-checking), which falls back to
 * the unhashed development names.
 */
declare const __BYE_SHELL_BUILD__: string | undefined;
declare const __BYE_SHELL_ASSETS__: ReadonlyArray<string> | undefined;

const BUILD = typeof __BYE_SHELL_BUILD__ === "string" ? __BYE_SHELL_BUILD__ : "dev";

/** One cache per build: activating a new worker deletes every older shell cache. */
export const SHELL = `bye-shell-${BUILD}`;

/** The offline app shell: static assets only, never API routes or message content. */
export const ASSETS: ReadonlyArray<string> =
  typeof __BYE_SHELL_ASSETS__ === "object" && __BYE_SHELL_ASSETS__ !== null
    ? __BYE_SHELL_ASSETS__
    : ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon.svg"];

/**
 * Worker-handled paths (the Worker's `runWorkerFirst` list plus well-known documents). Every one is
 * either authenticated, per-user or an API surface, so the service worker never answers them, not
 * even with the offline shell.
 */
export const PASS_THROUGH: ReadonlyArray<string> = [
  "/v1/",
  "/auth/",
  "/oauth/",
  "/render/",
  "/img",
  "/feeds/",
  "/webhooks/",
  "/.well-known/",
];

/**
 * Whether the worker answers a request (network first, shell cache as the offline fallback).
 * Writes, other origins and every Worker route (API, auth, render, downloads) pass straight through
 * and are never cached.
 */
export const servesFromShell = (method: string, url: string, origin: string): boolean => {
  const parsed = new URL(url);
  return (
    method === "GET" &&
    parsed.origin === origin &&
    !PASS_THROUGH.some((prefix) => parsed.pathname.startsWith(prefix))
  );
};

/** Message a waiting worker accepts to activate now (the page's "Reload" update prompt). */
export const SKIP_WAITING = "bye:skip-waiting";
