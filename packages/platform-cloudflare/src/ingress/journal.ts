import type { IngestMessage } from "@bye/contracts";
import { Kernel, KERNEL_MIGRATIONS, type KernelClock } from "../durable/kernel.ts";
import { type Migration, migrate, Sql, type TransactionalStorage } from "../durable/sql.ts";

// IngressJournalDO authority (§5.1 steps 2–4, §6). Receipt intent is recorded before expensive
// processing; the application guarantee starts once the original bytes are blob-ready. The
// reconciler republishes receipts that never reached a mailbox commit.

export type ReceiptState =
  | "registered"
  | "blob-ready"
  | "enqueued"
  | "committed"
  | "rejected"
  | "abandoned"
  /**
   * The replay budget is exhausted and committing the quarantine placeholder failed (transiently).
   * Never pruned and never `rejected`: the durable original stays reachable, and the reconciler
   * retries the quarantine at `QUARANTINE_RETRY_MS` instead of every sweep.
   */
  | "quarantine-failed";

/** Republish budget per receipt (by `publish_attempts`); past it the receipt is quarantined. */
export const REPLAY_ATTEMPT_CAP = 20;
/** Back-off between quarantine attempts for `quarantine-failed` receipts. */
export const QUARANTINE_RETRY_MS = 6 * 60 * 60_000;

