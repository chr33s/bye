import { normalizeAddress } from "@bye/domain";
import type { Address } from "@bye/mail-codec";
import { type MailboxContext, reject } from "./context.ts";
import type { IdentityDirectory } from "./identities.ts";
import { type DraftRow, toDraft } from "./rows.ts";
import type {
  MailboxDelivery,
  MailboxDraft,
  MailboxDraftContent,
  MailboxDraftState,
} from "./types.ts";

// Drafts (E17). A draft's state is never written ad hoc: `settleDraft` derives it from its send
// jobs, so every transition (send, undo, acceptance, rejection, publish) agrees.

/**
 * System drafts behind transactional jobs carry secrets (forwarding and send-as verification
 * codes) meant only for the destination; the mailbox principal must never read, edit, resend or
 * delete them. Dispatch renders from `draft_revisions` via the job, not through these reads.
 */
const NOT_SYSTEM = `NOT EXISTS (SELECT 1 FROM send_jobs j WHERE j.draft_id = drafts.draft_id AND j.traffic_class = 'transactional')`;

type CreateDraftResult = {
  readonly draftId: string;
  readonly revision: number;
};

export class MailboxDrafts {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly identities: IdentityDirectory,
    /** Contact-group members (first address of each contact). */
    private readonly groupMembers: (group: string) => ReadonlyArray<string>,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  createDraft(input: {
    readonly threadId?: string;
    readonly content: MailboxDraftContent;
  }): CreateDraftResult {
    return { draftId: this.insertDraft(input.threadId ?? null, input.content), revision: 1 };
  }

  insertDraft(threadId: string | null, content: MailboxDraftContent): string {
    const draftId = this.ctx.id("drf");
    this.sql.run(
      "INSERT INTO drafts (draft_id, thread_id, identity_id, revision, content, state, updated_at) VALUES (?, ?, ?, 1, ?, 'open', ?)",
      draftId,
      threadId,
      content.identityId ?? null,
      JSON.stringify(content),
      this.ctx.now(),
    );
    this.ctx.change("draft", "created", { draftId });

    return draftId;
  }

  /** Autosave with optimistic revision; a stale device gets the current draft, never last-write-wins. */
  saveDraft(
    draftId: string,
    expectedRevision: number,
    content: MailboxDraftContent,
  ):
    | { readonly _tag: "Saved"; readonly revision: number }
    | { readonly _tag: "Conflict"; readonly current: MailboxDraft } {
    const d = this.draft(draftId) ?? reject("not_found", "draft");

    if (d.state !== "open") reject("conflict", "draft is being sent", { state: d.state });

    if (d.revision !== expectedRevision) return { _tag: "Conflict", current: d };
    const revision = d.revision + 1;

    // The forwarded message is server-side provenance that clients never send back (not in the
    // v1 draft contract), so a save keeps it.
    const saved =
      d.content.forwardOf !== undefined && content.forwardOf === undefined
        ? { ...content, forwardOf: d.content.forwardOf }
        : content;

    this.sql.run(
      "UPDATE drafts SET revision = ?, content = ?, identity_id = ?, updated_at = ? WHERE draft_id = ?",
      revision,
      JSON.stringify(saved),
      content.identityId ?? null,
      this.ctx.now(),
      draftId,
    );
    this.ctx.change("draft", "saved", { draftId, revision });

    return { _tag: "Saved", revision };
  }

  deleteDraft(draftId: string): void {
    const d = this.draft(draftId);

    if (d && d.state !== "open") reject("conflict", "draft is being sent");
    this.sql.run(`DELETE FROM drafts WHERE draft_id = ? AND ${NOT_SYSTEM}`, draftId);
    this.ctx.change("draft", "deleted", { draftId });
  }

  draft(draftId: string): MailboxDraft | undefined {
    const r = this.sql.one<DraftRow>(
      `SELECT * FROM drafts WHERE draft_id = ? AND ${NOT_SYSTEM}`,
      draftId,
    );

    return r ? toDraft(r) : undefined;
  }

