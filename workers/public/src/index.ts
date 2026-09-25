// Public Worker (§3 "Public Worker", §11 Publishing, O05, P01, P02).
// Serves published World copies from the public bucket and resolves share links through the
// narrow MailCore `PublicGateway` RPC entrypoint, which rechecks grants on every request.
// It holds no private mailbox/blob bindings and never sets or reads session cookies.

import { escapeHtml, publishedKey } from "@bye/domain";

export interface PublicShareMessage {
  readonly from: string;
  readonly date: number;
  readonly subject: string;
  readonly html: string;
}

export interface PublicShareView {
  readonly subject: string;
  readonly messages: ReadonlyArray<PublicShareMessage>;
}

export interface PublicGatewayRpc {
  resolveShareLink(spaceId: string, token: string): Promise<PublicShareView | null>;
  subscribe(handle: string, address: string): Promise<{ readonly ok: boolean }>;
  confirmSubscription(handle: string, token: string): Promise<{ readonly ok: boolean }>;
  unsubscribe(handle: string, address: string, token: string): Promise<{ readonly ok: boolean }>;
}

export interface PublicEnv {
  readonly APP_ORIGIN: string;
  /**
   * Render origin hosting the signed image proxy that published posts' remote images go through.
   * When bound, `img-src` is pinned to it instead of any https: host.
   */
  readonly MAIL_ORIGIN?: string;
  readonly PUBLISHED: R2Bucket;
  readonly PUBLIC_RATE_LIMIT: RateLimit;
  /**
   * Tighter limiter for subscribe posts (each can trigger a confirmation mail to a third party),
   * separate from share-link reads. Falls back to PUBLIC_RATE_LIMIT until the binding is deployed.
   */
  readonly SUBSCRIBE_RATE_LIMIT?: RateLimit;
  readonly CORE: PublicGatewayRpc;
}

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const csp = (imageOrigin: string) =>
  `default-src 'none'; img-src 'self' ${imageOrigin} data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // Published and shared HTML is already sanitized; CSP is defense in depth and allows no script.
  // Until MAIL_ORIGIN is bound (posts published before the image proxy may still hold direct
  // https: images) any https: image host is allowed; `withImageOrigin` narrows it.
  "content-security-policy": csp("https:"),
};

/** Pin `img-src` to the image-proxy origin when it is configured. */
const withImageOrigin = (response: Response, env: PublicEnv): Response => {
  let origin: string | null = null;
  try {
    origin = env.MAIL_ORIGIN ? new URL(env.MAIL_ORIGIN).origin : null;
  } catch {
    origin = null;
  }
  if (origin && response.headers.has("content-security-policy"))
    response.headers.set("content-security-policy", csp(origin));
  return response;
};

/** Re-exported for existing callers; the platform-wide escaper and key layout live in @bye/domain. */
export { escapeHtml, publishedKey };

const page = (
  title: string,
  body: string,
  status = 200,
  extra: Record<string, string> = {},
): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem}article{border-top:1px solid #ddd;padding:1rem 0}.msg{contain:paint;overflow:hidden;position:relative}</style></head><body>${body}</body></html>`,
    { status, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", ...extra } },
  );

const notFound = () =>
  page("Not found", "<h1>Not found</h1>", 404, { "cache-control": "no-store" });

/** Raster image types MailCore accepts for World media; anything else is served as an opaque download type. */
const PUBLIC_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const serveObject = async (
  env: PublicEnv,
  key: string,
  contentType: string,
  media = false,
): Promise<Response> => {
  const object = await env.PUBLISHED.get(key);
  if (!object) return notFound();
  const stored = object.httpMetadata?.contentType?.split(";")[0]?.trim().toLowerCase();
  return new Response(object.body, {
    headers: {
      ...BASE_HEADERS,
      // Media keeps its stored raster type (never script-capable types such as SVG or HTML).
      "content-type": media && stored && PUBLIC_MEDIA_TYPES.has(stored) ? stored : contentType,
      // Short edge TTL: unpublish deletes the object and purges; stale copies age out quickly.
      "cache-control": "public, max-age=60, s-maxage=300",
      etag: object.httpEtag,
    },
  });
};

const renderShare = (view: PublicShareView): Response =>
  page(
    view.subject,
    `<h1>${escapeHtml(view.subject)}</h1>${view.messages
      .map(
        (m) =>
          `<article><header><strong>${escapeHtml(m.from)}</strong> · <time datetime="${new Date(m.date).toISOString()}">${escapeHtml(new Date(m.date).toUTCString())}</time></header><div class="msg">${m.html}</div></article>`,
      )
      .join("")}`,
    200,
    // Share links are bearer credentials: never cache at the edge, never index.
    { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  );

const FORM_MAX_BYTES = 4096;

class FormTooLarge extends Error {}

/**
 * Read a small urlencoded form, cancelling the stream past FORM_MAX_BYTES (a missing or lying
 * content-length can't make the Worker buffer an unbounded body).
 */
const form = async (request: Request): Promise<URLSearchParams> => {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded") || !request.body)
    return new URLSearchParams();
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > FORM_MAX_BYTES) throw new FormTooLarge();
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FORM_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FormTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
};

const tooMany = () =>
  page("Slow down", "<h1>Too many requests</h1>", 429, { "cache-control": "no-store" });

/** The Worker's own failure page: never cached, no details (MailCore RPC or R2 unavailable). */
const unavailable = () =>
  page("Unavailable", "<h1>Temporarily unavailable</h1><p>Please try again shortly.</p>", 503, {
    "cache-control": "no-store",
    "retry-after": "30",
  });

