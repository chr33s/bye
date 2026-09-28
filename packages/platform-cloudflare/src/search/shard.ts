import { Option, Predicate, Schema } from "effect";
import { reject } from "../durable/rpc.ts";
import {
  migrate,
  type Migration,
  placeholders,
  Sql,
  type SqlValue,
  type TransactionalStorage,
} from "../durable/sql.ts";
import {
  CJK,
  ftsLiteral,
  hasWordChars,
  parseSearchQuery,
  type SearchClause,
  type SearchQuery,
} from "./query.ts";

// SQLite FTS5 search shard (§8): a rebuildable lexical index partitioned by privacy scope.
// Raw MIME and attachment binaries are never indexed; long text is chunked below row limits.

export const SEARCH_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "search",
    statements: [
      `CREATE TABLE search_docs (
        doc_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        tombstone INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT,
        date INTEGER NOT NULL,
        from_addr TEXT NOT NULL DEFAULT '',
        to_addrs TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        view TEXT NOT NULL DEFAULT '',
        has_attachment INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX search_docs_date ON search_docs (tombstone, date)",
      `CREATE VIRTUAL TABLE search_fts USING fts5(doc_id UNINDEXED, subject, participants, body, attachments, tokenize = 'unicode61 remove_diacritics 2')`,
      `CREATE VIRTUAL TABLE search_trigram USING fts5(doc_id UNINDEXED, text, tokenize = 'trigram')`,
      `CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ],
  },
];

export const SEARCH_CHUNK_CHARS = 16 * 1024;

export const SEARCH_MAX_BODY_CHARS = 512 * 1024;

export interface SearchDocument {
  readonly docId: string;
  readonly kind: "delivery" | "note" | "clip" | "contact" | "event" | (string & {});
  readonly refId: string;
  /** Monotonic source version; older events never overwrite newer ones (late index events). */
  readonly version: number;
  readonly threadId?: string;
  readonly date: number;
  readonly from?: string;
  readonly to?: ReadonlyArray<string>;
  readonly participants?: ReadonlyArray<string>;
  readonly subject?: string;
  readonly body?: string;
  readonly attachments?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<string>;
  /** Presentation bucket: imbox/feed/paper-trail/screener/trash/spam/... */
  readonly view?: string;
}

export interface SearchCandidate {
  readonly docId: string;
  readonly kind: string;
  readonly refId: string;
  readonly threadId: string | null;
  readonly date: number;
  readonly version: number;
}

export interface SearchPage {
  readonly candidates: ReadonlyArray<SearchCandidate>;
  readonly nextCursor: string | null;
  /** Latest source sequence reflected in this shard; clients show lag when behind. */
  readonly watermark: number;
}

type ClauseSubqueryResult = {
  readonly sql: string;
  readonly args: ReadonlyArray<SqlValue>;
};

export class SearchShard {
  readonly sql: Sql;

  constructor(storage: TransactionalStorage) {
    this.sql = new Sql(storage);
    migrate(this.sql, "search", SEARCH_MIGRATIONS);
  }

