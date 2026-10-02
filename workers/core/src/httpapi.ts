// HttpApi (effect/http-api) plumbing for the conventional JSON API (§8): the public error
// envelope as endpoint error schemas, the middleware that authenticates and provides request-scoped
// services, and the platform services the builder needs on Workers. Endpoint specs live in
// ./spec/*, handlers next to their routes in ./routes/*.
import { authenticateRequest, requestAuthLayer } from "@bye/application";
import { ErrorCode, HTTP_STATUS } from "@bye/contracts";
import { Cause, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from "effect";
import { Etag, HttpPlatform, HttpServerRequest } from "effect/http";
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api";
import {
  type ErrorDetails,
  Invocation,
  PayloadTooLargeError,
  type PublicFailure,
  publicFailure,
  readBodyCapped,
} from "./http.ts";
import { type AppServices, appLayers, auditWrite, credentialsOf } from "./routes/common.ts";
import { controlLayer } from "./services.ts";

const failureBody = <const C extends ErrorCode>(code: C) =>
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literal(code),
      message: Schema.String,
      requestId: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  }).pipe(HttpApiSchema.status(HTTP_STATUS[code]));

/** The public error envelope (`ErrorEnvelope`), one member per code so each carries its status. */
export const PublicErrors = [
  failureBody("bad_request"),
  failureBody("unauthenticated"),
  failureBody("forbidden"),
  failureBody("not_found"),
  failureBody("conflict"),
  failureBody("too_late"),
  failureBody("rate_limited"),
  failureBody("payload_too_large"),
  failureBody("unavailable"),
  failureBody("internal"),
] as const;

export type PublicError = (typeof PublicErrors)[number]["Type"];

const envelope = (failure: PublicFailure): PublicError =>
  // SAFETY: `failure.code` is an `ErrorCode`, and `PublicErrors` has one member per code, so the
  // object is exactly one member of the union; TypeScript can't distribute the literal itself.
  ({ error: failure }) as PublicError;

const fail = (code: ErrorCode, message: string, requestId: string, details?: ErrorDetails) =>
  Effect.fail(
    envelope(details ? { code, message, requestId, details } : { code, message, requestId }),
  );

/** A void result answers `{ ok: true }`, as every write did before it had a response schema. */
export const Ok = Schema.Struct({ ok: Schema.Literal(true) });

export const ok = { ok: true } as const;

/** Whether any plain object in the tree holds an `undefined`-valued key; allocates nothing. */
const holdsUndefined = <A>(value: A): boolean => {
  if (Array.isArray(value)) return value.some(holdsUndefined);

  if (!Predicate.isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;

  for (const key in value) if (value[key] === undefined || holdsUndefined(value[key])) return true;

  return false;
};

const copyWithoutUndefined = <A>(value: A): A => {
  if (Array.isArray(value)) return value.map(copyWithoutUndefined) as A;

  if (!Predicate.isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return value;

  const out = Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) =>
      v === undefined ? [] : [[key, copyWithoutUndefined(v)]],
    ),
  );

  // SAFETY: same object minus keys whose value was `undefined`, which the response schema can only
  // declare as optional; nothing else changes.
  return out as A;
};

/**
 * Drop `undefined`-valued keys, as `JSON.stringify` did: HttpApi's JSON encoding would write a
 * present-but-undefined optional key as `null`. Most results hold none and are answered as they
 * are; only a result that does is copied.
 */
const withoutUndefined = <A>(value: A): A =>
  holdsUndefined(value) ? copyWithoutUndefined(value) : value;

/**
 * Settle a handler into its public answer: the result as `JSON.stringify` would have shaped it, and
 * failures as the public envelope — expected failures keep their code, defects are logged and
 * answered `internal` (see `publicFailure`).
 */
export const publicly = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, PublicError, R> =>
  self.pipe(
    Effect.map(withoutUndefined),
    Effect.catchCause((cause) => Effect.fail(envelope(publicFailure(cause, crypto.randomUUID())))),
  );

