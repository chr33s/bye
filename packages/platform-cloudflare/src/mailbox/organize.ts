import { type Destination, domainOf, normalizeAddress } from "@bye/domain";
import type { MessageSummary } from "@bye/mail-codec";
import { json } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import { allInChunks, groupBy, placeholders } from "./rows.ts";

export interface MailboxRuleConditions {
  readonly from?: string;
  readonly fromDomain?: string;
  readonly to?: string;
  readonly subjectContains?: string;
  readonly listId?: string;
}

export interface MailboxRuleActions {
  readonly labels?: ReadonlyArray<string>;
  readonly destination?: Destination;
  readonly bundle?: boolean;
  readonly workflowBoardId?: string;
  /** Copy matching mail to another mailbox the owner is authorized for (checked when the rule is saved). */
  readonly redeliverTo?: string;
}

export interface MailboxRule {
  readonly ruleId: string;
  readonly position: number;
  readonly conditions: MailboxRuleConditions;
  readonly actions: MailboxRuleActions;
  readonly enabled: boolean;
}

export interface MailboxContact {
  readonly contactId: string;
  readonly name: string;
  readonly emails: ReadonlyArray<string>;
  readonly notes: string;
  readonly groups: ReadonlyArray<string>;
}

export type MailboxNote = {
  readonly noteId: string;
  readonly kind: "thread" | "sticky" | "cover";
  readonly threadId: string | null;
  readonly body: string;
  readonly fileKeys: ReadonlyArray<string>;
  readonly revision: number;
  readonly updatedAt: number;
};

export interface MailboxClip {
  readonly clipId: string;
  readonly threadId: string;
  readonly deliveryId: string;
  readonly text: string;
  readonly createdAt: number;
}

interface NoteRow {
  readonly note_id: string;
  readonly kind: MailboxNote["kind"];
  readonly thread_id: string | null;
  readonly body: string;
  readonly file_keys: string;
  readonly revision: number;
  readonly updated_at: number;
}

const toNote = (r: NoteRow): MailboxNote => ({
  noteId: r.note_id,
  kind: r.kind,
  threadId: r.thread_id,
  body: r.body,
  fileKeys: json(r.file_keys, []),
  revision: Number(r.revision),
  updatedAt: Number(r.updated_at),
});

interface ClipRow {
  readonly clip_id: string;
  readonly thread_id: string;
  readonly delivery_id: string;
  readonly text: string;
  readonly created_at: number;
}

const toClip = (r: ClipRow): MailboxClip => ({
  clipId: r.clip_id,
  threadId: r.thread_id,
  deliveryId: r.delivery_id,
  text: r.text,
  createdAt: Number(r.created_at),
});

interface RuleOutcome {
  labels: Array<string>;
  destination?: Destination;
  bundle: boolean;
  workflowBoardId?: string;
  redeliverTo?: string;
}

interface ContactRow {
  readonly contact_id: string;
  readonly name: string;
  readonly emails: string;
  readonly notes: string;
}

type ImportContactsResult = { readonly imported: number };

type BoardResult = {
  readonly boardId: string;
  readonly name: string;
  readonly stages: ReadonlyArray<{
    readonly stageId: string;
    readonly name: string;
    readonly cards: ReadonlyArray<{
      readonly cardId: string;
      readonly threadId: string;
      readonly completed: boolean;
    }>;
  }>;
};

type CreateBoardResult = { readonly boardId: string; readonly stageIds: ReadonlyArray<string> };

/**
 * Personal organization inside MailboxDO: labels, rules, bundles, product workflow boards,
 * personal collections, notes/clips, and contacts (E12–E16). Notes and clips never enter MIME.
 */
export class MailboxOrganizer {
  constructor(private readonly ctx: MailboxContext) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ------------------------------------------------------------ labels (E12)

  labelId(name: string): string | undefined {
    return this.sql.one<{ label_id: string }>(
      "SELECT label_id FROM labels WHERE name = ?",
      name.trim(),
    )?.label_id;
  }

  /** Get-or-create: an existing label with the same name keeps its id. */
  createLabel(name: string, color?: string): string {
    const clean = name.trim();

    if (!clean) reject("bad_request", "label name required");
    const existing = this.labelId(clean);

    if (existing) return existing;
    const id = this.ctx.id("lbl");
    this.sql.run(
      "INSERT INTO labels (label_id, name, color) VALUES (?, ?, ?)",
      id,
      clean,
      color ?? null,
    );
    this.ctx.indexUpsert("label", id);
    this.ctx.change("label", "created", { labelId: id });

    return id;
  }

