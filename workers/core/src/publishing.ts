import { buildMessage, sanitizeHtml, signProxyUrl } from "@bye/mail-codec";
import { EmailMessage } from "cloudflare:email";
import {
  type SharedFailure,
  Unavailable,
  WorldPostPublishing,
  WorldPublishing,
} from "@bye/application";
import {
  cloudflareApi,
  DEFAULT_SENDING_LIMITS,
  isRejection,
  reject,
  SendingPolicy,
} from "@bye/platform-cloudflare";
import { Effect, Layer } from "effect";
import { escapeHtml, normalizeAddress, publishedKey } from "@bye/domain";
import { settle, settleOr, world } from "./authorities.ts";
import type { CoreEnv } from "./env.ts";
import { kernelClock } from "./durable-host.ts";
import { describeError } from "./http.ts";
import { publicOrigin, serviceDomain } from "./origins.ts";

// World public site writer (P01). Published copies live in the separate public bucket under
// site/<handle>/…; the Public worker serves them. Unpublish rewrites the index/feed and deletes the
// post object. Author HTML is sanitized again before it becomes public.

interface PostView {
  readonly id: string;
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

/** Listing bound per slug when pruning public media (1000 keys per page). */
const MEDIA_PRUNE_MAX_PAGES = 10;

/** Every public media copy of `slug`, all revisions (the `worldMediaKey` layout: `<slug>-r<n>-<name>`). */
const slugMediaKeys = async (
  env: CoreEnv,
  handle: string,
  slug: string,
): Promise<Array<string>> => {
  const prefix = publishedKey.media(handle, `${slug.slice(0, 60)}-r`);
  const keys: Array<string> = [];
  let cursor: string | undefined;

  for (let page = 0; page < MEDIA_PRUNE_MAX_PAGES; page++) {
    const listed = await env.PUBLISHED.list(
      cursor ? { prefix, limit: 1000, cursor } : { prefix, limit: 1000 },
    );

    for (const o of listed.objects) if (/^\d+-/.test(o.key.slice(prefix.length))) keys.push(o.key);

    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  return keys;
};

/**
 * Delete public media copies of `slugs` that no published revision references: an unpublished
 * post's media, and a republished post's superseded revisions. The live set is read AFTER listing,
 * so media of a publish that committed meanwhile (copied only after its commit) is kept. Returns
 * the deleted keys (their public URLs must be purged too).
 */
const pruneMedia = async (
  env: CoreEnv,
  handle: string,
  slugs: ReadonlyArray<string>,
  keep: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  if (slugs.length === 0) return [];
  const candidates = new Set<string>();

  for (const slug of new Set(slugs))
    for (const key of await slugMediaKeys(env, handle, slug)) candidates.add(key);

  if (candidates.size === 0) return [];
  const live = new Set<string>(keep);

  for (const p of (await settle(world(env, handle).publicPosts())) as ReadonlyArray<PostView>)
    for (const m of p.media ?? []) live.add(m.publicKey);
  const doomed = [...candidates].filter((k) => !live.has(k));

  for (let i = 0; i < doomed.length; i += 1000)
    await env.PUBLISHED.delete(doomed.slice(i, i + 1000));

  return doomed;
};

/**
 * Rewrite the author's public site; returns the public URLs whose caches must be purged.
 * `published` names the post version just published: its superseded revisions' media is removed.
 */
export const writeSite = async (
  env: CoreEnv,
  handle: string,
  publicOrigin: string,
  removedSlugs: ReadonlyArray<string> = [],
  published?: PublishPlan,
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
    ...posts.flatMap((p) => (p.status !== "published" ? [p.slug] : [])),
    ...removedSlugs.filter((slug) => !liveSlugs.has(slug)),
  ]);

  for (const slug of gone) await env.PUBLISHED.delete(publishedKey.post(handle, slug));
  // Media copies follow their post: none survive unpublish, and a new revision replaces the old.
  const republished = published ? live.find((p) => p.id === published.postId) : undefined;

