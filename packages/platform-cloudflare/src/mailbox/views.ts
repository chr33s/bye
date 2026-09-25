import type { MailView } from "@bye/domain";
import { json, type SqlValue } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import type { MailboxOrganizer } from "./organize.ts";
import {
  type AttachmentRow,
  decodeCursor,
  type DeliveryRow,
  encodeCursor,
  groupBy,
  allInChunks,
  placeholders,
  type ThreadRow,
  toDelivery,
  toThread,
} from "./rows.ts";
import type { ThreadLedger } from "./threads.ts";
import type { MailboxDelivery, MailboxThread, MailboxViewPage, MailboxViewQuery } from "./types.ts";

// Views, thread reads, and seen/visit state (E04–E07, E10, E24, §8 pagination).

export interface ViewFilter {
  readonly where: string;
  readonly args: ReadonlyArray<SqlValue>;
  readonly order: "activity" | "reply_later" | "set_aside" | "bubble";
  readonly bundles: boolean;
}

const MAIL_VIEW_NAMES: ReadonlySet<string> = new Set<MailView>([
  "imbox",
  "feed",
  "paper-trail",
  "screener",
  "reply-later",
  "set-aside",
  "bubble-up",
  "screened-out",
  "spam",
  "trash",
  "everything",
]);

export const isMailView = (v: string): v is MailView => MAIL_VIEW_NAMES.has(v);

export class MailboxViews {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
    private readonly organize: MailboxOrganizer,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ---------------------------------------------------------------- mapping

  /** Map thread rows to public threads with their labels loaded in one query. */
  threads(rows: ReadonlyArray<ThreadRow>, previousVisit = 0): Array<MailboxThread> {
    const labels = this.organize.labelsOf(rows.map((r) => r.thread_id));
    return rows.map((r) => toThread(r, labels.get(r.thread_id) ?? [], previousVisit));
  }

  thread(row: ThreadRow): MailboxThread {
    return this.threads([row])[0]!;
  }

  /** Map delivery rows with their attachments loaded in one query. */
  deliveries(rows: ReadonlyArray<DeliveryRow>): Array<MailboxDelivery> {
    if (rows.length === 0) return [];
    const byDelivery = groupBy(
      allInChunks(
        rows.map((d) => d.delivery_id),
        (ids) =>
          this.sql.all<AttachmentRow>(
            `SELECT * FROM attachments WHERE delivery_id IN (${placeholders(ids.length)}) ORDER BY rowid`,
            ...ids,
          ),
      ),
      (a) => a.delivery_id,
    );
    return rows.map((d) => toDelivery(d, byDelivery.get(d.delivery_id) ?? []));
  }

  // ---------------------------------------------------------------- filters

  /**
   * The one definition of view membership. Views page over it and search re-authorizes against
   * it (`in:<view>`), so both always agree.
   */
  viewFilter(q: Pick<MailboxViewQuery, "view" | "label">): ViewFilter {
    const base = "merged_into IS NULL";
    switch (q.view) {
      case "imbox":
        return {
          where: `${base} AND disposition = 'active' AND destination = 'imbox' AND (new_for_you = 1 OR (reply_later = 0 AND set_aside = 0 AND bubble_tag <> 'Scheduled'))`,
          args: [],
          order: "activity",
          bundles: true,
        };
      case "feed":
      case "paper-trail":
        return {
          where: `${base} AND disposition = 'active' AND destination = ?`,
          args: [q.view],
          order: "activity",
          bundles: true,
        };
      case "screener":
        return {
          where: `${base} AND disposition = 'screening'`,
          args: [],
          order: "activity",
          bundles: false,
        };
      case "reply-later":
        return {
          where: `${base} AND disposition = 'active' AND reply_later = 1`,
          args: [],
          order: "reply_later",
          bundles: false,
        };
      case "set-aside":
        return {
          where: `${base} AND disposition = 'active' AND set_aside = 1`,
          args: [],
          order: "set_aside",
          bundles: false,
        };
      case "bubble-up":
        return {
          where: `${base} AND disposition = 'active' AND bubble_tag <> 'None'`,
          args: [],
          order: "bubble",
          bundles: false,
        };
      case "screened-out":
      case "spam":
      case "trash":
        return {
          where: `${base} AND disposition = ?`,
          args: [q.view],
          order: "activity",
          bundles: false,
        };
      case "everything":
        return {
          where: `${base} AND disposition = 'active'`,
          args: [],
          order: "activity",
          bundles: false,
        };
      case "label": {
        const labelId = this.organize.labelId(q.label ?? "") ?? reject("not_found", "label");
        return {
          where: `${base} AND disposition = 'active' AND thread_id IN (SELECT thread_id FROM thread_labels WHERE label_id = ?)`,
          args: [labelId],
          order: "activity",
          bundles: false,
        };
      }
    }
  }

