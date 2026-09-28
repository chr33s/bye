// Stage classes (§15.2). Stage names flow into physical resource names, so they are
// validated, opaque, and never carry customer data.

import { Predicate } from "effect";

export type StageClass = "dev" | "preview" | "staging" | "prod";

export interface StageInfo {
  readonly name: string;
  readonly class: StageClass;
  /** Persistent classes keep data across deploys and must never be destroyed by automation. */
  readonly persistent: boolean;
}

const DEV = /^dev-[a-z0-9]{6,16}$/;

const PREVIEW = /^preview-[1-9][0-9]{0,6}$/;

export type StageValidation =
  | { readonly _tag: "Valid"; readonly stage: StageInfo }
  | { readonly _tag: "Invalid"; readonly reason: string };

export const classifyStage = (name: string): StageValidation => {
  if (name === "prod") return { _tag: "Valid", stage: { name, class: "prod", persistent: true } };

  if (name === "staging")
    return { _tag: "Valid", stage: { name, class: "staging", persistent: true } };

  if (PREVIEW.test(name))
    return { _tag: "Valid", stage: { name, class: "preview", persistent: false } };

  if (DEV.test(name)) return { _tag: "Valid", stage: { name, class: "dev", persistent: false } };

  return {
    _tag: "Invalid",
    reason: `stage "${name}" must be one of prod, staging, preview-<number>, dev-<6-16 lowercase alphanumerics>`,
  };
};

export const requireStage = (name: string): StageInfo => {
  const result = classifyStage(name);

  if (Predicate.isTagged(result, "Invalid")) throw new Error(result.reason);

  return result.stage;
};

/** Account separation: production must deploy to a different Cloudflare account than nonproduction when configured. */
export const accountForStage = (
  stage: StageInfo,
  accounts: { readonly prod: string | undefined; readonly nonprod: string | undefined },
): string | undefined => (stage.class === "prod" ? accounts.prod : accounts.nonprod);

/**
 * MX cutover gate (§15.4, §15.8): Email Routing takes over the zone's MX, so the stack enables it
 * only for a configured mail zone, never on previews, and only once BYE_MX_CUTOVER=approved.
 * Returns the zone to route, or undefined when routing stays off.
 */
export const mailRoutingZone = (
  stage: StageInfo,
  mailZone: string | undefined,
  mxCutover: string | undefined,
): string | undefined =>
  stage.class !== "preview" && mxCutover === "approved" ? mailZone : undefined;