  const prunedMedia = [
    ...(await pruneMedia(env, handle, [...gone])),
    ...(republished
      ? await pruneMedia(
          env,
          handle,
          [republished.slug],
          published!.copies.map((c) => c.to),
        )
      : []),
  ];

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
    ...prunedMedia.map(
      (key) =>
        `${publicOrigin}/@${handle}/media/${key.slice(publishedKey.media(handle, "").length)}`,
    ),
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
  published?: PublishPlan,
): Promise<{ readonly purged: boolean }> => {
  const urls = await writeSite(env, handle, publicOrigin(env), removedSlugs, published);

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
  const result = await refreshSite(env, handle, [], plan);
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

/** The publish ports' live layer: both run the ONE pipeline above. */
const publishEffect = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e): SharedFailure =>
      isRejection(e) ? e : new Unavailable({ dependency: "world", detail: "publish" }),
  });

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

/** Why a system message was not sent. Callers treat it like any failed send (never retried). */
export class SystemMailRefused extends Error {
  constructor(readonly reason: "suppressed" | "suspended" | "all-suppressed" | "budget") {
    super(`system mail refused: ${reason}`);
    this.name = "SystemMailRefused";
  }
}

/**
 * The platform sending controls for system mail (§10). The service-domain identities
 * (`no-reply@`, `world@`) are shared by every user, so their own budget is the domain's; the
 * per-user ramp, suspensions, domain and platform budgets apply unchanged.
 */
const systemMailPolicy = (env: CoreEnv) =>
  new SendingPolicy(env.DIRECTORY, kernelClock, {
    ...DEFAULT_SENDING_LIMITS,
    identityPerDay: DEFAULT_SENDING_LIMITS.domainPerDay,
  });

/**
 * Send one system message through the transactional binding. A globally suppressed recipient
 * (hard bounce, complaint, unsubscribe) is never mailed. When a user triggered the message
 * (`actorUserId`: invitations, imports, forwarding confirmations — recipients they choose), it is
 * also reserved against that user's sending budget and refused while they are suspended, exactly
 * like their own outbound mail.
 */
const deliverSystemMail = async (
  env: CoreEnv,
  from: string,
  to: string,
  raw: string,
  actorUserId: string | undefined,
): Promise<void> => {
  const policy = systemMailPolicy(env);
  const send = () => env.TRANSACTIONAL_EMAIL.send(new EmailMessage(from, to, raw));

  if (actorUserId === undefined) {
    const suppressed = await env.DIRECTORY.withSession("first-primary")
      .prepare(
        "SELECT 1 AS s FROM suppressions WHERE address = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .bind(normalizeAddress(to), Date.now())
      .first();

    if (suppressed !== null) throw new SystemMailRefused("suppressed");

    if (await policy.isSuspended("identity", normalizeAddress(from)))
      throw new SystemMailRefused("suspended");
    await send();

    return;
  }

  const verdict = await policy.reserve({ userId: actorUserId, identity: from, recipients: [to] });

  if (!verdict.allowed) throw new SystemMailRefused(verdict.reason);

  try {
    await send();
  } catch (error) {
    await policy
      .release({ userId: actorUserId, identity: from, recipients: 1 })
      .catch(() => undefined);
    throw error;
  }
};

/** Options for user-triggered system mail: the user it is counted against (see `deliverSystemMail`). */
export interface SystemMailOptions {
  readonly actorUserId?: string;
}

/**
 * Transactional system message (verification links, invitations). Never used for subscription
 * traffic. Rejects with `SystemMailRefused` when the sending controls refuse it.
 */
export const sendSystemEmail = async (
  env: CoreEnv,
  input: { readonly to: string; readonly subject: string; readonly text: string },
  options: SystemMailOptions = {},
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

  await deliverSystemMail(
    env,
    from,
    input.to,
    new TextDecoder().decode(built.bytes),
    options.actorUserId,
  );
};

/**
 * Double opt-in confirmation (P02). A single-recipient, user-requested message is transactional
 * traffic; newsletter fanout itself still requires the approved subscription transport. An
 * author's CSV import passes `actorUserId`, so the confirmations count against the author's
 * sending budget; the anonymous form (rate-limited per IP and address) passes none.
 */
export const sendSubscriptionConfirmation = async (
  env: CoreEnv,
  handle: string,
  address: string,
  token: string,
  options: SystemMailOptions = {},
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

  await deliverSystemMail(
    env,
    from,
    address,
    new TextDecoder().decode(built.bytes),
    options.actorUserId,
  );
};
