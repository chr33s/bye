import { Schema } from "effect";
import type { DecommissionRecord, Plan, PlanAction, PlanEntry } from "../policies/plan-policy.ts";
import { evaluatePlan, formatViolation } from "../policies/plan-policy.ts";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import { requireStage } from "../resources/stage.ts";
import { protectedType } from "./inventory.ts";
import { canonical } from "./plan-normalize.ts";
import {
  assertBoundary,
  assertNoSecrets,
  decode,
  Adoption,
  Snapshot,
  JsonObject,
  type Resource,
} from "./schemas.ts";

const key = (resource: Resource): string =>
  `${resource.stage}/${resource.type}/${resource.logicalId}`;

const unique = (resources: ReadonlyArray<Resource>): Map<string, Resource> => {
  const result = new Map<string, Resource>();
  const identities = new Set<string>();

  for (const resource of resources) {
    const physical = `${resource.type}/${canonical(resource.identity)}`;

    if (result.has(key(resource)) || identities.has(physical))
      throw new Error(`ambiguous resource ownership for ${resource.logicalId}`);
    result.set(key(resource), resource);
    identities.add(physical);
  }

  return result;
};

export interface PlanInput {
  readonly stage: string;
  readonly accountId: string;
  readonly desired: ReadonlyArray<Resource>;
  readonly discovery: Snapshot;
  readonly adoption?: Adoption;
  readonly decommissions?: ReadonlyArray<DecommissionRecord>;
}

/** A read failure, incomplete discovery, or ambiguous identity stops planning entirely. */
export const planResources = (input: PlanInput): Plan => {
  const stage = requireStage(input.stage);
  const snapshot = decode(Snapshot, input.discovery);
  assertBoundary(snapshot, input.stage, input.accountId);
  assertNoSecrets(snapshot);
  assertNoSecrets(input.desired);

  if (snapshot.blockers.length)
    throw new Error(`discovery blocked: ${snapshot.blockers.join("; ")}`);
  const adoption = input.adoption ? decode(Adoption, input.adoption) : undefined;

  if (adoption) {
    assertBoundary(adoption, input.stage, input.accountId);
    assertNoSecrets(adoption);
  }

  const desired = unique(input.desired);
  const live = unique(snapshot.resources);
  const adopted = unique(adoption?.resources ?? []);
  const entries: Array<PlanEntry> = [];

  for (const [id, wanted] of desired) {
    const current = live.get(id);
    const original = adopted.get(id);

    let action: PlanAction =
      current === undefined
        ? "create"
        : canonical(current.identity) !== canonical(wanted.identity)
          ? "replace"
          : canonical(current.settings) !== canonical(wanted.settings) ||
              canonical([...(current.bindings ?? [])].sort()) !==
                canonical([...(wanted.bindings ?? [])].sort()) ||
              canonical(current.references ?? []) !== canonical(wanted.references ?? [])
            ? "update"
            : "noop";

    if (
      original &&
      (canonical(original.identity) !== canonical(wanted.identity) ||
        !current ||
        canonical(original.identity) !== canonical(current.identity))
    )
      action = "replace";

    if (stage.persistent && current && wanted.type === "Cloudflare.Worker") {
      for (const field of ["domains", "triggers"] as const) {
        const before = current.settings[field];
        const after = wanted.settings[field];

        if (
          Array.isArray(before) &&
          before.some(
            (value) =>
              !Array.isArray(after) || !after.some((next) => canonical(value) === canonical(next)),
          )
        )
          throw new Error(
            `persistent Worker ${wanted.logicalId} removes/changes ${field}; a reviewed lifecycle migration is required`,
          );
      }

      const before = current.settings.exports;
      const after = wanted.settings.exports;

      if (
        before &&
        Schema.is(JsonObject)(before) &&
        !Array.isArray(before) &&
        Object.keys(before).some(
          (name) => !after || !Schema.is(JsonObject)(after) || !(name in after),
        )
      )
        throw new Error(`persistent Worker ${wanted.logicalId} removes an export`);
    }

    entries.push({
      logicalId: wanted.logicalId,
      type: wanted.type,
      action,
      stage: wanted.stage,
      bindings: wanted.bindings ?? [],
      references: wanted.references ?? [],
    });
  }

  // Discovery includes only proven Bye-owned resources. Unowned resources never reach this list.
  for (const [id, current] of live)
    if (!desired.has(id))
      entries.push({
        logicalId: current.logicalId,
        type: current.type,
        stage: current.stage,
        action: "delete",
      });

  const plan: Plan = {
    stack: "MailboxPlatform",
    stage: input.stage,
    entries: entries.sort((a, b) =>
      `${a.type}/${a.logicalId}`.localeCompare(`${b.type}/${b.logicalId}`),
    ),
  };

  const violations = evaluatePlan({
    plan,
    privateBindings: PRIVATE_BINDINGS,
    decommissions: input.decommissions ?? [],
  }).violations.map(formatViolation);

  for (const entry of plan.entries) {
    if (
      adopted.has(`${entry.stage}/${entry.type}/${entry.logicalId}`) &&
      protectedType(entry.type) &&
      !["noop", "update"].includes(entry.action)
    )
      violations.push(
        `${entry.action} of adopted protected identity ${entry.logicalId} blocks cutover`,
      );

    if (
      stage.persistent &&
      protectedType(entry.type) &&
      ["delete", "replace"].includes(entry.action) &&
      !input.decommissions?.some(
        (record) =>
          record.stage === input.stage &&
          record.logicalId === entry.logicalId &&
          record.action === entry.action &&
          record.approvedBy.trim() &&
          record.ticket.trim(),
      )
    )
      violations.push(`${entry.action} of ${entry.logicalId} requires decommission approval`);
  }

  if (violations.length) throw new Error(`plan rejected: ${[...new Set(violations)].join("; ")}`);

  return plan;
};