  /** Whether a (resolved) thread currently belongs to a view. */
  inView(threadId: string, view: MailView): boolean {
    const f = this.viewFilter({ view });
    return (
      this.sql.one(
        `SELECT 1 AS x FROM threads WHERE thread_id = ? AND ${f.where}`,
        threadId,
        ...f.args,
      ) !== undefined
    );
  }

  // ---------------------------------------------------------------- pages

  listView(query: MailboxViewQuery): MailboxViewPage {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const cursor = decodeCursor<{ k: number; id: string; b: number }>(query.cursor);
    const boundary = cursor?.b ?? this.ctx.kernel.currentSeq();
    const f = this.viewFilter(query);
    const sortCol =
      f.order === "reply_later"
        ? "reply_later_at"
        : f.order === "set_aside"
          ? "set_aside_at"
          : f.order === "bubble"
            ? "COALESCE(bubble_at, 0)"
            : "last_activity_at";
    const ascending = f.order !== "activity";
    const grouped = f.bundles
      ? `SELECT *, MAX(${sortCol}) AS k, COUNT(*) AS bundle_count FROM (SELECT * FROM threads WHERE ${f.where} AND activity_seq <= ?) GROUP BY COALESCE(bundle_key, thread_id)`
      : `SELECT *, ${sortCol} AS k, 1 AS bundle_count FROM threads WHERE ${f.where} AND activity_seq <= ?`;
    const cmp = ascending ? ">" : "<";
    const dir = ascending ? "ASC" : "DESC";
    const rows = this.sql.all<ThreadRow & { k: number; bundle_count: number }>(
      `SELECT * FROM (${grouped}) ${cursor ? `WHERE (k ${cmp} ? OR (k = ? AND thread_id ${cmp} ?))` : ""} ORDER BY k ${dir}, thread_id ${dir} LIMIT ?`,
      ...f.args,
      boundary,
      ...(cursor ? [cursor.k, cursor.k, cursor.id] : []),
      limit + 1,
    );
    const previousVisit = this.visitMarker(query.view);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const changed = cursor
      ? this.threads(
          this.sql.all<ThreadRow>(
            `SELECT * FROM threads WHERE ${f.where} AND activity_seq > ? ORDER BY last_activity_at DESC LIMIT 50`,
            ...f.args,
            boundary,
          ),
          previousVisit,
        )
      : [];
    return {
      view: query.view,
      items: this.threads(page, previousVisit),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ k: Number(last.k), id: last.thread_id, b: boundary })
          : null,
      boundary,
      changedSinceBoundary: changed,
      order: {
        ascending,
        keys: page.map((r) => Number(r.k)),
        cursors: page.map((r) => encodeCursor({ k: Number(r.k), id: r.thread_id, b: boundary })),
      },
      position: this.viewPosition(
        query.view === "label" ? `label:${query.label ?? ""}` : query.view,
      ),
      previousVisitAt: previousVisit,
    };
  }

  /** Imbox split into New For You and Previously Seen (E04); Bubble Up pins lead. */
  imbox(limit = 50): {
    readonly bubbledUp: ReadonlyArray<MailboxThread>;
    readonly newForYou: ReadonlyArray<MailboxThread>;
    readonly previouslySeen: ReadonlyArray<MailboxThread>;
    readonly boundary: number;
  } {
    const page = this.listView({ view: "imbox", limit });
    return {
      bubbledUp: page.items.filter((t) => t.attention.bubble._tag === "Pinned"),
      newForYou: page.items.filter((t) => t.newForYou && t.attention.bubble._tag !== "Pinned"),
      previouslySeen: page.items.filter(
        (t) => !t.newForYou && t.attention.bubble._tag !== "Pinned",
      ),
      boundary: page.boundary,
    };
  }

  bundle(bundleKey: string): ReadonlyArray<MailboxThread> {
    return this.threads(
      this.sql.all<ThreadRow>(
        "SELECT * FROM threads WHERE bundle_key = ? AND merged_into IS NULL AND disposition = 'active' ORDER BY last_activity_at DESC",
        bundleKey,
      ),
    );
  }

  getThread(threadId: string): {
    readonly thread: MailboxThread;
    readonly deliveries: ReadonlyArray<MailboxDelivery>;
    readonly mergeHistory: ReturnType<MailboxViews["mergeHistory"]>;
  } {
    const row = this.ledger.require(threadId);
    return {
      thread: this.thread(row),
      deliveries: this.deliveriesOf(row.thread_id),
      mergeHistory: this.mergeHistory(row.thread_id),
    };
  }

  deliveriesOf(threadId: string): ReadonlyArray<MailboxDelivery> {
    return this.deliveries(
      this.sql.all<DeliveryRow>(
        "SELECT * FROM deliveries WHERE thread_id = ? ORDER BY date, delivery_id",
        threadId,
      ),
    );
  }

  delivery(deliveryId: string): MailboxDelivery | undefined {
    const d = this.sql.one<DeliveryRow>(
      "SELECT * FROM deliveries WHERE delivery_id = ?",
      deliveryId,
    );
    return d ? this.deliveries([d])[0] : undefined;
  }

  mergeHistory(threadId: string): ReadonlyArray<{
    readonly mergeId: string;
    readonly sources: ReadonlyArray<string>;
    readonly at: number;
    readonly undone: boolean;
  }> {
    return this.sql
      .all<{ merge_id: string; source_threads: string; at: number; undone_at: number | null }>(
        "SELECT * FROM merges WHERE target_thread = ? ORDER BY at",
        this.ledger.resolve(threadId),
      )
      .map((m) => ({
        mergeId: m.merge_id,
        sources: json<Array<string>>(m.source_threads, []),
        at: Number(m.at),
        undone: m.undone_at !== null,
      }));
  }

  /** Focus & Reply: sequential queue of Reply Later threads with their latest delivery (E07). */
  focusQueue(): ReadonlyArray<{
    readonly thread: MailboxThread;
    readonly latest: MailboxDelivery | undefined;
  }> {
    return this.listView({ view: "reply-later", limit: 200 }).items.map((thread) => ({
      thread,
      latest: this.deliveriesOf(thread.threadId).at(-1),
    }));
  }

  // ---------------------------------------------------------------- Read Together (E10)

  /** A fixed snapshot order that new arrivals don't reorder. */
  createBatch(threadIds: ReadonlyArray<string> | "new-for-you"): {
    readonly batchId: string;
    readonly threadIds: ReadonlyArray<string>;
  } {
    const ids =
      threadIds === "new-for-you"
        ? this.listView({ view: "imbox", limit: 200 })
            .items.filter((t) => t.newForYou)
            .map((t) => t.threadId)
        : threadIds.map((id) => this.ledger.require(id).thread_id);
    const batchId = this.ctx.id("bat");
    this.sql.run(
      "INSERT INTO batches (batch_id, thread_ids, created_at) VALUES (?, ?, ?)",
      batchId,
      JSON.stringify(ids),
      this.ctx.now(),
    );
    return { batchId, threadIds: ids };
  }

  batch(batchId: string): ReadonlyArray<{
    readonly thread: MailboxThread;
    readonly deliveries: ReadonlyArray<MailboxDelivery>;
  }> {
    const row =
      this.sql.one<{ thread_ids: string }>(
        "SELECT thread_ids FROM batches WHERE batch_id = ?",
        batchId,
      ) ?? reject("not_found", "batch");
    return json<Array<string>>(row.thread_ids, []).flatMap((id) => {
      const t = this.ledger.row(this.ledger.resolve(id));
      return t ? [{ thread: this.thread(t), deliveries: this.deliveriesOf(t.thread_id) }] : [];
    });
  }

  // ---------------------------------------------------------------- visits and positions (E05/E06)

  /** Record a view visit; returns the prior marker used for new-since-last-visit. */
  visitView(view: string, position?: string): { readonly previousVisitAt: number } {
    const prior = this.sql.one<{ last_visit_at: number }>(
      "SELECT last_visit_at FROM view_positions WHERE view = ?",
      view,
    );
    const previousVisitAt = Number(prior?.last_visit_at ?? 0);
    this.sql.run(
      `INSERT INTO view_positions (view, position, last_visit_at, previous_visit_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (view) DO UPDATE SET previous_visit_at = view_positions.last_visit_at, last_visit_at = excluded.last_visit_at,
         position = COALESCE(excluded.position, view_positions.position)`,
      view,
      position ?? null,
      this.ctx.now(),
      previousVisitAt,
    );
    return { previousVisitAt };
  }

  setViewPosition(view: string, position: string): void {
    this.sql.run(
      `INSERT INTO view_positions (view, position) VALUES (?, ?) ON CONFLICT (view) DO UPDATE SET position = excluded.position`,
      view,
      position,
    );
  }

  viewPosition(view: string): string | null {
    return (
      this.sql.one<{ position: string | null }>(
        "SELECT position FROM view_positions WHERE view = ?",
        view,
      )?.position ?? null
    );
  }

  private visitMarker(view: string): number {
    if (view !== "feed" && view !== "paper-trail") return 0;
    return Number(
      this.sql.one<{ previous_visit_at: number }>(
        "SELECT previous_visit_at FROM view_positions WHERE view = ?",
        view,
      )?.previous_visit_at ?? 0,
    );
  }

  // ---------------------------------------------------------------- seen state (E04)

  /** Mark seen up to the observed revision only; a concurrently arriving reply stays new. */
  markSeen(threadId: string, observedRevision: number): { readonly newForYou: boolean } {
    const t = this.ledger.require(threadId);
    const seen = Math.max(Number(t.seen_revision), Math.min(observedRevision, Number(t.revision)));
    const stillNew = Number(t.revision) > seen && t.disposition === "active" && t.unfollowed !== 1;
    this.sql.run(
      "UPDATE threads SET seen_revision = ?, new_for_you = ? WHERE thread_id = ?",
      seen,
      stillNew,
      t.thread_id,
    );
    this.ctx.change("thread", "seen", { threadId: t.thread_id });
    return { newForYou: stillNew };
  }

  markUnseen(threadId: string): void {
    const t = this.ledger.require(threadId);
    this.sql.run(
      "UPDATE threads SET new_for_you = 1, seen_revision = MIN(seen_revision, revision - 1) WHERE thread_id = ?",
      t.thread_id,
    );
    this.ctx.change("thread", "unseen", { threadId: t.thread_id });
  }

  /** Bulk mark-seen over a bounded snapshot; arrivals after `boundary` are not swept in. */
  markAllSeen(
    view: MailView | "label",
    boundary: number,
    label?: string,
  ): { readonly marked: number } {
    if (view === "label" && !label) reject("bad_request", "label required");
    const f = this.viewFilter(view === "label" ? { view, label: label! } : { view });
    const marked = this.sql.run(
      `UPDATE threads SET seen_revision = revision, new_for_you = 0 WHERE ${f.where} AND activity_seq <= ? AND new_for_you = 1`,
      ...f.args,
      boundary,
    );
    this.ctx.change("view", "seen", { view, label: label ?? null, boundary });
    return { marked };
  }
}
