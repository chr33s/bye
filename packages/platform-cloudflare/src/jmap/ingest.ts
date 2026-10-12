import type { RoutingDecision, SafetyVerdict, SenderPolicy } from "@bye/domain";
import { domainOf, normalizeAddress, route } from "@bye/domain";
import type { MessageSummary } from "@bye/mail-codec";
import { Predicate } from "effect";
import { json } from "../durable/sql.ts";
import type { JmapCore, PreparedContent } from "./core.ts";

// Incoming mail on the JMAP core (spec.md §16 B4). Each arrival is staged on its own:
// received → preparing → ready → published, or parked with a reason and its raw bytes retained
// for operator replay. Publication commits the Email and its query data together; a failed or
// parked arrival never stalls unrelated ones, and a repeated trigger never duplicates the effect.

/** What the host received: the original is already durable in R2 (acknowledged ingress). */
export interface ArrivalInput {
  readonly ingestionId: string;
  readonly recipient: string;
  readonly messageKey: string;
  readonly rawSize: number;
  readonly summary: MessageSummary;
  readonly safety: SafetyVerdict;
  readonly receivedAt: number;
  readonly authorizedTransfer?: boolean;
  /** Forwarding hops already on the message (loop protection, E22). */
  readonly forwardHops?: number;
  /** The owner's calendar organizes the event this iTIP REPLY answers (C04, checked by the host). */
  readonly calendarOrganizerReply?: boolean;
  /**
   * A message this account sent through a legacy send job after the cutover (C3): it is
   * published into Sent as read, with no routing and no delivery effects.
   */
  readonly outgoing?: boolean;
}

/** Legacy policy services routing still uses (sender policies, Speakeasy, rules, away replies). */
export interface IngestPorts {
  policy(kind: "address" | "domain", subject: string): SenderPolicy | undefined;
  speakeasyMatches(subject: string): boolean;
  rules(
    summary: MessageSummary,
    recipient: string,
  ): {
    readonly destination?: "imbox" | "feed" | "paper-trail" | undefined;
    readonly labels: ReadonlyArray<string>;
    readonly redeliverTo?: string | undefined;
  };
  /**
   * The effects a legacy delivery has once committed (notification, shared-space propagation,
   * calendar invitations, redelivery, forwarding, away reply), for a published active Email.
   * Runs inside the publication transaction; `discardLocal` moves the Email to Trash.
   */
  delivered(input: DeliveredEffects): DeliveredOutcome;
}

/** What publication does after the effects: Trash the Email when no local copy is kept (E22). */
export interface DeliveredOutcome {
  readonly discardLocal: boolean;
}

export interface DeliveredEffects {
  readonly emailId: string;
  readonly threadId: string;
  readonly from: string;
  readonly recipient: string;
  readonly summary: MessageSummary;
  readonly messageKey: string;
  readonly rawSize: number;
  readonly receivedAt: number;
  readonly forwardHops: number;
  readonly notify: boolean;
  readonly redeliverTo: string | undefined;
}

/** When a staged arrival is next due: 30 s after its last attempt, doubling per attempt. */
const RETRY_AT = "updated_at + 30000 * (1 << MIN(attempts, 6))";

/** Attempts before an arrival whose preparation keeps failing is parked (B4 bounded retry). */
export const MAX_PREPARE_ATTEMPTS = 3;

export type StagingState = "received" | "preparing" | "ready" | "published" | "parked";

/** Where an arrival lands and why (A1 Mailboxes, routing decision, repair note). */
export interface Placement {
  readonly mailboxIds: ReadonlyArray<string>;
  readonly decision: RoutingDecision;
  readonly repair: string | null;
  /** A sender rule's redelivery target, when the arrival qualifies (E22). */
  readonly redeliverTo: string | undefined;
}

/** An arrival's staging state after a publication attempt, and its Email once published. */
export interface ArrivalOutcome {
  readonly emailId: string | null;
  readonly state: StagingState;
}

