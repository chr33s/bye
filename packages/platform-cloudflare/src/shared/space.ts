import { reject, type RpcSurface } from "../durable/rpc.ts";
import { Kernel, KERNEL_MIGRATIONS, type KernelClock } from "../durable/kernel.ts";
import {
  bool,
  json,
  type Migration,
  migrate,
  Sql,
  type TransactionalStorage,
} from "../durable/sql.ts";
import { randomToken, sha256Hex } from "../control/crypto.ts";

// SharedSpaceDO authority (§3.2, O03, O04, O05, E14). Owns shared threads, collections,
// resource grants, private comments, extension settings and public links. Every read rechecks
// current membership and grants; revocation blocks subsequent reads, blob downloads and search
// hydration (already-downloaded content cannot be recalled).

export const SPACE_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "space",
    statements: [
      "CREATE TABLE space_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      `CREATE TABLE space_members (
        user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'removed')), added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE shared_threads (
        id TEXT PRIMARY KEY, source_mailbox_id TEXT NOT NULL, source_thread_id TEXT NOT NULL, subject TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, include_future INTEGER NOT NULL,
        UNIQUE (source_mailbox_id, source_thread_id))`,
      `CREATE TABLE shared_messages (
        thread_id TEXT NOT NULL, message_ref TEXT NOT NULL, from_json TEXT NOT NULL, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
        subject TEXT NOT NULL, snippet TEXT NOT NULL, content_key TEXT NOT NULL, sent_at INTEGER NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_ref))`,
      "CREATE INDEX shared_messages_content ON shared_messages (content_key)",
      `CREATE TABLE grants (
        id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL CHECK (resource_kind IN ('thread', 'collection')), resource_id TEXT NOT NULL,
        grantee TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
      "CREATE INDEX grants_resource ON grants (resource_kind, resource_id, revoked_at)",
      `CREATE TABLE comments (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER)`,
      `CREATE TABLE collections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE collection_items (
        collection_id TEXT NOT NULL, thread_id TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, thread_id))`,
      `CREATE TABLE extension (
        address TEXT PRIMARY KEY, display_name TEXT NOT NULL, send_as INTEGER NOT NULL, workflow_board TEXT, workflow_stage TEXT, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE public_links (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, include_future INTEGER NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER)`,
    ],
  },
];

export interface SharedAddress {
  readonly name?: string | undefined;
  readonly address: string;
}

/**
 * A message reference visible to collaborators. There is deliberately no Bcc field: hidden
 * recipients never enter a shared resource, public link, or MIME built from it.
 */
export interface SharedMessageInput {
  readonly messageRef: string;
  readonly from: SharedAddress;
  readonly to: ReadonlyArray<SharedAddress>;
  readonly cc: ReadonlyArray<SharedAddress>;
  readonly subject: string;
  readonly snippet: string;
  readonly contentKey: string;
  readonly sentAt: number;
}

export interface SharedMessageView extends SharedMessageInput {
  readonly addedAt: number;
}

export interface SharedThreadView {
  readonly id: string;
  readonly subject: string;
  readonly includeFuture: boolean;
  readonly messages: ReadonlyArray<SharedMessageView>;
}

export interface CommentView {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface PublicThreadView {
  readonly subject: string;
  readonly messages: ReadonlyArray<{
    readonly from: SharedAddress;
    readonly to: ReadonlyArray<SharedAddress>;
    readonly cc: ReadonlyArray<SharedAddress>;
    readonly subject: string;
    readonly snippet: string;
    readonly contentKey: string;
    readonly sentAt: number;
  }>;
}

type ResourceKind = "thread" | "collection";

export type SpaceErrorCode = "forbidden" | "not_found" | "conflict" | "gone" | "bad_request";

const fail = (code: SpaceErrorCode, message: string): never => reject(code, message);

/** Grantee value meaning "every active member of this space". */
export const ALL_MEMBERS = "members";

export class SharedSpaceStore {
  readonly sql: Sql;
  readonly kernel: Kernel;

