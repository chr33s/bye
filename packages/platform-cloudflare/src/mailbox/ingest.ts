import { Predicate } from "effect";
import {
  domainOf,
  normalizeAddress,
  route,
  type RoutingDecision,
  type RoutingStep,
} from "@bye/domain";
import type { Address, MessageSummary } from "@bye/mail-codec";
import { bool, json } from "../durable/sql.ts";
import type { MailboxAutomation } from "./automation.ts";
import { type MailboxContext, reject } from "./context.ts";
import type { MailboxOrganizer } from "./organize.ts";
import { type DeliveryRow, placeholders, type ThreadRow } from "./rows.ts";
import type { MailboxScreener } from "./screener.ts";
import type { ThreadLedger } from "./threads.ts";
import type { MailboxTransfers } from "./transfers.ts";
import type { MailboxDeliveryInput, MailboxDeliveryResult, MailboxScanStatus } from "./types.ts";
import type { MailboxViews } from "./views.ts";

// Ingestion commit (§5.1 step 6) and whole-message scan verdicts (§10).
//
// Invariants: a Message-ID never grants entry on its own (the sender must already take part in
// the referenced thread); screened/spam mail never joins an active thread; quarantined mail is
// never enrolled anywhere; forward-without-copy trashes only a thread this delivery created.

const MAX_REFERENCES = 50;

const FALLBACK_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** The routing outcome for one delivery, fixed before any row is written. */
interface Decision extends Omit<RoutingDecision, "decidedBy"> {
  readonly decidedBy: RoutingStep | "transfer";
  readonly workflowBoardId: string | undefined;
  readonly redeliverTo: string | undefined;
}

const TRANSFER: Decision = {
  disposition: "active",
  destination: "imbox",
  labels: [],
  bundle: false,
  notify: false,
  decidedBy: "transfer",
  quarantine: false,
  workflowBoardId: undefined,
  redeliverTo: undefined,
};

/** Deterministic user rules refine an active decision (E12); they never change its disposition. */
const withRules = (
  d: Decision,
  rules: ReturnType<MailboxOrganizer["evaluateRules"]>,
): Decision => ({
  ...d,
  destination: rules.destination ?? d.destination,
  bundle: d.bundle || rules.bundle,
  labels: [...new Set([...d.labels, ...rules.labels])],
  workflowBoardId: rules.workflowBoardId,
  redeliverTo: rules.redeliverTo,
});

type AttachmentAccessResult = {
  readonly allowed: boolean;
  readonly status: MailboxScanStatus;
};

export class MailboxIngest {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
    private readonly views: MailboxViews,
    private readonly screener: MailboxScreener,
    private readonly organize: MailboxOrganizer,
    private readonly automation: MailboxAutomation,
    private readonly transfers: MailboxTransfers,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  /**
   * Whether an inbound iTIP REPLY would otherwise land in the Screener, so the host should ask the
   * owner's calendar whether it organizes the event (C04). Cheap: no policy for sender or domain.
   */
  needsOrganizerCheck(summary: MessageSummary, ingestionId: string): boolean {
    if (!summary.hasCalendar || summary.calendarMethod?.toUpperCase() !== "REPLY") return false;
    const from = normalizeAddress(summary.from.address);

    if (this.ledger.policy("address", from) || this.ledger.policy("domain", domainOf(from)))
      return false;

    return (
      this.sql.one("SELECT 1 AS x FROM deliveries WHERE ingestion_id = ? LIMIT 1", ingestionId) ===
      undefined
    );
  }

  /**
   * Commit one inbound delivery. Deduplicated by (ingestionId, recipient) only; identical
   * Message-IDs or bodies from independent SMTP deliveries are NOT discarded (§5.1).
   */
  commitDelivery(input: MailboxDeliveryInput): MailboxDeliveryResult {
    const recipient = normalizeAddress(input.recipient);

    const out = this.sql.tx(() =>
      this.ctx.kernel.consume(`ingest:${input.ingestionId}`, recipient, () =>
        this.applyDelivery({ ...input, recipient }),
      ),
    );

    return { ...out.result, replayed: out.replayed };
  }

  /**
   * A reply that answers the user (E09): not automated (auto-replies, bounces, delivery reports,
   * list or no-reply traffic) and not sent from one of the user's own identities. Spam and
   * screened-out mail never reach this check because they are not active.
   */
  private isQualifyingReply(s: MessageSummary, from: string): boolean {
    if (s.automated) return false;

    return (
      this.sql.one<{ n: number }>("SELECT 1 AS n FROM identities WHERE address = ?", from) ===
      undefined
    );
  }

