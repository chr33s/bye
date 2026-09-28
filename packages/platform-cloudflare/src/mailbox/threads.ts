import {
  type BubbleCondition,
  type Destination,
  type Disposition,
  normalizeAddress,
  type SenderPolicy,
} from "@bye/domain";
import type { Address, AttachmentMeta } from "@bye/mail-codec";
import { json } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import { type PolicyRow, type ThreadRow, toPolicy } from "./rows.ts";

// ThreadLedger: the only writer of thread and delivery rows, disposition moves (with reindex and
// change events), Bubble Up state (with its scheduled job), message counts, and sender policies.
// Every other mailbox module goes through it, so a transition means the same thing everywhere.

export interface NewThread {
  readonly subject: string;
  readonly sender: string;
  readonly destination: Destination;
  readonly disposition: Disposition;
  readonly quarantined: boolean;
  readonly bundleKey: string | null;
  readonly at: number;
}

export interface NewDelivery {
  readonly ingestionId: string;
  readonly recipient: string;
  readonly threadId: string;
  readonly direction: "in" | "out";
  readonly messageKey: string;
  readonly messageIdHeader: string | null;
  readonly inReplyTo: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly from: Address;
  readonly to: ReadonlyArray<Address>;
  readonly cc: ReadonlyArray<Address>;
  readonly subject: string;
  readonly date: number;
  readonly snippet: string;
  readonly listId: string | null;
  readonly automated: boolean;
  readonly rawSize: number;
  readonly threadRevision: number | "current";
  readonly routing: {
    readonly decidedBy: string;
    readonly hasCalendar: boolean;
    readonly calendarMethod: string | null;
  };
  readonly receivedAt: number;
  /** Omitted for outgoing mail (column default). */
  readonly scanStatus?: "pending" | "not-required";
  readonly attachments: ReadonlyArray<AttachmentMeta>;
}

/** Column effects of a disposition move beyond `disposition` itself. */
export interface MovePatch {
  readonly newForYou?: boolean;
  readonly quarantined?: boolean;
  readonly destination?: Destination;
  readonly bundleKey?: string | null;
  /** `revision`: mark everything seen; `0`: reset so everything counts as unseen. */
  readonly seenRevision?: "revision" | 0;
  readonly messageCount?: 0;
}

export type BubbleChange =
  /** Schedule a Bubble Up; `resetSeen` also clears New For You (the explicit command). */
  | {
      readonly _tag: "Scheduled";
      readonly at: number;
      readonly condition: BubbleCondition;
      readonly resetSeen: boolean;
    }
  | { readonly _tag: "Pinned" }
  /** Resolve now; `surface` returns the thread to New For You. */
  | { readonly _tag: "Popped"; readonly surface: boolean }
  /** A new reply invalidated a scheduled bubble (no change event of its own). */
  | { readonly _tag: "Invalidated" };

export type PolicyKind = "address" | "domain";

export interface PolicyHistoryEntry {
  readonly historyId: string;
  readonly kind: PolicyKind;
  readonly subject: string;
  readonly prior: SenderPolicy | null;
  readonly next: SenderPolicy | null;
  readonly at: number;
}

const MAX_REFERENCES = 50;

export class ThreadLedger {
  constructor(private readonly ctx: MailboxContext) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ---------------------------------------------------------------- reads

  /** Follow local merges to the surviving thread. */
  resolve(threadId: string): string {
    let id = threadId;
    for (let i = 0; i < 16; i++) {
      const next = this.sql.one<{ merged_into: string | null }>(
        "SELECT merged_into FROM threads WHERE thread_id = ?",
        id,
      )?.merged_into;
      if (!next) return id;
      id = next;
    }
    return id;
  }

  row(threadId: string): ThreadRow | undefined {
    return this.sql.one<ThreadRow>("SELECT * FROM threads WHERE thread_id = ?", threadId);
  }

  require(threadId: string): ThreadRow {
    return this.row(this.resolve(threadId)) ?? reject("not_found", "thread");
  }

  exists(threadId: string): boolean {
    return this.sql.one("SELECT 1 AS x FROM threads WHERE thread_id = ?", threadId) !== undefined;
  }

  // ---------------------------------------------------------------- thread and delivery rows

