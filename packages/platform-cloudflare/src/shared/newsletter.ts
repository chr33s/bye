import { Match, Predicate, type Types } from "effect";
import {
  advanceObserved,
  advanceNewsletterRecipientOutcome,
  applyConsent,
  type CancellationReport,
  type ConsentChange,
  type ConsentRecord,
  type IdempotencyProtection,
  type ObservedBroadcastState,
  type OperationOutcome,
  type PublicationState,
  type NewsletterRecipientOutcome,
  retryDecision,
  retryDelayMs,
} from "@bye/domain";
import type { KernelClock } from "../durable/kernel.ts";
import { reject } from "../durable/rpc.ts";
import type { Migration, Sql } from "../durable/sql.ts";

// Newsletter ledger inside a WorldDO (spec.md §5.5). Bye's consent, restriction,
// publication and operation records are authoritative; the provider is driven from them.
//
// - Consent: creator-scoped subscription state with a revision and an append-only history.
//   Restrictions (bounces/complaints) live apart from subscriptions and are never cleared by
//   re-consent or contact sync.
// - Contact sync: a durable outbox of the desired provider state per address. Unsubscribes are
//   committed locally first; additions are held while a publication is open so an approved
//   publication's audience can never silently grow.
// - Publications: one immutable recipient snapshot per post version. Every provider operation
//   (create, send, cancel) has its own persisted identity and is claimed before the provider call.

export const NEWSLETTER_TABLES: Migration = {
  version: 3,
  name: "newsletter",
  statements: [
    "ALTER TABLE subscribers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE subscribers ADD COLUMN changed_at INTEGER",
    "ALTER TABLE subscribers ADD COLUMN consent_evidence TEXT",
    // Non-null when event ordering or scope is unresolved: the address is ineligible until reconciled.
    "ALTER TABLE subscribers ADD COLUMN unresolved TEXT",
    `CREATE TABLE consent_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, change TEXT NOT NULL, source TEXT NOT NULL,
      evidence TEXT, revision INTEGER NOT NULL, applied INTEGER NOT NULL, occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL)`,
    "CREATE INDEX consent_log_address ON consent_log (address, seq)",
    `CREATE TABLE restrictions (
      address TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('hard-bounce', 'complaint', 'provider-unsubscribe', 'manual')),
      scope TEXT NOT NULL CHECK (scope IN ('creator', 'provider', 'platform')), reason TEXT NOT NULL,
      source_event TEXT, recorded_at INTEGER NOT NULL, PRIMARY KEY (address, kind, scope))`,
    // Legacy `suppressed` rows become creator-scoped restrictions; the subscription keeps its own history.
    "INSERT OR IGNORE INTO restrictions (address, kind, scope, reason, recorded_at) SELECT address, COALESCE(suppressed_reason, 'manual'), 'creator', 'legacy suppression', COALESCE(unsubscribed_at, confirmed_at, created_at) FROM subscribers WHERE status = 'suppressed' AND COALESCE(suppressed_reason, 'manual') IN ('hard-bounce', 'complaint', 'manual')",
    "UPDATE subscribers SET status = CASE WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed' WHEN confirmed_at IS NOT NULL THEN 'confirmed' ELSE 'pending' END WHERE status = 'suppressed'",
    "UPDATE subscribers SET changed_at = COALESCE(unsubscribed_at, confirmed_at, created_at), consent_evidence = CASE WHEN status = 'confirmed' THEN 'legacy-double-opt-in' END",
    `CREATE TABLE contact_sync (
      address TEXT PRIMARY KEY, desired INTEGER NOT NULL, revision INTEGER NOT NULL, synced_revision INTEGER,
      state TEXT NOT NULL CHECK (state IN ('pending', 'synced', 'held')), attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, detail TEXT, updated_at INTEGER NOT NULL)`,
    "CREATE INDEX contact_sync_due ON contact_sync (state, next_at)",
    `CREATE TABLE publications (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, revision INTEGER NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL,
      config_version TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, fingerprint TEXT NOT NULL,
      recipients INTEGER NOT NULL, scheduled_at INTEGER, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, provider_ref TEXT, observed TEXT, cancel TEXT, detail TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (post_id, revision))`,
    "CREATE INDEX publications_open ON publications (state, updated_at)",
    `CREATE TABLE publication_recipients (
      publication_id TEXT NOT NULL, address TEXT NOT NULL, in_snapshot INTEGER NOT NULL, outcome TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (publication_id, address))`,
    `CREATE TABLE newsletter_ops (
      op_id TEXT PRIMARY KEY, publication_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('audience', 'create', 'send', 'cancel')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'in-flight', 'accepted', 'rejected', 'unknown', 'held')),
      attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, lease_until INTEGER, next_at INTEGER NOT NULL,
      idempotency_scope TEXT, idempotency_expires_at INTEGER, provider_ref TEXT, detail TEXT, updated_at INTEGER NOT NULL)`,
    "CREATE INDEX newsletter_ops_due ON newsletter_ops (state, next_at)",
    `CREATE TABLE provider_events (
      event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, raw_type TEXT NOT NULL, address TEXT, broadcast_ref TEXT,
      occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applied', 'ignored', 'unmapped')), detail TEXT)`,
  ],
};

