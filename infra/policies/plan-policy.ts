// Desired-state review gate (§15.6, §15.10 "Review desired state"). Pure: evaluates a
// normalized plan against stage rules, the required inventory, and approved decommission
// records. Alchemy has no universal protect option we rely on; this check, restricted
// credentials, and operator approval enforce the requirement together.
import { Match, Predicate } from "effect";
import { INVENTORY, PROTECTED_TYPES, type ResourceType } from "../resources/inventory.ts";
import { classifyStage, type StageInfo } from "../resources/stage.ts";

export type PlanAction = "create" | "update" | "replace" | "delete" | "noop";

export interface ResourceRef {
  readonly stage: string;
  readonly logicalId: string;
}

export interface PlanEntry {
  readonly logicalId: string;
  readonly type: string;
  readonly action: PlanAction;
  /** Stage that owns the resource. A plan may only mutate its own stage's resources. */
  readonly stage: string;
  /** Resources this entry binds to or references (e.g. bindings, consumers). */
  readonly references?: ReadonlyArray<ResourceRef>;
  /** Binding names, for Worker entries. */
  readonly bindings?: ReadonlyArray<string>;
}

export interface Plan {
  readonly stack: string;
  readonly stage: string;
  readonly entries: ReadonlyArray<PlanEntry>;
}

export interface DecommissionRecord {
  readonly stage: string;
  readonly logicalId: string;
  readonly action: "delete" | "replace";
  readonly approvedBy: string;
  readonly ticket: string;
}

export type Violation =
  | { readonly _tag: "InvalidStage"; readonly stage: string; readonly reason: string }
  | {
      readonly _tag: "UnapprovedDestruction";
      readonly logicalId: string;
      readonly type: string;
      readonly action: PlanAction;
    }
  | { readonly _tag: "CrossStageMutation"; readonly logicalId: string; readonly ownerStage: string }
  | {
      readonly _tag: "CrossStageReference";
      readonly logicalId: string;
      readonly target: ResourceRef;
    }
  | { readonly _tag: "MissingBinding"; readonly worker: string; readonly binding: string }
  | { readonly _tag: "PrivateBindingOnPublic"; readonly worker: string; readonly binding: string }
  | { readonly _tag: "UnexpectedResourceType"; readonly logicalId: string; readonly type: string };

export interface PolicyInput {
  readonly plan: Plan;
  readonly decommissions: ReadonlyArray<DecommissionRecord>;
  /** Binding names that must never be attached to the public origin. */
  readonly privateBindings: ReadonlyArray<string>;
}

export interface PolicyResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<Violation>;
}

export const PUBLIC_WORKER = "PublicSite";

export const CORE_WORKER = "MailCore";

const requiredCoreBindings = (): ReadonlyArray<string> =>
  INVENTORY.filter(
    (e) =>
      e.owner === "stack" && e.binding !== undefined && (e.worker ?? "MailCore") === "MailCore",
  ).map((e) => e.binding as string);

const isDestructive = (action: PlanAction) => action === "delete" || action === "replace";

export const evaluatePlan = ({
  plan,
  decommissions,
  privateBindings,
}: PolicyInput): PolicyResult => {
  const violations: Array<Violation> = [];
  const classified = classifyStage(plan.stage);

  if (Predicate.isTagged(classified, "Invalid")) {
    return {
      ok: false,
      violations: [{ _tag: "InvalidStage", stage: plan.stage, reason: classified.reason }],
    };
  }

  const stage: StageInfo = classified.stage;

  const approved = (e: PlanEntry) =>
    decommissions.some(
      (d) =>
        d.stage === plan.stage &&
        d.logicalId === e.logicalId &&
        d.action === e.action &&
        d.approvedBy.length > 0 &&
        d.ticket.length > 0,
    );

  for (const entry of plan.entries) {
    // A feature branch or preview must never claim or mutate another stage's resources (§15.2).
    if (entry.stage !== plan.stage && entry.action !== "noop") {
      violations.push({
        _tag: "CrossStageMutation",
        logicalId: entry.logicalId,
        ownerStage: entry.stage,
      });
    }

    for (const ref of entry.references ?? []) {
      if (ref.stage !== plan.stage && (!stage.persistent || ref.stage === "prod")) {
        violations.push({ _tag: "CrossStageReference", logicalId: entry.logicalId, target: ref });
      }
    }

    if (
      isDestructive(entry.action) &&
      PROTECTED_TYPES.has(entry.type as ResourceType) &&
      stage.persistent &&
      !approved(entry)
    ) {
      violations.push({
        _tag: "UnapprovedDestruction",
        logicalId: entry.logicalId,
        type: entry.type,
        action: entry.action,
      });
    }

    if (entry.type === "Cloudflare.Worker" && entry.logicalId === PUBLIC_WORKER) {
      for (const binding of entry.bindings ?? []) {
        if (privateBindings.includes(binding)) {
          violations.push({ _tag: "PrivateBindingOnPublic", worker: entry.logicalId, binding });
        }
      }
    }

    if (
      entry.type === "Cloudflare.Worker" &&
      entry.logicalId === CORE_WORKER &&
      entry.action !== "delete"
    ) {
      const present = new Set(entry.bindings ?? []);

      for (const binding of requiredCoreBindings()) {
        if (!present.has(binding))
          violations.push({ _tag: "MissingBinding", worker: entry.logicalId, binding });
      }
    }

    const declared = INVENTORY.find((i) => i.logicalId === entry.logicalId);

    if (declared !== undefined && declared.type !== entry.type) {
      violations.push({
        _tag: "UnexpectedResourceType",
        logicalId: entry.logicalId,
        type: entry.type,
      });
    }
  }

  return { ok: violations.length === 0, violations };
};

export const formatViolation = (v: Violation): string => {
  return Match.valueTags(v, {
    InvalidStage: (v) => `invalid stage ${v.stage}: ${v.reason}`,
    UnapprovedDestruction: (v) =>
      `${v.action} of protected ${v.type} ${v.logicalId} requires an approved decommission record`,
    CrossStageMutation: (v) =>
      `${v.logicalId} belongs to stage ${v.ownerStage}; this plan may not mutate it`,
    CrossStageReference: (v) => `${v.logicalId} references ${v.target.stage}/${v.target.logicalId}`,
    MissingBinding: (v) => `${v.worker} is missing required binding ${v.binding}`,
    PrivateBindingOnPublic: (v) => `${v.worker} must not receive private binding ${v.binding}`,
    UnexpectedResourceType: (v) =>
      `${v.logicalId} changed type to ${v.type}; identities are compatibility-sensitive`,
  });
};
