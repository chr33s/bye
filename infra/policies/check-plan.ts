// Usage: node --experimental-strip-types infra/policies/check-plan.ts [--mode deploy|steady|destroy|drift] <plan-export.json|plan.json>
//   deploy  (default) — plan-policy review: protected destruction, stage isolation, bindings.
//   steady  — second deploy of the same commit: only noop/update allowed (§15.10 completion).
//   destroy — preview/dev teardown: only own-stage deletions, never foundation types (§15.8).
//   drift   — scheduled drift check of a deployed stage: any non-noop entry means the declared
//             stack and the live stage disagree (.github/workflows/drift.yml).
// Accepts the raw Alchemy export produced by plan-export.ts (preferred) or a normalized Plan.
import { readFileSync } from "node:fs";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import {
  destroyPlanViolations,
  driftViolations,
  type ExportedPlan,
  normalizePlan,
  steadyStateViolations,
} from "./plan-normalize.ts";
import {
  type DecommissionRecord,
  evaluatePlan,
  formatViolation,
  type Plan,
} from "./plan-policy.ts";
import { missingTelemetryOptOuts } from "./telemetry.ts";

export const FOUNDATION_TYPES: ReadonlySet<string> = new Set([
  "Cloudflare.StateStore",
  "Cloudflare.Ruleset",
  "Cloudflare.Zone.Zone",
]);

export const loadPlan = (raw: unknown): Plan =>
  (raw as { format?: string }).format === "bye.plan-export.v1"
    ? normalizePlan(raw as ExportedPlan)
    : (raw as Plan);

export const checkPlan = (
  mode: string,
  plan: Plan,
  decommissions: ReadonlyArray<DecommissionRecord>,
): ReadonlyArray<string> => {
  if (mode === "steady") return steadyStateViolations(plan);
  if (mode === "destroy") return destroyPlanViolations(plan, FOUNDATION_TYPES);
  if (mode === "drift") return driftViolations(plan);
  return evaluatePlan({ plan, decommissions, privateBindings: PRIVATE_BINDINGS }).violations.map(
    formatViolation,
  );
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const modeIndex = args.indexOf("--mode");
  const mode = modeIndex >= 0 ? (args[modeIndex + 1] ?? "deploy") : "deploy";
  const path = args.filter((_, i) => i !== modeIndex && i !== modeIndex + 1)[0];
  if (path === undefined) {
    console.error(
      "usage: check-plan.ts [--mode deploy|steady|destroy|drift] <plan-export.json|plan.json>",
    );
    process.exit(2);
  }
  const plan = loadPlan(JSON.parse(readFileSync(path, "utf8")));
  const decommissions = JSON.parse(
    readFileSync(`${import.meta.dirname}/decommissions.json`, "utf8"),
  ) as ReadonlyArray<DecommissionRecord>;
  const violations = [
    ...checkPlan(mode, plan, decommissions),
    ...missingTelemetryOptOuts(process.env).map((k) => `deploy environment must set ${k}`),
  ];
  for (const v of violations) console.error(`policy(${mode}): ${v}`);
  if (violations.length > 0) process.exit(1);
  console.log(
    `plan ${mode} check for ${plan.stack}/${plan.stage}: ${plan.entries.length} entries, passed`,
  );
}