export const INGRESS_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "ingress",
    statements: [
      `CREATE TABLE receipts (
        ingestion_id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        envelope_from TEXT NOT NULL,
        object_key TEXT NOT NULL,
        raw_size INTEGER NOT NULL,
        state TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        publish_attempts INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX receipts_state ON receipts (state, updated_at)",
    ],
  },
];

export interface ReceiptIntent {
  readonly ingestionId: string;
  readonly mailboxId: string;
  readonly recipient: string;
  readonly envelopeFrom: string;
  readonly objectKey: string;
  readonly rawSize: number;
}

export interface ReceiptRow extends ReceiptIntent {
  readonly state: ReceiptState;
  readonly receivedAt: number;
  readonly updatedAt: number;
  readonly publishAttempts: number;
}

const ORDER: Readonly<Record<ReceiptState, number>> = {
  registered: 0,
  "blob-ready": 1,
  enqueued: 2,
  "quarantine-failed": 2,
  committed: 3,
  rejected: 3,
  abandoned: 3,
};

export class IngressJournal {
  readonly sql: Sql;
  readonly kernel: Kernel;

  constructor(
    storage: TransactionalStorage,
    readonly clock: KernelClock,
  ) {
    this.sql = new Sql(storage);
    migrate(this.sql, "kernel", KERNEL_MIGRATIONS);
    migrate(this.sql, "ingress", INGRESS_MIGRATIONS);
    this.kernel = new Kernel(this.sql, clock);
  }

  /** Idempotent: re-registering an ingestion ID returns the existing row unchanged. */
  register(intent: ReceiptIntent): ReceiptRow {
    return this.sql.tx(() => {
      const now = this.clock.now();
      this.sql.run(
        "INSERT OR IGNORE INTO receipts (ingestion_id, mailbox_id, recipient, envelope_from, object_key, raw_size, state, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?)",
        intent.ingestionId,
        intent.mailboxId,
        intent.recipient,
        intent.envelopeFrom,
        intent.objectKey,
        intent.rawSize,
        now,
        now,
      );
      return this.get(intent.ingestionId)!;
    });
  }

  get(ingestionId: string): ReceiptRow | undefined {
    const r = this.sql.one<{
      ingestion_id: string;
      mailbox_id: string;
      recipient: string;
      envelope_from: string;
      object_key: string;
      raw_size: number;
      state: ReceiptState;
      received_at: number;
      updated_at: number;
      publish_attempts: number;
    }>("SELECT * FROM receipts WHERE ingestion_id = ?", ingestionId);
    return r
      ? {
          ingestionId: r.ingestion_id,
          mailboxId: r.mailbox_id,
          recipient: r.recipient,
          envelopeFrom: r.envelope_from,
          objectKey: r.object_key,
          rawSize: Number(r.raw_size),
          state: r.state,
          receivedAt: Number(r.received_at),
          updatedAt: Number(r.updated_at),
          publishAttempts: Number(r.publish_attempts),
        }
      : undefined;
  }

  /** Forward-only transitions; a late or repeated transition never moves a receipt backwards. */
  private advance(ingestionId: string, to: ReceiptState): boolean {
    return this.sql.tx(() => {
      const r = this.get(ingestionId);
      if (!r) return false;
      if (ORDER[to] <= ORDER[r.state]) return r.state === to;
      this.sql.run(
        "UPDATE receipts SET state = ?, updated_at = ?, publish_attempts = publish_attempts + ? WHERE ingestion_id = ?",
        to,
        this.clock.now(),
        to === "enqueued" ? 1 : 0,
        ingestionId,
      );
      return true;
    });
  }

  markBlobReady(ingestionId: string): boolean {
    return this.advance(ingestionId, "blob-ready");
  }

  markEnqueued(ingestionId: string): boolean {
    return this.advance(ingestionId, "enqueued");
  }

  markCommitted(ingestionId: string): boolean {
    return this.advance(ingestionId, "committed");
  }

  markRejected(ingestionId: string): boolean {
    return this.advance(ingestionId, "rejected");
  }

  /**
   * Quarantining an exhausted receipt failed transiently: park it in `quarantine-failed` (retried
   * at `QUARANTINE_RETRY_MS`, never pruned) — never `rejected`, which would let the prune sweep
   * forget a message whose SMTP delivery we already acknowledged.
   */
  markQuarantineFailed(ingestionId: string): boolean {
    return (
      this.sql.run(
        "UPDATE receipts SET state = 'quarantine-failed', updated_at = ?, publish_attempts = publish_attempts + 1 WHERE ingestion_id = ? AND state IN ('blob-ready', 'enqueued', 'quarantine-failed')",
        this.clock.now(),
        ingestionId,
      ) > 0
    );
  }

  /** True once a receipt has used its republish budget and should be quarantined, not replayed. */
  static exhausted(r: Pick<ReceiptRow, "publishAttempts" | "state">): boolean {
    return r.state === "quarantine-failed" || r.publishAttempts >= REPLAY_ATTEMPT_CAP;
  }

  /** Record a republish attempt for an already-enqueued receipt. */
  touchRepublished(ingestionId: string): void {
    this.sql.run(
      "UPDATE receipts SET updated_at = ?, publish_attempts = publish_attempts + 1 WHERE ingestion_id = ? AND state IN ('blob-ready', 'enqueued')",
      this.clock.now(),
      ingestionId,
    );
  }

  /**
   * Receipts whose original is durable but which have not been committed to a mailbox within
   * `olderThanMs` (queue publish failed, message expired, consumer lost). Republish by reference;
   * rows that are `IngressJournal.exhausted` are due for quarantine instead. `quarantine-failed`
   * rows come back only every `QUARANTINE_RETRY_MS`.
   */
  pendingReplay(olderThanMs: number, limit: number): ReadonlyArray<ReceiptRow> {
    const now = this.clock.now();
    return this.sql
      .all<{ ingestion_id: string }>(
        `SELECT ingestion_id FROM receipts
         WHERE (state IN ('blob-ready', 'enqueued') AND updated_at <= ?)
            OR (state = 'quarantine-failed' AND updated_at <= ?)
         ORDER BY updated_at LIMIT ?`,
        now - olderThanMs,
        now - Math.max(olderThanMs, QUARANTINE_RETRY_MS),
        limit,
      )
      .map((r) => this.get(r.ingestion_id)!);
  }

  /** Registered receipts whose blob write never completed. SMTP was not acknowledged for them. */
  abandonStale(olderThanMs: number): number {
    return this.sql.run(
      "UPDATE receipts SET state = 'abandoned', updated_at = ? WHERE state = 'registered' AND updated_at <= ?",
      this.clock.now(),
      this.clock.now() - olderThanMs,
    );
  }

  pruneCommitted(olderThanMs: number): number {
    return this.sql.run(
      "DELETE FROM receipts WHERE state IN ('committed', 'rejected', 'abandoned') AND updated_at <= ?",
      this.clock.now() - olderThanMs,
    );
  }

  /**
   * Queue payload: references only (§5.1 step 4). The event ID is derived from the ingestion ID so
   * that a republished receipt deduplicates against the original at the mailbox commit.
   */
  toIngestMessage(r: ReceiptRow, eventId = `ingest:${r.ingestionId}`): IngestMessage {
    return {
      schemaVersion: 1,
      type: "ingest",
      eventId,
      ingestionId: r.ingestionId,
      mailboxId: r.mailboxId,
      recipient: r.recipient,
      envelopeFrom: r.envelopeFrom,
      objectKey: r.objectKey,
      rawSize: r.rawSize,
      receivedAt: r.receivedAt,
    };
  }
}
