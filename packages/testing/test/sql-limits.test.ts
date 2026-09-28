import { describe, expect, it } from "vitest";
import { Sql } from "@bye/platform-cloudflare";
import { MemoryD1, MemoryDurableStorage } from "@bye/testing";

// The node:sqlite shims apply Cloudflare's SQL limits so a query that fails in workerd fails here.

const params = (n: number) => Array.from({ length: n }, (_, i) => i);

const inList = (n: number) =>
  `SELECT 1 AS x WHERE 1 IN (${params(n)
    .map(() => "?")
    .join(",")})`;

describe("Cloudflare SQL limits in the test shims", () => {
  it("Durable Object storage rejects more than 100 bound parameters", () => {
    const sql = new Sql(new MemoryDurableStorage());
    expect(sql.all(inList(100), ...params(100))).toHaveLength(1);
    expect(() => sql.all(inList(101), ...params(101))).toThrow(/too many SQL variables/);
  });

  it("Durable Object storage rejects LIKE patterns longer than 50 bytes", () => {
    const sql = new Sql(new MemoryDurableStorage());
    expect(sql.one("SELECT ? LIKE ? AS m", "a", `%${"a".repeat(49)}`)).toEqual({ m: 0 });
    expect(() => sql.one("SELECT ? LIKE ? AS m", "a", `%${"a".repeat(50)}`)).toThrow(
      /LIKE or GLOB pattern too complex/,
    );
    // Bytes, not characters: 17 three-byte characters are 51 bytes.
    expect(() => sql.one("SELECT ? LIKE ? AS m", "a", "日".repeat(17))).toThrow(/too complex/);
  });

  it("enforcement can be turned off per storage", () => {
    const sql = new Sql(new MemoryDurableStorage(":memory:", { enforceLimits: false }));
    expect(sql.all(inList(150), ...params(150))).toHaveLength(1);
  });

  it("the D1 shim applies the same bound-parameter cap", async () => {
    const d1 = new MemoryD1();
    await expect(
      d1
        .prepare(inList(101))
        .bind(...params(101))
        .all(),
    ).rejects.toThrow(/too many SQL variables/);
  });
});