  constructor(
    storage: TransactionalStorage,
    readonly clock: KernelClock,
  ) {
    this.sql = new Sql(storage);
    migrate(this.sql, "kernel", KERNEL_MIGRATIONS);
    migrate(this.sql, "space", SPACE_MIGRATIONS);
    this.kernel = new Kernel(this.sql, clock);
  }

  // ---- membership ----

  init(input: {
    spaceId: string;
    kind: "team" | "extension";
    organizationId: string;
    ownerId: string;
  }): void {
    this.sql.tx(() => {
      if (this.meta("space_id")) return;
      const now = this.clock.now();

      for (const [k, v] of Object.entries({
        space_id: input.spaceId,
        kind: input.kind,
        organization_id: input.organizationId,
        membership_version: "1",
      })) {
        this.sql.run("INSERT INTO space_meta (key, value) VALUES (?, ?)", k, v);
      }

      this.sql.run(
        "INSERT INTO space_members (user_id, role, status, added_at, updated_at) VALUES (?, 'owner', 'active', ?, ?)",
        input.ownerId,
        now,
        now,
      );
    });
  }

  private meta(key: string): string | undefined {
    return this.sql.one<{ value: string }>("SELECT value FROM space_meta WHERE key = ?", key)
      ?.value;
  }

  membershipVersion(): number {
    return Number(this.meta("membership_version") ?? 0);
  }

  /** Change feed for members (§8): expired cursors report `expired` and clients refresh. */
  changes(actorId: string, cursor: number, limit = 500): ReturnType<Kernel["changesSince"]> {
    if (!this.isMember(actorId)) fail("forbidden", "not a space member");

    return this.kernel.changesSince(cursor, Math.min(Math.max(limit, 1), 500));
  }

  isMember(userId: string): boolean {
    return (
      this.sql.one(
        "SELECT 1 AS m FROM space_members WHERE user_id = ? AND status = 'active'",
        userId,
      ) !== undefined
    );
  }

  private requireOwner(userId: string): void {
    const r = this.sql.one<{ role: string }>(
      "SELECT role FROM space_members WHERE user_id = ? AND status = 'active'",
      userId,
    );

    if (r?.role !== "owner") fail("forbidden", "space owner required");
  }

  private bumpMembership(): number {
    const next = this.membershipVersion() + 1;
    this.sql.run("UPDATE space_meta SET value = ? WHERE key = 'membership_version'", String(next));

    return next;
  }

  setMember(actorId: string, userId: string, role: "owner" | "member" | null): number {
    return this.sql.tx(() => {
      this.requireOwner(actorId);
      const now = this.clock.now();

      // Removing OR demoting the last owner would leave nobody able to manage the space.
      const otherOwners =
        this.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM space_members WHERE role = 'owner' AND status = 'active' AND user_id != ?",
          userId,
        )?.n ?? 0;

      const target = this.sql.one<{ role: string }>(
        "SELECT role FROM space_members WHERE user_id = ? AND status = 'active'",
        userId,
      );

      if (target?.role === "owner" && role !== "owner" && otherOwners === 0)
        fail(
          "conflict",
          role === null ? "cannot remove the last owner" : "cannot demote the last owner",
        );

      if (role === null) {
        this.sql.run(
          "UPDATE space_members SET status = 'removed', updated_at = ? WHERE user_id = ?",
          now,
          userId,
        );
        // Leaving the space ends access through it: direct grants to the removed member are revoked
        // too (re-adding them later does not resurrect old grants).
        this.sql.run(
          "UPDATE grants SET revoked_at = ? WHERE grantee = ? AND revoked_at IS NULL",
          now,
          userId,
        );
        // Public links they created were authorized by access they no longer have.
        this.sql.run(
          "UPDATE public_links SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL",
          now,
          userId,
        );
        this.kernel.change("member", "removed", { userId });
      } else {
        this.sql.run(
          "INSERT INTO space_members (user_id, role, status, added_at, updated_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at",
          userId,
          role,
          now,
          now,
        );
        this.kernel.change("member", "added", { userId, role });
      }

      return this.bumpMembership();
    });
  }

