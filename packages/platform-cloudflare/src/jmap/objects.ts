import {
  type AuthorityState,
  type MailReadResult,
  type MailWriteResult,
  type ObjectType,
  queryDigest,
  type SetCommand,
  type SetError,
  setError,
  type SetOutcome,
  idResolver,
  utcDate,
} from "@bye/jmap";
import type { RecipientOutcome } from "@bye/domain";
import { Option, Predicate, Result, Schema } from "effect";
import { json } from "../durable/sql.ts";
import type { MailboxAwaySettings } from "../mailbox/automation.ts";
import type { MailboxIdentity, MailboxSendJob } from "../mailbox/types.ts";
import { type JmapCore, STATE_MISMATCH, type Viewer } from "./core.ts";
import type { ChangeOp } from "./history.ts";

// Non-mail JMAP objects over the account core (spec.md §16.5, A2, B1, B2): Identity and
// EmailSubmission on the existing send pipeline, VacationResponse on the away settings, and the
// Bye Conversation/DraftSession extensions. Extensions never own membership or keywords.

/** The mutable fields of an identity (name and plain-text signature). */
export interface IdentityPatch {
  name?: string | null;
  signature?: string;
}

/** The legacy services the object layer runs on (send jobs, identities, away replies). */
export interface ObjectPorts {
  identities(): ReadonlyArray<MailboxIdentity>;
  updateIdentity(
    id: string,
    patch: { readonly name?: string | null; readonly signature?: string },
  ): void;
  createSubmissionJob(input: {
    readonly submissionId: string;
    readonly identityId: string;
    readonly from: string;
    readonly recipients: ReadonlyArray<string>;
    readonly contentKey: string;
    readonly bytes: number;
    readonly sendAt: number;
    readonly threadId: string | null;
  }): string;
  cancelJob(sendJobId: string): "Cancelled" | "TooLate";
  job(sendJobId: string): MailboxSendJob | undefined;
  away(): MailboxAwaySettings;
  setAway(settings: MailboxAwaySettings): void;
}

/** The pinned bytes prepared for one submission creation (B2: Bcc removed, immutable). */
export interface PreparedSubmission {
  readonly blobId: string;
  readonly r2Key: string;
  readonly size: number;
}

/** Recipient limit per submission (D2 release profile verifies the provider's real limit). */
export const MAX_SUBMISSION_RECIPIENTS = 50;

const MAX_DELAY_MS = 30 * 24 * 3600 * 1000;

const Envelope = Schema.Struct({
  mailFrom: Schema.Struct({
    email: Schema.String,
    parameters: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    ),
  }),
  rcptTo: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      parameters: Schema.optional(
        Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
      ),
    }),
  ),
});

type Envelope = typeof Envelope.Type;

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

/** RFC 8621 §7 `delivered`: relay acceptance is `queued`, never `yes` (spec.md §16.5). */
const delivered = (outcome: RecipientOutcome, jobState: string): string => {
  if (jobState === "unknown") return "unknown";

  if (jobState === "rejected" || jobState === "cancelled") return "no";

  switch (outcome) {
    case "delivered":
      return "yes";
    case "bounced":
    case "rejected":
    case "complained":
      return "no";
    default:
      return "queued";
  }
};

const SUBMISSION_SORT_COLUMN = new Map<string, "send_at" | "email_id" | "thread_id">([
  ["sentAt", "send_at"],
  ["emailId", "email_id"],
  ["threadId", "thread_id"],
]);

/** A JSON value as a string, or "" when it isn't one (no default object stringification). */
const text = (value: Schema.Json | undefined): string => (Predicate.isString(value) ? value : "");

interface SubmissionRow {
  readonly submission_id: string;
  readonly identity_id: string;
  readonly email_id: string;
  readonly thread_id: string;
  readonly envelope: string;
  readonly send_at: number;
  readonly content_blob_id: string;
  readonly send_job_id: string;
  readonly canceled: number;
  readonly principal_id: string | null;
}

export class JmapObjects {
  constructor(
    private readonly core: JmapCore,
    private readonly ports: ObjectPorts,
  ) {}

  private get sql() {
    return this.core.sql;
  }

  private state(viewer: Viewer, type: ObjectType): AuthorityState {
    return this.core.state(type, viewer);
  }

  // ---------------------------------------------------------------- reads

  get(viewer: Viewer, type: ObjectType, ids: ReadonlyArray<string> | null): MailReadResult {
    const all = this.list(viewer, type);
    const byId = new Map(all.map((o) => [text(o["id"]), o]));

    return {
      _tag: "ObjectGet",
      state: this.state(viewer, type),
      list:
        ids === null
          ? all
          : ids.flatMap((id) => Option.toArray(Option.fromNullishOr(byId.get(id)))),
      notFound: ids === null ? [] : ids.filter((id) => !byId.has(id)),
    };
  }

