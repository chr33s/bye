import { describe, expect, it } from "vitest";
import {
  applyPlan,
  DRILL_MANIFEST,
  drillPassed,
  memoryBackend,
  planDeploy,
  runFailedDeployDrill,
} from "../drills/failed-deploy.ts";

// §13 failed/interrupted-deploy recovery, against the production state backend and lease code.
describe("interrupted deploy recovery drill", () => {
  for (const recovery of ["release", "expiry"] as const) {
    it(`recovers a half-applied stage (lease ${recovery}) without replacing persistent resources`, async () => {
      const report = await runFailedDeployDrill(await memoryBackend(), { recovery });
      expect(report.secondWriterBlocked).toBe(true);
      expect(report.resumePlan.filter((s) => s.op === "resume")).toHaveLength(1);
      expect(report.resumePlan.filter((s) => s.op === "create")).toHaveLength(
        DRILL_MANIFEST.length - report.crashedAfter,
      );
      expect(report.replacements).toEqual([]);
      expect(report.idsKept).toBe(true);
      expect(report.converged).toBe(true);
      expect(report.finalPlanNoop).toBe(true);
      expect(drillPassed(report)).toBe(true);
    });
  }

  it("the planner flags a persistent-resource replacement, so the drill can fail", async () => {
    const b = await memoryBackend();
    let n = 0;
    await applyPlan(b, "staging", DRILL_MANIFEST, await planDeploy(b, "staging", DRILL_MANIFEST), {
      newId: () => `id-${++n}`,
    });

    const changed = DRILL_MANIFEST.map((r) =>
      r.fqn === "Storage/Directory" ? { ...r, type: "Cloudflare.D1.DatabaseV2" } : r,
    );

    const plan = await planDeploy(b, "staging", changed);
    expect(plan.find((s) => s.fqn === "Storage/Directory")?.op).toBe("replace");
  });
});