  /**
   * Erasure (§12): remove a user's membership and every grant made to them, without the
   * owner check (system operation). Content they shared stays with the space. Idempotent.
   */
  eraseMember(userId: string): { readonly removed: boolean; readonly grantsRevoked: number } {
    return this.sql.tx(() => {
      const now = this.clock.now();

      const removed =
        this.sql.run(
          "UPDATE space_members SET status = 'removed', updated_at = ? WHERE user_id = ? AND status = 'active'",
          now,
          userId,
        ) > 0;

      const grantsRevoked = this.sql.run(
        "UPDATE grants SET revoked_at = ? WHERE grantee = ? AND revoked_at IS NULL",
        now,
        userId,
      );

      this.sql.run(
        "UPDATE public_links SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL",
        now,
        userId,
      );

      if (removed || grantsRevoked > 0) {
        this.kernel.change("member", "erased", { userId });
        this.bumpMembership();
      }

      return { removed, grantsRevoked };
    });
  }

  /** Members of the space, visible to active members only. */
  listMembers(actorId: string): ReadonlyArray<{
    readonly userId: string;
    readonly role: "owner" | "member";
    readonly addedAt: number;
  }> {
    if (!this.isMember(actorId)) fail("forbidden", "not a space member");

    return this.sql
      .all<{ user_id: string; role: "owner" | "member"; added_at: number }>(
        "SELECT user_id, role, added_at FROM space_members WHERE status = 'active' ORDER BY added_at, user_id",
      )
      .map((r) => ({ userId: r.user_id, role: r.role, addedAt: Number(r.added_at) }));
  }

  /** Shared threads the user can read right now (grants rechecked per thread). */
  listThreads(userId: string): ReadonlyArray<{
    readonly id: string;
    readonly subject: string;
    readonly includeFuture: boolean;
    readonly createdAt: number;
    readonly messages: number;
  }> {
    return this.sql
      .all<{ id: string; subject: string; include_future: number; created_at: number; n: number }>(
        "SELECT t.id, t.subject, t.include_future, t.created_at, (SELECT COUNT(*) FROM shared_messages m WHERE m.thread_id = t.id) AS n FROM shared_threads t ORDER BY t.created_at DESC, t.id",
      )
      .filter((r) => this.canReadThread(userId, r.id))
      .map((r) => ({
        id: r.id,
        subject: r.subject,
        includeFuture: bool(r.include_future),
        createdAt: Number(r.created_at),
        messages: Number(r.n),
      }));
  }

