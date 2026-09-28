import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_MIGRATIONS,
  INGRESS_MIGRATIONS,
  KERNEL_MIGRATIONS,
  MAILBOX_MIGRATIONS,
  type Migration,
  SEARCH_MIGRATIONS,
  SPACE_MIGRATIONS,
  WORLD_MIGRATIONS,
} from "@bye/platform-cloudflare";

// §15.9 / §13 "D1/DO expand-contract migrations": readers and writers from release N-1 must keep
// working on schema N for the rollback interval. For every migration step we apply the history up
// to N-1, snapshot each table's columns, apply N, and require: no table dropped, no column dropped
// or renamed, and every newly added column is nullable or defaulted (so N-1 INSERTs still succeed).
// Destructive DDL is only legal in a later "contract" step recorded as a decommission.

type Columns = Map<
  string,
  { readonly notnull: boolean; readonly dflt: unknown; readonly pk: boolean }
>;

const snapshot = (db: DatabaseSync): Map<string, Columns> => {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all() as Array<{ name: string }>;

  return new Map(
    tables.map(({ name }) => [
      name,
      new Map(
        (
          db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
            name: string;
            notnull: number;
            dflt_value: unknown;
            pk: number;
          }>
        ).map((c) => [c.name, { notnull: c.notnull === 1, dflt: c.dflt_value, pk: c.pk > 0 }]),
      ),
    ]),
  );
};

const compatViolations = (
  before: Map<string, Columns>,
  after: Map<string, Columns>,
): ReadonlyArray<string> => {
  const out: Array<string> = [];

  for (const [table, cols] of before) {
    const next = after.get(table);

    if (!next) {
      out.push(`table ${table} dropped`);
      continue;
    }

    for (const col of cols.keys())
      if (!next.has(col)) out.push(`${table}.${col} dropped or renamed`);

    for (const [col, info] of next) {
      if (!cols.has(col) && info.notnull && info.dflt === null && !info.pk)
        out.push(`${table}.${col} added NOT NULL without DEFAULT`);
    }
  }

  return out;
};

const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN)|RENAME\s+(TO|COLUMN))\b/i;

/**
 * SQLite cannot alter constraints in place, so the sanctioned "table rebuild" is allowed:
 * CREATE t_new … ; INSERT … SELECT … FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t — within one
 * migration. Any other DROP/RENAME is destructive. Column preservation is checked separately.
 */
export const unsanctionedDdl = (statements: ReadonlyArray<string>): ReadonlyArray<string> => {
  const sql = statements.join(";\n");
  const out: Array<string> = [];

  for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) {
    if (!new RegExp(`ALTER\\s+TABLE\\s+"?\\w+"?\\s+RENAME\\s+TO\\s+"?${m[1]}"?\\b`, "i").test(sql))
      out.push(`DROP TABLE ${m[1]} without a rebuild`);
  }

  for (const m of sql.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)"?/gi)) {
    if (!new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?"?${m[2]}"?\\b`, "i").test(sql))
      out.push(`RENAME ${m[1]} TO ${m[2]} outside a rebuild`);
  }

  if (/DROP\s+COLUMN|RENAME\s+COLUMN/i.test(sql)) out.push("DROP/RENAME COLUMN");

  return out;
};

describe("§15.9 expand-only schema changes (N-1 compatibility)", () => {
  const d1Dir = join(import.meta.dirname, "../migrations/d1");

  const files = readdirSync(d1Dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("D1 migration files are ordered, uniquely numbered and contain no destructive DDL", () => {
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);

    for (const f of files)
      expect(
        unsanctionedDdl([readFileSync(join(d1Dir, f), "utf8").replace(/--[^\n]*/g, "")]),
        f,
      ).toEqual([]);
  });

  it("every D1 migration keeps schema N-1 readers and writers working", () => {
    const db = new DatabaseSync(":memory:");

    for (const f of files) {
      const before = snapshot(db);
      db.exec(readFileSync(join(d1Dir, f), "utf8"));
      expect(compatViolations(before, snapshot(db)), f).toEqual([]);
    }
  });

  const sets: ReadonlyArray<readonly [string, ReadonlyArray<Migration>]> = [
    ["kernel", KERNEL_MIGRATIONS],
    ["mailbox", MAILBOX_MIGRATIONS],
    ["calendar", CALENDAR_MIGRATIONS],
    ["space", SPACE_MIGRATIONS],
    ["world", WORLD_MIGRATIONS],
    ["ingress", INGRESS_MIGRATIONS],
    ["search", SEARCH_MIGRATIONS],
  ];

  for (const [authority, migrations] of sets) {
    it(`[A04] ${authority} in-object SQL migrations are expand-only and N-1 compatible`, () => {
      const versions = migrations.map((m) => m.version);
      expect([...versions].sort((a, b) => a - b)).toEqual(versions);
      expect(new Set(versions).size).toBe(versions.length);
      const db = new DatabaseSync(":memory:");

      for (const m of migrations) {
        const before = snapshot(db);
        expect(unsanctionedDdl(m.statements), `${authority} v${m.version}`).toEqual([]);

        for (const statement of m.statements) db.exec(statement);
        expect(compatViolations(before, snapshot(db)), `${authority} v${m.version}`).toEqual([]);
      }
    });
  }

  it("the checker itself rejects drops, renames and NOT NULL additions without defaults", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a TEXT NOT NULL, b INTEGER)");
    const before = snapshot(db);
    db.exec("ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT 'x'");
    expect(compatViolations(before, snapshot(db))).toEqual([]);
    const db2 = new DatabaseSync(":memory:");
    db2.exec("CREATE TABLE t (a TEXT NOT NULL, b INTEGER)");
    const b2 = snapshot(db2);
    db2.exec("ALTER TABLE t DROP COLUMN b");
    expect(compatViolations(b2, snapshot(db2))).toEqual(["t.b dropped or renamed"]);
    expect(unsanctionedDdl(["ALTER TABLE t RENAME COLUMN a TO z"])).toEqual(["DROP/RENAME COLUMN"]);
    expect(unsanctionedDdl(["DROP TABLE t"])).toEqual(["DROP TABLE t without a rebuild"]);
    expect(
      unsanctionedDdl([
        "CREATE TABLE t_v2 (a TEXT)",
        "INSERT INTO t_v2 SELECT a FROM t",
        "DROP TABLE t",
        "ALTER TABLE t_v2 RENAME TO t",
      ]),
    ).toEqual([]);
    expect(DESTRUCTIVE.test("DROP TABLE x")).toBe(true);
  });
});