  upsert(doc: SearchDocument): "indexed" | "stale" {
    return this.sql.tx(() => {
      const existing = this.sql.one<{ version: number }>(
        "SELECT version FROM search_docs WHERE doc_id = ?",
        doc.docId,
      );

      if (existing && Number(existing.version) >= doc.version) return "stale";
      this.deleteRows(doc.docId);
      const body = (doc.body ?? "").slice(0, SEARCH_MAX_BODY_CHARS);

      const participants = [doc.from ?? "", ...(doc.to ?? []), ...(doc.participants ?? [])]
        .filter(Boolean)
        .join(" ");

      const attachments = (doc.attachments ?? []).join(" ");
      const chunks = chunk(body);
      chunks.forEach((c, i) => {
        this.sql.run(
          "INSERT INTO search_fts (doc_id, subject, participants, body, attachments) VALUES (?, ?, ?, ?, ?)",
          doc.docId,
          i === 0 ? (doc.subject ?? "") : "",
          i === 0 ? participants : "",
          c,
          i === 0 ? attachments : "",
        );
        this.sql.run(
          "INSERT INTO search_trigram (doc_id, text) VALUES (?, ?)",
          doc.docId,
          i === 0 ? `${doc.subject ?? ""}\n${participants}\n${attachments}\n${c}` : c,
        );
      });
      this.sql.run(
        `INSERT INTO search_docs (doc_id, kind, ref_id, version, tombstone, thread_id, date, from_addr, to_addrs, labels, view, has_attachment, bytes)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, version = excluded.version, tombstone = 0,
           thread_id = excluded.thread_id, date = excluded.date, from_addr = excluded.from_addr, to_addrs = excluded.to_addrs,
           labels = excluded.labels, view = excluded.view, has_attachment = excluded.has_attachment, bytes = excluded.bytes`,
        doc.docId,
        doc.kind,
        doc.refId,
        doc.version,
        doc.threadId ?? null,
        doc.date,
        (doc.from ?? "").toLowerCase(),
        ` ${(doc.to ?? []).map((t) => t.toLowerCase()).join(" ")} `,
        JSON.stringify(doc.labels ?? []),
        doc.view ?? "",
        (doc.attachments?.length ?? 0) > 0,
        body.length + (doc.subject?.length ?? 0) + participants.length,
      );

      return "indexed";
    });
  }

  /** Tombstone: a replayed older upsert cannot resurrect a deleted document. */
  remove(docId: string, version: number): "removed" | "stale" {
    return this.sql.tx(() => {
      const existing = this.sql.one<{ version: number }>(
        "SELECT version FROM search_docs WHERE doc_id = ?",
        docId,
      );

      if (existing && Number(existing.version) > version) return "stale";
      this.deleteRows(docId);
      this.sql.run(
        `INSERT INTO search_docs (doc_id, kind, ref_id, version, tombstone, date) VALUES (?, 'tombstone', ?, ?, 1, 0)
         ON CONFLICT (doc_id) DO UPDATE SET version = excluded.version, tombstone = 1, bytes = 0`,
        docId,
        docId,
        version,
      );

      return "removed";
    });
  }

  private deleteRows(docId: string): void {
    this.sql.run("DELETE FROM search_fts WHERE doc_id = ?", docId);
    this.sql.run("DELETE FROM search_trigram WHERE doc_id = ?", docId);
  }

  setWatermark(seq: number): void {
    this.sql.run(
      "INSERT INTO search_meta (key, value) VALUES ('watermark', ?) ON CONFLICT (key) DO UPDATE SET value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(search_meta.value AS INTEGER) THEN excluded.value ELSE search_meta.value END",
      String(seq),
    );
  }

  watermark(): number {
    return Number(
      this.sql.one<{ value: string }>("SELECT value FROM search_meta WHERE key = 'watermark'")
        ?.value ?? 0,
    );
  }

  /** Approximate bytes stored, used for rollover decisions. */
  storedBytes(): number {
    return Number(
      this.sql.one<{ n: number | null }>(
        "SELECT SUM(bytes) AS n FROM search_docs WHERE tombstone = 0",
      )?.n ?? 0,
    );
  }

  clear(): void {
    this.sql.tx(() => {
      this.sql.run("DELETE FROM search_fts");
      this.sql.run("DELETE FROM search_trigram");
      this.sql.run("DELETE FROM search_docs");
      this.sql.run("DELETE FROM search_meta");
    });
  }

