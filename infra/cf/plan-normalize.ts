import { Predicate, Schema } from "effect";
import { decode } from "./schemas.ts";
import { createHash } from "node:crypto";
import type { ExportedPlan } from "../policies/plan-normalize.ts";
import type { Plan } from "../policies/plan-policy.ts";

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

/** JSON schema validation precedes recursive key sorting; array order is meaningful. */
export const canonical = <T>(value: T): string => {
  const visit = (input: JsonValue): JsonValue => {
    if (
      input === null ||
      Predicate.isString(input) ||
      Predicate.isBoolean(input) ||
      Predicate.isNumber(input)
    )
      return input;

    if (Array.isArray(input)) return input.map(visit);

    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, visit(item)]),
    );
  };

  return JSON.stringify(visit(decode(Schema.Json, value)));
};

export const digest = <T>(value: T): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const canonicalPlan = (plan: Plan): string =>
  canonical({
    ...plan,
    entries: plan.entries
      .map((entry) => ({
        ...entry,
        bindings: [...(entry.bindings ?? [])].sort(),
        references: [...(entry.references ?? [])].sort((a, b) =>
          canonical(a).localeCompare(canonical(b)),
        ),
      }))
      .sort((a, b) =>
        `${a.stage}/${a.type}/${a.logicalId}`.localeCompare(`${b.stage}/${b.type}/${b.logicalId}`),
      ),
  });

/** Temporary onboarding/CI adapter; domains remain visible to the hostname approval gate. */
export const exportPlan = (
  plan: Plan,
  domains: Readonly<Record<string, ReadonlyArray<string>>> = {},
): ExportedPlan => ({
  format: "bye.plan-export.v1",
  stack: plan.stack,
  stage: plan.stage,
  operation: "deploy",
  rows: plan.entries
    .map((entry) => ({
      fqn: `${plan.stack}/${entry.stage}/${entry.logicalId}`,
      logicalId: entry.logicalId,
      resourceType: entry.type,
      action: entry.action,
      envBindings: entry.bindings ?? [],
      domains: domains[entry.logicalId] ?? [],
    }))
    .sort((a, b) => a.fqn.localeCompare(b.fqn)),
});
