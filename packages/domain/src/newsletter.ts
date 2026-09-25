// Newsletter provider contract and consent rules (spec.md §5.2, §5.5). Pure rules only: Bye's consent,
// suppression and publication records are authoritative; provider records are external evidence.

// ---- per-operation capabilities ----

export const NEWSLETTER_OPERATIONS = [
  "contact-sync",
  "unsubscribe-sync",
  "broadcast-create",
  "broadcast-send",
  "broadcast-schedule",
  "broadcast-cancel",
  "broadcast-lookup",
  "events",
] as const;
export type NewsletterOperation = (typeof NEWSLETTER_OPERATIONS)[number];

/** Provider-side protection that makes resubmitting the SAME immutable request safe. */
export interface IdempotencyProtection {
  /** What the key is unique within (e.g. the provider account/team). */
  readonly scope: string;
  /** How long the provider remembers a key; after this a retry is a new request. */
  readonly windowMs: number;
}

export type ProviderEventKind =
  | "contact-unsubscribed"
  | "contact-subscribed"
  | "delivered"
  | "hard-bounce"
  | "soft-bounce"
  | "complaint"
  | "broadcast-state";

/** What one operation of one provider can do. Absent requirements are never silently stripped. */
export interface OperationCapability {
  readonly supported: boolean;
  readonly idempotency: IdempotencyProtection | null;
  /** Whether provider evidence can resolve an ambiguous outcome of this operation. */
  readonly reconciliation: boolean;
  readonly maxRecipients?: number;
  readonly maxEncodedBytes?: number;
  /** Arbitrary headers (List-Unsubscribe, List-Id, …) survive to the delivered message. */
  readonly preservesHeaders?: boolean;
  /** The provider only sends from verified sender domains. */
  readonly senderDomainRestricted?: boolean;
  /** broadcast-send/schedule: the provider drops unsubscribed contacts at its own dispatch boundary. */
  readonly enforcesExclusionsAtDispatch?: boolean;
  /** broadcast-cancel: which broadcasts a cancel can still stop. */
  readonly cancellable?: "draft-or-scheduled" | "until-sent" | "none";
  /** events: which observations the provider reports at all. */
  readonly eventCoverage?: ReadonlyArray<ProviderEventKind>;
}

export interface NewsletterCapabilities {
  readonly name: string;
  /** Adapter/API version the qualification evidence was recorded against. */
  readonly apiVersion: string;
  readonly operations: Readonly<Record<NewsletterOperation, OperationCapability>>;
}

/** What a caller needs from one operation; checked before any side effect. */
export interface OperationRequirements {
  readonly recipients?: number;
  readonly encodedBytes?: number;
  readonly headers?: ReadonlyArray<string>;
  readonly exclusionsAtDispatch?: boolean;
  readonly eventKinds?: ReadonlyArray<ProviderEventKind>;
}

export type OperationCheck =
  | { readonly _tag: "Ok"; readonly capability: OperationCapability }
  | {
      readonly _tag: "Unsupported";
      readonly operation: NewsletterOperation;
      readonly detail: string;
    };

export const checkOperation = (
  caps: NewsletterCapabilities,
  operation: NewsletterOperation,
  req: OperationRequirements = {},
): OperationCheck => {
  const cap = caps.operations[operation];
  const no = (detail: string): OperationCheck => ({ _tag: "Unsupported", operation, detail });
  if (!cap?.supported) return no(`${caps.name} does not support ${operation}`);
  if (
    req.recipients !== undefined &&
    cap.maxRecipients !== undefined &&
    req.recipients > cap.maxRecipients
  )
    return no(`${req.recipients} recipients exceeds ${cap.maxRecipients}`);
  if (
    req.encodedBytes !== undefined &&
    cap.maxEncodedBytes !== undefined &&
    req.encodedBytes > cap.maxEncodedBytes
  )
    return no(`${req.encodedBytes} bytes exceeds ${cap.maxEncodedBytes}`);
  if (req.headers?.length && !cap.preservesHeaders) return no("headers would not be preserved");
  if (req.exclusionsAtDispatch && !cap.enforcesExclusionsAtDispatch)
    return no("recipient exclusions are not enforced at dispatch");
  const missing = (req.eventKinds ?? []).filter((k) => !cap.eventCoverage?.includes(k));
  if (missing.length) return no(`no event coverage for ${missing.join(", ")}`);
  return { _tag: "Ok", capability: cap };
};

