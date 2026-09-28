// Produce a normalized, reviewable plan from the REAL Alchemy engine (not a hand-made file).
// The CLI's `plan` only renders to a terminal, so this runs alchemy/Alchemist `Stack.plan`
// programmatically with the same stack entrypoint, stage and profile as `alchemy deploy`.
//
// Usage: STAGE=<stage> node --experimental-strip-types infra/policies/plan-export.ts <out-dir> [deploy|destroy]
// Writes <out-dir>/plan-export.json (Alchemy rows) and <out-dir>/plan.json (normalized Plan).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, flow, Option, Schema } from "effect";
import * as Alchemist from "alchemy/Alchemist";
import {
  canonicalPlan,
  type ExportedPlan,
  type ExportedPlanRow,
  normalizePlan,
} from "./plan-normalize.ts";
import { missingTelemetryOptOuts } from "./telemetry.ts";

const PlanNode = Schema.Struct({
  props: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

type PlanNode = typeof PlanNode.Type;

const decodePlanNode = Schema.decodeUnknownOption(PlanNode);

const EnvProps = Schema.Struct({ env: Schema.optional(Schema.ObjectKeyword) });

const decodeEnvProps = Schema.decodeUnknownOption(EnvProps);

const DomainProps = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  aliases: Schema.optional(Schema.Unknown),
  redirects: Schema.optional(Schema.Unknown),
});

const decodeDomainProps = Schema.decodeUnknownOption(DomainProps);

const RouteProps = Schema.Struct({ pattern: Schema.optional(Schema.Unknown) });

const decodeRouteProps = Schema.decodeUnknownOption(RouteProps);

const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const isText = Schema.is(Schema.NonEmptyString);

const routeItems = flow(
  decodeList,
  Option.getOrElse((): ReadonlyArray<unknown> => []),
);

const text = flow(decodeText, Option.toArray);

const texts = flow(
  decodeList,
  Option.map((items) => items.flatMap((item) => text(item))),
  Option.getOrElse((): Array<string> => []),
);

const envKeysOf = (node: PlanNode): ReadonlyArray<string> | undefined =>
  Option.match(decodeEnvProps(node.props), {
    onNone: () => undefined,
    onSome: ({ env }) => (env === undefined ? undefined : Object.keys(env)),
  });

/**
 * Hostnames a row attaches: a Worker's `domain` (canonical name, aliases, redirects) and `routes`
 * patterns, or a custom-domain resource's own hostname. Onboarding review checks them against
 * the installation's chosen Bye hostname.
 */
export const domainsOf = (node: PlanNode, type: string): ReadonlyArray<string> | undefined => {
  const props = node.props;

  if (!props) return undefined;
  const out: Array<string> = [];

  if (type === "Cloudflare.Worker") {
    const d = props.domain;

    if (isText(d)) out.push(d);
    else {
      const c = Option.getOrUndefined(decodeDomainProps(d));

      if (c) out.push(...text(c.name), ...texts(c.aliases), ...texts(c.redirects));
    }

    for (const r of routeItems(props.routes))
      out.push(...(isText(r) ? [r] : text(Option.getOrUndefined(decodeRouteProps(r))?.pattern)));
  } else if (/customdomain|route/i.test(type))
    out.push(...text(props.hostname), ...text(props.name), ...text(props.pattern));

  return out.length > 0 ? out.map((h) => h.toLowerCase()) : undefined;
};

export interface PlanRequest {
  readonly target: { readonly entrypoint: string; readonly stage: string };
  readonly operation: "deploy" | "destroy";
}

/** Runs the engine plan for a request; injectable so tests can supply a fixed snapshot. */
export type PlanRunner = (request: PlanRequest) => Effect.Effect<Alchemist.Stack.PlanSnapshot>;

const alchemistPlan: PlanRunner = (request) =>
  Alchemist.Stack.plan(request).pipe(
    Effect.provide(Alchemist.layer()),
    Effect.scoped,
  ) as Effect.Effect<Alchemist.Stack.PlanSnapshot>;

export const exportPlan = async (
  stage: string,
  operation: "deploy" | "destroy",
  entrypoint = "alchemy.run.ts",
  runPlan: PlanRunner = alchemistPlan,
): Promise<ExportedPlan> => {
  const snapshot = await Effect.runPromise(runPlan({ target: { entrypoint, stage }, operation }));

  const nodes = snapshot.native.resources;

  const rows: Array<ExportedPlanRow> = snapshot.resources.map((r) => {
    const node = Option.getOrUndefined(decodePlanNode(nodes[r.fqn]));

    const envBindings =
      r.resourceType === "Cloudflare.Worker" && node ? envKeysOf(node) : undefined;

    const domains = node ? domainsOf(node, r.resourceType) : undefined;

    let planRow: ExportedPlanRow = {
      fqn: r.fqn,
      logicalId: r.logicalId,
      resourceType: r.resourceType,
      action: r.action,
    };

    if (envBindings) planRow = { ...planRow, envBindings };

    if (domains) planRow = { ...planRow, domains };

    return planRow;
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
