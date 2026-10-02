import type { Plan } from "../policies/plan-policy.ts";
import { canonical } from "./plan-normalize.ts";
import { writeJson, type OperationRunner } from "./operations.ts";
import type { Resource } from "./schemas.ts";

export const ACCOUNT_SETTINGS_TYPES = new Set(["Cloudflare.R2.Bucket"]);

/** Only settings represented in an approved row can reach the API. Public custom domains are never removed implicitly. */
export const reconcile = async (input: {
  readonly plan: Plan;
  readonly desired: ReadonlyArray<Resource>;
  readonly runner: OperationRunner;
  readonly beforeWrite: () => Promise<void>;
}): Promise<void> => {
  for (const entry of input.plan.entries) {
    if (!["create", "update"].includes(entry.action) || !ACCOUNT_SETTINGS_TYPES.has(entry.type))
      continue;

    const resource = input.desired.find(
      (r) => r.logicalId === entry.logicalId && r.type === entry.type && r.stage === entry.stage,
    );

    if (
      !resource?.identity.name ||
      resource.settings.publicAccess !== false ||
      !Array.isArray(resource.settings.lifecycleRules)
    )
      throw new Error("invalid approved R2 settings");
  }

  for (const entry of input.plan.entries) {
    if (!["create", "update"].includes(entry.action) || !ACCOUNT_SETTINGS_TYPES.has(entry.type))
      continue;

    const resource = input.desired.find(
      (r) => r.logicalId === entry.logicalId && r.type === entry.type && r.stage === entry.stage,
    )!;

    await input.beforeWrite();
    await writeJson(input.runner, [
      "r2",
      "buckets",
      "domains",
      "managed",
      "update",
      resource.identity.name!,
      "--enabled",
      "false",
    ]);
    await input.beforeWrite();
    await writeJson(input.runner, [
      "r2",
      "buckets",
      "lifecycle",
      "update",
      resource.identity.name!,
      "--rules",
      canonical(resource.settings.lifecycleRules),
    ]);
  }
};
