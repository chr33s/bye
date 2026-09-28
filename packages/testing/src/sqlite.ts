import { DatabaseSync } from "node:sqlite";
import type {
  SqlCursorLike,
  SqlRow,
  SqlValue,
  TransactionalStorage,
} from "@bye/platform-cloudflare";

/**
 * Cloudflare SQL limits that node:sqlite does not apply by default: Durable Object SQLite and D1
 * both cap bound parameters at 100 per statement and LIKE/GLOB patterns at 50 bytes. The test
 * shims enforce them so a query that would fail in workerd fails in tests too.
 * Set `BYE_SQL_LIMITS=off` to disable enforcement (e.g. when bisecting a failure).
 */
export const CLOUDFLARE_SQL_LIMITS = { variableNumber: 100, likePatternLength: 50 } as const;

/**
 * A node:sqlite database with {@link CLOUDFLARE_SQL_LIMITS} applied (node:sqlite `limits`
 * option; `@types/node` doesn't declare it yet, hence the cast).
 */
export const openCloudflareSqlite = (
  path = ":memory:",
  enforce = process.env.BYE_SQL_LIMITS !== "off",
): DatabaseSync =>
  new DatabaseSync(
    path,
    (enforce ? { limits: { ...CLOUDFLARE_SQL_LIMITS } } : {}) as ConstructorParameters<
      typeof DatabaseSync
    >[1],
  );

/**
 * node:sqlite implementation of the Durable Object `ctx.storage` subset used by adapters.
 * Mirrors DO semantics that matter for tests: multi-statement exec without bindings,
 * synchronous transactions with rollback on throw, nested transactions via savepoints.
 */
export class MemoryDurableStorage implements TransactionalStorage {
  readonly db: DatabaseSync;
  private depth = 0;
  private alarm: number | null = null;

  constructor(path = ":memory:", options: { readonly enforceLimits?: boolean } = {}) {
    this.db = openCloudflareSqlite(path, options.enforceLimits);
  }

  readonly sql = {
    exec: (query: string, ...bindings: Array<SqlValue>): SqlCursorLike => {
      if (bindings.length === 0 && hasMultipleStatements(query)) {
        this.db.exec(query);

        return { toArray: () => [], rowsWritten: 0 };
      }

      const statement = this.db.prepare(query);
      const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));

      if (statement.columns().length > 0) {
        const rows = statement.all(...(params as Array<never>)) as Array<SqlRow>;

        return { toArray: () => rows.map((r) => ({ ...r })), rowsWritten: 0 };
      }

      const result = statement.run(...(params as Array<never>));

      return { toArray: () => [], rowsWritten: Number(result.changes) };
    },
  };

  transactionSync<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
    this.depth++;

    try {
      const result = fn();

      if (result instanceof Promise)
        throw new Error("transactionSync callback must be synchronous");
      this.depth--;
      this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${name}`);

      return result;
    } catch (error) {
      this.depth--;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

const hasMultipleStatements = (query: string): boolean =>
  query.trim().replace(/;\s*$/, "").includes(";");
