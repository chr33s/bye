import {
  applyMemberPatch,
  type AuthorityState,
  type ChangeType,
  type EmailFilter,
  type EmailSort,
  type Mailbox,
  type MailboxRights,
  type MailboxRole,
  MAILBOX_ROLES,
  type MailReadQuery,
  type MailReadResult,
  type MailWriteResult,
  type NativeCommand,
  normalizeKeyword,
  parseEmailPatch,
  parseFlatPatch,
  type SetCommand,
  type SetError,
  setError,
  type Thread,
  idResolver,
  queryDigest,
  type ImportCommand,
  utcDate,
} from "@bye/jmap";
import {
  decodeEncodedWords,
  normalizeSubject,
  parseAddressList,
  parseMailDate,
  parseMessageIdList,
  type PreparedBodyPart,
  type PreparedEmail,
} from "@bye/mail-codec";
import { RETENTION } from "@bye/domain";
import { Match, Option, Predicate, Result, Schema } from "effect";
import type { KernelClock } from "../durable/kernel.ts";
import { allInChunks, json, placeholders, type Sql, type SqlValue } from "../durable/sql.ts";
import type { ExportManifestPageResult } from "../mailbox/retention.ts";
import { decodeCursor, encodeCursor } from "../mailbox/rows.ts";
import { History, PRINCIPAL_SCOPED } from "./history.ts";

// The JMAP mail core (spec.md §16.2–16.4, A1–A3): per-email membership and keywords, protocol
// Threads, effective rights, typed history and every per-object write. Synchronous over the
// account's SQLite; bytes are written and prepared before any call reaches here, so no transaction
// ever spans a network await (§4).

export const THREADING_VERSION = 1;

/** Kernel job kind of A2 timers. */
export const TIMER_JOB = "jmap-timer";

/** Kernel job kind continuing a retention sweep with a backlog. */
export const RETENTION_JOB = "jmap-retention";

/** Emails purged per retention batch; the rest continue from a scheduled job. */
export const JMAP_RETENTION_BATCH = 200;

/** Old Emails examined per recycling pass (each thread is checked once). */
export const RECYCLE_SCAN = 1000;

/** How long a blob GC claim blocks re-registration; a crashed sweep's claim lapses after it. */
export const GC_CLAIM_MS = 5 * 60_000;

/** The content is being deleted by blob GC: store it again once the delete finished. */
export class BlobCollecting extends Error {
  override readonly name = "BlobCollecting";

  constructor(readonly r2Key: string) {
    super("blob is being collected; retry");
  }
}

/** Account mode (C3 state machine; `jmap` means this core is the only mail writer). */
export type JmapMode =
  | "legacy"
  | "fencing"
  | "backfilling"
  | "verifying"
  | "activating"
  | "jmap"
  | "failed";

/** Prepared content for one creation: immutable bytes already in R2, parsed once (§4). */
export interface PreparedContent {
  readonly blobId: string;
  readonly bucket: "originals" | "parts";
  readonly r2Key: string;
  readonly type: string;
  readonly email: PreparedEmail;
}

export const FULL_RIGHTS: MailboxRights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

const NO_RIGHTS: MailboxRights = {
  mayReadItems: false,
  mayAddItems: false,
  mayRemoveItems: false,
  maySetSeen: false,
  maySetKeywords: false,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
};

/** Workflow Mailboxes without a standard role (A1): their IDs live in account configuration. */
export const WORKFLOW_TARGETS = ["feed", "paperTrail", "screener", "screenedOut"] as const;

export type WorkflowTarget = (typeof WORKFLOW_TARGETS)[number];

/** Mailboxes every account starts with; IDs match the read-only projection for continuity. */
export const DEFAULT_MAILBOXES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly role: MailboxRole | null;
  readonly sortOrder: number;
  readonly workflow?: WorkflowTarget;
}> = [
  { id: "inbox", name: "Imbox", role: "inbox", sortOrder: 10 },
  { id: "feed", name: "The Feed", role: null, sortOrder: 20, workflow: "feed" },
  { id: "paper-trail", name: "Paper Trail", role: null, sortOrder: 30, workflow: "paperTrail" },
  { id: "screener", name: "Screener", role: null, sortOrder: 40, workflow: "screener" },
  { id: "archive", name: "Archive", role: "archive", sortOrder: 50 },
  { id: "drafts", name: "Drafts", role: "drafts", sortOrder: 60 },
  { id: "sent", name: "Sent", role: "sent", sortOrder: 70 },
  { id: "screened-out", name: "Screened Out", role: null, sortOrder: 80, workflow: "screenedOut" },
  { id: "junk", name: "Spam", role: "junk", sortOrder: 90 },
  { id: "trash", name: "Trash", role: "trash", sortOrder: 100 },
];

const PREVIEW_MAX = 256;

/** Searchable text is indexed in overlapping chunks so no match is lost at a boundary (D2). */
export const FTS_CHUNK = 4000;

export const FTS_OVERLAP = 256;

const MAX_BINDINGS = 90;

/** How long an upload or copy stays usable without an Email referencing it (RFC 8620 §6.1). */
export const BLOB_UPLOAD_TTL_MS = 24 * 3600 * 1000;

const MAX_MAILBOX_NAME = 255;

interface EmailRow {
  readonly email_id: string;
  readonly blob_id: string;
  readonly thread_id: string;
  readonly size: number;
  readonly received_at: number;
  readonly sent_at: number | null;
  readonly message_id: string | null;
  readonly in_reply_to: string | null;
  readonly refs: string | null;
  readonly sender: string | null;
  readonly from_json: string | null;
  readonly to_json: string | null;
  readonly cc_json: string | null;
  readonly bcc_json: string | null;
  readonly reply_to_json: string | null;
  readonly subject: string;
  readonly base_subject: string;
  readonly preview: string;
  readonly has_attachment: number;
  readonly headers_json: string;
  readonly body_json: string;
  readonly scan_status: string;
  readonly quarantined: number;
  readonly placement_version: number;
}

interface MailboxRow {
  readonly mailbox_id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly role: MailboxRole | null;
  readonly sort_order: number;
}

interface StoredBody {
  readonly structure: PreparedBodyPart;
  readonly textBody: ReadonlyArray<string>;
  readonly htmlBody: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<string>;
}

/** Blob ID of one leaf part of an Email's immutable message. */
export const partBlobId = (emailBlobId: string, partId: string): string =>
  `${emailBlobId}_p${partId.replaceAll(".", "_")}`;

/** Inverse of `partBlobId`: the message blob and part, or none. */
export const parsePartBlobId = (
  blobId: string,
): Option.Option<{ readonly blobId: string; readonly partId: string }> => {
  const m = /^(.+)_p([0-9]+(?:_[0-9]+)*)$/.exec(blobId);

  return m ? Option.some({ blobId: m[1]!, partId: m[2]!.replaceAll("_", ".") }) : Option.none();
};

const jsonOrNull = (
  value: Schema.Json | ReadonlyArray<unknown> | null | undefined,
): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

const parsedJson = (value: string | null): Schema.Json =>
  value === null ? null : json<Schema.Json>(value, null);

/** Keywords that only the server sets or that are read-only for clients. */
const SERVER_KEYWORDS = new Set<string>();

/** Renders one Email row's JMAP properties (shared by Email/get and Email/parse). */
export class EmailView {
  constructor(
    private readonly r: EmailRow,
    private readonly memberships: () => ReadonlyArray<string>,
    private readonly keywords: () => ReadonlyArray<string>,
  ) {}

  bodyPart(part: PreparedBodyPart): Schema.JsonObject {
    const r = this.r;

    return {
      partId: part.partId,
      blobId: part.partId === null ? null : partBlobId(r.blob_id, part.partId),
      size: part.size,
      headers: [],
      name: part.name,
      type: part.type,
      charset: part.charset,
      disposition: part.disposition,
      cid: part.cid,
      language: null,
      location: null,
      ...(part.subParts ? { subParts: part.subParts.map((p) => this.bodyPart(p)) } : undefined),
    };
  }

  leafParts(ids: ReadonlyArray<string>): Array<Schema.JsonObject> {
    const r = this.r;

    const body = json<StoredBody | null>(r.body_json, null);

    if (!body) return [];
    const leaves = new Map<string, PreparedBodyPart>();

    const walk = (p: PreparedBodyPart) => {
      if (p.subParts) p.subParts.forEach(walk);
      else if (p.partId !== null) leaves.set(p.partId, p);
    };

    walk(body.structure);

    return ids.flatMap((id) => {
      const p = leaves.get(id);

      return p ? [this.bodyPart(p)] : [];
    });
  }

  headerValues(name: string): ReadonlyArray<string> {
    const r = this.r;

    return json<ReadonlyArray<{ name: string; value: string }>>(r.headers_json, [])
      .filter((h) => h.name.toLowerCase() === name.toLowerCase())
      .map((h) => h.value);
  }

  /** `header:{name}[:as{Form}][:all]` (RFC 8621 §4.1.2–4.1.3). */
  headerProperty(property: string): Schema.Json {
    const [, name = "", ...rest] = property.split(":");
    const all = rest.includes("all");
    const form = rest.find((x) => x.startsWith("as")) ?? "asRaw";

    const convert = (raw: string): Schema.Json => {
      switch (form) {
        case "asText":
          return decodeEncodedWords(raw.replace(/\r?\n[ \t]/g, " ")).trim();
        case "asAddresses":
          return parseAddressList(raw, []).map((a) => ({ name: a.name ?? null, email: a.address }));
        case "asGroupedAddresses":
          return [
            {
              name: null,
              addresses: parseAddressList(raw, []).map((a) => ({
                name: a.name ?? null,
                email: a.address,
              })),
            },
          ];
        case "asMessageIds": {
          const list = parseMessageIdList(raw);

          return list.length > 0 ? list : null;
        }

        case "asDate": {
          const at = parseMailDate(raw);

          return at === undefined ? null : utcDate(at);
        }

        case "asURLs": {
          const urls = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());

          return urls.length > 0 ? urls : null;
        }

        default:
          return raw;
      }
    };

    const values = this.headerValues(name).map(convert);

    return all ? values : (values.at(-1) ?? null);
  }

  property(p: string): Schema.Json {
    const r = this.r;

    if (p.startsWith("header:")) return this.headerProperty(p);
    const body = (): StoredBody | null => json<StoredBody | null>(r.body_json, null);

    switch (p) {
      case "id":
        return r.email_id;
      case "blobId":
        return r.blob_id;
      case "threadId":
        return r.thread_id;
      case "mailboxIds":
        return Object.fromEntries(this.memberships().map((m) => [m, true]));
      case "keywords":
        return Object.fromEntries(this.keywords().map((k) => [k, true]));
      case "size":
        return Number(r.size);
      case "receivedAt":
        return utcDate(Number(r.received_at));
      case "messageId":
        return parsedJson(r.message_id);
      case "inReplyTo":
        return parsedJson(r.in_reply_to);
      case "references":
        return parsedJson(r.refs);
      case "sender":
        return parsedJson(r.sender);
      case "from":
        return parsedJson(r.from_json);
      case "to":
        return parsedJson(r.to_json);
      case "cc":
        return parsedJson(r.cc_json);
      case "bcc":
        return parsedJson(r.bcc_json);
      case "replyTo":
        return parsedJson(r.reply_to_json);
      case "subject":
        return r.subject;
      case "sentAt":
        return r.sent_at === null ? null : utcDate(Number(r.sent_at));
      case "hasAttachment":
        return r.has_attachment === 1;
      // Quarantine applies to snippets and bodies (A3).
      case "preview":
        return r.quarantined === 1 ? "" : r.preview;
      case "headers":
        return json<Schema.Json>(r.headers_json, []);
      case "bodyStructure": {
        const b = body();

        return b ? this.bodyPart(b.structure) : null;
      }

      case "textBody":
        return this.leafParts(body()?.textBody ?? []);
      case "htmlBody":
        return this.leafParts(body()?.htmlBody ?? []);
      case "attachments":
        return this.leafParts(body()?.attachments ?? []);
      // Filled from the immutable bytes by the API host when fetch*BodyValues is requested.
      case "bodyValues":
        return {};
      default:
        return null;
    }
  }
}

/**
 * Email/parse (RFC 8621 §4.9): a prepared message rendered without account metadata; `id`,
 * `mailboxIds`, `keywords`, `threadId` and `receivedAt` are null.
 */
