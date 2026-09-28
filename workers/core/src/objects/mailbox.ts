import { Predicate } from "effect";
import { DurableObject } from "cloudflare:workers";
import type { MailboxDeliveryCommit } from "@bye/application";
import type { MailboxCommand, MailViewQuery } from "@bye/contracts";
import type { RecipientOutcome } from "@bye/domain";
import { normalizeSubject } from "@bye/mail-codec";
import {
  guardMailboxRead,
  type MailboxReadQuery,
  MailboxStore,
  makeMailboxRpcHandlers,
  type SearchCandidate,
  type SearchDocument,
  searchShardHealth,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { pointInTimeRestore } from "../restore.ts";
import { ownerOfMailbox } from "../topics/types.ts";
import { extraUsageBytes } from "../usage.ts";
import {
  bodyKeyFor,
  flush,
  ITIP_METHOD_HEADER,
  nameOf,
  setAlarmAt,
  type StoredBody,
} from "./common.ts";
import { acceptLiveSocket, broadcastSeq, closeLiveSockets } from "./live.ts";

/** UID of the first component in an iCalendar payload (moved to the codec; kept for callers). */
export { icsUid as itipUid } from "@bye/mail-codec";

/**
 * Mailbox metadata budget (§12). A SQLite-backed Durable Object stores up to 10 GB; the mailbox
 * authority (threads, deliveries, indexes, kernel ledgers — never message bytes, which live in R2)
 * is budgeted at that limit and probed by the Cron reconciler: alert at 50%, "rollover" at 70%.
 *
 * Policy (probe plus plan, not automatic sharding): a mailbox at "rollover" is flagged in D1
 * (`authority_storage`) and alerted for an operator. The planned remedy is metadata sharding by
 * time: freeze the current object as an archive shard (read-only, still searchable through its
 * search shards) and continue in a new `mbx_<id>#<n>` authority behind the same mailbox ID, routed
 * by the directory. That migration is operator-driven and gated on this probe; it is not automated
 * because no mailbox is expected to approach the budget before the probe has production data.
 */
export const MAILBOX_METADATA_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

const ERASED_KEY = "erased";

const ERASED_REJECTION = {
  ok: false as const,
  code: "gone" as const,
  message: "mailbox erased",
};

export class MailboxDO extends DurableObject<CoreEnv> {
  /** Per-instance identity; changes when the object restarts (used to observe a completed restore). */
  private readonly epoch = crypto.randomUUID();
  sessionEpoch() {
    return this.epoch;
  }

  /** Operator point-in-time restore (§12); the ops route replays erasure tombstones afterwards. */
  restoreTo(at: number) {
    return pointInTimeRestore(this.ctx, at);
  }

  private readonly store: MailboxStore;
  private readonly rpc: ReturnType<typeof makeMailboxRpcHandlers>;
  private readonly mailboxId: string;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.mailboxId = nameOf(ctx);
    this.store = new MailboxStore(ctx.storage, {
      mailboxId: this.mailboxId,
      clock: kernelClock,
      codec: { normalizeSubject },
      publishAddress: `world@${new URL(env.APP_ORIGIN).hostname.replace(/^app\./, "")}`,
    });
    this.rpc = makeMailboxRpcHandlers(this.store);
  }

  /** Run one store call; `settle` relays its outbox and re-arms the alarm after it commits. */
  private call<A>(f: () => A, options: { readonly settle?: boolean } = {}): A {
    const result = f();

    if (options.settle) this.ctx.waitUntil(this.afterCommit());

    return result;
  }

  private async afterCommit(): Promise<void> {
    // Small invalidation only; clients catch up through the HTTP changes API (§8 Synchronization).
    broadcastSeq(this.ctx, this.store.kernel.currentSeq());
    await flush(this.env, this.store.kernel, `mailbox:${this.mailboxId}`);
    await setAlarmAt(
      this.ctx.storage,
      this.store.nextWakeAt(Date.now()) ??
        (this.store.kernel.hasPendingOutbox() ? Date.now() + 5_000 : null),
    );
  }

  /**
   * Hibernating WebSocket for change notifications; authorization happens in the API Worker. A
   * credential tag (`x-bye-credential`, set by the API) lets revocation close exactly those sockets.
   */
  override async fetch(request: Request): Promise<Response> {
    return acceptLiveSocket(this.ctx, request, this.store.kernel.currentSeq());
  }

  override async webSocketMessage(): Promise<void> {
    // Clients never send commands over the socket; mutations use the HTTP command API.
  }

  /** Close live sockets for a revoked credential (or all, when no credential is given). */
  closeSockets(credentialId?: string): number {
    return closeLiveSockets(this.ctx, credentialId);
  }

  /** SQLite size of this authority (runtime `databaseSize`, else page_count × page_size). */
  metadataBytes(): number {
    // Forced by Cloudflare's types: `SqlStorage` doesn't declare `databaseSize` in the pinned
    // workers-types, though the runtime provides it; PRAGMAs are the fallback.
    const sql = this.ctx.storage.sql as {
      databaseSize?: number;
      exec(q: string): { toArray(): Array<Record<string, SqlStorageValue>> };
    };

    if (Predicate.isNumber(sql.databaseSize)) return sql.databaseSize;

    try {
      const pages = Number(Object.values(sql.exec("PRAGMA page_count").toArray()[0] ?? {})[0] ?? 0);
      const size = Number(Object.values(sql.exec("PRAGMA page_size").toArray()[0] ?? {})[0] ?? 0);

      return pages * size;
    } catch {
      return 0;
    }
  }

  /**
   * Refresh the D1-accounted usage (parts, bodies, exports) the quota adds (§12). Never throws: on
   * a D1 error the last known figure stays in force, so a directory hiccup can't fail uploads.
   * The owner's user-level exports are charged to exactly one mailbox — their first personal
   * mailbox — so they aren't counted against every mailbox the user owns.
   */
  async refreshExternalUsage(): Promise<number> {
    try {
      const mailbox = await extraUsageBytes(this.env, "mailbox", this.mailboxId);
      const owner = await ownerOfMailbox(this.env, this.mailboxId).catch(() => null);
      let exports = 0;

      if (owner) {
        const home = await this.env.DIRECTORY.withSession("first-primary")
          .prepare(
            "SELECT id FROM mailboxes WHERE owner_user_id = ? AND kind = 'personal' ORDER BY created_at, id LIMIT 1",
          )
          .bind(owner.user_id)
          .first<{ id: string }>();

        if (home?.id === this.mailboxId)
          exports = (await extraUsageBytes(this.env, "user", owner.user_id)).exports;
      }

      const total = mailbox.parts + mailbox.bodies + mailbox.exports + exports;
      this.store.uploads.setExternalUsage(total);

      return total;
    } catch {
      return this.store.uploads.externalUsage();
    }
  }

  /** Typed reads (§8): policies, labels, boards, contacts, attachments, send jobs… */
  read(query: MailboxReadQuery) {
    return this.call(() => guardMailboxRead(this.store, query));
  }

  execute(command: MailboxCommand) {
    return this.call(() => this.rpc.execute(command), { settle: true });
  }

  view(query: MailViewQuery) {
    return this.rpc.view(query);
  }

  thread(threadId: string) {
    return this.rpc.thread(threadId);
  }

  changes(cursor: number) {
    return this.rpc.changes(cursor);
  }

  /**
   * Erasure fence (§12): set by `eraseAll` and kept across the storage reset, so queued ingest,
   * journal quarantine or redelivery can never rebuild content in an erased authority.
   */
  private erased(): boolean {
    return this.ctx.storage.kv.get(ERASED_KEY) !== undefined;
  }

  async commitDelivery(input: MailboxDeliveryCommit) {
    // Permanent rejection: the ingest consumer records it and stops replaying the receipt.
    if (this.erased()) return ERASED_REJECTION;

    // C04: an iTIP REPLY from an unscreened sender bypasses the Screener only when the owner's
    // calendar authority confirms it organizes the event. REQUESTs are always screened.
    const organizerReply =
      this.store.ingest.needsOrganizerCheck(input.summary, input.ingestionId) &&
      (await this.ownerOrganizes(input.summary.calendarUid));

    return this.call(
      () =>
        this.rpc.commitDelivery(
          organizerReply ? { ...input, calendarOrganizerReply: true } : input,
        ),
      { settle: true },
    );
  }

  /** Whether the owner's calendar organizes the event with this UID; fails closed (the reply waits in the Screener). */
  private async ownerOrganizes(uid: string | undefined): Promise<boolean> {
    if (!uid) return false;

    try {
      const owner = await ownerOfMailbox(this.env, this.mailboxId);

      return owner?.calendar_id
        ? await this.env.CALENDARS.getByName(owner.calendar_id).isOrganizerOf(uid)
        : false;
    } catch {
      return false;
    }
  }

  /** Authorized internal redelivery (E19): bypasses the Screener only, never safety checks. */
  async receiveTransfer(input: MailboxDeliveryCommit & { readonly transferId: string }) {
    if (this.erased()) {
      // Drop the transfer and the copy already written under this (erased) mailbox's prefix.
      if (input.messageKey.startsWith(`t/${this.mailboxId}/`))
        await this.env.ORIGINALS.delete(input.messageKey).catch(() => undefined);

      return null;
    }

    return this.call(
      () =>
        this.store.ingest.commitDelivery({
          ...input,
          ingestionId: `xfer:${input.transferId}`,
          authorizedTransfer: true,
        }),
      { settle: true },
    );
  }

  // ---- send-job port (§7.3); the dispatch consumer calls these over RPC ----
  claim(sendJobId: string) {
    return this.call(() => this.store.sends.claim(sendJobId), { settle: true });
  }

  accepted(
    sendJobId: string,
    receipt: { readonly providerId: string; readonly wireMessageId?: string },
  ) {
    this.call(() => this.store.sends.accepted(sendJobId, receipt), { settle: true });
  }

  failed(
    sendJobId: string,
    failure: {
      readonly kind: "Rejected" | "RetryableBeforeAcceptance" | "Unknown";
      readonly detail: string;
    },
  ) {
    this.call(() => this.store.sends.failed(sendJobId, failure), { settle: true });
  }

  /**
   * Outbound iTIP (C04): one system send job per attendee through this mailbox's identity, so
   * invitation replies follow the same transport, limits, and audit trail as ordinary mail.
   */
  sendCalendarMessage(input: {
    readonly eventKey: string;
    readonly method: string;
    readonly ics: string;
    readonly recipients: ReadonlyArray<string>;
    readonly from: string;
    readonly subject: string;
  }) {
    // One transaction with its receipt: a failure part-way leaves no jobs and no receipt.
    return this.call(
      () =>
        this.store.ctx.cmd(`itip:${input.eventKey}`, "CalendarMessage", () =>
          input.recipients.map(
            (to) =>
              this.store.sends.createSystemJob({
                to: { name: undefined, address: to },
                subject: input.subject,
                text: input.ics,
                threadId: null,
                headers: { [ITIP_METHOD_HEADER]: input.method },
                fromAddress: input.from,
              }) ?? null,
          ),
        ),
      { settle: true },
    );
  }

  draft(draftId: string) {
    return this.store.drafts.draft(draftId) ?? null;
  }

  frozenContent(sendJobId: string) {
    return this.store.sends.frozenContent(sendJobId) ?? null;
  }

  sendJob(sendJobId: string) {
    return this.store.sends.job(sendJobId) ?? null;
  }

  setRenderedSize(sendJobId: string, bytes: number) {
    this.store.sends.setRenderedSize(sendJobId, bytes);
  }

  recordRecipientEvent(
    eventId: string,
    sendJobId: string,
    address: string,
    outcome: RecipientOutcome,
    detail?: string,
  ) {
    this.call(
      () => this.store.sends.recordRecipientEvent(eventId, sendJobId, address, outcome, detail),
      { settle: true },
    );
  }

  setScanResult(uploadId: string, status: "clean" | "infected" | "failed") {
    this.call(() => this.store.uploads.setScanResult(uploadId, status), { settle: true });
  }

  recordDeliveryScan(
    deliveryId: string,
    outcome: "clean" | "infected" | "failed",
    signature?: string,
  ) {
    this.call(() => this.store.ingest.recordDeliveryScan(deliveryId, outcome, signature), {
      settle: true,
    });
  }

  attachmentAccess(deliveryId: string) {
    return this.store.ingest.attachmentAccess(deliveryId);
  }

  scanStatusForMessageKey(messageKey: string) {
    return this.store.ingest.scanStatusForMessageKey(messageKey);
  }

  resolveFileLink(token: string) {
    return this.store.uploads.resolveFileLink(token, Date.now());
  }

  delivery(deliveryId: string) {
    return this.store.views.delivery(deliveryId) ?? null;
  }

  /**
   * Index target for the indexer (§8): the hydrated document (null → delete), the shard it lives
   * in, and the source sequence used both as document version and as acknowledgement point.
   */
  async indexTarget(
    kind: string,
    id: string,
  ): Promise<{
    readonly doc: SearchDocument | null;
    readonly shard: string | null;
    readonly seq: number;
    readonly docKey: string;
  }> {
    const docKey = `${kind}:${id}`;
    const doc = await this.indexDocument(kind, id);

    const shard = doc
      ? this.store.search.searchPlacement(doc.docId, doc.date)
      : (this.store.search.existingPlacement(docKey) ?? this.store.search.searchShards()[0]!.name);

    return { doc, shard, seq: this.store.kernel.currentSeq(), docKey };
  }

  ackIndexed(docKey: string, seq: number): void {
    this.store.search.ackIndexed(docKey, seq);
  }

  /** Shard size report from the indexer; may open a new shard (§12 alert 50%, split 70%). */
  recordShardHealth(name: string, storedBytes: number) {
    const health = searchShardHealth(storedBytes);
    const { opened } = this.store.search.recordShardHealth(name, storedBytes, health.rollover);

    if (health.alert)
      console.warn(
        JSON.stringify({
          level: "warn",
          op: "search.shard.capacity",
          ratio: Number(health.ratio.toFixed(3)),
          rollover: health.rollover,
        }),
      );

    if (opened) this.ctx.waitUntil(this.afterCommit());

    return { ...health, opened };
  }

  searchShards() {
    return this.store.search.searchShards();
  }

  indexWatermark() {
    return this.store.search.indexWatermark();
  }

  searchHits(candidates: ReadonlyArray<SearchCandidate>, query: string) {
    return this.store.search.searchHits(candidates, query);
  }

  /** Index document from authoritative state plus the normalized body text from R2; null deletes it. */
  async indexDocument(kind: string, id: string): Promise<SearchDocument | null> {
    const messageKey = this.store.search.bodySource(kind, id);
    const body = messageKey ? await this.env.PARTS.get(bodyKeyFor(messageKey)) : null;
    const text = body ? (await body.json<StoredBody>()).text : undefined;

    return this.store.search.searchDocument(kind, id, text);
  }

  /** Renderable message for the separate render origin; only for deliveries in this mailbox. */
  async renderable(
    deliveryId: string,
  ): Promise<{ readonly messageKey: string; readonly remoteImages: boolean } | null> {
    const d = this.store.views.delivery(deliveryId);

    if (!d) return null;

    // Preference values are "proxy" | "off" (E23); "off" blocks every remote image.
    return {
      messageKey: d.messageKey,
      remoteImages: this.store.automation.preferences().remoteImages !== "off",
    };
  }

  /** One page of every delivery (all dispositions) for export/reindex workflows (§12, A04). */
  exportManifestPage(cursor: string | null, limit = 500) {
    return this.store.retention.exportManifestPage(cursor, limit);
  }

  /** Everything except deliveries (contacts, notes, clips, policies): small, no mailbox-size dependence. */
  exportSettings() {
    return {
      mailboxId: this.mailboxId,
      contacts: this.store.organize.exportContacts(),
      notes: this.store.organize.notes({}),
      clips: this.store.organize.clips(),
      policies: this.store.ledger.listPolicies(),
    };
  }

  /** Zip/preview helpers need the stored attachment list and scan gate for a delivery. */
  attachmentFor(deliveryId: string, partId: string) {
    const d = this.store.views.delivery(deliveryId);
    const a = d?.attachments.find((x) => x.partId === partId);

    if (!d || !a) return null;

    return {
      messageKey: d.messageKey,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      date: d.date,
      access: this.store.ingest.attachmentAccess(deliveryId),
    };
  }

  identities() {
    return this.store.identities.identities();
  }

  // ---- uploads (E20): reservation is a command; parts are streamed by the Worker to R2 multipart ----
  setUploadR2Id(uploadId: string, r2UploadId: string) {
    this.store.uploads.setR2UploadId(uploadId, r2UploadId);
  }

  recordUploadPart(uploadId: string, partNumber: number, size: number, etag: string) {
    this.store.uploads.recordUploadPart(uploadId, partNumber, size, etag);

    return this.store.uploads.upload(uploadId);
  }

  uploadParts(uploadId: string) {
    return this.store.uploads.uploadParts(uploadId);
  }

  /** Erasure (§12): the authority's SQLite storage is removed after blobs and indexes. */
  async eraseAll(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Written after the reset so it survives it: the fresh authority stays fenced.
    this.ctx.storage.kv.put(ERASED_KEY, Date.now());
    // Reset the live object: its in-memory store references dropped tables. The next request
    // constructs a fresh, migrated, empty authority.
    const abort = (this.ctx as { abort?: (reason?: string) => void }).abort;

    if (Predicate.isFunction(abort)) setTimeout(() => abort.call(this.ctx, "erased"), 0);
  }

  /** Cron reconciliation (§6): restore wake-ups, fence stale submissions, apply retention. */
  async reconcile(now: number): Promise<{
    readonly nextWake: number | null;
    readonly unknown: number;
    readonly purged: number;
    readonly metadataBytes: number;
  }> {
    const unknown = this.store.sends.reconcileStaleSubmissions(now, 10 * 60_000).length;
    // Lost dispatch messages for `ready` jobs and unacknowledged index events are replayed from
    // source state (§6 row 8); change history is compacted (expired cursors refresh a snapshot).
    this.store.sends.replayStaleDispatches(now, 15 * 60_000);
    this.store.search.replayPendingIndex();
    this.store.kernel.compactChanges(10_000);

    // Re-emit scans whose queue message was lost or dead-lettered (§6 replay from source state).
    for (const p of this.store.ingest.pendingScans(now - 15 * 60_000, 50)) {
      this.store.kernel.outbox("propagate", this.mailboxId, {
        topic: "scan-message",
        deliveryId: p.deliveryId,
        messageKey: p.messageKey,
      });
    }

    // Bounded: one batch here; a scheduled `retention-sweep` job drains any backlog via the alarm.
    const purged = this.store.retention.sweepRetention(now).deleted;
    await this.refreshExternalUsage().catch(() => 0);
    await this.afterCommit();

    return {
      nextWake: this.store.nextWakeAt(now),
      unknown,
      purged,
      metadataBytes: this.metadataBytes(),
    };
  }

  override async alarm(): Promise<void> {
    // Jobs are isolated inside runDueJobs (a throwing job is retried, then parked as failed); the
    // finally re-arms the alarm and flushes the outbox even if something else here throws.
    try {
      const { failed } = this.store.runDueJobs(Date.now());

      for (const f of failed)
        console.error(
          JSON.stringify({
            level: "error",
            op: "mailbox.job.failed",
            mailboxId: this.mailboxId,
            kind: f.kind,
            key: f.key,
            outcome: f.outcome,
            error: f.error.slice(0, 200),
          }),
        );
    } finally {
      await this.afterCommit();
    }
  }
}
