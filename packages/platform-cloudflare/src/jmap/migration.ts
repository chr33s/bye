import type { MailboxRights } from "@bye/jmap";
import { Predicate } from "effect";
import { json } from "../durable/sql.ts";
import { FULL_RIGHTS, type JmapCore, type JmapMode, type PreparedContent } from "./core.ts";

// Per-account single-writer migration (spec.md §16 C3):
//
//   legacy → fencing → backfilling → verifying → activating → jmap
//                         └──────── failed/paused; resume from checkpoint
//
// Fencing stops old writers at their authoritative boundary (every writer checks the mode and
// epoch); arrivals and scan outcomes are buffered with stable event IDs; backfilling applies the
// versioned mapping in bounded idempotent checkpoints from the frozen legacy input; verifying
// blocks activation on any missing or contradictory mapping; activation is the no-backend-rollback
// point. The host performs the network steps (reading originals, writing draft bytes) between the
// synchronous steps here, so no transaction spans an await (§4).

export const MAPPING_VERSION = 2;

/** Deliveries per backfill checkpoint. */
export const BACKFILL_BATCH = 100;

export interface MigrationStatus {
  readonly mode: JmapMode;
  readonly epoch: number;
  readonly mappingVersion: number;
  readonly checkpoint: string;
  readonly stage: "deliveries" | "drafts" | "finish" | "done";
  readonly verified: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly buffered: number;
}

export interface BackfillItem {
  readonly deliveryId: string;
  readonly messageKey: string;
}

export interface DraftItem {
  readonly draftId: string;
  readonly content: string;
  readonly threadId: string | null;
}

/** A buffered unit of work captured while fenced (C3 "Buffered work"). */
export interface BufferedEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: "arrival" | "transfer" | "scan" | "outgoing";
  readonly payload: string;
}

/** Writers that are fenced while the mode is one of these (C3). */
export const FENCED_MODES: ReadonlyArray<JmapMode> = [
  "fencing",
  "backfilling",
  "verifying",
  "activating",
];

const DRAFT_KEYWORDS = ["$draft", "$seen"];

export class JmapMigration {
  constructor(private readonly core: JmapCore) {}

  private get sql() {
    return this.core.sql;
  }

