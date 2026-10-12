import type {
  EmailFilter,
  EmailSort,
  Mailbox,
  MailboxRole,
  MailReadQuery,
  MailReadResult,
  Thread,
} from "@bye/jmap";
import {
  PROJECTION_SORT_PROPERTIES,
  projectionSupportsFilter,
  READ_ONLY_RIGHTS,
  utcDate,
} from "@bye/jmap";
import type { Address } from "@bye/mail-codec";
import { Match, type Schema } from "effect";
import { allInChunks, json, placeholders, type SqlValue } from "../durable/sql.ts";
import type { MailboxContext } from "./context.ts";

// Read-only JMAP projection of the legacy thread-centric mailbox (spec.md §16.6 "read-only
// vertical slice labeled partial"). Every answer is computed in one synchronous pass over the
// authority's SQLite, so a response and its state describe one logical view (C1).
//
// Mapping (the C3 backfill rules, applied as a live projection rather than a migration):
// - Email = delivery; protocol Thread = the delivery's preserved `original_thread_id`, so a
//   legacy merge never changes a Thread ID.
// - Placement membership from the containing legacy thread: Trash/Spam win, then outgoing mail is
//   Sent, then Screener, Screened Out, or the destination (Imbox → `inbox`, Feed, Paper Trail).
//   Thread labels add label memberships, kept in Trash/Spam as A1 requires.
// - `$seen` is inferred from the revision watermark of the containing thread; a delivery moved by
//   a merge has no comparable revision and reads conservatively as unread. Outgoing mail is seen.
// - Archive and Drafts exist with their roles but stay empty until writable mail and drafts move
//   onto the new core; that is one reason the profile is labeled partial.

interface FixedMailbox {
  readonly id: string;
  readonly name: string;
  readonly role: MailboxRole | null;
  readonly sortOrder: number;
}

export const JMAP_FIXED_MAILBOXES: ReadonlyArray<FixedMailbox> = [
  { id: "inbox", name: "Imbox", role: "inbox", sortOrder: 10 },
  { id: "feed", name: "The Feed", role: null, sortOrder: 20 },
  { id: "paper-trail", name: "Paper Trail", role: null, sortOrder: 30 },
  { id: "screener", name: "Screener", role: null, sortOrder: 40 },
  { id: "archive", name: "Archive", role: "archive", sortOrder: 50 },
  { id: "drafts", name: "Drafts", role: "drafts", sortOrder: 60 },
  { id: "sent", name: "Sent", role: "sent", sortOrder: 70 },
  { id: "screened-out", name: "Screened Out", role: null, sortOrder: 80 },
  { id: "junk", name: "Spam", role: "junk", sortOrder: 90 },
  { id: "trash", name: "Trash", role: "trash", sortOrder: 100 },
];

const LABEL_PREFIX = "label-";

const NOT_IN_PROJECTION: MailReadResult = {
  _tag: "Refused",
  type: "accountNotSupportedByMethod",
  description: "this account has not migrated to the JMAP core",
};

const LABEL_SORT_ORDER = 200;

const BLOB_PREFIX = "raw-";

/** Blob ID of a delivery's original message; downloads resolve it back to the delivery. */
export const rawBlobId = (deliveryId: string): string => `${BLOB_PREFIX}${deliveryId}`;

export const deliveryOfBlob = (blobId: string): string | null =>
  blobId.startsWith(BLOB_PREFIX) ? blobId.slice(BLOB_PREFIX.length) : null;

const PREVIEW_MAX = 256;

const SEEN: Schema.JsonObject = { $seen: true };

const NO_KEYWORDS: Schema.JsonObject = {};

/** SQLite bound-parameter budget per statement (100 minus headroom). */
const MAX_BINDINGS = 90;

/** The per-email projection, optionally restricted by `where` over the `d`/`t` aliases. */
const emailsCte = (where: string) => `em AS (
  SELECT d.delivery_id AS id, d.original_thread_id AS thread, d.thread_id AS ledger_thread,
    d.received_at AS received_at, d.date AS sent_at, d.raw_size AS size,
    CASE
      WHEN t.disposition = 'trash' THEN 'trash'
      WHEN t.disposition = 'spam' THEN 'junk'
      WHEN d.direction = 'out' THEN 'sent'
      WHEN t.disposition = 'screening' THEN 'screener'
      WHEN t.disposition = 'screened-out' THEN 'screened-out'
      WHEN t.destination = 'imbox' THEN 'inbox'
      ELSE t.destination
    END AS placement,
    CASE WHEN d.direction = 'out'
      OR (d.thread_id = d.original_thread_id AND d.thread_revision <= t.seen_revision)
      THEN 1 ELSE 0 END AS seen,
    EXISTS (SELECT 1 FROM attachments a WHERE a.delivery_id = d.delivery_id AND a.inline = 0)
      AS has_attachment,
    CASE WHEN t.quarantined = 1 OR COALESCE(d.scan_status, 'legacy') = 'infected' THEN 1 ELSE 0 END
      AS quarantined
  FROM deliveries d JOIN threads t ON t.thread_id = d.thread_id
  ${where}
)`;

