import { buildMessage, sanitizeHtml, signProxyUrl } from "@bye/mail-codec";
import { EmailMessage } from "cloudflare:email";
import {
  type SharedFailure,
  Unavailable,
  WorldPostPublishing,
  WorldPublishing,
} from "@bye/application";
import { cloudflareApi, isRejection, reject } from "@bye/platform-cloudflare";
import { Effect, Layer } from "effect";
import { escapeHtml, publishedKey } from "@bye/domain";
import { settle, settleOr, world } from "./authorities.ts";
import type { CoreEnv } from "./env.ts";
import { describeError } from "./http.ts";
import { publicOrigin, serviceDomain } from "./origins.ts";

// World public site writer (P01). Published copies live in the separate public bucket under
// site/<handle>/…; the Public worker serves them. Unpublish rewrites the index/feed and deletes the
// post object. Author HTML is sanitized again before it becomes public.

interface PostView {
  readonly slug: string;
  readonly status: string;
  readonly title: string;
  readonly html: string;
  readonly publishedAt: number | null;
  readonly media?: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly publicKey: string;
  }>;
}

const handlePart = (v: string) =>
  v
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Service-domain addresses get `local`; custom-domain addresses get `local--domain`. Service handles
 * never contain `--` (runs of hyphens collapse), so a service-domain signup can never claim a
 * custom-domain user's handle (e.g. `alice-acme-com@service` vs alice@acme.com).
 */
export const worldHandle = (address: string, serviceDomain: string): string => {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  if (domain === serviceDomain.toLowerCase()) return handlePart(local).slice(0, 63) || "author";
  return `${handlePart(local).slice(0, 30) || "author"}--${handlePart(domain)}`
    .slice(0, 63)
    .replace(/-+$/, "");
};

/**
 * Handle used when the natural one is already owned by another author (distinct addresses that
 * sanitize alike, e.g. `a.b@` and `a_b@`): deterministic per address, and in the `--` space that
 * no service-domain handle can occupy.
 */
