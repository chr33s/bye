// Narrow binding interfaces over Durable Object SQLite storage (§7.4 Transactions).
// Adapters depend on these instead of a whole Worker environment so the same code runs
// against `ctx.storage` in workerd and against node:sqlite in tests.

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlCursorLike {
  toArray(): Array<SqlRow>;
  readonly rowsWritten: number;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: Array<SqlValue>): SqlCursorLike;
}

export interface TransactionalStorage {
  readonly sql: SqlStorageLike;
  /** Synchronous transaction. The callback must not await (§7.4). */
  transactionSync<T>(fn: () => T): T;
}

/** Thin helper that fully consumes cursors immediately, never holding one across an await. */
export class Sql {
  constructor(readonly storage: TransactionalStorage) {}

  all<T = SqlRow>(query: string, ...bindings: Array<SqlValue | boolean | undefined>): Array<T> {
    return this.storage.sql.exec(query, ...bindings.map(normalize)).toArray() as Array<T>;
  }

  one<T = SqlRow>(
    query: string,
    ...bindings: Array<SqlValue | boolean | undefined>
  ): T | undefined {
    return this.all<T>(query, ...bindings)[0];
  }

  run(query: string, ...bindings: Array<SqlValue | boolean | undefined>): number {
    return this.storage.sql.exec(query, ...bindings.map(normalize)).rowsWritten;
  }

  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

const normalize = (value: SqlValue | boolean | undefined): SqlValue =>
  value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;

/**
 * Durable Object SQLite and D1 reject statements with more than 100 bound parameters. IN lists
 * are bound in chunks of at most this many ids, leaving headroom for the statement's other
 * parameters.
 */
export const MAX_IN_LIST = 90;

/** `?,?,…` placeholders for an IN list of `n` values. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

/** Split `items` into consecutive chunks of at most `size` (default {@link MAX_IN_LIST}). */
export const inListChunks = <T>(
  items: ReadonlyArray<T>,
  size: number = MAX_IN_LIST,
): Array<Array<T>> => {
  if (!(size >= 1)) throw new RangeError("chunk size must be at least 1");
  const out: Array<Array<T>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Run `query(chunk)` for each chunk of the distinct `ids` and concatenate the rows. Use for every
 * `IN (${placeholders(n)})` lookup whose id count is not statically bounded below 90.
 */
export const allInChunks = <T>(
  ids: ReadonlyArray<string>,
  query: (chunk: ReadonlyArray<string>) => ReadonlyArray<T>,
): Array<T> => inListChunks([...new Set(ids)]).flatMap((c) => [...query(c)]);

/**
 * Durable Object SQLite (and D1) reject LIKE/GLOB patterns longer than 50 bytes. Substring and
 * prefix matches over user input use `instr()` instead, which has no pattern limit; this is exposed
 * for callers that still build patterns so they can check before binding.
 */
export const MAX_LIKE_PATTERN_BYTES = 50;

export const likePatternFits = (pattern: string): boolean =>
  new TextEncoder().encode(pattern).length <= MAX_LIKE_PATTERN_BYTES;

export const bool = (value: SqlValue | undefined): boolean => value === 1 || value === "1";

export const json = <T>(value: SqlValue | undefined, fallback: T): T =>
  typeof value === "string" && value.length > 0 ? (JSON.parse(value) as T) : fallback;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/**
 * In-object application SQL migrations (§15.9), distinct from DO namespace class migrations.
 * Run under the DO initialization gate (`blockConcurrencyWhile`). Each migration is a bounded,
 * synchronous transaction; backfills are resumable background jobs, not part of this call.
 */
export const migrate = (
  sql: Sql,
  authority: string,
  migrations: ReadonlyArray<Migration>,
): number => {
  sql.run(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (authority TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (authority, version))",
  );
  const applied = new Set(
    sql
      .all<{ version: number }>(
        "SELECT version FROM _schema_migrations WHERE authority = ?",
        authority,
      )
      .map((r) => Number(r.version)),
  );
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  let current = applied.size === 0 ? 0 : Math.max(...applied);
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    if (migration.version <= current) {
      throw new Error(
        `${authority}: migration ${migration.version} is older than applied version ${current}`,
      );
    }
    sql.tx(() => {
      for (const statement of migration.statements) sql.run(statement);
      sql.run(
        "INSERT INTO _schema_migrations (authority, version, name) VALUES (?, ?, ?)",
        authority,
        migration.version,
        migration.name,
      );
    });
    current = migration.version;
  }
  return current;
};
