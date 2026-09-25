import { describe, expect, it } from "vitest";
import { BENCH_THRESHOLDS, runBench } from "../evidence/bench.ts";

describe("§14.5 parser/search evidence harness", () => {
  it("parses, indexes and finds every message within local thresholds", () => {
    const r = runBench(Number(process.env.BYE_BENCH_MESSAGES ?? 200));
    console.log(JSON.stringify(r));
    expect(r.recallAt10).toBe(BENCH_THRESHOLDS.recallAt10);
    expect(r.parseP95Ms).toBeLessThan(BENCH_THRESHOLDS.parseP95Ms);
    expect(r.indexMsPerDoc).toBeLessThan(BENCH_THRESHOLDS.indexMsPerDoc);
    expect(r.searchP95Ms).toBeLessThan(BENCH_THRESHOLDS.searchP95Ms);
  }, 60_000);
});
