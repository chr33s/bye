// Capability identifiers and the limits Bye advertises (RFC 8620 §2, RFC 8621 §1.3).

export const CORE = "urn:ietf:params:jmap:core";

export const MAIL = "urn:ietf:params:jmap:mail";

export const SUBMISSION = "urn:ietf:params:jmap:submission";

export const VACATION_RESPONSE = "urn:ietf:params:jmap:vacationresponse";

/**
 * Vendor-owned capability for Bye extensions (spec.md §16.3). It never redefines standard
 * fields; today it only carries the conformance profile so clients can see the slice is partial.
 */
export const BYE = "https://github.com/chr33s/bye/blob/main/spec.md#jmap-capability";

/**
 * Conformance profile this deployment serves (spec.md §16.6 delivery order). `read-only-partial`
 * is the read-only vertical slice: it is not Mail conformance and accounts are `isReadOnly`.
 */
export const PROFILE = "read-only-partial";

/** Core limits (RFC 8620 §2 `urn:ietf:params:jmap:core` capability object). */
export const CORE_LIMITS = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
} as const;

/** Mail account capability (RFC 8621 §1.3.1). Mailbox nesting is flat in the legacy projection. */
export const MAIL_ACCOUNT_CAPABILITY = {
  maxMailboxesPerEmail: null,
  maxMailboxDepth: 1,
  maxSizeMailboxName: 255,
  maxSizeAttachmentsPerEmail: 25_000_000,
  emailQuerySortOptions: ["receivedAt", "sentAt", "size"],
  mayCreateTopLevelMailbox: false,
} as const;

/** Largest page an `/query` returns; larger requested limits are clamped and reported. */
export const MAX_QUERY_LIMIT = 500;

/** Capabilities a request may name in `using`. Submission is a separate gate (spec.md §16.5). */
export const SUPPORTED_CAPABILITIES: ReadonlyArray<string> = [
  CORE,
  MAIL,
  SUBMISSION,
  VACATION_RESPONSE,
  BYE,
];
