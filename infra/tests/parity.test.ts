import { readFileSync } from "node:fs";
import { PARITY_LEDGER } from "@bye/domain";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../policies/fs.ts";

// Definition of done (§13): no parity row hidden behind "later". Every ledger ID must have at
// least one executable test tagged `[ID]` in its name.

const tagsIn = (source: string): Set<string> => {
  const tags = new Set<string>();
  // Only count tags inside a test/describe title string, not arbitrary comments.
  for (const m of source.matchAll(
    /\b(?:it|test|describe)(?:\.\w+)*(?:\([^)]*\))?\(\s*(["'`])([^"'`]*)\1/g,
  )) {
    for (const t of (m[2] ?? "").matchAll(/\[([ECOPAX]\d\d)\]/g)) tags.add(t[1] as string);
  }
  return tags;
};

describe("§2 product parity ledger", () => {
  const covered = new Set<string>();
  for (const file of sourceFiles(["packages", "workers", "apps", "infra"], { ext: /\.test\.ts$/ }))
    for (const tag of tagsIn(readFileSync(file, "utf8"))) covered.add(tag);

  it("has unique, well-formed IDs numbered without gaps within each area", () => {
    const ids = PARITY_LEDGER.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    const byArea = new Map<string, Array<number>>();
    for (const id of ids) {
      // The same shape tagsIn() recognizes, so every row is taggable.
      expect(id).toMatch(/^[ECOPAX]\d\d$/);
      byArea.set(id[0]!, [...(byArea.get(id[0]!) ?? []), Number(id.slice(1))]);
    }
    for (const [area, numbers] of byArea)
      expect(numbers, area).toEqual(numbers.map((_, i) => i + 1));
  });

  it("every parity row has at least one tagged acceptance test", () => {
    const missing = PARITY_LEDGER.filter((r) => !covered.has(r.id)).map(
      (r) => `${r.id} ${r.capability}`,
    );
    expect(missing).toEqual([]);
  });

  it("only counts tags inside test titles", () => {
    expect([
      ...tagsIn(
        '// [E01]\nit("[E02] screener", () => {});\ndescribe.each([1])("[C03] x", () => {});',
      ),
    ]).toEqual(["E02", "C03"]);
  });
});
