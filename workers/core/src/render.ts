import {
  isForbiddenProxyTarget,
  sanitizeHtml,
  signProxyUrl,
  verifyProxyUrl,
} from "@bye/mail-codec";
import { blobKey, ingestionIdOf } from "@bye/application";
import { escapeHtml } from "@bye/domain";
import { mint, purposeOf, verify } from "./capability.ts";
import { type DohFetch, forbiddenResolution, readCapped } from "./dns.ts";
import type { CoreEnv } from "./env.ts";
import { sniffRaster } from "./images.ts";
import { bodyKeyFor, type StoredBody } from "./objects.ts";
import { mailbox } from "./authorities.ts";

// Separate render origin (§10): message HTML is served only on MAIL_ORIGIN, inside a sandboxed
// iframe, with no app cookies, no script, and images only via the signed proxy. Render tokens
// are short-lived HMAC capabilities minted after an authorized thread read.

export const RENDER_TOKEN_TTL_MS = 5 * 60_000;

const RENDER_CSP =
  "default-src 'none'; img-src 'self' data: cid:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors";

// Render-origin capabilities (see capability.ts): short-lived, minted only after an authorized
// read, each bound to its purpose and to the exact mailbox/delivery/part it grants.

/** The message document for one delivery. */
export const renderToken = (
  env: Pick<CoreEnv, "PROXY_SIGNING_KEY">,
  mailboxId: string,
  deliveryId: string,
  now: number,
) => mint(env.PROXY_SIGNING_KEY, "render", [mailboxId, deliveryId], RENDER_TOKEN_TTL_MS, now);

/** A sandboxed attachment preview (E20). */
export const previewToken = (
  env: Pick<CoreEnv, "PROXY_SIGNING_KEY">,
  mailboxId: string,
  deliveryId: string,
  partId: string,
  now: number,
) =>
  mint(env.PROXY_SIGNING_KEY, "preview", [mailboxId, deliveryId, partId], RENDER_TOKEN_TTL_MS, now);

/**
 * An attachment download for clients that cannot attach credentials to a link they open (native
 * apps handing off to the OS). Scan status is re-checked when the link is used (E20).
 */
export const downloadToken = (
  env: Pick<CoreEnv, "PROXY_SIGNING_KEY">,
  mailboxId: string,
  deliveryId: string,
  partId: string,
  now: number,
) =>
  mint(
    env.PROXY_SIGNING_KEY,
    "download",
    [mailboxId, deliveryId, partId],
    RENDER_TOKEN_TTL_MS,
    now,
  );

/** An inline (`cid:`) part of a message being rendered; the part key must be in that mailbox. */
const inlineToken = (
  env: Pick<CoreEnv, "PROXY_SIGNING_KEY">,
  mailboxId: string,
  partKey: string,
  now: number,
) => mint(env.PROXY_SIGNING_KEY, "inline", [mailboxId, partKey], RENDER_TOKEN_TTL_MS, now);

const INLINE_MAX_BYTES = 10 * 1024 * 1024;

const handleInline = async (env: CoreEnv, token: string): Promise<Response> => {
  const fields = await verify(env.PROXY_SIGNING_KEY, "inline", token, 2, Date.now());

  // Defense in depth: a token can only ever name an object in its own mailbox's namespace.
  if (!fields || !fields[1]!.startsWith(`t/${fields[0]}/`))
    return new Response("expired", { status: 403 });
  const object = await env.PARTS.get(fields[1]!);

  if (!object) return new Response("not found", { status: 404 });

  if (object.size > INLINE_MAX_BYTES) return new Response("too large", { status: 413 });
  const bytes = new Uint8Array(await object.arrayBuffer());
  const type = sniffRaster(bytes);

  if (!type) return new Response("not an image", { status: 415 });

  return new Response(bytes, {
    headers: {
      "content-type": type,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
    },
  });
};

