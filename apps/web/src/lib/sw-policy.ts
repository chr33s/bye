// Service-worker caching and notification policy, kept pure so it is testable outside a worker scope.
import { Predicate } from "effect";

/**
 * Injected by build.ts (rolldown `define`): the content hash of this build and its hashed shell
 * files. Absent when the module is imported directly (tests, type-checking), which falls back to
 * the unhashed development names.
 */
declare const __BYE_SHELL_BUILD__: string | undefined;

declare const __BYE_SHELL_ASSETS__: ReadonlyArray<string> | undefined;

const BUILD = typeof __BYE_SHELL_BUILD__ === "undefined" ? "dev" : __BYE_SHELL_BUILD__;

/** One cache per build: activating a new worker deletes every older shell cache. */
export const SHELL = `bye-shell-${BUILD}`;

/** The offline app shell: static assets only, never API routes or message content. */
export const ASSETS: ReadonlyArray<string> =
  typeof __BYE_SHELL_ASSETS__ === "undefined" || __BYE_SHELL_ASSETS__ === null
    ? ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon.svg"]
    : __BYE_SHELL_ASSETS__;

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

/** What a push message shows and opens (the server's `notify` payload, E23). */
export interface PushNotice {
  readonly title: string;
  readonly body: string;
  /** Same-origin URL a click opens. */
  readonly url: string;
  /** Replaces an earlier notification about the same thread or event. */
  readonly tag: string;
}

/** Only this app's own pages open from a notification; anything else opens the app root. */
export const clickTarget = (url: string, origin: string): string => {
  try {
    const target = new URL(url, origin);

    return target.origin === origin ? target.href : `${origin}/`;
  } catch {
    return `${origin}/`;
  }
};

const field = (value: Readonly<Record<string, string | number | boolean>>, key: string) => {
  const v = value[key];

  return Predicate.isString(v) ? v.slice(0, 500) : "";
};

/**
 * Decode a push payload. The payload is encrypted to this browser by its own server, but it is
 * still data: missing or malformed fields fall back to a generic notice rather than failing (a push
 * that shows nothing costs the site its permission in some browsers).
 */
export const pushNotice = (text: string | null, origin: string): PushNotice => {
  let value: Readonly<Record<string, string | number | boolean>> = {};

  try {
    const parsed = JSON.parse(text ?? "{}") as Readonly<Record<string, string | number | boolean>>;

    if (Predicate.isObject(parsed)) value = parsed;
  } catch {
    // generic notice below
  }

  return {
    title: field(value, "title") || "bye",
    body: field(value, "body") || "You have a new notification",
    url: clickTarget(field(value, "url") || "/", origin),
    tag: field(value, "collapseId") || field(value, "kind") || "bye",
  };
};
