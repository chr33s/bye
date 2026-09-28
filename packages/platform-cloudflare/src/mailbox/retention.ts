import { RETENTION } from "@bye/domain";
import type { SqlValue } from "../durable/sql.ts";
import type { MailboxContext } from "./context.ts";
import { decodeCursor, encodeCursor } from "./rows.ts";

// Retention and export paging (E24, A04, §12). Erasure writes index tombstones and blob-GC
// outbox events; nothing is deleted from R2 directly.

export interface ManifestEntry {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly messageKey: string;
  readonly date: number;
  readonly from: string;
  readonly direction: "in" | "out";
}

/** Threads purged per retention/empty batch; the rest continue from a scheduled job. */
export const RETENTION_BATCH = 200;

type ExportManifestPageResult = {
  readonly deliveries: ReadonlyArray<ManifestEntry>;
  readonly nextCursor: string | null;
};

type PurgeResult = { readonly deleted: number; readonly more: boolean };

type EmptyDispositionResult = { readonly deleted: number; readonly more: boolean };

export class MailboxRetention {
  constructor(private readonly ctx: MailboxContext) {}

  private get sql() {
    return this.ctx.sql;
  }

  /**
   * Empty Trash/Spam/Screened Out as of now. One bounded batch runs in the caller's transaction;
   * the rest continues from a scheduled job (`empty-disposition`) so a large backlog never
   * exceeds one invocation's CPU budget. Mail that lands in the disposition afterwards is kept.
   */
  emptyDisposition(
    disposition: "trash" | "spam" | "screened-out",
    before: number = this.ctx.now(),
  ): EmptyDispositionResult {
    const { deleted, more } = this.purge(
      "disposition = ? AND (disposition_at IS NULL OR disposition_at <= ?)",
      [disposition, before],
    );

    if (more)
      this.ctx.kernel.schedule("empty-disposition", disposition, this.ctx.now(), { before });

    return { deleted, more };
  }

  /**
   * Trash 30d, Spam/Screened Out 90d, optional user recycling for other mail. Purges at most
   * {@link RETENTION_BATCH} threads per call; when more remain it schedules a `retention-sweep`
   * job, which calls back here from the alarm until the backlog is gone.
   */
  sweepRetention(now: number): { readonly deleted: number; readonly more: boolean } {
    return this.sql.tx(() => {
      const recycleDays = this.ctx.setting<{ days: number | null }>("pref:recycling", {
        days: null,
      }).days;

      const passes: Array<[string, ReadonlyArray<SqlValue>]> = [
        ["disposition = 'trash' AND disposition_at < ?", [now - RETENTION.trashMs]],
        ["disposition = 'spam' AND disposition_at < ?", [now - RETENTION.spamMs]],
        ["disposition = 'screened-out' AND disposition_at < ?", [now - RETENTION.screenedOutMs]],
      ];

      if (recycleDays)
        passes.push([
          `disposition = 'active' AND reply_later = 0 AND set_aside = 0 AND bubble_tag = 'None' AND last_activity_at < ?
           AND thread_id NOT IN (SELECT thread_id FROM thread_labels) AND thread_id NOT IN (SELECT thread_id FROM collection_items)
           AND thread_id NOT IN (SELECT thread_id FROM notes WHERE thread_id IS NOT NULL)`,
          [now - recycleDays * 24 * 3600 * 1000],
        ]);
      let deleted = 0;
      let more = false;

      for (const [where, args] of passes) {
        const budget = RETENTION_BATCH - deleted;

        if (budget <= 0) {
          more = true;
          break;
        }

        const r = this.purge(where, args, budget);
        deleted += r.deleted;

        if (r.more) more = true;
      }

      if (more) this.ctx.kernel.schedule("retention-sweep", "sweep", this.ctx.now(), {});

      return { deleted, more };
    });
  }

  private purge(
    where: string,
    args: ReadonlyArray<SqlValue>,
    limit: number = RETENTION_BATCH,
  ): PurgeResult {
    const found = this.sql.all<{ thread_id: string }>(
      `SELECT thread_id FROM threads WHERE merged_into IS NULL AND ${where} ORDER BY thread_id LIMIT ?`,
      ...args,
      limit + 1,
    );

    const threads = found.slice(0, limit);

    for (const { thread_id } of threads) {
      for (const d of this.sql.all<{ delivery_id: string; message_key: string }>(
        "SELECT delivery_id, message_key FROM deliveries WHERE thread_id = ?",
        thread_id,
      )) {
        this.ctx.indexDelete("delivery", d.delivery_id);
        this.ctx.kernel.emit("blob-gc", this.ctx.mailboxId, {
          key: d.message_key,
          reason: "retention",
        });
      }

      this.sql.run("DELETE FROM attachments WHERE thread_id = ?", thread_id);
      this.sql.run("DELETE FROM deliveries WHERE thread_id = ?", thread_id);
      this.sql.run("DELETE FROM thread_labels WHERE thread_id = ?", thread_id);
      this.sql.run(
        "DELETE FROM threads WHERE thread_id = ? OR merged_into = ?",
        thread_id,
        thread_id,
      );
      this.ctx.change("thread", "deleted", { threadId: thread_id });
    }

    return { deleted: threads.length, more: found.length > limit };
  }

  /** Page through every delivery (all dispositions) in stable order; never silently capped. */
  exportManifestPage(cursor: string | null, limit = 500): ExportManifestPageResult {
    const size = Math.min(Math.max(limit, 1), 1000);
    const c = cursor ? decodeCursor<{ r: number; id: string }>(cursor) : undefined;

    const rows = this.sql.all<{
      delivery_id: string;
      thread_id: string;
      message_key: string;
      date: number;
      from_address: string;
      direction: "in" | "out";
      received_at: number;
    }>(
      `SELECT delivery_id, thread_id, message_key, date, from_address, direction, received_at FROM deliveries
       ${c ? "WHERE (received_at > ? OR (received_at = ? AND delivery_id > ?))" : ""} ORDER BY received_at, delivery_id LIMIT ?`,
      ...(c ? [c.r, c.r, c.id] : []),
      size + 1,
    );

    const page = rows.slice(0, size);
    const last = page.at(-1);

    return {
      deliveries: page.map((r) => ({
        deliveryId: r.delivery_id,
        threadId: r.thread_id,
        messageKey: r.message_key,
        date: Number(r.date),
        from: r.from_address,
        direction: r.direction,
      })),
      nextCursor:
        rows.length > size && last
          ? encodeCursor({ r: Number(last.received_at), id: last.delivery_id })
          : null,
    };
  }
}