  listCollections(userId: string): ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly items: number;
  }> {
    return this.sql
      .all<{ id: string; name: string; owner_id: string; n: number }>(
        "SELECT c.id, c.name, c.owner_id, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) AS n FROM collections c ORDER BY c.created_at, c.id",
      )
      .filter((r) => this.hasGrant("collection", r.id, userId))
      .map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, items: Number(r.n) }));
  }

  /** Active grants on a resource, visible to its owner (or a space owner) for revocation UIs. */
  grantsFor(
    actorId: string,
    kind: "thread" | "collection",
    resourceId: string,
  ): ReadonlyArray<{
    readonly id: string;
    readonly grantee: string;
    readonly createdBy: string;
    readonly createdAt: number;
  }> {
    const owner = this.resourceOwner(kind, resourceId);

    if (owner === undefined) return fail("not_found", kind);

    if (owner !== actorId) this.requireOwner(actorId);

    return this.sql
      .all<{ id: string; grantee: string; created_by: string; created_at: number }>(
        "SELECT id, grantee, created_by, created_at FROM grants WHERE resource_kind = ? AND resource_id = ? AND revoked_at IS NULL ORDER BY created_at, id",
        kind,
        resourceId,
      )
      .map((r) => ({
        id: r.id,
        grantee: r.grantee,
        createdBy: r.created_by,
        createdAt: Number(r.created_at),
      }));
  }

  /** Public links on a thread (owner or link creator view). Tokens are never returned. */
  listPublicLinks(
    actorId: string,
    threadId: string,
  ): ReadonlyArray<{
    readonly id: string;
    readonly includeFuture: boolean;
    readonly createdAt: number;
    readonly expiresAt: number | null;
  }> {
    if (!this.canReadThread(actorId, threadId)) fail("forbidden", "no current grant");

    return this.sql
      .all<{ id: string; include_future: number; created_at: number; expires_at: number | null }>(
        "SELECT id, include_future, created_at, expires_at FROM public_links WHERE thread_id = ? AND revoked_at IS NULL ORDER BY created_at",
        threadId,
      )
      .map((r) => ({
        id: r.id,
        includeFuture: bool(r.include_future),
        createdAt: Number(r.created_at),
        expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      }));
  }

  // ---- grants ----

  /** Creator of a shared thread, or owner of a collection; `undefined` when it doesn't exist. */
  private resourceOwner(kind: ResourceKind, resourceId: string): string | undefined {
    return kind === "thread"
      ? this.sql.one<{ o: string }>(
          "SELECT created_by AS o FROM shared_threads WHERE id = ?",
          resourceId,
        )?.o
      : this.sql.one<{ o: string }>(
          "SELECT owner_id AS o FROM collections WHERE id = ?",
          resourceId,
        )?.o;
  }

  private insertGrant(
    kind: ResourceKind,
    resourceId: string,
    grantee: string,
    createdBy: string,
  ): string {
    const id = this.clock.id("grt");
    this.sql.run(
      "INSERT INTO grants (id, resource_kind, resource_id, grantee, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      kind,
      resourceId,
      grantee,
      createdBy,
      this.clock.now(),
    );

    return id;
  }

  private hasGrant(kind: ResourceKind, id: string, userId: string): boolean {
    const member = this.isMember(userId);

    return (
      this.sql.one(
        "SELECT 1 AS g FROM grants WHERE resource_kind = ? AND resource_id = ? AND revoked_at IS NULL AND (grantee = ? OR (grantee = ? AND ?))",
        kind,
        id,
        userId,
        ALL_MEMBERS,
        member,
      ) !== undefined
    );
  }

  canReadThread(userId: string, threadId: string): boolean {
    return this.hasGrant("thread", threadId, userId);
  }

  grant(
    actorId: string,
    kind: "thread" | "collection",
    resourceId: string,
    grantee: string,
  ): string {
    return this.sql.tx(() => {
      const owns = this.resourceOwner(kind, resourceId);

      if (owns === undefined) fail("not_found", kind);

      if (owns !== actorId && !this.hasGrant(kind, resourceId, actorId))
        fail("forbidden", "cannot share what you cannot read");
      const id = this.insertGrant(kind, resourceId, grantee, actorId);
      this.kernel.change(kind, "granted", { resourceId, grantee });

      return id;
    });
  }

  /** Revocation takes effect for every subsequent read; connected clients get a change event. */
  revoke(actorId: string, grantId: string): void {
    this.sql.tx(() => {
      const g = this.sql.one<{
        resource_kind: ResourceKind;
        resource_id: string;
        grantee: string;
        created_by: string;
      }>(
        "SELECT resource_kind, resource_id, grantee, created_by FROM grants WHERE id = ? AND revoked_at IS NULL",
        grantId,
      );

      if (!g) return fail("not_found", "grant");
      const owner = this.resourceOwner(g.resource_kind, g.resource_id);

      if (actorId !== g.created_by && actorId !== owner) this.requireOwner(actorId);
      this.sql.run("UPDATE grants SET revoked_at = ? WHERE id = ?", this.clock.now(), grantId);
      this.kernel.change(g.resource_kind, "revoked", {
        resourceId: g.resource_id,
        grantee: g.grantee,
      });
    });
  }

  // ---- shared threads ----

  private insertMessage(threadId: string, m: SharedMessageInput): boolean {
    const inserted =
      this.sql.run(
        "INSERT OR IGNORE INTO shared_messages (thread_id, message_ref, from_json, to_json, cc_json, subject, snippet, content_key, sent_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        threadId,
        m.messageRef,
        JSON.stringify(pickAddress(m.from)),
        JSON.stringify(m.to.map(pickAddress)),
        JSON.stringify(m.cc.map(pickAddress)),
        m.subject,
        m.snippet,
        m.contentKey,
        m.sentAt,
        this.clock.now(),
      ) > 0;

    // The space now references the source mailbox's stored message (original, body, parts): pin it,
    // in the same transaction via the outbox, so the owner's retention/trash can't garbage-collect
    // content space members and public links still read (§12).
    if (inserted) {
      const spaceId = this.meta("space_id") ?? "";
      this.kernel.emit("blob.pin", spaceId, {
        bucket: "ORIGINALS",
        key: m.contentKey,
        holderKind: "space",
        holderId: spaceId,
      });
    }

    return inserted;
  }

  /**
   * Share explicitly selected history. `includeFuture` is visible in the sharing UI and decides
   * whether later replies propagate. Idempotent per (source mailbox, source thread).
   */
  shareThread(input: {
    actorId: string;
    sourceMailboxId: string;
    sourceThreadId: string;
    subject: string;
    messages: ReadonlyArray<SharedMessageInput>;
    grantees: ReadonlyArray<string>;
    includeFuture: boolean;
  }): string {
    return this.sql.tx(() => {
      if (!this.isMember(input.actorId)) fail("forbidden", "not a space member");

      const existing = this.sql.one<{ id: string }>(
        "SELECT id FROM shared_threads WHERE source_mailbox_id = ? AND source_thread_id = ?",
        input.sourceMailboxId,
        input.sourceThreadId,
      );

      const id = existing?.id ?? this.clock.id("sth");

      if (!existing) {
        this.sql.run(
          "INSERT INTO shared_threads (id, source_mailbox_id, source_thread_id, subject, created_by, created_at, include_future) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          input.sourceMailboxId,
          input.sourceThreadId,
          input.subject,
          input.actorId,
          this.clock.now(),
          input.includeFuture,
        );
        this.insertGrant("thread", id, input.actorId, input.actorId);
      }

      for (const m of input.messages) this.insertMessage(id, m);

      for (const g of input.grantees) {
        if (
          this.sql.one(
            "SELECT 1 AS g FROM grants WHERE resource_kind = 'thread' AND resource_id = ? AND grantee = ? AND revoked_at IS NULL",
            id,
            g,
          )
        )
          continue;
        this.insertGrant("thread", id, g, input.actorId);
      }

      this.kernel.change("thread", "shared", { threadId: id });

      return id;
    });
  }

  /**
   * Propagated reply from the source mailbox (source outbox → queue → here). Deduplicated by
   * event ID; accepted only when future replies were included. Emits notify events per grantee.
   */
  appendReply(
    eventId: string,
    sourceMailboxId: string,
    sourceThreadId: string,
    message: SharedMessageInput,
  ): { accepted: boolean; replayed: boolean } {
    return this.sql.tx(() => {
      const { result, replayed } = this.kernel.consume(
        eventId,
        `${sourceMailboxId}:${sourceThreadId}`,
        () => {
          const t = this.sql.one<{ id: string; include_future: number }>(
            "SELECT id, include_future FROM shared_threads WHERE source_mailbox_id = ? AND source_thread_id = ?",
            sourceMailboxId,
            sourceThreadId,
          );

          if (!t || !bool(t.include_future)) return false;

          if (!this.insertMessage(t.id, message)) return false;
          this.kernel.change("thread", "reply", { threadId: t.id, messageRef: message.messageRef });

          for (const g of this.sql.all<{ grantee: string }>(
            "SELECT DISTINCT grantee FROM grants WHERE resource_kind = 'thread' AND resource_id = ? AND revoked_at IS NULL",
            t.id,
          )) {
            this.kernel.outbox("notify", g.grantee, { kind: "shared-reply", threadId: t.id });
          }

          return true;
        },
      );

      return { accepted: result, replayed };
    });
  }

  readThread(userId: string, threadId: string): SharedThreadView {
    const t = this.sql.one<{ id: string; subject: string; include_future: number }>(
      "SELECT id, subject, include_future FROM shared_threads WHERE id = ?",
      threadId,
    );

    if (!t) return fail("not_found", "thread");

    if (!this.canReadThread(userId, threadId)) fail("forbidden", "no current grant");

    return {
      id: t.id,
      subject: t.subject,
      includeFuture: bool(t.include_future),
      messages: this.messages(threadId),
    };
  }

  private messages(threadId: string, addedBefore?: number): Array<SharedMessageView> {
    return this.sql
      .all<{
        message_ref: string;
        from_json: string;
        to_json: string;
        cc_json: string;
        subject: string;
        snippet: string;
        content_key: string;
        sent_at: number;
        added_at: number;
      }>(
        "SELECT message_ref, from_json, to_json, cc_json, subject, snippet, content_key, sent_at, added_at FROM shared_messages WHERE thread_id = ? AND added_at <= ? ORDER BY sent_at, message_ref",
        threadId,
        addedBefore ?? Number.MAX_SAFE_INTEGER,
      )
      .map((r) => ({
        messageRef: r.message_ref,
        from: json<SharedAddress>(r.from_json, { address: "" }),
        to: json<Array<SharedAddress>>(r.to_json, []),
        cc: json<Array<SharedAddress>>(r.cc_json, []),
        subject: r.subject,
        snippet: r.snippet,
        contentKey: r.content_key,
        sentAt: Number(r.sent_at),
        addedAt: Number(r.added_at),
      }));
  }

  /** Distinct content keys under `prefix` (a source mailbox's `t/<id>/`), paged by key (pin backfill). */
  contentKeys(prefix: string, after: string | null, limit: number): ReadonlyArray<string> {
    return this.sql
      .all<{ content_key: string }>(
        "SELECT DISTINCT content_key FROM shared_messages WHERE content_key >= ? AND content_key < ? AND content_key > ? ORDER BY content_key LIMIT ?",
        prefix,
        `${prefix}\uffff`,
        after ?? "",
        Math.min(Math.max(limit, 1), 1000),
      )
      .map((r) => r.content_key);
  }

  /** Blob download authorization: the key must belong to a thread the user can read now. */
  authorizeContent(userId: string, contentKey: string): boolean {
    return this.sql
      .all<{ thread_id: string }>(
        "SELECT DISTINCT thread_id FROM shared_messages WHERE content_key = ?",
        contentKey,
      )
      .some((r) => this.canReadThread(userId, r.thread_id));
  }

  /** Search hydration: stale index hits for revoked threads are dropped. */
  hydrate(userId: string, threadIds: ReadonlyArray<string>): ReadonlyArray<string> {
    return threadIds.filter((id) => this.canReadThread(userId, id));
  }

  /** The only content that may enter outbound MIME from a shared thread: messages, never comments. */
  mimeSource(userId: string, threadId: string): ReadonlyArray<SharedMessageView> {
    return this.readThread(userId, threadId).messages;
  }

  // ---- private comments ----

  addComment(userId: string, threadId: string, body: string): string {
    return this.sql.tx(() => {
      if (!this.canReadThread(userId, threadId)) fail("forbidden", "no current grant");

      if (body.trim().length === 0 || body.length > 20_000) fail("bad_request", "invalid comment");
      const id = this.clock.id("cmt");
      this.sql.run(
        "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        threadId,
        userId,
        body,
        this.clock.now(),
      );
      this.kernel.change("comment", "added", { threadId, id });

      return id;
    });
  }

  comments(userId: string, threadId: string): ReadonlyArray<CommentView> {
    if (!this.canReadThread(userId, threadId)) fail("forbidden", "no current grant");

    return this.sql
      .all<{ id: string; author_id: string; body: string; created_at: number }>(
        "SELECT id, author_id, body, created_at FROM comments WHERE thread_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
        threadId,
      )
      .map((r) => ({
        id: r.id,
        authorId: r.author_id,
        body: r.body,
        createdAt: Number(r.created_at),
      }));
  }

  // ---- collections (E14 shared collections) ----

  createCollection(ownerId: string, name: string, shareWithMembers: boolean): string {
    return this.sql.tx(() => {
      if (!this.isMember(ownerId)) fail("forbidden", "not a space member");
      const id = this.clock.id("col");
      this.sql.run(
        "INSERT INTO collections (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
        id,
        name,
        ownerId,
        this.clock.now(),
      );
      this.insertGrant("collection", id, ownerId, ownerId);

      if (shareWithMembers) this.insertGrant("collection", id, ALL_MEMBERS, ownerId);

      return id;
    });
  }

  addToCollection(userId: string, collectionId: string, threadId: string): void {
    this.sql.tx(() => {
      if (!this.hasGrant("collection", collectionId, userId))
        fail("forbidden", "no collection grant");

      if (!this.canReadThread(userId, threadId))
        fail("forbidden", "cannot add a thread you cannot read");
      this.sql.run(
        "INSERT OR IGNORE INTO collection_items (collection_id, thread_id, added_by, added_at) VALUES (?, ?, ?, ?)",
        collectionId,
        threadId,
        userId,
        this.clock.now(),
      );
      this.kernel.change("collection", "item-added", { collectionId, threadId });
    });
  }

  /**
   * Aggregated timeline across included threads. Permissions apply per item: threads the viewer
   * cannot read are omitted even though the collection itself is visible.
   */
  collectionTimeline(
    userId: string,
    collectionId: string,
  ): ReadonlyArray<SharedMessageView & { readonly threadId: string }> {
    if (!this.hasGrant("collection", collectionId, userId))
      fail("forbidden", "no collection grant");

    const threads = this.sql
      .all<{ thread_id: string }>(
        "SELECT thread_id FROM collection_items WHERE collection_id = ?",
        collectionId,
      )
      .map((r) => r.thread_id);

    return threads
      .filter((t) => this.canReadThread(userId, t))
      .flatMap((t) => this.messages(t).map((m) => ({ ...m, threadId: t })))
      .sort((a, b) => a.sentAt - b.sentAt || a.messageRef.localeCompare(b.messageRef));
  }

  // ---- extensions / shared addresses (O03) ----

  configureExtension(
    actorId: string,
    input: {
      address: string;
      displayName: string;
      sendAs: boolean;
      workflowBoard?: string;
      workflowStage?: string;
    },
  ): void {
    this.sql.tx(() => {
      this.requireOwner(actorId);
      this.sql.run(
        `INSERT INTO extension (address, display_name, send_as, workflow_board, workflow_stage, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET display_name = excluded.display_name, send_as = excluded.send_as, workflow_board = excluded.workflow_board, workflow_stage = excluded.workflow_stage, updated_at = excluded.updated_at`,
        input.address.toLowerCase(),
        input.displayName,
        input.sendAs,
        input.workflowBoard ?? null,
        input.workflowStage ?? null,
        this.clock.now(),
      );
    });
  }

  /** Authorized send-as: current active membership and the extension permits member sending. */
  canSendAs(userId: string, address: string): boolean {
    const e = this.sql.one<{ send_as: number }>(
      "SELECT send_as FROM extension WHERE address = ?",
      address.toLowerCase(),
    );

    return e !== undefined && bool(e.send_as) && this.isMember(userId);
  }

  /**
   * Inbound mail to an extension joins the common history visible to all members, and returns the
   * automatic workflow enrollment target, if configured.
   */
  receiveExtensionMail(
    eventId: string,
    input: {
      address: string;
      sourceMailboxId: string;
      sourceThreadId: string;
      subject: string;
      message: SharedMessageInput;
    },
  ): { threadId: string; enroll: { board: string; stage: string | undefined } | undefined } {
    return this.sql.tx(
      () =>
        this.kernel.consume(eventId, input.address, () => {
          const ext = this.sql.one<{
            workflow_board: string | null;
            workflow_stage: string | null;
          }>(
            "SELECT workflow_board, workflow_stage FROM extension WHERE address = ?",
            input.address.toLowerCase(),
          );

          if (!ext) return fail("not_found", "extension");

          let t = this.sql.one<{ id: string }>(
            "SELECT id FROM shared_threads WHERE source_mailbox_id = ? AND source_thread_id = ?",
            input.sourceMailboxId,
            input.sourceThreadId,
          );

          if (!t) {
            const id = this.clock.id("sth");
            this.sql.run(
              "INSERT INTO shared_threads (id, source_mailbox_id, source_thread_id, subject, created_by, created_at, include_future) VALUES (?, ?, ?, ?, ?, ?, 1)",
              id,
              input.sourceMailboxId,
              input.sourceThreadId,
              input.subject,
              `ext:${input.address}`,
              this.clock.now(),
            );
            this.insertGrant("thread", id, ALL_MEMBERS, `ext:${input.address}`);
            t = { id };
          }

          this.insertMessage(t.id, input.message);
          this.kernel.change("thread", "extension-mail", { threadId: t.id });

          return {
            threadId: t.id,
            enroll: ext.workflow_board
              ? { board: ext.workflow_board, stage: ext.workflow_stage ?? undefined }
              : undefined,
          };
        }).result,
    );
  }

  // ---- public links (O05) ----

  /** Create a bearer link. Only the hash is stored; the caller must have enforced step-up. */
  async createPublicLink(
    actorId: string,
    threadId: string,
    options: { includeFuture: boolean; expiresAt?: number },
  ): Promise<{ linkId: string; token: string }> {
    const token = randomToken();
    const hash = await sha256Hex(token);

    return this.sql.tx(() => {
      if (!this.canReadThread(actorId, threadId))
        fail("forbidden", "cannot publish a thread you cannot read");
      const id = this.clock.id("lnk");
      this.sql.run(
        "INSERT INTO public_links (id, token_hash, thread_id, include_future, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        hash,
        threadId,
        options.includeFuture,
        actorId,
        this.clock.now(),
        options.expiresAt ?? null,
      );
      this.kernel.change("link", "created", { linkId: id, threadId });

      return { linkId: id, token };
    });
  }

  /** Preview exactly what a public link would expose, before creating it. */
  previewPublicLink(actorId: string, threadId: string): PublicThreadView {
    const t = this.readThread(actorId, threadId);

    return { subject: t.subject, messages: t.messages.map(publicMessage) };
  }

  /**
   * `createdBy` lets the caller (PublicGateway) re-check the creator's organization membership,
   * which lives in D1, not in this authority.
   */
  async resolvePublicLink(
    token: string,
  ): Promise<PublicThreadView & { readonly createdBy: string }> {
    const hash = await sha256Hex(token);

    const link = this.sql.one<{
      thread_id: string;
      include_future: number;
      created_by: string;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
    }>(
      "SELECT thread_id, include_future, created_by, created_at, expires_at, revoked_at FROM public_links WHERE token_hash = ?",
      hash,
    );

    if (!link) return fail("not_found", "link");

    if (
      link.revoked_at !== null ||
      (link.expires_at !== null && link.expires_at <= this.clock.now())
    )
      fail("gone", "link revoked or expired");

    // A bearer link is only as good as its creator's current access (covers grant revocation too).
    if (!this.canReadThread(link.created_by, link.thread_id))
      fail("gone", "link creator no longer has access");

    const t = this.sql.one<{ subject: string }>(
      "SELECT subject FROM shared_threads WHERE id = ?",
      link.thread_id,
    );

    if (!t) return fail("not_found", "thread");

    const msgs = this.messages(
      link.thread_id,
      bool(link.include_future) ? undefined : Number(link.created_at),
    );

    return { subject: t.subject, messages: msgs.map(publicMessage), createdBy: link.created_by };
  }

  revokePublicLink(actorId: string, linkId: string): void {
    this.sql.tx(() => {
      const l = this.sql.one<{ created_by: string }>(
        "SELECT created_by FROM public_links WHERE id = ? AND revoked_at IS NULL",
        linkId,
      );

      if (!l) return fail("not_found", "link");

      if (l.created_by !== actorId) this.requireOwner(actorId);
      this.sql.run("UPDATE public_links SET revoked_at = ? WHERE id = ?", this.clock.now(), linkId);
      this.kernel.change("link", "revoked", { linkId });
    });
  }
}

const pickAddress = (a: SharedAddress): SharedAddress =>
  a.name ? { name: a.name, address: a.address } : { address: a.address };

const publicMessage = (m: SharedMessageView) => ({
  from: m.from,
  to: m.to,
  cc: m.cc,
  subject: m.subject,
  snippet: m.snippet,
  contentKey: m.contentKey,
  sentAt: m.sentAt,
});

/** Typed stub surface of a SharedSpaceDO (`space:<id>`): every store operation, enveloped. */
export type SharedSpaceRpc = RpcSurface<SharedSpaceStore>;
