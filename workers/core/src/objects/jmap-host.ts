import { blobKey, type MailboxDeliveryCommit } from "@bye/application";
import type { ChangeType, MailboxRights } from "@bye/jmap";
import { CHANGE_TYPES, encodeState } from "@bye/jmap";
import { buildMessage, prepareEmail } from "@bye/mail-codec";
import {
  type ArrivalInput,
  arrivalIdOf,
  BLOB_UPLOAD_TTL_MS,
  type JmapCallInput,
  type JmapCallOutput,
  type MailboxDraftContent,
  type MailboxStore,
  FULL_RIGHTS,
  parsePartBlobId,
  PRINCIPAL_SCOPED,
  type PreparedContent,
} from "@bye/platform-cloudflare";
import { Option, Predicate } from "effect";
import type { CoreEnv } from "../env.ts";
import { type GrantSyncOutcome, restoreGenerations } from "../generations.ts";
import { pushStateChange } from "../jmap-push.ts";

// The JMAP side of one MailboxDO (spec.md §16.2, §16.5, B4, C3): runs account-scoped method
// calls next to the storage, serves blob lookups, stages and publishes arrivals on the core,
// drives the per-account migration, and streams StateChange events. Every network step
// (R2 reads/writes) happens between synchronous store transactions, never inside one (§4).

/** Methods that never write; everything else settles the outbox and notifies after commit. */
const READ_METHODS = /\/(get|query|changes|queryChanges)$/;

/** Submission content pins outlive their job by the metadata recovery window (B2, C2). */
export const RECOVERY_WINDOW_MS = 30 * 24 * 3600 * 1000;

interface EventStream {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly principalId: string;
  readonly credentialId: string | null;
  readonly types: ReadonlySet<string> | null;
  readonly restoreGeneration: number;
  readonly last: Map<string, string>;
}

const encoder = new TextEncoder();

export interface MigrationInput {
  readonly grants: ReadonlyArray<{ readonly principalId: string; readonly rights?: MailboxRights }>;
  readonly ownerPrincipalId: string;
  /** The account's primary address: the From of converted drafts without an identity. */
  readonly address?: string;
  readonly inputChecksum?: string;
}

/** What a fenced account buffers (C3): an arrival/transfer, or a scan verdict. */
export type BufferedPayload =
  | MailboxDeliveryCommit
  | (MailboxDeliveryCommit & { readonly authorizedTransfer: boolean })
  | {
      readonly deliveryId: string;
      readonly outcome: "clean" | "infected" | "failed";
      readonly signature: string | undefined;
    };

export type MigrationAction = "start" | "step" | "activate" | "abort" | "status";

export class JmapHost {
  private readonly streams = new Set<EventStream>();

  /** Revisions last pushed per `principal type` (in memory; a restart re-pushes once). */
  private readonly pushed = new Map<string, string>();

  constructor(
    private readonly env: CoreEnv,
    private readonly store: MailboxStore,
    private readonly mailboxId: string,
    private readonly settle: () => void,
    private readonly waitUntil: (p: Promise<unknown>) => void = () => undefined,
    /** Network checks an arrival needs before routing (the iTIP organizer lookup, C04). */
    private readonly checkArrival: <I extends MailboxDeliveryCommit>(input: I) => Promise<I> = (
      input,
    ) => Promise.resolve(input),
  ) {}

  private get account() {
    return this.store.jmap;
  }

  // ---------------------------------------------------------------- calls

  accountFor(principalId: string, restoreGeneration: number) {
    return this.account.account(principalId, this.mailboxId, restoreGeneration);
  }

  call(input: JmapCallInput): JmapCallOutput {
    const out = this.account.call(input);

    if (!READ_METHODS.test(input.name)) this.settle();

    return out;
  }

  // ---------------------------------------------------------------- blobs

  /**
   * Where a blob's bytes live and whether this principal may read them (A3 quarantine gate).
   * Part blobs resolve to their message and part ID; the host extracts the part on download.
   */
  blob(principalId: string, blobId: string) {
    if (!this.account.active()) {
      const raw = this.store.jmapProjection.rawBlob(blobId);

      return raw
        ? {
            bucket: "originals" as const,
            r2Key: raw.messageKey,
            size: raw.size,
            type: "message/rfc822",
            partId: null,
            allowed: raw.allowed,
            status: raw.status,
          }
        : null;
    }

    const viewer = { principalId };
    const access = this.account.core.blobAccess(viewer, blobId);

    if (!access.visible) return null;
    const part = parsePartBlobId(blobId);
    const base = this.account.core.blob(Option.isSome(part) ? part.value.blobId : blobId);

    if (!base) return null;

    return {
      bucket: base.bucket,
      r2Key: base.r2Key,
      size: base.size,
      type: base.type,
      partId: Option.isSome(part) ? part.value.partId : null,
      allowed: access.allowed,
      status: access.status,
    };
  }