  status(): MigrationStatus {
    return {
      mode: this.core.mode(),
      epoch: this.core.epoch(),
      mappingVersion: this.core.meta<number>("mappingVersion", MAPPING_VERSION),
      checkpoint: this.core.meta<string>("checkpoint", ""),
      stage: this.core.meta<MigrationStatus["stage"]>("stage", "deliveries"),
      verified: this.core.meta<boolean>("verified", false),
      problems: this.core.meta<ReadonlyArray<string>>("problems", []),
      buffered: Number(
        this.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jmap_buffer WHERE applied_at IS NULL",
        )?.n ?? 0,
      ),
    };
  }

  fenced(): boolean {
    return FENCED_MODES.includes(this.core.mode());
  }

  private setMode(mode: JmapMode): void {
    this.core.putMeta("mode", mode);
    this.core.audit("migration", mode, `epoch ${this.core.epoch()}`);
  }

  /**
   * Fence the legacy writers: from here old interactive commands are refused with a retry
   * response, arrivals buffer, and no new dispatch claims start (C3 Fencing).
   */
  fence(input: {
    readonly inputChecksum: string;
    readonly grants: ReadonlyArray<{
      readonly principalId: string;
      readonly rights?: MailboxRights;
    }>;
  }): MigrationStatus {
    this.sql.tx(() => {
      const mode = this.core.mode();

      if (mode !== "legacy" && mode !== "failed") return;
      this.core.putMeta("epoch", this.core.epoch() + 1);
      this.core.putMeta("mappingVersion", MAPPING_VERSION);
      this.core.putMeta("inputChecksum", input.inputChecksum);
      this.core.putMeta("checkpoint", "");
      this.core.putMeta("stage", "deliveries");
      this.core.putMeta("verified", false);
      this.core.putMeta("problems", []);
      // Verification judges this attempt's audit rows only: an aborted attempt's findings stay
      // in the log but can't block a retry after the cause is fixed.
      this.core.putMeta(
        "auditFrom",
        Number(this.sql.one<{ n: number | null }>("SELECT MAX(seq) AS n FROM jmap_audit")?.n ?? 0),
      );
      this.core.putMeta(
        "grantsInput",
        input.grants.map((g) => ({
          principalId: g.principalId,
          rights: g.rights ?? FULL_RIGHTS,
        })) as never,
      );
      this.setMode("fencing");
    });

    return this.status();
  }

  /** In-flight external attempts must be drained or classified before backfill (C3). */
  beginBackfill(submittingJobs: number): MigrationStatus {
    if (this.core.mode() !== "fencing") return this.status();

    if (submittingJobs > 0) {
      this.core.putMeta("problems", [
        `${submittingJobs} send attempt(s) still in flight; retry after they settle`,
      ]);

      return this.status();
    }

    this.sql.tx(() => {
      this.core.ensureDefaults();
      this.mapLabels();
      this.core.putMeta("problems", []);
      this.setMode("backfilling");
    });

    return this.status();
  }

  // ---------------------------------------------------------------- buffered work

  buffer(kind: BufferedEvent["kind"], eventId: string, payload: string): void {
    this.sql.run(
      "INSERT OR IGNORE INTO jmap_buffer (event_id, kind, payload) VALUES (?, ?, ?)",
      eventId,
      kind,
      payload,
    );
  }

  /** Unapplied buffered events in source order. */
  buffered(limit: number): ReadonlyArray<BufferedEvent> {
    return this.sql
      .all<{ seq: number; event_id: string; kind: BufferedEvent["kind"]; payload: string }>(
        "SELECT seq, event_id, kind, payload FROM jmap_buffer WHERE applied_at IS NULL ORDER BY seq LIMIT ?",
        limit,
      )
      .map((r) => ({ seq: Number(r.seq), eventId: r.event_id, kind: r.kind, payload: r.payload }));
  }

  markApplied(seq: number): void {
    this.sql.run("UPDATE jmap_buffer SET applied_at = ? WHERE seq = ?", this.core.clock.now(), seq);
  }

  // ---------------------------------------------------------------- backfill

  /** Labels become role-less Mailboxes with the IDs the read-only projection exposed. */
  private mapLabels(): void {
    for (const l of this.sql.all<{ label_id: string; name: string }>(
      "SELECT label_id, name FROM labels",
    )) {
      const id = `label-${l.label_id}`;

      const created =
        this.sql.run(
          "INSERT OR IGNORE INTO jmap_mailboxes (mailbox_id, name, parent_id, role, sort_order, created_rev) VALUES (?, ?, NULL, NULL, 200, 0)",
          id,
          l.name,
        ) > 0;

      if (created) this.core.history.tx(() => this.core.history.record("Mailbox", id, "created"));
      this.idMap("label", l.label_id, id);
    }
  }

  private idMap(kind: string, legacyId: string, jmapId: string): void {
    this.sql.run(
      "INSERT OR IGNORE INTO jmap_id_map (kind, legacy_id, jmap_id) VALUES (?, ?, ?)",
      kind,
      legacyId,
      jmapId,
    );
  }

  /** The next deliveries to backfill after the checkpoint (frozen legacy input). */
  nextDeliveries(limit = BACKFILL_BATCH): ReadonlyArray<BackfillItem> {
    if (this.core.mode() !== "backfilling" || this.status().stage !== "deliveries") return [];

    return this.sql
      .all<{ delivery_id: string; message_key: string }>(
        "SELECT delivery_id, message_key FROM deliveries WHERE delivery_id > ? ORDER BY delivery_id LIMIT ?",
        this.core.meta<string>("checkpoint", ""),
        limit,
      )
      .map((r) => ({ deliveryId: r.delivery_id, messageKey: r.message_key }));
  }

  /**
   * Apply one checkpoint of the v2 mapping (idempotent): placement + labels → memberships,
   * revision watermark → `$seen` (conservatively unread when incomparable), preserved
   * `original_thread_id` → fixed Thread. Missing originals are audited and block activation.
   */
  applyDeliveries(
    batch: ReadonlyArray<{ readonly deliveryId: string; readonly content: PreparedContent | null }>,
  ): MigrationStatus {
    if (this.core.mode() !== "backfilling") return this.status();

    this.core.history.tx(() => {
      for (const item of batch) {
        if (this.sql.one("SELECT 1 AS x FROM jmap_emails WHERE email_id = ?", item.deliveryId))
          continue;

        const d = this.sql.one<{
          delivery_id: string;
          thread_id: string;
          original_thread_id: string;
          direction: "in" | "out";
          thread_revision: number;
          received_at: number;
          scan_status: string | null;
          disposition: string | null;
          disposition_at: number | null;
          destination: string | null;
          seen_revision: number | null;
          quarantined: number | null;
        }>(
          `SELECT d.delivery_id, d.thread_id, d.original_thread_id, d.direction, d.thread_revision, d.received_at, d.scan_status,
             t.disposition, t.disposition_at, t.destination, t.seen_revision, t.quarantined
           FROM deliveries d LEFT JOIN threads t ON t.thread_id = d.thread_id WHERE d.delivery_id = ?`,
          item.deliveryId,
        );

        if (!d) continue;

        if (item.content === null) {
          this.core.audit("missing-original", d.delivery_id, "original message bytes unavailable");
          continue;
        }

        const t = this.core.workflowTargets();

        let placement: string | undefined =
          d.disposition === "trash"
            ? "trash"
            : d.disposition === "spam"
              ? "junk"
              : d.direction === "out"
                ? "sent"
                : d.disposition === "screening"
                  ? t.screener
                  : d.disposition === "screened-out"
                    ? t.screenedOut
                    : d.disposition === "active"
                      ? d.destination === "feed"
                        ? t.feed
                        : d.destination === "paper-trail"
                          ? t.paperTrail
                          : "inbox"
                      : undefined;

        if (placement === undefined) {
          placement = "archive";
          this.core.audit("inferred", d.delivery_id, "no resolved placement; mapped to Archive");
        }

        const labels = this.sql
          .all<{ label_id: string }>(
            "SELECT label_id FROM thread_labels WHERE thread_id = ?",
            d.thread_id,
          )
          .map((l) => `label-${l.label_id}`);

        const comparable = d.thread_id === d.original_thread_id && d.seen_revision !== null;

        const seen =
          d.direction === "out" ||
          (comparable && Number(d.thread_revision) <= Number(d.seen_revision));

        if (!comparable && d.direction === "in")
          this.core.audit(
            "inferred",
            d.delivery_id,
            "read state incomparable after merge; mapped unread",
          );

        this.core.publish({
          emailId: d.delivery_id,
          content: item.content,
          mailboxIds: [placement, ...labels],
          keywords: seen ? ["$seen"] : [],
          receivedAt: Number(d.received_at),
          // Trash/Spam retention keeps counting from when the legacy thread got there.
          placedAt: Number(d.disposition_at ?? d.received_at),
          threadId: d.original_thread_id,
          scanStatus: d.scan_status ?? "legacy",
          quarantined: d.quarantined === 1,
          legacyDeliveryId: d.delivery_id,
        });
        this.idMap("delivery", d.delivery_id, d.delivery_id);
      }

      const last = batch.at(-1)?.deliveryId;

      if (last !== undefined) this.core.putMeta("checkpoint", last);

      if (batch.length === 0) this.core.putMeta("stage", "drafts");
    });

    return this.status();
  }

  /** Open user drafts to convert (system drafts behind transactional jobs are never exposed). */
  nextDrafts(): ReadonlyArray<DraftItem> {
    if (this.core.mode() !== "backfilling" || this.status().stage !== "drafts") return [];

    return this.sql
      .all<{ draft_id: string; content: string; thread_id: string | null }>(
        `SELECT draft_id, content, thread_id FROM drafts d WHERE state = 'open'
           AND NOT EXISTS (SELECT 1 FROM send_jobs j WHERE j.draft_id = d.draft_id AND j.traffic_class = 'transactional')
           AND NOT EXISTS (SELECT 1 FROM jmap_id_map m WHERE m.kind = 'draft' AND m.legacy_id = d.draft_id)
         ORDER BY draft_id LIMIT 50`,
      )
      .map((r) => ({ draftId: r.draft_id, content: r.content, threadId: r.thread_id }));
  }

  /** Convert one draft to an immutable Email in Drafts and a DraftSession for its owner. */
  applyDraft(draftId: string, content: PreparedContent | null, principalId: string): void {
    this.core.history.tx(() => {
      if (content === null) {
        this.core.audit("unsupported", draftId, "draft could not be rendered");
        this.idMap("draft", draftId, "");

        return;
      }

      const emailId = this.core.clock.id("eml");

      this.core.publish({
        emailId,
        content,
        mailboxIds: [this.core.roleMailbox("drafts") ?? "drafts"],
        keywords: DRAFT_KEYWORDS,
        receivedAt: this.core.clock.now(),
      });

      const sessionId = this.core.clock.id("dss");

      this.sql.run(
        "INSERT INTO jmap_draft_sessions (session_id, principal_id, head_email_id, version, updated_at) VALUES (?, ?, ?, 1, ?)",
        sessionId,
        principalId,
        emailId,
        this.core.clock.now(),
      );
      this.core.history.recordFor(principalId, "DraftSession", sessionId, "created");
      this.idMap("draft", draftId, emailId);
    });
  }

  /** Drafts converted: map merge groups to Conversations and grants, then verify (C3). */
  finishBackfill(): MigrationStatus {
    if (this.core.mode() !== "backfilling") return this.status();

    this.core.history.tx(() => {
      // Current merge groups become Conversations over their fixed protocol Threads (A2, C3).
      for (const g of this.sql.all<{ thread_id: string; title: string; originals: string }>(
        `SELECT t.thread_id, COALESCE(t.local_subject, t.subject) AS title,
           (SELECT json_group_array(DISTINCT d.original_thread_id) FROM deliveries d WHERE d.thread_id = t.thread_id) AS originals
         FROM threads t WHERE t.merged_into IS NULL`,
      )) {
        const originals = json<Array<string>>(g.originals, []);

        if (originals.length > 1) {
          const existing = this.sql.one<{ jmap_id: string }>(
            "SELECT jmap_id FROM jmap_id_map WHERE kind = 'conversation' AND legacy_id = ?",
            g.thread_id,
          );

          if (!existing) {
            const id = this.core.clock.id("cnv");
            this.sql.run(
              "INSERT INTO jmap_conversations (conversation_id, title, thread_ids) VALUES (?, ?, ?)",
              id,
              g.title,
              JSON.stringify(originals),
            );
            this.core.history.record("Conversation", id, "created");
            this.idMap("conversation", g.thread_id, id);
          }
        }

        // Notes, clips, boards and collections keep their legacy thread references; this map
        // resolves them to the fixed protocol Thread (or the Conversation above).
        this.idMap("thread", g.thread_id, originals[0] ?? g.thread_id);
      }

      const grants = this.core.meta<ReadonlyArray<{ principalId: string; rights: MailboxRights }>>(
        "grantsInput",
        [],
      );

      // The input is the whole set: a grant it no longer names (left by an earlier attempt) goes.
      const named = new Set(grants.map((g) => g.principalId));

      for (const r of this.sql.all<{ principal_id: string; mailbox_id: string }>(
        "SELECT principal_id, mailbox_id FROM jmap_grants",
      ))
        if (!named.has(r.principal_id)) this.core.applyGrant(r.principal_id, r.mailbox_id, null);

      for (const g of grants) this.core.applyGrant(g.principalId, "*", g.rights);

      this.core.putMeta("stage", "finish");
      this.setMode("verifying");
    });

    return this.verify();
  }

  /**
   * Verification (C3): content references, grants, memberships, drafts and outstanding jobs.
   * Any problem blocks activation; the account stays fenced until repaired or aborted.
   */
  verify(): MigrationStatus {
    if (this.core.mode() !== "verifying") return this.status();
    const problems: Array<string> = [];
    const count = (q: string) => Number(this.sql.one<{ n: number }>(q)?.n ?? 0);
    const deliveries = count("SELECT COUNT(*) AS n FROM deliveries");

    const mapped = count(
      "SELECT COUNT(*) AS n FROM jmap_emails WHERE legacy_delivery_id IS NOT NULL",
    );

    if (mapped !== deliveries)
      problems.push(`${deliveries - mapped} deliveries not mapped to Emails`);

    if (
      count(
        "SELECT COUNT(*) AS n FROM jmap_emails e WHERE NOT EXISTS (SELECT 1 FROM jmap_memberships m WHERE m.email_id = e.email_id)",
      ) > 0
    )
      problems.push("Emails without a Mailbox");

    if (
      count(
        "SELECT COUNT(*) AS n FROM jmap_memberships m WHERE NOT EXISTS (SELECT 1 FROM jmap_mailboxes b WHERE b.mailbox_id = m.mailbox_id)",
      ) > 0
    )
      problems.push("memberships reference missing Mailboxes");

    if (
      count(
        "SELECT COUNT(*) AS n FROM labels l WHERE NOT EXISTS (SELECT 1 FROM jmap_id_map m WHERE m.kind = 'label' AND m.legacy_id = l.label_id)",
      ) > 0
    )
      problems.push("labels not mapped");

    const auditFrom = this.core.meta<number>("auditFrom", 0);

    const audited = (kind: string) =>
      Number(
        this.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jmap_audit WHERE kind = ? AND seq > ?",
          kind,
          auditFrom,
        )?.n ?? 0,
      );

    if (audited("missing-original") > 0)
      problems.push("original message bytes missing for some deliveries");

    if (audited("unsupported") > 0)
      problems.push("unsupported references (drafts that could not be converted)");

    if (count("SELECT COUNT(*) AS n FROM jmap_grants") === 0)
      problems.push("no effective grants mapped");

    if (count("SELECT COUNT(*) AS n FROM send_jobs WHERE state = 'submitting'") > 0)
      problems.push("send attempts in flight");

    if (
      count(`SELECT COUNT(*) AS n FROM drafts d WHERE state = 'open'
        AND NOT EXISTS (SELECT 1 FROM send_jobs j WHERE j.draft_id = d.draft_id AND j.traffic_class = 'transactional')
        AND NOT EXISTS (SELECT 1 FROM jmap_id_map m WHERE m.kind = 'draft' AND m.legacy_id = d.draft_id)`) >
      0
    )
      problems.push("open drafts not converted");

    this.core.putMeta("problems", problems);
    this.core.putMeta("verified", problems.length === 0);

    return this.status();
  }

  /**
   * Activation (C3): atomically switch the account authority and epoch. This is the
   * no-backend-rollback point; buffered work is then replayed through the new services.
   */
  activate(): MigrationStatus {
    const s = this.status();

    if (s.mode !== "verifying" || !s.verified) return s;

    this.sql.tx(() => {
      this.setMode("activating");
      this.core.putMeta("epoch", this.core.epoch() + 1);
      this.setMode("jmap");
      this.core.putMeta("stage", "done");
    });

    return this.status();
  }

  /**
   * Abort before activation: the fenced legacy authority resumes; the host replays buffered work
   * through the legacy services. Partial JMAP state is discarded (the legacy input never changed).
   * Blob rows only the discarded Emails held go too, so they no longer keep legacy originals
   * from blob GC; `released` receives each key the migration wrote (rendered drafts).
   */
  abort(reason: string, released: (r2Key: string) => void = () => undefined): MigrationStatus {
    const mode = this.core.mode();

    if (mode === "jmap" || mode === "legacy") return this.status();

    this.sql.tx(() => {
      for (const table of [
        "jmap_emails",
        "jmap_memberships",
        "jmap_keywords",
        "jmap_message_ids",
        "jmap_threads",
        "jmap_fts",
        "jmap_draft_sessions",
        "jmap_conversations",
        "jmap_id_map",
      ])
        this.sql.run(`DELETE FROM ${table}`);
      this.sql.run("DELETE FROM jmap_blob_pins WHERE owner LIKE 'email:%'");

      // A retried migration grants from its own directory read, never from this attempt's.
      for (const r of this.sql.all<{ principal_id: string; mailbox_id: string }>(
        "SELECT principal_id, mailbox_id FROM jmap_grants",
      ))
        this.core.applyGrant(r.principal_id, r.mailbox_id, null);

      // Only bytes the migration itself wrote (rendered drafts, under `…/jmap/`) need collecting;
      // backfilled originals stay with the legacy deliveries that still name them.
      const unpinned =
        "NOT EXISTS (SELECT 1 FROM jmap_blob_pins p WHERE p.blob_id = jmap_blobs.blob_id)";

      for (const b of this.sql.all<{ r2_key: string }>(
        `SELECT DISTINCT r2_key FROM jmap_blobs WHERE ${unpinned} AND r2_key LIKE 't/%/jmap/%'`,
      ))
        released(b.r2_key);

      this.sql.run(`DELETE FROM jmap_blobs WHERE ${unpinned}`);

      this.core.putMeta("epoch", this.core.epoch() + 1);
      this.core.putMeta("problems", Predicate.isString(reason) ? [reason] : []);
      this.setMode("legacy");
    });

    return this.status();
  }
}