  private list(viewer: Viewer, type: ObjectType): ReadonlyArray<Schema.JsonObject> {
    switch (type) {
      case "Identity":
        return this.ports.identities().flatMap((i) => (i.verified ? [this.identity(i)] : []));
      case "EmailSubmission":
        return this.submissions(viewer).map((r) => this.submission(r));
      case "VacationResponse":
        return [this.vacation()];
      case "Conversation":
        return this.sql
          .all<{
            conversation_id: string;
            title: string | null;
            thread_ids: string;
            redirect_to: string | null;
          }>("SELECT * FROM jmap_conversations ORDER BY conversation_id")
          .map((c) => ({
            id: c.conversation_id,
            title: c.title,
            threadIds: json<ReadonlyArray<string>>(c.thread_ids, []) as Array<string>,
            redirectTo: c.redirect_to,
          }));
      case "DraftSession":
        // Principal-scoped (A2): an editor sees only its own sessions.
        return this.sql
          .all<{
            session_id: string;
            head_email_id: string | null;
            version: number;
            conflicts: string;
            pending_cleanup: string;
          }>(
            "SELECT * FROM jmap_draft_sessions WHERE principal_id = ? ORDER BY session_id",
            viewer.principalId,
          )
          .map((d) => ({
            id: d.session_id,
            headEmailId: d.head_email_id,
            version: Number(d.version),
            conflicts: json<Array<string>>(d.conflicts, []),
            pendingCleanup: json<Array<string>>(d.pending_cleanup, []),
          }));
    }
  }

  /**
   * Submissions are principal-scoped (A3): the envelope names Bcc recipients and cancelling
   * changes another member's send, so only the creating principal sees or touches one.
   */
  private submissions(viewer: Viewer): ReadonlyArray<SubmissionRow> {
    return this.sql.all<SubmissionRow>(
      `SELECT * FROM jmap_submissions WHERE ${this.ownedBy()} ORDER BY created_at, submission_id`,
      viewer.principalId,
      this.legacySubmitter(viewer) ? 1 : 0,
    );
  }

  private ownSubmission(viewer: Viewer, id: string): SubmissionRow | undefined {
    return this.sql.one<SubmissionRow>(
      `SELECT * FROM jmap_submissions WHERE submission_id = ? AND ${this.ownedBy()}`,
      id,
      viewer.principalId,
      this.legacySubmitter(viewer) ? 1 : 0,
    );
  }

  /**
   * Whose EmailSubmission history a change belongs to: its creator, or — for a submission from
   * before creators were recorded — every principal that may manage it (see `ownedBy`).
   */
  private owners(principalId: string | null): ReadonlyArray<string> {
    if (principalId !== null) return [principalId];

    return this.sql
      .all<{ principal_id: string; rights: string }>(
        "SELECT principal_id, rights FROM jmap_grants WHERE mailbox_id = '*'",
      )
      .filter((g) => json<{ maySubmit?: boolean }>(g.rights, {}).maySubmit === true)
      .map((g) => g.principal_id);
  }

  private recordSubmission(
    row: Pick<SubmissionRow, "submission_id" | "principal_id">,
    op: ChangeOp,
  ) {
    for (const owner of this.owners(row.principal_id))
      this.core.history.recordFor(owner, "EmailSubmission", row.submission_id, op);
  }

  /**
   * Ownership filter (two bindings: principal, legacy submitter flag). Submissions made before
   * creators were recorded have none: they stay manageable by principals who may send as the
   * whole account, so a pending delayed send can still be seen and cancelled.
   */
  private ownedBy(): string {
    return "(principal_id = ? OR (principal_id IS NULL AND ? = 1))";
  }

  private legacySubmitter(viewer: Viewer): boolean {
    return this.core.grants(viewer.principalId).get("*")?.maySubmit === true;
  }

  private identity(i: MailboxIdentity): Schema.JsonObject {
    return {
      id: i.identityId,
      name: i.name ?? "",
      email: i.address,
      replyTo: null,
      bcc: null,
      textSignature: i.signature,
      htmlSignature: "",
      // Identities are provisioned and verified by account settings; JMAP can't delete them.
      mayDelete: false,
    };
  }

  private submission(r: SubmissionRow): Schema.JsonObject {
    const job = this.ports.job(r.send_job_id);
    const state = job?.state ?? "cancelled";

    const undoStatus =
      r.canceled === 1 || state === "cancelled"
        ? "canceled"
        : ["scheduled", "undo-window", "ready"].includes(state)
          ? "pending"
          : "final";

    const envelope = json<Schema.JsonObject>(r.envelope, {});

    return {
      id: r.submission_id,
      identityId: r.identity_id,
      emailId: r.email_id,
      threadId: r.thread_id,
      envelope,
      sendAt: utcDate(Number(r.send_at)),
      undoStatus,
      deliveryStatus: Object.fromEntries(
        (job?.outcomes ?? []).map((o) => [
          o.address,
          {
            smtpReply: o.detail ?? (state === "accepted" ? "250 2.0.0 accepted by relay" : ""),
            delivered: delivered(o.outcome, state),
            displayed: "unknown",
          },
        ]),
      ),
      dsnBlobIds: [],
      mdnBlobIds: [],
    };
  }

  private vacation(): Schema.JsonObject {
    const a = this.ports.away();

    return {
      id: "singleton",
      isEnabled: a.enabled,
      fromDate: a.startAt === null ? null : utcDate(a.startAt),
      toDate: a.endAt === null ? null : utcDate(a.endAt),
      subject: a.subject,
      textBody: a.text,
      htmlBody: null,
    };
  }