export const worldFallbackHandle = async (address: string, base: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address.toLowerCase())),
  );
  const hash = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${base.split("--")[0]!.slice(0, 40)}--h${hash}`;
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;

/** Newsletter-mail HTML (mail clients apply their own remote-image policy). */
export const publicHtml = (html: string): string =>
  sanitizeHtml(html, {
    proxyImage: (url) => (url.startsWith("https://") ? url : null),
    cid: () => null,
    blockRemoteImages: false,
  }).html;

/** Remote images per published post routed through the proxy (beyond this they are dropped). */
const MAX_PUBLIC_REMOTE_IMAGES = 200;

/**
 * Published-site HTML: remote images are rewritten to the signed image proxy on the render origin
 * (`/img`, the same SSRF-guarded, size- and type-capped fetcher private mail uses), so a public
 * page never makes readers' browsers contact author-chosen hosts (tracking, mixed content) and the
 * public CSP can pin `img-src` to that origin.
 */
export const publicSiteHtml = async (env: CoreEnv, html: string): Promise<string> => {
  const urls: Array<string> = [];
  sanitizeHtml(html, {
    proxyImage: (url) => (urls.push(url), null),
    cid: () => null,
    blockRemoteImages: false,
  });
  const signed = new Map<string, string>();
  for (const url of [...new Set(urls)].slice(0, MAX_PUBLIC_REMOTE_IMAGES)) {
    if (!url.startsWith("https://")) continue;
    signed.set(url, await signProxyUrl(url, env.PROXY_SIGNING_KEY, `${env.MAIL_ORIGIN}/img`));
  }
  return sanitizeHtml(html, {
    proxyImage: (url) => signed.get(url) ?? null,
    cid: () => null,
    blockRemoteImages: false,
  }).html;
};

const mediaHtml = (handle: string, post: PostView): string =>
  (post.media ?? [])
    .filter(
      (m) =>
        m.contentType.startsWith("image/") &&
        m.publicKey.startsWith(publishedKey.media(handle, "")),
    )
    .map(
      (m) =>
        `<figure><img src="/@${handle}/media/${escapeHtml(m.publicKey.slice(publishedKey.media(handle, "").length))}" alt="${escapeHtml(m.name)}"></figure>`,
    )
    .join("");

/** Rewrite the author's public site; returns the public URLs whose caches must be purged. */
export const writeSite = async (
  env: CoreEnv,
  handle: string,
  publicOrigin: string,
  removedSlugs: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  const stub = world(env, handle);
  const posts: ReadonlyArray<PostView> = await settle(stub.publicPosts());
  const rss = await settle(stub.rss(publicOrigin));
  const live = posts.filter((p) => p.status === "published");
  for (const post of live) {
    await env.PUBLISHED.put(
      publishedKey.post(handle, post.slug),
      page(
        post.title,
        `<article><h1>${escapeHtml(post.title)}</h1>${mediaHtml(handle, post)}${await publicSiteHtml(env, post.html)}</article>`,
      ),
      {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      },
    );
  }
  // Unpublished posts are not in the public list, so callers name them explicitly; never leave a public copy.
  const liveSlugs = new Set(live.map((p) => p.slug));
  const gone = new Set([
    ...posts.filter((p) => p.status !== "published").map((p) => p.slug),
    ...removedSlugs.filter((slug) => !liveSlugs.has(slug)),
  ]);
  for (const slug of gone) await env.PUBLISHED.delete(publishedKey.post(handle, slug));
  const index = live
    .map((p) => `<li><a href="/@${handle}/${p.slug}">${escapeHtml(p.title)}</a></li>`)
    .join("");
  await env.PUBLISHED.put(
    publishedKey.index(handle),
    page(
      `@${handle}`,
      `<h1>@${escapeHtml(handle)}</h1><ul>${index}</ul><form method="post" action="/@${handle}/subscribe"><input name="email" type="email" required aria-label="Email"><button>Subscribe</button></form><p><a href="/@${handle}/feed.xml">RSS</a></p>`,
    ),
    { httpMetadata: { contentType: "text/html; charset=utf-8" } },
  );
  await env.PUBLISHED.put(publishedKey.feed(handle), rss, {
    httpMetadata: { contentType: "application/rss+xml; charset=utf-8" },
  });
  const slugs = [...new Set([...posts.map((p) => p.slug), ...removedSlugs])];
  return [
    `${publicOrigin}/@${handle}`,
    `${publicOrigin}/@${handle}/feed.xml`,
    ...slugs.map((slug) => `${publicOrigin}/@${handle}/${slug}`),
  ];
};

/**
 * Purge public caches after publish/unpublish (P01) through the scoped Cache Purge token. Without
 * configuration the short edge TTL bounds staleness; the call reports whether a purge happened.
 */
export const purgePublic = async (env: CoreEnv, urls: ReadonlyArray<string>): Promise<boolean> => {
  if (!env.CF_CACHE_PURGE_TOKEN || !env.CF_PUBLIC_ZONE_ID || urls.length === 0) return false;
  await cloudflareApi(env.CF_CACHE_PURGE_TOKEN, (u, i) => fetch(u, i)).purgeUrls(
    env.CF_PUBLIC_ZONE_ID,
    urls,
  );
  return true;
};

export const refreshSite = async (
  env: CoreEnv,
  handle: string,
  removedSlugs: ReadonlyArray<string> = [],
): Promise<{ readonly purged: boolean }> => {
  const urls = await writeSite(env, handle, publicOrigin(env), removedSlugs);
  return { purged: await purgePublic(env, urls).catch(() => false) };
};

export interface WorldAuthor {
  readonly authorId: string;
  readonly handle: string;
  readonly address: string;
  readonly name: string;
}

/** Resolve (and idempotently initialize) the author's World authority. */
export const worldAuthor = async (env: CoreEnv, authorId: string): Promise<WorldAuthor | null> => {
  const user = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT primary_address AS address, display_name AS name FROM users WHERE id = ?")
    .bind(authorId)
    .first<{ address: string; name: string }>();
  if (!user) return null;
  // A handle already owned by another author refuses with `forbidden`: use the fallback handle.
  const init = (handle: string) =>
    settleOr(
      world(env, handle).initWorld({
        authorId,
        handle,
        title: user.name || handle,
        addresses: [user.address],
      }),
      "forbidden",
    ).then((r) => r !== null);
  let handle = worldHandle(user.address, serviceDomain(env));
  if (!(await init(handle))) {
    handle = await worldFallbackHandle(user.address, handle);
    if (!(await init(handle))) reject("conflict", "world handle unavailable");
  }
  return { authorId, handle, address: user.address, name: user.name };
};

/** Copy selected private media into the public namespace (bounded concurrency, never the original key). */
export const copyPublicMedia = async (
  env: CoreEnv,
  copies: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): Promise<void> => {
  for (let i = 0; i < copies.length; i += 4) {
    await Promise.all(
      copies.slice(i, i + 4).map(async (c) => {
        const object = (await env.PARTS.get(c.from)) ?? (await env.ORIGINALS.get(c.from));
        if (!object) throw new Error("media missing");
        await env.PUBLISHED.put(c.to, object.body, { httpMetadata: object.httpMetadata ?? {} });
      }),
    );
  }
};

/** A committed publish whose public side effects (media, site, fanout) must follow. */
export interface PublishPlan {
  readonly postId: string;
  readonly revision: number;
  readonly copies: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/** Private marker recording the newest revision whose public site was rendered (dedupes resumes). */
const siteMarkerKey = (handle: string, postId: string) =>
  `t/world/${handle}/site-rendered/${postId}`;

export const siteRendered = async (
  env: CoreEnv,
  handle: string,
  postId: string,
  revision: number,
): Promise<boolean> => {
  const marker = await env.PARTS.get(siteMarkerKey(handle, postId));
  return marker !== null && Number(await marker.text()) >= revision;
};

/**
 * The post-commit publish pipeline: copy media into the public bucket, rewrite and purge the site,
 * record the rendered revision. Idempotent — the durable FANOUT instance re-runs it after a crash.
 */
export const renderPublished = async (
  env: CoreEnv,
  handle: string,
  plan: PublishPlan,
): Promise<{ readonly purged: boolean }> => {
  await copyPublicMedia(env, plan.copies);
  const result = await refreshSite(env, handle);
  await env.PARTS.put(siteMarkerKey(handle, plan.postId), String(plan.revision));
  return result;
};

/**
 * Start the durable publish instance for a committed post version (idempotent per version): it
 * finishes media/site if the synchronous attempt didn't, then runs the subscription fanout.
 */
export const startFanout = async (
  env: CoreEnv,
  author: WorldAuthor,
  plan: PublishPlan,
): Promise<void> => {
  try {
    await env.FANOUT.create({
      id: `fan-${author.handle}-${plan.postId}-r${plan.revision}`.slice(0, 100),
      params: {
        v: 1,
        handle: author.handle,
        userId: author.authorId,
        postId: plan.postId,
        revision: plan.revision,
        copies: plan.copies.map((c) => ({ from: c.from, to: c.to })),
      },
    });
  } catch (error) {
    // An instance for this post version already exists: its steps are durable, so a duplicate
    // trigger is harmless.
    if (!String(error).toLowerCase().includes("exist")) throw error;
  }
};

/**
 * After a commit: make the rest durable FIRST (the FANOUT instance), then render synchronously so
 * the public page exists when the request returns. A failed synchronous render is logged, not
 * surfaced: the durable instance completes it.
 */
const afterCommit = async (
  env: CoreEnv,
  author: WorldAuthor,
  plan: PublishPlan,
): Promise<{ readonly purged: boolean }> => {
  await startFanout(env, author, plan);
  try {
    return await renderPublished(env, author.handle, plan);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        op: "world.render-deferred",
        postId: plan.postId,
        error: describeError(error),
      }),
    );
    return { purged: false };
  }
};

export interface PublishResult {
  readonly postId: string;
  readonly revision: number;
  readonly handle: string;
  readonly purged: boolean;
}

/**
 * The ONE publish pipeline (P01), used by the API use cases and the internal publish-address path:
 * the operation is always built from an authenticated principal (never inbound SMTP), committed in
 * the World authority (idempotent by `eventId`), then published durably.
 */
export const publishForAuthor = async (
  env: CoreEnv,
  authorId: string,
  input: {
    readonly fromAddress: string;
    readonly title: string;
    readonly html: string;
    readonly text: string;
    readonly media: ReadonlyArray<{
      readonly contentKey: string;
      readonly name: string;
      readonly contentType: string;
    }>;
    readonly publish: boolean;
  },
  eventId?: string,
): Promise<PublishResult> => {
  const author = (await worldAuthor(env, authorId)) ?? reject("not_found", "author not found");
  const committed = await settle(
    world(env, author.handle).publishFromMail(
      { origin: "internal-send", authenticatedUserId: authorId, ...input },
      eventId,
    ),
  );
  const plan: PublishPlan = {
    postId: committed.postId,
    revision: committed.revision,
    copies: "copies" in committed ? committed.copies : [],
  };
  const { purged } = input.publish ? await afterCommit(env, author, plan) : { purged: false };
  return { postId: plan.postId, revision: plan.revision, handle: author.handle, purged };
};

/** Publish an existing draft/post (the same pipeline as `publishForAuthor`). */
export const publishExistingForAuthor = async (
  env: CoreEnv,
  authorId: string,
  postId: string,
): Promise<PublishResult> => {
  const author = (await worldAuthor(env, authorId)) ?? reject("not_found", "author not found");
  const plan = await settle(world(env, author.handle).publishPost(authorId, postId));
  const { purged } = await afterCommit(env, author, plan);
  return { postId: plan.postId, revision: plan.revision, handle: author.handle, purged };
};

/** An authority refusal as the shared use cases' typed failure; anything else is infrastructure. */
const publishFailure = (e: unknown): SharedFailure =>
  isRejection(e) ? e : new Unavailable({ dependency: "world", detail: "publish" });

/** The publish ports' live layer: both run the ONE pipeline above. */
const publishEffect = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: publishFailure });

export const worldPublishingLayer = (env: CoreEnv) =>
  Layer.mergeAll(
    Layer.succeed(WorldPublishing, {
      publish: (authorId, op) => publishEffect(() => publishForAuthor(env, authorId, op)),
    }),
    Layer.succeed(WorldPostPublishing, {
      publishExisting: (authorId, postId) =>
        publishEffect(() => publishExistingForAuthor(env, authorId, postId)),
    }),
  );

/** Transactional system message (verification links). Never used for subscription traffic. */
export const sendSystemEmail = async (
  env: CoreEnv,
  input: { readonly to: string; readonly subject: string; readonly text: string },
): Promise<void> => {
  const domain = serviceDomain(env);
  const from = `no-reply@${domain}`;
  const built = buildMessage({
    from: { name: "bye", address: from },
    to: [{ name: undefined, address: input.to }],
    subject: input.subject,
    text: input.text,
    autoSubmitted: "auto-generated",
    date: Date.now(),
    messageId: `sys-${crypto.randomUUID()}@${domain}`,
  });
  await env.TRANSACTIONAL_EMAIL.send(
    new EmailMessage(from, input.to, new TextDecoder().decode(built.bytes)),
  );
};

/**
 * Double opt-in confirmation (P02). A single-recipient, user-requested message is transactional
 * traffic; newsletter fanout itself still requires the approved subscription transport.
 */
export const sendSubscriptionConfirmation = async (
  env: CoreEnv,
  handle: string,
  address: string,
  token: string,
): Promise<void> => {
  const origin = publicOrigin(env);
  const domain = serviceDomain(env);
  const from = `world@${domain}`;
  const link = `${origin}/@${handle}/confirm/${token}`;
  const built = buildMessage({
    from: { name: `@${handle}`, address: from },
    to: [{ name: undefined, address }],
    subject: `Confirm your subscription to @${handle}`,
    text: `Someone (hopefully you) asked to follow @${handle}.\n\nConfirm: ${link}\n\nIf this wasn't you, ignore this message and nothing will be sent.`,
    autoSubmitted: "auto-generated",
    date: Date.now(),
    messageId: `confirm-${crypto.randomUUID()}@${domain}`,
  });
  await env.TRANSACTIONAL_EMAIL.send(
    new EmailMessage(from, address, new TextDecoder().decode(built.bytes)),
  );
};
