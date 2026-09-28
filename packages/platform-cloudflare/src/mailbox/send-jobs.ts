import { Predicate, type Schema } from "effect";
import { MAX_MESSAGE_RECIPIENTS } from "@bye/contracts";
import {
  type CancelResult,
  canTransition,
  CLOUDFLARE_PERSONAL_CAPABILITIES,
  DEFAULT_UNDO_WINDOW_MS,
  domainOf,
  isCancellable,
  mergeOutcome,
  normalizeAddress,
  type RecipientOutcome,
  type SendJobState,
  type TrafficClass,
} from "@bye/domain";
import type { Address } from "@bye/mail-codec";
import { json } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import type { MailboxDrafts } from "./drafts.ts";
import type { IdentityDirectory } from "./identities.ts";
import {
  EMPTY_CONTENT,
  groupBy,
  allInChunks,
  placeholders,
  type RecipientRow,
  type SendJobRow,
  toJob,
} from "./rows.ts";
import type { ThreadLedger } from "./threads.ts";
import type { MailboxTriage } from "./triage.ts";
import type {
  MailboxAfterSend,
  MailboxDraftContent,
  MailboxIdentity,
  MailboxJobClass,
  MailboxSendJob,
  MailboxSendResult,
  MailboxSubmission,
} from "./types.ts";
import type { MailboxUploads } from "./uploads.ts";

// Send intents and the §5.2 send-job state machine (E17–E19, P01). Submission uncertainty
// becomes `unknown`, never an automatic resubmit. Publish-by-mail is a `publish` job that
// completes locally when due; it never reaches a transport.

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

/** Pseudo job IDs issued before publish jobs existed; only in-flight scheduled publishes still use them. */
const LEGACY_PUBLISH_PREFIX = "wpub_";

interface NewJob {
  readonly draftId: string;
  readonly revision: number;
  readonly splitKey: string;
  readonly state: "undo-window" | "scheduled" | "ready";
  readonly dueAt: number;
  /** Null for forwarding: the original bytes are relayed, not sent as one of our identities. */
  readonly identityId: string | null;
  readonly from: string;
  readonly recipients: ReadonlyArray<string>;
  readonly threadId: string | null;
  readonly trafficClass: MailboxJobClass;
  /** Defaults to this job's own rendered-MIME key. */
  readonly contentKey?: string;
  readonly bytes: number;
  readonly afterSend?: MailboxAfterSend;
}

export interface SendOptions {
  readonly expectedRevision: number;
  readonly sendAt?: number;
  readonly undoMs?: number;
  readonly afterSend?: MailboxAfterSend;
  /** Same-reply-to-many: one separate message per recipient, never one combined message. */
  readonly individually?: boolean;
  readonly limits?: { readonly maxBytes: number; readonly maxRecipients: number };
  readonly trafficClass?: TrafficClass;
  /** False when the sending principal lacks the "publish" scope (P01); omitted for internal callers. */
  readonly publishAllowed?: boolean;
}

export class MailboxSends {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
    private readonly identities: IdentityDirectory,
    private readonly drafts: MailboxDrafts,
    private readonly uploads: MailboxUploads,
    private readonly triage: MailboxTriage,
    private readonly recordRecipients: (addresses: ReadonlyArray<Address>) => void,
    /** The service's World publishing address (`world@<service domain>`); null disables publish-by-mail. */
    private readonly publishAddress: string | null,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ------------------------------------------------------------ intents (E18, P01)