const MEMBERSHIP_CTE = `membership AS (
  SELECT id, placement AS mailbox FROM em
  UNION ALL
  SELECT em.id, '${LABEL_PREFIX}' || tl.label_id FROM em JOIN thread_labels tl ON tl.thread_id = em.ledger_thread
)`;

interface EmailRow {
  readonly id: string;
  readonly thread: string;
  readonly received_at: number;
  readonly sent_at: number;
  readonly size: number;
  readonly seen: number;
  readonly has_attachment: number;
  readonly quarantined: number;
  readonly message_id_header: string | null;
  readonly in_reply_to: string;
  readonly refs: string;
  readonly from_address: string;
  readonly from_name: string | null;
  readonly to_json: string;
  readonly cc_json: string;
  readonly subject: string;
  readonly snippet: string;
}

const msgIds = (values: ReadonlyArray<string>): ReadonlyArray<string> | null => {
  const ids = values.flatMap((v) => {
    const id = v.trim().replace(/^<|>$/g, "");

    return id.length > 0 ? [id] : [];
  });

  return ids.length > 0 ? ids : null;
};

const addresses = (raw: string): ReadonlyArray<Schema.JsonObject> | null => {
  const list = json<ReadonlyArray<Address>>(raw, []);

  return list.length > 0 ? list.map((a) => ({ name: a.name ?? null, email: a.address })) : null;
};

interface Compiled {
  readonly sql: string;
  readonly args: Array<SqlValue>;
}

/** Compile a parsed Email/query filter to SQL over the `e` alias of the projection. */
const compileFilter = (filter: EmailFilter | null): Compiled => {
  if (filter === null) return { sql: "1", args: [] };

  return Match.value(filter).pipe(
    Match.tagsExhaustive({
      Operator: (f) => {
        const parts = f.conditions.map(compileFilter);
        const args = parts.flatMap((p) => p.args);

        if (parts.length === 0) return { sql: f.operator === "OR" ? "0" : "1", args };

        const joined = parts.map((p) => `(${p.sql})`).join(f.operator === "AND" ? " AND " : " OR ");

        return { sql: f.operator === "NOT" ? `NOT (${joined})` : joined, args };
      },
      Condition: ({ condition: c }) => {
        const sql: Array<string> = [];
        const args: Array<SqlValue> = [];

        if (c.inMailbox !== undefined) {
          sql.push("EXISTS (SELECT 1 FROM membership m WHERE m.id = e.id AND m.mailbox = ?)");
          args.push(c.inMailbox);
        }

        if (c.inMailboxOtherThan !== undefined) {
          sql.push(
            c.inMailboxOtherThan.length === 0
              ? "EXISTS (SELECT 1 FROM membership m WHERE m.id = e.id)"
              : "EXISTS (SELECT 1 FROM membership m WHERE m.id = e.id AND m.mailbox NOT IN (SELECT value FROM json_each(?)))",
          );

          // Client-sized list: one JSON parameter (Cloudflare SQL allows 100 parameters).
          if (c.inMailboxOtherThan.length > 0) args.push(JSON.stringify(c.inMailboxOtherThan));
        }

        if (c.before !== undefined) {
          sql.push("e.received_at < ?");
          args.push(c.before);
        }

        if (c.after !== undefined) {
          sql.push("e.received_at >= ?");
          args.push(c.after);
        }

        if (c.minSize !== undefined) {
          sql.push("e.size >= ?");
          args.push(c.minSize);
        }

        if (c.maxSize !== undefined) {
          sql.push("e.size < ?");
          args.push(c.maxSize);
        }

        // `$seen` is the only keyword the legacy model carries; every other keyword is absent.
        if (c.hasKeyword !== undefined) sql.push(c.hasKeyword === "$seen" ? "e.seen = 1" : "0");

        if (c.notKeyword !== undefined) sql.push(c.notKeyword === "$seen" ? "e.seen = 0" : "1");

        if (c.hasAttachment !== undefined) {
          sql.push("e.has_attachment = ?");
          args.push(c.hasAttachment ? 1 : 0);
        }

        return { sql: sql.length > 0 ? sql.join(" AND ") : "1", args };
      },
    }),
  );
};