  renameLabel(labelId: string, name: string): void {
    const clean = name.trim();

    if (!clean) reject("bad_request", "label name required");
    const clash = this.labelId(clean);

    if (clash && clash !== labelId) reject("conflict", "label name already used");

    if (this.sql.run("UPDATE labels SET name = ? WHERE label_id = ?", clean, labelId) === 0)
      reject("not_found", "label");
    this.ctx.indexUpsert("label", labelId);

    for (const t of this.sql.all<{ thread_id: string }>(
      "SELECT thread_id FROM thread_labels WHERE label_id = ?",
      labelId,
    ))
      this.ctx.reindexThread(t.thread_id);
    this.ctx.change("label", "renamed", { labelId });
  }

  deleteLabel(labelId: string): void {
    const threads = this.sql.all<{ thread_id: string }>(
      "SELECT thread_id FROM thread_labels WHERE label_id = ?",
      labelId,
    );

    this.sql.run("DELETE FROM thread_labels WHERE label_id = ?", labelId);
    this.sql.run("DELETE FROM labels WHERE label_id = ?", labelId);
    this.ctx.indexDelete("label", labelId);

    for (const t of threads) this.ctx.reindexThread(t.thread_id);
    this.ctx.change("label", "deleted", { labelId });
  }

  label(
    labelId: string,
  ):
    | { readonly labelId: string; readonly name: string; readonly color: string | null }
    | undefined {
    const r = this.sql.one<{ label_id: string; name: string; color: string | null }>(
      "SELECT label_id, name, color FROM labels WHERE label_id = ?",
      labelId,
    );

    return r ? { labelId: r.label_id, name: r.name, color: r.color } : undefined;
  }

  listLabels(): ReadonlyArray<{
    readonly labelId: string;
    readonly name: string;
    readonly color: string | null;
    readonly threads: number;
  }> {
    return this.sql
      .all<{ label_id: string; name: string; color: string | null; n: number }>(
        "SELECT l.label_id, l.name, l.color, (SELECT COUNT(*) FROM thread_labels t WHERE t.label_id = l.label_id) AS n FROM labels l ORDER BY l.name",
      )
      .map((r) => ({ labelId: r.label_id, name: r.name, color: r.color, threads: Number(r.n) }));
  }

  /** Multi-label assignment. */
  setThreadLabels(
    threadId: string,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
  ): void {
    this.requireThread(threadId);

    for (const name of add) this.assignLabelByName(threadId, name);

    for (const name of remove) {
      const id = this.labelId(name);

      if (id)
        this.sql.run(
          "DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?",
          threadId,
          id,
        );
    }

    this.ctx.reindexThread(threadId);
    this.ctx.change("thread", "labels", { threadId });
  }

  assignLabelByName(threadId: string, name: string): void {
    const id = this.createLabel(name);
    this.sql.run(
      "INSERT OR IGNORE INTO thread_labels (thread_id, label_id) VALUES (?, ?)",
      threadId,
      id,
    );
  }

  threadLabels(threadId: string): ReadonlyArray<string> {
    return this.labelsOf([threadId]).get(threadId) ?? [];
  }

  /** Label names for many threads in one query. */
  labelsOf(threadIds: ReadonlyArray<string>): Map<string, Array<string>> {
    const out = new Map<string, Array<string>>();

    const rows = allInChunks(threadIds, (chunk) =>
      this.sql.all<{ thread_id: string; name: string }>(
        `SELECT t.thread_id, l.name FROM thread_labels t JOIN labels l ON l.label_id = t.label_id WHERE t.thread_id IN (${placeholders(chunk.length)}) ORDER BY l.name`,
        ...chunk,
      ),
    );

    // Each thread's rows come from exactly one chunk, so per-thread name order is preserved.
    for (const [id, group] of groupBy(rows, (r) => r.thread_id))
      out.set(
        id,
        group.map((r) => r.name),
      );

    return out;
  }

  private requireThread(threadId: string): void {
    if (!this.sql.one("SELECT 1 AS x FROM threads WHERE thread_id = ?", threadId))
      reject("not_found", "thread");
  }

  // ------------------------------------------------------------ rules (E12)

