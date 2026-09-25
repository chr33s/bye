import { DurableObject } from "cloudflare:workers";
import {
  NEWSLETTER_METHODS,
  type NewsletterLedger,
  type NewsletterMethod,
  SharedSpaceStore,
  WorldStore,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { pointInTimeRestore } from "../restore.ts";
import { flush, nameOf } from "./common.ts";
import { acceptLiveSocket, broadcastSeq, closeLiveSockets } from "./live.ts";
import { type RpcResult, toRpc, catalogShard } from "@bye/platform-cloudflare";

/**
 * Shared resources: `space:<id>` hosts a SharedSpaceStore (O03/O04/O05/E14); `world:<authorId>`
 * hosts a WorldStore (P01/P02). One namespace, distinct authorities per object.
 */
export class SharedSpaceDO extends DurableObject<CoreEnv> {
  /** Per-instance identity; changes when the object restarts (used to observe a completed restore). */
  private readonly epoch = crypto.randomUUID();
  sessionEpoch() {
    return this.epoch;
  }

  /** Operator point-in-time restore (§12); the ops route replays erasure tombstones afterwards. */
  restoreTo(at: number) {
    return pointInTimeRestore(this.ctx, at);
  }

  private space: SharedSpaceStore | null = null;
  private world: WorldStore | null = null;

  private get name(): string {
    return nameOf(this.ctx);
  }

  spaceStore(): SharedSpaceStore {
    if (!this.name.startsWith("space:")) throw new Error("not a shared space");
    return (this.space ??= new SharedSpaceStore(this.ctx.storage, kernelClock));
  }

  worldStore(): WorldStore {
    if (!this.name.startsWith("world:")) throw new Error("not a world author");
    return (this.world ??= new WorldStore(this.ctx.storage, kernelClock, this.env.SESSION_KEY));
  }

  private async afterCommit(): Promise<void> {
    const kernel = this.space?.kernel ?? this.world?.kernel;
    if (!kernel) return;
    if (this.space) broadcastSeq(this.ctx, kernel.currentSeq());
    await flush(this.env, kernel, this.name);
  }

  /**
   * Register this authority in the reconciliation catalog (§6 row 3). Idempotent; a failure is
   * harmless (the next init retries, and the migration backfills older spaces).
   */
  private async catalog(kind: "space" | "world", id: string): Promise<void> {
    await this.env.DIRECTORY.prepare(
      "INSERT INTO resource_catalog (kind, id, shard, provisioned_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO NOTHING",
    )
      .bind(kind, id, catalogShard(id), Date.now())
      .run()
      .catch(() => undefined);
  }

  /** The kernel of whichever authority this object hosts (null for an unknown name). */
  private kernelOf() {
    if (this.name.startsWith("space:")) return this.spaceStore().kernel;
    if (this.name.startsWith("world:")) return this.worldStore().kernel;
    return null;
  }

  /** Cron reconciliation (§6 row 3): relay any stranded outbox rows and compact change history. */
  async reconcile(_now: number): Promise<{ readonly nextWake: number | null }> {
    const kernel = this.kernelOf();
    if (!kernel) return { nextWake: null };
    kernel.compactChanges(10_000);
    await flush(this.env, kernel, this.name);
    return { nextWake: kernel.nextDueAt() };
  }

  /** Hibernating change-hint socket for a shared space (§8); membership checked by the API Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (!this.name.startsWith("space:")) return new Response("not found", { status: 404 });
    return acceptLiveSocket(this.ctx, request, this.spaceStore().kernel.currentSeq());
  }

  override async webSocketMessage(): Promise<void> {
    // Clients never send commands over the socket; mutations use the HTTP API.
  }

  /** Close live sockets for a revoked credential (or all, when none is given). */
  closeSockets(credentialId?: string): number {
    return closeLiveSockets(this.ctx, credentialId);
  }

  /** Member-only change feed for the space. */
  changes(actorId: string, cursor: number, limit?: number) {
    return this.run(() => this.spaceStore().changes(actorId, cursor, limit));
  }

  /** Every RPC runs through the platform envelope: rejections cross as data, defects throw. */
  private async run<A>(f: () => A | Promise<A>): Promise<RpcResult<A>> {
    const r = await toRpc(f);
    if (r.ok) this.ctx.waitUntil(this.afterCommit());
    return r;
  }

  // Shared spaces
  initSpace(input: Parameters<SharedSpaceStore["init"]>[0]) {
    return this.run(() => this.spaceStore().init(input)).then(async (r) => {
      if (r.ok) {
        await this.indexMembership(input.spaceId, input.ownerId, "owner");
        await this.catalog("space", input.spaceId);
      }
      return r;
    });
  }

  /** Keep the D1 membership index (used by erasure/closure) in step with the authority. */
  private async indexMembership(
    spaceId: string,
    userId: string,
    role: "owner" | "member" | null,
  ): Promise<void> {
    try {
      await (role === null
        ? this.env.DIRECTORY.prepare(
            "DELETE FROM space_memberships WHERE space_id = ? AND user_id = ?",
          )
            .bind(spaceId, userId)
            .run()
        : this.env.DIRECTORY.prepare(
            "INSERT INTO space_memberships (space_id, user_id, role, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
          )
            .bind(spaceId, userId, role, Date.now())
            .run());
    } catch {
      // The index is advisory; the DO stays authoritative and erasure also replays tombstones.
    }
  }

  /** Erasure (§12): remove the member and revoke their grants; system operation (no owner check). */
  eraseMember(userId: string) {
    return this.run(() => this.spaceStore().eraseMember(userId)).then(async (r) => {
      if (r.ok) await this.indexMembership(this.name.replace(/^space:/, ""), userId, null);
      return r;
    });
  }
  shareThread(input: Parameters<SharedSpaceStore["shareThread"]>[0]) {
    return this.run(() => this.spaceStore().shareThread(input));
  }
  appendReply(...args: Parameters<SharedSpaceStore["appendReply"]>) {
    return this.run(() => this.spaceStore().appendReply(...args));
  }
  readThread(userId: string, threadId: string) {
    return this.run(() => this.spaceStore().readThread(userId, threadId));
  }
  grant(...args: Parameters<SharedSpaceStore["grant"]>) {
    return this.run(() => this.spaceStore().grant(...args));
  }
  revoke(actorId: string, grantId: string) {
    return this.run(() => this.spaceStore().revoke(actorId, grantId));
  }
  addComment(userId: string, threadId: string, body: string) {
    return this.run(() => this.spaceStore().addComment(userId, threadId, body));
  }
  createPublicLink(...args: Parameters<SharedSpaceStore["createPublicLink"]>) {
    return this.run(() => this.spaceStore().createPublicLink(...args));
  }
  resolvePublicLink(token: string) {
    return this.run(() => this.spaceStore().resolvePublicLink(token));
  }
  revokePublicLink(actorId: string, linkId: string) {
    return this.run(() => this.spaceStore().revokePublicLink(actorId, linkId));
  }
  previewPublicLink(actorId: string, threadId: string) {
    return this.run(() => this.spaceStore().previewPublicLink(actorId, threadId));
  }
  listPublicLinks(actorId: string, threadId: string) {
    return this.run(() => this.spaceStore().listPublicLinks(actorId, threadId));
  }
  setMember(actorId: string, userId: string, role: "owner" | "member" | null) {
    return this.run(() => this.spaceStore().setMember(actorId, userId, role)).then(async (r) => {
      if (r.ok) await this.indexMembership(this.name.replace(/^space:/, ""), userId, role);
      return r;
    });
  }
  isMember(userId: string) {
    return this.run(() => this.spaceStore().isMember(userId));
  }
  listMembers(actorId: string) {
    return this.run(() => this.spaceStore().listMembers(actorId));
  }
  listThreads(userId: string) {
    return this.run(() => this.spaceStore().listThreads(userId));
  }
  comments(userId: string, threadId: string) {
    return this.run(() => this.spaceStore().comments(userId, threadId));
  }
  createCollection(ownerId: string, name: string, shareWithMembers: boolean) {
    return this.run(() => this.spaceStore().createCollection(ownerId, name, shareWithMembers));
  }
  addToCollection(userId: string, collectionId: string, threadId: string) {
    return this.run(() => this.spaceStore().addToCollection(userId, collectionId, threadId));
  }
  listCollections(userId: string) {
    return this.run(() => this.spaceStore().listCollections(userId));
  }
  collectionTimeline(userId: string, collectionId: string) {
    return this.run(() => this.spaceStore().collectionTimeline(userId, collectionId));
  }
  grantsFor(actorId: string, kind: "thread" | "collection", resourceId: string) {
    return this.run(() => this.spaceStore().grantsFor(actorId, kind, resourceId));
  }
  configureExtension(
    actorId: string,
    input: Parameters<SharedSpaceStore["configureExtension"]>[1],
  ) {
    return this.run(() => this.spaceStore().configureExtension(actorId, input));
  }
  canSendAs(userId: string, address: string) {
    return this.run(() => this.spaceStore().canSendAs(userId, address));
  }
  receiveExtensionMail(
    eventId: string,
    input: Parameters<SharedSpaceStore["receiveExtensionMail"]>[1],
  ) {
    return this.run(() => this.spaceStore().receiveExtensionMail(eventId, input));
  }

  /** Content keys copied from a source mailbox (`t/<mailboxId>/` prefix), for pin backfill. */
  contentKeys(prefix: string, after: string | null, limit: number) {
    return this.run(() => this.spaceStore().contentKeys(prefix, after, limit));
  }

  // World publishing
  worldAuthorId() {
    return this.run(() => this.worldStore().ownerId());
  }
  eraseWorld(authorId: string | null) {
    return this.run(() => this.worldStore().erase(authorId));
  }
  initWorld(input: Parameters<WorldStore["init"]>[0]) {
    return this.run(() => this.worldStore().init(input)).then(async (r) => {
      if (r.ok) await this.catalog("world", input.handle);
      return r;
    });
  }
  publishFromMail(op: Parameters<WorldStore["publishFromMail"]>[0], eventId?: string) {
    return this.run(() => this.worldStore().publishFromMail(op, eventId));
  }
  unpublish(userId: string, postId: string) {
    return this.run(() => this.worldStore().unpublish(userId, postId));
  }
  publicPosts() {
    return this.run(() => this.worldStore().publicPosts());
  }
  rss(baseUrl: string) {
    return this.run(() => this.worldStore().rss(baseUrl));
  }
  subscribe(address: string) {
    return this.run(() => this.worldStore().subscribe(address));
  }
  confirm(token: string) {
    return this.run(() => this.worldStore().confirm(token));
  }
  unsubscribe(address: string, token: string) {
    return this.run(() => this.worldStore().unsubscribe(address, token));
  }
  /**
   * Newsletter ledger operations (spec.md §5.5), called by the newsletter engine and webhook. One
   * allowlisted entry point keeps the DO surface small; every call runs in the store's transaction.
   */
  newsletter<K extends NewsletterMethod>(method: K, ...args: Parameters<NewsletterLedger[K]>) {
    return this.run(() => {
      if (!NEWSLETTER_METHODS.includes(method)) throw new Error(`newsletter.${method} not allowed`);
      const ledger = this.worldStore().newsletter;
      return (ledger[method] as (...a: typeof args) => ReturnType<NewsletterLedger[K]>)(...args);
    });
  }
  newsletterStatus(userId: string, postId: string, revision: number) {
    return this.run(() => this.worldStore().newsletterStatus(userId, postId, revision));
  }
  cancelNewsletter(userId: string, postId: string, revision: number) {
    return this.run(() => this.worldStore().cancelNewsletter(userId, postId, revision));
  }
  isPublished(postId: string, revision: number) {
    return this.run(() => this.worldStore().isPublished(postId, revision));
  }
  publishedRevision(postId: string, revision: number) {
    return this.run(() => this.worldStore().publishedRevision(postId, revision));
  }
  worldInfo() {
    return this.run(() => ({
      handle: this.worldStore().handle(),
      authorId: this.worldStore().authorId(),
    }));
  }
  createDraft(userId: string, input: Parameters<WorldStore["createDraft"]>[1]) {
    return this.run(() => this.worldStore().createDraft(userId, input));
  }
  editPost(userId: string, postId: string, input: Parameters<WorldStore["edit"]>[2]) {
    return this.run(() => this.worldStore().edit(userId, postId, input));
  }
  previewPost(userId: string, postId: string) {
    return this.run(() => this.worldStore().preview(userId, postId));
  }
  publishPost(userId: string, postId: string) {
    return this.run(() => this.worldStore().publish(userId, postId));
  }
  listPosts(userId: string) {
    return this.run(() => this.worldStore().listPosts(userId));
  }
  importSubscribers(userId: string, csv: string) {
    return this.run(() => this.worldStore().importCsv(userId, csv));
  }
  exportSubscribers(userId: string) {
    return this.run(() => this.worldStore().exportSubscribers(userId));
  }
  subscriberStatus(address: string) {
    return this.run(() => this.worldStore().subscriberStatus(address));
  }
}