const SORT_COLUMN = new Map<string, string>([
  ["receivedAt", "received_at"],
  ["sentAt", "sent_at"],
  ["size", "size"],
]);

/** ORDER BY for the comparators, with the ID as final tie-break so paging is deterministic. */
const orderBy = (sort: ReadonlyArray<EmailSort>, alias: string): string => {
  const keys = sort.map(
    (s) =>
      `${alias}.${SORT_COLUMN.get(s.property) ?? "received_at"} ${s.isAscending ? "ASC" : "DESC"}`,
  );

  const last = sort.at(-1);

  return [...keys, `${alias}.id ${last && !last.isAscending ? "DESC" : "ASC"}`].join(", ");
};

export class MailboxJmap {
  constructor(private readonly ctx: MailboxContext) {}

  private state() {
    return { revision: String(this.ctx.kernel.currentSeq()) };
  }

  read(query: MailReadQuery): MailReadResult {
    return Match.value(query).pipe(
      Match.tagsExhaustive({
        State: (): MailReadResult => ({ _tag: "State", state: this.state() }),
        MailboxGet: (q): MailReadResult => {
          const all = this.mailboxes();
          const byId = new Map(all.map((m) => [m.id, m]));

          if (q.ids === null)
            return { _tag: "MailboxGet", state: this.state(), list: all, notFound: [] };

          return {
            _tag: "MailboxGet",
            state: this.state(),
            list: q.ids.flatMap((id) => byId.get(id) ?? []),
            notFound: q.ids.filter((id) => !byId.has(id)),
          };
        },
        EmailGet: (q): MailReadResult => {
          const list = this.emails(q.ids, q.properties);
          const found = new Set(list.map((e) => e["id"]));

          return {
            _tag: "EmailGet",
            state: this.state(),
            list,
            notFound: q.ids.filter((id) => !found.has(id)),
          };
        },
        EmailQuery: (q): MailReadResult => this.query(q),
        // The projection has no typed history: only a token at the current revision has (no)
        // changes; every other one must resynchronize (C1 fallback, never a partial answer).
        Changes: (q): MailReadResult =>
          q.target === null && q.base === this.state().revision
            ? {
                _tag: "Changes",
                state: this.state(),
                created: [],
                updated: [],
                destroyed: [],
                nextCursor: null,
              }
            : { _tag: "Refused", type: "cannotCalculateChanges", description: "no history" },
        ObjectGet: (): MailReadResult => NOT_IN_PROJECTION,
        Snippets: (): MailReadResult => NOT_IN_PROJECTION,
        SubmissionQuery: (): MailReadResult => NOT_IN_PROJECTION,
        ThreadGet: (q): MailReadResult => {
          const list = this.threads(q.ids);
          const found = new Set(list.map((t) => t.id));

          return {
            _tag: "ThreadGet",
            state: this.state(),
            list,
            notFound: q.ids.filter((id) => !found.has(id)),
          };
        },
      }),
    );
  }