/** A newsletter operation's lease: a crashed holder's claim expires and is then treated as Unknown. */
export const OP_LEASE_MS = 5 * 60_000;

export const OP_MAX_ATTEMPTS = 5;

export const SYNC_MAX_ATTEMPTS = 8;

/** Default horizon after which an unsent publication is held instead of sent late. */
export const PUBLICATION_EXPIRY_MS = 24 * 3600_000;

export type OpKind = "audience" | "create" | "send" | "cancel";

export interface NewsletterConfig {
  readonly provider: string;
  readonly account: string;
  readonly configVersion: string;
}

export interface AudienceMapping extends NewsletterConfig {
  readonly audienceId: string;
  /** Provider construct carrying the creator-scoped subscription (e.g. a topic). */
  readonly scopeId?: string;
}

export interface PublicationInput extends NewsletterConfig {
  readonly postId: string;
  readonly revision: number;
  readonly sender: string;
  readonly subject: string;
  readonly fingerprint: string;
  readonly scheduledAt: number | null;
  readonly expiresInMs?: number;
}

export interface PublicationRow {
  readonly id: string;
  readonly postId: string;
  readonly revision: number;
  readonly provider: string;
  readonly account: string;
  readonly configVersion: string;
  readonly sender: string;
  readonly subject: string;
  readonly fingerprint: string;
  readonly recipients: number;
  readonly scheduledAt: number | null;
  readonly expiresAt: number;
  readonly state: PublicationState;
  readonly providerRef: string | null;
  readonly observed: ObservedBroadcastState | null;
  readonly cancel: CancellationReport | null;
  readonly detail: string | null;
}

export interface OpRow {
  readonly opId: string;
  readonly publicationId: string | null;
  readonly kind: OpKind;
  readonly state: "pending" | "in-flight" | "accepted" | "rejected" | "unknown" | "held";
  readonly attempts: number;
  readonly firstAttemptAt: number | null;
  readonly providerRef: string | null;
  readonly detail: string | null;
}

export type OpClaim =
  | { readonly _tag: "Proceed"; readonly op: OpRow }
  /** Another holder's lease is live, or the op is settled/held: do not call the provider. */
  | { readonly _tag: "Skip"; readonly op: OpRow }
  /** A previous attempt's outcome is unknown and not covered: reconcile before any retry. */
  | { readonly _tag: "Reconcile"; readonly op: OpRow };

export interface ProviderEventInput {
  readonly eventId: string;
  readonly kind: string;
  readonly rawType: string;
  readonly address?: string;
  readonly broadcastRef?: string;
  readonly broadcastState?: ObservedBroadcastState;
  readonly occurredAt: number;
  /** Provider-wide (account) or creator-scoped; provider-wide changes become restrictions. */
  readonly scope?: "creator" | "provider";
}

type SubscriberRow = {
  status: string;
  revision: number;
  changed_at: number | null;
  consent_evidence: string | null;
  unresolved: string | null;
};

/** Ledger methods callable over the WorldDO's `newsletter` RPC (engine + webhook only). */
export const NEWSLETTER_METHODS = [
  "audience",
  "mapAudience",
  "claimOp",
  "settleOp",
  "reconcileOp",
  "resolveHeldOp",
  "resumeHeld",
  "heldOps",
  "operation",
  "dueSync",
  "settleSync",
  "syncState",
  "freshness",
  "approve",
  "publication",
  "openPublication",
  "publications",
  "setPublication",
  "requestCancel",
  "status",
  "snapshotEligible",
  "audienceDrift",
  "observe",
  "applyEvent",
  "health",
] as const;

export type NewsletterMethod = (typeof NEWSLETTER_METHODS)[number];

const TERMINAL: ReadonlyArray<PublicationState> = ["sent", "cancelled", "failed"];

/** A `publications` table row as SQLite returns it. */
interface PublicationRecord {
  id: string;
  post_id: string;
  revision: number;
  provider: string;
  account: string;
  config_version: string;
  sender: string;
  subject: string;
  fingerprint: string;
  recipients: number;
  scheduled_at: number | null;
  expires_at: number;
  state: string;
  provider_ref: string | null;
  observed: string | null;
  cancel: string | null;
  detail: string | null;
}

/** A `newsletter_ops` table row as SQLite returns it. */
interface OpRecord {
  op_id: string;
  publication_id: string | null;
  kind: string;
  state: string;
  attempts: number;
  first_attempt_at: number | null;
  provider_ref: string | null;
  detail: string | null;
}

export interface PublicationPatch {
  readonly state?: PublicationState;
  readonly providerRef?: string;
  readonly detail?: string | null;
  readonly cancel?: CancellationReport;
}

export interface SnapshotEligibility {
  readonly snapshot: number;
  readonly eligible: number;
  readonly removed: ReadonlyArray<string>;
}

export interface PublicationStatusView {
  readonly publication: PublicationRow;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly drift: number;
  readonly ops: ReadonlyArray<OpRow>;
}

export class NewsletterLedger {
  constructor(
    private readonly sql: Sql,
    private readonly clock: KernelClock,
    private readonly meta: (key: string) => string | undefined,
    private readonly setMeta: (key: string, value: string) => void,
  ) {}

  // ---- consent ----

