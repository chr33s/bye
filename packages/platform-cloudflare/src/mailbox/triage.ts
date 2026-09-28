import { json } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import type { ThreadLedger } from "./threads.ts";
import type { BubbleCondition } from "@bye/domain";
import type { MailboxAfterSend } from "./types.ts";

// Per-thread triage (E07–E11, E24): attention flags, Bubble Up, local rename/merge, and moves to
// Trash/Spam or back. Disposition and bubble state change only through the ledger.

export type AttentionFlag = "replyLater" | "setAside" | "unfollowed";

const ATTENTION_COLUMN: Readonly<Record<AttentionFlag, string>> = {
  replyLater: "reply_later",
  setAside: "set_aside",
  unfollowed: "unfollowed",
};

export class MailboxTriage {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ---------------------------------------------------------------- attention (E07–E10)

  setAttention(threadId: string, flag: AttentionFlag, on: boolean): void {
    const t = this.ledger.require(threadId);
    const col = ATTENTION_COLUMN[flag];
    // Reply Later / Set Aside keep a timestamp for their view's order; Unfollow has none.
    const at = flag === "unfollowed" ? "" : `, ${col}_at = ${on ? "?" : "NULL"}`;
    this.sql.run(
      `UPDATE threads SET ${col} = ?${at} WHERE thread_id = ?`,
      on,
      ...(flag !== "unfollowed" && on ? [this.ctx.now()] : []),
      t.thread_id,
    );
    this.ctx.change("thread", "attention", { threadId: t.thread_id, flag, on });
  }

  bubbleUp(
    threadId: string,
    at: number,
    condition: BubbleCondition = "always",
  ): { readonly generation: number } {
    return {
      generation: this.ledger.setBubble(this.ledger.require(threadId).thread_id, {
        _tag: "Scheduled",
        at,
        condition,
        resetSeen: true,
      })!,
    };
  }

  pinBubble(threadId: string): void {
    this.ledger.setBubble(this.ledger.require(threadId).thread_id, { _tag: "Pinned" });
  }

  /** Pop: resolve the bubble now and surface the thread as new. */
  popBubble(threadId: string): void {
    this.ledger.setBubble(this.ledger.require(threadId).thread_id, {
      _tag: "Popped",
      surface: true,
    });
  }

  clearBubble(threadId: string): void {
    this.ledger.setBubble(this.ledger.require(threadId).thread_id, {
      _tag: "Popped",
      surface: false,
    });
  }

  /** Send-and-done / send-and-bubble / send-and-pop, applied when the provider accepts the message (E08/E09). */
  afterSend(threadId: string | null, action: MailboxAfterSend): void {
    if (!threadId || action._tag === "None") return;
    const id = this.ledger.resolve(threadId);
    if (action._tag === "MarkDone") {
      this.sql.run(
        "UPDATE threads SET set_aside = 0, set_aside_at = NULL, reply_later = 0, reply_later_at = NULL WHERE thread_id = ?",
        id,
      );
      this.ctx.change("thread", "attention", { threadId: id, done: true });
    } else if (action._tag === "ClearBubble") {
      // The reply itself resolves the bubble; nothing new arrived, so the thread is not resurfaced.
      this.ledger.setBubble(id, { _tag: "Popped", surface: false });
    } else {
      this.ledger.setBubble(id, {
        _tag: "Scheduled",
        at: action.at,
        condition: action.condition ?? "always",
        resetSeen: false,
      });
    }
  }

  // ---------------------------------------------------------------- thread controls (E11)

  renameThread(threadId: string, subject: string | null): void {
    const t = this.ledger.require(threadId);
    this.sql.run(
      "UPDATE threads SET local_subject = ? WHERE thread_id = ?",
      subject && subject.trim() ? subject.trim() : null,
      t.thread_id,
    );
    this.ctx.reindexThread(t.thread_id);
    this.ctx.change("thread", "renamed", { threadId: t.thread_id });
  }