  open(t: NewThread): string {
    const threadId = this.ctx.id("thr");
    this.sql.run(
      `INSERT INTO threads (thread_id, subject, sender, destination, disposition, disposition_at, quarantined, bundle_key,
         last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      threadId,
      t.subject,
      t.sender,
      t.destination,
      t.disposition,
      this.ctx.now(),
      t.quarantined,
      t.bundleKey,
      t.at,
      this.ctx.now(),
    );
    return threadId;
  }

  appendDelivery(d: NewDelivery): string {
    const deliveryId = this.ctx.id("dlv");
    this.sql.run(
      `INSERT INTO deliveries (delivery_id, ingestion_id, recipient, thread_id, original_thread_id, direction, message_key,
         message_id_header, in_reply_to, refs, from_address, from_name, to_json, cc_json, subject, date, snippet, list_id,
         automated, raw_size, thread_revision, routing, received_at, scan_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ${d.threadRevision === "current" ? "(SELECT revision FROM threads WHERE thread_id = ?)" : "?"}, ?, ?, COALESCE(?, 'legacy'))`,
      deliveryId,
      d.ingestionId,
      d.recipient,
      d.threadId,
      d.threadId,
      d.direction,
      d.messageKey,
      d.messageIdHeader,
      JSON.stringify(d.inReplyTo.slice(0, MAX_REFERENCES)),
      JSON.stringify(d.references.slice(-MAX_REFERENCES)),
      d.from.address,
      d.from.name ?? null,
      JSON.stringify(d.to),
      JSON.stringify(d.cc),
      d.subject,
      d.date,
      d.snippet,
      d.listId,
      d.automated,
      d.rawSize,
      d.threadRevision === "current" ? d.threadId : d.threadRevision,
      JSON.stringify(d.routing),
      d.receivedAt,
      d.scanStatus ?? null,
    );
    for (const a of d.attachments) {
      this.sql.run(
        `INSERT INTO attachments (delivery_id, part_id, thread_id, filename, content_type, size, inline, from_address, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deliveryId,
        a.partId,
        d.threadId,
        a.filename,
        a.contentType,
        a.size,
        a.inline,
        d.from.address,
        d.receivedAt,
      );
    }
    this.ctx.indexUpsert("delivery", deliveryId);
    return deliveryId;
  }

