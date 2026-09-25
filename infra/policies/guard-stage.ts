// Usage: guard-stage.ts <deploy|destroy> <stage>
// Refuses invalid stage names and any destroy outside preview/dev stages (§15.6: never run
// unconditional production destroy). Preview cleanup still reviews the deletion set.
import { classifyStage } from "../resources/stage.ts";
import { missingTelemetryOptOuts } from "./telemetry.ts";

export const guard = (
  op: string,
  stageName: string,
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const result = classifyStage(stageName);
  if (result._tag === "Invalid") errors.push(result.reason);
  else if (op === "destroy" && result.stage.persistent)
    errors.push(`refusing to destroy persistent stage ${stageName}`);
  if (op !== "deploy" && op !== "destroy" && op !== "plan") errors.push(`unknown operation ${op}`);
  for (const k of missingTelemetryOptOuts(env)) errors.push(`set ${k} before running alchemy`);
  // Shared stages have exactly one serialized writer: the CI deploy job (§15.6), or — for a
  // self-hosted installation in the operator's own account — the onboarding service, which
  // serializes writes per installation and verifies the approved plan first (infra/onboarding).
  // Local deploys to staging or prod are refused even with valid credentials.
  if (
    result._tag === "Valid" &&
    (result.stage.class === "prod" || result.stage.class === "staging") &&
    op === "deploy" &&
    env.CI !== "true" &&
    env.BYE_DEPLOY_WRITER !== "onboarding"
  ) {
    errors.push(
      `${result.stage.class} deploys run only from CI or the onboarding service (one serialized writer per shared stage)`,
    );
  }
  if (
    result._tag === "Valid" &&
    result.stage.class === "prod" &&
    op === "deploy" &&
    env.BYE_RELEASE_MANIFEST_VERIFIED !== "1"
  ) {
    errors.push(
      "production deploys require a verified release manifest (release-manifest.ts verify)",
    );
  }
  return errors;
};

if (import.meta.main) {
  const [op = "", stage = ""] = process.argv.slice(2);
  const errors = guard(op, stage, process.env);
  for (const e of errors) console.error(`guard: ${e}`);
  if (errors.length > 0) process.exit(1);
}
