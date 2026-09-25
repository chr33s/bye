// Plan review and approval (spec.md §15.11 step 3, "Plan approval and deployment writes").
// Pure: turns the real Alchemy plan export into what the operator approves, applies the existing
// plan policy plus v1's hard limits (no DNS, MX, Email Routing or catch-all changes, no custom
// domains), and decides whether an earlier approval still covers a freshly computed plan.
import { createHash } from "node:crypto";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import { classifyStage } from "../resources/stage.ts";
import { type ExportedPlan, normalizePlan } from "../policies/plan-normalize.ts";
import { evaluatePlan, formatViolation } from "../policies/plan-policy.ts";
import { coverageGaps } from "./scopes.ts";
import type { ApprovalSubject, Installation, PlannedAction, ReleaseRef } from "./store.ts";

/**
 * Resource types v1 onboarding never changes, whatever the operator confirms. Any non-noop row of
 * these types blocks the plan (and any retry or upgrade built from it).
 */
export const PROHIBITED_TYPES: ReadonlySet<string> = new Set([
  "Cloudflare.Email.Routing",
  "Cloudflare.Email.CatchAll",
  "Cloudflare.Email.Rule",
  "Cloudflare.Email.Address",
  "Cloudflare.DNS.Record",
  "Cloudflare.DnsRecord",
  "Cloudflare.Zone.Zone",
  "Cloudflare.Zone",
  "Cloudflare.Ruleset",
  "Cloudflare.Workers.CustomDomain",
  "Cloudflare.Workers.Route",
  "Cloudflare.Turnstile.Widget",
]);

const PROHIBITED_PATTERN = /dns|email\.(routing|catchall|rule|address)|zone|route|customdomain/i;

export const isProhibited = (type: string): boolean =>
  PROHIBITED_TYPES.has(type) || PROHIBITED_PATTERN.test(type);

/** Stages an onboarding installation may bind: production-like `prod`/`staging`, or a `dev-*` trial. */
export const allowedStage = (stage: string): string | null => {
  const c = classifyStage(stage);
  if (c._tag === "Invalid") return c.reason;
  if (c.stage.class === "preview") return "preview stages belong to CI pull-request previews";
  return null;
};

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

export const subjectDigest = (subject: ApprovalSubject): string =>
  sha256(
    canonical({
      ...subject,
      actions: [...subject.actions].sort((a, b) => a.fqn.localeCompare(b.fqn)),
      migrations: [...subject.migrations].sort(),
    }),
  );

/** Non-secret values by value, secrets by presence only (as release-manifest.ts does). */
export const configHash = (
  config: Readonly<Record<string, string>>,
  secretNames: ReadonlyArray<string>,
): string =>
  sha256(
    Object.keys(config)
      .sort()
      .map((k) =>
        secretNames.includes(k)
          ? `${k}=${config[k] ? "<present>" : "<empty>"}`
          : `${k}=${config[k]}`,
      )
      .join("\n"),
  );

export const plannedActions = (exported: ExportedPlan): ReadonlyArray<PlannedAction> => {
  const plan = normalizePlan(exported);
  return plan.entries
    .map((e, i) => ({ ...e, fqn: exported.rows[i]!.fqn }))
    .filter((e) => e.action !== "noop")
    .map((e) => ({
      fqn: e.fqn,
      logicalId: e.logicalId,
      type: e.type,
      action: e.action as PlannedAction["action"],
    }))
    .sort((a, b) => a.fqn.localeCompare(b.fqn));
};

export interface ReviewInput {
  readonly installation: Installation;
  readonly release: ReleaseRef;
  readonly exported: ExportedPlan;
  readonly configHash: string;
  /** Migration IDs shipped by the release. */
  readonly releaseMigrations: ReadonlyArray<string>;
  /** Prerequisite failures found before planning. */
  readonly prerequisiteBlockers: ReadonlyArray<string>;
  readonly grantedScopes: ReadonlyArray<string>;
}

export interface ReviewOutcome {
  readonly subject: ApprovalSubject;
  readonly digest: string;
  readonly blockers: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly destructive: ReadonlyArray<PlannedAction>;
}