  /** Remove one delivery; an emptied thread moves to Trash, otherwise counts are recomputed. */
  removeDelivery(deliveryId: string): string {
    const d =
      this.sql.one<{ thread_id: string }>(
        "SELECT thread_id FROM deliveries WHERE delivery_id = ?",
        deliveryId,
      ) ?? reject("not_found", "delivery");
    this.sql.run("DELETE FROM attachments WHERE delivery_id = ?", deliveryId);
    this.sql.run("DELETE FROM deliveries WHERE delivery_id = ?", deliveryId);
    this.ctx.indexDelete("delivery", deliveryId);
    const left = Number(
      this.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM deliveries WHERE thread_id = ?",
        d.thread_id,
      )?.n ?? 0,
    );
    if (left === 0) this.move(d.thread_id, "trash", { messageCount: 0, newForYou: false }, null);
    else this.recount(d.thread_id);
    this.ctx.change("thread", "delivery-moved", { threadId: d.thread_id, deliveryId });
    return d.thread_id;
  }

  /** Message count and last activity recomputed from the thread's deliveries. */
  recount(threadId: string): void {
    this.sql.run(
      `UPDATE threads SET message_count = (SELECT COUNT(*) FROM deliveries WHERE thread_id = ?),
         last_activity_at = COALESCE((SELECT MAX(received_at) FROM deliveries WHERE thread_id = ?), last_activity_at)
       WHERE thread_id = ?`,
      threadId,
      threadId,
      threadId,
    );
  }

  /** Record one arrival: bump revision/count/activity; `becomesNew` surfaces it in New For You. */
  recordArrival(
    threadId: string,
    input: {
      readonly at: number;
      readonly becomesNew: boolean;
      readonly active: boolean;
      readonly seq: number;
    },
  ): number {
    const revision = Number(this.row(threadId)!.revision) + 1;
    this.sql.run(
      `UPDATE threads SET revision = ?, message_count = message_count + 1, last_activity_at = MAX(last_activity_at, ?),
         activity_seq = ?, new_for_you = CASE WHEN ? THEN 1 ELSE new_for_you END,
         seen_revision = CASE WHEN ? THEN seen_revision ELSE ? END
       WHERE thread_id = ?`,
      revision,
      input.at,
      input.seq,
      input.becomesNew,
      input.becomesNew || !input.active ? 1 : 0,
      revision,
      threadId,
    );
    return revision;
  }

  /** Our own outgoing message joins its thread (count and activity only; never surfaces as new). */
  recordOutgoing(threadId: string, at: number): void {
    this.sql.run(
      "UPDATE threads SET message_count = message_count + 1, last_activity_at = ? WHERE thread_id = ?",
      at,
      threadId,
    );
  }

  // ---------------------------------------------------------------- disposition (E01, E24, §10)

  /**
   * The single disposition transition: sets `disposition` (and its timestamp) plus the patch,
   * reindexes the thread's deliveries, and emits `thread/<change>` unless `change` is null (the
   * caller then emits its own aggregate event).
   */
  move(
    threadId: string,
    disposition: Disposition,
    patch: MovePatch = {},
    change: string | null = "disposition",
  ): void {
    const sets = ["disposition = ?", "disposition_at = ?"];
    const args: Array<string | number | null> = [disposition, this.ctx.now()];
    if (patch.newForYou !== undefined) {
      sets.push("new_for_you = ?");
      args.push(patch.newForYou ? 1 : 0);
    }
    if (patch.quarantined !== undefined) {
      sets.push("quarantined = ?");
      args.push(patch.quarantined ? 1 : 0);
    }
    if (patch.destination !== undefined) {
      sets.push("destination = ?");
      args.push(patch.destination);
    }
    if (patch.bundleKey !== undefined) {
      sets.push("bundle_key = ?");
      args.push(patch.bundleKey);
    }
    if (patch.seenRevision !== undefined)
      sets.push(
        patch.seenRevision === "revision" ? "seen_revision = revision" : "seen_revision = 0",
      );
    if (patch.messageCount !== undefined) sets.push("message_count = 0");
    this.sql.run(`UPDATE threads SET ${sets.join(", ")} WHERE thread_id = ?`, ...args, threadId);
    this.ctx.reindexThread(threadId);
    if (change !== null)
      this.ctx.change(
        "thread",
        change,
        change === "disposition" ? { threadId, disposition } : { threadId },
      );
  }

  // ---------------------------------------------------------------- Bubble Up (E09)

  /** The only writer of bubble state and of the `bubble` scheduled job. Returns the job generation when scheduling. */
  setBubble(threadId: string, next: BubbleChange): number | undefined {
    switch (next._tag) {
      case "Scheduled": {
        const generation = this.ctx.kernel.schedule("bubble", threadId, next.at, {});
        this.sql.run(
          `UPDATE threads SET bubble_tag = 'Scheduled', bubble_at = ?, bubble_generation = ?, bubble_condition = ?${next.resetSeen ? ", new_for_you = 0, seen_revision = revision" : ""} WHERE thread_id = ?`,
          next.at,
          generation,
          next.condition,
          threadId,
        );
        this.ctx.change("thread", "bubble", { threadId, at: next.at, condition: next.condition });
        return generation;
      }
      case "Pinned":
        this.ctx.kernel.cancelJob("bubble", threadId);
        this.sql.run(
          "UPDATE threads SET bubble_tag = 'Pinned', bubble_at = ?, bubble_generation = bubble_generation + 1 WHERE thread_id = ?",
          this.ctx.now(),
          threadId,
        );
        this.ctx.change("thread", "bubble", { threadId, pinned: true });
        return undefined;
      case "Popped":
        this.ctx.kernel.cancelJob("bubble", threadId);
        this.sql.run(
          `UPDATE threads SET bubble_tag = 'None', bubble_at = NULL, bubble_generation = bubble_generation + 1,
             bubbled_at = ?, new_for_you = CASE WHEN ? THEN 1 ELSE new_for_you END WHERE thread_id = ?`,
          this.ctx.now(),
          next.surface,
          threadId,
        );
        this.ctx.change("thread", "bubble", { threadId, popped: next.surface });
        return undefined;
      case "Invalidated":
        this.ctx.kernel.cancelJob("bubble", threadId);
        this.sql.run(
          "UPDATE threads SET bubble_tag = 'None', bubble_at = NULL, bubble_generation = bubble_generation + 1 WHERE thread_id = ?",
          threadId,
        );
        return undefined;
    }
  }

  // ---------------------------------------------------------------- sender policies (E02)

  policy(kind: PolicyKind, subject: string): SenderPolicy | undefined {
    const r = this.sql.one<PolicyRow>(
      "SELECT * FROM sender_policies WHERE kind = ? AND subject = ?",
      kind,
      normalizeAddress(subject),
    );
    return r ? toPolicy(r) : undefined;
  }

  listPolicies(): ReadonlyArray<{
    readonly kind: PolicyKind;
    readonly subject: string;
    readonly policy: SenderPolicy;
  }> {
    return this.sql
      .all<PolicyRow>("SELECT * FROM sender_policies ORDER BY kind, subject")
      .map((r) => ({ kind: r.kind, subject: r.subject, policy: toPolicy(r) }));
  }

  policyHistory(subject?: string): ReadonlyArray<PolicyHistoryEntry> {
    const rows = this.sql.all<{
      history_id: string;
      kind: PolicyKind;
      subject: string;
      prior: string | null;
      next: string | null;
      at: number;
    }>(
      subject
        ? "SELECT * FROM policy_history WHERE subject = ? ORDER BY at DESC, history_id DESC"
        : "SELECT * FROM policy_history ORDER BY at DESC, history_id DESC",
      ...(subject ? [normalizeAddress(subject)] : []),
    );
    return rows.map((r) => ({
      historyId: r.history_id,
      kind: r.kind,
      subject: r.subject,
      prior: json<SenderPolicy | null>(r.prior, null),
      next: json<SenderPolicy | null>(r.next, null),
      at: Number(r.at),
    }));
  }

  historyEntry(historyId: string): PolicyHistoryEntry | undefined {
    const r = this.sql.one<{
      history_id: string;
      kind: PolicyKind;
      subject: string;
      prior: string | null;
      next: string | null;
      at: number;
    }>("SELECT * FROM policy_history WHERE history_id = ?", historyId);
    return r
      ? {
          historyId: r.history_id,
          kind: r.kind,
          subject: r.subject,
          prior: json<SenderPolicy | null>(r.prior, null),
          next: json<SenderPolicy | null>(r.next, null),
          at: Number(r.at),
        }
      : undefined;
  }

  /**
   * The single policy write: upsert or delete, a history row (so every decision can be inspected
   * and reversed, E02), allowed-sender changes applied to existing active threads, and a
   * `policy/updated` change. `onlyIfAbsent` never overrides an existing decision (approvals made
   * by sending must not downgrade a block).
   */
  writePolicy(
    kind: PolicyKind,
    rawSubject: string,
    policy: SenderPolicy | null,
    options: { readonly onlyIfAbsent?: boolean } = {},
  ): boolean {
    const subject = normalizeAddress(rawSubject);
    const prior = this.policy(kind, subject) ?? null;
    if (options.onlyIfAbsent && prior !== null) return false;
    if (policy === null) {
      this.sql.run("DELETE FROM sender_policies WHERE kind = ? AND subject = ?", kind, subject);
    } else {
      this.sql.run(
        `INSERT INTO sender_policies (kind, subject, decision, destination, labels, bundle, notify, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, subject) DO UPDATE SET decision = excluded.decision, destination = excluded.destination,
           labels = excluded.labels, bundle = excluded.bundle, notify = excluded.notify, updated_at = excluded.updated_at`,
        kind,
        subject,
        policy.decision,
        policy.destination,
        JSON.stringify(policy.labels),
        policy.bundle,
        policy.notify,
        this.ctx.now(),
      );
    }
    this.sql.run(
      "INSERT INTO policy_history (history_id, kind, subject, prior, next, at) VALUES (?, ?, ?, ?, ?, ?)",
      this.ctx.id("pol"),
      kind,
      subject,
      prior ? JSON.stringify(prior) : null,
      policy ? JSON.stringify(policy) : null,
      this.ctx.now(),
    );
    // Allowed-sender destination/bundle changes apply to existing active threads.
    if (policy?.decision === "allowed") {
      // Domain match is a suffix comparison, not LIKE: DO SQLite caps LIKE patterns at 50 bytes.
      const match =
        kind === "address" ? "sender = ?" : "lower(substr(sender, -length(?))) = lower(?)";
      const args = kind === "address" ? [subject] : [`@${subject}`, `@${subject}`];
      this.sql.run(
        `UPDATE threads SET destination = ?, bundle_key = ? WHERE disposition = 'active' AND ${match}`,
        policy.destination,
        policy.bundle ? subject : null,
        ...args,
      );
    }
    this.ctx.change("policy", "updated", { kind, subject });
    return true;
  }
}
