import { reject, type RpcSurface } from "../durable/rpc.ts";
import { escapeHtml, normalizeAddress } from "@bye/domain";
import { Kernel, KERNEL_MIGRATIONS, type KernelClock } from "../durable/kernel.ts";
import { json, type Migration, migrate, Sql, type TransactionalStorage } from "../durable/sql.ts";
import {
  hmacSha256,
  parseSecretRing,
  randomToken,
  ringVersions,
  type SecretRing,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
} from "../control/crypto.ts";
import { NEWSLETTER_TABLES, NewsletterLedger } from "./newsletter.ts";

// World-style publishing (P01) and subscriptions (P02): one WorldDO authority per author.
// Posts are published only from an authenticated internal operation, never from inbound SMTP.
// Public content is copied into the public namespace; private originals are never made public.

export const WORLD_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "world",
    statements: [
      "CREATE TABLE world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      `CREATE TABLE posts (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unpublished')),
        current_revision INTEGER NOT NULL, published_revision INTEGER, created_at INTEGER NOT NULL, published_at INTEGER, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE post_revisions (
        post_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL,
        media TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, revision))`,
      `CREATE TABLE subscribers (
        address TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'suppressed')),
        source TEXT NOT NULL CHECK (source IN ('form', 'import')), confirm_hash TEXT, created_at INTEGER NOT NULL,
        confirmed_at INTEGER, unsubscribed_at INTEGER, suppressed_reason TEXT)`,
      `CREATE TABLE fanout (
        post_id TEXT NOT NULL, revision INTEGER NOT NULL, address TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'skipped', 'bounced')), updated_at INTEGER NOT NULL,
        PRIMARY KEY (post_id, revision, address))`,
      "CREATE INDEX fanout_pending ON fanout (state, post_id)",
    ],
  },
  {
    // P02/§5.2: a fanout intent is leased, submitted to the approved subscription transport, then
    // settled. An ambiguous submission is recorded as `unknown` and never blindly re-sent.
    version: 2,
    name: "fanout-lease",
    statements: [
      `CREATE TABLE fanout_v2 (
        post_id TEXT NOT NULL, revision INTEGER NOT NULL, address TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'skipped', 'bounced', 'unknown')), updated_at INTEGER NOT NULL,
        claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (post_id, revision, address))`,
      "INSERT INTO fanout_v2 (post_id, revision, address, state, updated_at) SELECT post_id, revision, address, state, updated_at FROM fanout",
      "DROP TABLE fanout",
      "ALTER TABLE fanout_v2 RENAME TO fanout",
      "CREATE INDEX fanout_pending ON fanout (state, post_id)",
    ],
  },
  // spec.md §5.5: consent history, restrictions, provider sync, publications and operations.
  // The per-recipient `fanout` table is retained only as history.
  NEWSLETTER_TABLES,
  {
    // Confirmation-mail cooldown (anti email-bombing): when this (address, world) pair was last
    // sent a double-opt-in invitation.
    version: 4,
    name: "subscribe-cooldown",
    statements: ["ALTER TABLE subscribers ADD COLUMN invited_at INTEGER"],
  },
];

/**
 * One confirmation mail per pending address per World per window: repeated form posts never turn
 * a World into a mail cannon aimed at a third party.
 */
export const SUBSCRIBE_CONFIRM_COOLDOWN_MS = 24 * 60 * 60_000;

/** Rows per transaction when importing a subscriber CSV. */
const IMPORT_CHUNK = 100;

/**
 * Distinct addresses per CSV import. Each one becomes a confirmation mail to a third party, so an
 * import is refused whole above this (split larger lists; the sending budget still applies).
 */
export const IMPORT_MAX_ADDRESSES = 1000;

const mediaSegment = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const base =
    (dot > 0 ? name.slice(0, dot) : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file";
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 8)
      : "";
  return ext ? `${base}.${ext}` : base;
};

/** Public media key: served by the Public worker at /@handle/media/<name> (never a private key). */
export const worldMediaKey = (
  handle: string,
  slug: string,
  revision: number,
  name: string,
): string => `site/${handle}/media/${slug.slice(0, 60)}-r${revision}-${mediaSegment(name)}`;

export interface PublishOperation {
  /** Only "internal-send" may publish; inbound SMTP to the publishing address is always refused. */
  readonly origin: "internal-send" | "inbound-smtp";
  readonly authenticatedUserId: string | undefined;
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
}

type PostContent = Pick<PublishOperation, "title" | "html" | "text" | "media">;

export interface PostView {
  readonly id: string;
  readonly slug: string;
  readonly status: "draft" | "published" | "unpublished";
  readonly revision: number;
  readonly title: string;
  readonly html: string;
  readonly text: string;
  readonly media: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly publicKey: string;
  }>;
  readonly publishedAt: number | null;
}

export interface PublishPlan {
  readonly postId: string;
  readonly revision: number;
  /** Copy instructions from private content keys to the public namespace. */
  readonly copies: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export type WorldErrorCode = "forbidden" | "not_found" | "conflict" | "bad_request";

const fail = (code: WorldErrorCode, message: string): never => reject(code, message);

const ADDRESS = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;

export const worldSlug = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "post";

/** XML text for the RSS feed: the canonical escape (`&#39;` is valid XML) minus C0 controls XML forbids. */
export const rssEscape = (s: string): string =>
  // oxlint-disable-next-line no-control-regex -- intentional control-char match
  escapeHtml(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export class WorldStore {
  readonly sql: Sql;
  readonly kernel: Kernel;
  private readonly unsubscribeSecrets: SecretRing;

  constructor(
    storage: TransactionalStorage,
    readonly clock: KernelClock,
    /** SESSION_KEY: a plain secret (version 1) or a `v2:<key>,v1:<key>` ring. */
    unsubscribeSecret: string | SecretRing,
  ) {
    this.unsubscribeSecrets = parseSecretRing(unsubscribeSecret);
    this.sql = new Sql(storage);
    migrate(this.sql, "kernel", KERNEL_MIGRATIONS);
    migrate(this.sql, "world", WORLD_MIGRATIONS);
    this.kernel = new Kernel(this.sql, clock);
    this.newsletter = new NewsletterLedger(
      this.sql,
      clock,
      (key) =>
        this.sql.one<{ value: string }>("SELECT value FROM world_meta WHERE key = ?", key)?.value,
      (key, value) =>
        this.sql.run(
          "INSERT INTO world_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          key,
          value,
        ),
    );
  }

  readonly newsletter: NewsletterLedger;

  init(input: {
    authorId: string;
    handle: string;
    title: string;
    addresses: ReadonlyArray<string>;
  }): void {
    this.sql.tx(() => {
      // A handle belongs to exactly one author; re-initialization by anyone else is refused.
      const existing = this.sql.one<{ value: string }>(
        "SELECT value FROM world_meta WHERE key = 'author_id'",
      )?.value;
      if (existing !== undefined && existing !== input.authorId)
        fail("forbidden", "handle belongs to another author");
      for (const [k, v] of Object.entries({
        author_id: input.authorId,
        handle: input.handle,
        title: input.title,
        addresses: JSON.stringify(input.addresses.map(normalizeAddress)),
      })) {
        this.sql.run(
          "INSERT INTO world_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          k,
          v,
        );
      }
    });
  }

  /** The owning author, or null for an uninitialized (or erased) handle. */
  ownerId(): string | null {
    return (
      this.sql.one<{ value: string }>("SELECT value FROM world_meta WHERE key = 'author_id'")
        ?.value ?? null
    );
  }

  /**
   * Erasure (§12): delete posts, revisions, subscribers and fanout state, and release the handle.
   * Refuses (returns false) when the handle now belongs to someone else — a released handle may be
   * re-claimed, and replaying an old tombstone must never wipe the new owner. `authorId` null
   * (legacy tombstones) only erases an unowned handle.
   */
  erase(authorId: string | null): boolean {
    return this.sql.tx(() => {
      const owner = this.ownerId();
      if (owner !== null && owner !== authorId) return false;
      for (const table of [
        "fanout",
        "consent_log",
        "restrictions",
        "contact_sync",
        "publication_recipients",
        "newsletter_ops",
        "provider_events",
        "publications",
        "subscribers",
        "post_revisions",
        "posts",
        "world_meta",
      ])
        this.sql.run(`DELETE FROM ${table}`);
      return true;
    });
  }

  private meta(key: string): string {
    return (
      this.sql.one<{ value: string }>("SELECT value FROM world_meta WHERE key = ?", key)?.value ??
      fail("not_found", "world not initialized")
    );
  }

  private requireAuthor(userId: string | undefined): string {
    const author = this.meta("author_id");
    if (userId !== author) fail("forbidden", "not the author");
    return author;
  }

  /**
   * Publish from the special publishing address. A forged external From never publishes: the
   * operation must originate from an authenticated internal send by the author's own identity.
   */
  publishFromMail(
    op: PublishOperation,
    eventId?: string,
  ): PublishPlan | { readonly postId: string; readonly revision: number } {
    if (op.origin !== "internal-send")
      return fail("forbidden", "publishing requires an authenticated internal send");
    // Queue-driven publishes (`world.publish` topic) replay by event ID without a duplicate post.
    if (eventId)
      return this.sql.tx(
        () => this.kernel.consume(eventId, "publish", () => this.publishFromMail(op)).result,
      );
    this.requireAuthor(op.authenticatedUserId);
    const addresses = json<Array<string>>(this.meta("addresses"), []);
    if (!addresses.includes(normalizeAddress(op.fromAddress)))
      fail("forbidden", "sender identity is not the author's");
    const { postId, revision } = this.createDraft(op.authenticatedUserId!, {
      title: op.title,
      html: op.html,
      text: op.text,
      media: op.media,
    });
    return op.publish ? this.publish(op.authenticatedUserId!, postId) : { postId, revision };
  }

  createDraft(userId: string, input: PostContent): { postId: string; revision: number } {
    this.requireAuthor(userId);
    return this.sql.tx(() => {
      const id = this.clock.id("pst");
      let slug = worldSlug(input.title);
      for (let n = 2; this.sql.one("SELECT 1 AS s FROM posts WHERE slug = ?", slug); n++)
        slug = `${worldSlug(input.title)}-${n}`;
      const now = this.clock.now();
      this.sql.run(
        "INSERT INTO posts (id, slug, status, current_revision, created_at, updated_at) VALUES (?, ?, 'draft', 1, ?, ?)",
        id,
        slug,
        now,
        now,
      );
      this.insertRevision(id, 1, input);
      return { postId: id, revision: 1 };
    });
  }

  private insertRevision(postId: string, revision: number, input: PostContent) {
    this.sql.run(
      "INSERT INTO post_revisions (post_id, revision, title, html, text, media, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      postId,
      revision,
      input.title,
      input.html,
      input.text,
      JSON.stringify(input.media),
      this.clock.now(),
    );
  }

  /** Edit creates a new revision; a published post keeps serving the old revision until republished. */
  edit(userId: string, postId: string, input: PostContent): number {
    this.requireAuthor(userId);
    return this.sql.tx(() => {
      const p =
        this.sql.one<{ current_revision: number }>(
          "SELECT current_revision FROM posts WHERE id = ?",
          postId,
        ) ?? fail("not_found", "post");
      const next = Number(p.current_revision) + 1;
      this.insertRevision(postId, next, input);
      this.sql.run(
        "UPDATE posts SET current_revision = ?, updated_at = ? WHERE id = ?",
        next,
        this.clock.now(),
        postId,
      );
      return next;
    });
  }

  private view(postId: string, revision: number): PostView {
    const p =
      this.sql.one<{
        id: string;
        slug: string;
        status: PostView["status"];
        published_at: number | null;
      }>("SELECT id, slug, status, published_at FROM posts WHERE id = ?", postId) ??
      fail("not_found", "post");
    const r =
      this.sql.one<{ title: string; html: string; text: string; media: string }>(
        "SELECT title, html, text, media FROM post_revisions WHERE post_id = ? AND revision = ?",
        postId,
        revision,
      ) ?? fail("not_found", "revision");
    const handle = this.meta("handle");
    return {
      id: p.id,
      slug: p.slug,
      status: p.status,
      revision,
      title: r.title,
      html: r.html,
      text: r.text,
      media: json<PublishOperation["media"]>(r.media, []).map((m) => ({
        name: m.name,
        contentType: m.contentType,
        publicKey: worldMediaKey(handle, p.slug, revision, m.name),
      })),
      publishedAt: p.published_at === null ? null : Number(p.published_at),
    };
  }

  /** Author-only preview of the latest revision, including unpublished drafts. */
  preview(userId: string, postId: string): PostView {
    this.requireAuthor(userId);
    const p =
      this.sql.one<{ current_revision: number }>(
        "SELECT current_revision FROM posts WHERE id = ?",
        postId,
      ) ?? fail("not_found", "post");
    return this.view(postId, Number(p.current_revision));
  }

  publish(userId: string, postId: string): PublishPlan {
    this.requireAuthor(userId);
    return this.sql.tx(() => {
      const p =
        this.sql.one<{ slug: string; current_revision: number; published_at: number | null }>(
          "SELECT slug, current_revision, published_at FROM posts WHERE id = ?",
          postId,
        ) ?? fail("not_found", "post");
      const revision = Number(p.current_revision);
      const now = this.clock.now();
      this.sql.run(
        "UPDATE posts SET status = 'published', published_revision = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?",
        revision,
        now,
        now,
        postId,
      );
      const media = json<PublishOperation["media"]>(
        this.sql.one<{ media: string }>(
          "SELECT media FROM post_revisions WHERE post_id = ? AND revision = ?",
          postId,
          revision,
        )?.media,
        [],
      );
      this.kernel.change("post", "published", { postId, revision });
      const handle = this.meta("handle");
      return {
        postId,
        revision,
        copies: media.map((m) => ({
          from: m.contentKey,
          to: worldMediaKey(handle, p.slug, revision, m.name),
        })),
      };
    });
  }

  unpublish(userId: string, postId: string): PublishPlan {
    this.requireAuthor(userId);
    return this.sql.tx(() => {
      const p =
        this.sql.one<{ slug: string; published_revision: number | null }>(
          "SELECT slug, published_revision FROM posts WHERE id = ?",
          postId,
        ) ?? fail("not_found", "post");
      this.sql.run(
        "UPDATE posts SET status = 'unpublished', updated_at = ? WHERE id = ?",
        this.clock.now(),
        postId,
      );
      this.kernel.change("post", "unpublished", { postId });
      return { postId, revision: Number(p.published_revision ?? 0), copies: [] };
    });
  }

  /** Public read: only the published revision of a published post. */
  publicPost(slug: string): PostView | undefined {
    const p = this.sql.one<{ id: string; published_revision: number }>(
      "SELECT id, published_revision FROM posts WHERE slug = ? AND status = 'published'",
      slug,
    );
    return p ? this.view(p.id, Number(p.published_revision)) : undefined;
  }

  publicPosts(limit = 50): ReadonlyArray<PostView> {
    return this.sql
      .all<{ id: string; published_revision: number }>(
        "SELECT id, published_revision FROM posts WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ?",
        limit,
      )
      .map((p) => this.view(p.id, Number(p.published_revision)));
  }

  rss(baseUrl: string): string {
    const handle = this.meta("handle");
    const title = this.meta("title");
    const items = this.publicPosts(50)
      .map((p) => {
        const link = `${baseUrl}/@${handle}/${p.slug}`;
        // Plain-text description: the feed never carries author HTML that skipped public sanitization.
        return `<item><title>${rssEscape(p.title)}</title><link>${rssEscape(link)}</link><guid isPermaLink="true">${rssEscape(link)}</guid><pubDate>${new Date(p.publishedAt ?? 0).toUTCString()}</pubDate><description>${rssEscape(p.text)}</description></item>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${rssEscape(title)}</title><link>${rssEscape(`${baseUrl}/@${handle}`)}</link><description>${rssEscape(title)}</description>${items}</channel></rss>`;
  }

  // ---- subscriptions (P02) ----

  /** Double opt-in. Returns a confirmation token only when a confirmation mail should be sent. */
  async subscribe(
    address: string,
    source: "form" | "import" = "form",
  ): Promise<{ confirmToken: string | undefined }> {
    const a = normalizeAddress(address);
    if (!ADDRESS.test(a)) fail("bad_request", "invalid address");
    // An uninitialized World has no subscribe form: never create subscriber state for it.
    this.meta("handle");
    const token = randomToken();
    const hash = await sha256Hex(token);
    return this.sql.tx(() => ({
      confirmToken: this.invite(a, source, hash, this.clock.now()) ? token : undefined,
    }));
  }

  /**
   * Record a pending invitation (inside a transaction). False when no confirmation mail should go
   * out: already confirmed, restricted, an import of someone who unsubscribed, or invited within
   * the cooldown (the earlier, still-valid link stands).
   */
  private invite(a: string, source: "form" | "import", hash: string, now: number): boolean {
    const s = this.sql.one<{ status: string; invited_at: number | null }>(
      "SELECT status, invited_at FROM subscribers WHERE address = ?",
      a,
    );
    // Restricted (bounced/complained) addresses are not re-invited; re-consent never clears them.
    if (s?.status === "confirmed" || this.newsletter.restrictions(a).length > 0) return false;
    if (s && source === "import" && s.status === "unsubscribed") return false;
    // Still-unconfirmed invitation inside the window: no new mail. (Leaving `unsubscribed` needs the
    // recipient's own HMAC token, so a re-subscribe after it is the recipient acting, not a bomb.)
    if (
      s?.status === "pending" &&
      s.invited_at != null &&
      now - Number(s.invited_at) < SUBSCRIBE_CONFIRM_COOLDOWN_MS
    )
      return false;
    this.sql.run(
      `INSERT INTO subscribers (address, status, source, confirm_hash, created_at, invited_at) VALUES (?, 'pending', ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET status = 'pending', confirm_hash = excluded.confirm_hash, invited_at = excluded.invited_at`,
      a,
      source,
      hash,
      now,
      now,
    );
    return true;
  }

  /**
   * Confirm only a still-pending subscription; an unsubscribe that raced ahead wins. The token is
   * the recorded consent evidence (its hash is logged, never the token).
   */
  async confirm(token: string): Promise<boolean> {
    const hash = await sha256Hex(token);
    return this.sql.tx(() => {
      const s = this.sql.one<{ address: string }>(
        "SELECT address FROM subscribers WHERE confirm_hash = ? AND status = 'pending'",
        hash,
      );
      if (!s) return false;
      return this.newsletter.recordConsent(
        s.address,
        { _tag: "Confirm", evidence: `double-opt-in:${hash.slice(0, 16)}`, at: this.clock.now() },
        "confirm-link",
        `double-opt-in:${hash.slice(0, 16)}`,
      );
    });
  }

  /** Signed under the current SESSION_KEY version (links in sent mail must outlive rotation). */
  async unsubscribeToken(address: string): Promise<string> {
    return this.unsubscribeMac(this.unsubscribeSecrets.current, address);
  }

  private async unsubscribeMac(version: number, address: string): Promise<string> {
    return toBase64Url(
      await hmacSha256(
        this.unsubscribeSecrets.secrets[version]!,
        `unsub:${this.meta("author_id")}:${normalizeAddress(address)}`,
      ),
    );
  }

  /** Verifies under every version still in the ring, so a rotation never breaks sent links. */
  private async validUnsubscribeToken(address: string, token: string): Promise<boolean> {
    for (const version of ringVersions(this.unsubscribeSecrets))
      if (timingSafeEqual(await this.unsubscribeMac(version, address), token)) return true;
    return false;
  }

  /**
   * Bye-origin unsubscribe. Committed (and so blocking every later dispatch decision) before this
   * returns to the subscriber; provider synchronization is queued durably in the same transaction.
   */
  async unsubscribe(address: string, token: string): Promise<boolean> {
    if (!(await this.validUnsubscribeToken(address, token))) return false;
    const a = normalizeAddress(address);
    this.sql.tx(() => {
      if (!this.newsletter.consent(a)) return;
      this.newsletter.recordConsent(
        a,
        { _tag: "Unsubscribe", source: "bye", at: this.clock.now() },
        "unsubscribe-link",
        null,
      );
    });
    return true;
  }

  /**
   * CSV import creates confirmation invitations, never opted-in subscribers. Previously
   * unsubscribed or suppressed addresses are not re-invited.
   */
  async importCsv(
    userId: string,
    csv: string,
  ): Promise<{
    invitations: ReadonlyArray<{ address: string; token: string }>;
    skipped: ReadonlyArray<string>;
  }> {
    this.requireAuthor(userId);
    const invitations: Array<{ address: string; token: string }> = [];
    const skipped: Array<string> = [];
    const seen = new Set<string>();
    const accepted: Array<string> = [];
    for (const line of csv.split(/\r?\n/)) {
      const cell = line.split(",")[0]?.trim().replace(/^"|"$/g, "") ?? "";
      if (!cell || cell.toLowerCase() === "email") continue;
      const a = normalizeAddress(cell);
      if (seen.has(a) || !ADDRESS.test(a)) {
        skipped.push(cell);
        continue;
      }
      seen.add(a);
      accepted.push(a);
      if (accepted.length > IMPORT_MAX_ADDRESSES)
        fail("bad_request", `at most ${IMPORT_MAX_ADDRESSES} addresses per import`);
    }
    // Chunked: tokens are hashed concurrently per chunk and each chunk commits in one transaction,
    // instead of one await + one transaction per row.
    for (let i = 0; i < accepted.length; i += IMPORT_CHUNK) {
      const chunk = accepted.slice(i, i + IMPORT_CHUNK);
      const tokens = chunk.map(() => randomToken());
      // bounded: at most IMPORT_CHUNK hashes per chunk.
      const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
      const now = this.clock.now();
      this.sql.tx(() =>
        chunk.forEach((a, j) => {
          if (this.invite(a, "import", hashes[j]!, now))
            invitations.push({ address: a, token: tokens[j]! });
          else skipped.push(a);
        }),
      );
    }
    return { invitations, skipped };
  }

  exportSubscribers(userId: string): string {
    this.requireAuthor(userId);
    const rows = this.sql.all<{ address: string; confirmed_at: number }>(
      "SELECT address, confirmed_at FROM subscribers WHERE status = 'confirmed' ORDER BY address",
    );
    return (
      [
        "email,confirmed_at",
        ...rows.map((r) => `${r.address},${new Date(Number(r.confirmed_at)).toISOString()}`),
      ].join("\n") + "\n"
    );
  }

  /** Published content of one revision, for building subscription messages. */
  publishedRevision(postId: string, revision: number): PostView {
    return this.view(postId, revision);
  }

  handle(): string {
    return this.meta("handle");
  }

  authorId(): string {
    return this.meta("author_id");
  }

  /** Author's posts, including drafts and unpublished posts (newest first). */
  listPosts(userId: string): ReadonlyArray<{
    readonly id: string;
    readonly slug: string;
    readonly status: PostView["status"];
    readonly title: string;
    readonly revision: number;
    readonly publishedAt: number | null;
    readonly updatedAt: number;
  }> {
    this.requireAuthor(userId);
    return this.sql
      .all<{
        id: string;
        slug: string;
        status: PostView["status"];
        current_revision: number;
        published_at: number | null;
        updated_at: number;
        title: string;
      }>(
        "SELECT p.id, p.slug, p.status, p.current_revision, p.published_at, p.updated_at, r.title FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.revision = p.current_revision ORDER BY p.updated_at DESC, p.id DESC",
      )
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        status: r.status,
        title: r.title,
        revision: Number(r.current_revision),
        publishedAt: r.published_at === null ? null : Number(r.published_at),
        updatedAt: Number(r.updated_at),
      }));
  }

  /** Subscription status; `suppressed` when a bounce/complaint restriction applies (kept separately). */
  subscriberStatus(address: string): string | undefined {
    const a = normalizeAddress(address);
    const status = this.sql.one<{ status: string }>(
      "SELECT status FROM subscribers WHERE address = ?",
      a,
    )?.status;
    return status && this.newsletter.restrictions(a).length > 0 ? "suppressed" : status;
  }

  /** Author-scoped publication status (intent, provider-observed state, recipient outcomes). */
  newsletterStatus(userId: string, postId: string, revision: number) {
    this.requireAuthor(userId);
    const p = this.newsletter.publicationFor(postId, revision) ?? fail("not_found", "publication");
    return this.newsletter.status(p.id);
  }

  cancelNewsletter(userId: string, postId: string, revision: number) {
    this.requireAuthor(userId);
    const p = this.newsletter.publicationFor(postId, revision) ?? fail("not_found", "publication");
    return this.newsletter.requestCancel(p.id);
  }

  /** Published and still published at this revision (dispatch-time recheck). */
  isPublished(postId: string, revision: number): boolean {
    const p = this.sql.one<{ status: string; published_revision: number | null }>(
      "SELECT status, published_revision FROM posts WHERE id = ?",
      postId,
    );
    return p?.status === "published" && Number(p.published_revision) === revision;
  }
}

/** Typed stub surface of a World authority (`world:<handle>`): every store operation, enveloped. */
export type WorldRpc = RpcSurface<WorldStore>;