export const buildReview = (input: ReviewInput): ReviewOutcome => {
  const { installation, exported } = input;
  const blockers: Array<string> = [...input.prerequisiteBlockers];
  const warnings: Array<string> = [];
  const stage = installation.stage!;
  const classified = classifyStage(stage);
  const persistent = classified._tag === "Valid" && classified.stage.persistent;

  if (exported.operation !== "deploy") blockers.push("only deploy plans can be approved");
  if (exported.stage !== stage)
    blockers.push(`plan is for stage ${exported.stage}, installation is bound to ${stage}`);

  const plan = normalizePlan(exported);
  // Onboarding has no decommission records: approval never overrides retention policy.
  for (const v of evaluatePlan({ plan, decommissions: [], privateBindings: PRIVATE_BINDINGS })
    .violations)
    blockers.push(formatViolation(v));

  const actions = plannedActions(exported);
  for (const a of actions)
    if (isProhibited(a.type))
      blockers.push(
        `${a.action} of ${a.type} ${a.logicalId} is outside v1 onboarding (manual guide only)`,
      );

  // A first deployment only creates. Existing state for this stack/stage means another deployment
  // already owns it; onboarding does not adopt it.
  if (installation.firstWriteAt === null) {
    const existing = exported.rows.filter((r) => r.action !== "create");
    if (existing.length > 0)
      blockers.push(
        `Alchemy state already holds ${existing.length} resources for stage ${stage}; onboarding will not adopt another deployment (use the existing upgrade procedure)`,
      );
  }

  const gaps = coverageGaps(
    actions.map((a) => a.type),
    input.grantedScopes,
  );
  if (gaps.length > 0) {
    if (persistent)
      blockers.push(
        ...gaps.map((g) => `OAuth coverage: ${g} (persistent stages need verified scopes)`),
      );
    else warnings.push(...gaps.map((g) => `OAuth coverage: ${g} (allowed for a dev trial)`));
  }

  const destructive = actions.filter((a) => a.action === "replace" || a.action === "delete");
  for (const d of destructive)
    warnings.push(`${d.action} of ${d.type} ${d.logicalId} needs explicit acknowledgement`);

  const pending = input.releaseMigrations.filter(
    (m) => !installation.appliedMigrations.includes(m),
  );
  if (pending.length > 0)
    warnings.push(
      `${pending.length} forward-only migrations will apply; code rollback does not roll back data`,
    );

  const subject: ApprovalSubject = {
    installationId: installation.id,
    accountId: installation.accountId!,
    stage,
    release: input.release,
    configHash: input.configHash,
    actions,
    migrations: pending,
  };
  return { subject, digest: subjectDigest(subject), blockers, warnings, destructive };
};

/**
 * Whether an approval still covers a fresh plan. Account, stage, release, configuration and
 * migrations must match exactly. Each remaining action must be one that was approved — or, after a
 * partial apply, an approved create that now resumes as an update. Anything else needs review.
 */
export const approvalCovers = (
  approved: ApprovalSubject,
  fresh: ApprovalSubject,
): ReadonlyArray<string> => {
  const reasons: Array<string> = [];
  if (approved.installationId !== fresh.installationId) reasons.push("installation changed");
  if (approved.accountId !== fresh.accountId) reasons.push("account changed");
  if (approved.stage !== fresh.stage) reasons.push("stage changed");
  if (canonical(approved.release) !== canonical(fresh.release)) reasons.push("release changed");
  if (approved.configHash !== fresh.configHash) reasons.push("configuration changed");
  const newMigrations = fresh.migrations.filter((m) => !approved.migrations.includes(m));
  if (newMigrations.length > 0) reasons.push(`unapproved migrations: ${newMigrations.join(", ")}`);
  for (const a of fresh.actions) {
    const was = approved.actions.find((x) => x.fqn === a.fqn);
    const ok =
      was !== undefined &&
      was.type === a.type &&
      (was.action === a.action || (was.action === "create" && a.action === "update"));
    if (!ok) reasons.push(`unapproved ${a.action} of ${a.type} ${a.logicalId}`);
  }
  return reasons;
};