export const arrivalIdOf = (input: Pick<ArrivalInput, "ingestionId" | "recipient">): string =>
  `${input.ingestionId}:${normalizeAddress(input.recipient)}`;

export class JmapIngest {
  constructor(
    private readonly core: JmapCore,
    private readonly ports: IngestPorts,
  ) {}

  private get sql() {
    return this.core.sql;
  }

  /** Record a received arrival (idempotent): the same ingestion never stages twice (B4). */
  stage(input: ArrivalInput): {
    readonly arrivalId: string;
    readonly state: StagingState;
    readonly emailId: string | null;
  } {
    const arrivalId = arrivalIdOf(input);

    return this.sql.tx(() => {
      this.sql.run(
        "INSERT OR IGNORE INTO jmap_staging (arrival_id, state, input, updated_at) VALUES (?, 'received', ?, ?)",
        arrivalId,
        JSON.stringify(input),
        this.core.clock.now(),
      );

      const row = this.sql.one<{ state: StagingState; email_id: string | null }>(
        "SELECT state, email_id FROM jmap_staging WHERE arrival_id = ?",
        arrivalId,
      )!;

      return { arrivalId, state: row.state, emailId: row.email_id };
    });
  }

  arrival(
    arrivalId: string,
  ):
    | { readonly input: ArrivalInput; readonly state: StagingState; readonly attempts: number }
    | undefined {
    const row = this.sql.one<{ input: string; state: StagingState; attempts: number }>(
      "SELECT input, state, attempts FROM jmap_staging WHERE arrival_id = ?",
      arrivalId,
    );

    return row
      ? {
          input: json<ArrivalInput>(row.input, null as never),
          state: row.state,
          attempts: Number(row.attempts),
        }
      : undefined;
  }

  /** The staged Sent copy of a post-cutover legacy send (`send:<job>:<from>`), if any. */
  outgoingArrivalId(sendJobId: string): string | undefined {
    const prefix = `send:${sendJobId}:`;

    return this.sql.one<{ arrival_id: string }>(
      "SELECT arrival_id FROM jmap_staging WHERE arrival_id >= ? AND arrival_id < ? LIMIT 1",
      prefix,
      `${prefix}\uffff`,
    )?.arrival_id;
  }

  /** Mark preparation started; returns false when the arrival is already past it. */
  preparing(arrivalId: string): boolean {
    return (
      this.sql.run(
        "UPDATE jmap_staging SET state = 'preparing', attempts = attempts + 1, updated_at = ? WHERE arrival_id = ? AND state IN ('received','preparing','ready')",
        this.core.clock.now(),
        arrivalId,
      ) > 0
    );
  }

  /** A preparation failure: retried up to the bound, then parked with its reason (B4). */
  failed(arrivalId: string, reason: string): StagingState {
    return this.sql.tx(() => {
      const row = this.arrival(arrivalId);

      if (!row || row.state === "published") return row?.state ?? "parked";
      const next: StagingState = row.attempts >= MAX_PREPARE_ATTEMPTS ? "parked" : "received";
      this.sql.run(
        "UPDATE jmap_staging SET state = ?, reason = ?, updated_at = ? WHERE arrival_id = ?",
        next,
        reason.slice(0, 300),
        this.core.clock.now(),
        arrivalId,
      );

      return next;
    });
  }

  /** Park immediately (e.g. the bytes exceed preparation limits): retained for operator replay. */
  park(arrivalId: string, reason: string): void {
    this.sql.run(
      "UPDATE jmap_staging SET state = 'parked', reason = ?, updated_at = ? WHERE arrival_id = ? AND state <> 'published'",
      reason.slice(0, 300),
      this.core.clock.now(),
      arrivalId,
    );
  }

  /** Operator replay of a parked arrival: back to `received` with a fresh attempt budget. */
  replay(arrivalId: string): boolean {
    return (
      this.sql.run(
        "UPDATE jmap_staging SET state = 'received', attempts = 0, reason = NULL, updated_at = ? WHERE arrival_id = ? AND state = 'parked'",
        this.core.clock.now(),
        arrivalId,
      ) > 0
    );
  }

