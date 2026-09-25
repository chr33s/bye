import { normalizeAddress } from "@bye/domain";
import { parseSearchQuery, type SearchQuery } from "../search/query.ts";
import type { SearchDocument } from "../search/shard.ts";
import type { MailboxContext } from "./context.ts";
import type { MailboxOrganizer } from "./organize.ts";
import { isServableUpload, type ThreadRow } from "./rows.ts";
import type { ThreadLedger } from "./threads.ts";
import type { MailboxUploads } from "./uploads.ts";
import type { MailboxDelivery, MailboxSearchHit } from "./types.ts";
import { isMailView, type MailboxViews } from "./views.ts";

// Search catalog (§8): shard placement and rollover, the indexing watermark, and one registry
// that says, per indexed kind, how to build its document and whether a hit may be shown now. A
// stale index can omit results but never reveal them: every hit is re-authorized here.

interface SearchKind {
  /** Message key whose normalized body text the host adds to the document, if any. */
  readonly bodySource?: (id: string) => string | undefined;
  /** The index document from authoritative state; null deletes it from the index. */
  readonly doc: (
    id: string,
    version: number,
    bodyText: string | undefined,
  ) => SearchDocument | null;
  /** The hit if it may be shown for this query now; null drops it. */
  readonly visible: (id: string, q: SearchQuery) => MailboxSearchHit | null;
}

