// Adapter: Alchemy's real plan (alchemy/Alchemist `Stack.plan` → `PlanSnapshot`) → the
// normalized `Plan` evaluated by plan-policy.ts (§15.6 "review desired state"). Pure and
// tested; infra/policies/plan-export.ts runs Alchemy and feeds this.
import type { Plan, PlanAction, PlanEntry } from "./plan-policy.ts";

/** Serializable subset of an Alchemy plan row plus the Worker env binding names we extract. */
export interface ExportedPlanRow {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly action: "create" | "update" | "adopted" | "replace" | "delete" | "orphaned" | "noop";
  /** Worker `env` keys (binding names) from the planned props, when the row is a Worker. */
  readonly envBindings?: ReadonlyArray<string>;
  /** Hostnames the row attaches (Worker `domain`/`routes`, or a custom-domain row's hostname). */
  readonly domains?: ReadonlyArray<string>;
}

export interface ExportedPlan {
  readonly format: "bye.plan-export.v1";
  readonly stack: string;
  readonly stage: string;
  readonly operation: "deploy" | "destroy";
  readonly deploymentEngine?: "cf";
  readonly cfApprovalDigest?: string;
  readonly rows: ReadonlyArray<ExportedPlanRow>;
}

/**
 * Alchemy type strings that differ from the inventory's canonical names. Without this, a real
 * D1 deletion (`Cloudflare.D1Database`) would bypass the protected-type check.
 */
export const TYPE_ALIASES = new Map([
  ["Cloudflare.D1Database", "Cloudflare.D1.Database"],
  ["Cloudflare.Ruleset.Ruleset", "Cloudflare.Ruleset"],
]);

const ACTIONS: Readonly<Record<ExportedPlanRow["action"], PlanAction>> = {
  create: "create",
  update: "update",
  adopted: "update",
  replace: "replace",
  delete: "delete",
  orphaned: "delete",
  noop: "noop",
};

export const normalizePlan = (exported: ExportedPlan): Plan => {
  if (exported.format !== "bye.plan-export.v1")
    throw new Error(`unsupported plan export format ${String(exported.format)}`);

  const entries: Array<PlanEntry> = exported.rows.map((row) => {
    let entry: PlanEntry = {
      logicalId: row.logicalId,
      type: TYPE_ALIASES.get(row.resourceType) ?? row.resourceType,
      action: ACTIONS[row.action],
      // A plan computed for a stage only contains that stage's state rows.
      stage: exported.stage,
    };

    if (row.envBindings) entry = { ...entry, bindings: [...row.envBindings].sort() };

    return entry;
  });

  return { stack: exported.stack, stage: exported.stage, entries };
};

/** Stable digest input: rows sorted by FQN so plan artifacts compare byte-for-byte. */
export const canonicalPlan = (exported: ExportedPlan): string =>
  JSON.stringify({
    ...exported,
    rows: [...exported.rows].sort((a, b) => a.fqn.localeCompare(b.fqn)),
  });

/** Resource identity map recorded per release (§15.6 "resource identity manifest"). */
export const resourceIdentities = (
  exported: ExportedPlan,
): ReadonlyArray<{ readonly fqn: string; readonly logicalId: string; readonly type: string }> =>
  [...exported.rows]
    .flatMap((r) =>
      r.action !== "delete" && r.action !== "orphaned"
        ? [
            {
              fqn: r.fqn,
              logicalId: r.logicalId,
              type: TYPE_ALIASES.get(r.resourceType) ?? r.resourceType,
            },
          ]
        : [],
    )
    .sort((a, b) => a.fqn.localeCompare(b.fqn));

/**
 * Two-clean-deploy gate (§15.10 completion, §13 Alchemy row): the plan computed after a deploy
 * of the same commit must contain only noop/update — nothing created, replaced or deleted.
 */
export const steadyStateViolations = (plan: Plan): ReadonlyArray<string> =>
  plan.entries
    .filter((e) => e.action !== "noop" && e.action !== "update")
    .map((e) => `${e.action} ${e.type} ${e.logicalId}`);

/** Drift check (weekly, deployed stages): the plan of the deployed commit must be all noop. */
export const driftViolations = (plan: Plan): ReadonlyArray<string> =>
  plan.entries
    .filter((e) => e.action !== "noop")
    .map((e) => `drift: ${e.action} ${e.type} ${e.logicalId}`);

/**
 * Preview destruction review (§15.8): a destroy plan may only delete resources of its own
 * ephemeral stage and never touches shared/foundation resource types.
 */
export const destroyPlanViolations = (
  plan: Plan,
  foundationTypes: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const violations: Array<string> = [];

  if (!/^(preview-\d+|dev-[a-z0-9]{4,32})$/.test(plan.stage))
    violations.push(`destroy is only reviewed for preview/dev stages, not ${plan.stage}`);

  for (const e of plan.entries) {
    if (e.stage !== plan.stage) violations.push(`${e.logicalId} belongs to ${e.stage}`);

    if (foundationTypes.has(e.type))
      violations.push(`${e.logicalId} (${e.type}) is foundation-owned`);

    if (e.action !== "delete" && e.action !== "noop")
      violations.push(`unexpected ${e.action} of ${e.logicalId} in a destroy plan`);
  }

  return violations;
};