  parked(): ReadonlyArray<{ readonly arrivalId: string; readonly reason: string | null }> {
    return this.sql
      .all<{ arrival_id: string; reason: string | null }>(
        "SELECT arrival_id, reason FROM jmap_staging WHERE state = 'parked' ORDER BY updated_at",
      )
      .map((r) => ({ arrivalId: r.arrival_id, reason: r.reason }));
  }

  /**
   * When the earliest unpublished arrival should be retried: backoff from its last attempt
   * (30 s doubling), so a failed preparation re-arms the alarm instead of waiting for unrelated
   * work (B4 bounded retry).
   */
  nextRetryAt(): number | null {
    const row = this.sql.one<{ at: number | null }>(
      `SELECT MIN(${RETRY_AT}) AS at FROM jmap_staging WHERE state IN ('received','preparing','ready')`,
    );

    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  }

  /**
   * Unpublished arrivals whose retry backoff has passed. An arrival still being prepared by its
   * delivery was touched just now, so a concurrent alarm never prepares it a second time.
   */
  due(now: number, limit: number): ReadonlyArray<string> {
    return this.sql
      .all<{ arrival_id: string }>(
        `SELECT arrival_id FROM jmap_staging WHERE state IN ('received','preparing','ready') AND ${RETRY_AT} <= ? ORDER BY updated_at LIMIT ?`,
        now,
        limit,
      )
      .map((r) => r.arrival_id);
  }

  /** Arrivals waiting for (re)preparation, oldest first. */
  pending(limit: number): ReadonlyArray<string> {
    return this.sql
      .all<{ arrival_id: string }>(
        "SELECT arrival_id FROM jmap_staging WHERE state IN ('received','preparing','ready') ORDER BY updated_at LIMIT ?",
        limit,
      )
      .map((r) => r.arrival_id);
  }

  /** Placement for an arrival from the sender policies, Speakeasy and rules (A1 Mailboxes). */
  private placement(input: ArrivalInput, content: PreparedContent): Placement {
    const from = normalizeAddress(input.summary.from.address);
    const threadId = this.core.resolveThread(content.email);
    const method = input.summary.calendarMethod?.toUpperCase();

    // iTIP REPLYs to events the owner organizes skip the Screener; REQUESTs never do (C04).
    const knownThread =
      (threadId !== undefined && this.repliesInKnownThread(threadId, from)) ||
      (input.calendarOrganizerReply === true && method === "REPLY");

    const decision: RoutingDecision =
      input.authorizedTransfer && Predicate.isTagged(input.safety, "Clean")
        ? {
            disposition: "active",
            destination: "imbox",
            labels: [],
            bundle: false,
            notify: false,
            decidedBy: "exact-allow",
            quarantine: false,
          }
        : route({
            safety: input.safety,
            exact: this.ports.policy("address", from),
            domain: this.ports.policy("domain", domainOf(from)),
            speakeasy: this.ports.speakeasyMatches(input.summary.subject),
            knownThread,
          });

    const rules =
      decision.disposition === "active"
        ? this.ports.rules(input.summary, input.recipient)
        : { labels: [] };

    const destination = rules.destination ?? decision.destination;
    const t = this.core.workflowTargets();

    const target =
      decision.disposition === "spam"
        ? this.core.roleMailbox("junk")
        : decision.disposition === "trash"
          ? this.core.roleMailbox("trash")
          : decision.disposition === "screening"
            ? t.screener
            : decision.disposition === "screened-out"
              ? t.screenedOut
              : destination === "feed"
                ? t.feed
                : destination === "paper-trail"
                  ? t.paperTrail
                  : this.core.roleMailbox("inbox");

    const inbox = this.core.roleMailbox("inbox");
    let repair: string | null = null;
    let primary = target;

    // A deleted workflow target is never recreated (A1); mail lands in Inbox and the gap is audited.
    if (primary === undefined) {
      repair = `missing destination for ${decision.disposition}/${destination}`;
      primary = inbox;
    }

    const labels = [...new Set([...decision.labels, ...rules.labels])].flatMap((name) => {
      const row = this.sql.one<{ mailbox_id: string }>(
        "SELECT mailbox_id FROM jmap_mailboxes WHERE role IS NULL AND lower(name) = lower(?)",
        name,
      );

      return row ? [row.mailbox_id] : [];
    });

    return {
      mailboxIds:
        primary === undefined
          ? []
          : [primary, ...(decision.disposition === "active" ? labels : [])],
      decision,
      repair,
      // Sender redelivery copies clean mail only, and never re-copies an authorized transfer.
      redeliverTo:
        Predicate.isTagged(input.safety, "Clean") && !input.authorizedTransfer
          ? rules.redeliverTo
          : undefined,
    };
  }