  submissionQuery(
    viewer: Viewer,
    q: Extract<import("@bye/jmap").MailReadQuery, { readonly _tag: "SubmissionQuery" }>,
  ): MailReadResult {
    const f = q.filter ?? {};

    const rows = this.submissions(viewer)
      .map((r) => ({ row: r, obj: this.submission(r) }))
      .filter(({ row, obj }) => {
        const inList = (key: string, value: string) => {
          const list = f[key];

          return !Array.isArray(list) || (list as ReadonlyArray<Schema.Json>).includes(value);
        };

        return (
          inList("identityIds", row.identity_id) &&
          inList("emailIds", row.email_id) &&
          inList("threadIds", row.thread_id) &&
          (f["undoStatus"] === undefined || obj["undoStatus"] === f["undoStatus"]) &&
          (!Predicate.isString(f["before"]) || row.send_at < Date.parse(f["before"])) &&
          (!Predicate.isString(f["after"]) || row.send_at >= Date.parse(f["after"]))
        );
      });

    const sorted = [...rows].sort((a, b) => {
      for (const c of q.sort) {
        const key = SUBMISSION_SORT_COLUMN.get(c.property) ?? "thread_id";

        const av = a.row[key];
        const bv = b.row[key];
        const order = av < bv ? -1 : av > bv ? 1 : 0;

        if (order !== 0) return c.isAscending === false ? -order : order;
      }

      return a.row.submission_id < b.row.submission_id ? -1 : 1;
    });

    const ids = sorted.map((r) => r.row.submission_id);
    let start = q.position < 0 ? Math.max(0, ids.length + q.position) : q.position;

    if (q.anchor !== null) {
      const at = ids.indexOf(q.anchor);

      if (at < 0)
        return {
          _tag: "SubmissionQuery",
          state: this.state(viewer, "EmailSubmission"),
          ids: [],
          position: 0,
          total: null,
          anchorFound: false,
        };
      start = Math.max(0, at + q.anchorOffset);
    }

    return {
      _tag: "SubmissionQuery",
      state: this.state(viewer, "EmailSubmission"),
      ids: ids.slice(start, start + q.limit),
      position: start,
      total: q.calculateTotal ? ids.length : null,
      anchorFound: true,
    };
  }

  // ---------------------------------------------------------------- writes

  set(
    viewer: Viewer,
    cmd: SetCommand,
    submissions: ReadonlyMap<string, PreparedSubmission>,
  ): MailWriteResult {
    const type = cmd.type as ObjectType;
    const oldState = this.state(viewer, type);

    if (cmd.ifInState !== null && cmd.ifInState !== oldState.revision) return STATE_MISMATCH;

    const out = {
      created: [] as Array<readonly [string, Schema.JsonObject]>,
      notCreated: [] as Array<readonly [string, SetError]>,
      updated: [] as Array<readonly [string, Schema.JsonObject | null]>,
      notUpdated: [] as Array<readonly [string, SetError]>,
      destroyed: [] as Array<string>,
      notDestroyed: [] as Array<readonly [string, SetError]>,
    };

    const known = [...cmd.createdIds];

    for (const [cid, obj] of cmd.create) {
      const r = this.core.history.tx(() =>
        this.create(viewer, type, cid, obj, submissions.get(cid), known),
      );

      if (Result.isSuccess(r)) {
        out.created.push([cid, r.success]);

        if (Predicate.isString(r.success["id"])) known.push([cid, r.success["id"]]);
      } else out.notCreated.push([cid, r.failure]);
    }

    for (const [id, patch] of cmd.update) {
      const r = this.core.history.tx(() => this.update(viewer, type, id, patch, known));

      if (Result.isSuccess(r)) out.updated.push([id, r.success]);
      else out.notUpdated.push([id, r.failure]);
    }

    // A destroyed submission's row is gone afterwards: its Email is kept for the implicit set.
    const destroyedEmails = new Map<string, string>();

    for (const id of cmd.destroy) {
      const emailId =
        type === "EmailSubmission"
          ? this.sql.one<{ email_id: string }>(
              "SELECT email_id FROM jmap_submissions WHERE submission_id = ?",
              id,
            )?.email_id
          : undefined;

      const r = this.core.history.tx(() => this.destroy(viewer, type, id));

      if (Result.isSuccess(r) && emailId !== undefined) destroyedEmails.set(id, emailId);

      if (Result.isSuccess(r)) out.destroyed.push(id);
      else out.notDestroyed.push([id, r.failure]);
    }

    // Draft cleanup runs only after every head has advanced (B1 step 3), each on its own.
    if (type === "DraftSession") this.cleanupDrafts(viewer);

    const result: SetOutcome = {
      _tag: "Set",
      oldState,
      newState: this.state(viewer, type),
      ...out,
    };

    if (type !== "EmailSubmission") return result;
    const implicit = this.implicitEmail(viewer, cmd, known, result, destroyedEmails);

    return implicit ? { ...result, implicitEmail: implicit } : result;
  }