  /**
   * Freeze the draft revision and record send job(s) and scheduled wake-ups. One intent per
   * (draft, revision): a second device or a different command key returns the existing intent.
   */
  send(draftId: string, options: SendOptions): MailboxSendResult {
    const d = this.drafts.draft(draftId) ?? reject("not_found", "draft");

    if (d.revision !== options.expectedRevision)
      return { _tag: "Conflict", currentRevision: d.revision };

    const existing = this.sql.all<{ send_job_id: string; due_at: number }>(
      "SELECT send_job_id, due_at FROM send_jobs WHERE draft_id = ? AND draft_revision = ? AND state <> 'cancelled' ORDER BY split_key",
      draftId,
      d.revision,
    );

    if (existing.length > 0)
      return {
        _tag: "Queued",
        sendJobIds: existing.map((e) => e.send_job_id),
        dueAt: Number(existing[0]!.due_at),
        deduplicated: true,
      };

    if (d.state === "sent") reject("conflict", "draft already sent");
    const c = this.drafts.expandGroups(d.content);

    const identity =
      (c.identityId ? this.identities.identity(c.identityId) : this.identities.defaultIdentity()) ??
      reject("bad_request", "no sending identity");

    if (!identity.verified) reject("forbidden", "sending identity not verified");

    // P01: an authenticated send from a hosted identity to world@<service domain> publishes a post.
    // It is a local operation (never SMTP), built from this verified identity, so forged inbound
    // mail can't. The address is the service's, never derived from the sender's own domain: on a
    // customer domain, world@<that domain> is an ordinary colleague's mailbox and gets real mail.
    const publishAddress =
      identity.kind === "hosted" && this.publishAddress
        ? normalizeAddress(this.publishAddress)
        : null;

    const addressed = [...c.to, ...c.cc, ...c.bcc];
    const allRecipients = addressed.map((a) => normalizeAddress(a.address));
    const publishing = publishAddress !== null && allRecipients.includes(publishAddress);

    if (publishing && options.publishAllowed === false)
      reject("forbidden", "missing scope publish");
    const envelope = [...new Set(allRecipients.filter((r) => r !== publishAddress))];

    if (envelope.length === 0 && !publishing) reject("bad_request", "no recipients");

    // Contact-group expansion happens after wire validation, so the ceiling is re-checked here.
    if (!options.individually && envelope.length > MAX_MESSAGE_RECIPIENTS)
      reject("bad_request", "too many recipients", {
        count: envelope.length,
        limit: MAX_MESSAGE_RECIPIENTS,
      });

    const bytes =
      envelope.length > 0
        ? this.uploads.attachmentBytes(c.attachments, c.fileLinks ?? []) +
          c.text.length +
          (c.html?.length ?? 0)
        : 0;

    if (options.limits && envelope.length > 0) {
      if (bytes > options.limits.maxBytes)
        reject("payload_too_large", "message exceeds transport limit; use a large-file link", {
          bytes,
          limit: options.limits.maxBytes,
        });
      const perMessage = options.individually ? 1 : envelope.length;

      if (perMessage > options.limits.maxRecipients)
        reject("bad_request", "too many recipients for transport", {
          count: perMessage,
          limit: options.limits.maxRecipients,
        });
    }

    // Hosted senders go out over the Cloudflare adapter, which caps a message below the wire ceiling
    // (`MAX_MESSAGE_RECIPIENTS`): refuse here, while the user can still edit, rather than have
    // dispatch reject the job after the undo window.
    const jobClass =
      options.trafficClass ?? (identity.kind === "external" ? "external-identity" : "personal");

    if (
      !options.limits &&
      !options.individually &&
      jobClass === "personal" &&
      envelope.length > CLOUDFLARE_PERSONAL_CAPABILITIES.maxRecipients
    )
      reject("bad_request", "too many recipients for transport", {
        count: envelope.length,
        limit: CLOUDFLARE_PERSONAL_CAPABILITIES.maxRecipients,
      });
    this.drafts.freeze(draftId, d.revision, c);

    // Publishing honours the same undo window / Send Later time as the mail.
    const dueAt =
      options.sendAt ??
      this.ctx.now() +
        (options.undoMs ?? this.ctx.setting<number>("pref:undoWindowMs", DEFAULT_UNDO_WINDOW_MS));

    const state = options.sendAt ? "scheduled" : "undo-window";

    const base = {
      draftId,
      revision: d.revision,
      state,
      dueAt,
      identityId: identity.identityId,
      from: identity.address,
      threadId: d.threadId,
    } as const;

    const groups = options.individually
      ? envelope.map((r) => ({ splitKey: r, recipients: [r] }))
      : envelope.length > 0
        ? [{ splitKey: "", recipients: envelope }]
        : [];

    const ids = groups.map((g) => {
      let job: NewJob = {
        ...base,
        splitKey: g.splitKey,
        recipients: g.recipients,
        trafficClass:
          options.trafficClass ?? (identity.kind === "external" ? "external-identity" : "personal"),
        bytes,
      };

      if (options.afterSend) job = { ...job, afterSend: options.afterSend };

      return this.insertJob(job);
    });

    if (publishing)
      ids.push(
        this.insertJob({
          ...base,
          splitKey: "publish:world",
          recipients: [],
          trafficClass: "publish",
          bytes: 0,
        }),
      );
    this.drafts.settleDraft(draftId);

    if (envelope.length > 0) this.recordRecipients(addressed);
    this.ctx.change("draft", envelope.length > 0 ? "sending" : "publish-scheduled", {
      draftId,
      sendJobIds: ids,
    });

    return { _tag: "Queued", sendJobIds: ids, dueAt, deduplicated: false };
  }