  drafts(): ReadonlyArray<MailboxDraft> {
    return this.sql
      .all<DraftRow>(
        `SELECT * FROM drafts WHERE state = 'open' AND ${NOT_SYSTEM} ORDER BY updated_at DESC`,
      )
      .map(toDraft);
  }

  /**
   * The draft's state from its send jobs: any job still in flight → `sending`; otherwise any
   * accepted job → `sent`; otherwise (nothing sent, all cancelled/rejected) → `open`.
   */
  settleDraft(draftId: string): MailboxDraftState {
    const r = this.sql.one<{ live: number; accepted: number }>(
      `SELECT SUM(CASE WHEN state NOT IN ('cancelled','accepted','rejected') THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END) AS accepted
       FROM send_jobs WHERE draft_id = ?`,
      draftId,
    );

    const state: MailboxDraftState =
      Number(r?.live ?? 0) > 0 ? "sending" : Number(r?.accepted ?? 0) > 0 ? "sent" : "open";

    this.sql.run(
      "UPDATE drafts SET state = ?, updated_at = ? WHERE draft_id = ? AND state <> ?",
      state,
      this.ctx.now(),
      draftId,
      state,
    );

    return state;
  }

  /** Reply, reply-all or forward draft from the thread's latest inbound message. */
  createReplyDraft(
    threadId: string,
    mode: "reply" | "reply-all" | "forward",
    deliveries: ReadonlyArray<MailboxDelivery>,
  ): string {
    const latest =
      [...deliveries].reverse().find((d) => d.direction === "in") ??
      deliveries.at(-1) ??
      reject("not_found", "thread has no messages");

    const own = this.identities.ownAddresses();

    const identity =
      this.identities.byAddress(latest.recipient) ?? this.identities.defaultIdentity();

    const to: Array<Address> = mode === "forward" ? [] : [latest.from];

    const cc: Array<Address> =
      mode === "reply-all"
        ? [...latest.to, ...latest.cc].filter(
            (a) =>
              !own.has(normalizeAddress(a.address)) &&
              normalizeAddress(a.address) !== normalizeAddress(latest.from.address),
          )
        : [];

    const prefix = mode === "forward" ? "Fwd: " : "Re: ";

    const subject =
      /^(re|fwd?):/i.test(latest.subject) && mode !== "forward"
        ? latest.subject
        : `${prefix}${latest.subject}`;

    const references = deliveries.flatMap((d) => (d.messageIdHeader ? [d.messageIdHeader] : []));

    let content: MailboxDraftContent = {
      to,
      cc,
      bcc: [],
      subject,
      text: "",
      attachments: [],
      references: mode === "forward" ? [] : references.slice(-20),
    };

    if (latest.messageIdHeader && mode !== "forward")
      content = { ...content, inReplyTo: latest.messageIdHeader };

    if (identity) content = { ...content, identityId: identity.identityId };

    if (mode === "forward") content = { ...content, forwardOf: latest.deliveryId };

    return this.insertDraft(threadId, content);
  }

  /** Expand `groups` into To (deduplicated); the frozen revision stores the expanded recipients. */
  expandGroups(content: MailboxDraftContent): MailboxDraftContent {
    if (!content.groups || content.groups.length === 0) return content;

    const present = new Set(
      [...content.to, ...content.cc, ...content.bcc].map((a) => normalizeAddress(a.address)),
    );

    const added: Array<Address> = [];

    for (const g of content.groups) {
      const members = this.groupMembers(g);

      if (members.length === 0)
        reject("bad_request", "unknown or empty contact group", { group: g });

      for (const m of members) {
        const a = normalizeAddress(m);

        if (!present.has(a)) {
          present.add(a);
          added.push({ name: undefined, address: a });
        }
      }
    }

    const { groups: _groups, ...rest } = content;
    void _groups;

    return { ...rest, to: [...content.to, ...added] };
  }

  /** Freeze a draft revision's content for rendering (idempotent). */
  freeze(draftId: string, revision: number, content: MailboxDraftContent): void {
    this.sql.run(
      "INSERT OR IGNORE INTO draft_revisions (draft_id, revision, content) VALUES (?, ?, ?)",
      draftId,
      revision,
      JSON.stringify(content),
    );
  }
}