  consent(address: string): ConsentRecord | null {
    const s = this.sql.one<SubscriberRow>(
      "SELECT status, revision, changed_at, consent_evidence, unresolved FROM subscribers WHERE address = ?",
      address,
    );

    if (!s) return null;

    return {
      status: Match.value(s.status).pipe(
        Match.when("confirmed", () => "confirmed" as const),
        Match.when("unsubscribed", () => "unsubscribed" as const),
        Match.orElse(() => "pending" as const),
      ),
      revision: Number(s.revision),
      changedAt: Number(s.changed_at ?? 0),
      consentEvidence: s.consent_evidence,
    };
  }

  /**
   * Apply one consent change through the shared rules and log it (applied or not). Must run inside
   * the caller's transaction. Returns whether the subscription changed.
   */
  recordConsent(
    address: string,
    change: ConsentChange,
    source: string,
    evidence: string | null,
  ): boolean {
    const now = this.clock.now();
    const current = this.consent(address);
    const result = applyConsent(current, change);
    const applied = Predicate.isTagged(result, "Applied");

    if (Predicate.isTagged(result, "Applied")) {
      const r = result.record;
      this.sql.run(
        `UPDATE subscribers SET status = ?, revision = ?, changed_at = ?, consent_evidence = ?,
           confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
           unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN ? ELSE unsubscribed_at END,
           confirm_hash = CASE WHEN ? = 'unsubscribed' OR ? = 'confirmed' THEN NULL ELSE confirm_hash END
         WHERE address = ?`,
        r.status,
        r.revision,
        r.changedAt,
        r.consentEvidence,
        r.status,
        now,
        r.status,
        now,
        r.status,
        r.status,
        address,
      );
      this.enqueueSync(address);
    }

    this.sql.run(
      "INSERT INTO consent_log (address, change, source, evidence, revision, applied, occurred_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      address,
      change._tag,
      source,
      evidence,
      applied ? result.record.revision : (current?.revision ?? 0),
      applied,
      change.at,
      now,
    );

    return applied;
  }

  consentHistory(
    address: string,
  ): ReadonlyArray<{ change: string; source: string; applied: boolean }> {
    return this.sql
      .all<{ change: string; source: string; applied: number }>(
        "SELECT change, source, applied FROM consent_log WHERE address = ? ORDER BY seq",
        address,
      )
      .map((r) => ({ change: r.change, source: r.source, applied: Number(r.applied) === 1 }));
  }

  /** Bounce/complaint restriction. Provider restrictions are a minimum; never broadened or cleared here. */
  restrict(
    address: string,
    kind: "hard-bounce" | "complaint" | "provider-unsubscribe" | "manual",
    scope: "creator" | "provider" | "platform",
    reason: string,
    sourceEvent?: string,
  ): void {
    const inserted = this.sql.run(
      "INSERT OR IGNORE INTO restrictions (address, kind, scope, reason, source_event, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      address,
      kind,
      scope,
      reason,
      sourceEvent,
      this.clock.now(),
    );

    if (inserted) this.enqueueSync(address);
  }

  restrictions(address: string): ReadonlyArray<{ kind: string; scope: string; reason: string }> {
    return this.sql.all(
      "SELECT kind, scope, reason FROM restrictions WHERE address = ? ORDER BY kind, scope",
      address,
    );
  }

  /** Mark ordering/scope as unresolved (blocks eligibility) or resolved again. */
  setUnresolved(address: string, reason: string | null): void {
    this.sql.run("UPDATE subscribers SET unresolved = ? WHERE address = ?", reason, address);
    this.enqueueSync(address);
  }

