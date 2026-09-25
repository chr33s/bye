import type { Destination, Disposition, SenderDecision } from "./state.ts";

/** Authenticated-transport safety verdict. Never derived from sender-supplied headers (§10). */
export type SafetyVerdict =
  | { readonly _tag: "Clean" }
  | { readonly _tag: "Spam"; readonly reason: string }
  | { readonly _tag: "Spoofed"; readonly reason: string }
  | { readonly _tag: "Malware"; readonly reason: string };

export interface SenderPolicy {
  readonly decision: SenderDecision;
  readonly destination: Destination;
  readonly labels: ReadonlyArray<string>;
  readonly bundle: boolean;
  readonly notify: boolean;
}

export interface RoutingInput {
  readonly safety: SafetyVerdict;
  /** Exact-address policy; overrides domain defaults (E02). */
  readonly exact: SenderPolicy | undefined;
  readonly domain: SenderPolicy | undefined;
  /** True only when the subject carries the current, unrotated Speakeasy secret (E03). */
  readonly speakeasy: boolean;
  /** Reply to a thread the mailbox already participates in and still follows. */
  readonly knownThread: boolean;
}

export type RoutingStep =
  | "safety"
  | "exact-block"
  | "exact-allow"
  | "domain-block"
  | "domain-allow"
  | "speakeasy"
  | "known-thread"
  | "screener";

export interface RoutingDecision {
  readonly disposition: Disposition;
  readonly destination: Destination;
  readonly labels: ReadonlyArray<string>;
  readonly bundle: boolean;
  readonly notify: boolean;
  readonly decidedBy: RoutingStep;
  /** Quarantined originals stay accessible for false-positive recovery. */
  readonly quarantine: boolean;
}

const defaults = {
  destination: "imbox" as Destination,
  labels: [] as ReadonlyArray<string>,
  bundle: false,
  notify: false,
};

const fromPolicy = (policy: SenderPolicy, decidedBy: RoutingStep): RoutingDecision => ({
  disposition: "active",
  destination: policy.destination,
  labels: policy.labels,
  bundle: policy.bundle,
  notify: policy.notify,
  decidedBy,
  quarantine: false,
});

/**
 * Proposed routing precedence (§4.2):
 * malware/spoofing/spam → explicit sender block → exact sender allow → domain policy →
 * valid Speakeasy bypass → Screener. Recipient validity is resolved before this function.
 * Sender approval never overrides detected forgery; Speakeasy never bypasses safety.
 */
export const route = (input: RoutingInput): RoutingDecision => {
  const { safety, exact, domain } = input;
  if (safety._tag === "Malware" || safety._tag === "Spoofed") {
    return { ...defaults, disposition: "spam", decidedBy: "safety", quarantine: true };
  }
  if (safety._tag === "Spam") {
    return { ...defaults, disposition: "spam", decidedBy: "safety", quarantine: false };
  }
  if (exact?.decision === "blocked") {
    return {
      ...defaults,
      disposition: "screened-out",
      decidedBy: "exact-block",
      quarantine: false,
    };
  }
  if (exact?.decision === "allowed") return fromPolicy(exact, "exact-allow");
  if (domain?.decision === "blocked") {
    return {
      ...defaults,
      disposition: "screened-out",
      decidedBy: "domain-block",
      quarantine: false,
    };
  }
  if (domain?.decision === "allowed") return fromPolicy(domain, "domain-allow");
  if (input.speakeasy)
    return { ...defaults, disposition: "active", decidedBy: "speakeasy", quarantine: false };
  if (input.knownThread)
    return { ...defaults, disposition: "active", decidedBy: "known-thread", quarantine: false };
  return { ...defaults, disposition: "screening", decidedBy: "screener", quarantine: false };
};

/** Normalize an address for policy lookup. Local part case is preserved per RFC but compared lowercased in practice. */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

export const domainOf = (address: string): string => {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : normalizeAddress(address.slice(at + 1));
};

/** Split plus-addressing: "alice+news@example.com" → { base: "alice@example.com", tag: "news" }. */
export const splitPlusAddress = (
  address: string,
): { readonly base: string; readonly tag: string | undefined } => {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at < 0) return { base: normalized, tag: undefined };
  const local = normalized.slice(0, at);
  const plus = local.indexOf("+");
  if (plus <= 0) return { base: normalized, tag: undefined };
  return { base: `${local.slice(0, plus)}${normalized.slice(at)}`, tag: local.slice(plus + 1) };
};