  private create(
    viewer: Viewer,
    type: ObjectType,
    cid: string,
    obj: Schema.JsonObject,
    prepared: PreparedSubmission | undefined,
    known: ReadonlyArray<readonly [string, string]>,
  ): Result.Result<Schema.JsonObject, SetError> {
    switch (type) {
      case "EmailSubmission":
        return this.createSubmission(viewer, cid, obj, prepared, known);
      case "Conversation": {
        const threadIds = obj["threadIds"];

        if (!Array.isArray(threadIds) || !threadIds.every(Predicate.isString))
          return Result.fail(setError("invalidProperties", undefined, ["threadIds"]));
        const id = this.core.clock.id("cnv");
        this.sql.run(
          "INSERT INTO jmap_conversations (conversation_id, title, thread_ids) VALUES (?, ?, ?)",
          id,
          Predicate.isString(obj["title"]) ? obj["title"] : null,
          JSON.stringify(threadIds),
        );
        this.core.history.record("Conversation", id, "created");

        return Result.succeed({ id, redirectTo: null });
      }

      case "DraftSession": {
        const head = obj["headEmailId"] ?? null;
        const resolved = Predicate.isString(head) ? idResolver(known)(head) : Option.none();

        if (head !== null && (Option.isNone(resolved) || !this.core.emailRow(resolved.value)))
          return Result.fail(setError("invalidProperties", "unknown head email", ["headEmailId"]));
        const id = this.core.clock.id("dss");
        const headId = Option.getOrNull(resolved);
        this.sql.run(
          "INSERT INTO jmap_draft_sessions (session_id, principal_id, head_email_id, version, updated_at) VALUES (?, ?, ?, 1, ?)",
          id,
          viewer.principalId,
          headId,
          this.core.clock.now(),
        );
        this.putHeadVersion(id, headId);
        this.core.history.recordFor(viewer.principalId, "DraftSession", id, "created");

        return Result.succeed({ id, version: 1, conflicts: [], pendingCleanup: [] });
      }

      default:
        return Result.fail(setError("forbidden", `${type} objects cannot be created here`));
    }
  }