  private applyDelivery(input: MailboxDeliveryInput): Omit<MailboxDeliveryResult, "replayed"> {
    const s = input.summary;
    const from = normalizeAddress(s.from.address);
    const referenced = this.findReferencedThread([...s.inReplyTo, ...s.references]);

    // Threading membership: the sender already wrote, or was addressed, in the referenced thread.
    const participant =
      referenced !== undefined && this.appearsInThread(referenced.thread_id, from);

    const decision = this.decide(input, from, referenced, participant);
    const active = decision.disposition === "active";

    // Join an existing thread only when both share a disposition (screened/spam mail never joins an
    // active thread) and the sender already takes part in it (or this is an authorized transfer):
    // a quoted or leaked Message-ID must never splice an outsider into a private conversation.
    const mayJoin =
      referenced !== undefined &&
      (input.authorizedTransfer === true || participant) &&
      referenced.disposition === decision.disposition &&
      decision.disposition !== "trash";

    const joined = mayJoin
      ? referenced
      : active
        ? this.fallbackThread(from, s.subject, input.receivedAt)
        : undefined;

    const threadId =
      joined?.thread_id ??
      this.ledger.open({
        subject: s.subject,
        sender: from,
        destination: decision.destination,
        disposition: decision.disposition,
        quarantined: decision.quarantine,
        bundleKey: decision.bundle ? from : null,
        at: input.receivedAt,
      });

    const current = this.ledger.row(threadId)!;
    const unfollowed = bool(current.unfollowed);
    const becomesNew = active && !unfollowed;

    const deliveryId = this.ledger.appendDelivery({
      ingestionId: input.ingestionId,
      recipient: input.recipient,
      threadId,
      direction: "in",
      messageKey: input.messageKey,
      messageIdHeader: s.messageIdHeader ?? null,
      inReplyTo: s.inReplyTo,
      references: s.references,
      from: { name: s.from.name, address: from },
      to: s.to,
      cc: s.cc,
      subject: s.subject,
      date: s.date,
      snippet: s.snippet.slice(0, 512),
      listId: s.listId ?? null,
      automated: s.automated,
      rawSize: input.rawSize,
      threadRevision: Number(current.revision) + 1,
      routing: {
        decidedBy: decision.decidedBy,
        hasCalendar: s.hasCalendar,
        calendarMethod: s.calendarMethod ?? null,
      },
      receivedAt: input.receivedAt,
      // Whole-message scanning (§10): messages with attachments are scanned after commit and their
      // attachments stay blocked until the verdict is clean. Plain messages need no scan.
      scanStatus: s.attachments.length > 0 ? "pending" : "not-required",
      attachments: s.attachments,
    });

    if (s.attachments.length > 0)
      this.ctx.kernel.emit("scan-message", this.ctx.mailboxId, {
        deliveryId,
        messageKey: input.messageKey,
      });

    // A new reply invalidates any scheduled Bubble Up and returns the thread to New For You (§4.2).
    // An `if-no-reply` bubble yields only to a qualifying reply, so an away reply or bounce leaves
    // the reminder in place (E09).
    if (
      becomesNew &&
      current.bubble_tag === "Scheduled" &&
      (current.bubble_condition !== "if-no-reply" || this.isQualifyingReply(s, from))
    )
      this.ledger.setBubble(threadId, { _tag: "Invalidated" });

    const seq = this.ctx.change("thread", "delivered", {
      threadId,
      deliveryId,
      disposition: decision.disposition,
    });

    this.ledger.recordArrival(threadId, { at: input.receivedAt, becomesNew, active, seq });

    for (const label of decision.labels) this.organize.assignLabelByName(threadId, label);

    if (active && !decision.quarantine) {
      if (decision.workflowBoardId) this.organize.enrollInBoard(decision.workflowBoardId, threadId);

      // Sender-specific redelivery rules copy the message to another authorized mailbox (E22).
      if (
        decision.redeliverTo &&
        Predicate.isTagged(input.safety, "Clean") &&
        !input.authorizedTransfer
      ) {
        this.transfers.emitTransfer(
          deliveryId,
          decision.redeliverTo,
          "copy",
          this.deliverySummary(deliveryId),
        );
      }

      this.organize.enrollByAddress(
        threadId,
        [...s.to, ...s.cc].map((a) => normalizeAddress(a.address)).concat(input.recipient),
      );
      // Shared-resource propagation (O03 extension mailboxes, O04 future replies): consumers look up
      // registrations and append idempotently by event; unregistered mailboxes are a no-op.
      this.ctx.kernel.emit("shared.delivery", this.ctx.mailboxId, { deliveryId, threadId });

      if (s.hasCalendar)
        this.ctx.kernel.emit("calendar.invitation", this.ctx.mailboxId, {
          deliveryId,
          messageKey: input.messageKey,
        });

      if (
        this.automation.shouldNotify({ threadId, from, notifyPolicy: decision.notify, unfollowed })
      )
        this.ctx.kernel.outbox("notify", this.ctx.mailboxId, { kind: "delivery", threadId });
      this.automation.maybeAwayReply({
        threadId,
        from,
        recipient: input.recipient,
        summary: s,
        deliveredAt: input.receivedAt,
      });

      const fwd = this.automation.maybeForward({
        from,
        recipient: input.recipient,
        messageKey: input.messageKey,
        threadId,
        hops: input.forwardHops ?? 0,
        bytes: input.rawSize,
      });

      if (fwd.discardLocal && !joined) this.ledger.move(threadId, "trash", { newForYou: false });
    }

    return {
      deliveryId,
      threadId,
      disposition: decision.disposition,
      destination: current.destination,
      decidedBy: decision.decidedBy,
      newForYou: becomesNew,
    };
  }