  eligible(address: string): boolean {
    return (
      this.sql.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM subscribers s WHERE s.address = ? AND s.status = 'confirmed' AND s.unresolved IS NULL
           AND NOT EXISTS (SELECT 1 FROM restrictions r WHERE r.address = s.address)`,
        address,
      )?.n === 1
    );
  }

  /** The eligible audience as SQL (one definition for counting and set-based snapshot inserts). */
  private static readonly ELIGIBLE_SQL = `FROM subscribers s WHERE s.status = 'confirmed' AND s.unresolved IS NULL
           AND NOT EXISTS (SELECT 1 FROM restrictions r WHERE r.address = s.address)`;

  // ---- contact sync outbox (Bye → provider) ----

  /** Queue the address's current desired provider state. Idempotent; a newer revision supersedes. */
  enqueueSync(address: string): void {
    const now = this.clock.now();
    const desired = this.eligible(address);

    const row = this.sql.one<{ desired: number; revision: number; synced_revision: number | null }>(
      "SELECT desired, revision, synced_revision FROM contact_sync WHERE address = ?",
      address,
    );

    // Never synced and not eligible: the provider has nothing to exclude.
    if (!row && !desired) return;

    if (row && Boolean(row.desired) === desired && row.synced_revision === row.revision) return;
    this.sql.run(
      `INSERT INTO contact_sync (address, desired, revision, state, attempts, next_at, updated_at) VALUES (?, ?, 1, 'pending', 0, ?, ?)
       ON CONFLICT (address) DO UPDATE SET desired = excluded.desired, revision = contact_sync.revision + 1,
         state = 'pending', attempts = 0, next_at = excluded.next_at, detail = NULL, updated_at = excluded.updated_at`,
      address,
      desired,
      now,
      now,
    );
  }

  /**
   * Due sync work. Removals always go first and are never held back. While a publication is open,
   * only additions inside its approved snapshot proceed: the provider audience must not grow past
   * what was approved.
   */
  dueSync(
    limit: number,
  ): ReadonlyArray<{ address: string; subscribed: boolean; revision: number }> {
    const now = this.clock.now();
    const open = this.openPublication();

    return this.sql
      .all<{ address: string; desired: number; revision: number }>(
        `SELECT c.address, c.desired, c.revision FROM contact_sync c WHERE c.state = 'pending' AND c.next_at <= ?
           ${open ? "AND (c.desired = 0 OR EXISTS (SELECT 1 FROM publication_recipients p WHERE p.publication_id = ? AND p.address = c.address AND p.in_snapshot = 1))" : ""}
         ORDER BY c.desired, c.next_at LIMIT ?`,
        now,
        ...(open ? [open.id] : []),
        limit,
      )
      .map((r) => ({
        address: r.address,
        subscribed: Boolean(r.desired),
        revision: Number(r.revision),
      }));
  }

  /**
   * Freshness for one publication: every removal, and every addition inside its snapshot, has
   * reached the provider. Additions outside the snapshot are irrelevant (and held back).
   */
  freshness(publicationId: string) {
    const r = this.sql.one<{ pending: number; held: number }>(
      `SELECT SUM(c.state = 'pending') AS pending, SUM(c.state = 'held') AS held FROM contact_sync c
       WHERE c.state IN ('pending', 'held') AND (c.desired = 0 OR EXISTS (
         SELECT 1 FROM publication_recipients p WHERE p.publication_id = ? AND p.address = c.address AND p.in_snapshot = 1))`,
      publicationId,
    );

    return { pending: Number(r?.pending ?? 0), held: Number(r?.held ?? 0) };
  }

  /** Record a sync attempt. A stale revision's result never marks a newer change synced. */
  settleSync(address: string, revision: number, outcome: OperationOutcome, retryAfterMs = 0): void {
    this.sql.tx(() => {
      const row = this.sql.one<{ revision: number; attempts: number }>(
        "SELECT revision, attempts FROM contact_sync WHERE address = ?",
        address,
      );

      if (!row || Number(row.revision) !== revision) return;
      const now = this.clock.now();

      if (Predicate.isTagged(outcome, "Accepted")) {
        this.sql.run(
          "UPDATE contact_sync SET state = 'synced', synced_revision = revision, detail = NULL, updated_at = ? WHERE address = ?",
          now,
          address,
        );

        return;
      }

      // Contact upserts are state-setting (not additive), so re-applying the same desired state is safe.
      const attempts = Number(row.attempts) + 1;
      const permanent = Predicate.isTagged(outcome, "NotAccepted") && !outcome.retryable;
      this.sql.run(
        "UPDATE contact_sync SET state = ?, attempts = ?, next_at = ?, detail = ?, updated_at = ? WHERE address = ?",
        permanent || attempts >= SYNC_MAX_ATTEMPTS ? "held" : "pending",
        attempts,
        now + retryDelayMs(attempts, retryAfterMs),
        outcome.detail.slice(0, 300),
        now,
        address,
      );
    });
  }

  /** Freshness: nothing waiting (or held) to reach the provider. */
  syncState() {
    const r = this.sql.one<{ pending: number; held: number; oldest: number | null }>(
      "SELECT SUM(state = 'pending') AS pending, SUM(state = 'held') AS held, MIN(CASE WHEN state = 'pending' THEN updated_at END) AS oldest FROM contact_sync",
    );

    return {
      pending: Number(r?.pending ?? 0),
      held: Number(r?.held ?? 0),
      oldestPendingAt: r?.oldest === null || r?.oldest === undefined ? null : Number(r.oldest),
    };
  }

  // ---- audience mapping ----

  audience(): AudienceMapping | undefined {
    const raw = this.meta("newsletter_audience");

    return raw ? (JSON.parse(raw) as AudienceMapping) : undefined;
  }

  /** Bind this creator to a provider audience. A different existing mapping is never overwritten. */
  mapAudience(mapping: AudienceMapping): void {
    const existing = this.audience();

    if (
      existing &&
      (existing.provider !== mapping.provider ||
        existing.account !== mapping.account ||
        existing.audienceId !== mapping.audienceId)
    )
      reject(
        "conflict",
        "creator is mapped to another audience; reconcile before replacing the provider",
      );
    this.setMeta("newsletter_audience", JSON.stringify(mapping));
  }

  // ---- publications ----

  private row(r: PublicationRecord | undefined): PublicationRow | undefined {
    if (!r) return undefined;

    return {
      id: String(r.id),
      postId: String(r.post_id),
      revision: Number(r.revision),
      provider: String(r.provider),
      account: String(r.account),
      configVersion: String(r.config_version),
      sender: String(r.sender),
      subject: String(r.subject),
      fingerprint: String(r.fingerprint),
      recipients: Number(r.recipients),
      scheduledAt: r.scheduled_at === null ? null : Number(r.scheduled_at),
      expiresAt: Number(r.expires_at),
      state: r.state as PublicationState,
      providerRef: (r.provider_ref as string | null) ?? null,
      observed: (r.observed as ObservedBroadcastState | null) ?? null,
      cancel: Predicate.isString(r.cancel) ? (JSON.parse(r.cancel) as CancellationReport) : null,
      detail: (r.detail as string | null) ?? null,
    };
  }

  publication(id: string): PublicationRow | undefined {
    return this.row(this.sql.one("SELECT * FROM publications WHERE id = ?", id));
  }

  publicationFor(postId: string, revision: number): PublicationRow | undefined {
    return this.row(
      this.sql.one(
        "SELECT * FROM publications WHERE post_id = ? AND revision = ?",
        postId,
        revision,
      ),
    );
  }

  openPublication(): PublicationRow | undefined {
    return this.row(
      this.sql.one(
        `SELECT * FROM publications WHERE state NOT IN (${TERMINAL.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`,
        ...TERMINAL,
      ),
    );
  }

  publications(): ReadonlyArray<PublicationRow> {
    return this.sql
      .all<PublicationRecord>("SELECT * FROM publications ORDER BY created_at DESC LIMIT 100")
      .map((r) => this.row(r)!);
  }

  /**
   * Approve one publication per post version with an immutable recipient snapshot of the currently
   * eligible audience. Replays return the existing publication; nothing is re-snapshotted.
   */
  approve(input: PublicationInput): PublicationRow {
    return this.sql.tx(() => {
      const existing = this.publicationFor(input.postId, input.revision);

      if (existing) return existing;
      const now = this.clock.now();
      const id = `pub_${input.postId}_r${input.revision}`;

      const recipients = Number(
        this.sql.one<{ n: number }>(`SELECT COUNT(*) AS n ${NewsletterLedger.ELIGIBLE_SQL}`)?.n ??
          0,
      );

      this.sql.run(
        `INSERT INTO publications (id, post_id, revision, provider, account, config_version, sender, subject, fingerprint,
           recipients, scheduled_at, expires_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
        id,
        input.postId,
        input.revision,
        input.provider,
        input.account,
        input.configVersion,
        input.sender,
        input.subject,
        input.fingerprint,
        recipients,
        input.scheduledAt,
        (input.scheduledAt ?? now) + (input.expiresInMs ?? PUBLICATION_EXPIRY_MS),
        now,
        now,
      );
      // One set-based statement, however large the audience (no per-recipient round trip).
      this.sql.run(
        `INSERT INTO publication_recipients (publication_id, address, in_snapshot, updated_at)
         SELECT ?, s.address, 1, ? ${NewsletterLedger.ELIGIBLE_SQL}`,
        id,
        now,
      );

      return this.publication(id)!;
    });
  }

  setPublication(id: string, patch: PublicationPatch): PublicationRow {
    return this.sql.tx(() => {
      const p = this.publication(id) ?? reject("not_found", "publication");
      // Terminal publications never move again (a late success cannot resurrect a cancel, etc.).
      const state = patch.state && !TERMINAL.includes(p.state) ? patch.state : p.state;
      this.sql.run(
        "UPDATE publications SET state = ?, provider_ref = COALESCE(?, provider_ref), detail = ?, cancel = COALESCE(?, cancel), updated_at = ? WHERE id = ?",
        state,
        patch.providerRef,
        patch.detail === undefined ? p.detail : patch.detail,
        patch.cancel ? JSON.stringify(patch.cancel) : undefined,
        this.clock.now(),
        id,
      );

      return this.publication(id)!;
    });
  }

  /** Recipients of the approved snapshot who are STILL eligible (later removals only narrow it). */
  snapshotEligible(id: string): SnapshotEligibility {
    const snapshot = Number(
      this.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM publication_recipients WHERE publication_id = ? AND in_snapshot = 1",
        id,
      )?.n ?? 0,
    );

    const removed = this.sql
      .all<{ address: string }>(
        `SELECT p.address FROM publication_recipients p WHERE p.publication_id = ? AND p.in_snapshot = 1
           AND NOT EXISTS (SELECT 1 ${NewsletterLedger.ELIGIBLE_SQL} AND s.address = p.address)
         ORDER BY p.address`,
        id,
      )
      .map((r) => r.address);

    return { snapshot, eligible: snapshot - removed.length, removed };
  }