/** Missing event coverage is declared, never assumed (§ Delivery and events). */
export const missingEventCoverage = (
  caps: NewsletterCapabilities,
  wanted: ReadonlyArray<ProviderEventKind>,
): ReadonlyArray<ProviderEventKind> =>
  wanted.filter((k) => !caps.operations.events.eventCoverage?.includes(k));

// ---- ambiguous operations ----

/** Accepted, definitively not accepted, or unknown. A timeout is never proof of non-acceptance. */
export type OperationOutcome =
  | { readonly _tag: "Accepted"; readonly providerRef: string }
  | { readonly _tag: "NotAccepted"; readonly retryable: boolean; readonly detail: string }
  | { readonly _tag: "Unknown"; readonly detail: string };

export type RetryDecision =
  | { readonly _tag: "Retry" }
  | { readonly _tag: "Hold"; readonly reason: string };

/**
 * May the SAME immutable request be attempted again? Only when nothing was accepted, or when the
 * provider's idempotency window still covers the first attempt. Reconciliation evidence that
 * proves absence is handled by the caller turning Unknown into NotAccepted.
 */
export const retryDecision = (input: {
  readonly outcome: OperationOutcome;
  readonly idempotency: IdempotencyProtection | null;
  readonly firstAttemptAt: number;
  readonly now: number;
  readonly attempts: number;
  readonly maxAttempts: number;
}): RetryDecision => {
  const { outcome } = input;
  if (outcome._tag === "Accepted") return { _tag: "Hold", reason: "accepted" };
  if (input.attempts >= input.maxAttempts) return { _tag: "Hold", reason: "retries exhausted" };
  if (outcome._tag === "NotAccepted")
    return outcome.retryable ? { _tag: "Retry" } : { _tag: "Hold", reason: "rejected" };
  if (!input.idempotency) return { _tag: "Hold", reason: "unknown outcome without idempotency" };
  if (input.now - input.firstAttemptAt >= input.idempotency.windowMs)
    return { _tag: "Hold", reason: "idempotency window expired" };
  return { _tag: "Retry" };
};

/** Exponential backoff for a safe retry, never faster than the provider's declared retry-after. */
export const retryDelayMs = (attempts: number, retryAfterMs = 0): number =>
  Math.max(retryAfterMs, Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000));

// ---- consent and suppression ----

export type ConsentStatus = "pending" | "confirmed" | "unsubscribed";

/** Creator-specific subscription state with its latest revision and consent evidence. */
export interface ConsentRecord {
  readonly status: ConsentStatus;
  readonly revision: number;
  /** When the state-defining change happened (source time, not receipt time). */
  readonly changedAt: number;
  /** Evidence ID of the consent that confirmed the current subscription, if any. */
  readonly consentEvidence: string | null;
}

export type ConsentChange =
  | {
      readonly _tag: "Confirm";
      /** New recorded consent (double opt-in token, form submission …); required to (re)subscribe. */
      readonly evidence: string;
      readonly at: number;
    }
  | { readonly _tag: "Unsubscribe"; readonly source: "bye" | "provider"; readonly at: number }
  /** A provider says the contact is subscribed again; never evidence of consent by itself. */
  | { readonly _tag: "ProviderSubscribed"; readonly at: number };

export type ConsentResult =
  | { readonly _tag: "Applied"; readonly record: ConsentRecord }
  | { readonly _tag: "Ignored"; readonly reason: "stale" | "no-consent" | "unchanged" };

/**
 * One consent transition. Unsubscribes always win over older state; a positive change never
 * reactivates an unsubscribe unless it carries NEW consent recorded after that unsubscribe.
 */