  /**
   * A reply skips the Screener only inside a live thread we sent into and that the sender
   * already took part in (as an exact From/To/Cc address); a guessed Message-ID never grants
   * entry (as in the legacy router).
   */
  private repliesInKnownThread(threadId: string, from: string): boolean {
    const sent = this.core.roleMailbox("sent");
    const t = this.core.workflowTargets();

    const inactive = [
      this.core.roleMailbox("trash"),
      this.core.roleMailbox("junk"),
      t.screener,
      t.screenedOut,
    ].filter(Predicate.isString);

    if (sent === undefined) return false;

    return (
      this.sql.one(
        // Participation counts only from accepted mail: the sender's own messages waiting in
        // Screener, Spam, Trash or Screened Out never vouch for their next one.
        `SELECT 1 AS x WHERE
           EXISTS (SELECT 1 FROM jmap_emails e JOIN jmap_memberships m ON m.email_id = e.email_id
             WHERE e.thread_id = ? AND m.mailbox_id = ?)
           AND EXISTS (SELECT 1 FROM jmap_emails e,
               json_each(json_array(json(COALESCE(e.from_json, '[]')), json(COALESCE(e.to_json, '[]')), json(COALESCE(e.cc_json, '[]')))) l,
               json_each(l.value) a
             WHERE e.thread_id = ? AND lower(json_extract(a.value, '$.email')) = ?
               AND EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id
                 AND m.mailbox_id NOT IN (SELECT value FROM json_each(?))))`,
        threadId,
        sent,
        threadId,
        from,
        JSON.stringify(inactive),
      ) !== undefined
    );
  }

  /** Sent mail recorded after the cutover: Sent, read, never routed (C3, B4). */
  private publishOutgoing(arrivalId: string, input: ArrivalInput, content: PreparedContent) {
    const sent = this.core.roleMailbox("sent") ?? this.core.roleMailbox("archive");

    if (sent === undefined) {
      this.park(arrivalId, "no Sent mailbox");

      return { emailId: null, state: "parked" as const };
    }

    const emailId = this.core.history.tx(() => {
      const id = this.core.clock.id("eml");

      this.core.publish({
        emailId: id,
        content,
        mailboxIds: [sent],
        keywords: ["$seen"],
        receivedAt: input.receivedAt,
        scanStatus: "not-required",
      });
      this.sql.run(
        "UPDATE jmap_staging SET state = 'published', email_id = ?, reason = NULL, updated_at = ? WHERE arrival_id = ?",
        id,
        this.core.clock.now(),
        arrivalId,
      );

      return id;
    });

    return { emailId, state: "published" as const };
  }

