import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import { SUPPORTED_CAPABILITIES } from "./capabilities.ts";
import { type MethodError, methodError, type RequestProblem, requestProblem } from "./errors.ts";
import { evaluatePointer } from "./pointer.ts";
import {
  type Invocation,
  type JmapRequest,
  type JmapResponse,
  ResultReference,
} from "./request.ts";

// Method dispatch (RFC 8620 §3.3–3.7). Calls run strictly in order; each sees the responses of
// the calls before it through result references. A batch is not a transaction: every call commits
// or fails on its own and a failed call never aborts the rest (spec.md §16.4).

export interface CallContext {
  /** Capabilities the client named in `using`. */
  readonly using: ReadonlySet<string>;
  /** Creation IDs from the request plus those created by earlier calls (RFC 8620 §3.3). */
  readonly createdIds: Map<string, string>;
  readonly callId: string;
}

/**
 * Several responses for one call, in order: a method with implicit calls (EmailSubmission/set's
 * implicit Email/set, RFC 8621 §7.5), or a call forwarded to the account authority, whose answer
 * may already be an `error` invocation.
 */
export class Responses {
  constructor(readonly list: ReadonlyArray<readonly [string, Schema.JsonObject]>) {}
}

export type MethodOutput = Schema.JsonObject | Responses;

export interface MethodDefinition<R> {
  readonly name: string;
  readonly capability: string;
  readonly handler: (
    args: Schema.JsonObject,
    context: CallContext,
  ) => Effect.Effect<MethodOutput, MethodError, R>;
}

export type MethodRegistry<R> = ReadonlyMap<string, MethodDefinition<R>>;

export const methodRegistry = <R>(methods: ReadonlyArray<MethodDefinition<R>>): MethodRegistry<R> =>
  new Map(methods.map((m) => [m.name, m]));

const decodeReference = Schema.decodeUnknownOption(ResultReference);

const errorBody = (error: MethodError): readonly [string, Schema.JsonObject] => [
  "error",
  error.description === undefined
    ? { type: error.type }
    : { type: error.type, description: error.description },
];

const errorInvocation = (error: MethodError, callId: string): Invocation => [
  ...errorBody(error),
  callId,
];

/**
 * Resolve `#name` arguments against earlier responses (RFC 8620 §3.7). A key present both plain
 * and `#`-prefixed is `invalidArguments`; any failed lookup is `invalidResultReference`.
 */
export const resolveReferences = (
  args: Schema.JsonObject,
  responses: ReadonlyArray<Invocation>,
): Result.Result<Schema.JsonObject, MethodError> => {
  const resolved: { [key: string]: Schema.Json } = {};

  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      resolved[key] = value;
      continue;
    }

    const name = key.slice(1);

    if (Object.hasOwn(args, name))
      return Result.fail(methodError("invalidArguments", `both ${name} and #${name} are present`));
    const reference = decodeReference(value);

    if (Option.isNone(reference))
      return Result.fail(
        methodError("invalidResultReference", `#${name} is not a ResultReference`),
      );
    const { resultOf, name: responseName, path } = reference.value;
    const source = responses.find(([, , callId]) => callId === resultOf);

    if (!source || source[0] !== responseName)
      return Result.fail(
        methodError("invalidResultReference", `no ${responseName} response for call ${resultOf}`),
      );
    const target = evaluatePointer(source[1], path);

    if (Option.isNone(target))
      return Result.fail(methodError("invalidResultReference", `path ${path} does not resolve`));
    resolved[name] = target.value;
  }

  return Result.succeed(resolved);
};

/** The `using` capabilities this server doesn't know, which fail the whole request. */
export const unknownCapabilities = (using: ReadonlyArray<string>): ReadonlyArray<string> =>
  using.filter((c) => !SUPPORTED_CAPABILITIES.includes(c));

/**
 * Run one already-resolved call: its responses (named, without the call ID). Unknown methods,
 * method errors and handler defects all become one `error` response.
 */
export const runCall = <R>(
  registry: MethodRegistry<R>,
  name: string,
  args: Schema.JsonObject,
  context: CallContext,
): Effect.Effect<ReadonlyArray<readonly [string, Schema.JsonObject]>, never, R> =>
  Effect.gen(function* () {
    const method = registry.get(name);

    if (!method || !context.using.has(method.capability))
      return [errorBody(methodError("unknownMethod", name))];
    const exit = yield* Effect.exit(method.handler(args, context));

    if (Exit.isSuccess(exit))
      return exit.value instanceof Responses ? exit.value.list : [[name, exit.value] as const];
    const failure = Cause.findError(exit.cause);

    if (Result.isSuccess(failure)) return [errorBody(failure.success)];

    console.error(
      JSON.stringify({
        level: "error",
        op: "jmap.method.defect",
        method: name,
        callId: context.callId,
        defect: String(Cause.squash(exit.cause)).slice(0, 300),
      }),
    );

    return [errorBody(methodError("serverFail"))];
  });

/**
 * Process one request. Request-level problems come back as a `RequestProblem`; everything after
 * validation is a `JmapResponse`, with method failures as `error` invocations. A handler defect
 * is reported as `serverFail` for that call only.
 */
export const dispatch = <R>(
  registry: MethodRegistry<R>,
  request: JmapRequest,
  sessionState: string,
): Effect.Effect<Result.Result<JmapResponse, RequestProblem>, never, R> =>
  Effect.gen(function* () {
    const unknown = unknownCapabilities(request.using);

    if (unknown.length > 0)
      return Result.fail(
        requestProblem("unknownCapability", `unknown capability: ${unknown.join(", ")}`),
      );
    const using = new Set(request.using);
    const createdIds = new Map(Object.entries(request.createdIds ?? {}));
    const responses: Array<Invocation> = [];

    for (const [name, rawArgs, callId] of request.methodCalls) {
      const args = resolveReferences(rawArgs, responses);

      if (Result.isFailure(args)) {
        responses.push(errorInvocation(args.failure, callId));
        continue;
      }

      const out = yield* runCall(registry, name, args.success, { using, createdIds, callId });

      for (const [responseName, responseArgs] of out)
        responses.push([responseName, responseArgs, callId]);
    }

    const response: JmapResponse =
      request.createdIds === undefined
        ? { methodResponses: responses, sessionState }
        : { methodResponses: responses, createdIds: Object.fromEntries(createdIds), sessionState };

    return Result.succeed(response);
  });