  private decide(
    input: MailboxDeliveryInput,
    from: string,
    referenced: ThreadRow | undefined,
    participant: boolean,
  ): Decision {
    if (input.authorizedTransfer && Predicate.isTagged(input.safety, "Clean"))
      return withRules(TRANSFER, this.organize.evaluateRules(input.summary, input.recipient));

    // A reply only skips the Screener when the thread is one we took part in AND the sender was
    // already a participant of it. Message-ID is untrusted: guessing one never grants entry (§4.1).
    const knownThread =
      referenced !== undefined &&
      referenced.disposition === "active" &&
      participant &&
      this.weSentInto(referenced.thread_id);

    const method = input.summary.calendarMethod?.toUpperCase();

    const routed = route({
      safety: input.safety,
      exact: this.ledger.policy("address", from),
      domain: this.ledger.policy("domain", domainOf(from)),
      speakeasy: this.screener.speakeasyMatches(input.summary.subject),
      // iTIP REPLYs to events the owner organizes skip the Screener; REQUESTs never do (C04).
      knownThread: knownThread || (input.calendarOrganizerReply === true && method === "REPLY"),
    });

    const decision: Decision = { ...routed, workflowBoardId: undefined, redeliverTo: undefined };

    return routed.disposition === "active"
      ? withRules(decision, this.organize.evaluateRules(input.summary, input.recipient))
      : decision;
  }

  private weSentInto(threadId: string): boolean {
    return (
      this.sql.one(
        "SELECT 1 AS x FROM deliveries WHERE thread_id = ? AND direction = 'out' LIMIT 1",
        threadId,
      ) !== undefined
    );
  }

  /** Whether the address already sent, or was addressed, in the thread (threading membership). */
  private appearsInThread(threadId: string, sender: string): boolean {
    for (const d of this.sql.all<{ from_address: string; to_json: string; cc_json: string }>(
      "SELECT from_address, to_json, cc_json FROM deliveries WHERE thread_id = ?",
      threadId,
    )) {
      if (normalizeAddress(d.from_address) === sender) return true;

      for (const a of [
        ...json<Array<Address>>(d.to_json, []),
        ...json<Array<Address>>(d.cc_json, []),
      ])
        if (normalizeAddress(a.address) === sender) return true;
    }

    return false;
  }

  private findReferencedThread(ids: ReadonlyArray<string>): ThreadRow | undefined {
    const refs = [...new Set(ids.filter((x) => x.length > 0))].slice(-MAX_REFERENCES);

    if (refs.length === 0) return undefined;

    const row = this.sql.one<{ thread_id: string }>(
      `SELECT thread_id FROM deliveries WHERE message_id_header IN (${placeholders(refs.length)}) ORDER BY date DESC LIMIT 1`,
      ...refs,
    );

    return row ? this.ledger.row(this.ledger.resolve(row.thread_id)) : undefined;
  }