export const handlePublic = async (request: Request, env: PublicEnv): Promise<Response> => {
  try {
    return withImageOrigin(await route(request, env), env);
  } catch (error) {
    if (error instanceof FormTooLarge)
      return page("Too large", "<h1>Request too large</h1>", 413, { "cache-control": "no-store" });
    console.error(
      JSON.stringify({
        level: "error",
        op: "public",
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return unavailable();
  }
};

const route = async (request: Request, env: PublicEnv): Promise<Response> => {
  const url = new URL(request.url);
  // Liveness for uptime checks: no bindings touched, no details, never cached.
  if (url.pathname === "/healthz")
    return new Response("ok", {
      status: 200,
      headers: { ...BASE_HEADERS, "content-type": "text/plain", "cache-control": "no-store" },
    });
  const parts = url.pathname.split("/").filter(Boolean);
  const ip = request.headers.get("cf-connecting-ip") ?? "anon";

  if (parts[0] === "s" && parts.length === 3) {
    const spaceId = parts[1]!;
    const token = parts[2]!;
    if (!TOKEN.test(token) || !/^[a-z0-9_-]{4,64}$/i.test(spaceId)) return notFound();
    const { success } = await env.PUBLIC_RATE_LIMIT.limit({ key: `share:${ip}` });
    if (!success) return tooMany();
    const view = await env.CORE.resolveShareLink(spaceId, token);
    return view ? renderShare(view) : notFound();
  }

  const handle = parts[0]?.startsWith("@") ? parts[0].slice(1) : undefined;
  if (!handle || !HANDLE.test(handle))
    return parts.length === 0 ? page("bye", "<h1>bye</h1>") : notFound();

  if (request.method === "GET") {
    if (parts.length === 1)
      return serveObject(env, publishedKey.index(handle), "text/html; charset=utf-8");
    if (parts[1] === "feed.xml" && parts.length === 2)
      return serveObject(env, publishedKey.feed(handle), "application/rss+xml; charset=utf-8");
    if (
      parts[1] === "media" &&
      parts.length === 3 &&
      SLUG.test(parts[2]!.replace(/\.[a-z0-9]+$/, ""))
    ) {
      return serveObject(
        env,
        publishedKey.media(handle, parts[2]!),
        "application/octet-stream",
        true,
      );
    }
    if (parts[1] === "confirm" && parts.length === 3 && TOKEN.test(parts[2]!)) {
      const result = await env.CORE.confirmSubscription(handle, parts[2]!);
      return page(
        "Subscription",
        result.ok ? "<h1>You're subscribed.</h1>" : "<h1>This link has expired.</h1>",
        result.ok ? 200 : 410,
        { "cache-control": "no-store" },
      );
    }
    if (parts[1] === "unsubscribe" && parts.length === 2) {
      // The human-visible link in the mail footer. GET never changes state (mail scanners prefetch
      // links); it shows a one-button form that posts to the RFC 8058 one-click endpoint below.
      const token = url.searchParams.get("token") ?? "";
      const who = (url.searchParams.get("email") ?? "").toLowerCase();
      if (!TOKEN.test(token) || !who)
        return page("Unsubscribe", "<h1>This link is invalid.</h1>", 400, {
          "cache-control": "no-store",
        });
      return page(
        "Unsubscribe",
        `<h1>Unsubscribe ${escapeHtml(who)} from @${escapeHtml(handle)}?</h1>
         <form method="post" action="/@${escapeHtml(handle)}/unsubscribe"><input type="hidden" name="email" value="${escapeHtml(who)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form>`,
        200,
        { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      );
    }
    if (parts.length === 2 && SLUG.test(parts[1]!))
      return serveObject(env, publishedKey.post(handle, parts[1]!), "text/html; charset=utf-8");
    return notFound();
  }

  if (request.method === "POST") {
    const subscribing = parts[1] === "subscribe" && parts.length === 2;
    const limiter = subscribing
      ? (env.SUBSCRIBE_RATE_LIMIT ?? env.PUBLIC_RATE_LIMIT)
      : env.PUBLIC_RATE_LIMIT;
    const { success } = await limiter.limit({ key: `${subscribing ? "sub" : "unsub"}:${ip}` });
    if (!success) return tooMany();
    const data = await form(request);
    const address = (data.get("email") ?? "").trim().toLowerCase();
    if (subscribing) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254)
        return page("Subscribe", "<h1>Enter a valid email address.</h1>", 400);
      // Per-target bucket as well: many IPs aiming confirmation mail at one address are throttled.
      // A throttled target gets the ordinary answer (no signal that someone else just asked).
      const target = await limiter.limit({ key: `sub:${handle}:${address}` });
      if (target.success) await env.CORE.subscribe(handle, address);
      // Same response whether or not the address was already subscribed (no enumeration).
      return page("Subscribe", "<h1>Check your email to confirm.</h1>", 202, {
        "cache-control": "no-store",
      });
    }
    if (parts[1] === "unsubscribe" && parts.length === 2) {
      // RFC 8058 one-click unsubscribe posts here with address and token.
      const token = data.get("token") ?? url.searchParams.get("token") ?? "";
      const who = address || (url.searchParams.get("email") ?? "").toLowerCase();
      const result = await env.CORE.unsubscribe(handle, who, token);
      return page(
        "Unsubscribe",
        result.ok ? "<h1>You're unsubscribed.</h1>" : "<h1>This link is invalid.</h1>",
        result.ok ? 200 : 400,
        { "cache-control": "no-store" },
      );
    }
  }
  return notFound();
};

export default {
  fetch: (request: Request, env: PublicEnv): Promise<Response> => handlePublic(request, env),
} satisfies ExportedHandler<PublicEnv>;
