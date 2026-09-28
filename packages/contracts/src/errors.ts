import { Predicate, Schema } from "effect";

// Public error envelope. Stable across library upgrades (§7.3); never carries defects or provider payloads.

export const ErrorCode = Schema.Literals([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "too_late",
  "rate_limited",
  "payload_too_large",
  "unavailable",
  "internal",
]);

export type ErrorCode = typeof ErrorCode.Type;

/**
 * Domain rejection codes that authorities (Durable Objects, control plane) return as data. A
 * superset of the public `ErrorCode`: `publicError` (platform durable/rpc.ts) maps the extras.
 */
export const REJECTION_CODES = [
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "gone",
  "conflict",
  "too_late",
  "read_only",
  "payload_too_large",
  "rate_limited",
  "step_up_required",
  "unavailable",
] as const;

export const RejectionCode = Schema.Literals(REJECTION_CODES);

export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * An expected, domain-level refusal shared by every layer (stores, Durable Objects, application
 * ports). `details` travels to the client (e.g. `currentRevision`, `stepUp`). Defects are never
 * Rejections.
 */
export class Rejection extends Schema.TaggedError<Rejection>()("Rejection", {
  code: RejectionCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export const reject = (
  code: RejectionCode,
  message: string,
  details?: Readonly<Rejection["details"] & object>,
): never => {
  throw new Rejection(details ? { code, message, details: { ...details } } : { code, message });
};

export const isRejection = (e: unknown): e is Rejection =>
  e instanceof Rejection || Predicate.isTagged(e, "Rejection");

export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCode,
    message: Schema.String,
    requestId: Schema.optional(Schema.String),
    details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});

export type ErrorEnvelope = typeof ErrorEnvelope.Type;

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_late: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unavailable: 503,
  internal: 500,
};

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  code: ErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}