export const renderParsedEmail = (
  blobId: string,
  e: PreparedEmail,
  properties: ReadonlyArray<string>,
): Schema.JsonObject => {
  const row: EmailRow = {
    email_id: "",
    blob_id: blobId,
    thread_id: "",
    size: e.size,
    received_at: 0,
    sent_at: e.sentAt,
    message_id: jsonOrNull(e.messageId),
    in_reply_to: jsonOrNull(e.inReplyTo),
    refs: jsonOrNull(e.references),
    sender: jsonOrNull(e.sender),
    from_json: jsonOrNull(e.from),
    to_json: jsonOrNull(e.to),
    cc_json: jsonOrNull(e.cc),
    bcc_json: jsonOrNull(e.bcc),
    reply_to_json: jsonOrNull(e.replyTo),
    subject: e.subject,
    base_subject: normalizeSubject(e.subject),
    preview: e.preview,
    has_attachment: e.hasAttachment ? 1 : 0,
    headers_json: JSON.stringify(e.headers),
    body_json: JSON.stringify({
      structure: e.bodyStructure,
      textBody: e.textBody,
      htmlBody: e.htmlBody,
      attachments: e.attachments,
    }),
    scan_status: "not-required",
    quarantined: 0,
    placement_version: 0,
  };

  const view = new EmailView(
    row,
    () => [],
    () => [],
  );

  const metadata = new Set(["id", "mailboxIds", "keywords", "threadId", "receivedAt"]);

  return Object.fromEntries(properties.map((p) => [p, metadata.has(p) ? null : view.property(p)]));
};

/** One page of Email/get results. */
export interface EmailPage {
  readonly list: Array<Schema.JsonObject>;
  readonly notFound: Array<string>;
}

/** A principal's access to a blob's bytes (A3 quarantine and scan gate). */
export interface BlobAccess {
  readonly visible: boolean;
  readonly allowed: boolean;
  readonly status: string;
}

/** A published Email and the protocol Thread it joined or opened. */
export interface Published {
  readonly emailId: string;
  readonly threadId: string;
}

/** Outcome of one timer execution: Emails acted on and those a later edit invalidated. */
export interface TimerRun {
  readonly ran: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/** Replacement memberships and/or keywords for one Email. */
export interface StateChange {
  mailboxIds?: ReadonlyArray<string>;
  keywords?: ReadonlyArray<string>;
}

/** An address as delivery consumers read it (legacy `Address` shape). */
export interface EmailAddress {
  readonly name: string | undefined;
  readonly address: string;
}

/** One retention batch: Emails purged, and whether a backlog remains. */
/** Emails of whole recyclable threads, and whether the walk stopped with work left. */
interface RecycleBatch {
  readonly ids: ReadonlyArray<string>;
  readonly more: boolean;
}

export interface RetentionBatch {
  readonly deleted: number;
  readonly more: boolean;
}

/** One principal's view of the account: rights resolve per Mailbox from effective grants. */
export interface Viewer {
  readonly principalId: string;
  /** The credential may destroy only `$draft` Emails (a `draft` scope without `delete`). */
  readonly draftsOnlyDestroy?: boolean;
  /**
   * False when the credential lacks `delete`: it may not move existing mail into Trash, whose
   * retention destroys it (the same scope as MoveToTrash).
   */
  readonly mayTrash?: boolean;
}

export class JmapCore {
  readonly history: History;

  constructor(
    readonly sql: Sql,
    readonly clock: KernelClock,
    /** Arms a durable alarm job (the authority kernel's scheduler). */
    private readonly schedule: (kind: string, key: string, dueAt: number) => void = () => undefined,
  ) {
    this.history = new History(sql, () => clock.now());
  }

  // ---------------------------------------------------------------- meta

  meta<T>(key: string, fallback: T): T {
    return json<T>(
      this.sql.one<{ value: string }>("SELECT value FROM jmap_meta WHERE key = ?", key)?.value,
      fallback,
    );
  }

  putMeta(key: string, value: Schema.Json): void {
    this.sql.run(
      "INSERT INTO jmap_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  mode(): JmapMode {
    return this.meta<JmapMode>("mode", "legacy");
  }

  /** Writer epoch (C3): every authoritative writer checks it at its commit boundary. */
  epoch(): number {
    return this.meta<number>("epoch", 0);
  }

  /** ACL generation (A3): advanced by every effective-grant change in the account. */
  aclGeneration(): number {
    return this.meta<number>("aclGeneration", 0);
  }

  /**
   * The ACL generation of the principal's own latest grant change (A3). It binds visibility in
   * that principal's state tokens, so another principal's grant change never invalidates them.
   */
  visibilityGeneration(principalId: string): number {
    return Number(
      this.sql.one<{ generation: number }>(
        "SELECT generation FROM jmap_acl_generations WHERE principal_id = ?",
        principalId,
      )?.generation ?? 0,
    );
  }

  audit(kind: string, subject: string, detail: string): void {
    this.sql.run(
      "INSERT INTO jmap_audit (kind, subject, detail, at) VALUES (?, ?, ?, ?)",
      kind,
      subject,
      detail,
      this.clock.now(),
    );
  }

  workflowTargets(): { readonly [K in WorkflowTarget]?: string } {
    return this.meta<{ readonly [K in WorkflowTarget]?: string }>("workflowTargets", {});
  }

  /** Create the default Mailboxes and workflow configuration once (activation, C3). */
  ensureDefaults(): void {
    if (this.meta<boolean>("initialized", false)) return;
    this.history.tx(() => {
      const targets: { [key: string]: string } = {};

      for (const m of DEFAULT_MAILBOXES) {
        this.sql.run(
          "INSERT OR IGNORE INTO jmap_mailboxes (mailbox_id, name, parent_id, role, sort_order, created_rev) VALUES (?, ?, NULL, ?, ?, 0)",
          m.id,
          m.name,
          m.role,
          m.sortOrder,
        );
        this.history.record("Mailbox", m.id, "created");

        if (m.workflow) targets[m.workflow] = m.id;
      }

      this.putMeta("workflowTargets", targets);
      this.putMeta("initialized", true);
    });
  }

  // ---------------------------------------------------------------- rights (A3)

  /** Set (or with null, revoke) one effective grant; advances the account and principal ACL generations. */
  applyGrant(principalId: string, mailboxId: string, rights: MailboxRights | null): number {
    return this.sql.tx(() => {
      const generation = this.aclGeneration() + 1;

      if (rights === null)
        this.sql.run(
          "DELETE FROM jmap_grants WHERE principal_id = ? AND mailbox_id = ?",
          principalId,
          mailboxId,
        );
      else
        this.sql.run(
          `INSERT INTO jmap_grants (principal_id, mailbox_id, rights, revision) VALUES (?, ?, ?, ?)
           ON CONFLICT (principal_id, mailbox_id) DO UPDATE SET rights = excluded.rights, revision = excluded.revision`,
          principalId,
          mailboxId,
          JSON.stringify(rights),
          generation,
        );
      this.putMeta("aclGeneration", generation);
      this.sql.run(
        `INSERT INTO jmap_acl_generations (principal_id, generation) VALUES (?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET generation = excluded.generation`,
        principalId,
        generation,
      );
      this.audit("grant", `${principalId}:${mailboxId}`, rights === null ? "revoked" : "granted");

      return generation;
    });
  }

  grants(principalId: string): ReadonlyMap<string, MailboxRights> {
    return new Map(
      this.sql
        .all<{ mailbox_id: string; rights: string }>(
          "SELECT mailbox_id, rights FROM jmap_grants WHERE principal_id = ?",
          principalId,
        )
        .map((g) => [g.mailbox_id, json<MailboxRights>(g.rights, NO_RIGHTS)]),
    );
  }

  hasAnyGrant(principalId: string): boolean {
    return (
      this.sql.one("SELECT 1 AS x FROM jmap_grants WHERE principal_id = ? LIMIT 1", principalId) !==
      undefined
    );
  }

  /** Rights on one Mailbox: a specific grant wins over the account-wide `*` grant. */
  rights(viewer: Viewer, mailbox: Pick<MailboxRow, "mailbox_id" | "role">): MailboxRights {
    const grants = this.grants(viewer.principalId);
    const r = grants.get(mailbox.mailbox_id) ?? grants.get("*") ?? NO_RIGHTS;

    // Role Mailboxes are protected from deletion; the advertised rights say so (A1).
    return mailbox.role !== null ? { ...r, mayDelete: false } : r;
  }

  /** Mailbox IDs the viewer may read, or null when the viewer reads everything (`*`). */
  readable(viewer: Viewer): ReadonlyArray<string> | null {
    const grants = this.grants(viewer.principalId);

    if (grants.get("*")?.mayReadItems) return null;

    return [...grants].flatMap(([id, r]) => (id !== "*" && r.mayReadItems ? [id] : []));
  }

  // ---------------------------------------------------------------- state

  /**
   * A type's state. Principal-scoped types (submissions, drafts) have a state per principal, so
   * they require the viewer: a caller that forgot it fails instead of getting another scope's.
   */
  state(type: ChangeType, viewer?: Viewer): AuthorityState {
    if (!PRINCIPAL_SCOPED.has(type)) return { revision: String(this.history.typeRevision(type)) };

    if (viewer === undefined) throw new Error(`${type} state is per principal: pass the viewer`);

    return { revision: String(this.history.typeRevision(type, viewer.principalId)) };
  }

  // ---------------------------------------------------------------- mailboxes

  mailboxRows(): ReadonlyArray<MailboxRow> {
    return this.sql.all<MailboxRow>(
      "SELECT mailbox_id, name, parent_id, role, sort_order FROM jmap_mailboxes ORDER BY sort_order, name, mailbox_id",
    );
  }

  mailboxRow(id: string): MailboxRow | undefined {
    return this.sql.one<MailboxRow>(
      "SELECT mailbox_id, name, parent_id, role, sort_order FROM jmap_mailboxes WHERE mailbox_id = ?",
      id,
    );
  }

  roleMailbox(role: MailboxRole): string | undefined {
    return this.sql.one<{ mailbox_id: string }>(
      "SELECT mailbox_id FROM jmap_mailboxes WHERE role = ?",
      role,
    )?.mailbox_id;
  }

  private visibilityClause(viewer: Viewer, alias: string): Compiled {
    const readable = this.readable(viewer);

    if (readable === null) return { sql: "1", args: [] };

    if (readable.length === 0) return { sql: "0", args: [] };

    // One JSON parameter, whatever the number of readable mailboxes: callers add id chunks of
    // up to MAX_IN_LIST, and Cloudflare SQL refuses more than 100 bound parameters.
    return {
      sql: `EXISTS (SELECT 1 FROM jmap_memberships vm WHERE vm.email_id = ${alias}.email_id AND vm.mailbox_id IN (SELECT value FROM json_each(?)))`,
      args: [JSON.stringify(readable)],
    };
  }

  mailboxes(viewer: Viewer): ReadonlyArray<Mailbox> {
    const rows = this.mailboxRows().filter((m) => this.rights(viewer, m).mayReadItems);

    const counts = new Map(
      this.sql
        .all<{
          mailbox_id: string;
          total: number;
          unread: number;
          threads: number;
          unread_threads: number;
        }>(
          `WITH em AS (
             SELECT e.email_id, e.thread_id,
               CASE WHEN EXISTS (SELECT 1 FROM jmap_keywords k WHERE k.email_id = e.email_id AND k.keyword IN ('$seen','$draft'))
                 THEN 0 ELSE 1 END AS unread,
               EXISTS (SELECT 1 FROM jmap_memberships t JOIN jmap_mailboxes tm ON tm.mailbox_id = t.mailbox_id
                 WHERE t.email_id = e.email_id AND tm.role = 'trash') AS in_trash
             FROM jmap_emails e
           ),
           thread_unread AS (
             SELECT thread_id,
               MAX(CASE WHEN unread = 1 AND in_trash = 0 THEN 1 ELSE 0 END) AS outside_trash,
               MAX(CASE WHEN unread = 1 AND in_trash = 1 THEN 1 ELSE 0 END) AS inside_trash
             FROM em GROUP BY thread_id
           )
           SELECT m.mailbox_id, COUNT(*) AS total, SUM(em.unread) AS unread,
             COUNT(DISTINCT em.thread_id) AS threads,
             COUNT(DISTINCT CASE WHEN (mb.role = 'trash' AND u.inside_trash = 1)
               OR (COALESCE(mb.role, '') <> 'trash' AND u.outside_trash = 1) THEN em.thread_id END) AS unread_threads
           FROM jmap_memberships m JOIN em ON em.email_id = m.email_id
             JOIN jmap_mailboxes mb ON mb.mailbox_id = m.mailbox_id
             JOIN thread_unread u ON u.thread_id = em.thread_id
           GROUP BY m.mailbox_id`,
        )
        .map((r) => [r.mailbox_id, r] as const),
    );

    const subscriptions = new Map(
      this.sql
        .all<{ mailbox_id: string; subscribed: number }>(
          "SELECT mailbox_id, subscribed FROM jmap_subscriptions WHERE principal_id = ?",
          viewer.principalId,
        )
        .map((s) => [s.mailbox_id, s.subscribed === 1]),
    );

    return rows.map((m) => {
      const c = counts.get(m.mailbox_id);

      return {
        id: m.mailbox_id,
        name: m.name,
        parentId: m.parent_id,
        role: m.role,
        sortOrder: Number(m.sort_order),
        totalEmails: Number(c?.total ?? 0),
        unreadEmails: Number(c?.unread ?? 0),
        totalThreads: Number(c?.threads ?? 0),
        unreadThreads: Number(c?.unread_threads ?? 0),
        myRights: this.rights(viewer, m),
        isSubscribed: subscriptions.get(m.mailbox_id) ?? true,
      };
    });
  }

  // ---------------------------------------------------------------- email reads

  private emailRows(ids: ReadonlyArray<string>, viewer: Viewer): ReadonlyArray<EmailRow> {
    const visible = this.visibilityClause(viewer, "e");

    return allInChunks(ids, (chunk) =>
      this.sql.all<EmailRow>(
        `SELECT e.* FROM jmap_emails e WHERE e.email_id IN (${placeholders(chunk.length)}) AND ${visible.sql}`,
        ...chunk,
        ...visible.args,
      ),
    );
  }

  emailRow(id: string): EmailRow | undefined {
    return this.sql.one<EmailRow>("SELECT * FROM jmap_emails WHERE email_id = ?", id);
  }

  memberships(id: string): ReadonlyArray<string> {
    return this.sql
      .all<{ mailbox_id: string }>(
        "SELECT mailbox_id FROM jmap_memberships WHERE email_id = ? ORDER BY mailbox_id",
        id,
      )
      .map((r) => r.mailbox_id);
  }

  keywords(id: string): ReadonlyArray<string> {
    return this.sql
      .all<{ keyword: string }>(
        "SELECT keyword FROM jmap_keywords WHERE email_id = ? ORDER BY keyword",
        id,
      )
      .map((r) => r.keyword);
  }

  emailGet(
    viewer: Viewer,
    ids: ReadonlyArray<string>,
    properties: ReadonlyArray<string>,
  ): EmailPage {
    const rows = new Map(this.emailRows(ids, viewer).map((r) => [r.email_id, r]));
    const list: Array<Schema.JsonObject> = [];
    const notFound: Array<string> = [];

    for (const id of ids) {
      const r = rows.get(id);

      if (!r) {
        notFound.push(id);
        continue;
      }

      list.push(Object.fromEntries(properties.map((p) => [p, this.property(r, p)])));
    }

    return { list, notFound };
  }

  private property(r: EmailRow, p: string): Schema.Json {
    return new EmailView(
      r,
      () => this.memberships(r.email_id),
      () => this.keywords(r.email_id),
    ).property(p);
  }

  /**
   * Search snippets (RFC 8621 §5.1): subject and a body excerpt around the first match, HTML
   * escaped, with every term match wrapped in `<mark>`. Null where nothing matched.
   */
  snippets(
    viewer: Viewer,
    ids: ReadonlyArray<string>,
    terms: ReadonlyArray<string>,
  ): MailReadResult {
    const rows = new Map(this.emailRows(ids, viewer).map((r) => [r.email_id, r]));
    const list: Array<{ emailId: string; subject: string | null; preview: string | null }> = [];

    for (const id of ids) {
      const r = rows.get(id);

      if (!r) continue;

      const body =
        r.quarantined === 1
          ? ""
          : this.sql
              .all<{ body: string }>(
                "SELECT body FROM jmap_fts WHERE email_id = ? ORDER BY chunk",
                id,
              )
              .map((c, i) => (i === 0 ? c.body : c.body.slice(FTS_OVERLAP)))
              .join("");

      list.push({
        emailId: id,
        subject: highlight(r.subject, terms, false),
        preview: highlight(body, terms, true),
      });
    }

    return { _tag: "Snippets", list, notFound: ids.filter((id) => !rows.has(id)) };
  }

  threads(viewer: Viewer, ids: ReadonlyArray<string>): Array<Thread> {
    const visible = this.visibilityClause(viewer, "e");

    const rows = allInChunks(ids, (chunk) =>
      this.sql.all<{ thread_id: string; email_id: string }>(
        `SELECT e.thread_id, e.email_id FROM jmap_emails e
         WHERE e.thread_id IN (${placeholders(chunk.length)}) AND ${visible.sql}
         ORDER BY e.received_at, e.email_id`,
        ...chunk,
        ...visible.args,
      ),
    );

    const byThread = new Map<string, Array<string>>();

    for (const r of rows)
      byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r.email_id]);