/**
 * Authenticates the request and provides the request-scoped application services. Bodies are
 * read (capped at 1 MiB) before authentication, as they always were; every write is attributed to
 * the exact credential in the user's audit log (X02 / P0#10) — bodies are never recorded.
 */
export class RequestServices extends HttpApiMiddleware.Service<
  RequestServices,
  { provides: AppServices }
>()("bye/core/RequestServices", { error: PublicErrors }) {}

const MAX_JSON_BYTES = 1024 * 1024;

const isRead = (method: string) => method === "GET" || method === "HEAD";

/**
 * The request's invocation, read inside middleware. Middleware `requires` are build-time layer
 * requirements, and the invocation exists only per request, so it is read as an optional service:
 * the router provides it to every request, and its absence is a wiring defect.
 */
const currentInvocation = Effect.flatMap(Effect.serviceOption(Invocation), (invocation) =>
  Option.isSome(invocation) ? Effect.succeed(invocation.value) : Effect.die("no invocation"),
);

/**
 * Read a write's body once, capped, as the JSON payload HttpApi decodes. As under `authed`, the
 * body is JSON whatever its declared type, and an empty body is `{}` (so all-optional payloads
 * accept it).
 */
const bufferJson = (request: Request, requestId: string) =>
  Effect.tryPromise({
    try: () => readBodyCapped(request, MAX_JSON_BYTES),
    catch: (e) => e,
  }).pipe(
    Effect.catch((e) =>
      e instanceof PayloadTooLargeError
        ? fail("payload_too_large", "payload too large", requestId)
        : fail("bad_request", "invalid body", requestId),
    ),
    Effect.map((bytes) => {
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");

      return new Request(request.url, {
        method: request.method,
        headers,
        body: bytes.byteLength === 0 ? "{}" : bytes,
      });
    }),
  );

export const RequestServicesLive = Layer.succeed(RequestServices)((httpEffect) =>
  Effect.gen(function* () {
    const { request, env } = yield* currentInvocation;
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;

    const buffered = isRead(request.method) ? request : yield* bufferJson(request, requestId);

    const control = yield* Effect.promise(() => controlLayer(env));

    const auth = yield* authenticateRequest(credentialsOf(request), env.APP_ORIGIN).pipe(
      Effect.provide(control),
      Effect.catchCause((cause) => Effect.fail(envelope(publicFailure(cause, requestId)))),
    );

    return yield* httpEffect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(buffered),
      ),
      Effect.provide(requestAuthLayer(auth)),
      Effect.onExit((exit) =>
        isRead(request.method)
          ? Effect.void
          : auditWrite(
              env,
              auth,
              request.method,
              path,
              Predicate.isTagged(exit, "Success") ? "ok" : "failed",
            ),
      ),
      Effect.provide(appLayers(env, control)),
    );
  }),
);

/** Answers a body, path or query that doesn't match its schema as `bad_request`, never a default. */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "bye/core/SchemaErrors",
  {
    error: PublicErrors,
  },
) {}

const REQUEST_PARTS = {
  Payload: "body",
  Params: "path",
  Query: "query",
  Headers: "headers",
} as const;

/**
 * A request that doesn't decode is the caller's `bad_request`; a response that doesn't encode
 * (`Body`, `ResponseHeaders`) is our defect: logged, and answered `internal`.
 */
export const SchemaErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrors,
  (error) => {
    const requestId = crypto.randomUUID();

    switch (error.kind) {
      case "Payload":
      case "Params":
      case "Query":
      case "Headers":
        return fail(
          "bad_request",
          `invalid request ${REQUEST_PARTS[error.kind]}: ${error.cause.message.split("\n")[0]}`,
          requestId,
        );
      case "Body":
      case "ResponseHeaders":
        return Effect.fail(envelope(publicFailure(Cause.die(error), requestId)));
    }
  },
);

/** What `HttpApiBuilder.layer` needs from the platform; Workers serve no files through it. */
export const ApiPlatformLive = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  FileSystem.layerNoop({}),
  Etag.layer,
  Path.layer,
);