  /** Conservative fallback: same sender, same normalized subject, reply prefix, recent activity. */
  private fallbackThread(from: string, subject: string, at: number): ThreadRow | undefined {
    const normalized = this.ctx.codec.normalizeSubject(subject);

    if (normalized.length === 0 || normalized === subject.trim().toLowerCase()) return undefined;

    const candidates = this.sql.all<ThreadRow>(
      "SELECT * FROM threads WHERE sender = ? AND disposition = 'active' AND merged_into IS NULL AND last_activity_at >= ? ORDER BY last_activity_at DESC LIMIT 20",
      from,
      at - FALLBACK_WINDOW_MS,
    );

    return candidates.find((t) => this.ctx.codec.normalizeSubject(t.subject) === normalized);
  }

  /** Reconstruct a MessageSummary from stored delivery fields (redelivery, rules). */
  deliverySummary(deliveryId: string): MessageSummary {
    const row =
      this.sql.one<DeliveryRow>("SELECT * FROM deliveries WHERE delivery_id = ?", deliveryId) ??
      reject("not_found", "delivery");

    const d = this.views.deliveries([row])[0]!;

    return {
      from: d.from,
      to: d.to,
      cc: d.cc,
      replyTo: [],
      subject: d.subject,
      date: d.date,
      messageIdHeader: d.messageIdHeader ?? undefined,
      inReplyTo: json<Array<string>>(row.in_reply_to, []),
      references: json<Array<string>>(row.refs, []),
      listId: row.list_id ?? undefined,
      listUnsubscribe: undefined,
      automated: bool(row.automated),
      snippet: d.snippet,
      attachments: d.attachments,
      hasCalendar: d.routing.hasCalendar,
      calendarMethod: d.routing.calendarMethod ?? undefined,
    };
  }

  // ---------------------------------------------------------------- scanning (§10)

  /**
   * Record the whole-message scan verdict. Infected mail is quarantined: moved to Spam with the
   * original preserved and visible for false-positive recovery; its attachments stay blocked even
   * if the thread is restored. Replays with a stale verdict never downgrade `infected`.
   */
  recordDeliveryScan(
    deliveryId: string,
    outcome: "clean" | "infected" | "failed",
    signature?: string,
  ): void {
    this.sql.tx(() => {
      const d = this.sql.one<{ thread_id: string; scan_status: MailboxScanStatus }>(
        "SELECT thread_id, scan_status FROM deliveries WHERE delivery_id = ?",
        deliveryId,
      );

      if (!d || d.scan_status === "infected") return;
      this.sql.run(
        "UPDATE deliveries SET scan_status = ?, scan_signature = ?, scan_attempts = scan_attempts + 1 WHERE delivery_id = ?",
        outcome,
        signature ?? null,
        deliveryId,
      );

      if (outcome === "infected")
        this.ledger.move(d.thread_id, "spam", { quarantined: true, newForYou: false }, null);
      this.ctx.change("delivery", "scanned", {
        deliveryId,
        threadId: d.thread_id,
        status: outcome,
      });
    });
  }

  /** Whether a delivery's attachments may be downloaded, previewed, forwarded or redelivered. */
  attachmentAccess(deliveryId: string): AttachmentAccessResult {
    const status =
      this.sql.one<{ scan_status: MailboxScanStatus | null }>(
        "SELECT scan_status FROM deliveries WHERE delivery_id = ?",
        deliveryId,
      ) ?? reject("not_found", "delivery");

    const s = status.scan_status ?? "legacy";

    return { allowed: s === "clean" || s === "not-required" || s === "legacy", status: s };
  }

  /** Scan status of the delivery that owns a stored original (forwarding reuses originals). */
  scanStatusForMessageKey(messageKey: string): MailboxScanStatus | null {
    return (
      this.sql.one<{ scan_status: MailboxScanStatus }>(
        "SELECT scan_status FROM deliveries WHERE message_key = ? ORDER BY received_at DESC LIMIT 1",
        messageKey,
      )?.scan_status ?? null
    );
  }

  /** Deliveries still waiting for a verdict (for reconciliation and optional rescans). */
  pendingScans(
    olderThan: number,
    limit: number,
  ): ReadonlyArray<{ readonly deliveryId: string; readonly messageKey: string }> {
    return this.sql
      .all<{ delivery_id: string; message_key: string }>(
        "SELECT delivery_id, message_key FROM deliveries WHERE scan_status = 'pending' AND received_at <= ? ORDER BY received_at LIMIT ?",
        olderThan,
        limit,
      )
      .map((r) => ({ deliveryId: r.delivery_id, messageKey: r.message_key }));
  }
}