  /** The message blob behind one visible Email (submission preparation, body values). */
  emailBlob(principalId: string, emailId: string) {
    if (!this.account.active()) {
      const raw = this.store.jmapProjection.rawBlob(`raw-${emailId}`);

      return raw
        ? {
            blobId: `raw-${emailId}`,
            bucket: "originals" as const,
            r2Key: raw.messageKey,
            allowed: raw.allowed,
          }
        : null;
    }

    const row = this.account.core.emailGet({ principalId }, [emailId], ["blobId"]).list[0];
    const blobId = row?.["blobId"];

    if (!Predicate.isString(blobId)) return null;
    const blob = this.account.core.blob(blobId);
    const access = this.account.core.blobAccess({ principalId }, blobId);

    return blob
      ? { blobId, bucket: blob.bucket, r2Key: blob.r2Key, allowed: access.allowed }
      : null;
  }

  /** Register an uploaded (or copied) blob for its uploader, expiring unless referenced. */
  registerUpload(
    principalId: string,
    blob: {
      readonly blobId: string;
      /** Where the bytes live: uploads go to parts, copied messages to originals. */
      readonly bucket?: "originals" | "parts";
      readonly r2Key: string;
      readonly size: number;
      readonly type: string;
    },
    owner = `upload:${principalId}`,
  ): void {
    this.store.ctx.sql.tx(() => {
      this.account.core.registerBlob({
        blobId: blob.blobId,
        bucket: blob.bucket ?? "parts",
        r2Key: blob.r2Key,
        size: blob.size,
        type: blob.type,
        expiresAt: Date.now() + BLOB_UPLOAD_TTL_MS,
      });
      this.account.core.pin(blob.blobId, owner);

      if (owner !== `upload:${principalId}`)
        this.account.core.pin(blob.blobId, `upload:${principalId}`);
    });
  }

  // ---------------------------------------------------------------- arrivals (B4)

  private async prepareFrom(
    bucket: "originals" | "parts",
    r2Key: string,
    blobId: string,
  ): Promise<PreparedContent | null> {
    const object = await (bucket === "originals" ? this.env.ORIGINALS : this.env.PARTS).get(r2Key);

    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());