  putRule(rule: {
    readonly ruleId?: string;
    readonly conditions: MailboxRuleConditions;
    readonly actions: MailboxRuleActions;
    readonly enabled?: boolean;
    readonly position?: number;
  }): string {
    const c = rule.conditions;

    if (!c.from && !c.fromDomain && !c.to && !c.subjectContains && !c.listId)
      reject("bad_request", "rule needs a condition");
    const ruleId = rule.ruleId ?? this.ctx.id("rul");

    const position =
      rule.position ??
      Number(this.sql.one<{ p: number | null }>("SELECT MAX(position) AS p FROM rules")?.p ?? 0) +
        1;

    this.sql.run(
      `INSERT INTO rules (rule_id, position, conditions, actions, enabled) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (rule_id) DO UPDATE SET position = excluded.position, conditions = excluded.conditions, actions = excluded.actions, enabled = excluded.enabled`,
      ruleId,
      position,
      JSON.stringify(rule.conditions),
      JSON.stringify(rule.actions),
      rule.enabled ?? true,
    );
    this.ctx.change("rule", "put", { ruleId });

    return ruleId;
  }

  deleteRule(ruleId: string): void {
    this.sql.run("DELETE FROM rules WHERE rule_id = ?", ruleId);
    this.ctx.change("rule", "deleted", { ruleId });
  }

  listRules(): ReadonlyArray<MailboxRule> {
    return this.sql
      .all<{
        rule_id: string;
        position: number;
        conditions: string;
        actions: string;
        enabled: number;
      }>("SELECT * FROM rules ORDER BY position, rule_id")
      .map((r) => ({
        ruleId: r.rule_id,
        position: Number(r.position),
        conditions: json(r.conditions, {}),
        actions: json(r.actions, {}),
        enabled: r.enabled === 1,
      }));
  }

  /**
   * Deterministic evaluation in position order: labels accumulate; the first matching rule
   * that sets a destination or workflow wins.
   */
  evaluateRules(summary: MessageSummary, recipient: string): RuleOutcome {
    const from = normalizeAddress(summary.from.address);

    const recipients = new Set(
      [recipient, ...summary.to.map((a) => a.address), ...summary.cc.map((a) => a.address)].map(
        normalizeAddress,
      ),
    );

    const out: RuleOutcome = { labels: [], bundle: false };

    for (const rule of this.listRules()) {
      if (!rule.enabled) continue;
      const c = rule.conditions;

      const match =
        (!c.from || normalizeAddress(c.from) === from) &&
        (!c.fromDomain ||
          domainOf(from) === normalizeAddress(c.fromDomain) ||
          domainOf(from).endsWith(`.${normalizeAddress(c.fromDomain)}`)) &&
        (!c.to || recipients.has(normalizeAddress(c.to))) &&
        (!c.subjectContains ||
          summary.subject.toLowerCase().includes(c.subjectContains.toLowerCase())) &&
        (!c.listId || (summary.listId ?? "").toLowerCase().includes(c.listId.toLowerCase()));

      if (!match) continue;
      out.labels.push(...(rule.actions.labels ?? []));

      if (rule.actions.destination && !out.destination) out.destination = rule.actions.destination;

      if (rule.actions.bundle) out.bundle = true;

      if (rule.actions.workflowBoardId && !out.workflowBoardId)
        out.workflowBoardId = rule.actions.workflowBoardId;

      if (
        rule.actions.redeliverTo &&
        !out.redeliverTo &&
        rule.actions.redeliverTo !== this.ctx.mailboxId
      )
        out.redeliverTo = rule.actions.redeliverTo;
    }

    return out;
  }

  // ------------------------------------------------------------ product workflows (E13)

  createBoard(
    name: string,
    stages: ReadonlyArray<string>,
    enrollAddress?: string,
  ): CreateBoardResult {
    if (stages.length === 0) reject("bad_request", "board needs a stage");
    const boardId = this.ctx.id("wfb");
    this.sql.run(
      "INSERT INTO workflow_boards (board_id, name, enroll_address) VALUES (?, ?, ?)",
      boardId,
      name,
      enrollAddress ? normalizeAddress(enrollAddress) : null,
    );

    const stageIds = stages.map((s, i) => {
      const id = this.ctx.id("wfs");
      this.sql.run(
        "INSERT INTO workflow_stages (stage_id, board_id, name, position) VALUES (?, ?, ?, ?)",
        id,
        boardId,
        s,
        i,
      );

      return id;
    });

    this.ctx.change("workflow", "created", { boardId });

    return { boardId, stageIds };
  }