  /** Addresses the provider audience would include beyond the approved snapshot. */
  audienceDrift(id: string): ReadonlyArray<string> {
    return this.sql
      .all<{ address: string }>(
        `SELECT c.address FROM contact_sync c WHERE c.synced_revision IS NOT NULL AND c.desired = 1 AND c.synced_revision = c.revision
           AND NOT EXISTS (SELECT 1 FROM publication_recipients p WHERE p.publication_id = ? AND p.address = c.address AND p.in_snapshot = 1)`,
        id,
      )
      .map((r) => r.address);
  }

  requestCancel(id: string): PublicationRow {
    return this.sql.tx(() => {
      const p = this.publication(id) ?? reject("not_found", "publication");

      if (TERMINAL.includes(p.state)) return p;

      // Nothing reached the provider's send path yet: a local cancel is complete.
      if (
        p.state === "approved" ||
        p.state === "draft-pending" ||
        p.state === "drafted" ||
        p.state === "held"
      ) {
        const localOnly = p.state !== "draft-pending";

        return this.setPublication(id, {
          state: "cancelled",
          cancel: localOnly
            ? { _tag: "Confirmed", coverage: "complete" }
            : { _tag: "Uncertain", detail: "draft creation outcome unknown; draft never sent" },
        });
      }

      return this.setPublication(id, { cancel: { _tag: "Requested" } });
    });
  }