  /**
   * Candidate lookup only. Candidates carry IDs, never snippets: callers must rehydrate and
   * reauthorize from authoritative state before returning content (see `authorizeSearchResults`).
   */
  candidates(
    input: string | SearchQuery,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): SearchPage {
    const q = Predicate.isString(input) ? parseSearchQuery(input) : input;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    // Every term, filter value and kind binds one parameter; DO SQLite allows 100 per statement.
    const kinds = [...new Set(q.kinds)];
    const terms = q.clauses.length + q.from.length + q.to.length + q.labels.length + kinds.length;

    if (terms > MAX_SEARCH_TERMS)
      reject("bad_request", "search query has too many terms", {
        terms,
        limit: MAX_SEARCH_TERMS,
      });
    const cursor = decodeSearchCursor(options.cursor);
    const where: Array<string> = ["d.tombstone = 0"];
    const args: Array<SqlValue> = [];

    for (const c of q.clauses) {
      const sub = this.clauseSubquery(c);
      where.push(`d.doc_id ${c.negated ? "NOT IN" : "IN"} (${sub.sql})`);
      args.push(...sub.args);
    }

    for (const f of q.from) {
      if (f.includes("@")) {
        where.push("d.from_addr = ?");
        args.push(f);
      } else {
        // Substring match (covers `@domain` suffixes). instr() rather than LIKE: DO SQLite caps
        // LIKE patterns at 50 bytes and these values are user input.
        where.push("instr(lower(d.from_addr), ?) > 0");
        args.push(f.toLowerCase());
      }
    }

    for (const t of q.to) {
      where.push("instr(lower(d.to_addrs), ?) > 0");
      args.push((t.includes("@") ? ` ${t} ` : t).toLowerCase());
    }

    for (const l of q.labels) {
      where.push("instr(lower(d.labels), lower(?)) > 0");
      args.push(JSON.stringify(l));
    }

    if (kinds.length > 0) {
      where.push(`d.kind IN (${placeholders(kinds.length)})`);
      args.push(...kinds);
    }

    if (q.hasAttachment !== undefined) {
      where.push("d.has_attachment = ?");
      args.push(q.hasAttachment ? 1 : 0);
    }

    if (q.before !== undefined) {
      where.push("d.date < ?");
      args.push(q.before);
    }

    if (q.after !== undefined) {
      where.push("d.date >= ?");
      args.push(q.after);
    }

    if (q.scope === "trash" || q.scope === "spam") {
      where.push("d.view = ?");
      args.push(q.scope);
    } else if (q.scope === "mail") {
      where.push("d.view NOT IN ('trash','spam')");
    }

    if (q.view) {
      where.push("d.view = ?");
      args.push(q.view);
    }

    if (cursor) {
      where.push("(d.date < ? OR (d.date = ? AND d.doc_id < ?))");
      args.push(cursor.d, cursor.d, cursor.id);
    }

    const rows = this.sql.all<{
      doc_id: string;
      kind: string;
      ref_id: string;
      thread_id: string | null;
      date: number;
      version: number;
    }>(
      `SELECT d.doc_id, d.kind, d.ref_id, d.thread_id, d.date, d.version FROM search_docs d WHERE ${where.join(" AND ")} ORDER BY d.date DESC, d.doc_id DESC LIMIT ?`,
      ...args,
      limit + 1,
    );

    const page = rows.slice(0, limit).map((r) => ({
      docId: r.doc_id,
      kind: r.kind,
      refId: r.ref_id,
      threadId: r.thread_id,
      date: Number(r.date),
      version: Number(r.version),
    }));

    const last = page.at(-1);

    return {
      candidates: page,
      nextCursor:
        rows.length > limit && last ? btoa(JSON.stringify({ d: last.date, id: last.docId })) : null,
      watermark: this.watermark(),
    };
  }

  private clauseSubquery(c: SearchClause): ClauseSubqueryResult {
    const value = c.value.normalize("NFC");

    if (CJK.test(value)) {
      // unicode61 does not segment CJK; trigram handles substrings of ≥3 chars, LIKE covers shorter ones.
      return Array.from(value).length >= 3
        ? {
            sql: "SELECT doc_id FROM search_trigram WHERE search_trigram MATCH ?",
            args: [ftsLiteral(value)],
          }
        : {
            sql: "SELECT doc_id FROM search_trigram WHERE instr(lower(text), lower(?)) > 0",
            args: [value],
          };
    }

    if (!hasWordChars(value)) {
      // Pure punctuation: a substring scan. instr() has no pattern-length cap, unlike LIKE.
      return {
        sql: "SELECT doc_id FROM search_trigram WHERE instr(lower(text), lower(?)) > 0",
        args: [value],
      };
    }

    // Terms and phrases are both quoted literals; addresses/punctuation become token phrases.
    return {
      sql: "SELECT doc_id FROM search_fts WHERE search_fts MATCH ?",
      args: [ftsLiteral(value)],
    };
  }
}