    return ids.flatMap((id) => {
      const emailIds = byThread.get(id);

      return emailIds ? [{ id, emailIds }] : [];
    });
  }

  // ---------------------------------------------------------------- query

  query(
    viewer: Viewer,
    q: Extract<MailReadQuery, { readonly _tag: "EmailQuery" }>,
  ): MailReadResult {
    const filter = compileFilter(q.filter);
    const visible = this.visibilityClause(viewer, "e");
    const args = [...visible.args, ...filter.args];

    if (args.length > MAX_BINDINGS)
      return { _tag: "Refused", type: "unsupportedFilter", description: "filter is too complex" };
    const order = orderBy(q.sort);
    const sortArgs = q.sort.flatMap((s) => (s.property === "hasKeyword" ? [s.keyword ?? ""] : []));

    const source = q.collapseThreads
      ? `SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.thread_id ORDER BY ${order}) AS rn
           FROM jmap_emails e WHERE ${visible.sql} AND (${filter.sql})) e WHERE e.rn = 1`
      : `SELECT e.* FROM jmap_emails e WHERE ${visible.sql} AND (${filter.sql})`;

    const bindings = q.collapseThreads ? [...sortArgs, ...args] : args;
    const state = this.state("Email");

    if (q.anchor !== null) {
      const ids = this.sql
        .all<{ email_id: string }>(
          `WITH matched AS (${source}) SELECT e.email_id FROM matched e ORDER BY ${order}`,
          ...bindings,
          ...sortArgs,
        )
        .map((r) => r.email_id);

      const at = ids.indexOf(q.anchor);

      if (at < 0)
        return { _tag: "EmailQuery", state, ids: [], position: 0, total: null, anchorFound: false };
      const start = Math.max(0, at + q.anchorOffset);

      return {
        _tag: "EmailQuery",
        state,
        ids: ids.slice(start, start + q.limit),
        position: start,
        total: q.calculateTotal ? ids.length : null,
        anchorFound: true,
      };
    }

    const total =
      q.calculateTotal || q.position < 0
        ? Number(
            this.sql.one<{ n: number }>(
              `WITH matched AS (${source}) SELECT COUNT(*) AS n FROM matched`,
              ...bindings,
            )?.n ?? 0,
          )
        : null;

    const start = q.position < 0 ? Math.max(0, (total ?? 0) + q.position) : q.position;

    const ids = this.sql
      .all<{ email_id: string }>(
        `WITH matched AS (${source}) SELECT e.email_id FROM matched e ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...bindings,
        ...sortArgs,
        q.limit,
        start,
      )
      .map((r) => r.email_id);

    return {
      _tag: "EmailQuery",
      state,
      ids,
      position: start,
      total: q.calculateTotal ? total : null,
      anchorFound: true,
    };
  }

  // ---------------------------------------------------------------- blobs

  registerBlob(blob: {
    readonly blobId: string;
    readonly bucket: "originals" | "parts";
    readonly r2Key: string;
    readonly size: number;
    readonly type: string;
    readonly expiresAt: number | null;
  }): void {
    if (
      this.sql.one(
        "SELECT 1 AS x FROM jmap_gc_claims WHERE r2_key = ? AND at > ?",
        blob.r2Key,
        this.clock.now() - GC_CLAIM_MS,
      ) !== undefined
    )
      throw new BlobCollecting(blob.r2Key);

    this.sql.run(
      `INSERT INTO jmap_blobs (blob_id, bucket, r2_key, size, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (blob_id) DO UPDATE SET expires_at = CASE
         WHEN excluded.expires_at IS NULL OR jmap_blobs.expires_at IS NULL THEN NULL
         ELSE MAX(jmap_blobs.expires_at, excluded.expires_at) END`,
      blob.blobId,
      blob.bucket,
      blob.r2Key,
      blob.size,
      blob.type,
      this.clock.now(),
      blob.expiresAt,
    );
  }

  /**
   * Expired upload/copy blobs that nothing else pins (B3 staged cleanup): their rows go, and the
   * caller deletes the bytes. A blob pinned by an Email, submission or recovery owner is kept.
   */
  expiredBlobs(
    now: number,
    limit = 100,
  ): ReadonlyArray<{
    readonly blobId: string;
    readonly bucket: "originals" | "parts";
    readonly r2Key: string;
  }> {
    const rows = this.sql.all<{ blob_id: string; bucket: "originals" | "parts"; r2_key: string }>(
      `SELECT b.blob_id, b.bucket, b.r2_key FROM jmap_blobs b
       WHERE b.expires_at IS NOT NULL AND b.expires_at < ?
         AND NOT EXISTS (SELECT 1 FROM jmap_blob_pins p WHERE p.blob_id = b.blob_id
           AND p.owner NOT LIKE 'upload:%' AND p.owner NOT LIKE 'copy:%')
         AND NOT EXISTS (SELECT 1 FROM jmap_emails e WHERE e.blob_id = b.blob_id)
       LIMIT ?`,
      now,
      limit,
    );

    this.sql.tx(() => {
      for (const r of rows) {
        this.sql.run("DELETE FROM jmap_blob_pins WHERE blob_id = ?", r.blob_id);
        this.sql.run("DELETE FROM jmap_blobs WHERE blob_id = ?", r.blob_id);
      }
    });

    return rows.map((r) => ({ blobId: r.blob_id, bucket: r.bucket, r2Key: r.r2_key }));
  }

  pin(blobId: string, owner: string): void {
    this.sql.run(
      "INSERT OR IGNORE INTO jmap_blob_pins (blob_id, owner, created_at) VALUES (?, ?, ?)",
      blobId,
      owner,
      this.clock.now(),
    );
  }

  /**
   * Drop one owner's pins. A blob that no Email and no durable owner (submission, recovery) still
   * holds becomes collectable: its row expires, and housekeeping hands its bytes to blob GC. An
   * upload or copy pin keeps it only for the rest of its upload lifetime.
   */
  unpin(owner: string): void {
    const blobs = this.sql.all<{ blob_id: string }>(
      "SELECT blob_id FROM jmap_blob_pins WHERE owner = ?",
      owner,
    );

    this.sql.run("DELETE FROM jmap_blob_pins WHERE owner = ?", owner);

    for (const { blob_id } of blobs)
      this.sql.run(
        `UPDATE jmap_blobs SET expires_at = MAX(?, created_at + ?) WHERE blob_id = ? AND expires_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM jmap_blob_pins p WHERE p.blob_id = jmap_blobs.blob_id
             AND p.owner NOT LIKE 'upload:%' AND p.owner NOT LIKE 'copy:%')
           AND NOT EXISTS (SELECT 1 FROM jmap_emails e WHERE e.blob_id = jmap_blobs.blob_id)`,
        this.clock.now(),
        BLOB_UPLOAD_TTL_MS,
        blob_id,
      );
  }

  blob(blobId: string):
    | {
        readonly blobId: string;
        readonly bucket: "originals" | "parts";
        readonly r2Key: string;
        readonly size: number;
        readonly type: string;
      }
    | undefined {
    const row = this.sql.one<{
      blob_id: string;
      bucket: "originals" | "parts";
      r2_key: string;
      size: number;
      type: string;
    }>("SELECT blob_id, bucket, r2_key, size, type FROM jmap_blobs WHERE blob_id = ?", blobId);

    return row
      ? {
          blobId: row.blob_id,
          bucket: row.bucket,
          r2Key: row.r2_key,
          size: Number(row.size),
          type: row.type,
        }
      : undefined;
  }

  /**
   * Whether a viewer may read a blob, and whether quarantine/scan gates allow its bytes (A3): a
   * message blob is readable through any Email the viewer can see; an upload by its uploader.
   */
  blobAccess(viewer: Viewer, blobId: string): BlobAccess {
    const part = parsePartBlobId(blobId);
    const messageBlob = Option.isSome(part) ? part.value.blobId : blobId;
    const visible = this.visibilityClause(viewer, "e");

    const email = this.sql.one<{ scan_status: string; quarantined: number }>(
      `SELECT e.scan_status, e.quarantined FROM jmap_emails e WHERE e.blob_id = ? AND ${visible.sql} LIMIT 1`,
      messageBlob,
      ...visible.args,
    );

    if (email) {
      const okScan = ["clean", "not-required", "legacy"].includes(email.scan_status);

      return {
        visible: true,
        allowed: email.quarantined !== 1 && okScan,
        status: email.quarantined === 1 ? "quarantined" : email.scan_status,
      };
    }

    const upload = this.sql.one(
      "SELECT 1 AS x FROM jmap_blob_pins WHERE blob_id = ? AND owner = ?",
      blobId,
      `upload:${viewer.principalId}`,
    );

    return upload !== undefined
      ? { visible: true, allowed: true, status: "upload" }
      : { visible: false, allowed: false, status: "missing" };
  }

  // ---------------------------------------------------------------- threading (A2)

  /**
   * Versioned deterministic threading: compatible normalized subject plus a known reference,
   * rightmost References entry first, then In-Reply-To; duplicate candidates resolve by
   * first-seen order then ID. A bridge reply joins one Thread and never reassigns older Emails.
   */
  resolveThread(email: PreparedEmail): string | undefined {
    const base = normalizeSubject(email.subject);

    const candidates = [...(email.references ?? [])].reverse().concat(email.inReplyTo ?? []);

    for (const msgId of candidates) {
      const match = this.sql.one<{ thread_id: string }>(
        `SELECT m.thread_id FROM jmap_message_ids m JOIN jmap_emails e ON e.email_id = m.email_id
         WHERE m.message_id = ? AND e.base_subject = ? ORDER BY m.first_seen, m.email_id LIMIT 1`,
        msgId,
        base,
      );

      if (match) return match.thread_id;
    }

    return undefined;
  }

  // ---------------------------------------------------------------- publication

  private seen(): number {
    const n = this.meta<number>("firstSeen", 0) + 1;
    this.putMeta("firstSeen", n);

    return n;
  }

  /**
   * Publish one Email (inside a History transaction): metadata, memberships, keywords, thread,
   * message-ID index, search chunks, blob pin and typed history together (§4).
   */
  publish(input: {
    readonly emailId: string;
    readonly content: PreparedContent;
    readonly mailboxIds: ReadonlyArray<string>;
    readonly keywords: ReadonlyArray<string>;
    readonly receivedAt: number;
    /** When the Email entered its Mailboxes (retention clock); defaults to `receivedAt`. */
    readonly placedAt?: number;
    readonly threadId?: string;
    readonly scanStatus?: string;
    readonly quarantined?: boolean;
    readonly legacyDeliveryId?: string;
  }): Published {
    const e = input.content.email;
    const firstSeen = this.seen();
    const existingThread = input.threadId ?? this.resolveThread(e);
    const threadId = existingThread ?? this.clock.id("thr");

    if (!existingThread || input.threadId) {
      const created =
        this.sql.run(
          "INSERT OR IGNORE INTO jmap_threads (thread_id, threading_version, created_rev) VALUES (?, ?, 0)",
          threadId,
          THREADING_VERSION,
        ) > 0;

      this.history.record("Thread", threadId, created ? "created" : "updated");
    } else this.history.record("Thread", threadId, "updated");

    this.registerBlob({
      blobId: input.content.blobId,
      bucket: input.content.bucket,
      r2Key: input.content.r2Key,
      size: e.size,
      type: input.content.type,
      expiresAt: null,
    });
    this.pin(input.content.blobId, `email:${input.emailId}`);

    const body: StoredBody = {
      structure: e.bodyStructure,
      textBody: e.textBody,
      htmlBody: e.htmlBody,
      attachments: e.attachments,
    };

    this.sql.run(
      `INSERT INTO jmap_emails (email_id, blob_id, thread_id, size, received_at, sent_at, message_id, in_reply_to, refs,
         sender, from_json, to_json, cc_json, bcc_json, reply_to_json, subject, base_subject, preview, has_attachment,
         headers_json, body_json, scan_status, quarantined, placement_version, first_seen, legacy_delivery_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      input.emailId,
      input.content.blobId,
      threadId,
      e.size,
      input.receivedAt,
      e.sentAt,
      jsonOrNull(e.messageId),
      jsonOrNull(e.inReplyTo),
      jsonOrNull(e.references),
      jsonOrNull(e.sender),
      jsonOrNull(e.from),
      jsonOrNull(e.to),
      jsonOrNull(e.cc),
      jsonOrNull(e.bcc),
      jsonOrNull(e.replyTo),
      e.subject,
      normalizeSubject(e.subject),
      e.preview.slice(0, PREVIEW_MAX),
      e.hasAttachment ? 1 : 0,
      JSON.stringify(e.headers),
      JSON.stringify(body),
      input.scanStatus ?? (e.attachments.length > 0 ? "pending" : "not-required"),
      input.quarantined ? 1 : 0,
      firstSeen,
      input.legacyDeliveryId ?? null,
    );

    for (const id of e.messageId ?? [])
      this.sql.run(
        "INSERT OR IGNORE INTO jmap_message_ids (message_id, email_id, thread_id, first_seen) VALUES (?, ?, ?, ?)",
        id,
        input.emailId,
        threadId,
        firstSeen,
      );

    for (const m of new Set(input.mailboxIds)) {
      this.sql.run(
        "INSERT INTO jmap_memberships (email_id, mailbox_id, added_at) VALUES (?, ?, ?)",
        input.emailId,
        m,
        input.placedAt ?? input.receivedAt,
      );
      this.history.record("Mailbox", m, "updated");
    }

    for (const k of new Set(input.keywords))
      this.sql.run("INSERT INTO jmap_keywords (email_id, keyword) VALUES (?, ?)", input.emailId, k);

    this.indexText(input.emailId, e);
    this.history.record("Email", input.emailId, "created");

    return { emailId: input.emailId, threadId };
  }

  /** Canonical search chunks (D2): overlapping, never truncated. */
  private indexText(emailId: string, e: PreparedEmail): void {
    const addresses = [e.from, e.to, e.cc, e.bcc]
      .flatMap((list) => list ?? [])
      .map((a) => `${a.name ?? ""} ${a.email}`)
      .join(" ");

    const text = e.text;
    const step = FTS_CHUNK - FTS_OVERLAP;
    let chunk = 0;

    for (let i = 0; i === 0 || i < text.length; i += step) {
      this.sql.run(
        "INSERT INTO jmap_fts (email_id, chunk, subject, addresses, body) VALUES (?, ?, ?, ?, ?)",
        emailId,
        chunk,
        chunk === 0 ? e.subject : "",
        chunk === 0 ? addresses : "",
        text.slice(i, i + FTS_CHUNK),
      );
      chunk++;
    }
  }

  /** Destroy an Email across all memberships; its submission/recovery pins are untouched (A1). */
  destroyEmail(emailId: string): void {
    const row = this.emailRow(emailId);

    if (!row) return;

    for (const m of this.memberships(emailId)) this.history.record("Mailbox", m, "updated");
    this.sql.run("DELETE FROM jmap_memberships WHERE email_id = ?", emailId);
    this.sql.run("DELETE FROM jmap_keywords WHERE email_id = ?", emailId);
    this.sql.run("DELETE FROM jmap_message_ids WHERE email_id = ?", emailId);
    this.sql.run("DELETE FROM jmap_fts WHERE email_id = ?", emailId);
    this.sql.run("DELETE FROM jmap_emails WHERE email_id = ?", emailId);
    this.unpin(`email:${emailId}`);
    this.history.record("Email", emailId, "destroyed");

    const remaining = this.sql.one(
      "SELECT 1 AS x FROM jmap_emails WHERE thread_id = ? LIMIT 1",
      row.thread_id,
    );

    if (remaining) this.history.record("Thread", row.thread_id, "updated");
    else {
      this.sql.run("DELETE FROM jmap_threads WHERE thread_id = ?", row.thread_id);
      this.history.record("Thread", row.thread_id, "destroyed");
    }
  }

  /**
   * Retention on the core (E24 after C3): an Email leaves Trash after 30 days and Spam or
   * Screened Out after 90, counted from when it entered. With recycling on, a whole thread goes
   * once nothing in it has arrived or moved since the cutoff — as legacy recycling decided per
   * thread: none of its mail flagged, a draft, or in any Mailbox other than Inbox, Archive, Sent
   * and the workflow Mailboxes, and its legacy thread has no note, collection, Reply Later, Set
   * Aside or follow-up. One bounded batch; a backlog continues from a scheduled job.
   */
  sweepRetention(
    now: number,
    recycleDays: number | null,
    limit = JMAP_RETENTION_BATCH,
  ): RetentionBatch {
    const t = this.workflowTargets();
    // Memberships from before placement times were recorded count from the upgrade.
    const from = this.meta<number>("retentionFrom", 0);

    const windows = [
      [this.roleMailbox("trash"), RETENTION.trashMs],
      [this.roleMailbox("junk"), RETENTION.spamMs],
      [t.screenedOut, RETENTION.screenedOutMs],
    ].flatMap(([id, ms]) => (Predicate.isString(id) ? [[id, now - Number(ms)] as const] : []));

    const ids = new Set<string>();

    for (const [mailboxId, cutoff] of windows)
      for (const r of this.sql.all<{ email_id: string }>(
        `SELECT email_id FROM jmap_memberships
         WHERE mailbox_id = ? AND COALESCE(added_at, ?) < ? ORDER BY email_id LIMIT ?`,
        mailboxId,
        from,
        cutoff,
        limit + 1 - ids.size,
      ))
        ids.add(r.email_id);

    let more = ids.size > limit;
    const batch = new Set([...ids].slice(0, limit));

    // Whole threads only: the last one may take the batch past `limit`, never split it.
    if (!more && recycleDays !== null && recycleDays > 0) {
      const recycled = this.recyclable(
        now - recycleDays * 24 * 3600 * 1000,
        from,
        limit - batch.size,
      );

      for (const id of recycled.ids) batch.add(id);
      more = recycled.more;
    }

    if (batch.size > 0)
      this.history.tx(() => {
        for (const id of batch) this.destroyEmail(id);
        this.audit("retention", String(batch.size), "emails purged by retention");
      });

    if (more) this.schedule(RETENTION_JOB, "sweep", now);

    return { deleted: batch.size, more };
  }

  /**
   * Emails of recyclable threads, whole threads until at least `limit` (`more` when it stopped
   * there). Bounded per call: it walks at most
   * {@link RECYCLE_SCAN} old Emails from a persisted cursor (wrapping around), checks each of
   * their threads once, and never scans the whole account in one sweep.
   */
  private recyclable(cutoff: number, from: number, limit: number): RecycleBatch {
    // Every membership older than the upgrade counts from it: nothing can qualify before then.
    if (cutoff < from) return { ids: [], more: false };

    if (limit <= 0) return { ids: [], more: true };

    const cursor = this.meta<{ readonly r: number; readonly id: string } | null>(
      "recycleCursor",
      null,
    );

    const rows = this.sql.all<{ email_id: string; thread_id: string; received_at: number }>(
      `SELECT email_id, thread_id, received_at FROM jmap_emails
       WHERE received_at < ? ${cursor ? "AND (received_at > ? OR (received_at = ? AND email_id > ?))" : ""}
       ORDER BY received_at, email_id LIMIT ?`,
      cutoff,
      ...(cursor ? [cursor.r, cursor.r, cursor.id] : []),
      RECYCLE_SCAN,
    );

    const t = this.workflowTargets();

    const kept = JSON.stringify(
      [
        this.roleMailbox("inbox"),
        this.roleMailbox("archive"),
        this.roleMailbox("sent"),
        t.feed,
        t.paperTrail,
      ].filter(Predicate.isString),
    );

    const out: Array<string> = [];
    const seen = new Set<string>();
    let complete = true;

    for (const row of rows) {
      if (seen.has(row.thread_id)) continue;
      seen.add(row.thread_id);

      if (out.length >= limit) {
        complete = false;
        break;
      }

      if (this.threadRecyclable(row.thread_id, cutoff, from, kept))
        out.push(...this.threadEmailIds(row.thread_id));
    }

    // Wrap once the old end is reached; stay put when the batch filled (the rest comes next).
    const last = rows.at(-1);

    if (complete)
      this.putMeta(
        "recycleCursor",
        rows.length < RECYCLE_SCAN || !last
          ? null
          : { r: Number(last.received_at), id: last.email_id },
      );

    return { ids: out, more: !complete };
  }

  private threadRecyclable(threadId: string, cutoff: number, from: number, kept: string): boolean {
    return (
      this.sql.one(
        `SELECT 1 AS x WHERE
           NOT EXISTS (SELECT 1 FROM jmap_emails a JOIN jmap_memberships m ON m.email_id = a.email_id
             WHERE a.thread_id = ? AND (a.received_at >= ? OR COALESCE(m.added_at, ?) >= ?
               OR m.mailbox_id NOT IN (SELECT value FROM json_each(?))))
           AND NOT EXISTS (SELECT 1 FROM jmap_emails a JOIN jmap_keywords k ON k.email_id = a.email_id
             WHERE a.thread_id = ? AND k.keyword IN ('$flagged', '$draft'))
           AND NOT EXISTS (SELECT 1 FROM jmap_emails a JOIN deliveries d ON d.delivery_id = a.legacy_delivery_id
             WHERE a.thread_id = ? AND (
               EXISTS (SELECT 1 FROM notes n WHERE n.thread_id = d.thread_id)
               OR EXISTS (SELECT 1 FROM collection_items c WHERE c.thread_id = d.thread_id)
               OR EXISTS (SELECT 1 FROM threads l WHERE l.thread_id = d.thread_id
                 AND (l.reply_later = 1 OR l.set_aside = 1 OR l.bubble_tag <> 'None'))))`,
        threadId,
        cutoff,
        from,
        cutoff,
        kept,
        threadId,
        threadId,
      ) !== undefined
    );
  }

  /**
   * Replace an Email's memberships and/or keywords (C1 dependencies): Email always; Mailbox
   * counts for every Mailbox whose membership changed, and for all of the Email's Mailboxes when
   * `$seen`/`$draft` changed; Thread never (its Email list didn't change).
   */
  applyState(
    emailId: string,
    next: {
      readonly mailboxIds?: ReadonlyArray<string>;
      readonly keywords?: ReadonlyArray<string>;
    },
  ): void {
    const beforeBoxes = this.memberships(emailId);
    const beforeKeywords = this.keywords(emailId);
    const boxes = next.mailboxIds ?? beforeBoxes;
    const keywords = next.keywords ?? beforeKeywords;
    const touched = new Set<string>();

    if (next.mailboxIds) {
      for (const m of beforeBoxes)
        if (!boxes.includes(m)) {
          this.sql.run(
            "DELETE FROM jmap_memberships WHERE email_id = ? AND mailbox_id = ?",
            emailId,
            m,
          );
          touched.add(m);
        }

      for (const m of boxes)
        if (!beforeBoxes.includes(m)) {
          this.sql.run(
            "INSERT INTO jmap_memberships (email_id, mailbox_id, added_at) VALUES (?, ?, ?)",
            emailId,
            m,
            this.clock.now(),
          );
          touched.add(m);
        }

      if (touched.size > 0)
        this.sql.run(
          "UPDATE jmap_emails SET placement_version = placement_version + 1 WHERE email_id = ?",
          emailId,
        );
    }

    const countKeywords = ["$seen", "$draft"];

    if (next.keywords) {
      this.sql.run("DELETE FROM jmap_keywords WHERE email_id = ?", emailId);

      for (const k of new Set(keywords))
        this.sql.run("INSERT INTO jmap_keywords (email_id, keyword) VALUES (?, ?)", emailId, k);

      const countChanged = countKeywords.some(
        (k) => beforeKeywords.includes(k) !== keywords.includes(k),
      );

      if (countChanged) for (const m of new Set([...beforeBoxes, ...boxes])) touched.add(m);
    }

    for (const m of touched) this.history.record("Mailbox", m, "updated");
    this.history.record("Email", emailId, "updated");
  }

  // ---------------------------------------------------------------- Mailbox/set

  mailboxSet(viewer: Viewer, cmd: SetCommand): MailWriteResult {
    const oldState = this.state("Mailbox");

    if (cmd.ifInState !== null && cmd.ifInState !== oldState.revision) return STATE_MISMATCH;
    const created: Array<readonly [string, Schema.JsonObject]> = [];
    const notCreated: Array<readonly [string, SetError]> = [];
    const updated: Array<readonly [string, Schema.JsonObject | null]> = [];
    const notUpdated: Array<readonly [string, SetError]> = [];
    const destroyed: Array<string> = [];
    const notDestroyed: Array<readonly [string, SetError]> = [];
    const known = [...cmd.createdIds];
    const resolve = (id: string) => idResolver(known)(id);

    for (const [cid, obj] of cmd.create) {
      const r = this.history.tx(() => this.createMailbox(viewer, obj, resolve));

      if (Result.isSuccess(r)) {
        created.push([cid, r.success]);
        known.push([cid, Predicate.isString(r.success["id"]) ? r.success["id"] : ""]);
      } else notCreated.push([cid, r.failure]);
    }

    for (const [id, patch] of cmd.update) {
      const r = this.history.tx(() => this.updateMailbox(viewer, id, patch, resolve));

      if (Result.isSuccess(r)) updated.push([id, null]);
      else notUpdated.push([id, r.failure]);
    }

    const removeEmails = cmd.options["onDestroyRemoveEmails"] === true;

    for (const id of cmd.destroy) {
      const r = this.history.tx(() => this.destroyMailbox(viewer, id, removeEmails));

      if (Result.isSuccess(r)) destroyed.push(id);
      else notDestroyed.push([id, r.failure]);
    }

    return {
      _tag: "Set",
      oldState,
      newState: this.state("Mailbox"),
      created,
      updated,
      destroyed,
      notCreated,
      notUpdated,
      notDestroyed,
    };
  }

  private validMailboxName(name: Schema.Json | undefined): name is string {
    return Predicate.isString(name) && name.trim().length > 0 && name.length <= MAX_MAILBOX_NAME;
  }

  private nameTaken(name: string, parentId: string | null, except?: string): boolean {
    return (
      this.sql.one(
        "SELECT 1 AS x FROM jmap_mailboxes WHERE lower(name) = lower(?) AND parent_id IS ? AND mailbox_id IS NOT ?",
        name,
        parentId,
        except ?? null,
      ) !== undefined
    );
  }

  private createMailbox(
    viewer: Viewer,
    obj: Schema.JsonObject,
    resolve: (id: string) => Option.Option<string>,
  ): Result.Result<Schema.JsonObject, SetError> {
    const allowed = ["name", "parentId", "role", "sortOrder", "isSubscribed"];

    const bad = Object.keys(obj).filter(
      (k) => !allowed.includes(k) && !SERVER_SET_MAILBOX.includes(k),
    );

    if (bad.length > 0) return Result.fail(setError("invalidProperties", undefined, bad));

    if (!this.validMailboxName(obj["name"]))
      return Result.fail(setError("invalidProperties", "name required", ["name"]));
    const parentRaw = obj["parentId"] ?? null;
    let parentId: string | null = null;

    if (parentRaw !== null) {
      const resolved = Predicate.isString(parentRaw) ? resolve(parentRaw) : Option.none();

      if (Option.isNone(resolved) || !this.mailboxRow(resolved.value))
        return Result.fail(setError("invalidProperties", "unknown parent", ["parentId"]));
      parentId = resolved.value;
    }

    const parentRights = parentId
      ? this.rights(viewer, this.mailboxRow(parentId)!)
      : (this.grants(viewer.principalId).get("*") ?? NO_RIGHTS);

    if (!parentRights.mayCreateChild) return Result.fail(setError("forbidden"));

    if (this.nameTaken(obj["name"], parentId))
      return Result.fail(setError("invalidProperties", "name already used", ["name"]));
    const role = obj["role"] ?? null;

    if (
      role !== null &&
      (!Predicate.isString(role) || !MAILBOX_ROLES.includes(role as MailboxRole))
    )
      return Result.fail(setError("invalidProperties", "unknown role", ["role"]));

    if (role !== null && this.roleMailbox(role as MailboxRole))
      return Result.fail(setError("invalidProperties", "role already assigned", ["role"]));
    const sortOrder = obj["sortOrder"] ?? 0;

    if (!Predicate.isNumber(sortOrder) || !Number.isSafeInteger(sortOrder) || sortOrder < 0)
      return Result.fail(setError("invalidProperties", undefined, ["sortOrder"]));
    const id = this.clock.id("mbx");

    this.sql.run(
      "INSERT INTO jmap_mailboxes (mailbox_id, name, parent_id, role, sort_order, created_rev) VALUES (?, ?, ?, ?, ?, 0)",
      id,
      obj["name"].trim(),
      parentId,
      role,
      sortOrder,
    );

    if (obj["isSubscribed"] === false) this.setSubscribed(viewer, id, false);
    this.history.record("Mailbox", id, "created");
    const m = this.mailboxes(viewer).find((x) => x.id === id);

    return Result.succeed({
      id,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      myRights: { ...(m?.myRights ?? FULL_RIGHTS) },
      isSubscribed: m?.isSubscribed ?? true,
    });
  }

  private setSubscribed(viewer: Viewer, mailboxId: string, subscribed: boolean): void {
    this.sql.run(
      `INSERT INTO jmap_subscriptions (principal_id, mailbox_id, subscribed) VALUES (?, ?, ?)
       ON CONFLICT (principal_id, mailbox_id) DO UPDATE SET subscribed = excluded.subscribed`,
      viewer.principalId,
      mailboxId,
      subscribed ? 1 : 0,
    );
  }

  private updateMailbox(
    viewer: Viewer,
    id: string,
    patch: Schema.JsonObject,
    resolve: (id: string) => Option.Option<string>,
  ): Result.Result<void, SetError> {
    const row = this.mailboxRow(id);

    if (!row || !this.rights(viewer, row).mayReadItems) return Result.fail(setError("notFound"));

    const parsed = parseFlatPatch(
      patch,
      ["name", "parentId", "sortOrder", "isSubscribed", "role"],
      SERVER_SET_MAILBOX,
    );

    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const p = parsed.success;
    const rights = this.rights(viewer, row);

    const changesDefinition = ["name", "parentId", "sortOrder", "role"].some((k) =>
      Object.hasOwn(p, k),
    );

    if (changesDefinition && !rights.mayRename) return Result.fail(setError("forbidden"));
    let name = row.name;
    let parentId = row.parent_id;

    if (Object.hasOwn(p, "name")) {
      if (!this.validMailboxName(p["name"]))
        return Result.fail(setError("invalidProperties", undefined, ["name"]));
      name = p["name"].trim();
    }

    if (Object.hasOwn(p, "parentId")) {
      const raw = p["parentId"] ?? null;

      if (raw === null) parentId = null;
      else {
        const resolved = Predicate.isString(raw) ? resolve(raw) : Option.none();

        if (
          Option.isNone(resolved) ||
          !this.mailboxRow(resolved.value) ||
          this.isDescendant(resolved.value, id)
        )
          return Result.fail(setError("invalidProperties", "invalid parent", ["parentId"]));
        parentId = resolved.value;
      }
    }

    if (this.nameTaken(name, parentId, id))
      return Result.fail(setError("invalidProperties", "name already used", ["name"]));
    let role = row.role;

    if (Object.hasOwn(p, "role")) {
      const next = p["role"] ?? null;

      if (
        next !== null &&
        (!Predicate.isString(next) || !MAILBOX_ROLES.includes(next as MailboxRole))
      )
        return Result.fail(setError("invalidProperties", "unknown role", ["role"]));
      const holder = next === null ? undefined : this.roleMailbox(next as MailboxRole);

      if (holder !== undefined && holder !== id)
        return Result.fail(setError("invalidProperties", "role already assigned", ["role"]));
      role = next as MailboxRole | null;
    }

    let sortOrder = Number(row.sort_order);

    if (Object.hasOwn(p, "sortOrder")) {
      const v = p["sortOrder"];

      if (!Predicate.isNumber(v) || !Number.isSafeInteger(v) || v < 0)
        return Result.fail(setError("invalidProperties", undefined, ["sortOrder"]));
      sortOrder = v;
    }

    const subscribed = p["isSubscribed"];

    // Every property is validated before anything is written: a refused patch changes nothing.
    if (Object.hasOwn(p, "isSubscribed") && !Predicate.isBoolean(subscribed))
      return Result.fail(setError("invalidProperties", undefined, ["isSubscribed"]));

    // Rename preserves the ID; workflow configuration follows the ID, never the name (A1).
    this.sql.run(
      "UPDATE jmap_mailboxes SET name = ?, parent_id = ?, role = ?, sort_order = ? WHERE mailbox_id = ?",
      name,
      parentId,
      role,
      sortOrder,
      id,
    );

    if (Predicate.isBoolean(subscribed)) this.setSubscribed(viewer, id, subscribed);

    this.history.record("Mailbox", id, "updated");

    return Result.succeed(undefined);
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let cur: string | null = candidate;

    for (let i = 0; cur !== null && i < 64; i++) {
      if (cur === ancestor) return true;
      cur = this.mailboxRow(cur)?.parent_id ?? null;
    }

    return false;
  }

  /**
   * Standard `Mailbox/set` destroy (RFC 8621 §2.5) including `onDestroyRemoveEmails`. A deleted
   * workflow target disables the rules/timers that pointed at it with a visible reason; nothing is
   * recreated or retargeted by name (A1).
   */
  private destroyMailbox(
    viewer: Viewer,
    id: string,
    removeEmails: boolean,
  ): Result.Result<void, SetError> {
    const row = this.mailboxRow(id);

    if (!row || !this.rights(viewer, row).mayReadItems) return Result.fail(setError("notFound"));

    if (!this.rights(viewer, row).mayDelete) return Result.fail(setError("forbidden"));

    if (this.sql.one("SELECT 1 AS x FROM jmap_mailboxes WHERE parent_id = ? LIMIT 1", id))
      return Result.fail(setError("mailboxHasChild"));

    const emails = this.sql
      .all<{ email_id: string }>("SELECT email_id FROM jmap_memberships WHERE mailbox_id = ?", id)
      .map((r) => r.email_id);

    if (emails.length > 0 && !removeEmails) return Result.fail(setError("mailboxHasEmail"));

    for (const emailId of emails) {
      const others = this.memberships(emailId).filter((m) => m !== id);

      // An Email left in no Mailbox is destroyed (the standard cascade).
      if (others.length === 0) this.destroyEmail(emailId);
      else this.applyState(emailId, { mailboxIds: others });
    }

    this.sql.run("DELETE FROM jmap_mailboxes WHERE mailbox_id = ?", id);
    this.sql.run("DELETE FROM jmap_subscriptions WHERE mailbox_id = ?", id);
    this.sql.run("DELETE FROM jmap_grants WHERE mailbox_id = ?", id);
    this.history.record("Mailbox", id, "destroyed");
    const targets = this.workflowTargets();

    for (const key of WORKFLOW_TARGETS)
      if (targets[key] === id) {
        this.putMeta(
          "workflowTargets",
          Object.fromEntries(
            Object.entries(this.workflowTargets()).flatMap(([k, v]) =>
              k === key || v === undefined ? [] : [[k, v]],
            ),
          ),
        );
        this.audit("workflow-target", key, `deleted mailbox ${id}; routing to ${key} disabled`);
      }

    this.disableTimersTargeting(id);

    return Result.succeed(undefined);
  }

  private disableTimersTargeting(mailboxId: string): void {
    for (const t of this.sql.all<{ timer_id: string; action: string }>(
      "SELECT timer_id, action FROM jmap_timers WHERE state = 'armed'",
    )) {
      if (t.action.includes(`"${mailboxId}"`))
        this.sql.run(
          "UPDATE jmap_timers SET state = 'disabled', reason = ? WHERE timer_id = ?",
          `target mailbox ${mailboxId} was deleted`,
          t.timer_id,
        );
    }
  }

  // ---------------------------------------------------------------- Email/set

  /** Check the rights a membership/keyword change needs on every affected Mailbox (A3). */
  private mayChange(
    viewer: Viewer,
    before: { readonly boxes: ReadonlyArray<string>; readonly keywords: ReadonlyArray<string> },
    after: { readonly boxes: ReadonlyArray<string>; readonly keywords: ReadonlyArray<string> },
  ): boolean {
    const rightsOf = (id: string) => {
      const row = this.mailboxRow(id);

      return row ? this.rights(viewer, row) : NO_RIGHTS;
    };

    for (const m of after.boxes)
      if (!before.boxes.includes(m) && !rightsOf(m).mayAddItems) return false;

    // Moving existing mail into Trash is a removal (MoveToTrash): `delete` only.
    if (viewer.mayTrash === false && before.boxes.length > 0) {
      const trash = this.roleMailbox("trash");

      if (trash !== undefined && after.boxes.includes(trash) && !before.boxes.includes(trash))
        return false;
    }

    for (const m of before.boxes)
      if (!after.boxes.includes(m) && !rightsOf(m).mayRemoveItems) return false;

    const changed = [
      ...after.keywords.filter((k) => !before.keywords.includes(k)),
      ...before.keywords.filter((k) => !after.keywords.includes(k)),
    ];

    if (changed.length === 0) return true;
    const boxes = after.boxes.length > 0 ? after.boxes : before.boxes;

    return changed.every((k) =>
      boxes.some((m) => (k === "$seen" ? rightsOf(m).maySetSeen : rightsOf(m).maySetKeywords)),
    );
  }

  private checkMailboxes(ids: ReadonlyArray<string>): Option.Option<SetError> {
    if (ids.length === 0)
      return Option.some(
        setError("invalidProperties", "an Email needs at least one Mailbox", ["mailboxIds"]),
      );

    for (const id of ids)
      if (!this.mailboxRow(id))
        return Option.some(setError("invalidProperties", `unknown mailbox ${id}`, ["mailboxIds"]));

    return Option.none();
  }

  private checkKeywords(keywords: ReadonlyArray<string>): Option.Option<SetError> {
    for (const k of keywords) {
      if (Option.isNone(normalizeKeyword(k)) || SERVER_KEYWORDS.has(k))
        return Option.some(setError("invalidProperties", `invalid keyword ${k}`, ["keywords"]));
    }

    return Option.none();
  }

  /**
   * One Email as the delivery topics' consumers see a legacy delivery (notification, calendar
   * invitations, shared-space propagation): addresses, subject, preview and its original's key.
   */
  emailSummary(emailId: string):
    | {
        readonly emailId: string;
        readonly threadId: string;
        readonly from: EmailAddress;
        readonly to: ReadonlyArray<EmailAddress>;
        readonly cc: ReadonlyArray<EmailAddress>;
        readonly subject: string;
        readonly preview: string;
        readonly sentAt: number;
        readonly contentKey: string;
      }
    | undefined {
    const row = this.emailRow(emailId);

    if (!row) return undefined;

    const addresses = (value: string | null): ReadonlyArray<EmailAddress> =>
      json<ReadonlyArray<{ readonly name?: string | null; readonly email?: string }>>(
        value,
        [],
      ).map((a) => ({ name: a.name ?? undefined, address: a.email ?? "" }));

    return {
      emailId,
      threadId: row.thread_id,
      from: addresses(row.from_json)[0] ?? { name: undefined, address: "" },
      to: addresses(row.to_json),
      cc: addresses(row.cc_json),
      subject: row.subject,
      preview: row.preview,
      sentAt: row.sent_at ?? row.received_at,
      contentKey: this.blob(row.blob_id)?.r2Key ?? "",
    };
  }

  /**
   * One page of every Email (any Mailbox) for export, in stable (receivedAt, ID) order, never
   * silently capped (A04 on the core): a migrated account exports its current mail, not the
   * frozen legacy rows.
   */
  exportManifestPage(cursor: string | null, limit = 500): ExportManifestPageResult {
    const size = Math.min(Math.max(limit, 1), 1000);
    const c = cursor ? decodeCursor<{ r: number; id: string }>(cursor) : undefined;
    const sent = this.roleMailbox("sent") ?? "";

    const rows = this.sql.all<{
      email_id: string;
      thread_id: string;
      received_at: number;
      sent_at: number | null;
      from_json: string | null;
      r2_key: string;
      bucket: "originals" | "parts";
      outgoing: number;
    }>(
      `SELECT e.email_id, e.thread_id, e.received_at, e.sent_at, e.from_json, b.r2_key, b.bucket,
         EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id AND m.mailbox_id = ?) AS outgoing
       FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id
       ${c ? "WHERE (e.received_at > ? OR (e.received_at = ? AND e.email_id > ?))" : ""}
       ORDER BY e.received_at, e.email_id LIMIT ?`,
      sent,
      ...(c ? [c.r, c.r, c.id] : []),
      size + 1,
    );

    const page = rows.slice(0, size);
    const last = page.at(-1);

    return {
      deliveries: page.map((r) => ({
        deliveryId: r.email_id,
        threadId: r.thread_id,
        messageKey: r.r2_key,
        date: Number(r.sent_at ?? r.received_at),
        from: json<ReadonlyArray<{ readonly email?: string }>>(r.from_json, [])[0]?.email ?? "",
        direction: Number(r.outgoing) === 1 ? "out" : "in",
        bucket: r.bucket,
      })),
      nextCursor:
        rows.length > size && last
          ? encodeCursor({ r: Number(last.received_at), id: last.email_id })
          : null,
    };
  }

  /** Emails of one thread, oldest first. */
  threadEmailIds(threadId: string): ReadonlyArray<string> {
    return this.sql
      .all<{ email_id: string }>(
        "SELECT email_id FROM jmap_emails WHERE thread_id = ? ORDER BY received_at, email_id",
        threadId,
      )
      .map((r) => r.email_id);
  }

  /**
   * Scan state of the latest Email stored under an R2 object, or null when none is: what the
   * forwarding dispatch gate waits on or refuses (§10). A quarantined Email reads as infected.
   */
  scanStatusForKey(r2Key: string): string | null {
    const row = this.sql.one<{ scan_status: string; quarantined: number }>(
      `SELECT e.scan_status, e.quarantined FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id
       WHERE b.r2_key = ? ORDER BY e.received_at DESC LIMIT 1`,
      r2Key,
    );

    if (!row) return null;

    return Number(row.quarantined) === 1 ? "infected" : row.scan_status;
  }

  /**
   * Blob GC's claim before it deletes a content-addressed key (§12): granted only while no blob
   * row names the key, and until released (or {@link GC_CLAIM_MS} passed) registering the same
   * key is refused, so content stored again meanwhile never points at bytes being deleted.
   */
  claimGc(r2Key: string): boolean {
    return this.sql.tx(() => {
      if (this.referencesKey(r2Key)) return false;

      this.sql.run(
        "INSERT INTO jmap_gc_claims (r2_key, at) VALUES (?, ?) ON CONFLICT (r2_key) DO UPDATE SET at = excluded.at",
        r2Key,
        this.clock.now(),
      );

      return true;
    });
  }

  /** The delete finished: the key may be registered (and its bytes stored) again. */
  releaseGc(r2Key: string): void {
    this.sql.run(
      "DELETE FROM jmap_gc_claims WHERE r2_key = ? OR at <= ?",
      r2Key,
      this.clock.now() - GC_CLAIM_MS,
    );
  }

  /** Whether any JMAP blob row still points at this R2 object (blob GC, §12). */
  referencesKey(r2Key: string): boolean {
    return (
      this.sql.one<{ x: number }>(
        "SELECT 1 AS x FROM jmap_blobs WHERE r2_key = ? LIMIT 1",
        r2Key,
      ) !== undefined
    );
  }

  emailSet(
    viewer: Viewer,
    cmd: SetCommand,
    prepared: ReadonlyMap<string, PreparedContent>,
  ): MailWriteResult {
    const oldState = this.state("Email");

    if (cmd.ifInState !== null && cmd.ifInState !== oldState.revision) return STATE_MISMATCH;
    const created: Array<readonly [string, Schema.JsonObject]> = [];
    const notCreated: Array<readonly [string, SetError]> = [];
    const updated: Array<readonly [string, Schema.JsonObject | null]> = [];
    const notUpdated: Array<readonly [string, SetError]> = [];
    const destroyed: Array<string> = [];
    const notDestroyed: Array<readonly [string, SetError]> = [];
    const known = [...cmd.createdIds];
    const resolve = (id: string) => idResolver(known)(id);

    for (const [cid, obj] of cmd.create) {
      const content = prepared.get(cid);

      if (!content) {
        notCreated.push([cid, setError("invalidProperties", "message could not be prepared")]);
        continue;
      }

      const mailboxIds = Object.keys(
        Predicate.isObject(obj["mailboxIds"]) ? (obj["mailboxIds"] as Schema.JsonObject) : {},
      ).map((m) => Option.getOrElse(resolve(m), () => m));

      const requested = Object.keys(
        Predicate.isObject(obj["keywords"]) ? (obj["keywords"] as Schema.JsonObject) : {},
      );

      const keywords = requested.flatMap((k) => Option.toArray(normalizeKeyword(k)));

      if (keywords.length !== requested.length) {
        notCreated.push([cid, setError("invalidProperties", "invalid keyword", ["keywords"])]);
        continue;
      }

      const r = this.createEmail(viewer, content, mailboxIds, keywords, this.clock.now());

      if (Result.isSuccess(r)) {
        created.push([cid, r.success]);
        known.push([cid, Predicate.isString(r.success["id"]) ? r.success["id"] : ""]);
      } else notCreated.push([cid, r.failure]);
    }

    for (const [id, patch] of cmd.update) {
      const r = this.history.tx(() => this.updateEmail(viewer, id, patch, resolve));

      if (Result.isSuccess(r)) updated.push([id, null]);
      else notUpdated.push([id, r.failure]);
    }

    for (const id of cmd.destroy) {
      const r = this.history.tx(() => this.destroyForViewer(viewer, id));

      if (Result.isSuccess(r)) destroyed.push(id);
      else notDestroyed.push([id, r.failure]);
    }

    return {
      _tag: "Set",
      oldState,
      newState: this.state("Email"),
      created,
      updated,
      destroyed,
      notCreated,
      notUpdated,
      notDestroyed,
    };
  }

  /** Create one Email from prepared content (Email/set create, Email/import, copy). */
  createEmail(
    viewer: Viewer,
    content: PreparedContent,
    mailboxIds: ReadonlyArray<string>,
    keywords: ReadonlyArray<string>,
    receivedAt: number,
    // Authored mail needs no scan; imported/copied bytes are `legacy` (readable, eligible for an
    // operator rescan), as for mail committed before scanning existed.
    scanStatus: "not-required" | "legacy" = "not-required",
  ): Result.Result<Schema.JsonObject, SetError> {
    const boxError = this.checkMailboxes(mailboxIds);

    if (Option.isSome(boxError)) return Result.fail(boxError.value);
    const kwError = this.checkKeywords(keywords);

    if (Option.isSome(kwError)) return Result.fail(kwError.value);

    if (!this.mayChange(viewer, { boxes: [], keywords: [] }, { boxes: mailboxIds, keywords }))
      return Result.fail(setError("forbidden"));

    if (content.email.truncated)
      return Result.fail(setError("invalidEmail", "message exceeds parse limits"));

    return this.history.tx(() => {
      const emailId = this.clock.id("eml");

      const { threadId } = this.publish({
        emailId,
        content,
        mailboxIds,
        keywords: keywords.map((k) => k.toLowerCase()),
        receivedAt,
        // Imported and copied mail keeps its original receivedAt; retention counts from now.
        placedAt: this.clock.now(),
        scanStatus,
      });

      return Result.succeed({
        id: emailId,
        blobId: content.blobId,
        threadId,
        size: content.email.size,
      });
    });
  }

  private updateEmail(
    viewer: Viewer,
    id: string,
    patch: Schema.JsonObject,
    resolve: (id: string) => Option.Option<string>,
  ): Result.Result<void, SetError> {
    if (this.emailRows([id], viewer).length === 0) return Result.fail(setError("notFound"));
    const parsed = parseEmailPatch(patch, resolve);

    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    const beforeBoxes = this.memberships(id);
    const beforeKeywords = this.keywords(id);

    const boxes = parsed.success.mailboxIds
      ? applyMemberPatch(beforeBoxes, parsed.success.mailboxIds)
      : beforeBoxes;

    const keywords = parsed.success.keywords
      ? applyMemberPatch(beforeKeywords, parsed.success.keywords)
      : beforeKeywords;

    const boxError = this.checkMailboxes(boxes);

    if (Option.isSome(boxError)) return Result.fail(boxError.value);

    if (
      !this.mayChange(viewer, { boxes: beforeBoxes, keywords: beforeKeywords }, { boxes, keywords })
    )
      return Result.fail(setError("forbidden"));
    const next: StateChange = {};

    if (parsed.success.mailboxIds) next.mailboxIds = boxes;

    if (parsed.success.keywords) next.keywords = keywords;
    this.applyState(id, next);

    return Result.succeed(undefined);
  }

  private destroyForViewer(viewer: Viewer, id: string): Result.Result<void, SetError> {
    if (this.emailRows([id], viewer).length === 0) return Result.fail(setError("notFound"));
    const boxes = this.memberships(id);

    if (viewer.draftsOnlyDestroy === true && !this.keywords(id).includes("$draft"))
      return Result.fail(
        setError("forbidden", "only drafts may be destroyed with this credential"),
      );

    if (!this.mayChange(viewer, { boxes, keywords: [] }, { boxes: [], keywords: [] }))
      return Result.fail(setError("forbidden"));
    this.destroyEmail(id);

    return Result.succeed(undefined);
  }

  // ---------------------------------------------------------------- Email/import

  emailImport(
    viewer: Viewer,
    cmd: ImportCommand,
    prepared: ReadonlyMap<string, PreparedContent>,
  ): MailWriteResult {
    const oldState = this.state("Email");

    if (cmd.ifInState !== null && cmd.ifInState !== oldState.revision) return STATE_MISMATCH;
    const created: Array<readonly [string, Schema.JsonObject]> = [];
    const notCreated: Array<readonly [string, SetError]> = [];

    for (const [cid, e] of cmd.emails) {
      const content = prepared.get(cid);
      const access = this.blobAccess(viewer, e.blobId);

      if (!content || !access.visible) {
        notCreated.push([cid, setError("blobNotFound", undefined)]);
        continue;
      }

      const keywords = e.keywords.flatMap((k) => Option.toArray(normalizeKeyword(k)));

      if (keywords.length !== e.keywords.length) {
        notCreated.push([cid, setError("invalidProperties", "invalid keyword", ["keywords"])]);
        continue;
      }

      const r = this.createEmail(
        viewer,
        content,
        e.mailboxIds,
        keywords,
        e.receivedAt ?? this.clock.now(),
        "legacy",
      );

      if (Result.isSuccess(r)) created.push([cid, r.success]);
      else notCreated.push([cid, r.failure]);
    }

    return {
      _tag: "Set",
      oldState,
      newState: this.state("Email"),
      created,
      updated: [],
      destroyed: [],
      notCreated,
      notUpdated: [],
      notDestroyed: [],
    };
  }

  // ---------------------------------------------------------------- native actions (A1)

  /** Placement Mailboxes native archive/trash remove: Inbox and the workflow Mailboxes. */
  private placementBoxes(): ReadonlyArray<string> {
    const t = this.workflowTargets();

    return [this.roleMailbox("inbox"), t.feed, t.paperTrail, t.screener, t.screenedOut].filter(
      (x): x is string => x !== undefined,
    );
  }

  /** Label Mailboxes: role-less and not a workflow target. */
  private isLabel(mailboxId: string): boolean {
    const row = this.mailboxRow(mailboxId);

    return (
      row !== undefined &&
      row.role === null &&
      !Object.values(this.workflowTargets()).includes(mailboxId)
    );
  }

  native(viewer: Viewer, cmd: NativeCommand): MailWriteResult {
    const digest = queryDigest({
      emails: cmd.emails.map(([id, v]) => [id, v]),
      action: { ...cmd.action },
    });

    if (cmd.intentId !== null) {
      const receipt = this.sql.one<{ method: string; digest: string; result: string }>(
        "SELECT method, digest, result FROM jmap_intents WHERE principal_id = ? AND intent_id = ?",
        viewer.principalId,
        cmd.intentId,
      );

      if (receipt) {
        if (receipt.method !== "EmailAction/apply" || receipt.digest !== digest)
          return {
            _tag: "Refused",
            type: "invalidArguments",
            description: "intent ID reused with a different payload",
          };

        return {
          ...json<MailWriteResult & { readonly _tag: "Native" }>(receipt.result, nativeEmpty),
          replayed: true,
        };
      }
    }

    if (cmd.dueAt !== null && cmd.dueAt > this.clock.now())
      return this.armTimer(viewer, cmd, digest);

    const results: Array<readonly [string, { readonly ok: boolean; readonly reason?: string }]> =
      [];

    const ids = Predicate.isTagged(cmd.action, "EmptyTrash")
      ? this.trashContents().map((id) => [id, null] as const)
      : cmd.emails;

    const run = () => {
      for (const [id, version] of ids) {
        const r = this.history.tx(() => this.nativeOne(viewer, id, version, cmd));

        results.push([id, Result.isSuccess(r) ? { ok: true } : { ok: false, reason: r.failure }]);
      }

      const out: MailWriteResult = {
        _tag: "Native",
        state: this.state("Email"),
        results,
        replayed: false,
      };

      if (cmd.intentId !== null)
        this.sql.run(
          "INSERT INTO jmap_intents (principal_id, intent_id, method, digest, result, created_at) VALUES (?, ?, 'EmailAction/apply', ?, ?, ?)",
          viewer.principalId,
          cmd.intentId,
          digest,
          JSON.stringify(out),
          this.clock.now(),
        );

      return out;
    };

    return run();
  }

  /** Emails currently in Trash. */
  private trashContents(): ReadonlyArray<string> {
    return this.sql
      .all<{ email_id: string }>(
        "SELECT email_id FROM jmap_memberships WHERE mailbox_id = ?",
        this.roleMailbox("trash") ?? "",
      )
      .map((r) => r.email_id);
  }

  // ---------------------------------------------------------------- timers (A2)

  /**
   * Arm a native action as a timer: the exact Email IDs with their placement versions now (or
   * as captured at selection), the creating principal and a generation. Re-arming is explicit.
   */
  private armTimer(viewer: Viewer, cmd: NativeCommand, digest: string): MailWriteResult {
    const timerId = this.clock.id("tmr");

    const emails = cmd.emails.map(([id, version]) => ({
      id,
      version: version ?? Number(this.emailRow(id)?.placement_version ?? -1),
    }));

    this.sql.tx(() => {
      this.sql.run(
        "INSERT INTO jmap_timers (timer_id, principal_id, emails, action, due_at) VALUES (?, ?, ?, ?, ?)",
        timerId,
        viewer.principalId,
        JSON.stringify(emails),
        JSON.stringify(cmd.action),
        cmd.dueAt,
      );
      this.schedule(TIMER_JOB, timerId, cmd.dueAt!);

      if (cmd.intentId !== null)
        this.sql.run(
          "INSERT INTO jmap_intents (principal_id, intent_id, method, digest, result, created_at) VALUES (?, ?, 'EmailAction/apply', ?, ?, ?)",
          viewer.principalId,
          cmd.intentId,
          digest,
          JSON.stringify({
            _tag: "Native",
            state: this.state("Email"),
            results: [],
            replayed: false,
            timerId,
          }),
          this.clock.now(),
        );
    });

    return { _tag: "Native", state: this.state("Email"), results: [], replayed: false, timerId };
  }

  /**
   * Execute a due timer (A2 precedence): recheck the timer's state and its creator's rights; each
   * captured Email whose placement changed since capture, or that no longer exists, is skipped —
   * a later edit wins and nothing is resurrected. Read/star edits don't change placement.
   */
  runTimer(timerId: string): TimerRun {
    const t = this.sql.one<{ principal_id: string; emails: string; action: string; state: string }>(
      "SELECT principal_id, emails, action, state FROM jmap_timers WHERE timer_id = ?",
      timerId,
    );

    if (!t || t.state !== "armed") return { ran: [], skipped: [] };
    const viewer = { principalId: t.principal_id };
    const action = json<NativeCommand["action"]>(t.action, { _tag: "Seen", seen: true });
    const ran: Array<string> = [];
    const skipped: Array<string> = [];

    // Only mail-moving actions depend on placement; read/star timers coexist with later moves.
    const moving = !Predicate.isTagged(action, "Seen") && !Predicate.isTagged(action, "Flag");

    // Emptying Trash at a time means what is in Trash then; it never captured a selection.
    const captured = Predicate.isTagged(action, "EmptyTrash")
      ? this.trashContents().map((id) => ({ id, version: null }))
      : json<ReadonlyArray<{ id: string; version: number }>>(t.emails, []);

    for (const e of captured) {
      const version = moving ? e.version : null;

      const r = this.history.tx(() =>
        this.nativeOne(viewer, e.id, version, {
          _tag: "Native",
          emails: [],
          action,
          intentId: null,
          dueAt: null,
        }),
      );

      if (Result.isSuccess(r)) ran.push(e.id);
      else skipped.push(e.id);
    }

    this.sql.run(
      "UPDATE jmap_timers SET state = 'done', reason = ? WHERE timer_id = ?",
      skipped.length > 0 ? `skipped: ${skipped.join(",")}`.slice(0, 300) : null,
      timerId,
    );

    return { ran, skipped };
  }

  private nativeOne(
    viewer: Viewer,
    id: string,
    version: number | null,
    cmd: NativeCommand,
  ): Result.Result<void, string> {
    const row = this.emailRows([id], viewer)[0];

    if (!row) return Result.fail("notFound");

    // A1 bulk rule: the exact Emails and versions captured at selection; a later edit wins.
    if (version !== null && Number(row.placement_version) !== version)
      return Result.fail("changedSinceSelection");
    const boxes = this.memberships(id);
    const keywords = this.keywords(id);
    const trash = this.roleMailbox("trash");
    const junk = this.roleMailbox("junk");
    const archive = this.roleMailbox("archive");
    const placement = new Set(this.placementBoxes());
    const inTrashOrSpam = boxes.some((m) => m === trash || m === junk);

    const nextBoxes = (): Result.Result<ReadonlyArray<string> | null, string> =>
      Match.value(cmd.action).pipe(
        Match.tagsExhaustive({
          Archive: () => {
            if (keywords.includes("$draft") || inTrashOrSpam || row.quarantined === 1)
              return Result.fail("notArchivable");

            if (!archive) return Result.fail("missingArchiveMailbox");

            return Result.succeed([...boxes.filter((m) => !placement.has(m)), archive]);
          },
          Move: (a) => {
            if (!this.mailboxRow(a.to)) return Result.fail("missingDestination");

            return Result.succeed([...boxes.filter((m) => !a.from.includes(m)), a.to]);
          },
          Trash: () =>
            trash
              ? Result.succeed([...boxes.filter((m) => this.isLabel(m)), trash])
              : Result.fail("missingTrashMailbox"),
          Spam: () =>
            junk
              ? Result.succeed([...boxes.filter((m) => this.isLabel(m)), junk])
              : Result.fail("missingSpamMailbox"),
          Restore: (a) => {
            if (!this.mailboxRow(a.to)) return Result.fail("missingDestination");

            return Result.succeed([...boxes.filter((m) => m !== trash && m !== junk), a.to]);
          },
          Label: (a) => {
            if (!this.isLabel(a.mailboxId)) return Result.fail("notALabel");

            if (a.add) return Result.succeed([...boxes, a.mailboxId]);
            const rest = boxes.filter((m) => m !== a.mailboxId);

            // Removing the last membership is a destruction, never an implicit one (A1).
            return rest.length === 0 ? Result.fail("lastMembership") : Result.succeed(rest);
          },
          Seen: () => Result.succeed(null),
          Flag: () => Result.succeed(null),
          AcceptScreener: (a) => {
            const screener = this.workflowTargets().screener;

            if (!this.mailboxRow(a.to)) return Result.fail("missingDestination");

            return Result.succeed([...boxes.filter((m) => m !== screener), a.to]);
          },
          DestroyPermanently: () => Result.succeed(null),
          EmptyTrash: () => Result.succeed(null),
        }),
      );

    const emptying = Predicate.isTagged(cmd.action, "EmptyTrash");

    if (Predicate.isTagged(cmd.action, "DestroyPermanently") || emptying) {
      if (emptying && !boxes.includes(trash ?? "")) return Result.fail("notInTrash");

      const destroyedResult = this.destroyForViewer(viewer, id);

      return Result.isSuccess(destroyedResult)
        ? Result.succeed(undefined)
        : Result.fail(destroyedResult.failure.type);
    }

    const boxesNext = nextBoxes();

    if (Result.isFailure(boxesNext)) return Result.fail(boxesNext.failure);
    let keywordsNext: ReadonlyArray<string> | null = null;

    if (Predicate.isTagged(cmd.action, "Seen"))
      keywordsNext = cmd.action.seen
        ? [...new Set([...keywords, "$seen"])]
        : keywords.filter((k) => k !== "$seen");

    if (Predicate.isTagged(cmd.action, "Flag"))
      keywordsNext = cmd.action.flagged
        ? [...new Set([...keywords, "$flagged"])]
        : keywords.filter((k) => k !== "$flagged");
    const finalBoxes = boxesNext.success === null ? boxes : [...new Set(boxesNext.success)];

    if (
      !this.mayChange(
        viewer,
        { boxes, keywords },
        { boxes: finalBoxes, keywords: keywordsNext ?? keywords },
      )
    )
      return Result.fail("forbidden");
    const next: StateChange = {};

    if (boxesNext.success !== null) next.mailboxIds = finalBoxes;

    if (keywordsNext !== null) next.keywords = keywordsNext;
    this.applyState(id, next);

    if (Predicate.isTagged(cmd.action, "AcceptScreener"))
      this.audit("screener", id, `accepted to ${cmd.action.to}`);

    return Result.succeed(undefined);
  }
}

const nativeEmpty: MailWriteResult & { readonly _tag: "Native" } = {
  _tag: "Native",
  state: { revision: "0" },
  results: [],
  replayed: true,
};

/** Server-set Mailbox properties a client may echo in create but never change. */
const SERVER_SET_MAILBOX = [
  "id",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
];

/** `ifInState` didn't match: the whole method fails before any object is touched. */
export const STATE_MISMATCH: MailWriteResult = {
  _tag: "Refused",
  type: "stateMismatch",
  description: "ifInState does not match the current state",
};

interface Compiled {
  readonly sql: string;
  readonly args: Array<SqlValue>;
}

const SNIPPET_LENGTH = 200;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Wrap whole-word (prefix-free) matches of `terms` in `<mark>`; null when none match. With
 * `excerpt`, the text is cut to a window around the first match.
 */
export const highlight = (
  text: string,
  terms: ReadonlyArray<string>,
  excerpt: boolean,
): string | null => {
  if (terms.length === 0 || text.length === 0) return null;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const first = text.search(pattern);

  if (first < 0) return null;
  let window = text;
  let prefix = "";
  let suffix = "";

  if (excerpt) {
    const start = Math.max(0, first - 40);
    window = text.slice(start, start + SNIPPET_LENGTH).replace(/\s+/g, " ");
    prefix = start > 0 ? "…" : "";
    suffix = start + SNIPPET_LENGTH < text.length ? "…" : "";
  }

  const parts: Array<string> = [];
  let last = 0;

  for (const m of window.matchAll(pattern)) {
    parts.push(escapeHtml(window.slice(last, m.index)), `<mark>${escapeHtml(m[0])}</mark>`);
    last = m.index + m[0].length;
  }

  parts.push(escapeHtml(window.slice(last)));

  return `${prefix}${parts.join("")}${suffix}`;
};

/**
 * FTS5 query for a free-text condition: each whitespace-separated word is a phrase of its tokens
 * (so `order-1234` matches those tokens adjacent, as written), and all words must match.
 */
const ftsPhrases = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0))
    .filter((tokens) => tokens.length > 0)
    .slice(0, 16)
    .map((tokens) => `"${tokens.join(" ")}"`);