  /** Local merge only: original messages and wire headers are untouched; history is reversible. */
  mergeThreads(targetId: string, sourceIds: ReadonlyArray<string>): { readonly mergeId: string } {
    const target = this.ledger.require(targetId);
    const sources = [...new Set(sourceIds.map((id) => this.ledger.require(id).thread_id))].filter(
      (id) => id !== target.thread_id,
    );
    if (sources.length === 0) reject("bad_request", "nothing to merge");
    const moved: Array<{ deliveryId: string; from: string }> = [];
    for (const s of sources) {
      for (const d of this.sql.all<{ delivery_id: string }>(
        "SELECT delivery_id FROM deliveries WHERE thread_id = ?",
        s,
      ))
        moved.push({ deliveryId: d.delivery_id, from: s });
      this.sql.run("UPDATE deliveries SET thread_id = ? WHERE thread_id = ?", target.thread_id, s);
      this.sql.run("UPDATE attachments SET thread_id = ? WHERE thread_id = ?", target.thread_id, s);
      this.sql.run("UPDATE threads SET merged_into = ? WHERE thread_id = ?", target.thread_id, s);
    }
    this.ledger.recount(target.thread_id);
    this.ctx.reindexThread(target.thread_id);
    const mergeId = this.ctx.id("mrg");
    this.sql.run(
      "INSERT INTO merges (merge_id, target_thread, source_threads, moved_deliveries, at) VALUES (?, ?, ?, ?, ?)",
      mergeId,
      target.thread_id,
      JSON.stringify(sources),
      JSON.stringify(moved),
      this.ctx.now(),
    );
    this.ctx.change("thread", "merged", { mergeId, target: target.thread_id, sources });
    return { mergeId };
  }

  unmergeThreads(mergeId: string): void {
    const m =
      this.sql.one<{
        target_thread: string;
        source_threads: string;
        moved_deliveries: string;
        undone_at: number | null;
      }>("SELECT * FROM merges WHERE merge_id = ?", mergeId) ?? reject("not_found", "merge");
    if (m.undone_at !== null) return;
    for (const mv of json<Array<{ deliveryId: string; from: string }>>(m.moved_deliveries, [])) {
      this.sql.run(
        "UPDATE deliveries SET thread_id = ? WHERE delivery_id = ?",
        mv.from,
        mv.deliveryId,
      );
      this.sql.run(
        "UPDATE attachments SET thread_id = ? WHERE delivery_id = ?",
        mv.from,
        mv.deliveryId,
      );
    }
    const sources = json<Array<string>>(m.source_threads, []);
    for (const s of sources) {
      this.sql.run("UPDATE threads SET merged_into = NULL WHERE thread_id = ?", s);
      this.ledger.recount(s);
    }
    this.ledger.recount(m.target_thread);
    this.ctx.reindexThread(m.target_thread);
    for (const s of sources) this.ctx.reindexThread(s);
    this.sql.run("UPDATE merges SET undone_at = ? WHERE merge_id = ?", this.ctx.now(), mergeId);
    this.ctx.change("thread", "unmerged", { mergeId });
  }

  // ---------------------------------------------------------------- Trash / Spam / Restore (E24)

  moveToTrash(threadIds: ReadonlyArray<string>): void {
    for (const id of threadIds.map((t) => this.ledger.require(t).thread_id))
      this.ledger.move(id, "trash", { newForYou: false });
  }

  markSpam(threadIds: ReadonlyArray<string>): void {
    for (const id of threadIds.map((t) => this.ledger.require(t).thread_id))
      this.ledger.move(id, "spam", { newForYou: false });
  }

  /** Restore from Trash/Spam/Screened Out to active mail (false-positive recovery). */
  restore(threadIds: ReadonlyArray<string>): void {
    for (const id of threadIds)
      this.ledger.move(
        this.ledger.require(id).thread_id,
        "active",
        { quarantined: false },
        "restored",
      );
  }
}
