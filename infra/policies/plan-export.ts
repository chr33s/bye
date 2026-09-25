// Produce a normalized, reviewable plan from the REAL Alchemy engine (not a hand-made file).
// The CLI's `plan` only renders to a terminal, so this runs alchemy/Alchemist `Stack.plan`
// programmatically with the same stack entrypoint, stage and profile as `alchemy deploy`.
//
// Usage: STAGE=<stage> node --experimental-strip-types infra/policies/plan-export.ts <out-dir> [deploy|destroy]
// Writes <out-dir>/plan-export.json (Alchemy rows) and <out-dir>/plan.json (normalized Plan).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import * as Alchemist from "alchemy/Alchemist";
import {
  canonicalPlan,
  type ExportedPlan,
  type ExportedPlanRow,
  normalizePlan,
} from "./plan-normalize.ts";
import { missingTelemetryOptOuts } from "./telemetry.ts";

const envKeysOf = (node: unknown): ReadonlyArray<string> | undefined => {
  const props = (node as { props?: { env?: unknown } }).props;
  return props && typeof props.env === "object" && props.env !== null
    ? Object.keys(props.env as object)
    : undefined;
};

export const exportPlan = async (
  stage: string,
  operation: "deploy" | "destroy",
  entrypoint = "alchemy.run.ts",
): Promise<ExportedPlan> => {
  const snapshot = await Effect.runPromise(
    Alchemist.Stack.plan({ target: { entrypoint, stage }, operation }).pipe(
      Effect.provide(Alchemist.layer()),
      Effect.scoped,
    ) as Effect.Effect<Alchemist.Stack.PlanSnapshot>,
  );
  const nodes = snapshot.native.resources as Record<string, { resource: { Type: string } }>;
  const rows: Array<ExportedPlanRow> = snapshot.resources.map((r) => {
    const node = nodes[r.fqn];
    const envBindings =
      r.resourceType === "Cloudflare.Worker" && node ? envKeysOf(node) : undefined;
    return {
      fqn: r.fqn,
      logicalId: r.logicalId,
      resourceType: r.resourceType,
      action: r.action,
      ...(envBindings ? { envBindings } : {}),
    };
  });
  return {
    format: "bye.plan-export.v1",
    stack: snapshot.stack.name,
    stage: snapshot.stack.stage,
    operation,
    rows,
  };
};

if (import.meta.main) {
  const [out = "plan-out", op = "deploy"] = process.argv.slice(2);
  const stage = process.env.STAGE ?? "";
  const missing = missingTelemetryOptOuts(process.env);
  if (missing.length) {
    console.error(`plan-export: set ${missing.join(", ")}`);
    process.exit(1);
  }
  const exported = await exportPlan(stage, op === "destroy" ? "destroy" : "deploy");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan-export.json"), canonicalPlan(exported));
  writeFileSync(join(out, "plan.json"), JSON.stringify(normalizePlan(exported), null, 2));
  console.log(
    `plan-export: ${exported.rows.length} rows for ${exported.stack}/${exported.stage} → ${out}`,
  );
}
