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
  type JmapCallInput,
  type JmapCallOutput,
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
import { JmapHost, type MigrationAction, type MigrationInput } from "./jmap-host.ts";
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

/** C3: legacy writers are fenced while the account migrates. */
const MIGRATING = {
  ok: false as const,
  code: "conflict" as const,
  message: "account migration in progress; retry later",
  details: { retryable: true },
};

/** C4: a client of the thread model can't represent JMAP state; it must upgrade. */
const UPGRADE_REQUIRED = {
  ok: false as const,
  code: "conflict" as const,
  message: "this account uses JMAP; upgrade the client",
  details: { upgradeRequired: true, session: "/.well-known/jmap" },
};

/** Legacy commands that don't write the mail model and stay available after activation (C4). */
const JMAP_LEGACY_COMMANDS: ReadonlySet<string> = new Set([
  "SetPolicy",
  "RevertPolicy",
  "RotateSpeakeasy",
  "DisableSpeakeasy",
  "PutRule",
  "DeleteRule",
  "PutContact",
  "DeleteContact",
  "ImportContacts",
  "SetPreference",
  "SetNotifyOptIn",
  "SetNotificationSettings",
  "SetAway",
  "AddForwardingDestination",
  "VerifyForwardingDestination",
  "PutForwardingRule",
  "DeleteForwardingRule",
  "AddIdentity",
  "SetDefaultIdentity",
  "VerifyIdentity",
  "ResendIdentityChallenge",
  "ClearRecentSearches",
  "CancelSend",
  "ResolveUnknownSend",
  "ReserveUpload",
  "CompleteUpload",
  "AbortUpload",
  "CreateFileLink",
  "RevokeFileLink",
]);

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

  /** C2: reconcile restored send jobs with the attempt/acceptance evidence kept in D1. */
  reconcileRestoredSends(
    evidence: ReadonlyArray<{
      readonly sendJobId: string;
      readonly attempted: boolean;
      readonly providerId: string | null;
    }>,
  ) {
    return this.call(
      () => this.store.ctx.sql.tx(() => this.store.sends.reconcileRestored(evidence)),
      {
        settle: true,
      },
    );
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
    this.jmapHost = new JmapHost(
      env,
      this.store,
      this.mailboxId,
      () => this.ctx.waitUntil(this.afterCommit()),
      (p) => this.ctx.waitUntil(p),
      (input) => this.withOrganizerCheck(input),
    );
  }

  private readonly jmapHost: JmapHost;

  /** Run one store call; `settle` relays its outbox and re-arms the alarm after it commits. */
  private call<A>(f: () => A, options: { readonly settle?: boolean } = {}): A {
    const result = f();

    if (options.settle) this.ctx.waitUntil(this.afterCommit());

    return result;
  }

  private async afterCommit(): Promise<void> {
    // Small invalidation only; clients catch up through the HTTP changes API (§8 Synchronization).
    broadcastSeq(this.ctx, this.store.kernel.currentSeq());
    this.jmapHost.notify();
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
    if (new URL(request.url).pathname === "/jmap-events") return this.jmapHost.openStream(request);

    return acceptLiveSocket(this.ctx, request, this.store.kernel.currentSeq());
  }

  override async webSocketMessage(): Promise<void> {
    // Clients never send commands over the socket; mutations use the HTTP command API.
  }

  /** Close live sockets for a revoked credential (or all, when no credential is given). */
  closeSockets(credentialId?: string): number {
    const streams = this.jmapHost.closeStreams(credentialId === undefined ? {} : { credentialId });

    return closeLiveSockets(this.ctx, credentialId) + streams;
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

  /**
   * Legacy commands (C3/C4): refused with a retry response while the account is fenced; once the
   * JMAP core is the mail authority, commands that write the thread model are refused with an
   * explicit upgrade-required response instead of silently diverging. Settings-level commands
   * (policies, contacts, identities, away replies, uploads…) keep working.
   */
  execute(command: MailboxCommand) {
    if (this.fenced()) return MIGRATING;

    if (this.store.jmap.active() && !JMAP_LEGACY_COMMANDS.has(command._tag))
      return UPGRADE_REQUIRED;

    return this.call(
      () => {
        const before = new Set(this.store.identities.identities().map((i) => i.identityId));
        const result = this.rpc.execute(command);

        if (this.store.jmap.active()) this.jmapAfterLegacyCommand(command._tag, before);

        return result;
      },
      { settle: true },
    );
  }

  /**
   * Identity and away-reply commands are visible to JMAP clients as Identity/VacationResponse
   * changes, under the real object IDs (a JMAP Identity ID is the identity's ID).
   */
  private jmapAfterLegacyCommand(tag: string, identitiesBefore: ReadonlySet<string>): void {
    const core = this.store.jmap.core;

    if (tag === "SetAway") {
      core.history.tx(() => core.history.record("VacationResponse", "singleton", "updated"));

      return;
    }

    if (!["AddIdentity", "SetDefaultIdentity", "VerifyIdentity"].includes(tag)) return;

    // Any of these may change another identity's default/verified state: report every one.
    core.history.tx(() => {
      for (const i of this.store.identities.identities())
        core.history.record(
          "Identity",
          i.identityId,
          identitiesBefore.has(i.identityId) ? "updated" : "created",
        );
    });
  }

  view(query: MailViewQuery) {
    return this.store.jmap.active() ? UPGRADE_REQUIRED : this.rpc.view(query);
  }

  thread(threadId: string) {
    return this.store.jmap.active() ? UPGRADE_REQUIRED : this.rpc.thread(threadId);
  }

  changes(cursor: number) {
    return this.store.jmap.active() ? UPGRADE_REQUIRED : this.rpc.changes(cursor);
  }

  // ---- JMAP (spec.md §16); the API Worker authenticates and passes the principal ----

  /** This account as the principal discovers it, or null when it has no effective grant (A3). */
  jmapAccount(principalId: string, restoreGeneration: number) {
    if (this.erased()) return null;

    return this.jmapHost.accountFor(principalId, restoreGeneration);
  }

  /** One account-scoped method call, run next to the storage in one consistent pass (C1). */
  jmapCall(input: JmapCallInput): JmapCallOutput {
    return this.jmapHost.call(input);
  }

  /** Where a blob's bytes live, and whether the quarantine/scan gate allows them (A3). */
  jmapBlob(principalId: string, blobId: string) {
    return this.jmapHost.blob(principalId, blobId);
  }

  jmapEmailBlob(principalId: string, emailId: string) {
    return this.jmapHost.emailBlob(principalId, emailId);
  }

  jmapRegisterUpload(
    principalId: string,
    blob: {
      readonly blobId: string;
      /** Where the bytes live: uploads go to parts, copied messages to originals. */
      readonly bucket?: "originals" | "parts";
      readonly r2Key: string;
      readonly size: number;
      readonly type: string;
    },
    owner?: string,
  ) {
    this.jmapHost.registerUpload(principalId, blob, owner);
  }

  /** Operator migration control (C3). */
  jmapMigrate(action: MigrationAction, input: MigrationInput) {
    return this.jmapHost.migrate(action, input);
  }

  /** Converge effective grants with one directory read taken at `readAt` (A3). */
  jmapSyncGrants(
    entries: ReadonlyArray<{ readonly principalId: string; readonly canSend: boolean }>,
    readAt: number,
  ) {
    return this.jmapHost.syncGrants(entries, readAt);
  }

  /** Parked arrivals and operator replay (B4). */
  jmapParked() {
    return this.store.jmap.ingest.parked();
  }

  async jmapReplayArrival(arrivalId: string) {
    if (!this.store.jmap.ingest.replay(arrivalId)) return null;

    return this.jmapHost.process(arrivalId);
  }

  /** C3: the account is fenced for migration (writers refuse or buffer). */
  private fenced(): boolean {
    return this.store.jmap.migration.fenced();
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

    // C3: a fenced account buffers the arrival durably with a stable event ID (acknowledged).
    if (this.fenced()) {
      this.jmapHost.buffer("arrival", `arrival:${this.jmapHost.arrivalId(input)}`, input);

      return {
        ok: true as const,
        value: { deliveryId: "", threadId: "", disposition: "buffered", replayed: false },
      };
    }

    // B4: on the JMAP core, staged then prepared and published; acknowledged once staged.
    if (this.store.jmap.active()) {
      const out = await this.jmapHost.deliver(input);

      return {
        ok: true as const,
        value: {
          deliveryId: out.emailId ?? "",
          threadId: "",
          disposition: out.state,
          replayed: false,
        },
      };
    }

    const checked = await this.withOrganizerCheck(input);

    return this.call(() => this.rpc.commitDelivery(checked), { settle: true });
  }

  /**
   * C04: an iTIP REPLY from an unscreened sender bypasses the Screener only when the owner's
   * calendar authority confirms it organizes the event. REQUESTs are always screened.
   */
  private async withOrganizerCheck<I extends MailboxDeliveryCommit>(input: I): Promise<I> {
    const organizerReply =
      this.store.ingest.needsOrganizerCheck(input.summary, input.ingestionId) &&
      (await this.ownerOrganizes(input.summary.calendarUid));

    return organizerReply ? { ...input, calendarOrganizerReply: true } : input;
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

    const transfer = {
      ...input,
      ingestionId: `xfer:${input.transferId}`,
      authorizedTransfer: true,
    };

    if (this.fenced()) {
      this.jmapHost.buffer("transfer", `transfer:${input.transferId}`, transfer);

      return null;
    }

    if (this.store.jmap.active()) return this.jmapHost.deliver(transfer);

    return this.call(() => this.store.ingest.commitDelivery(transfer), { settle: true });
  }

  // ---- send-job port (§7.3); the dispatch consumer calls these over RPC ----
  claim(sendJobId: string) {
    // C3: no new external dispatch claims while fenced; the job stays ready and is re-emitted.
    if (this.fenced()) return null;

    return this.call(() => this.store.sends.claim(sendJobId), { settle: true });
  }

  accepted(
    sendJobId: string,
    receipt: { readonly providerId: string; readonly wireMessageId?: string },
  ) {
    this.call(() => this.store.sends.accepted(sendJobId, receipt), { settle: true });

    // A legacy send accepted after the cutover was staged for Sent: publish it now (C3).
    if (this.store.jmap.active()) this.ctx.waitUntil(this.jmapHost.publishOutgoing(sendJobId));
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
    if (this.fenced()) {
      this.jmapHost.buffer("scan", `scan:${deliveryId}:${outcome}`, {
        deliveryId,
        outcome,
        signature,
      });

      return;
    }

    if (this.store.jmap.active()) {
      this.jmapHost.recordScan(deliveryId, outcome);

      return;
    }

    this.call(() => this.store.ingest.recordDeliveryScan(deliveryId, outcome, signature), {
      settle: true,
    });
  }

  attachmentAccess(deliveryId: string) {
    return this.store.ingest.attachmentAccess(deliveryId);
  }

  /**
   * Scan state behind an original (forwarding gate, §10): the core's Emails once migrated. A
   * forward is only made for a published Email, so when none (nor its legacy delivery) names the
   * key any more it was destroyed before its verdict: no verdict means no forward (`failed`).
   */
  scanStatusForMessageKey(messageKey: string): string | null {
    if (!this.store.jmap.active()) return this.store.ingest.scanStatusForMessageKey(messageKey);

    return (
      this.store.jmap.core.scanStatusForKey(messageKey) ??
      this.store.ingest.scanStatusForMessageKey(messageKey) ??
      "failed"
    );
  }

  /** A JMAP Email as the delivery-topic consumers need it, or null (spec.md §16 B4). */
  jmapEmailSummary(emailId: string) {
    return this.store.jmap.core.emailSummary(emailId) ?? null;
  }

  /** A JMAP thread's subject and the requested Emails, in the shared-propagation shape. */
  jmapSharedMessages(threadId: string, refs: ReadonlyArray<string>) {
    const core = this.store.jmap.core;

    const all = core.threadEmailIds(threadId).flatMap((id) => {
      const s = core.emailSummary(id);

      return s ? [s] : [];
    });

    if (all.length === 0) return null;
    const wanted = new Set(refs);

    return {
      subject: all[0]!.subject,
      messages: all
        .filter((s) => wanted.has(s.emailId))
        .map((s) => ({
          messageRef: s.emailId,
          from: s.from,
          to: s.to,
          cc: s.cc,
          subject: s.subject,
          snippet: s.preview,
          contentKey: s.contentKey,
          sentAt: s.sentAt,
        })),
    };
  }

  /**
   * A delivery or a JMAP blob still points at this object: blob GC must keep it. Once the JMAP
   * core is the authority, the frozen legacy rows no longer hold bytes (§16 C3): a destroyed
   * Email's original goes even though the delivery it was backfilled from remains.
   */
  messageKeyReferenced(messageKey: string): boolean {
    if (this.store.jmap.core.referencesKey(messageKey)) return true;

    return (
      !this.store.jmap.active() && this.store.ingest.scanStatusForMessageKey(messageKey) !== null
    );
  }

  /** Blob GC claims a JMAP key it found unreferenced before deleting it (§12); see `claimGc`. */
  jmapClaimGc(r2Key: string): boolean {
    return this.store.jmap.core.claimGc(r2Key);
  }

  jmapReleaseGc(r2Key: string): void {
    this.store.jmap.core.releaseGc(r2Key);
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
    // A migrated account's mail is the core's Emails; the legacy rows are a frozen snapshot.
    return this.store.jmap.active()
      ? this.store.jmap.core.exportManifestPage(cursor, limit)
      : this.store.retention.exportManifestPage(cursor, limit);
  }

  /** One page of legacy deliveries for the legacy search reindex (§8). */
  searchManifestPage(cursor: string | null, limit = 500) {
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

    // Once fenced or migrated the legacy tables are frozen: their scans, retention and blob
    // collection belong to the JMAP core, whose Emails point at the same originals (§16 C3).
    const legacy = !this.fenced() && !this.store.jmap.active();

    // Re-emit scans whose queue message was lost or dead-lettered (§6 replay from source state).
    const pending = legacy
      ? this.store.ingest.pendingScans(now - 15 * 60_000, 50)
      : this.jmapHost.pendingScans(now - 15 * 60_000, 50);

    for (const p of pending) {
      this.store.kernel.outbox("propagate", this.mailboxId, {
        topic: "scan-message",
        deliveryId: p.deliveryId,
        messageKey: p.messageKey,
      });
    }

    // Bounded: one batch here; a scheduled sweep job drains any backlog via the alarm. Retention
    // waits out a migration fence, then runs on whichever authority holds the mail.
    const purged = legacy
      ? this.store.retention.sweepRetention(now).deleted
      : this.store.jmap.active()
        ? this.store.ctx.sql.tx(() => this.store.jmapRetention(now)).deleted
        : 0;

    // The alarm runs only for due jobs: the cron is what guarantees JMAP housekeeping (blob and
    // pin release) and history compaction also happen on an otherwise quiet account.
    if (this.store.jmap.active()) {
      this.jmapHost.housekeeping(now);
      this.store.jmap.core.history.compact(now);
    }

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

      if (this.store.jmap.active()) {
        await this.jmapHost.retryArrivals();
        this.jmapHost.housekeeping();
        // C1 retention: compaction raises each type's floor; it never silently shortens history.
        this.store.jmap.core.history.compact(Date.now());
      }

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