  /** Every projected Mailbox with its counts (RFC 8621 §2 recommended unread-thread policy). */
  mailboxes(): ReadonlyArray<Mailbox> {
    const counts = new Map(
      this.ctx.sql
        .all<{
          mailbox: string;
          total: number;
          unread: number;
          threads: number;
          unread_threads: number;
        }>(
          `WITH ${emailsCte("")}, ${MEMBERSHIP_CTE},
          thread_unread AS (
            SELECT thread,
              MAX(CASE WHEN seen = 0 AND placement <> 'trash' THEN 1 ELSE 0 END) AS outside_trash,
              MAX(CASE WHEN seen = 0 AND placement = 'trash' THEN 1 ELSE 0 END) AS inside_trash
            FROM em GROUP BY thread
          )
          SELECT m.mailbox AS mailbox, COUNT(*) AS total, SUM(1 - e.seen) AS unread,
            COUNT(DISTINCT e.thread) AS threads,
            COUNT(DISTINCT CASE WHEN (m.mailbox = 'trash' AND u.inside_trash = 1)
              OR (m.mailbox <> 'trash' AND u.outside_trash = 1) THEN e.thread END) AS unread_threads
          FROM membership m JOIN em e ON e.id = m.id JOIN thread_unread u ON u.thread = e.thread
          GROUP BY m.mailbox`,
        )
        .map((r) => [r.mailbox, r] as const),
    );

    const labels = this.ctx.sql.all<{ label_id: string; name: string }>(
      "SELECT label_id, name FROM labels ORDER BY name, label_id",
    );

    const defined = [
      ...JMAP_FIXED_MAILBOXES,
      ...labels.map((l) => ({
        id: `${LABEL_PREFIX}${l.label_id}`,
        name: l.name,
        role: null,
        sortOrder: LABEL_SORT_ORDER,
      })),
    ];

    return defined.map((m) => {
      const c = counts.get(m.id);

      return {
        id: m.id,
        name: m.name,
        parentId: null,
        role: m.role,
        sortOrder: m.sortOrder,
        totalEmails: Number(c?.total ?? 0),
        unreadEmails: Number(c?.unread ?? 0),
        totalThreads: Number(c?.threads ?? 0),
        unreadThreads: Number(c?.unread_threads ?? 0),
        myRights: READ_ONLY_RIGHTS,
        // Subscriptions are principal-scoped (A3); the legacy model has none, so all are on.
        isSubscribed: true,
      };
    });
  }

  emails(ids: ReadonlyArray<string>, properties: ReadonlyArray<string>): Array<Schema.JsonObject> {
    const wanted = new Set(properties);

    const rows = allInChunks(ids, (chunk) =>
      this.ctx.sql.all<EmailRow>(
        `WITH ${emailsCte(`WHERE d.delivery_id IN (${placeholders(chunk.length)})`)}
         SELECT e.*, d.message_id_header, d.in_reply_to, d.refs, d.from_address, d.from_name,
           d.to_json, d.cc_json, d.subject, d.snippet
         FROM em e JOIN deliveries d ON d.delivery_id = e.id`,
        ...chunk,
      ),
    );

    const memberships = new Map<string, { [mailboxId: string]: boolean }>();

    if (wanted.has("mailboxIds"))
      for (const m of allInChunks(ids, (chunk) =>
        this.ctx.sql.all<{ id: string; mailbox: string }>(
          `WITH ${emailsCte(`WHERE d.delivery_id IN (${placeholders(chunk.length)})`)}, ${MEMBERSHIP_CTE}
           SELECT id, mailbox FROM membership`,
          ...chunk,
        ),
      )) {
        const set = memberships.get(m.id) ?? {};
        set[m.mailbox] = true;
        memberships.set(m.id, set);
      }

    const byId = new Map(rows.map((r) => [r.id, r]));

    return ids.flatMap((id) => {
      const r = byId.get(id);

      if (!r) return [];

      const all = new Map<string, () => Schema.Json>(
        Object.entries({
          id: () => r.id,
          blobId: () => rawBlobId(r.id),
          threadId: () => r.thread,
          mailboxIds: () => memberships.get(r.id) ?? {},
          keywords: () => (r.seen === 1 ? SEEN : NO_KEYWORDS),
          size: () => Number(r.size),
          receivedAt: () => utcDate(Number(r.received_at)),
          messageId: () => (r.message_id_header ? msgIds([r.message_id_header]) : null),
          inReplyTo: () => msgIds(json<ReadonlyArray<string>>(r.in_reply_to, [])),
          references: () => msgIds(json<ReadonlyArray<string>>(r.refs, [])),
          from: () => [{ name: r.from_name ?? null, email: r.from_address }],
          to: () => addresses(r.to_json),
          cc: () => addresses(r.cc_json),
          subject: () => r.subject,
          sentAt: () => utcDate(Number(r.sent_at)),
          hasAttachment: () => r.has_attachment === 1,
          // Quarantine applies to snippets too (A3): quarantined mail shows no preview text.
          preview: () => (r.quarantined === 1 ? "" : r.snippet.slice(0, PREVIEW_MAX)),
        }),
      );

      return [
        Object.fromEntries(
          properties.flatMap((p) => {
            const value = all.get(p);

            return value ? [[p, value()] as const] : [];
          }),
        ),
      ];
    });
  }

