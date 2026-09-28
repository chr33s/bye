// Narrow D1 binding interface (§7.1). Real `D1Database` satisfies it structurally.

/** A value D1 can bind as a statement parameter. */
export type D1Value = string | number | boolean | null | undefined | ArrayBuffer | Uint8Array;

/** A column value read back from D1. */
export type D1Column = string | number | boolean | null | ArrayBuffer;

/** Default row for untyped reads. */
export type D1Row = Record<string, D1Column>;

/** The per-statement result of a `batch` call. */
export interface D1BatchResult {
  readonly meta?: { readonly changes?: number };
}

export interface D1StatementLike {
  bind(...values: Array<D1Value>): D1StatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: Array<T> }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1SessionLike {
  prepare(query: string): D1StatementLike;
  /** Atomic: all statements commit or none do. */
  batch(statements: Array<D1StatementLike>): Promise<Array<D1BatchResult>>;
}

export interface D1Like extends D1SessionLike {
  /** Read-replication sessions. Authorization reads use "first-primary" (§3.2). */
  withSession?(constraint: "first-primary" | "first-unconstrained"): D1SessionLike;
}

/** Primary-consistent session for authorization decisions; never a stale replica. */
export const primary = (db: D1Like): D1SessionLike =>
  db.withSession ? db.withSession("first-primary") : db;

export const q = (db: D1SessionLike, query: string, ...values: Array<D1Value>): D1StatementLike =>
  db
    .prepare(query)
    .bind(...values.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v)));

// Bounded `IN (...)` lists (D1 binds at most 100 parameters): use `inListChunks`/`MAX_IN_LIST`
// from durable/sql.ts, shared with Durable Object SQLite.

/** One audit-log row as a statement, so it commits in the same `batch` as the change it records. */
export interface AuditEntry {
  readonly orgId?: string | null;
  readonly actorId: string;
  readonly action: string;
  readonly target: string;
  readonly detail?: unknown;
}

export const audit = (
  db: D1SessionLike,
  clock: { id(prefix: string): string; now(): number },
  e: AuditEntry,
): D1StatementLike =>
  q(
    db,
    "INSERT INTO audit_log (id, org_id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    clock.id("aud"),
    e.orgId ?? null,
    e.actorId,
    e.action,
    e.target,
    JSON.stringify(e.detail ?? {}),
    clock.now(),
  );

/** Rows changed by one statement of a `batch` result (D1 returns `{ meta: { changes } }` per statement). */
export const changesOf = (result: D1BatchResult | undefined): number =>
  Number(result?.meta?.changes ?? 0);

/**
 * Audit row that is written only if the PREVIOUS statement in the same `batch` changed a row
 * (`changes() > 0`): an atomic "change, then audit that it happened". `id` lets callers use the
 * row as a marker for later guarded statements.
 */
export const auditIfChanged = (
  db: D1SessionLike,
  clock: { id(prefix: string): string; now(): number },
  e: AuditEntry,
  id: string = clock.id("aud"),
): D1StatementLike =>
  q(
    db,
    "INSERT INTO audit_log (id, org_id, actor_id, action, target, detail, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0",
    id,
    e.orgId ?? null,
    e.actorId,
    e.action,
    e.target,
    JSON.stringify(e.detail ?? {}),
    clock.now(),
  );
