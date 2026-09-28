import type { PropagatePayload, PropagateTopic } from "@bye/contracts";
import { Predicate } from "effect";
import { reject } from "./rpc.ts";
import { json, type Migration, Sql } from "./sql.ts";

// Durable authority kernel (§4.1 "Durable authorities", §6): CommandReceipt, OutboxEvent,
// ChangeEvent, ScheduledJob. Every SQLite-backed authority embeds one kernel so that
// idempotency, change sequences, outbox publication, and generation-tagged timers
// share one tested implementation.

export const KERNEL_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "kernel",
    statements: [
      `CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE change_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        resource TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE outbox (
        event_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX outbox_pending ON outbox (published_at, created_at)",
      `CREATE TABLE scheduled_jobs (
        kind TEXT NOT NULL,
        job_key TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (kind, job_key)
      )`,
      "CREATE INDEX scheduled_jobs_due ON scheduled_jobs (state, due_at)",
      `CREATE TABLE inbound_receipts (
        event_id TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (event_id, target)
      )`,
    ],
  },
  {
    // Poison isolation (§6): an outbox row that can never be published (oversize, repeatedly
    // refused) is dead-lettered locally with diagnostics instead of blocking the queue behind it.
    version: 2,
    name: "kernel-outbox-dead-letter",
    statements: [
      "ALTER TABLE outbox ADD COLUMN dead_at INTEGER",
      "ALTER TABLE outbox ADD COLUMN dead_reason TEXT",
    ],
  },
  {
    // Bounded tables: receipts, published outbox rows and finished jobs are pruned after a TTL
    // (`prune`). Command receipts carry a payload hash so a reused command ID with a different
    // payload is a conflict, not a silent replay. Failing jobs are retried with backoff and then
    // parked as `failed` instead of blocking the alarm.
    version: 3,
    name: "kernel-retention",
    statements: [
      "ALTER TABLE command_receipts ADD COLUMN payload_hash TEXT",
      "CREATE INDEX command_receipts_created ON command_receipts (created_at)",
      "ALTER TABLE inbound_receipts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
      // Existing rows get the migration time, so they age out one TTL from now.
      "UPDATE inbound_receipts SET created_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE created_at = 0",
      "CREATE INDEX inbound_receipts_created ON inbound_receipts (created_at)",
      "CREATE INDEX outbox_published ON outbox (published_at) WHERE published_at IS NOT NULL",
      "ALTER TABLE scheduled_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE scheduled_jobs ADD COLUMN last_error TEXT",
      "CREATE INDEX scheduled_jobs_finished ON scheduled_jobs (state, due_at) WHERE state IN ('done','cancelled')",
    ],
  },
];

/** How long idempotency receipts, published outbox rows and finished jobs are kept. */
export const KERNEL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows deleted per table per `prune` call, so housekeeping stays inside one alarm/cron budget. */
export const KERNEL_PRUNE_BATCH = 500;

/** Attempts before a throwing scheduled job is parked as `failed` (dead-lettered). */
export const JOB_MAX_ATTEMPTS = 3;

/** A JSON-serializable command or event payload. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/**
 * Stable, order-insensitive fingerprint of a command payload: canonical JSON (sorted keys) run
 * through two FNV-1a 32-bit lanes. It detects accidental command-ID reuse; it is not a MAC.
 */
export const payloadHash = (payload: JsonValue): string => {
  const text = canonicalJson(payload);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }

  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
};

const canonicalJson = (value: JsonValue): string => {
  if (value === undefined) return "null";

  if (value === null || !Predicate.isObjectKeyword(value) || Predicate.isFunction(value))
    return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export interface ReceiptOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

export interface ChangeFeed {
  readonly changes: ReadonlyArray<ChangeEvent>;
  readonly cursor: number;
  readonly expired: boolean;
}

export interface PruneResult {
  readonly deleted: number;
  readonly more: boolean;
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly topic: string;
  readonly target: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface ChangeEvent {
  readonly seq: number;
  readonly resource: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface DueJob {
  readonly kind: string;
  readonly key: string;
  readonly dueAt: number;
  readonly generation: number;
  readonly payload: unknown;
}

export interface KernelClock {
  readonly now: () => number;
  readonly id: (prefix: string) => string;
}

type OutboxRow = {
  event_id: string;
  topic: string;
  target: string;
  payload: string;
  created_at: number;
};

const toOutboxEvent = (r: OutboxRow): OutboxEvent => ({
  eventId: r.event_id,
  topic: r.topic,
  target: r.target,
  payload: json<JsonValue>(r.payload, null),
  createdAt: Number(r.created_at),
});

type JobRow = {
  kind: string;
  job_key: string;
  due_at: number;
  generation: number;
  payload: string;
};

const toDueJob = (r: JobRow): DueJob => ({
  kind: r.kind,
  key: r.job_key,
  dueAt: Number(r.due_at),
  generation: Number(r.generation),
  payload: json<unknown>(r.payload, null),
});

export class Kernel {
  constructor(
    readonly sql: Sql,
    readonly clock: KernelClock,
  ) {}

  /**
   * Execute `fn` once per command ID. A replay returns the stored result without re-running.
   * Callers invoke this inside their own transaction so the receipt commits with the mutation.
   */
  receipt<T>(
    commandId: string,
    kind: string,
    fn: () => T,
    /** The command's payload; when given, a replay with a different payload is a conflict. */
    payload?: JsonValue,
  ): ReceiptOutcome<T> {
    const hash = payload === undefined ? null : payloadHash(payload);

    const existing = this.sql.one<{ kind: string; result: string; payload_hash: string | null }>(
      "SELECT kind, result, payload_hash FROM command_receipts WHERE command_id = ?",
      commandId,
    );

    if (existing) {
      // Reusing a command ID for a different command is a client error, never a replay.
      if (existing.kind !== kind)
        reject("conflict", `command ${commandId} was already used for ${existing.kind}`);

      // Receipts written before payload hashing (or without a payload) replay unchecked.
      if (hash !== null && existing.payload_hash !== null && existing.payload_hash !== hash)
        reject("conflict", `command ${commandId} was already used with a different payload`);

      return { result: JSON.parse(existing.result) as T, replayed: true };
    }

    const result = fn();
    this.sql.run(
      "INSERT INTO command_receipts (command_id, kind, result, created_at, payload_hash) VALUES (?, ?, ?, ?, ?)",
      commandId,
      kind,
      JSON.stringify(result ?? null),
      this.clock.now(),
      hash,
    );

    return { result, replayed: false };
  }

  /** Consumer-side deduplication by (eventId, targetId) (§6). */
  consume<T>(eventId: string, target: string, fn: () => T): ReceiptOutcome<T> {
    const existing = this.sql.one<{ result: string }>(
      "SELECT result FROM inbound_receipts WHERE event_id = ? AND target = ?",
      eventId,
      target,
    );

    if (existing) return { result: JSON.parse(existing.result) as T, replayed: true };
    const result = fn();
    this.sql.run(
      "INSERT INTO inbound_receipts (event_id, target, result, created_at) VALUES (?, ?, ?, ?)",
      eventId,
      target,
      JSON.stringify(result ?? null),
      this.clock.now(),
    );

    return { result, replayed: false };
  }

  change(resource: string, kind: string, payload: JsonValue): number {
    this.sql.run(
      "INSERT INTO change_events (resource, kind, payload, created_at) VALUES (?, ?, ?, ?)",
      resource,
      kind,
      JSON.stringify(payload),
      this.clock.now(),
    );

    return this.currentSeq();
  }

  changesSince(cursor: number, limit: number): ChangeFeed {
    const oldest = Number(
      this.sql.one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM change_events")?.seq ?? 0,
    );

    const expired = cursor > 0 && oldest > 0 && cursor < oldest - 1;

    const rows = this.sql.all<{
      seq: number;
      resource: string;
      kind: string;
      payload: string;
      created_at: number;
    }>(
      "SELECT seq, resource, kind, payload, created_at FROM change_events WHERE seq > ? ORDER BY seq LIMIT ?",
      cursor,
      limit,
    );

    const changes = rows.map((r) => ({
      seq: Number(r.seq),
      resource: r.resource,
      kind: r.kind,
      payload: json<unknown>(r.payload, null),
      createdAt: Number(r.created_at),
    }));

    return { changes, cursor: changes.at(-1)?.seq ?? Math.max(cursor, this.currentSeq()), expired };
  }

  currentSeq(): number {
    return Number(
      this.sql.one<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM change_events")?.seq ?? 0,
    );
  }

  /**
   * Trim change history, keeping at least `keep` most recent events. Expired cursors force a
   * snapshot. Every authority calls this from its reconcile path, so it also runs one bounded
   * `prune` pass over the kernel's other append-only tables.
   */
  compactChanges(keep: number): void {
    this.sql.run(
      "DELETE FROM change_events WHERE seq <= (SELECT MAX(seq) FROM change_events) - ?",
      keep,
    );
    this.prune();
  }

  /**
   * Delete, at most `batch` rows per table, command and inbound receipts, published outbox rows
   * and done/cancelled jobs older than `ttlMs`. Dead-lettered outbox rows, pending work and
   * failed jobs are kept. `more` reports whether any table still had rows past the cutoff.
   */
  prune(options: { readonly ttlMs?: number; readonly batch?: number } = {}): PruneResult {
    const cutoff = this.clock.now() - (options.ttlMs ?? KERNEL_RETENTION_MS);
    const batch = Math.max(1, Math.floor(options.batch ?? KERNEL_PRUNE_BATCH));

    const statements = [
      "DELETE FROM command_receipts WHERE rowid IN (SELECT rowid FROM command_receipts WHERE created_at < ? LIMIT ?)",
      "DELETE FROM inbound_receipts WHERE rowid IN (SELECT rowid FROM inbound_receipts WHERE created_at < ? LIMIT ?)",
      "DELETE FROM outbox WHERE rowid IN (SELECT rowid FROM outbox WHERE published_at IS NOT NULL AND published_at < ? LIMIT ?)",
      "DELETE FROM scheduled_jobs WHERE rowid IN (SELECT rowid FROM scheduled_jobs WHERE state IN ('done','cancelled') AND due_at < ? LIMIT ?)",
    ];

    let deleted = 0;
    let more = false;
    this.sql.tx(() => {
      for (const statement of statements) {
        const n = this.sql.run(statement, cutoff, batch);
        deleted += n;

        if (n >= batch) more = true;
      }
    });

    return { deleted, more };
  }

  /**
   * Typed propagate emission: `fields` must match the topic's `PropagatePayload` member, so a
   * producer and its consumer can't drift. Rides the outbox like any other event.
   */
  emit<T extends PropagateTopic>(
    topic: T,
    target: string,
    fields: Omit<Extract<PropagatePayload, { readonly topic: T }>, "topic">,
  ): string {
    return this.outbox(topic, target, fields);
  }

  outbox<P>(topic: string, target: string, payload: P): string {
    const eventId = this.clock.id("evt");
    this.sql.run(
      "INSERT INTO outbox (event_id, topic, target, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      eventId,
      topic,
      target,
      JSON.stringify(payload),
      this.clock.now(),
    );

    return eventId;
  }

  pendingOutbox(limit: number): ReadonlyArray<OutboxEvent> {
    return this.sql
      .all<OutboxRow>(
        "SELECT event_id, topic, target, payload, created_at FROM outbox WHERE published_at IS NULL AND dead_at IS NULL ORDER BY created_at, event_id LIMIT ?",
        limit,
      )
      .map(toOutboxEvent);
  }

  /** Mark published after the queue accepted the batch. A crash before this produces a harmless repeat. */
  markPublished(eventIds: ReadonlyArray<string>): void {
    const now = this.clock.now();
    this.sql.tx(() => {
      for (const id of eventIds)
        this.sql.run("UPDATE outbox SET published_at = ? WHERE event_id = ?", now, id);
    });
  }

  markPublishFailed(eventIds: ReadonlyArray<string>): void {
    this.sql.tx(() => {
      for (const id of eventIds)
        this.sql.run("UPDATE outbox SET attempts = attempts + 1 WHERE event_id = ?", id);
    });
  }

  /** Attempts so far for pending rows (used to dead-letter repeatedly refused rows). */
  outboxAttempts(eventIds: ReadonlyArray<string>): ReadonlyMap<string, number> {
    const out = new Map<string, number>();

    for (const id of eventIds)
      out.set(
        id,
        Number(
          this.sql.one<{ attempts: number }>("SELECT attempts FROM outbox WHERE event_id = ?", id)
            ?.attempts ?? 0,
        ),
      );

    return out;
  }

  /** Move rows out of the publish path; they stay inspectable and can be re-armed. */
  deadLetterOutbox(eventIds: ReadonlyArray<string>, reason: string): void {
    const now = this.clock.now();
    this.sql.tx(() => {
      for (const id of eventIds)
        this.sql.run(
          "UPDATE outbox SET dead_at = ?, dead_reason = ? WHERE event_id = ? AND published_at IS NULL",
          now,
          reason.slice(0, 500),
          id,
        );
    });
  }

  deadOutbox(
    limit: number,
  ): ReadonlyArray<OutboxEvent & { readonly reason: string; readonly deadAt: number }> {
    return this.sql
      .all<OutboxRow & { dead_reason: string; dead_at: number }>(
        "SELECT event_id, topic, target, payload, created_at, dead_reason, dead_at FROM outbox WHERE dead_at IS NOT NULL AND published_at IS NULL ORDER BY dead_at LIMIT ?",
        limit,
      )
      .map((r) => ({ ...toOutboxEvent(r), reason: r.dead_reason, deadAt: Number(r.dead_at) }));
  }

  /** Re-arm a dead-lettered row after the cause was fixed. */
  rearmOutbox(eventId: string): boolean {
    return (
      this.sql.run(
        "UPDATE outbox SET dead_at = NULL, dead_reason = NULL, attempts = 0 WHERE event_id = ? AND published_at IS NULL",
        eventId,
      ) > 0
    );
  }

  /**
   * Upsert a persisted job; returns the new generation. Any previously scheduled generation for
   * the same (kind, key) becomes stale, so an old alarm cannot resurrect a cancelled action (§4.2).
   */
  schedule(kind: string, key: string, dueAt: number, payload: JsonValue): number {
    const prior = this.sql.one<{ generation: number }>(
      "SELECT generation FROM scheduled_jobs WHERE kind = ? AND job_key = ?",
      kind,
      key,
    );

    const generation = Number(prior?.generation ?? 0) + 1;
    this.sql.run(
      `INSERT INTO scheduled_jobs (kind, job_key, due_at, generation, payload, state) VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (kind, job_key) DO UPDATE SET due_at = excluded.due_at, generation = excluded.generation,
         payload = excluded.payload, state = 'pending', attempts = 0, last_error = NULL`,
      kind,
      key,
      dueAt,
      generation,
      JSON.stringify(payload),
    );

    return generation;
  }

  /** Cancel by bumping the generation and marking the row cancelled. */
  cancelJob(kind: string, key: string): boolean {
    return (
      this.sql.run(
        "UPDATE scheduled_jobs SET state = 'cancelled', generation = generation + 1 WHERE kind = ? AND job_key = ? AND state = 'pending'",
        kind,
        key,
      ) > 0
    );
  }

  job(kind: string, key: string): DueJob | undefined {
    const r = this.sql.one<JobRow & { state: string }>(
      "SELECT kind, job_key, due_at, generation, payload, state FROM scheduled_jobs WHERE kind = ? AND job_key = ? AND state = 'pending'",
      kind,
      key,
    );

    return r ? toDueJob(r) : undefined;
  }

  dueJobs(now: number, limit: number): ReadonlyArray<DueJob> {
    return this.sql
      .all<JobRow>(
        "SELECT kind, job_key, due_at, generation, payload FROM scheduled_jobs WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, kind, job_key LIMIT ?",
        now,
        limit,
      )
      .map(toDueJob);
  }

  /**
   * Complete a job only if its generation is still current. Returns false for a stale job,
   * which the caller must skip without side effects.
   */
  completeJob(job: Pick<DueJob, "kind" | "key" | "generation">): boolean {
    return (
      this.sql.run(
        "UPDATE scheduled_jobs SET state = 'done' WHERE kind = ? AND job_key = ? AND generation = ? AND state = 'pending'",
        job.kind,
        job.key,
        job.generation,
      ) > 0
    );
  }

  /**
   * Record a throwing job (its transaction already rolled back). The job is retried with
   * exponential backoff and parked as `failed` after {@link JOB_MAX_ATTEMPTS}, so one poison job
   * can't wedge the alarm. Stale generations are left alone. Returns the resulting state.
   */
  failJob(
    job: Pick<DueJob, "kind" | "key" | "generation">,
    cause: unknown,
  ): "retry" | "failed" | "stale" {
    const row = this.sql.one<{ attempts: number }>(
      "SELECT attempts FROM scheduled_jobs WHERE kind = ? AND job_key = ? AND generation = ? AND state = 'pending'",
      job.kind,
      job.key,
      job.generation,
    );

    if (!row) return "stale";
    const attempts = Number(row.attempts) + 1;

    const reason = (
      cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    ).slice(0, 500);

    const failed = attempts >= JOB_MAX_ATTEMPTS;
    this.sql.run(
      "UPDATE scheduled_jobs SET attempts = ?, last_error = ?, state = ?, due_at = ? WHERE kind = ? AND job_key = ? AND generation = ?",
      attempts,
      reason,
      failed ? "failed" : "pending",
      failed ? this.clock.now() : this.clock.now() + 60_000 * 2 ** (attempts - 1),
      job.kind,
      job.key,
      job.generation,
    );

    return failed ? "failed" : "retry";
  }

  /** Jobs parked after repeated failures, for operators. */
  failedJobs(limit: number): ReadonlyArray<DueJob & { readonly error: string | null }> {
    return this.sql
      .all<JobRow & { last_error: string | null }>(
        "SELECT kind, job_key, due_at, generation, payload, last_error FROM scheduled_jobs WHERE state = 'failed' ORDER BY due_at LIMIT ?",
        limit,
      )
      .map((r) => ({ ...toDueJob(r), error: r.last_error }));
  }

  nextDueAt(): number | null {
    const r = this.sql.one<{ due: number | null }>(
      "SELECT MIN(due_at) AS due FROM scheduled_jobs WHERE state = 'pending'",
    );

    return r?.due == null ? null : Number(r.due);
  }

  hasPendingOutbox(): boolean {
    return (
      this.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL AND dead_at IS NULL",
      )?.n !== 0
    );
  }
}