  // ---- operations ----

  private op(opId: string): OpRow | undefined {
    const r = this.sql.one<OpRecord>("SELECT * FROM newsletter_ops WHERE op_id = ?", opId);

    return r
      ? {
          opId: String(r.op_id),
          publicationId: (r.publication_id as string | null) ?? null,
          kind: r.kind as OpKind,
          state: r.state as OpRow["state"],
          attempts: Number(r.attempts),
          firstAttemptAt: r.first_attempt_at === null ? null : Number(r.first_attempt_at),
          providerRef: (r.provider_ref as string | null) ?? null,
          detail: (r.detail as string | null) ?? null,
        }
      : undefined;
  }

  operation(opId: string): OpRow | undefined {
    return this.op(opId);
  }

  /**
   * Persist and lease an operation BEFORE the provider call. Serialized per operation: a live
   * lease, a settled op, or a held op is never re-attempted. An expired in-flight lease means the
   * last attempt's outcome is unknown.
   */
  claimOp(
    opId: string,
    kind: OpKind,
    publicationId: string | null,
    idempotency: IdempotencyProtection | null,
  ): OpClaim {
    return this.sql.tx(() => {
      const now = this.clock.now();
      this.sql.run(
        "INSERT OR IGNORE INTO newsletter_ops (op_id, publication_id, kind, state, next_at, idempotency_scope, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        opId,
        publicationId,
        kind,
        now,
        idempotency?.scope,
        now,
      );

      const row = this.sql.one<{ state: string; lease_until: number | null; next_at: number }>(
        "SELECT state, lease_until, next_at FROM newsletter_ops WHERE op_id = ?",
        opId,
      )!;

      let state = row.state;

      if (state === "in-flight" && Number(row.lease_until ?? 0) > now)
        return { _tag: "Skip", op: this.op(opId)! };

      if (state === "in-flight") {
        // The previous holder died mid-call: its outcome is unknown, never "not accepted".
        this.sql.run(
          "UPDATE newsletter_ops SET state = 'unknown', lease_until = NULL, detail = 'lease expired mid-call', updated_at = ? WHERE op_id = ?",
          now,
          opId,
        );
        state = "unknown";
      }

      if (state === "accepted" || state === "rejected" || state === "held")
        return { _tag: "Skip", op: this.op(opId)! };

      if (state === "unknown") {
        const op = this.op(opId)!;

        const decision = retryDecision({
          outcome: { _tag: "Unknown", detail: op.detail ?? "" },
          idempotency,
          firstAttemptAt: op.firstAttemptAt ?? now,
          now,
          attempts: op.attempts,
          maxAttempts: OP_MAX_ATTEMPTS,
        });

        if (Predicate.isTagged(decision, "Hold")) return { _tag: "Reconcile", op };
      }

      if (Number(row.next_at) > now) return { _tag: "Skip", op: this.op(opId)! };
      this.sql.run(
        `UPDATE newsletter_ops SET state = 'in-flight', attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?),
           idempotency_expires_at = COALESCE(idempotency_expires_at, ?), lease_until = ?, updated_at = ? WHERE op_id = ?`,
        now,
        idempotency ? now + idempotency.windowMs : undefined,
        now + OP_LEASE_MS,
        now,
        opId,
      );

      return { _tag: "Proceed", op: this.op(opId)! };
    });
  }

  /** Settle an attempt. Unknown outcomes stay visible for reconciliation; nothing is replayed blindly. */
  settleOp(
    opId: string,
    outcome: OperationOutcome,
    idempotency: IdempotencyProtection | null,
    retryAfterMs = 0,
  ): OpRow {
    return this.sql.tx(() => {
      const op = this.op(opId) ?? reject("not_found", "operation");

      if (op.state === "accepted" || op.state === "rejected") return op;
      const now = this.clock.now();

      if (Predicate.isTagged(outcome, "Accepted")) {
        this.sql.run(
          "UPDATE newsletter_ops SET state = 'accepted', provider_ref = ?, lease_until = NULL, detail = NULL, updated_at = ? WHERE op_id = ?",
          outcome.providerRef,
          now,
          opId,
        );

        return this.op(opId)!;
      }

      const decision = retryDecision({
        outcome,
        idempotency,
        firstAttemptAt: op.firstAttemptAt ?? now,
        now,
        attempts: op.attempts,
        maxAttempts: OP_MAX_ATTEMPTS,
      });

      const state = Predicate.isTagged(outcome, "NotAccepted")
        ? Predicate.isTagged(decision, "Retry")
          ? "pending"
          : outcome.retryable
            ? "held"
            : "rejected"
        : Predicate.isTagged(decision, "Retry")
          ? "unknown"
          : "unknown";

      this.sql.run(
        "UPDATE newsletter_ops SET state = ?, lease_until = NULL, next_at = ?, detail = ?, updated_at = ? WHERE op_id = ?",
        state,
        now + retryDelayMs(op.attempts, retryAfterMs),
        outcome.detail.slice(0, 300),
        now,
        opId,
      );

      return this.op(opId)!;
    });
  }

