import { Schema } from "effect";

// JMAP error vocabulary (RFC 8620 §3.6, RFC 8621). Request-level errors are RFC 7807 problem
// documents; method-level errors are `["error", { type, … }, callId]` invocations; per-object
// errors are SetError values inside a method response. They are three distinct envelopes and
// never collapse into one HTTP error body (spec.md §16 D1).

const ERROR_URN = "urn:ietf:params:jmap:error:";

/** Request-level problem types (RFC 8620 §3.6.1). */
export const REQUEST_ERROR_TYPES = ["unknownCapability", "notJSON", "notRequest", "limit"] as const;

export type RequestErrorType = (typeof REQUEST_ERROR_TYPES)[number];

export const requestErrorUri = (type: RequestErrorType): string => `${ERROR_URN}${type}`;

/** Method-level error types (RFC 8620 §3.6.2 and the per-method errors of RFC 8620/8621). */
export const METHOD_ERROR_TYPES = [
  "serverUnavailable",
  "serverFail",
  "serverPartialFail",
  "unknownMethod",
  "invalidArguments",
  "invalidResultReference",
  "forbidden",
  "accountNotFound",
  "accountNotSupportedByMethod",
  "accountReadOnly",
  "requestTooLarge",
  "cannotCalculateChanges",
  "stateMismatch",
  "anchorNotFound",
  "unsupportedSort",
  "unsupportedFilter",
  "tooManyChanges",
  "fromAccountNotFound",
  "fromAccountNotSupportedByMethod",
] as const;

export const MethodErrorType = Schema.Literals(METHOD_ERROR_TYPES);

export type MethodErrorType = typeof MethodErrorType.Type;

/** A method-level error; the dispatcher turns it into an `error` invocation for its call. */
export class MethodError extends Schema.TaggedError<MethodError>()("MethodError", {
  type: MethodErrorType,
  description: Schema.optional(Schema.String),
}) {}

export const methodError = (type: MethodErrorType, description?: string): MethodError =>
  description === undefined ? new MethodError({ type }) : new MethodError({ type, description });

/** Per-object SetError types (RFC 8620 §5.3, §5.4; RFC 8621 §§2.5, 4.6, 7.5). */
export const SET_ERROR_TYPES = [
  "forbidden",
  "overQuota",
  "tooLarge",
  "rateLimit",
  "notFound",
  "invalidPatch",
  "willDestroy",
  "invalidProperties",
  "singleton",
  "alreadyExists",
  "mailboxHasChild",
  "mailboxHasEmail",
  "blobNotFound",
  "tooManyKeywords",
  "tooManyMailboxes",
  "invalidEmail",
  "tooManyRecipients",
  "noRecipients",
  "invalidRecipients",
  "forbiddenMailFrom",
  "forbiddenFrom",
  "forbiddenToSend",
  "cannotUnsend",
] as const;

export type SetErrorType = (typeof SET_ERROR_TYPES)[number];

/** A request-level failure, answered as an `application/problem+json` document. */
export interface RequestProblem {
  readonly type: string;
  readonly status: number;
  readonly detail: string;
  /** For `limit`: the name of the exceeded limit (RFC 8620 §3.6.1). */
  readonly limit?: string;
}

export const requestProblem = (
  type: RequestErrorType,
  detail: string,
  limit?: string,
): RequestProblem =>
  limit === undefined
    ? { type: requestErrorUri(type), status: 400, detail }
    : { type: requestErrorUri(type), status: 400, detail, limit };