  private query(q: Extract<MailReadQuery, { readonly _tag: "EmailQuery" }>): MailReadResult {
    if (!projectionSupportsFilter(q.filter))
      return {
        _tag: "Refused",
        type: "unsupportedFilter",
        description: "this account has not migrated to the JMAP core; text filters need it",
      };

    if (q.sort.some((s) => !PROJECTION_SORT_PROPERTIES.includes(s.property)))
      return { _tag: "Refused", type: "unsupportedSort", description: "sort needs the JMAP core" };
    const filter = compileFilter(q.filter);

    if (filter.args.length > MAX_BINDINGS)
      return {
        _tag: "Refused",
        type: "unsupportedFilter",
        description: "filter is too complex for this server",
      };

    const order = orderBy(q.sort, "e");

    const source = q.collapseThreads
      ? `SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.thread ORDER BY ${order}) AS rn
           FROM em e WHERE ${filter.sql}) e WHERE e.rn = 1`
      : `SELECT e.* FROM em e WHERE ${filter.sql}`;

    const base = `WITH ${emailsCte("")}, ${MEMBERSHIP_CTE}, matched AS (${source})`;

    const count = (): number =>
      Number(
        this.ctx.sql.one<{ n: number }>(`${base} SELECT COUNT(*) AS n FROM matched`, ...filter.args)
          ?.n ?? 0,
      );

    if (q.anchor !== null) {
      const ids = this.ctx.sql
        .all<{ id: string }>(`${base} SELECT e.id FROM matched e ORDER BY ${order}`, ...filter.args)
        .map((r) => r.id);

      const at = ids.indexOf(q.anchor);

      if (at < 0)
        return {
          _tag: "EmailQuery",
          state: this.state(),
          ids: [],
          position: 0,
          total: null,
          anchorFound: false,
        };
      const start = Math.max(0, at + q.anchorOffset);

      return {
        _tag: "EmailQuery",
        state: this.state(),
        ids: ids.slice(start, start + q.limit),
        position: start,
        total: q.calculateTotal ? ids.length : null,
        anchorFound: true,
      };
    }

    const total = q.calculateTotal || q.position < 0 ? count() : null;
    const start = q.position < 0 ? Math.max(0, (total ?? 0) + q.position) : q.position;

    const ids = this.ctx.sql
      .all<{ id: string }>(
        `${base} SELECT e.id FROM matched e ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...filter.args,
        q.limit,
        start,
      )
      .map((r) => r.id);

    return {
      _tag: "EmailQuery",
      state: this.state(),
      ids,
      position: start,
      total: q.calculateTotal ? total : null,
      anchorFound: true,
    };
  }

  threads(ids: ReadonlyArray<string>): Array<Thread> {
    const rows = allInChunks(ids, (chunk) =>
      this.ctx.sql.all<{ thread: string; id: string }>(
        `SELECT original_thread_id AS thread, delivery_id AS id FROM deliveries
         WHERE original_thread_id IN (${placeholders(chunk.length)})
         ORDER BY received_at, delivery_id`,
        ...chunk,
      ),
    );

    const byThread = new Map<string, Array<string>>();

    for (const r of rows) byThread.set(r.thread, [...(byThread.get(r.thread) ?? []), r.id]);

    return ids.flatMap((id) => {
      const emailIds = byThread.get(id);

      return emailIds ? [{ id, emailIds }] : [];
    });
  }

  /**
   * The raw message behind a blob ID, with the quarantine/scan gate applied (A3): quarantined or
   * not-yet-clean originals are never served. Null when the blob doesn't exist here.
   */
  rawBlob(blobId: string): {
    readonly messageKey: string;
    readonly size: number;
    readonly allowed: boolean;
    readonly status: string;
  } | null {
    const deliveryId = deliveryOfBlob(blobId);

    if (deliveryId === null) return null;

    const row = this.ctx.sql.one<{
      message_key: string;
      raw_size: number;
      scan_status: string | null;
      quarantined: number;
    }>(
      `SELECT d.message_key, d.raw_size, d.scan_status, t.quarantined FROM deliveries d
       JOIN threads t ON t.thread_id = d.thread_id WHERE d.delivery_id = ?`,
      deliveryId,
    );

    if (!row) return null;
    const status = row.scan_status ?? "legacy";

    const allowed =
      row.quarantined !== 1 &&
      (status === "clean" || status === "not-required" || status === "legacy");

    return {
      messageKey: row.message_key,
      size: Number(row.raw_size),
      allowed,
      status: row.quarantined === 1 ? "quarantined" : status,
    };
  }
}