  addStage(boardId: string, name: string): string {
    if (!this.sql.one("SELECT 1 AS x FROM workflow_boards WHERE board_id = ?", boardId))
      reject("not_found", "board");

    if (!name.trim()) reject("bad_request", "stage name required");

    const pos =
      Number(
        this.sql.one<{ p: number | null }>(
          "SELECT MAX(position) AS p FROM workflow_stages WHERE board_id = ?",
          boardId,
        )?.p ?? -1,
      ) + 1;

    const id = this.ctx.id("wfs");
    this.sql.run(
      "INSERT INTO workflow_stages (stage_id, board_id, name, position) VALUES (?, ?, ?, ?)",
      id,
      boardId,
      name,
      pos,
    );
    this.ctx.change("workflow", "stage", { boardId });

    return id;
  }

  renameStage(stageId: string, name: string): void {
    if (!name.trim()) reject("bad_request", "stage name required");

    if (
      this.sql.run(
        "UPDATE workflow_stages SET name = ? WHERE stage_id = ?",
        name.trim(),
        stageId,
      ) === 0
    )
      reject("not_found", "stage");
    this.ctx.change("workflow", "stage", { stageId });
  }

  listBoards(): ReadonlyArray<{
    readonly boardId: string;
    readonly name: string;
    readonly enrollAddress: string | null;
    readonly cards: number;
  }> {
    return this.sql
      .all<{ board_id: string; name: string; enroll_address: string | null; n: number }>(
        "SELECT b.board_id, b.name, b.enroll_address, (SELECT COUNT(*) FROM workflow_cards c WHERE c.board_id = b.board_id AND c.completed_at IS NULL) AS n FROM workflow_boards b ORDER BY b.name",
      )
      .map((r) => ({
        boardId: r.board_id,
        name: r.name,
        enrollAddress: r.enroll_address,
        cards: Number(r.n),
      }));
  }

  enrollInBoard(boardId: string, threadId: string): string | undefined {
    const first = this.sql.one<{ stage_id: string }>(
      "SELECT stage_id FROM workflow_stages WHERE board_id = ? ORDER BY position LIMIT 1",
      boardId,
    );

    if (!first) return undefined;

    const existing = this.sql.one<{ card_id: string }>(
      "SELECT card_id FROM workflow_cards WHERE board_id = ? AND thread_id = ?",
      boardId,
      threadId,
    );

    if (existing) return existing.card_id;

    const pos =
      Number(
        this.sql.one<{ p: number | null }>(
          "SELECT MAX(position) AS p FROM workflow_cards WHERE stage_id = ?",
          first.stage_id,
        )?.p ?? -1,
      ) + 1;

    const cardId = this.ctx.id("wfc");
    this.sql.run(
      "INSERT INTO workflow_cards (card_id, board_id, stage_id, thread_id, position) VALUES (?, ?, ?, ?, ?)",
      cardId,
      boardId,
      first.stage_id,
      threadId,
      pos,
    );
    this.ctx.change("workflow", "enrolled", { boardId, threadId });

    return cardId;
  }

  /** Extension-triggered enrollment: mail to a board's enrollment address joins its first stage. */
  enrollByAddress(threadId: string, recipients: ReadonlyArray<string>): void {
    if (recipients.length === 0) return;
    const addresses = recipients.slice(0, 50);

    const boards = this.sql.all<{ board_id: string }>(
      `SELECT board_id FROM workflow_boards WHERE enroll_address IN (${placeholders(addresses.length)})`,
      ...addresses,
    );

    for (const b of boards) this.enrollInBoard(b.board_id, threadId);
  }

  addToBoard(boardId: string, threadId: string): string {
    this.requireThread(threadId);

    return this.enrollInBoard(boardId, threadId) ?? reject("not_found", "board");
  }