/** Compile a parsed Email/query filter to SQL over the `e` alias of `jmap_emails`. */
const compileFilter = (filter: EmailFilter | null): Compiled => {
  if (filter === null) return { sql: "1", args: [] };

  if (Predicate.isTagged(filter, "Operator")) {
    const parts = filter.conditions.map(compileFilter);
    const args = parts.flatMap((p) => p.args);

    if (parts.length === 0) return { sql: filter.operator === "OR" ? "0" : "1", args };

    const joined = parts
      .map((p) => `(${p.sql})`)
      .join(filter.operator === "AND" ? " AND " : " OR ");

    return { sql: filter.operator === "NOT" ? `NOT (${joined})` : joined, args };
  }

  const c = filter.condition;
  const sql: Array<string> = [];
  const args: Array<SqlValue> = [];

  const contains = (column: string, value: string) => {
    sql.push(`instr(lower(COALESCE(${column}, '')), ?) > 0`);
    args.push(value.toLowerCase());
  };

  // One match per word (or hyphenated phrase), ANDed per Email rather than per chunk row:
  // subject/addresses sit in chunk 0 and long bodies span chunks, so words of one query may be
  // found in different rows of the same Email.
  const fts = (columns: string, value: string) => {
    const phrases = ftsPhrases(value);

    if (phrases.length === 0) {
      sql.push("1");

      return;
    }

    for (const phrase of phrases) {
      sql.push(`e.email_id IN (SELECT email_id FROM jmap_fts WHERE jmap_fts MATCH ?)`);
      args.push(`${columns} : (${phrase})`);
    }
  };

  if (c.inMailbox !== undefined) {
    sql.push(
      "EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id AND m.mailbox_id = ?)",
    );
    args.push(c.inMailbox);
  }

  if (c.inMailboxOtherThan !== undefined) {
    sql.push(
      c.inMailboxOtherThan.length === 0
        ? "EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id)"
        : "EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id AND m.mailbox_id NOT IN (SELECT value FROM json_each(?)))",
    );

    // Client-sized list: bound as one JSON parameter (Cloudflare SQL allows 100 parameters).
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

  if (c.hasKeyword !== undefined) {
    sql.push(
      "EXISTS (SELECT 1 FROM jmap_keywords k WHERE k.email_id = e.email_id AND k.keyword = ?)",
    );
    args.push(c.hasKeyword);
  }

  if (c.notKeyword !== undefined) {
    sql.push(
      "NOT EXISTS (SELECT 1 FROM jmap_keywords k WHERE k.email_id = e.email_id AND k.keyword = ?)",
    );
    args.push(c.notKeyword);
  }

  if (c.allInThreadHaveKeyword !== undefined) {
    sql.push(
      "NOT EXISTS (SELECT 1 FROM jmap_emails t WHERE t.thread_id = e.thread_id AND NOT EXISTS (SELECT 1 FROM jmap_keywords k WHERE k.email_id = t.email_id AND k.keyword = ?))",
    );
    args.push(c.allInThreadHaveKeyword);
  }

  if (c.someInThreadHaveKeyword !== undefined) {
    sql.push(
      "EXISTS (SELECT 1 FROM jmap_emails t JOIN jmap_keywords k ON k.email_id = t.email_id WHERE t.thread_id = e.thread_id AND k.keyword = ?)",
    );
    args.push(c.someInThreadHaveKeyword);
  }

  if (c.noneInThreadHaveKeyword !== undefined) {
    sql.push(
      "NOT EXISTS (SELECT 1 FROM jmap_emails t JOIN jmap_keywords k ON k.email_id = t.email_id WHERE t.thread_id = e.thread_id AND k.keyword = ?)",
    );
    args.push(c.noneInThreadHaveKeyword);
  }

  if (c.hasAttachment !== undefined) {
    sql.push("e.has_attachment = ?");
    args.push(c.hasAttachment ? 1 : 0);
  }

  if (c.text !== undefined) fts("{subject addresses body}", c.text);

  if (c.body !== undefined) fts("body", c.body);

  if (c.subject !== undefined) contains("e.subject", c.subject);

  if (c.from !== undefined) contains("e.from_json", c.from);

  if (c.to !== undefined) contains("e.to_json", c.to);

  if (c.cc !== undefined) contains("e.cc_json", c.cc);

  if (c.bcc !== undefined) contains("e.bcc_json", c.bcc);

  if (c.header !== undefined) {
    const [name, value] = c.header;
    sql.push(
      `EXISTS (SELECT 1 FROM json_each(e.headers_json) h WHERE lower(json_extract(h.value, '$.name')) = lower(?)${value === null ? "" : " AND instr(lower(json_extract(h.value, '$.value')), lower(?)) > 0"})`,
    );
    args.push(name);

    if (value !== null) args.push(value);
  }

  return { sql: sql.length > 0 ? sql.join(" AND ") : "1", args };
};

const SORT_EXPRESSION = {
  receivedAt: "e.received_at",
  sentAt: "COALESCE(e.sent_at, e.received_at)",
  size: "e.size",
  subject: "lower(e.base_subject)",
  from: "lower(COALESCE(json_extract(e.from_json, '$[0].email'), ''))",
  to: "lower(COALESCE(json_extract(e.to_json, '$[0].email'), ''))",
  hasKeyword:
    "EXISTS (SELECT 1 FROM jmap_keywords sk WHERE sk.email_id = e.email_id AND sk.keyword = ?)",
} satisfies { readonly [property in EmailSort["property"]]: string };

/** ORDER BY for the comparators, with the ID as final tie-break so paging is deterministic. */
const orderBy = (sort: ReadonlyArray<EmailSort>): string => {
  const keys = sort.map((s) => `${SORT_EXPRESSION[s.property]} ${s.isAscending ? "ASC" : "DESC"}`);
  const last = sort.at(-1);

  return [...keys, `e.email_id ${last && !last.isAscending ? "DESC" : "ASC"}`].join(", ");
};
