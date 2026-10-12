import { describe, expect, it } from "vitest";
import { JMAP_BENCH_THRESHOLDS, runJmapBench } from "../evidence/jmap-bench.ts";

describe("spec.md §16 D2 local JMAP core evidence", () => {
  it("publishes, counts, queries, searches and pages changes within local thresholds", () => {
    const r = runJmapBench(Number(process.env.BYE_JMAP_BENCH_MESSAGES ?? 500));
    console.log(JSON.stringify(r));
    expect(r.textRecall).toBe(JMAP_BENCH_THRESHOLDS.textRecall);
    expect(r.prepareP95Ms).toBeLessThan(JMAP_BENCH_THRESHOLDS.prepareP95Ms);
    expect(r.publishMsPerEmail).toBeLessThan(JMAP_BENCH_THRESHOLDS.publishMsPerEmail);
    expect(r.queryP95Ms).toBeLessThan(JMAP_BENCH_THRESHOLDS.queryP95Ms);
    expect(r.textQueryP95Ms).toBeLessThan(JMAP_BENCH_THRESHOLDS.textQueryP95Ms);
  }, 600_000);
});