  moveCard(cardId: string, stageId: string, position: number): void {
    const card =
      this.sql.one<{ board_id: string }>(
        "SELECT board_id FROM workflow_cards WHERE card_id = ?",
        cardId,
      ) ?? reject("not_found", "card");

    if (
      !this.sql.one(
        "SELECT 1 AS x FROM workflow_stages WHERE stage_id = ? AND board_id = ?",
        stageId,
        card.board_id,
      )
    )
      reject("bad_request", "stage not on board");
    this.sql.run(
      "UPDATE workflow_cards SET position = position + 1 WHERE stage_id = ? AND position >= ?",
      stageId,
      position,
    );
    this.sql.run(
      "UPDATE workflow_cards SET stage_id = ?, position = ? WHERE card_id = ?",
      stageId,
      position,
      cardId,
    );
    this.ctx.change("workflow", "moved", { cardId });
  }

  completeCard(cardId: string, done: boolean): void {
    this.sql.run(
      "UPDATE workflow_cards SET completed_at = ? WHERE card_id = ?",
      done ? this.ctx.now() : null,
      cardId,
    );
    this.ctx.change("workflow", "completed", { cardId, done });
  }

  board(boardId: string): BoardResult {
    const b =
      this.sql.one<{ name: string }>(
        "SELECT name FROM workflow_boards WHERE board_id = ?",
        boardId,
      ) ?? reject("not_found", "board");

    const stages = this.sql.all<{ stage_id: string; name: string }>(
      "SELECT stage_id, name FROM workflow_stages WHERE board_id = ? ORDER BY position",
      boardId,
    );

    const cards = groupBy(
      this.sql.all<{
        card_id: string;
        stage_id: string;
        thread_id: string;
        completed_at: number | null;
      }>(
        "SELECT card_id, stage_id, thread_id, completed_at FROM workflow_cards WHERE board_id = ? ORDER BY position, card_id",
        boardId,
      ),
      (c) => c.stage_id,
    );

    return {
      boardId,
      name: b.name,
      stages: stages.map((s) => ({
        stageId: s.stage_id,
        name: s.name,
        cards: (cards.get(s.stage_id) ?? []).map((c) => ({
          cardId: c.card_id,
          threadId: c.thread_id,
          completed: c.completed_at !== null,
        })),
      })),
    };
  }

  // ------------------------------------------------------------ personal collections (E14)

  createCollection(name: string): string {
    const id = this.ctx.id("col");
    this.sql.run(
      "INSERT INTO collections (collection_id, name, created_at) VALUES (?, ?, ?)",
      id,
      name,
      this.ctx.now(),
    );
    this.ctx.change("collection", "created", { collectionId: id });

    return id;
  }

  setCollectionItems(
    collectionId: string,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
  ): void {
    if (!this.sql.one("SELECT 1 AS x FROM collections WHERE collection_id = ?", collectionId))
      reject("not_found", "collection");

    for (const t of add) {
      this.requireThread(t);
      this.sql.run(
        "INSERT OR IGNORE INTO collection_items (collection_id, thread_id, added_at) VALUES (?, ?, ?)",
        collectionId,
        t,
        this.ctx.now(),
      );
    }

    for (const t of remove)
      this.sql.run(
        "DELETE FROM collection_items WHERE collection_id = ? AND thread_id = ?",
        collectionId,
        t,
      );
    this.ctx.change("collection", "items", { collectionId });
  }

  /** Aggregated timeline across referenced threads; no forwarding copies are created. */
  collection(
    collectionId: string,
  ): { readonly collectionId: string; readonly name: string } | undefined {
    const r = this.sql.one<{ collection_id: string; name: string }>(
      "SELECT collection_id, name FROM collections WHERE collection_id = ?",
      collectionId,
    );

    return r ? { collectionId: r.collection_id, name: r.name } : undefined;
  }

  collectionTimeline(collectionId: string): ReadonlyArray<{
    readonly threadId: string;
    readonly deliveryId: string;
    readonly subject: string;
    readonly from: string;
    readonly date: number;
  }> {
    return this.sql
      .all<{
        thread_id: string;
        delivery_id: string;
        subject: string;
        from_address: string;
        date: number;
      }>(
        // Permissions apply per message: trashed, spam and quarantined threads never surface (E14).
        `SELECT d.thread_id, d.delivery_id, d.subject, d.from_address, d.date FROM collection_items c
         JOIN deliveries d ON d.thread_id = c.thread_id JOIN threads t ON t.thread_id = d.thread_id
         WHERE c.collection_id = ? AND t.disposition = 'active' AND t.quarantined = 0 ORDER BY d.date, d.delivery_id`,
        collectionId,
      )
      .map((r) => ({
        threadId: r.thread_id,
        deliveryId: r.delivery_id,
        subject: r.subject,
        from: r.from_address,
        date: Number(r.date),
      }));
  }