  /** The single send-job insert. Due jobs are scheduled; `ready` jobs are dispatched now. */
  private insertJob(j: NewJob): string {
    const id = this.ctx.id("snd");
    const now = this.ctx.now();
    this.sql.run(
      `INSERT INTO send_jobs (send_job_id, draft_id, draft_revision, split_key, state, due_at, identity_id, from_address, recipients,
         thread_id, traffic_class, content_key, bytes, after_send, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      j.draftId,
      j.revision,
      j.splitKey,
      j.state,
      j.dueAt,
      j.identityId,
      j.from,
      JSON.stringify(j.recipients),
      j.threadId,
      j.trafficClass,
      j.contentKey ?? `t/${this.ctx.mailboxId}/out/${id}.eml`,
      j.bytes,
      JSON.stringify(j.afterSend ?? { _tag: "None" }),
      now,
      now,
    );

    for (const r of j.recipients)
      this.sql.run(
        "INSERT INTO send_recipients (send_job_id, address, outcome, updated_at) VALUES (?, ?, 'pending', ?)",
        id,
        r,
        now,
      );

    if (j.state === "ready") {
      this.ctx.kernel.outbox("dispatch", this.ctx.mailboxId, { sendJobId: id });
      this.ctx.change("send", "ready", { sendJobId: id });
    } else {
      this.ctx.kernel.schedule("send", id, j.dueAt, {});
    }

    return id;
  }

  /** System-originated message (away reply, verification) as a frozen single-recipient job. */
  createSystemJob(input: {
    readonly to: Address;
    readonly subject: string;
    readonly text: string;
    readonly threadId: string | null;
    readonly inReplyTo?: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly fromAddress: string;
    readonly trafficClass?: TrafficClass;
  }): string | undefined {
    const identity =
      this.identities.byAddress(input.fromAddress) ?? this.identities.defaultIdentity();

    if (!identity?.verified) return undefined;

    let content: MailboxDraftContent = {
      to: [input.to],
      cc: [],
      bcc: [],
      subject: input.subject,
      text: input.text,
      attachments: [],
      headers: input.headers,
      identityId: identity.identityId,
    };

    if (input.inReplyTo)
      content = { ...content, inReplyTo: input.inReplyTo, references: [input.inReplyTo] };

    const draftId = this.drafts.insertDraft(input.threadId, content);
    this.drafts.freeze(draftId, 1, content);

    return this.readyJob(
      draftId,
      identity,
      normalizeAddress(input.to.address),
      input.threadId,
      input.trafficClass ?? "personal",
      input.text.length,
    );
  }

  /** Forwarding job reusing the original stored bytes (not a resend with a forged From). */
  createForwardJob(input: {
    readonly destination: string;
    readonly recipient: string;
    readonly messageKey: string;
    readonly threadId: string;
    readonly bytes: number;
  }): string {
    const draftId = this.drafts.insertDraft(input.threadId, {
      ...EMPTY_CONTENT,
      to: [{ name: undefined, address: input.destination }],
    });

    this.drafts.freeze(draftId, 1, EMPTY_CONTENT);
    const own = this.identities.byAddress(input.recipient);

    const identity = own
      ? { identityId: own.identityId, address: own.address }
      : { identityId: null, address: normalizeAddress(input.recipient) };

    return this.readyJob(
      draftId,
      identity,
      normalizeAddress(input.destination),
      input.threadId,
      "forwarding",
      input.bytes,
      input.messageKey,
    );
  }

  private readyJob(
    draftId: string,
    identity: Pick<MailboxIdentity, "address"> & { readonly identityId: string | null },
    to: string,
    threadId: string | null,
    trafficClass: TrafficClass,
    bytes: number,
    contentKey?: string,
  ): string {
    let job: NewJob = {
      draftId,
      revision: 1,
      splitKey: "",
      state: "ready",
      dueAt: this.ctx.now(),
      identityId: identity.identityId,
      from: identity.address,
      recipients: [to],
      threadId,
      trafficClass,
      bytes,
    };

    if (contentKey) job = { ...job, contentKey };
    const id = this.insertJob(job);

    this.drafts.settleDraft(draftId);

    return id;
  }

  // ------------------------------------------------------------ undo and due jobs

  /** Cancel before Submitting wins; otherwise report TooLate honestly. Undoing mail also stops its publish. */
  cancelSend(sendJobId: string): CancelResult {
    if (sendJobId.startsWith(LEGACY_PUBLISH_PREFIX)) {
      const draftId = sendJobId.slice(LEGACY_PUBLISH_PREFIX.length);

      if (!this.ctx.kernel.cancelJob("world-publish", draftId))
        return { _tag: "TooLate", state: "accepted" };
      this.drafts.settleDraft(draftId);

      return { _tag: "Cancelled" };
    }

    const job = this.job(sendJobId) ?? reject("not_found", "send job");

    if (!isCancellable(job.state)) return { _tag: "TooLate", state: job.state };
    this.cancelJob(job);

    if (job.trafficClass !== "publish") {
      const publish = this.sql.one<SendJobRow>(
        "SELECT * FROM send_jobs WHERE draft_id = ? AND draft_revision = ? AND traffic_class = 'publish' AND state IN ('undo-window','scheduled')",
        job.draftId,
        job.draftRevision,
      );

      if (publish) this.cancelJob(toJob(publish, []));
      this.ctx.kernel.cancelJob("world-publish", job.draftId);
    }

    this.drafts.settleDraft(job.draftId);

    return { _tag: "Cancelled" };
  }

  private cancelJob(job: MailboxSendJob): void {
    this.transition(job.sendJobId, job.state, "cancelled");
    this.ctx.kernel.cancelJob("send", job.sendJobId);
    this.ctx.kernel.cancelJob("send-retry", job.sendJobId);
  }

  /** Alarm callback: undo window / Send Later elapsed, or retry backoff elapsed. */
  onSendDue(sendJobId: string, kind: "send" | "send-retry"): boolean {
    const job = this.job(sendJobId);

    if (!job) return false;

    if (job.trafficClass === "publish") return kind === "send" && this.publishNow(job);

    if (kind === "send") {
      if (job.state !== "undo-window" && job.state !== "scheduled") return false;
      this.transition(sendJobId, job.state, "ready");
    } else if (job.state !== "ready") {
      return false;
    }

    this.ctx.kernel.outbox("dispatch", this.ctx.mailboxId, { sendJobId });

    return true;
  }

  /**
   * A publish job completes locally: emit `world.publish` from the frozen revision and mark it
   * accepted directly — it never enters the transport part of the state machine.
   */
  private publishNow(job: MailboxSendJob): boolean {
    if (job.state !== "undo-window" && job.state !== "scheduled") return false;
    const c = this.frozenContent(job.sendJobId)!.content;
    this.ctx.kernel.emit("world.publish", this.ctx.mailboxId, {
      fromAddress: job.from,
      subject: c.subject,
      html: c.html ?? "",
      text: c.text,
    });

    if (
      this.sql.run(
        "UPDATE send_jobs SET state = 'accepted', updated_at = ? WHERE send_job_id = ? AND state = ?",
        this.ctx.now(),
        job.sendJobId,
        job.state,
      ) === 0
    )
      reject("conflict", "send job changed concurrently");
    this.ctx.change("send", "accepted", { sendJobId: job.sendJobId });
    this.drafts.settleDraft(job.draftId);
    this.ctx.change("draft", "published", { draftId: job.draftId });

    return true;
  }

  /** Alarm callback for publishes scheduled before publish jobs existed (in-flight only). */
  onLegacyWorldPublishDue(draftId: string, payload: Schema.Json): boolean {
    // Legacy stored payload (pre-typing): relayed as-is; the consumer's lenient decoder validates it.
    this.ctx.kernel.outbox(
      "world.publish",
      this.ctx.mailboxId,
      Predicate.isObject(payload) ? payload : {},
    );
    this.sql.run(
      "UPDATE drafts SET state = 'sent', updated_at = ? WHERE draft_id = ? AND NOT EXISTS (SELECT 1 FROM send_jobs WHERE draft_id = ? AND state NOT IN ('cancelled','accepted','rejected'))",
      this.ctx.now(),
      draftId,
      draftId,
    );
    this.ctx.change("draft", "published", { draftId });

    return true;
  }

  // ------------------------------------------------------------ transport port (§5.2)

  /** Persist Submitting before external I/O. Duplicates and in-flight jobs return null. */
  claim(sendJobId: string): MailboxSubmission | null {
    return this.sql.tx(() => {
      const job = this.job(sendJobId);

      if (!job || job.state !== "ready" || job.trafficClass === "publish") return null;
      // Forwarding jobs have no identity (legacy rows used the "forwarding" sentinel).
      const forwarding = job.identityId === null || job.identityId === "forwarding";
      const identity = forwarding ? undefined : this.identities.identity(job.identityId!);

      if (!forwarding && !identity?.verified) {
        this.transition(sendJobId, "ready", "cancelled");
        this.sql.run(
          "UPDATE send_jobs SET failure = ? WHERE send_job_id = ?",
          JSON.stringify({ kind: "Rejected", detail: "identity no longer authorized" }),
          sendJobId,
        );
        this.drafts.settleDraft(job.draftId);

        return null;
      }

      this.sql.run("UPDATE send_jobs SET attempts = attempts + 1 WHERE send_job_id = ?", sendJobId);
      this.transition(sendJobId, "ready", "submitting");

      return {
        sendJobId,
        identityId: job.identityId ?? "",
        from: job.from,
        contentKey: job.contentKey,
        envelopeRecipients: job.recipients,
        trafficClass: job.trafficClass as TrafficClass,
        bytes: job.bytes,
      };
    });
  }

  /** Provider acceptance: record receipt, outgoing delivery, and after-send actions. Idempotent. */
  accepted(
    sendJobId: string,
    receipt: { readonly providerId: string; readonly wireMessageId?: string },
  ): void {
    this.sql.tx(() => {
      const job = this.job(sendJobId) ?? reject("not_found", "send job");

      if (job.state === "accepted") return;

      if (job.state !== "submitting" && job.state !== "unknown")
        reject("conflict", `cannot accept from ${job.state}`);
      this.transition(sendJobId, job.state, "accepted");
      this.sql.run(
        "UPDATE send_jobs SET provider_id = ?, wire_message_id = ? WHERE send_job_id = ?",
        receipt.providerId,
        receipt.wireMessageId ?? null,
        sendJobId,
      );
      this.drafts.settleDraft(job.draftId);

      // Transactional system mail (verification codes) never becomes a readable outgoing
      // delivery or snippet in the requester's threads, nor approves its recipient as a sender.
      if (job.trafficClass !== "forwarding" && job.trafficClass !== "transactional")
        this.recordOutgoing(job, receipt.wireMessageId);
      this.ctx.change("send", "accepted", { sendJobId });
    });
  }

  /** Persist the classified failure and next durable attempt before the caller acknowledges. */
  failed(
    sendJobId: string,
    failure: {
      readonly kind: "Rejected" | "RetryableBeforeAcceptance" | "Unknown";
      readonly detail: string;
    },
  ): void {
    this.sql.tx(() => {
      const job = this.job(sendJobId) ?? reject("not_found", "send job");

      if (job.state !== "submitting") return;
      this.sql.run(
        "UPDATE send_jobs SET failure = ? WHERE send_job_id = ?",
        JSON.stringify({ kind: failure.kind, detail: failure.detail.slice(0, 500) }),
        sendJobId,
      );

      if (failure.kind === "Unknown") {
        this.transition(sendJobId, "submitting", "unknown");
      } else if (
        failure.kind === "RetryableBeforeAcceptance" &&
        job.attempts < this.maxAttempts(sendJobId)
      ) {
        this.transition(sendJobId, "submitting", "ready");

        const delay =
          RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 60_000;

        this.ctx.kernel.schedule("send-retry", sendJobId, this.ctx.now() + delay, {});
      } else {
        this.transition(sendJobId, "submitting", "rejected");
        this.sql.run(
          "UPDATE send_recipients SET outcome = 'rejected', detail = ?, updated_at = ? WHERE send_job_id = ? AND outcome = 'pending'",
          failure.detail.slice(0, 200),
          this.ctx.now(),
          sendJobId,
        );
        this.drafts.settleDraft(job.draftId);
      }

      this.ctx.change("send", "failed", { sendJobId, kind: failure.kind });
    });
  }

  /** Reconciler: a Submitting job whose outcome was never recorded is uncertain, not retryable. */
  reconcileStaleSubmissions(now: number, staleMs: number): ReadonlyArray<string> {
    return this.sql.tx(() => {
      const stale = this.sql.all<{ send_job_id: string }>(
        "SELECT send_job_id FROM send_jobs WHERE state = 'submitting' AND updated_at < ?",
        now - staleMs,
      );

      for (const s of stale) {
        this.transition(s.send_job_id, "submitting", "unknown");
        this.sql.run(
          "UPDATE send_jobs SET failure = ? WHERE send_job_id = ?",
          JSON.stringify({ kind: "Unknown", detail: "no recorded outcome after submission" }),
          s.send_job_id,
        );
        this.ctx.change("send", "unknown", { sendJobId: s.send_job_id });
      }

      return stale.map((s) => s.send_job_id);
    });
  }

  /**
   * Replay from source state (§6 row 8): a `ready` job whose dispatch message was lost is
   * re-emitted. Jobs waiting on a scheduled retry are left alone; `claim` makes duplicates harmless.
   */
  replayStaleDispatches(now: number, staleMs: number, limit = 100): ReadonlyArray<string> {
    return this.sql.tx(() => {
      const stale = this.sql.all<{ send_job_id: string }>(
        "SELECT send_job_id FROM send_jobs WHERE state = 'ready' AND updated_at < ? ORDER BY updated_at LIMIT ?",
        now - staleMs,
        limit,
      );

      const replayed: Array<string> = [];

      for (const s of stale) {
        if (this.ctx.kernel.job("send-retry", s.send_job_id)) continue;
        this.ctx.kernel.outbox("dispatch", this.ctx.mailboxId, { sendJobId: s.send_job_id });
        this.sql.run(
          "UPDATE send_jobs SET updated_at = ? WHERE send_job_id = ?",
          now,
          s.send_job_id,
        );
        replayed.push(s.send_job_id);
      }

      return replayed;
    });
  }

  /** Explicit decision for an Unknown send after inspecting provider evidence. */
  resolveUnknown(
    sendJobId: string,
    decision:
      | { readonly _tag: "Accepted"; readonly providerId: string }
      | { readonly _tag: "Rejected" }
      | { readonly _tag: "Resend" },
  ): void {
    const job = this.job(sendJobId) ?? reject("not_found", "send job");

    if (job.state !== "unknown") reject("conflict", "send job is not unknown");

    if (Predicate.isTagged(decision, "Accepted"))
      this.accepted(sendJobId, { providerId: decision.providerId });
    else if (Predicate.isTagged(decision, "Rejected")) {
      this.transition(sendJobId, "unknown", "rejected");
      this.drafts.settleDraft(job.draftId);
    } else {
      this.transition(sendJobId, "unknown", "ready");
      this.ctx.kernel.outbox("dispatch", this.ctx.mailboxId, { sendJobId });
    }
  }

  /** Per-recipient provider events, idempotent and order-insensitive (terminal outcomes don't regress). */
  recordRecipientEvent(
    eventId: string,
    sendJobId: string,
    address: string,
    outcome: RecipientOutcome,
    detail?: string,
  ): void {
    this.sql.tx(() =>
      this.ctx.kernel.consume(eventId, sendJobId, () => {
        const a = normalizeAddress(address);

        const cur = this.sql.one<{ outcome: RecipientOutcome }>(
          "SELECT outcome FROM send_recipients WHERE send_job_id = ? AND address = ?",
          sendJobId,
          a,
        );

        if (!cur) return null;
        const next = mergeOutcome(cur.outcome, outcome);

        // A late lower-ranked event changes nothing, including the recorded detail.
        if (next !== outcome) return cur.outcome;
        this.sql.run(
          "UPDATE send_recipients SET outcome = ?, detail = ?, updated_at = ? WHERE send_job_id = ? AND address = ?",
          next,
          detail ?? null,
          this.ctx.now(),
          sendJobId,
          a,
        );
        this.ctx.change("send", "recipient", { sendJobId });

        return next;
      }),
    );
  }

  // ------------------------------------------------------------ reads

  /** Frozen content for rendering; notes, clips, and private comments are never part of it. */
  frozenContent(sendJobId: string):
    | {
        readonly job: MailboxSendJob;
        readonly content: MailboxDraftContent;
        readonly identity: MailboxIdentity | undefined;
      }
    | undefined {
    const job = this.job(sendJobId);

    if (!job) return undefined;

    const r = this.sql.one<{ content: string }>(
      "SELECT content FROM draft_revisions WHERE draft_id = ? AND revision = ?",
      job.draftId,
      job.draftRevision,
    );

    return {
      job,
      content: json(r?.content, EMPTY_CONTENT),
      identity: job.identityId ? this.identities.identity(job.identityId) : undefined,
    };
  }

  setRenderedSize(sendJobId: string, bytes: number): void {
    this.sql.run("UPDATE send_jobs SET bytes = ? WHERE send_job_id = ?", bytes, sendJobId);
  }

  job(sendJobId: string): MailboxSendJob | undefined {
    return this.toJobs(
      this.sql.all<SendJobRow>("SELECT * FROM send_jobs WHERE send_job_id = ?", sendJobId),
    )[0];
  }

  /** The most recent `limit` jobs (optionally in one state), oldest first. */
  jobs(state?: SendJobState, limit = 200): ReadonlyArray<MailboxSendJob> {
    return this.toJobs(
      this.sql
        .all<SendJobRow>(
          "SELECT * FROM send_jobs WHERE (? IS NULL OR state = ?) ORDER BY created_at DESC, rowid DESC LIMIT ?",
          state ?? null,
          state ?? null,
          Math.min(Math.max(Math.floor(limit), 1), 1000),
        )
        .reverse(),
    );
  }

  /** Jobs with their recipient outcomes loaded in one query. */
  private toJobs(rows: ReadonlyArray<SendJobRow>): Array<MailboxSendJob> {
    if (rows.length === 0) return [];

    const outcomes = groupBy(
      allInChunks(
        rows.map((r) => r.send_job_id),
        (ids) =>
          this.sql.all<RecipientRow>(
            `SELECT * FROM send_recipients WHERE send_job_id IN (${placeholders(ids.length)}) ORDER BY address`,
            ...ids,
          ),
      ),
      (o) => o.send_job_id,
    );

    return rows.map((r) => toJob(r, outcomes.get(r.send_job_id) ?? []));
  }

  private maxAttempts(sendJobId: string): number {
    return Number(
      this.sql.one<{ m: number }>(
        "SELECT max_attempts AS m FROM send_jobs WHERE send_job_id = ?",
        sendJobId,
      )?.m ?? 5,
    );
  }

  private transition(sendJobId: string, from: SendJobState, to: SendJobState): void {
    if (!canTransition(from, to)) reject("conflict", `illegal send transition ${from} -> ${to}`);

    const n = this.sql.run(
      "UPDATE send_jobs SET state = ?, updated_at = ? WHERE send_job_id = ? AND state = ?",
      to,
      this.ctx.now(),
      sendJobId,
      from,
    );

    if (n === 0) reject("conflict", "send job changed concurrently");
    this.ctx.change("send", to, { sendJobId });
  }

  /** The accepted message joins its thread (or opens one); recipients become approved senders. */
  private recordOutgoing(job: MailboxSendJob, wireMessageId: string | undefined): void {
    const c = this.frozenContent(job.sendJobId)!.content;
    const now = this.ctx.now();
    const known = job.threadId ? this.ledger.resolve(job.threadId) : null;

    const threadId =
      known && this.ledger.exists(known)
        ? known
        : this.ledger.open({
            subject: c.subject,
            sender: job.from,
            destination: "imbox",
            disposition: "active",
            quarantined: false,
            bundleKey: null,
            at: now,
          });

    this.ledger.appendDelivery({
      ingestionId: `send:${job.sendJobId}`,
      recipient: job.from,
      threadId,
      direction: "out",
      messageKey: job.contentKey,
      messageIdHeader: wireMessageId ?? `${job.sendJobId}@${domainOf(job.from) || "localhost"}`,
      inReplyTo: c.inReplyTo ? [c.inReplyTo] : [],
      references: c.references ?? [],
      from: { name: undefined, address: job.from },
      // Bcc recipients are never recorded in visible To/Cc.
      to: c.to,
      cc: c.cc,
      subject: c.subject,
      date: now,
      snippet: c.text.slice(0, 200),
      listId: null,
      automated: false,
      rawSize: 0,
      threadRevision: "current",
      routing: { decidedBy: "sent", hasCalendar: false, calendarMethod: null },
      receivedAt: now,
      attachments: [],
    });
    this.ledger.recordOutgoing(threadId, now);

    // Emailing someone approves them as a sender (they skip the Screener when they reply). An
    // existing decision — including a block — is never overridden; new approvals are recorded in
    // the policy history like any other decision (E02).
    for (const r of job.recipients) {
      this.ledger.writePolicy(
        "address",
        r,
        { decision: "allowed", destination: "imbox", labels: [], bundle: false, notify: false },
        { onlyIfAbsent: true },
      );
    }

    const afterSend = json<MailboxAfterSend>(
      this.sql.one<{ after_send: string }>(
        "SELECT after_send FROM send_jobs WHERE send_job_id = ?",
        job.sendJobId,
      )?.after_send,
      { _tag: "None" },
    );

    this.triage.afterSend(threadId, afterSend);
  }
}
