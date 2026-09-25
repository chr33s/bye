// Narrow D1 binding interface (§7.1). Real `D1Database` satisfies it structurally.

export interface D1StatementLike {
  bind(...values: Array<unknown>): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: Array<T> }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1SessionLike {
  prepare(query: string): D1StatementLike;
  /** Atomic: all statements commit or none do. */
  batch(statements: Array<D1StatementLike>): Promise<Array<unknown>>;
}

export interface D1Like extends D1SessionLike {
  /** Read-replication sessions. Authorization reads use "first-primary" (§3.2). */
  withSession?(constraint: "first-primary" | "first-unconstrained"): D1SessionLike;
}

/** Primary-consistent session for authorization decisions; never a stale replica. */
export const primary = (db: D1Like): D1SessionLike =>
  db.withSession ? db.withSession("first-primary") : db;

export const q = (db: D1SessionLike, query: string, ...values: Array<unknown>): D1StatementLike =>
  db
    .prepare(query)
    .bind(
      ...values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)),
    );

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
export const changesOf = (result: unknown): number =>
  Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);

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