  listCollections(): ReadonlyArray<{
    readonly collectionId: string;
    readonly name: string;
    readonly threads: number;
  }> {
    return this.sql
      .all<{ collection_id: string; name: string; n: number }>(
        "SELECT c.collection_id, c.name, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.collection_id) AS n FROM collections c ORDER BY c.name",
      )
      .map((r) => ({ collectionId: r.collection_id, name: r.name, threads: Number(r.n) }));
  }

  // ------------------------------------------------------------ notes & clips (E15)

  /** Optimistic-revision note upsert; returns Conflict instead of overwriting a newer note. */
  putNote(input: {
    readonly noteId?: string;
    readonly kind: "thread" | "sticky" | "cover";
    readonly threadId?: string;
    readonly body: string;
    readonly fileKeys?: ReadonlyArray<string>;
    readonly expectedRevision?: number;
  }):
    | { readonly _tag: "Saved"; readonly noteId: string; readonly revision: number }
    | { readonly _tag: "Conflict"; readonly note: MailboxNote } {
    if (input.threadId) this.requireThread(input.threadId);

    if (input.kind === "thread" && !input.threadId)
      reject("bad_request", "thread note requires threadId");
    const existing = input.noteId ? this.note(input.noteId) : undefined;

    if (existing && input.expectedRevision !== existing.revision)
      return { _tag: "Conflict", note: existing };
    const noteId = existing?.noteId ?? input.noteId ?? this.ctx.id("not");
    const revision = (existing?.revision ?? 0) + 1;
    this.sql.run(
      `INSERT INTO notes (note_id, kind, thread_id, body, file_keys, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (note_id) DO UPDATE SET body = excluded.body, file_keys = excluded.file_keys, revision = excluded.revision, updated_at = excluded.updated_at`,
      noteId,
      input.kind,
      input.threadId ?? null,
      input.body,
      JSON.stringify(input.fileKeys ?? []),
      revision,
      this.ctx.now(),
    );
    this.ctx.indexUpsert("note", noteId);
    this.ctx.change("note", "saved", { noteId });

    return { _tag: "Saved", noteId, revision };
  }

  deleteNote(noteId: string): void {
    this.sql.run("DELETE FROM notes WHERE note_id = ?", noteId);
    this.ctx.indexDelete("note", noteId);
    this.ctx.change("note", "deleted", { noteId });
  }

  note(noteId: string): MailboxNote | undefined {
    const r = this.sql.one<NoteRow>("SELECT * FROM notes WHERE note_id = ?", noteId);

    return r ? toNote(r) : undefined;
  }

  notes(filter: {
    readonly threadId?: string;
    readonly kind?: MailboxNote["kind"];
  }): ReadonlyArray<MailboxNote> {
    return this.sql
      .all<NoteRow>(
        "SELECT * FROM notes WHERE (? IS NULL OR thread_id = ?) AND (? IS NULL OR kind = ?) ORDER BY updated_at DESC",
        filter.threadId ?? null,
        filter.threadId ?? null,
        filter.kind ?? null,
        filter.kind ?? null,
      )
      .map(toNote);
  }

  createClip(threadId: string, deliveryId: string, text: string): string {
    if (
      !this.sql.one(
        "SELECT 1 AS x FROM deliveries WHERE delivery_id = ? AND thread_id = ?",
        deliveryId,
        threadId,
      )
    )
      reject("not_found", "delivery");
    const clipId = this.ctx.id("clp");
    this.sql.run(
      "INSERT INTO clips (clip_id, thread_id, delivery_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
      clipId,
      threadId,
      deliveryId,
      text,
      this.ctx.now(),
    );
    this.ctx.indexUpsert("clip", clipId);
    this.ctx.change("clip", "created", { clipId });

    return clipId;
  }

  /** Clips library with source links back to the thread/delivery. */
  clips(query?: string): ReadonlyArray<MailboxClip> {
    return this.sql
      .all<ClipRow>(
        "SELECT * FROM clips WHERE (? IS NULL OR instr(lower(text), ?) > 0) ORDER BY created_at DESC",
        query || null,
        query ? query.toLowerCase() : null,
      )
      .map(toClip);
  }