  private createSubmission(
    viewer: Viewer,
    cid: string,
    obj: Schema.JsonObject,
    prepared: PreparedSubmission | undefined,
    known: ReadonlyArray<readonly [string, string]>,
  ): Result.Result<Schema.JsonObject, SetError> {
    const allowed = ["identityId", "emailId", "envelope", "byeIntentId"];
    const bad = Object.keys(obj).filter((k) => !allowed.includes(k));

    if (bad.length > 0) return Result.fail(setError("invalidProperties", undefined, bad));

    const identity = this.ports
      .identities()
      .find((i) => i.identityId === obj["identityId"] && i.verified);

    if (!identity)
      return Result.fail(setError("invalidProperties", "unknown identity", ["identityId"]));
    const emailRef = obj["emailId"];
    const emailId = Predicate.isString(emailRef) ? idResolver(known)(emailRef) : Option.none();

    if (Option.isNone(emailId))
      return Result.fail(setError("invalidProperties", undefined, ["emailId"]));
    const intent = obj["byeIntentId"];

    // The intent digest covers the request as sent (B1): the envelope's HOLDFOR/HOLDUNTIL text,
    // never a send time computed from the clock, so a retry carries the same digest.
    const digest = queryDigest({
      identityId: text(obj["identityId"]),
      emailId: emailId.value,
      envelope: obj["envelope"] ?? null,
    });

    if (Predicate.isString(intent)) {
      const receipt = this.sql.one<{ digest: string; result: string }>(
        "SELECT digest, result FROM jmap_intents WHERE principal_id = ? AND intent_id = ?",
        viewer.principalId,
        intent,
      );

      // A lost response retrieves the existing result, checked before anything the first attempt
      // may have changed (its draft destroyed or moved); reuse with a different payload conflicts.
      if (receipt)
        return receipt.digest === digest
          ? Result.succeed(json<Schema.JsonObject>(receipt.result, {}))
          : Result.fail(
              setError("invalidProperties", "intent ID reused with a different payload", [
                "byeIntentId",
              ]),
            );
    }

    const email = this.core.emailGet(
      viewer,
      [emailId.value],
      ["id", "threadId", "from", "to", "cc", "bcc"],
    ).list[0];

    if (!email) return Result.fail(setError("invalidProperties", "unknown email", ["emailId"]));

    // Rights to submit are per Mailbox (A3): any Mailbox of the Email granting maySubmit.
    const maySubmit = this.core.memberships(emailId.value).some((m) => {
      const row = this.core.mailboxRow(m);

      return row !== undefined && this.core.rights(viewer, row).maySubmit;
    });

    if (!maySubmit) return Result.fail(setError("forbidden", "no submit right"));

    const from = Array.isArray(email["from"])
      ? (email["from"] as ReadonlyArray<Schema.JsonObject>)
      : [];

    if (
      from.length !== 1 ||
      text(from[0]?.["email"]).toLowerCase() !== identity.address.toLowerCase()
    )
      return Result.fail(setError("forbiddenFrom", "From must be the identity's address"));
    let envelope: Envelope;

    if (obj["envelope"] === undefined || obj["envelope"] === null) {
      const rcpt = (["to", "cc", "bcc"] as const).flatMap((k) =>
        Array.isArray(email[k])
          ? (email[k] as ReadonlyArray<Schema.JsonObject>).map((a) => ({
              email: text(a["email"]),
              parameters: null,
            }))
          : [],
      );

      envelope = { mailFrom: { email: identity.address, parameters: null }, rcptTo: rcpt };
    } else {
      const decoded = decodeEnvelope(obj["envelope"]);

      if (Option.isNone(decoded))
        return Result.fail(setError("invalidProperties", undefined, ["envelope"]));
      envelope = decoded.value;
    }

    if (envelope.mailFrom.email.toLowerCase() !== identity.address.toLowerCase())
      return Result.fail(setError("forbiddenMailFrom"));
    const recipients = [...new Set(envelope.rcptTo.map((r) => r.email.toLowerCase()))];

    if (recipients.length === 0) return Result.fail(setError("noRecipients"));

    if (recipients.length > MAX_SUBMISSION_RECIPIENTS)
      return Result.fail(setError("tooManyRecipients"));
    const invalid = recipients.filter((r) => !EMAIL.test(r));

    if (invalid.length > 0) return Result.fail(setError("invalidRecipients", invalid.join(", ")));
    const params = envelope.mailFrom.parameters ?? {};
    const now = this.core.clock.now();
    let sendAt = now;

    // FUTURERELEASE (RFC 4865) parameters on MAIL FROM schedule a delayed send.
    if (Predicate.isString(params["HOLDFOR"])) sendAt = now + Number(params["HOLDFOR"]) * 1000;
    else if (Predicate.isString(params["HOLDUNTIL"])) sendAt = Date.parse(params["HOLDUNTIL"]);

    if (!Number.isFinite(sendAt) || sendAt < now || sendAt - now > MAX_DELAY_MS)
      return Result.fail(setError("invalidProperties", "invalid release time", ["envelope"]));

    if (!prepared)
      return Result.fail(setError("invalidEmail", "message bytes could not be prepared"));

    const id = this.core.clock.id("sub");

    // B2: an independent immutable content pin, envelope, identity, schedule and job together.
    this.core.registerBlob({
      blobId: prepared.blobId,
      bucket: "originals",
      r2Key: prepared.r2Key,
      size: prepared.size,
      type: "message/rfc822",
      expiresAt: null,
    });
    this.core.pin(prepared.blobId, `submission:${id}`);

    const sendJobId = this.ports.createSubmissionJob({
      submissionId: id,
      identityId: identity.identityId,
      from: identity.address,
      recipients,
      contentKey: prepared.r2Key,
      bytes: prepared.size,
      sendAt,
      threadId: null,
    });

    this.sql.run(
      `INSERT INTO jmap_submissions (submission_id, principal_id, identity_id, email_id, thread_id, envelope, send_at, content_blob_id, send_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      viewer.principalId,
      identity.identityId,
      emailId.value,
      text(email["threadId"]),
      JSON.stringify(envelope),
      sendAt,
      prepared.blobId,
      sendJobId,
      now,
    );
    this.core.history.recordFor(viewer.principalId, "EmailSubmission", id, "created");

    const created: Schema.JsonObject = {
      id,
      threadId: text(email["threadId"]),
      sendAt: utcDate(sendAt),
      undoStatus: "pending",
    };

    if (Predicate.isString(intent))
      this.sql.run(
        "INSERT INTO jmap_intents (principal_id, intent_id, method, digest, result, created_at) VALUES (?, ?, 'EmailSubmission/set', ?, ?, ?)",
        viewer.principalId,
        intent,
        digest,
        JSON.stringify(created),
        now,
      );

    void cid;

    return Result.succeed(created);
  }

  private update(
    viewer: Viewer,
    type: ObjectType,
    id: string,
    patch: Schema.JsonObject,
    known: ReadonlyArray<readonly [string, string]>,
  ): Result.Result<Schema.JsonObject | null, SetError> {
    switch (type) {
      case "EmailSubmission": {
        const row = this.ownSubmission(viewer, id);

        if (!row) return Result.fail(setError("notFound"));
        const keys = Object.keys(patch);

        if (keys.length !== 1 || patch["undoStatus"] !== "canceled")
          return Result.fail(
            setError("invalidProperties", "only undoStatus: canceled may be set", keys),
          );

        // Cancellation only before the durable attempt boundary (B2); afterwards it's honest.
        if (this.ports.cancelJob(row.send_job_id) === "TooLate")
          return Result.fail(setError("cannotUnsend"));
        this.sql.run("UPDATE jmap_submissions SET canceled = 1 WHERE submission_id = ?", id);
        this.recordSubmission(row, "updated");

        return Result.succeed(null);
      }

      case "Identity": {
        const identity = this.ports.identities().find((i) => i.identityId === id && i.verified);

        if (!identity) return Result.fail(setError("notFound"));

        for (const key of Object.keys(patch)) {
          if (key === "name" || key === "textSignature") {
            if (!Predicate.isString(patch[key]))
              return Result.fail(setError("invalidProperties", undefined, [key]));
            continue;
          }

          if (key === "htmlSignature" && patch[key] === "") continue;

          if ((key === "replyTo" || key === "bcc") && patch[key] === null) continue;

          return Result.fail(setError("invalidProperties", `${key} is not supported`, [key]));
        }

        const p: IdentityPatch = {};

        if (Predicate.isString(patch["name"])) p.name = patch["name"];

        if (Predicate.isString(patch["textSignature"])) p.signature = patch["textSignature"];
        this.ports.updateIdentity(id, p);
        this.core.history.record("Identity", id, "updated");

        return Result.succeed(null);
      }

      case "VacationResponse": {
        if (id !== "singleton") return Result.fail(setError("notFound"));
        const cur = this.ports.away();
        const next = { ...cur };

        for (const [key, value] of Object.entries(patch)) {
          switch (key) {
            case "isEnabled":
              if (!Predicate.isBoolean(value))
                return Result.fail(setError("invalidProperties", undefined, [key]));
              next.enabled = value;
              break;
            case "fromDate":
            case "toDate": {
              const at =
                value === null ? null : Predicate.isString(value) ? Date.parse(value) : Number.NaN;

              if (at !== null && !Number.isFinite(at))
                return Result.fail(setError("invalidProperties", undefined, [key]));

              if (key === "fromDate") next.startAt = at;
              else next.endAt = at;
              break;
            }

            case "subject":
              next.subject = Predicate.isString(value) ? value : "";
              break;
            case "textBody":
              next.text = Predicate.isString(value) ? value : "";
              break;
            case "htmlBody":
              if (value !== null)
                return Result.fail(
                  setError("invalidProperties", "htmlBody is not supported", [key]),
                );
              break;
            default:
              return Result.fail(setError("invalidProperties", undefined, [key]));
          }
        }

        if (next.startAt !== null && next.endAt !== null && next.endAt <= next.startAt)
          return Result.fail(setError("invalidProperties", "toDate before fromDate", ["toDate"]));
        this.ports.setAway(next);
        this.core.history.record("VacationResponse", "singleton", "updated");

        return Result.succeed(null);
      }

      case "Conversation": {
        const row = this.sql.one<{ thread_ids: string; redirect_to: string | null }>(
          "SELECT thread_ids, redirect_to FROM jmap_conversations WHERE conversation_id = ?",
          id,
        );

        if (!row) return Result.fail(setError("notFound"));

        if (row.redirect_to !== null)
          return Result.fail(setError("invalidPatch", "conversation was merged"));
        const mergeRef = patch["mergeInto"];

        const merge = Predicate.isString(mergeRef)
          ? Option.getOrElse(idResolver(known)(mergeRef), () => mergeRef)
          : mergeRef;

        // Merge: membership moves to the target; the source keeps a reversible redirect (A2).
        if (Predicate.isString(merge)) {
          const target = this.sql.one<{ thread_ids: string }>(
            "SELECT thread_ids FROM jmap_conversations WHERE conversation_id = ? AND redirect_to IS NULL",
            merge,
          );

          if (!target || merge === id)
            return Result.fail(setError("invalidProperties", undefined, ["mergeInto"]));

          const combined = [
            ...new Set([
              ...json<Array<string>>(target.thread_ids, []),
              ...json<Array<string>>(row.thread_ids, []),
            ]),
          ];

          this.sql.run(
            "UPDATE jmap_conversations SET thread_ids = ?, version = version + 1 WHERE conversation_id = ?",
            JSON.stringify(combined),
            merge,
          );
          this.sql.run(
            "UPDATE jmap_conversations SET redirect_to = ?, version = version + 1 WHERE conversation_id = ?",
            merge,
            id,
          );
          this.core.history.record("Conversation", merge, "updated");
          this.core.history.record("Conversation", id, "updated");

          return Result.succeed(null);
        }

        const sets: Array<string> = [];
        const args: Array<string | null> = [];

        for (const [key, value] of Object.entries(patch)) {
          if (key === "title" && (value === null || Predicate.isString(value))) {
            sets.push("title = ?");
            args.push(value);
          } else if (
            key === "threadIds" &&
            Array.isArray(value) &&
            value.every(Predicate.isString)
          ) {
            sets.push("thread_ids = ?");
            args.push(JSON.stringify(value));
          } else return Result.fail(setError("invalidProperties", undefined, [key]));
        }

        if (sets.length > 0)
          this.sql.run(
            `UPDATE jmap_conversations SET ${sets.join(", ")}, version = version + 1 WHERE conversation_id = ?`,
            ...args,
            id,
          );
        this.core.history.record("Conversation", id, "updated");

        return Result.succeed(null);
      }

      case "DraftSession": {
        const head = patch["headEmailId"];

        return this.advanceDraft(
          viewer,
          id,
          Predicate.isString(head)
            ? Object.fromEntries([
                ...Object.entries(patch),
                ["headEmailId", Option.getOrElse(idResolver(known)(head), () => head)],
              ])
            : patch,
        );
      }
    }
  }

  private destroy(viewer: Viewer, type: ObjectType, id: string): Result.Result<void, SetError> {
    switch (type) {
      case "EmailSubmission": {
        const row = this.ownSubmission(viewer, id);

        if (!row) return Result.fail(setError("notFound"));

        // Destroying the record never cancels a send; a still-pending one must be canceled first.
        if (this.submission(row)["undoStatus"] === "pending")
          return Result.fail(setError("forbidden", "cancel the submission before destroying it"));
        // The content pin outlives the record: it follows the job until the recovery window ends.
        this.sql.run(
          "UPDATE jmap_blob_pins SET owner = ? WHERE owner = ?",
          `job:${row.send_job_id}`,
          `submission:${id}`,
        );
        this.sql.run("DELETE FROM jmap_submissions WHERE submission_id = ?", id);
        this.recordSubmission(row, "destroyed");

        return Result.succeed(undefined);
      }

      case "Conversation": {
        if (!this.sql.one("SELECT 1 AS x FROM jmap_conversations WHERE conversation_id = ?", id))
          return Result.fail(setError("notFound"));
        this.sql.run("DELETE FROM jmap_conversations WHERE conversation_id = ?", id);
        this.core.history.record("Conversation", id, "destroyed");

        return Result.succeed(undefined);
      }

      case "DraftSession": {
        const n = this.sql.run(
          "DELETE FROM jmap_draft_sessions WHERE session_id = ? AND principal_id = ?",
          id,
          viewer.principalId,
        );

        if (n === 0) return Result.fail(setError("notFound"));
        this.core.history.recordFor(viewer.principalId, "DraftSession", id, "destroyed");

        return Result.succeed(undefined);
      }

      default:
        return Result.fail(setError("forbidden", `${type} objects cannot be destroyed here`));
    }
  }

  // ---------------------------------------------------------------- draft sessions (B1)

  private putHeadVersion(sessionId: string, headId: string | null): void {
    const v = headId ? Number(this.core.emailRow(headId)?.placement_version ?? 0) : 0;
    this.core.putMeta(`draftHead:${sessionId}`, {
      email: headId,
      version: v,
      keywords: headId ? [...this.core.keywords(headId)] : [],
    });
  }

  /**
   * Advance a session head with compare-and-swap (B1 step 2). A losing save keeps its candidate
   * as an explicit conflict and never touches the winning head.
   */
  private advanceDraft(
    viewer: Viewer,
    id: string,
    patch: Schema.JsonObject,
  ): Result.Result<Schema.JsonObject | null, SetError> {
    const row = this.sql.one<{
      head_email_id: string | null;
      version: number;
      conflicts: string;
      pending_cleanup: string;
    }>(
      "SELECT head_email_id, version, conflicts, pending_cleanup FROM jmap_draft_sessions WHERE session_id = ? AND principal_id = ?",
      id,
      viewer.principalId,
    );

    if (!row) return Result.fail(setError("notFound"));

    if (Object.hasOwn(patch, "conflicts") && Object.keys(patch).length === 1) {
      const next = patch["conflicts"];

      if (!Array.isArray(next) || !next.every(Predicate.isString))
        return Result.fail(setError("invalidProperties", undefined, ["conflicts"]));
      const current = json<Array<string>>(row.conflicts, []);
      // Resolving conflicts can only drop entries, never invent them.
      const kept = current.filter((c) => (next as ReadonlyArray<string>).includes(c));
      this.sql.run(
        "UPDATE jmap_draft_sessions SET conflicts = ? WHERE session_id = ?",
        JSON.stringify(kept),
        id,
      );
      this.core.history.recordFor(viewer.principalId, "DraftSession", id, "updated");

      return Result.succeed(null);
    }

    const head = patch["headEmailId"];
    const expected = patch["ifVersion"];

    if (
      !Predicate.isString(head) ||
      !Predicate.isNumber(expected) ||
      Object.keys(patch).some((k) => k !== "headEmailId" && k !== "ifVersion")
    )
      return Result.fail(
        setError("invalidProperties", "headEmailId and ifVersion are required", ["headEmailId"]),
      );

    if (!this.core.emailRow(head))
      return Result.fail(setError("invalidProperties", "unknown email", ["headEmailId"]));

    if (Number(row.version) !== expected) {
      const conflicts = [...new Set([...json<Array<string>>(row.conflicts, []), head])];
      this.sql.run(
        "UPDATE jmap_draft_sessions SET conflicts = ? WHERE session_id = ?",
        JSON.stringify(conflicts),
        id,
      );
      this.core.history.recordFor(viewer.principalId, "DraftSession", id, "updated");

      return Result.fail(
        setError("invalidPatch", "version conflict: candidate retained as a conflict"),
      );
    }

    const previous = row.head_email_id;
    const pending = json<Array<string>>(row.pending_cleanup, []);

    const old = this.core.meta<{
      email: string | null;
      version: number;
      keywords: ReadonlyArray<string>;
    }>(`draftHead:${id}`, { email: null, version: 0, keywords: [] });

    if (previous !== null && previous !== head) {
      // Only an unchanged superseded draft is cleanup material; an edited one becomes a conflict.
      const r = this.core.emailRow(previous);

      const unchanged =
        r !== undefined &&
        old.email === previous &&
        Number(r.placement_version) === old.version &&
        JSON.stringify(this.core.keywords(previous)) === JSON.stringify(old.keywords);

      if (unchanged) pending.push(previous);
      else if (r !== undefined) {
        const conflicts = [...new Set([...json<Array<string>>(row.conflicts, []), previous])];
        this.sql.run(
          "UPDATE jmap_draft_sessions SET conflicts = ? WHERE session_id = ?",
          JSON.stringify(conflicts),
          id,
        );
      }
    }

    this.sql.run(
      "UPDATE jmap_draft_sessions SET head_email_id = ?, version = version + 1, pending_cleanup = ?, updated_at = ? WHERE session_id = ?",
      head,
      JSON.stringify([...new Set(pending)]),
      this.core.clock.now(),
      id,
    );
    this.putHeadVersion(id, head);
    this.core.history.recordFor(viewer.principalId, "DraftSession", id, "updated");

    return Result.succeed({ version: Number(row.version) + 1 });
  }

  /** B1 step 3: destroy superseded drafts after the head advanced; failures stay pending. */
  cleanupDrafts(viewer: Viewer): void {
    for (const s of this.sql.all<{ session_id: string; pending_cleanup: string }>(
      "SELECT session_id, pending_cleanup FROM jmap_draft_sessions WHERE principal_id = ? AND pending_cleanup <> '[]'",
      viewer.principalId,
    )) {
      const left: Array<string> = [];

      for (const emailId of json<Array<string>>(s.pending_cleanup, [])) {
        try {
          this.core.history.tx(() => {
            // A superseded draft that was submitted keeps its submission pin; only the Email goes.
            if (this.core.emailRow(emailId) && this.core.keywords(emailId).includes("$draft"))
              this.core.destroyEmail(emailId);
          });
        } catch {
          left.push(emailId);
        }
      }

      this.core.history.tx(() => {
        this.sql.run(
          "UPDATE jmap_draft_sessions SET pending_cleanup = ? WHERE session_id = ?",
          JSON.stringify(left),
          s.session_id,
        );
        this.core.history.recordFor(viewer.principalId, "DraftSession", s.session_id, "updated");
      });
    }
  }

  // ---------------------------------------------------------------- implicit Email/set (B2)

  /**
   * RFC 8621 §7.5 `onSuccessUpdateEmail`/`onSuccessDestroyEmail`: a separate Email/set result.
   * Its failures are reported there and never turn a created submission into a failure.
   */
  private implicitEmail(
    viewer: Viewer,
    cmd: SetCommand,
    known: ReadonlyArray<readonly [string, string]>,
    result: SetOutcome,
    destroyedEmails: ReadonlyMap<string, string>,
  ): SetOutcome | undefined {
    const update = cmd.options["onSuccessUpdateEmail"];
    const destroy = cmd.options["onSuccessDestroyEmail"];

    if ((update === undefined || update === null) && (destroy === undefined || destroy === null))
      return undefined;

    // Only submissions this call created, updated or destroyed successfully (RFC 8621 §7.5).
    const created = new Map(result.created.map(([cid, obj]) => [cid, text(obj["id"])]));

    const touched = new Set([
      ...created.values(),
      ...result.updated.map(([id]) => id),
      ...result.destroyed,
    ]);

    const emailOf = (ref: string): string | undefined => {
      const submissionId = ref.startsWith("#") ? created.get(ref.slice(1)) : ref;

      if (submissionId === undefined || !touched.has(submissionId)) return undefined;

      return (
        destroyedEmails.get(submissionId) ??
        this.sql.one<{ email_id: string }>(
          "SELECT email_id FROM jmap_submissions WHERE submission_id = ?",
          submissionId,
        )?.email_id
      );
    };

    const updates: Array<readonly [string, Schema.JsonObject]> = [];

    if (Predicate.isObject(update) && !Array.isArray(update))
      for (const [ref, patch] of Object.entries(update as Schema.JsonObject)) {
        const emailId = emailOf(ref);

        if (emailId !== undefined && Predicate.isObject(patch) && !Array.isArray(patch))
          updates.push([emailId, patch as Schema.JsonObject]);
      }

    const destroys = Array.isArray(destroy)
      ? (destroy as ReadonlyArray<Schema.Json>).flatMap((ref) => {
          const emailId = Predicate.isString(ref) ? emailOf(ref) : undefined;

          return emailId === undefined ? [] : [emailId];
        })
      : [];

    // The ordinary Email/set path: the viewer's rights, validation and history all apply. The
    // submission's own content pin keeps the bytes it will send (B2).
    const out = this.core.emailSet(
      viewer,
      {
        _tag: "Set",
        type: "Email",
        ifInState: null,
        create: [],
        update: updates,
        destroy: destroys,
        options: {},
        createdIds: known,
      },
      new Map(),
    );

    return Predicate.isTagged(out, "Set") ? out : undefined;
  }

  /** Record that a submission's job state or recipient outcomes moved (EmailSubmission history). */
  touchSubmissionByJob(sendJobId: string): void {
    const row = this.sql.one<{ submission_id: string; principal_id: string | null }>(
      "SELECT submission_id, principal_id FROM jmap_submissions WHERE send_job_id = ?",
      sendJobId,
    );

    if (row) this.core.history.tx(() => this.recordSubmission(row, "updated"));
  }

  /**
   * Release submission content pins once the job has been terminal for the recovery window
   * (B2): the caller's `olderThan` counts from when the job ended (a send held for weeks keeps
   * its bytes that long after it went), or from the pin when the job is gone. Only releasable
   * pins are selected, so jobs still awaiting a decision never fill a batch; this includes pins a
   * destroyed submission left to its job. Owner ranges (not LIKE) keep this on the owner index.
   */
  releaseTerminalPins(olderThan: number, limit = 200): number {
    const owners = this.sql.all<{ owner: string }>(
      `SELECT p.owner FROM jmap_blob_pins p
         LEFT JOIN jmap_submissions s ON s.submission_id = substr(p.owner, 12)
         LEFT JOIN send_jobs j ON j.send_job_id =
           CASE WHEN p.owner >= 'job:' AND p.owner < 'job;' THEN substr(p.owner, 5) ELSE s.send_job_id END
       WHERE ((p.owner >= 'submission:' AND p.owner < 'submission;') OR (p.owner >= 'job:' AND p.owner < 'job;'))
         AND CASE WHEN j.send_job_id IS NULL THEN p.created_at < ?
           ELSE j.state IN ('accepted', 'rejected', 'cancelled') AND j.updated_at < ? END
       ORDER BY p.created_at LIMIT ?`,
      olderThan,
      olderThan,
      limit,
    );

    for (const { owner } of owners) this.core.unpin(owner);

    return owners.length;
  }
}