  /** Reconciliation evidence for an Unknown op: accepted, proven absent (retry allowed), or hold. */
  reconcileOp(
    opId: string,
    evidence: "accepted" | "absent" | "inconclusive",
    providerRef?: string,
  ): OpRow {
    return this.sql.tx(() => {
      const op = this.op(opId) ?? reject("not_found", "operation");

      if (op.state !== "unknown") return op;
      const now = this.clock.now();

      if (evidence === "accepted")
        this.sql.run(
          "UPDATE newsletter_ops SET state = 'accepted', provider_ref = ?, detail = 'reconciled', updated_at = ? WHERE op_id = ?",
          providerRef,
          now,
          opId,
        );
      else if (evidence === "absent")
        this.sql.run(
          "UPDATE newsletter_ops SET state = 'pending', detail = 'reconciled absent', next_at = ?, updated_at = ? WHERE op_id = ?",
          now,
          now,
          opId,
        );
      else
        this.sql.run(
          "UPDATE newsletter_ops SET state = 'held', detail = 'awaiting operator review', updated_at = ? WHERE op_id = ?",
          now,
          opId,
        );

      return this.op(opId)!;
    });
  }

  /** Operator resolution of a held op, with the evidence they relied on recorded in `detail`. */
  resolveHeldOp(
    opId: string,
    resolution: "accepted" | "not-accepted",
    note: string,
    providerRef?: string,
  ): OpRow {
    return this.sql.tx(() => {
      const op = this.op(opId) ?? reject("not_found", "operation");

      if (op.state !== "held" && op.state !== "unknown")
        reject("conflict", "operation is not held");
      this.sql.run(
        "UPDATE newsletter_ops SET state = ?, provider_ref = COALESCE(?, provider_ref), detail = ?, next_at = ?, updated_at = ? WHERE op_id = ?",
        resolution === "accepted" ? "accepted" : "pending",
        providerRef,
        `operator: ${note}`.slice(0, 300),
        this.clock.now(),
        this.clock.now(),
        opId,
      );

      return this.op(opId)!;
    });
  }

  /**
   * Operator resume of a held publication after its operations were resolved: the state is derived
   * from the recorded create/send outcomes, so a resume can never skip a step or repeat one.
   */
  resumeHeld(publicationId: string): PublicationRow {
    return this.sql.tx(() => {
      const p = this.publication(publicationId) ?? reject("not_found", "publication");

      if (p.state !== "held") reject("conflict", "publication is not held");
      const create = this.op(`${publicationId}:create`);
      const send = this.op(`${publicationId}:send`);

      const unresolved = [create, send].find(
        (o) => o && (o.state === "held" || o.state === "unknown" || o.state === "in-flight"),
      );

      if (unresolved) reject("conflict", `operation ${unresolved.opId} is ${unresolved.state}`);

      const state: PublicationState =
        send?.state === "accepted"
          ? "submitted"
          : create?.state === "accepted"
            ? "drafted"
            : "approved";

      const patch: Types.Mutable<PublicationPatch> = {
        state,
        detail: "resumed by operator",
      };

      if (create?.providerRef) patch.providerRef = create.providerRef;

      return this.setPublication(publicationId, patch);
    });
  }

  heldOps(): ReadonlyArray<OpRow> {
    return this.sql
      .all<{ op_id: string }>(
        "SELECT op_id FROM newsletter_ops WHERE state IN ('held', 'unknown') ORDER BY updated_at",
      )
      .map((r) => this.op(r.op_id)!);
  }

  // ---- provider events ----

  /**
   * Persist then apply one authenticated provider event. Replays are no-ops; events that cannot be
   * mapped to this creator are retained as `unmapped`, never applied elsewhere.
   */
  applyEvent(e: ProviderEventInput): "applied" | "ignored" | "unmapped" | "duplicate" {
    return this.sql.tx(() => {
      const now = this.clock.now();

      const fresh = this.sql.run(
        "INSERT OR IGNORE INTO provider_events (event_id, kind, raw_type, address, broadcast_ref, occurred_at, received_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'unmapped')",
        e.eventId,
        e.kind,
        e.rawType,
        e.address,
        e.broadcastRef,
        e.occurredAt,
        now,
      );

      if (!fresh) return "duplicate";
      const state = this.applyMapped(e);
      this.sql.run("UPDATE provider_events SET state = ? WHERE event_id = ?", state, e.eventId);

      return state;
    });
  }