  clip(clipId: string): MailboxClip | undefined {
    const r = this.sql.one<ClipRow>("SELECT * FROM clips WHERE clip_id = ?", clipId);

    return r ? toClip(r) : undefined;
  }

  // ------------------------------------------------------------ contacts (E16)

  putContact(contact: {
    readonly contactId?: string;
    readonly name: string;
    readonly emails: ReadonlyArray<string>;
    readonly notes?: string;
    readonly groups?: ReadonlyArray<string>;
  }): string {
    const id = contact.contactId ?? this.ctx.id("con");
    this.sql.run(
      `INSERT INTO contacts (contact_id, name, emails, notes, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (contact_id) DO UPDATE SET name = excluded.name, emails = excluded.emails, notes = excluded.notes, updated_at = excluded.updated_at`,
      id,
      contact.name,
      JSON.stringify(contact.emails.map(normalizeAddress)),
      contact.notes ?? "",
      this.ctx.now(),
    );

    if (contact.groups) {
      this.sql.run("DELETE FROM contact_group_members WHERE contact_id = ?", id);

      for (const g of contact.groups) {
        let gid = this.sql.one<{ group_id: string }>(
          "SELECT group_id FROM contact_groups WHERE name = ?",
          g,
        )?.group_id;

        if (!gid) {
          gid = this.ctx.id("grp");
          this.sql.run("INSERT INTO contact_groups (group_id, name) VALUES (?, ?)", gid, g);
        }

        this.sql.run(
          "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
          gid,
          id,
        );
      }
    }

    this.ctx.indexUpsert("contact", id);
    this.ctx.change("contact", "put", { contactId: id });

    return id;
  }

  deleteContact(contactId: string): void {
    this.sql.run("DELETE FROM contact_group_members WHERE contact_id = ?", contactId);
    this.sql.run("DELETE FROM contacts WHERE contact_id = ?", contactId);
    this.ctx.indexDelete("contact", contactId);
    this.ctx.change("contact", "deleted", { contactId });
  }

  contact(contactId: string): MailboxContact | undefined {
    return this.toContacts(
      this.sql.all<ContactRow>("SELECT * FROM contacts WHERE contact_id = ?", contactId),
    )[0];
  }

  /** Contacts with their groups loaded in one query. */
  private toContacts(rows: ReadonlyArray<ContactRow>): Array<MailboxContact> {
    if (rows.length === 0) return [];
    const groups = new Map<string, Array<string>>();

    const found = allInChunks(
      rows.map((r) => r.contact_id),
      (chunk) =>
        this.sql.all<{ contact_id: string; name: string }>(
          `SELECT m.contact_id, g.name FROM contact_group_members m JOIN contact_groups g ON g.group_id = m.group_id WHERE m.contact_id IN (${placeholders(chunk.length)}) ORDER BY g.name`,
          ...chunk,
        ),
    );

    for (const [id, group] of groupBy(found, (g) => g.contact_id))
      groups.set(
        id,
        group.map((g) => g.name),
      );

    return rows.map((r) => ({
      contactId: r.contact_id,
      name: r.name,
      emails: json(r.emails, []),
      notes: r.notes,
      groups: groups.get(r.contact_id) ?? [],
    }));
  }

  /** Search name, addresses, and notes. */
  searchContacts(query: string): ReadonlyArray<MailboxContact> {
    // instr() instead of LIKE: DO SQLite caps LIKE patterns at 50 bytes, and user input can exceed it.
    const needle = query.toLowerCase();

    return this.toContacts(
      this.sql.all<ContactRow>(
        "SELECT * FROM contacts WHERE instr(lower(name), ?) > 0 OR instr(lower(emails), ?) > 0 OR instr(lower(notes), ?) > 0 ORDER BY name",
        needle,
        needle,
        needle,
      ),
    );
  }

  groupMembers(group: string): ReadonlyArray<string> {
    return this.sql
      .all<{ emails: string }>(
        "SELECT c.emails FROM contact_groups g JOIN contact_group_members m ON m.group_id = g.group_id JOIN contacts c ON c.contact_id = m.contact_id WHERE g.name = ?",
        group,
      )
      .flatMap((r) => json<Array<string>>(r.emails, []).slice(0, 1));
  }