/**
 * Terms (clauses, from/to/label values, kinds) accepted per query. Each binds one parameter and
 * the fixed filters bind at most ~10 more, keeping every statement under DO SQLite's 100.
 */
export const MAX_SEARCH_TERMS = 64;

const decodeCursorFields = Schema.decodeUnknownOption(
  Schema.Struct({ d: Schema.Finite, id: Schema.String }),
);

/** Opaque page cursor; anything that doesn't decode to `{d, id}` is a client error. */
const decodeSearchCursor = (
  cursor: string | undefined,
): { readonly d: number; readonly id: string } | undefined => {
  if (!cursor) return undefined;
  let parsed: unknown;

  try {
    parsed = JSON.parse(atob(cursor));
  } catch {
    return reject("bad_request", "invalid cursor");
  }

  const c = decodeCursorFields(parsed);

  if (Option.isNone(c)) return reject("bad_request", "invalid cursor");

  return { d: c.value.d, id: c.value.id };
};

const chunk = (text: string): Array<string> => {
  if (text.length <= SEARCH_CHUNK_CHARS) return [text];
  const out: Array<string> = [];

  for (let i = 0; i < text.length; i += SEARCH_CHUNK_CHARS)
    out.push(text.slice(i, i + SEARCH_CHUNK_CHARS));

  return out;
};

export const SEARCH_SHARD_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

type SearchShardHealthResult = {
  readonly alert: boolean;
  readonly rollover: boolean;
  readonly ratio: number;
};

/** Alert at 50% of a shard budget; split/rebuild before 70% (§12). */
export const searchShardHealth = (
  storedBytes: number,
  budget = SEARCH_SHARD_BUDGET_BYTES,
): SearchShardHealthResult => {
  const ratio = storedBytes / budget;

  return { alert: ratio >= 0.5, rollover: ratio >= 0.7, ratio };
};

/** Size-aware period partitioning: scope + time bucket. */
export const searchShardName = (scope: string, date: number, bucketMonths = 12): string => {
  const d = new Date(date);
  const bucket = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / bucketMonths);

  return `${scope}:${bucketMonths}m:${bucket}`;
};

/**
 * Merge candidates from a bounded set of authorized shards using stable date ordering (not
 * shard-local scores), then rehydrate/reauthorize each against current authoritative state.
 * Anything the hydrator rejects (revoked, deleted, stale) is dropped and never revealed.
 */
export const authorizeSearchResults = async <T>(
  pages: ReadonlyArray<SearchPage>,
  hydrate: (candidates: ReadonlyArray<SearchCandidate>) => Promise<ReadonlyArray<T | undefined>>,
  limit: number,
): Promise<{
  readonly results: ReadonlyArray<T>;
  readonly watermark: number;
  /** Last candidate of this page (after de-duplication): the next page's cursor position. */
  readonly last: SearchCandidate | undefined;
  /** Whether more candidates exist beyond this page. */
  readonly more: boolean;
}> => {
  const seen = new Set<string>();

  const unique = pages
    .flatMap((p) => p.candidates)
    .filter((c) => (seen.has(c.docId) ? false : (seen.add(c.docId), true)))
    .sort((a, b) => b.date - a.date || (a.docId < b.docId ? 1 : a.docId > b.docId ? -1 : 0));

  const merged = unique.slice(0, limit);
  const hydrated = await hydrate(merged);

  return {
    results: hydrated.filter((x): x is T => x !== undefined),
    watermark: Math.min(...pages.map((p) => p.watermark), Number.MAX_SAFE_INTEGER),
    last: merged.at(-1),
    more: unique.length > limit || pages.some((p) => p.nextCursor !== null),
  };
};