export const applyConsent = (
  current: ConsentRecord | null,
  change: ConsentChange,
): ConsentResult => {
  const revision = (current?.revision ?? 0) + 1;
  switch (change._tag) {
    case "Unsubscribe":
      if (current?.status === "unsubscribed") return { _tag: "Ignored", reason: "unchanged" };
      return {
        _tag: "Applied",
        record: { status: "unsubscribed", revision, changedAt: change.at, consentEvidence: null },
      };
    case "ProviderSubscribed":
      return { _tag: "Ignored", reason: "no-consent" };
    case "Confirm":
      if (current?.status === "confirmed") return { _tag: "Ignored", reason: "unchanged" };
      if (current?.status === "unsubscribed" && change.at <= current.changedAt)
        return { _tag: "Ignored", reason: "stale" };
      return {
        _tag: "Applied",
        record: {
          status: "confirmed",
          revision,
          changedAt: change.at,
          consentEvidence: change.evidence,
        },
      };
  }
};

/** Bounces and complaints are restrictions, recorded apart from subscriptions. */
export type RestrictionScope = "creator" | "provider" | "platform";
export interface Restriction {
  readonly kind: "hard-bounce" | "complaint" | "provider-unsubscribe" | "manual";
  readonly scope: RestrictionScope;
  readonly reason: string;
}

/** Newsletter eligibility for one creator. Restrictions only ever narrow it. */
export const newsletterEligible = (
  consent: ConsentRecord | null,
  restrictions: ReadonlyArray<Restriction>,
  unresolved: boolean,
): boolean => consent?.status === "confirmed" && restrictions.length === 0 && !unresolved;

// ---- publications ----

export type PublicationState =
  | "approved"
  | "draft-pending"
  | "drafted"
  | "submit-pending"
  | "submitted"
  | "scheduled"
  | "sent"
  | "cancelled"
  | "held"
  | "failed";

export type CancellationReport =
  | { readonly _tag: "Requested" }
  | { readonly _tag: "Confirmed"; readonly coverage: "complete" | "partial" }
  | { readonly _tag: "Unsupported"; readonly detail: string }
  | { readonly _tag: "Uncertain"; readonly detail: string };

/** Provider-observed broadcast state, ordered so a late observation never regresses newer state. */
export type ObservedBroadcastState =
  | "draft"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "cancelled";
const OBSERVED_ORDER: Readonly<Record<ObservedBroadcastState, number>> = {
  draft: 0,
  scheduled: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  cancelled: 4,
};
export const advanceObserved = (
  current: ObservedBroadcastState | null,
  next: ObservedBroadcastState,
): ObservedBroadcastState =>
  current === null || OBSERVED_ORDER[next] > OBSERVED_ORDER[current] ? next : current;

/** Recipient outcome ordering: a delayed "delivered" never overwrites a bounce or complaint. */
export type NewsletterRecipientOutcome =
  | "accepted"
  | "delivered"
  | "soft-bounce"
  | "hard-bounce"
  | "complaint";
const OUTCOME_ORDER: Readonly<Record<NewsletterRecipientOutcome, number>> = {
  accepted: 0,
  "soft-bounce": 1,
  delivered: 2,
  "hard-bounce": 3,
  complaint: 4,
};
export const advanceNewsletterRecipientOutcome = (
  current: NewsletterRecipientOutcome | null,
  next: NewsletterRecipientOutcome,
): NewsletterRecipientOutcome =>
  current === null || OUTCOME_ORDER[next] > OUTCOME_ORDER[current] ? next : current;

/**
 * Stable fingerprint input for an immutable publication (content, sender, schedule). The recipient
 * population is bound separately by the publication's snapshot.
 */
export const publicationFingerprintInput = (p: {
  readonly postId: string;
  readonly revision: number;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly scheduledAt: number | null;
}): string =>
  JSON.stringify([p.postId, p.revision, p.from, p.subject, p.html, p.text, p.scheduledAt]);