  /** Sender/domain history (From filter). */
  senderHistory(
    addressOrDomain: string,
    limit = 50,
  ): ReadonlyArray<{
    readonly deliveryId: string;
    readonly threadId: string;
    readonly subject: string;
    readonly date: number;
  }> {
    const q = normalizeAddress(addressOrDomain);
    // Domain match is a suffix comparison, not LIKE: DO SQLite caps LIKE patterns at 50 bytes.
    const exact = q.includes("@");
    const where = exact ? "from_address = ?" : "lower(substr(from_address, -length(?))) = ?";

    return this.sql
      .all<{ delivery_id: string; thread_id: string; subject: string; date: number }>(
        `SELECT delivery_id, thread_id, subject, date FROM deliveries WHERE direction = 'in' AND ${where} ORDER BY date DESC LIMIT ?`,
        ...(exact ? [q] : [`@${q}`, `@${q}`]),
        limit,
      )
      .map((r) => ({
        deliveryId: r.delivery_id,
        threadId: r.thread_id,
        subject: r.subject,
        date: Number(r.date),
      }));
  }

  /** To filter: messages we sent to an address. */
  recipientHistory(
    address: string,
    limit = 50,
  ): ReadonlyArray<{
    readonly deliveryId: string;
    readonly threadId: string;
    readonly subject: string;
    readonly date: number;
  }> {
    return this.sql
      .all<{ delivery_id: string; thread_id: string; subject: string; date: number }>(
        "SELECT delivery_id, thread_id, subject, date FROM deliveries WHERE direction = 'out' AND instr(lower(to_json), ?) > 0 ORDER BY date DESC LIMIT ?",
        JSON.stringify(normalizeAddress(address)),
        limit,
      )
      .map((r) => ({
        deliveryId: r.delivery_id,
        threadId: r.thread_id,
        subject: r.subject,
        date: Number(r.date),
      }));
  }

  recordRecipients(
    addresses: ReadonlyArray<{ readonly address: string; readonly name?: string | undefined }>,
  ): void {
    for (const a of addresses) {
      this.sql.run(
        `INSERT INTO recent_recipients (address, name, last_used_at, uses) VALUES (?, ?, ?, 1)
         ON CONFLICT (address) DO UPDATE SET last_used_at = excluded.last_used_at, uses = uses + 1, name = COALESCE(excluded.name, name)`,
        normalizeAddress(a.address),
        a.name ?? null,
        this.ctx.now(),
      );
    }
  }

  /** Recent-recipient suggestions merged with contacts, prefix match. */
  suggestRecipients(
    prefix: string,
    limit = 10,
  ): ReadonlyArray<{ readonly address: string; readonly name: string | null }> {
    const needle = prefix.toLowerCase();

    const recent = this.sql.all<{ address: string; name: string | null }>(
      "SELECT address, name FROM recent_recipients WHERE instr(lower(address), ?) = 1 OR instr(lower(COALESCE(name, '')), ?) = 1 ORDER BY last_used_at DESC, uses DESC LIMIT ?",
      needle,
      needle,
      limit,
    );

    const seen = new Set(recent.map((r) => r.address));

    const contacts = this.searchContacts(prefix)
      .flatMap((c) => c.emails.map((address) => ({ address, name: c.name })))
      .filter((c) => !seen.has(c.address));

    return [...recent, ...contacts].slice(0, limit);
  }

  /** Bulk vCard import after codec parsing; merges on first email address. */
  importContacts(
    contacts: ReadonlyArray<{
      readonly name: string;
      readonly emails: ReadonlyArray<string>;
      readonly notes?: string;
    }>,
  ): ImportContactsResult {
    let imported = 0;

    for (const c of contacts) {
      const primary = c.emails[0] ? normalizeAddress(c.emails[0]) : undefined;

      const existing = primary
        ? this.sql.one<{ contact_id: string }>(
            "SELECT contact_id FROM contacts WHERE instr(lower(emails), ?) > 0",
            JSON.stringify(primary),
          )
        : undefined;

      let contact: Parameters<typeof this.putContact>[0] = {
        name: c.name,
        emails: c.emails,
        notes: c.notes ?? "",
      };

      if (existing) contact = { ...contact, contactId: existing.contact_id };
      this.putContact(contact);
      imported++;
    }

    return { imported };
  }

  exportContacts(): ReadonlyArray<MailboxContact> {
    return this.toContacts(this.sql.all<ContactRow>("SELECT * FROM contacts ORDER BY name"));
  }
}