export class MailboxSearch {
  private readonly kinds: Readonly<Record<string, SearchKind>>;

  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
    private readonly views: MailboxViews,
    organize: MailboxOrganizer,
    uploads: MailboxUploads,
  ) {
    const activeThread = (threadId: string) =>
      this.ledger.row(this.ledger.resolve(threadId))?.disposition === "active";
    this.kinds = {
      delivery: {
        bodySource: (id) => this.views.delivery(id)?.messageKey,
        doc: (id, version, bodyText) => {
          const d = this.views.delivery(id);
          if (!d) return null;
          const t = this.views.thread(this.ledger.require(d.threadId));
          return {
            docId: `delivery:${id}`,
            kind: "delivery",
            refId: id,
            version,
            threadId: d.threadId,
            date: d.date,
            from: d.from.address,
            to: [...d.to, ...d.cc].map((a) => a.address),
            subject: t.subject,
            body: bodyText ?? d.snippet,
            attachments: d.attachments.map((a) => `${a.filename} ${a.contentType}`),
            labels: t.labels,
            view: t.disposition === "active" ? t.destination : t.disposition,
          };
        },
        visible: (id, q) => {
          const d = this.views.delivery(id);
          if (!d) return null;
          const t = this.ledger.row(this.ledger.resolve(d.threadId));
          return t && this.threadMatchesQuery(t, d, q, organize)
            ? {
                kind: "delivery",
                id: d.deliveryId,
                threadId: t.thread_id,
                date: d.date,
                snippet: d.snippet,
              }
            : null;
        },
      },
      note: {
        doc: (id, version) => {
          const n = organize.note(id);
          return n
            ? {
                docId: `note:${id}`,
                kind: "note",
                refId: id,
                version,
                threadId: n.threadId ?? undefined,
                date: n.updatedAt,
                body: n.body,
                view: "notes",
              }
            : null;
        },
        visible: (id) => {
          const n = organize.note(id);
          const inTrash = n?.threadId
            ? this.ledger.row(this.ledger.resolve(n.threadId))?.disposition === "trash"
            : false;
          return n && !inTrash
            ? {
                kind: "note",
                id,
                threadId: n.threadId,
                date: n.updatedAt,
                snippet: n.body.slice(0, 200),
              }
            : null;
        },
      },
      contact: {
        doc: (id, version) => {
          const c = organize.contact(id);
          return c
            ? {
                docId: `contact:${id}`,
                kind: "contact",
                refId: id,
                version,
                date: 0,
                subject: c.name,
                participants: [...c.emails],
                body: c.notes,
                view: "contacts",
              }
            : null;
        },
        visible: (id) => {
          const k = organize.contact(id);
          return k
            ? {
                kind: "contact",
                id,
                threadId: null,
                date: 0,
                snippet: `${k.name} <${k.emails[0] ?? ""}>`,
              }
            : null;
        },
      },
      clip: {
        doc: (id, version) => {
          const c = organize.clip(id);
          return c
            ? {
                docId: `clip:${id}`,
                kind: "clip",
                refId: id,
                version,
                threadId: c.threadId,
                date: c.createdAt,
                body: c.text,
                view: "clips",
              }
            : null;
        },
        visible: (id) => {
          const c = organize.clip(id);
          return c && activeThread(c.threadId)
            ? {
                kind: "clip",
                id,
                threadId: c.threadId,
                date: c.createdAt,
                snippet: c.text.slice(0, 200),
              }
            : null;
        },
      },
      upload: {
        doc: (id, version) => {
          const u = uploads.upload(id);
          return u && isServableUpload(u)
            ? {
                docId: `upload:${id}`,
                kind: "upload",
                refId: id,
                version,
                date: 0,
                subject: u.filename,
                attachments: [`${u.filename} ${u.contentType}`],
                view: "files",
              }
            : null;
        },
        visible: (id) => {
          const u = uploads.upload(id);
          return u && isServableUpload(u)
            ? {
                kind: "upload",
                id,
                threadId: null,
                date: 0,
                snippet: `${u.filename} (${u.contentType})`,
              }
            : null;
        },
      },
      label: {
        doc: (id, version) => {
          const l = organize.label(id);
          return l
            ? {
                docId: `label:${id}`,
                kind: "label",
                refId: id,
                version,
                date: 0,
                subject: l.name,
                view: "labels",
              }
            : null;
        },
        visible: (id) => {
          const l = organize.label(id);
          return l ? { kind: "label", id, threadId: null, date: 0, snippet: l.name } : null;
        },
      },
    };
  }

  private get sql() {
    return this.ctx.sql;
  }

  // ---------------------------------------------------------------- documents and hits

  /** Message key whose normalized body belongs in `kind:id`'s document, if it has one. */
  bodySource(kind: string, id: string): string | undefined {
    return this.kinds[kind]?.bodySource?.(id);
  }

  /** Index document from authoritative state; null means "delete from the index". */
  searchDocument(kind: string, id: string, bodyText?: string): SearchDocument | null {
    return this.kinds[kind]?.doc(id, this.ctx.kernel.currentSeq(), bodyText) ?? null;
  }

  /**
   * Rehydrate and re-authorize candidates against current state (§8): anything deleted, moved out
   * of the query's scope (e.g. trashed without `in:trash`), or no longer matching its filters is
   * dropped. Mail-only filters (scope, from/to/label/attachment) exclude non-mail kinds.
   */
  searchHits(
    candidates: ReadonlyArray<{ readonly kind: string; readonly refId: string }>,
    query: string,
  ): ReadonlyArray<MailboxSearchHit> {
    const q = parseSearchQuery(query);
    const mailFiltered =
      q.scope === "trash" ||
      q.scope === "spam" ||
      q.from.length > 0 ||
      q.to.length > 0 ||
      q.labels.length > 0 ||
      q.hasAttachment !== undefined;
    const out: Array<MailboxSearchHit> = [];
    for (const c of candidates) {
      if (c.kind !== "delivery" && mailFiltered) continue;
      const hit = this.kinds[c.kind]?.visible(c.refId, q);
      if (hit) out.push(hit);
    }
    return out;
  }

  private threadMatchesQuery(
    t: ThreadRow,
    d: MailboxDelivery,
    q: SearchQuery,
    organize: MailboxOrganizer,
  ): boolean {
    if (q.scope === "trash" && t.disposition !== "trash") return false;
    if (q.scope === "spam" && t.disposition !== "spam") return false;
    if (q.scope === "mail" && t.disposition !== "active" && t.disposition !== "screening")
      return false;
    if (t.quarantined === 1 && q.scope !== "spam" && q.scope !== "everything-including-trash")
      return false;
    // `in:<view>` means exactly what the view shows: the same SQL filter the view pages over.
    if (q.view && isMailView(q.view) && !this.views.inView(t.thread_id, q.view)) return false;
    const labels = organize.threadLabels(t.thread_id).map((l) => l.toLowerCase());
    for (const l of q.labels) if (!labels.includes(l.toLowerCase())) return false;
    const from = normalizeAddress(d.from.address);
    for (const f of q.from)
      if (!(f.includes("@") ? from === f : from.endsWith(`@${f}`) || from.includes(f)))
        return false;
    const to = [...d.to, ...d.cc].map((a) => normalizeAddress(a.address));
    for (const x of q.to)
      if (!to.some((a) => (x.includes("@") ? a === x : a.includes(x)))) return false;
    if (q.hasAttachment !== undefined && d.attachments.length > 0 !== q.hasAttachment) return false;
    if (q.before !== undefined && d.date >= q.before) return false;
    if (q.after !== undefined && d.date < q.after) return false;
    return true;
  }

  // ---------------------------------------------------------------- shards and placement

  /** Search shard catalog for this mailbox; the first shard keeps the legacy per-mailbox name. */
  searchShards(): ReadonlyArray<{
    readonly name: string;
    readonly fromDate: number;
    readonly sealed: boolean;
    readonly storedBytes: number;
  }> {
    if (!this.sql.one("SELECT 1 AS x FROM search_shards LIMIT 1")) {
      this.sql.run(
        "INSERT OR IGNORE INTO search_shards (name, from_date, created_at) VALUES (?, 0, ?)",
        `search:${this.ctx.mailboxId}`,
        this.ctx.now(),
      );
    }
    return this.sql
      .all<{ name: string; from_date: number; sealed_at: number | null; stored_bytes: number }>(
        "SELECT name, from_date, sealed_at, stored_bytes FROM search_shards ORDER BY from_date",
      )
      .map((r) => ({
        name: r.name,
        fromDate: Number(r.from_date),
        sealed: r.sealed_at !== null,
        storedBytes: Number(r.stored_bytes),
      }));
  }

  /**
   * Stable placement: a document stays in the shard it was first written to (so updates and
   * deletes find it); new documents go to the shard whose date range covers them.
   */
  searchPlacement(docKey: string, date: number): string {
    const existing = this.existingPlacement(docKey);
    if (existing) return existing;
    const shards = this.searchShards();
    const shard = [...shards].reverse().find((x) => x.fromDate <= date)?.name ?? shards[0]!.name;
    this.sql.run(
      "INSERT OR IGNORE INTO search_placement (doc_key, shard) VALUES (?, ?)",
      docKey,
      shard,
    );
    return shard;
  }

  existingPlacement(docKey: string): string | undefined {
    return this.sql.one<{ shard: string }>(
      "SELECT shard FROM search_placement WHERE doc_key = ?",
      docKey,
    )?.shard;
  }

  /** Record a shard's size (§12: alert at 50%, split before 70%); may open a new shard. */
  recordShardHealth(
    name: string,
    storedBytes: number,
    rollover: boolean,
  ): { readonly opened: string | null } {
    return this.sql.tx(() => {
      this.sql.run("UPDATE search_shards SET stored_bytes = ? WHERE name = ?", storedBytes, name);
      const newest = this.searchShards().at(-1);
      if (!rollover || !newest || newest.name !== name) return { opened: null };
      const now = this.ctx.now();
      const opened = `search:${this.ctx.mailboxId}:${now}`;
      this.sql.run("UPDATE search_shards SET sealed_at = ? WHERE name = ?", now, name);
      this.sql.run(
        "INSERT INTO search_shards (name, from_date, created_at) VALUES (?, ?, ?)",
        opened,
        now,
        now,
      );
      this.ctx.change("search", "shard-opened", { name: opened });
      return { opened };
    });
  }

  // ---------------------------------------------------------------- watermark

  /** The indexer acknowledges a processed document at the source sequence it observed. */
  ackIndexed(docKey: string, seq: number): void {
    this.sql.run("DELETE FROM index_pending WHERE doc_key = ? AND emitted_seq <= ?", docKey, seq);
  }

  /** Honest indexing watermark: everything at or below it is reflected in search. */
  indexWatermark(): {
    readonly watermark: number;
    readonly lagging: boolean;
    readonly pending: number;
  } {
    const r = this.sql.one<{ n: number; m: number | null }>(
      "SELECT COUNT(*) AS n, MIN(emitted_seq) AS m FROM index_pending",
    );
    const pending = Number(r?.n ?? 0);
    return {
      watermark: pending > 0 ? Math.max(0, Number(r?.m ?? 0)) : this.ctx.kernel.currentSeq(),
      lagging: pending > 0,
      pending,
    };
  }

  /** Re-emit index events that stayed unacknowledged across a reconcile (lost/dead-lettered). */
  replayPendingIndex(limit = 200): number {
    const since = this.ctx.setting<number>("index:lastReconcileSeq", 0);
    const stale = this.sql.all<{ doc_key: string }>(
      "SELECT doc_key FROM index_pending WHERE emitted_seq <= ? LIMIT ?",
      since,
      limit,
    );
    for (const r of stale) {
      const i = r.doc_key.indexOf(":");
      this.ctx.kernel.outbox("index", this.ctx.mailboxId, {
        op: "upsert",
        kind: r.doc_key.slice(0, i),
        id: r.doc_key.slice(i + 1),
      });
    }
    this.ctx.putSetting("index:lastReconcileSeq", this.ctx.kernel.currentSeq());
    return stale.length;
  }
}