  private applyMapped(e: ProviderEventInput): "applied" | "ignored" | "unmapped" {
    const address = e.address?.toLowerCase();

    const publication = e.broadcastRef
      ? this.row(this.sql.one("SELECT * FROM publications WHERE provider_ref = ?", e.broadcastRef))
      : undefined;

    if (
      e.broadcastRef &&
      !publication &&
      e.kind !== "contact-unsubscribed" &&
      e.kind !== "contact-subscribed"
    )
      return "unmapped";

    switch (e.kind) {
      case "contact-unsubscribed": {
        if (!address || !this.consent(address)) return "unmapped";

        // An account-wide provider unsubscribe is a restriction on every creator (never narrowed to
        // one list); a creator-scoped one is this creator's unsubscribe.
        if (e.scope === "provider") {
          this.restrict(
            address,
            "provider-unsubscribe",
            "provider",
            `provider ${e.rawType}`,
            e.eventId,
          );

          return "applied";
        }

        return this.recordConsent(
          address,
          { _tag: "Unsubscribe", source: "provider", at: e.occurredAt },
          "provider",
          e.eventId,
        )
          ? "applied"
          : "ignored";
      }

      case "contact-subscribed": {
        if (!address || !this.consent(address)) return "unmapped";
        // A provider-side (re)subscribe is not consent and clears no restriction: logged only.
        this.recordConsent(
          address,
          { _tag: "ProviderSubscribed", at: e.occurredAt },
          "provider",
          e.eventId,
        );

        return "ignored";
      }

      case "hard-bounce":
      case "complaint": {
        if (!address) return "unmapped";
        this.restrict(address, e.kind, e.scope ?? "creator", `provider ${e.rawType}`, e.eventId);

        if (publication) this.recipientOutcome(publication.id, address, e.kind);

        return "applied";
      }

      case "soft-bounce":
      case "delivered": {
        if (!address || !publication) return "unmapped";
        this.recipientOutcome(publication.id, address, e.kind);

        return "applied";
      }

      case "broadcast-state": {
        if (!publication || !e.broadcastState) return "unmapped";
        this.observe(publication.id, e.broadcastState);

        return "applied";
      }

      default:
        return "unmapped";
    }
  }

  private recipientOutcome(
    publicationId: string,
    address: string,
    outcome: NewsletterRecipientOutcome,
  ): void {
    const r = this.sql.one<{ outcome: NewsletterRecipientOutcome | null }>(
      "SELECT outcome FROM publication_recipients WHERE publication_id = ? AND address = ?",
      publicationId,
      address,
    );

    const next = advanceNewsletterRecipientOutcome(r?.outcome ?? null, outcome);
    // A recipient outside the approved snapshot is recorded as drift, never silently accepted.
    this.sql.run(
      `INSERT INTO publication_recipients (publication_id, address, in_snapshot, outcome, updated_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (publication_id, address) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at`,
      publicationId,
      address,
      next,
      this.clock.now(),
    );
  }

  /** Apply a provider-observed broadcast state without regressing a newer observation. */
  observe(publicationId: string, observed: ObservedBroadcastState): PublicationRow {
    return this.sql.tx(() => {
      const p = this.publication(publicationId) ?? reject("not_found", "publication");
      const next = advanceObserved(p.observed, observed);
      this.sql.run(
        "UPDATE publications SET observed = ?, updated_at = ? WHERE id = ?",
        next,
        this.clock.now(),
        publicationId,
      );

      if (next === "sent") return this.setPublication(publicationId, { state: "sent" });

      if (next === "cancelled") {
        const partial = p.observed === "sending";

        return this.setPublication(publicationId, {
          state: "cancelled",
          cancel: { _tag: "Confirmed", coverage: partial ? "partial" : "complete" },
        });
      }

      return this.publication(publicationId)!;
    });
  }

  /** Delivery/eligibility view for the author and operators. */
  status(publicationId: string): PublicationStatusView {
    const publication = this.publication(publicationId) ?? reject("not_found", "publication");

    const outcomes = Object.fromEntries(
      this.sql
        .all<{ outcome: string | null; n: number }>(
          "SELECT outcome, COUNT(*) AS n FROM publication_recipients WHERE publication_id = ? AND in_snapshot = 1 GROUP BY outcome",
          publicationId,
        )
        .map((r) => [r.outcome ?? "no-event", Number(r.n)]),
    );

    const drift = Number(
      this.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM publication_recipients WHERE publication_id = ? AND in_snapshot = 0",
        publicationId,
      )?.n ?? 0,
    );

    const ops = this.sql
      .all<{ op_id: string }>(
        "SELECT op_id FROM newsletter_ops WHERE publication_id = ? ORDER BY updated_at",
        publicationId,
      )
      .map((r) => this.op(r.op_id)!);

    return { publication, outcomes, drift, ops };
  }

  /** Counters for monitoring (unknown sends, oldest queued work, sync lag, cancellation uncertainty). */
  health() {
    const ops = this.sql.one<{ unknown: number; held: number }>(
      "SELECT SUM(state = 'unknown') AS unknown, SUM(state = 'held') AS held FROM newsletter_ops",
    );

    const sync = this.syncState();

    const cancels = this.sql.all<{ cancel: string }>(
      "SELECT cancel FROM publications WHERE cancel IS NOT NULL",
    );

    return {
      unknownOps: Number(ops?.unknown ?? 0),
      heldOps: Number(ops?.held ?? 0),
      syncPending: sync.pending,
      syncHeld: sync.held,
      oldestSyncPendingAt: sync.oldestPendingAt,
      openPublication: this.openPublication()?.id ?? null,
      uncertainCancels: cancels.filter((c) =>
        Predicate.isTagged(JSON.parse(c.cancel) as CancellationReport, "Uncertain"),
      ).length,
      unmappedEvents: Number(
        this.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM provider_events WHERE state = 'unmapped'",
        )?.n ?? 0,
      ),
    };
  }
}