/** A part-granting capability's claims (preview/download). */
const partClaims = async (env: CoreEnv, purpose: "preview" | "download", token: string) => {
  const fields = await verify(env.PROXY_SIGNING_KEY, purpose, token, 3, Date.now());

  return fields ? { mailboxId: fields[0]!, deliveryId: fields[1]!, partId: fields[2]! } : null;
};

const handleDownload = async (env: CoreEnv, token: string): Promise<Response> => {
  const claims = await partClaims(env, "download", token);

  if (!claims) return new Response("expired", { status: 403 });
  const a = await mailbox(env, claims.mailboxId).attachmentFor(claims.deliveryId, claims.partId);

  if (!a) return new Response("not found", { status: 404 });

  if (!a.access.allowed) return new Response("blocked", { status: 403 });

  const object = await env.PARTS.get(
    blobKey.part(claims.mailboxId, ingestionIdOf(a.messageKey), claims.partId),
  );

  if (!object) return new Response("not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      "content-length": String(object.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
};

const PREVIEW_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/i;

const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Sandboxed preview: only clean-scanned attachments, only raster images and plain text, served on
 * the separate render origin with a no-script CSP (§10). Everything else is download-only.
 */
const handlePreview = async (env: CoreEnv, token: string): Promise<Response> => {
  const claims = await partClaims(env, "preview", token);

  if (!claims) return new Response("expired", { status: 403 });
  const a = await mailbox(env, claims.mailboxId).attachmentFor(claims.deliveryId, claims.partId);

  if (!a) return new Response("not found", { status: 404 });

  if (!a.access.allowed) return new Response("blocked", { status: 403 });

  if (a.size > PREVIEW_MAX_BYTES) return new Response("too large to preview", { status: 413 });

  const object = await env.PARTS.get(
    blobKey.part(claims.mailboxId, ingestionIdOf(a.messageKey), claims.partId),
  );

  if (!object) return new Response("not found", { status: 404 });
  const type = a.contentType.split(";")[0]!.trim().toLowerCase();

  const headers = {
    "content-security-policy":
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
  };

  if (PREVIEW_IMAGE.test(type))
    return new Response(object.body, { headers: { ...headers, "content-type": type } });

  if (type === "text/plain" || type === "text/csv" || type === "text/markdown") {
    const text = (await object.text()).slice(0, 1_000_000);
    const escaped = escapeHtml(text);

    return new Response(
      `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;margin:12px">${escaped}</pre>`,
      {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      },
    );
  }

  return new Response("preview not available for this type", { status: 415 });
};

export const handleRender = async (
  request: Request,
  env: CoreEnv,
  token: string,
): Promise<Response> => {
  switch (purposeOf(token)) {
    case "preview":
      return handlePreview(env, token);
    case "download":
      return handleDownload(env, token);
    case "inline":
      return handleInline(env, token);
  }

  const fields = await verify(env.PROXY_SIGNING_KEY, "render", token, 2, Date.now());

  if (!fields) return new Response("expired", { status: 403 });
  const claims = { mailboxId: fields[0]!, deliveryId: fields[1]! };
  const stub = mailbox(env, claims.mailboxId);
  const renderable = await stub.renderable(claims.deliveryId);

  if (!renderable) return new Response("not found", { status: 404 });
  const object = await env.PARTS.get(bodyKeyFor(renderable.messageKey));

  const stored = object
    ? ((await object.json()) as StoredBody)
    : { text: "", html: null, remoteImages: 0, blockedTrackers: 0 };

  let html: string;

  if (stored.html !== null) {
    // Re-sanitize at render time with the viewer's remote-image preference and signed proxy URLs.
    const rendered = await rewriteImages(
      stored.html,
      env,
      renderable.remoteImages,
      claims.mailboxId,
      stored.inline ?? {},
    );

    html = rendered;
  } else {
    html = `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(stored.text)}</pre>`;
  }

  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><body style="font:15px/1.5 system-ui,sans-serif;margin:12px">${html}</body>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${RENDER_CSP} ${env.APP_ORIGIN}`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "cross-origin-resource-policy": "same-origin",
      },
    },
  );
};

const rewriteImages = async (
  html: string,
  env: CoreEnv,
  allowRemote: boolean,
  mailboxId: string,
  inline: Readonly<Record<string, string>>,
): Promise<string> => {
  // Collect remote URLs and cid references first (sanitizer callbacks are synchronous), sign
  // them, then re-run. Inline parts are always shown: they are part of the message, not remote.
  const urls: Array<string> = [];
  const cids: Array<string> = [];
  sanitizeHtml(html, {
    proxyImage: (url) => (urls.push(url), null),
    cid: (id) => (cids.push(id), null),
    blockRemoteImages: false,
  });
  const inlineUrls = new Map<string, string>();
  const now = Date.now();

  for (const id of [...new Set(cids)].slice(0, 100)) {
    const partKey = Object.hasOwn(inline, id) ? inline[id] : undefined;

    if (partKey)
      inlineUrls.set(
        id,
        `${env.MAIL_ORIGIN}/render/${await inlineToken(env, mailboxId, partKey, now)}`,
      );
  }

  const signed = new Map<string, string>();

  if (allowRemote) {
    for (const url of urls.slice(0, 200)) {
      const proxied = await signProxyUrl(url, env.PROXY_SIGNING_KEY, `${env.MAIL_ORIGIN}/img`);

      if (proxied) signed.set(url, proxied);
    }
  }

  return sanitizeHtml(html, {
    proxyImage: (url) => signed.get(url) ?? null,
    cid: (id) => inlineUrls.get(id) ?? null,
    blockRemoteImages: !allowRemote,
  }).html;
};

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Network seams for the image proxy (tests inject fakes; production uses the global fetch). */
export interface ImageProxyDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly doh: DohFetch;
}

const liveProxyDeps: ImageProxyDeps = { fetch: (u, i) => fetch(u, i), doh: (u, i) => fetch(u, i) };

/**
 * Image proxy (E23, §10): signed URLs only; no cookies, referrer, or client IP forwarded; every
 * redirect hop revalidated — URL shape AND resolved addresses (DNS rebinding, see `dns.ts`);
 * raster types only (SVG rejected); the body is streamed with a hard byte cap, never buffered
 * past it.
 */
export const handleImageProxy = async (
  request: Request,
  env: CoreEnv,
  deps: ImageProxyDeps = liveProxyDeps,
): Promise<Response> => {
  const target = await verifyProxyUrl(request.url, env.PROXY_SIGNING_KEY);

  if (!target) return new Response("forbidden", { status: 403 });
  let url = target;

  for (let hop = 0; hop < 4; hop++) {
    if (isForbiddenProxyTarget(url)) return new Response("forbidden", { status: 403 });

    if (await forbiddenResolution(new URL(url).hostname, deps.doh))
      return new Response("forbidden", { status: 403 });

    const response = await deps.fetch(url, {
      redirect: "manual",
      headers: { accept: "image/*", "user-agent": "bye-image-proxy" },
      cf: { cacheTtl: 3600 },
    } as RequestInit);

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const next = response.headers.get("location");

      if (!next) return new Response("bad redirect", { status: 502 });
      url = new URL(next, url).toString();
      continue;
    }

    const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

    if (!response.ok || !IMAGE_TYPES.test(type)) {
      await response.body?.cancel().catch(() => undefined);

      return new Response("unsupported", { status: 415 });
    }

    const declared = Number(response.headers.get("content-length") ?? "0");

    if (declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);

      return new Response("too large", { status: 413 });
    }

    const bytes = await readCapped(response, MAX_IMAGE_BYTES);

    if (!bytes) return new Response("too large", { status: 413 });

    return new Response(bytes, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  }

  return new Response("too many redirects", { status: 508 });
};