  /**
   * Publish a prepared arrival: one short transaction commits the Email, its memberships, thread,
   * search chunks, counts and history (B4 "published"). Replays return the existing Email.
   */
  publish(arrivalId: string, content: PreparedContent): ArrivalOutcome {
    const staged = this.arrival(arrivalId);

    if (!staged) return { emailId: null, state: "parked" };

    if (staged.state === "published")
      return {
        emailId:
          this.sql.one<{ email_id: string }>(
            "SELECT email_id FROM jmap_staging WHERE arrival_id = ?",
            arrivalId,
          )?.email_id ?? null,
        state: "published",
      };

    if (content.email.truncated) {
      this.park(arrivalId, "message exceeds preparation limits");

      return { emailId: null, state: "parked" };
    }

    const input = staged.input;

    if (input.outgoing === true) return this.publishOutgoing(arrivalId, input, content);
    const placed = this.placement(input, content);

    if (placed.mailboxIds.length === 0) {
      this.park(arrivalId, placed.repair ?? "no destination mailbox");

      return { emailId: null, state: "parked" };
    }

    const emailId = this.core.history.tx(() => {
      const id = this.core.clock.id("eml");

      this.core.publish({
        emailId: id,
        content,
        mailboxIds: placed.mailboxIds,
        keywords: [],
        receivedAt: input.receivedAt,
        scanStatus: input.summary.attachments.length > 0 ? "pending" : "not-required",
        quarantined: placed.decision.quarantine,
      });

      this.sql.run(
        "UPDATE jmap_staging SET state = 'published', email_id = ?, reason = NULL, updated_at = ? WHERE arrival_id = ?",
        id,
        this.core.clock.now(),
        arrivalId,
      );

      if (placed.repair !== null) this.core.audit("repair", arrivalId, placed.repair);

      if (placed.decision.disposition === "active" && !placed.decision.quarantine) {
        const effects = this.ports.delivered({
          emailId: id,
          threadId: this.core.emailRow(id)?.thread_id ?? id,
          from: normalizeAddress(input.summary.from.address),
          recipient: input.recipient,
          summary: input.summary,
          messageKey: input.messageKey,
          rawSize: input.rawSize,
          receivedAt: input.receivedAt,
          forwardHops: input.forwardHops ?? 0,
          notify: placed.decision.notify,
          redeliverTo: placed.redeliverTo,
        });

        const trash = this.core.roleMailbox("trash");

        // A forwarding rule that keeps no local copy (E22).
        if (effects.discardLocal && trash) this.core.applyState(id, { mailboxIds: [trash] });
      }

      return id;
    });

    return { emailId, state: "published" };
  }

  /** Emails still awaiting a scan verdict since before `olderThan` (replayed by cron, §6). */
  pendingScans(
    olderThan: number,
    limit: number,
  ): ReadonlyArray<{ readonly deliveryId: string; readonly messageKey: string }> {
    return this.sql
      .all<{ email_id: string; r2_key: string }>(
        `SELECT e.email_id, b.r2_key FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id
         WHERE e.scan_status = 'pending' AND e.received_at < ? ORDER BY e.received_at LIMIT ?`,
        olderThan,
        limit,
      )
      .map((r) => ({ deliveryId: r.email_id, messageKey: r.r2_key }));
  }

  /** Whole-message scan verdict: infected mail is quarantined into Spam (A3 consistency). */
  recordScan(id: string, outcome: "clean" | "infected" | "failed"): void {
    this.core.history.tx(() => {
      // A verdict may name the legacy delivery a migrated Email came from (C3 backfill).
      const emailId =
        this.sql.one<{ email_id: string }>(
          "SELECT email_id FROM jmap_emails WHERE email_id = ? OR legacy_delivery_id = ? LIMIT 1",
          id,
          id,
        )?.email_id ?? id;

      const row = this.core.emailRow(emailId);

      if (!row) return;
      this.sql.run(
        "UPDATE jmap_emails SET scan_status = ?, quarantined = CASE WHEN ? = 'infected' THEN 1 ELSE quarantined END WHERE email_id = ?",
        outcome,
        outcome,
        emailId,
      );

      const junk = this.core.roleMailbox("junk");

      if (outcome === "infected" && junk) this.core.applyState(emailId, { mailboxIds: [junk] });
      else this.core.history.record("Email", emailId, "updated");
    });
  }
}
