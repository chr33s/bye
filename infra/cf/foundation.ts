import { Schema } from "effect";
import { canonical, digest } from "./plan-normalize.ts";
import { record, rows, stringField } from "./discover.ts";
import { decode, assertNoSecrets } from "./schemas.ts";
import { writeJson, type CloudflareOperations } from "./operations.ts";

export interface OwnedRule {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly rulesetId: string;
  readonly ruleId: string;
  readonly reference: string;
  readonly phase: "http_request_firewall_custom" | "http_ratelimit";
  readonly settings: Schema.Schema.Type<typeof Schema.Json>;
}

export interface FoundationChange {
  readonly rule: OwnedRule;
  readonly action: "noop" | "update";
  readonly live: Schema.Schema.Type<typeof Schema.Json>;
}

/** Explicit adopted rule IDs/references constrain ownership; never replace a zone's entire ruleset. */
export const foundationPlan = async (
  operations: CloudflareOperations,
  desired: ReadonlyArray<OwnedRule>,
): Promise<ReadonlyArray<FoundationChange>> => {
  const changes: Array<FoundationChange> = [];
  const seen = new Set<string>();

  for (const rule of desired) {
    if (!rule.reference.startsWith("bye-") || !rule.ruleId || !rule.rulesetId || !rule.zoneId)
      throw new Error("foundation requires reviewed Bye rule identities");
    const key = `${rule.zoneId}/${rule.rulesetId}/${rule.ruleId}`;

    if (seen.has(key)) throw new Error("ambiguous foundation ownership");
    seen.add(key);
    const zone = record(await operations.read.json(["zones", "get", rule.zoneId]));

    if (stringField(zone, "name") !== rule.zoneName || stringField(zone, "id") !== rule.zoneId)
      throw new Error("adopted zone identity changed");

    const ruleset = record(
      await operations.read.json([
        "rulesets",
        "account-rulesets",
        "get",
        rule.rulesetId,
        "--zone",
        rule.zoneId,
      ]),
    );

    if (ruleset.phase !== rule.phase) throw new Error("adopted ruleset phase changed");

    const matches = rows(ruleset.rules).filter(
      (item) => item.id === rule.ruleId && item.ref === rule.reference,
    );

    if (matches.length !== 1) throw new Error("owned foundation rule is missing or ambiguous");
    const wanted = record(rule.settings);

    if (
      Object.keys(wanted).some(
        (key) =>
          ![
            "action",
            "expression",
            "description",
            "enabled",
            "ratelimit",
            "action_parameters",
            "logging",
          ].includes(key),
      )
    )
      throw new Error("unreviewed foundation rule setting");

    const live = Object.fromEntries(
      Object.keys(wanted).map((key) => [key, decode(Schema.Json, matches[0]![key])]),
    );

    changes.push({ rule, action: canonical(wanted) === canonical(live) ? "noop" : "update", live });
  }

  assertNoSecrets(changes);

  return changes;
};

export const applyFoundation = async (input: {
  readonly engine: string;
  readonly desired: ReadonlyArray<OwnedRule>;
  readonly approvedDigest: string;
  readonly operations: CloudflareOperations;
  readonly beforeWrite: () => Promise<void>;
}): Promise<void> => {
  if (input.engine !== "cf") throw new Error("foundation writes require explicit opt-in");
  const changes = await foundationPlan(input.operations, input.desired);

  if (digest(changes) !== input.approvedDigest)
    throw new Error("fresh foundation plan differs from approval");

  for (const change of changes) {
    if (change.action === "noop") continue;
    await input.beforeWrite();
    const rule = change.rule;
    await writeJson(input.operations.write, [
      "rulesets",
      "account-rulesets",
      "rules",
      "update",
      rule.ruleId,
      "--ruleset-id",
      rule.rulesetId,
      "--zone",
      rule.zoneId,
      "--body",
      canonical(rule.settings),
    ]);
  }

  if (
    (await foundationPlan(input.operations, input.desired)).some(
      (change) => change.action !== "noop",
    )
  )
    throw new Error("foundation updates failed live verification");
};
