import { Result, Schema } from "effect";
import { CORE_LIMITS } from "./capabilities.ts";
import { type RequestProblem, requestProblem } from "./errors.ts";

// Request and response envelopes (RFC 8620 §3.2–3.4, §3.7).

export const Invocation = Schema.Tuple([Schema.String, Schema.JsonObject, Schema.String]);

export type Invocation = typeof Invocation.Type;

export const JmapRequest = Schema.Struct({
  using: Schema.Array(Schema.String),
  methodCalls: Schema.Array(Invocation),
  createdIds: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type JmapRequest = typeof JmapRequest.Type;

export interface JmapResponse {
  readonly methodResponses: ReadonlyArray<Invocation>;
  readonly createdIds?: { readonly [creationId: string]: string };
  readonly sessionState: string;
}

export const ResultReference = Schema.Struct({
  resultOf: Schema.String,
  name: Schema.String,
  path: Schema.String,
});

export type ResultReference = typeof ResultReference.Type;

const decodeRequest = Schema.decodeUnknownResult(JmapRequest);

/**
 * Parse a request body: invalid JSON is `notJSON`, JSON that isn't a Request is `notRequest`, and
 * an oversize body or too many calls is `limit` (RFC 8620 §3.6.1).
 */
export const parseRequest = (body: string): Result.Result<JmapRequest, RequestProblem> => {
  if (new TextEncoder().encode(body).byteLength > CORE_LIMITS.maxSizeRequest)
    return Result.fail(requestProblem("limit", "request too large", "maxSizeRequest"));
  let parsed: Schema.Json;

  try {
    parsed = JSON.parse(body) as Schema.Json;
  } catch {
    return Result.fail(requestProblem("notJSON", "request body is not valid JSON"));
  }

  const request = decodeRequest(parsed);

  if (Result.isFailure(request))
    return Result.fail(
      requestProblem("notRequest", `request does not match the JMAP Request type`),
    );

  if (request.success.methodCalls.length > CORE_LIMITS.maxCallsInRequest)
    return Result.fail(
      requestProblem("limit", "too many method calls in request", "maxCallsInRequest"),
    );

  return Result.succeed(request.success);
};