    return { blobId, bucket, r2Key, type: "message/rfc822", email: prepareEmail(bytes) };
  }

  /**
   * Accept an arrival on the core: stage it (acknowledgeable once staged), then prepare and
   * publish. A failure leaves it staged for bounded retry, never a visible Email without bytes.
   */
  async deliver(
    original: MailboxDeliveryCommit & { readonly authorizedTransfer?: boolean },
  ): Promise<{ readonly emailId: string | null; readonly state: string }> {
    // A redelivery or replay of a staged arrival keeps its staged input: the calendar lookup
    // runs only for a new one.
    const input = this.account.ingest.arrival(arrivalIdOf(original))
      ? original
      : await this.checkArrival(original);

    const arrival: ArrivalInput = {
      ingestionId: input.ingestionId,
      recipient: input.recipient,
      messageKey: input.messageKey,
      rawSize: input.rawSize,
      summary: input.summary,
      safety: input.safety,
      receivedAt: input.receivedAt,
      ...(input.authorizedTransfer ? { authorizedTransfer: true } : undefined),
      ...(input.forwardHops === undefined ? undefined : { forwardHops: input.forwardHops }),
      ...(input.calendarOrganizerReply ? { calendarOrganizerReply: true } : undefined),
    };

    const staged = this.account.ingest.stage(arrival);

    if (staged.state === "published" || staged.state === "parked")
      return { emailId: staged.emailId, state: staged.state };

    return this.process(staged.arrivalId);
  }

  /** Prepare and publish one staged arrival (also the retry/replay path). */
  async process(
    arrivalId: string,
  ): Promise<{ readonly emailId: string | null; readonly state: string }> {
    const ingest = this.account.ingest;
    const staged = ingest.arrival(arrivalId);

    if (!staged || staged.state === "published" || staged.state === "parked")
      return { emailId: null, state: staged?.state ?? "missing" };

    if (!ingest.preparing(arrivalId)) return { emailId: null, state: staged.state };
    let content: PreparedContent | null;

    try {
      content = await this.prepareFrom(
        "originals",
        staged.input.messageKey,
        `raw-${arrivalId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      );
    } catch (e) {
      return {
        emailId: null,
        state: ingest.failed(arrivalId, e instanceof Error ? e.message : "prepare failed"),
      };
    }

    if (!content) return { emailId: null, state: ingest.failed(arrivalId, "original not found") };
    const out = ingest.publish(arrivalId, content);

    const emailId = out.emailId;

    if (emailId !== null && staged.input.summary.attachments.length > 0)
      this.store.ctx.sql.tx(() =>
        this.store.kernel.emit("scan-message", this.mailboxId, {
          deliveryId: emailId,
          messageKey: staged.input.messageKey,
        }),
      );
    this.settle();

    return out;
  }

  /**
   * Alarm housekeeping: release terminal submission pins after the recovery window (B2), then
   * hand expired, unreferenced blobs (uploads, copies, destroyed Emails, released submissions)
   * to the delayed blob GC (§12). Nothing is deleted here: the GC sweep deletes only after its
   * delay and a fresh reference check, so bytes re-registered meanwhile (the same content
   * uploaded again) or held by a shared space or export are kept.
   */
  housekeeping(now = Date.now()): void {
    if (!this.account.active()) return;
    const core = this.account.core;

    this.store.ctx.sql.tx(() => {
      this.account.objects.releaseTerminalPins(now - RECOVERY_WINDOW_MS);

      for (const blob of core.expiredBlobs(now)) {
        // Content-addressed bytes another blob row still names stay (only rows were dropped).
        if (!core.referencesKey(blob.r2Key))
          this.store.kernel.emit("blob-gc", this.mailboxId, {
            key: blob.r2Key,
            reason: "jmap-unreferenced",
          });
      }
    });
  }

  /**
   * Publish the Sent copy of a legacy send accepted after the cutover (C3), prepared like an
   * arrival. The job's acceptance staged it; one buffered while fenced is staged here first,
   * dated when it was accepted. Jobs with nothing staged (submissions, system mail) cost one
   * key lookup.
   */
  async publishOutgoing(
    sendJobId: string,
    buffered?: { readonly acceptedAt: number },
  ): Promise<{ readonly emailId: string | null; readonly state: string } | null> {
    if (!this.account.active()) return null;

    const arrivalId = buffered
      ? this.store.ctx.sql.tx(() => this.store.stageOutgoing(sendJobId, buffered.acceptedAt))
      : this.account.ingest.outgoingArrivalId(sendJobId);

    return arrivalId === undefined ? null : this.process(arrivalId);
  }

  /** Retry staged arrivals left by an earlier failure (alarm path). */
  async retryArrivals(limit = 20, now = Date.now()): Promise<number> {
    let done = 0;

    for (const id of this.account.ingest.due(now, limit)) {
      const r = await this.process(id);

      if (r.state === "published") done++;
    }

    return done;
  }

  /** Core Emails whose scan verdict never arrived (cron replays their scan-message). */
  pendingScans(olderThan: number, limit: number) {
    return this.account.active() ? this.account.ingest.pendingScans(olderThan, limit) : [];
  }

  /** Whole-message scan verdict for a core Email (the scan consumer calls with the Email ID). */
  recordScan(emailId: string, outcome: "clean" | "infected" | "failed"): void {
    this.account.ingest.recordScan(emailId, outcome);
    this.settle();
  }

  // ---------------------------------------------------------------- migration (C3)

  /** Render a legacy draft's frozen content to immutable bytes (C3 draft conversion). */
  private async renderDraft(
    draftId: string,
    raw: string,
    fallbackAddress: string | undefined,
  ): Promise<PreparedContent | null> {
    let content: MailboxDraftContent;

    try {
      content = JSON.parse(raw) as MailboxDraftContent;
    } catch {
      return null;
    }

    const identity =
      (content.identityId ? this.store.identities.identity(content.identityId) : undefined) ??
      this.store.identities.defaultIdentity() ??
      (fallbackAddress ? { name: null, address: fallbackAddress } : undefined);

    if (!identity) return null;
    const attachments: Array<{ filename: string; contentType: string; content: Uint8Array }> = [];

    for (const uploadId of content.attachments) {
      const object = await this.env.PARTS.get(blobKey.upload(this.mailboxId, uploadId));

      if (!object) return null;
      attachments.push({
        filename: object.customMetadata?.["filename"] ?? uploadId,
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
        content: new Uint8Array(await object.arrayBuffer()),
      });
    }

    const built = buildMessage({
      from: { name: identity.name ?? undefined, address: identity.address },
      to: content.to,
      cc: content.cc,
      subject: content.subject,
      text: content.text,
      ...(content.html ? { html: content.html } : undefined),
      attachments,
      date: Date.now(),
      messageId: `${draftId}@${identity.address.split("@")[1] ?? "localhost"}`,
      ...(content.inReplyTo ? { inReplyTo: content.inReplyTo } : undefined),
      ...(content.references ? { references: content.references } : undefined),
      bcc: content.bcc,
      draftBcc: true,
    });

    const r2Key = `t/${this.mailboxId}/jmap/draft/${draftId}.eml`;
    await this.env.ORIGINALS.put(r2Key, built.bytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    return {
      blobId: `draft-${draftId}`,
      bucket: "originals",
      r2Key,
      type: "message/rfc822",
      email: prepareEmail(built.bytes),
    };
  }

  /** One bounded migration step; `start` runs fence → backfill → verify, never activation. */
  async migrate(action: MigrationAction, input: MigrationInput) {
    const m = this.account.migration;

    switch (action) {
      case "status":
        return m.status();
      case "abort": {
        // Released keys go to the delayed blob GC, which keeps any a legacy delivery still holds.
        const status = m.abort("operator abort", (key) =>
          this.store.kernel.emit("blob-gc", this.mailboxId, { key, reason: "jmap-aborted" }),
        );

        await this.replayBuffered("legacy");
        this.settle();

        return status;
      }

      case "activate": {
        const status = m.activate();

        if (status.mode === "jmap") await this.replayBuffered("jmap");
        this.settle();

        return this.account.migration.status();
      }

      case "start":
      case "step": {
        let status = m.status();
        let finished = false;

        if (status.mode === "legacy" || status.mode === "failed")
          status = m.fence({ inputChecksum: input.inputChecksum ?? "", grants: input.grants });

        if (status.mode === "fencing") {
          const submitting = this.store.sends.jobs("submitting", 1000).length;
          status = m.beginBackfill(submitting);
        }

        // `step` runs one checkpoint (crash/resume tests); `start` runs to verification.
        for (
          let i = 0;
          i < (action === "step" ? 1 : 1_000_000) && status.mode === "backfilling";
          i++
        ) {
          if (status.stage === "deliveries") {
            const batch = m.nextDeliveries();
            const prepared: Array<{ deliveryId: string; content: PreparedContent | null }> = [];

            for (const item of batch)
              prepared.push({
                deliveryId: item.deliveryId,
                content: await this.prepareFrom(
                  "originals",
                  item.messageKey,
                  `raw-${item.deliveryId}`,
                ),
              });
            status = m.applyDeliveries(prepared);
          } else if (status.stage === "drafts") {
            const drafts = m.nextDrafts();

            for (const d of drafts)
              m.applyDraft(
                d.draftId,
                await this.renderDraft(d.draftId, d.content, input.address),
                input.ownerPrincipalId,
              );

            finished = drafts.length === 0;
            status = finished ? m.finishBackfill() : m.status();
          }
        }

        this.settle();

        // `finishBackfill` verifies; a run resumed in `verifying` (e.g. after a repair) checks here.
        return status.mode === "verifying" && !finished ? m.verify() : status;
      }
    }
  }

  /** Replay buffered arrivals and scans through the services of the resulting mode (C3). */
  private async replayBuffered(target: "jmap" | "legacy"): Promise<void> {
    const m = this.account.migration;

    for (let batch = m.buffered(50); batch.length > 0; batch = m.buffered(50)) {
      for (const event of batch) {
        const payload = JSON.parse(event.payload) as MailboxDeliveryCommit & {
          authorizedTransfer?: boolean;
          deliveryId?: string;
          outcome?: "clean" | "infected" | "failed";
          signature?: string;
        };

        if (event.kind === "scan") {
          // A verdict buffered while fenced applies to whichever authority now holds the mail.
          if (payload.deliveryId && target === "legacy")
            this.store.ingest.recordDeliveryScan(
              payload.deliveryId,
              payload.outcome ?? "failed",
              payload.signature,
            );
          else if (payload.deliveryId)
            this.account.ingest.recordScan(payload.deliveryId, payload.outcome ?? "failed");
        } else if (event.kind === "outgoing") {
          // A legacy send accepted while fenced: Sent on whichever authority now holds the mail.
          const outgoing = payload as { readonly sendJobId?: string; readonly acceptedAt?: number };
          const sendJobId = outgoing.sendJobId ?? "";

          if (target === "jmap")
            await this.publishOutgoing(sendJobId, {
              acceptedAt: outgoing.acceptedAt ?? Date.now(),
            });
          else this.store.ctx.sql.tx(() => this.store.sends.recordFrozenOutgoing(sendJobId));
        } else if (target === "jmap") await this.deliver(payload);
        else this.store.ingest.commitDelivery(await this.checkArrival(payload));
        m.markApplied(event.seq);
      }
    }
  }

  buffer(
    kind: "arrival" | "transfer" | "scan" | "outgoing",
    eventId: string,
    payload: BufferedPayload,
  ): void {
    this.account.migration.buffer(kind, eventId, JSON.stringify(payload));
  }

  arrivalId(input: Pick<MailboxDeliveryCommit, "ingestionId" | "recipient">): string {
    return arrivalIdOf(input);
  }

  // ---------------------------------------------------------------- grants (A3)

  /**
   * Converge effective grants with one directory read (A3): every listed principal holds the
   * account-wide grant (submit only with `canSend`); everyone else is revoked. `readAt` orders
   * reads: one older than a read already taken is `stale` and changes nothing. Before migration
   * nothing is kept (`legacy`: the fence reads the directory itself); while fenced, before the
   * migration applies its grants, the read replaces the fence's grant input (`recorded`), so
   * activation applies the current directory, never the one captured at the fence. Revocation
   * takes effect on commit: later calls fail authorization and the principal's streams close.
   */
  syncGrants(
    entries: ReadonlyArray<{ readonly principalId: string; readonly canSend: boolean }>,
    readAt: number,
  ): { readonly outcome: GrantSyncOutcome; readonly aclGeneration: number | null } {
    const core = this.account.core;
    const revoked: Array<string> = [];
    let changed = false;

    // Grants apply inside the transaction; streams and pushes follow only once it committed.
    const out = core.sql.tx(() => {
      if (readAt < core.meta<number>("grantsReadAt", 0))
        return { outcome: "stale" as const, aclGeneration: null };
      core.putMeta("grantsReadAt", readAt);

      const mode = core.mode();

      if (mode === "legacy" || mode === "failed")
        return { outcome: "legacy" as const, aclGeneration: null };

      if (mode === "fencing" || mode === "backfilling") {
        core.putMeta(
          "grantsInput",
          entries.map((e) => ({
            principalId: e.principalId,
            rights: { ...FULL_RIGHTS, maySubmit: e.canSend },
          })) as never,
        );

        return { outcome: "recorded" as const, aclGeneration: null };
      }

      const wanted = new Map(entries.map((e) => [e.principalId, e.canSend]));

      const current = core.sql
        .all<{ principal_id: string; rights: string }>(
          "SELECT principal_id, rights FROM jmap_grants WHERE mailbox_id = '*'",
        )
        .map((g) => [g.principal_id, JSON.parse(g.rights) as MailboxRights] as const);

      for (const [principalId] of current)
        if (!wanted.has(principalId)) {
          core.applyGrant(principalId, "*", null);
          revoked.push(principalId);
        }

      for (const [principalId, canSend] of wanted) {
        const existing = current.find(([p]) => p === principalId)?.[1];

        if (existing && existing.maySubmit === canSend && existing.mayReadItems) continue;
        core.applyGrant(principalId, "*", { ...FULL_RIGHTS, maySubmit: canSend });
        changed = true;
      }

      return { outcome: "committed" as const, aclGeneration: core.aclGeneration() };
    });

    for (const principalId of revoked) this.closeStreams({ principalId });

    if (changed || revoked.length > 0) this.settle();

    return out;
  }

  // ---------------------------------------------------------------- event streams (T09)

  /** Open a StateChange stream for one principal (the API host authorized it). */
  openStream(request: Request): Response {
    const url = new URL(request.url);
    const principalId = url.searchParams.get("principal") ?? "";
    const types = url.searchParams.get("types") ?? "*";
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

    const stream: EventStream = {
      writer: writable.getWriter(),
      principalId,
      credentialId: request.headers.get("x-bye-credential"),
      types: types === "*" ? null : new Set(types.split(",")),
      restoreGeneration: Number(url.searchParams.get("restoreGeneration") ?? 0),
      last: new Map(),
    };

    this.streams.add(stream);
    this.push(stream, true);

    return new Response(readable, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  private changed(stream: EventStream, force: boolean): { readonly [type: string]: string } | null {
    const acct = this.accountFor(stream.principalId, stream.restoreGeneration);

    if (!acct) return null;
    const out: { [type: string]: string } = {};

    for (const type of CHANGE_TYPES as ReadonlyArray<ChangeType>) {
      if (stream.types && !stream.types.has(type)) continue;

      const revision = this.account.active()
        ? this.account.core.state(type, { principalId: stream.principalId }).revision
        : String(this.store.kernel.currentSeq());

      const token = encodeState({
        accountId: this.mailboxId,
        type,
        restoreGeneration: acct.restoreGeneration,
        visibilityGeneration: acct.visibilityGeneration,
        writerEpoch: acct.writerEpoch ?? 0,
        revision: BigInt(revision),
      });

      if (force || stream.last.get(type) !== token) {
        out[type] = token;
        stream.last.set(type, token);
      }
    }

    return out;
  }

  private push(stream: EventStream, force = false): void {
    const changed = this.changed(stream, force);

    if (changed === null) {
      // The principal lost access: no more notifications on this stream (A3).
      this.closeStream(stream);

      return;
    }

    if (Object.keys(changed).length === 0) return;
    const event = { "@type": "StateChange", changed: { [this.mailboxId]: changed } };

    stream.writer
      .write(encoder.encode(`event: state\ndata: ${JSON.stringify(event)}\n\n`))
      .catch(() => this.streams.delete(stream));
  }

  /**
   * After a commit: notify every open stream, and each grant holder's PushSubscriptions of the
   * types that moved for that principal (its own submissions and drafts, A3).
   */
  notify(): void {
    for (const stream of this.streams) this.push(stream);

    if (!this.account.active()) return;
    const core = this.account.core;

    const principals = core.sql
      .all<{ principal_id: string }>("SELECT DISTINCT principal_id FROM jmap_grants")
      .map((r) => r.principal_id);

    const moved = new Map<string, ReadonlyArray<readonly [ChangeType, string]>>();

    // Account-wide states once; only the principal-scoped ones differ per principal.
    const shared = new Map(
      (CHANGE_TYPES as ReadonlyArray<ChangeType>)
        .filter((type) => !PRINCIPAL_SCOPED.has(type))
        .map((type) => [type, core.state(type).revision] as const),
    );

    for (const principalId of principals) {
      const types: Array<readonly [ChangeType, string]> = [];

      for (const type of CHANGE_TYPES as ReadonlyArray<ChangeType>) {
        const revision = shared.get(type) ?? core.state(type, { principalId }).revision;
        const key = `${principalId} ${type}`;

        if (this.pushed.get(key) !== revision) {
          this.pushed.set(key, revision);
          types.push([type, revision]);
        }
      }

      if (types.length > 0) moved.set(principalId, types);
    }

    if (moved.size > 0) this.waitUntil(this.pushSubscriptions(moved).catch(() => undefined));
  }

  /** StateChange to each grant holder's verified subscriptions, in its own states (T09). */
  private async pushSubscriptions(
    moved: ReadonlyMap<string, ReadonlyArray<readonly [ChangeType, string]>>,
  ): Promise<void> {
    const core = this.account.core;

    const generation =
      (await restoreGenerations(this.env, "mailbox", [this.mailboxId])).get(this.mailboxId) ?? 0;

    const changedFor = new Map(
      [...moved].map(([principalId, types]) => [
        principalId,
        Object.fromEntries(
          types.map(([type, revision]) => [
            type,
            encodeState({
              accountId: this.mailboxId,
              type,
              restoreGeneration: generation,
              visibilityGeneration: core.visibilityGeneration(principalId),
              writerEpoch: core.epoch(),
              revision: BigInt(revision),
            }),
          ]),
        ),
      ]),
    );

    await pushStateChange(this.env, changedFor, this.mailboxId);
  }

  private closeStream(stream: EventStream): void {
    this.streams.delete(stream);
    stream.writer.close().catch(() => undefined);
  }

  /** Close streams for a revoked credential or principal (or all). */
  closeStreams(
    filter: { readonly credentialId?: string; readonly principalId?: string } = {},
  ): number {
    let closed = 0;

    for (const s of this.streams) {
      if (filter.credentialId !== undefined && s.credentialId !== filter.credentialId) continue;

      if (filter.principalId !== undefined && s.principalId !== filter.principalId) continue;
      this.closeStream(s);
      closed++;
    }

    return closed;
  }
}
