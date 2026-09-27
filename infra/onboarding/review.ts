// Plan review and approval (spec.md §15.11 step 3, "Plan approval and deployment writes";
// infra/onboarding/spec.md §6–§7). Pure: turns the real Alchemy plan export into what is approved,
// applies the existing plan policy plus onboarding's hard limits (no DNS, MX, Email Routing or
// catch-all changes; the only custom domain is MailCore's chosen Bye hostname), decides whether a
// plan is a standard first install that the "Create Bye" intent may approve by policy, and whether
// an earlier approval still covers a freshly computed plan.
import { createHash } from "node:crypto";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import { classifyStage } from "../resources/stage.ts";
import { type ExportedPlan, normalizePlan } from "../policies/plan-normalize.ts";
import { evaluatePlan, formatViolation } from "../policies/plan-policy.ts";
import { coverageGaps, ONBOARDING_SCOPES, type ScopeGrant } from "./scopes.ts";
import type {
  ApprovalSubject,
  InstallIntent,
  Installation,
  PlannedAction,
  ReleaseRef,
} from "./store.ts";

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

/**
 * Custom-domain resource types the pinned Alchemy release may emit for MailCore's `domain`. In
 * alchemy 2.0.0-beta.79 the custom domain is part of the MailCore Worker row itself; a release
 * that splits it into its own row may use only these types, only for MailCore, and only on an
 * installation with a chosen Bye hostname. The hostname itself is checked per row by
 * `domainProblems` (from the plan export's `domains`), and APP_DOMAIN is part of the config
 * digest. Everything else in `isProhibited` stays blocked.
 */
export const PERMITTED_CUSTOM_DOMAIN_TYPES: ReadonlySet<string> = new Set([
  "Cloudflare.Workers.CustomDomain",
]);

const MAILCORE = /^MailCore(?:[./-]|$)/;

export const isPermittedCustomDomain = (
  action: Pick<PlannedAction, "type" | "logicalId" | "action">,
  installation: Pick<Installation, "appHostname">,
): boolean =>
  PERMITTED_CUSTOM_DOMAIN_TYPES.has(action.type) &&
  (action.action === "create" || action.action === "update") &&
  MAILCORE.test(action.logicalId) &&
  !!installation.appHostname;

/**
 * Rows that attach any hostname other than the installation's chosen Bye hostname, or attach it
 * to anything but MailCore. A row with no recorded hostnames (older plan exports) is judged by
 * type alone.
 */
export const domainProblems = (
  exported: ExportedPlan,
  installation: Pick<Installation, "appHostname">,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  for (const r of exported.rows) {
    if (!r.domains || r.domains.length === 0 || r.action === "noop") continue;
    const ok =
      !!installation.appHostname &&
      MAILCORE.test(r.logicalId) &&
      r.domains.every((d) => d === installation.appHostname);
    if (!ok)
      problems.push(
        `${r.logicalId} would attach ${r.domains.join(", ")}; onboarding attaches only ${installation.appHostname ?? "no hostname"} to MailCore`,
      );
  }
  return problems;
};

/** Stages an onboarding installation may bind: production-like `prod`/`staging`, or a `dev-*` trial. */
export const allowedStage = (stage: string): string | null => {
  const c = classifyStage(stage);
  if (c._tag === "Invalid") return c.reason;
  if (c.stage.class === "preview") return "preview stages belong to CI pull-request previews";
  return null;
};

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export const canonical = (value: unknown): string =>
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
  /** Scope matrix (default: ONBOARDING_SCOPES); injectable so tests can model verified scopes. */
  readonly scopeMatrix?: ReadonlyArray<ScopeGrant>;
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
  blockers.push(...domainProblems(exported, installation));
  for (const a of actions)
    if (isProhibited(a.type) && !isPermittedCustomDomain(a, installation))
      blockers.push(
        `${a.action} of ${a.type} ${a.logicalId} is outside onboarding (DNS, MX and Email Routing change only through incoming-email activation)`,
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
    input.scopeMatrix ?? ONBOARDING_SCOPES,
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

/**
 * The reviewed resource graph of a standard first install: every plan resource type a clean
 * onboarding deploy of this repository creates. A type outside it (even as a `create`) sends the
 * plan to review. `infra/tests/onboarding.test.ts` fails when the inventory's stack-created types
 * change without this list being reviewed.
 */
export const STANDARD_FIRST_INSTALL_TYPES: ReadonlySet<string> = new Set([
  "Cloudflare.Worker",
  "Cloudflare.DurableObject",
  "Cloudflare.Workflow",
  "Cloudflare.Email.SendEmail",
  "Cloudflare.RateLimit",
  "Cloudflare.KV.Namespace",
  "Cloudflare.D1.Database",
  "Cloudflare.R2.Bucket",
  "Cloudflare.Queues.Queue",
  "Cloudflare.Queues.Consumer",
  "Cloudflare.Container",
  "Cloudflare.StateStore",
  ...PERMITTED_CUSTOM_DOMAIN_TYPES,
]);

export interface AutoApprovalInput {
  readonly installation: Installation;
  readonly intent: InstallIntent;
  readonly review: ReviewOutcome;
  /** Release now resolved from the pinned checkout. */
  readonly release: ReleaseRef;
  /** Every migration the pinned release ships (a first install applies all of them). */
  readonly releaseMigrations: ReadonlyArray<string>;
}

/**
 * Why a plan is NOT a standard clean first install that the "Create Bye" intent may approve by
 * policy (infra/onboarding/spec.md §6). Empty = auto-approve. Any reason puts the install in
 * `needs-review`, where the operator sees the full review.
 */
export const autoApprovalBlockers = (input: AutoApprovalInput): ReadonlyArray<string> => {
  const { installation: inst, intent, review } = input;
  const reasons: Array<string> = [];
  if (inst.firstWriteAt !== null) reasons.push("not a first deployment");
  if (review.blockers.length > 0) reasons.push(`${review.blockers.length} review blockers`);
  if (inst.stage !== "prod" || review.subject.stage !== intent.stage)
    reasons.push("not the standard prod installation");
  if (
    inst.accountId !== intent.accountId ||
    review.subject.accountId !== intent.accountId ||
    (inst.zoneId ?? null) !== intent.zoneId ||
    (inst.zoneName ?? null) !== intent.zoneName ||
    (inst.appHostname ?? null) !== intent.appHostname
  )
    reasons.push("account, zone or hostname differs from the install intent");
  if (canonical(input.release) !== canonical(intent.release))
    reasons.push("the pinned release differs from the install intent");
  if (canonical(review.subject.release) !== canonical(intent.release))
    reasons.push("the plan's release differs from the install intent");
  if (review.subject.actions.length === 0) reasons.push("the plan has no changes");
  for (const a of review.subject.actions) {
    if (a.action !== "create") reasons.push(`${a.action} of ${a.type} ${a.logicalId}`);
    if (!STANDARD_FIRST_INSTALL_TYPES.has(a.type))
      reasons.push(`${a.type} ${a.logicalId} is not in the standard first-install graph`);
    else if (isProhibited(a.type) && !isPermittedCustomDomain(a, inst))
      reasons.push(`${a.type} ${a.logicalId} is not the chosen Bye hostname`);
  }
  const expected = [...input.releaseMigrations].sort();
  const planned = [...review.subject.migrations].sort();
  if (canonical(expected) !== canonical(planned))
    reasons.push("migrations differ from the pinned first-install release");
  return reasons;
};
