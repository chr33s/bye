import { publicError, REJECTION_CODES, type RejectionCode } from "@bye/platform-cloudflare";
import { Unauthenticated } from "@bye/application";
import { typeNameOf } from "./typename.ts";
import type { CoreEnv } from "./env.ts";
import { Cause, Context, Effect, Exit, Layer, Predicate, Schema, Scope } from "effect";
import {
  FindMyWay,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { ErrorCode, HTTP_STATUS } from "@bye/contracts";

// HTTP boundary helpers: routing (effect/unstable/http HttpRouter), JSON envelopes, and mapping of
// expected tagged failures to public error codes. Defects are logged with an opaque request ID and
// returned as `internal` without details (§7.4 Errors).

export type Params = Readonly<Record<string, string>>;

/** The native invocation a route runs in: the original request (body unread) and Worker bindings. */
export class Invocation extends Context.Service<
  Invocation,
  { readonly request: Request; readonly env: CoreEnv; readonly ctx: ExecutionContext }
>()("bye/core/Invocation") {}

export type Route = HttpRouter.Route<never, Invocation>;

export type RouteHandler = (
  request: Request,
  params: Params,
  env: CoreEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * A handler that throws instead of returning an envelope: auth and body-read failures map to their
 * public codes, anything else is logged (redacted) and answered as `internal`.
 */
const thrownResponse =
  (path: string) =>
  <E>(error: E): Response => {
    if (error instanceof Unauthenticated)
      return errorResponse("unauthenticated", "unauthenticated");

    if (Predicate.isTagged(error, "PayloadTooLarge"))
      return errorResponse("payload_too_large", "payload too large");

    if (Predicate.isTagged(error, "BadRequest"))
      return errorResponse("bad_request", "invalid JSON");
    console.error(
      JSON.stringify({ level: "error", op: "http", path, error: describeError(error) }),
    );

    return errorResponse("internal", "internal error");
  };

/**
 * A router entry for a native handler. It runs uninterruptibly: a client disconnect never abandons
 * a handler midway, matching the Worker's own request lifetime.
 */
export const route = (
  method: HttpMethod.HttpMethod,
  path: HttpRouter.PathInput,
  handler: RouteHandler,
): Route =>
  HttpRouter.route(
    method,
    path,
    Effect.gen(function* () {
      const { request, env, ctx } = yield* Invocation;
      const params: Record<string, string> = {};

      for (const [key, value] of Object.entries(yield* HttpRouter.params))
        if (value !== undefined) params[key] = value;

      const response = yield* Effect.promise(() =>
        handler(request, params, env, ctx).catch(thrownResponse(path)),
      );

      return HttpServerResponse.raw(response);
    }),
    { uninterruptible: true },
  );

/** Paths are exact: case-sensitive, no trailing-slash folding, no parameter length cap. */
const ROUTER_CONFIG = {
  ignoreTrailingSlash: false,
  caseSensitive: true,
  maxParamLength: Number.MAX_SAFE_INTEGER,
} satisfies Partial<FindMyWay.RouterConfig>;

const decodesAsUri = (pathname: string): boolean => {
  try {
    decodeURI(pathname);

    return true;
  } catch {
    return false;
  }
};

/**
 * The URL the router matches, with the lookup rules the pathname-regex router had:
 * - a `;` is part of a path segment (FindMyWay would start a query string at it, answering
 *   `/v1/me;x` as `/v1/me`), so it is escaped and matches no static segment;
 * - a repeated query key keeps its first value, as `URLSearchParams.get` did (the router would
 *   parse it as an array that no query schema accepts).
 */
export const routingUrl = (url: URL): string => {
  const seen = new Set<string>();

  const pairs = url.search
    .slice(1)
    .split("&")
    .flatMap((pair) => {
      if (!pair) return [];

      const key = pair.split("=", 1)[0]!;

      if (seen.has(key)) return [];
      seen.add(key);

      return [pair];
    });

  return `${url.pathname.replaceAll(";", "%3B")}${pairs.length ? `?${pairs.join("&")}` : ""}`;
};

/** A method and path the router answers; with `fetchHandler`'s surface, a wrong method is a 400. */
export interface Endpoint {
  readonly method: string;
  readonly path: HttpRouter.PathInput;
}

/**
 * Build the router once per isolate from a layer that registers routes (native `route`s and the
 * HttpApi). A request no route answers is `bad_request` when its path is malformed or another
 * method of `surface` would match it, else `not_found`. Anything that escapes a route as a failure
 * or defect is answered through `publicFailure`.
 */
export const fetchHandler = (
  app: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Invocation>
  >,
  surface: ReadonlyArray<Endpoint>,
) => {
  const handler = Effect.runSync(
    HttpRouter.toHttpEffect(app).pipe(
      Effect.provideService(HttpRouter.RouterConfig, ROUTER_CONFIG),
      Scope.provide(Scope.makeUnsafe()),
    ),
  );

  const methodsByPath = FindMyWay.make<true>(ROUTER_CONFIG);

  for (const e of surface) methodsByPath.on(e.method, e.path, true);

  const unmatched = (method: string, url: URL): Response =>
    !decodesAsUri(url.pathname)
      ? errorResponse("bad_request", "malformed path")
      : [...HttpMethod.all].some((m) => m !== method && methodsByPath.find(m, routingUrl(url)))
        ? errorResponse("bad_request", "method not allowed")
        : errorResponse("not_found", "not found");

  return (request: Request, env: CoreEnv, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    // No route answers HEAD: the router would run the GET handler (a download, a rate-limit token)
    // only to drop its body.
    if (request.method === "HEAD") return Promise.resolve(unmatched(request.method, url));

    return Effect.runPromise(
      handler.pipe(
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.catchReason("HttpServerError", "RouteNotFound", () =>
          Effect.succeed(unmatched(request.method, url)),
        ),
        Effect.catchCause((cause) => {
          const failure = publicFailure(cause, crypto.randomUUID());

          return Effect.succeed(
            errorResponse(failure.code, failure.message, failure.requestId, failure.details),
          );
        }),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request).modify({ url: routingUrl(url) }),
        ),
        Effect.provideService(Invocation, { request, env, ctx }),
        Effect.scoped,
      ),
    );
  };
};

const SECURITY_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} satisfies Readonly<Record<string, string>>;

/** Two years, subdomains included: every Bye host is HTTPS-only. */
export const HSTS = "max-age=63072000; includeSubDomains";

/** JSON (and other non-document) responses can never be framed or load anything. */
export const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Fallback for a Worker-built HTML page that set no policy of its own: no script at all. */
const htmlCsp = (frameAncestors: string) =>
  `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors ${frameAncestors}`;

/**
 * Baseline response headers for everything MailCore serves itself (static assets get theirs from
 * the web build's `_headers`): HSTS, nosniff, no-referrer, `no-store` for JSON, and a
 * Content-Security-Policy when the handler set none. Handler-set values win — the consent page's `same-origin` referrer policy and
 * the render origin's `frame-ancestors <APP_ORIGIN>` document policies are never overridden.
 * `frameAncestors` is the default for responses without a policy: `'none'` on the app host, the
 * app origin on the render origin (whose error pages show inside the app's sandboxed frame).
 * WebSocket upgrades pass through untouched.
 */
export const withSecurityHeaders = (response: Response, frameAncestors = "'none'"): Response => {
  if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) return response;
  // Stub/fetch responses carry immutable headers: always rebuild.
  const headers = new Headers(response.headers);

  const setDefault = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };

  setDefault("strict-transport-security", HSTS);
  setDefault("x-content-type-options", "nosniff");
  setDefault("referrer-policy", "no-referrer");

  // API answers are per-principal: never cached unless the handler chose a policy.
  if ((headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    setDefault("cache-control", "no-store");

  if (!headers.has("content-security-policy")) {
    const type = (headers.get("content-type") ?? "").toLowerCase();
    headers.set(
      "content-security-policy",
      type.startsWith("text/html")
        ? htmlCsp(frameAncestors)
        : `default-src 'none'; frame-ancestors ${frameAncestors}`,
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const json = <B>(body: B, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...headers } });

/** Public, JSON-serialisable context attached to an error body. */
export type ErrorDetails = NonNullable<ReturnType<typeof publicError>["details"]>;

type ErrorBody = {
  code: ErrorCode;
  message: string;
  requestId?: string;
  details?: ErrorDetails;
};

export const errorResponse = (
  code: ErrorCode,
  message: string,
  requestId?: string,
  details?: ErrorDetails,
): Response => {
  const error: ErrorBody = { code, message };

  if (requestId) error.requestId = requestId;

  if (details) error.details = details;

  return json({ error }, HTTP_STATUS[code]);
};

/** Legacy domain codes still emitted by stores being migrated to `Rejection`. */
const LEGACY_CODES = new Map<string, RejectionCode>([["invalid", "bad_request"]]);

const rejectionCode = <C>(code: C): RejectionCode | undefined =>
  !Predicate.isString(code)
    ? undefined
    : (REJECTION_CODES as ReadonlyArray<string>).includes(code)
      ? (code as RejectionCode)
      : LEGACY_CODES.get(code);

/** Map expected tagged failures to public codes. Unknown tags are internal. */
export const codeForTag = (tag: string): ErrorCode => {
  switch (tag) {
    case "SchemaError":
    case "BadRequest":
      return "bad_request";
    case "Unauthenticated":
      return "unauthenticated";
    case "Forbidden":
    case "StepUpRequired":
      return "forbidden";
    case "NotFound":
      return "not_found";
    case "Conflict":
      return "conflict";
    case "TooLate":
      return "too_late";
    case "RateLimited":
      return "rate_limited";
    case "PayloadTooLarge":
      return "payload_too_large";
    case "Unavailable":
    case "BlobStoreFailure":
    case "QueueFailure":
      return "unavailable";
    case "ApiError":
      return "internal";
    default:
      return "internal";
  }
};

/** The public envelope body for a failed request: expected failures keep their code, defects are `internal`. */
export interface PublicFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: ErrorDetails;
}

/**
 * Map a failure cause to its public envelope (§7.4). Expected tagged failures keep their code;
 * defects and interruptions are logged with the request ID and redacted to `internal`.
 */
export const publicFailure = <E>(cause: Cause.Cause<E>, requestId: string): PublicFailure => {
  const failure = Cause.findErrorOption(cause);

  const withDetails = (code: ErrorCode, message: string, details?: ErrorDetails): PublicFailure =>
    details ? { code, message, requestId, details } : { code, message, requestId };

  if (Predicate.isTagged(failure, "Some")) {
    const error = failure.value as {
      _tag?: string;
      code?: ErrorCode;
      message?: string;
      reason?: string;
      details?: ErrorDetails;
    };

    if (Predicate.isTagged(failure.value, "ApiError") && error.code)
      return withDetails(error.code, error.message ?? error.code, error.details);
    // Structured domain rejections (Rejection, MailboxRejected, CalendarFailure, …) carry their own
    // code; `publicError` is the one mapping to the public vocabulary.
    const domainCode = rejectionCode(error.code);

    if (domainCode) {
      const pub = publicError(domainCode, error.details);

      return withDetails(
        pub.code,
        error.message ?? pub.code,
        pub.details ? { ...pub.details } : undefined,
      );
    }

    // Step-up is a 403 like any refusal, but machine-readable so clients prompt for a passkey only
    // when a fresh confirmation would actually help.
    if (Predicate.isTagged(failure.value, "StepUpRequired")) {
      const action = (error as { action?: string }).action;

      return withDetails(
        "forbidden",
        "recent passkey confirmation required",
        action ? { stepUp: true, action } : { stepUp: true },
      );
    }

    const code = codeForTag(error._tag ?? "");

    if (code !== "internal")
      return withDetails(
        code,
        code === "bad_request" ? "invalid request" : (error.reason ?? error.message ?? code),
      );
  }

  const interrupted = Cause.hasInterrupts(cause);

  console.error(
    JSON.stringify(
      interrupted
        ? { level: "error", requestId, kind: "interrupted" }
        : {
            level: "error",
            requestId,
            kind: "defect",
            error: describeError(Cause.squash(cause)),
          },
    ),
  );

  if ((globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__) console.error(Cause.pretty(cause));

  return withDetails("internal", "internal error");
};

/**
 * Run an Effect at a native invocation boundary (§7.4). All dependencies must already be provided.
 * Expected failures become envelopes; defects and interruptions are redacted.
 */
export const runHttp = async (
  effect: Effect.Effect<Response, unknown>,
  requestId: string,
  signal?: AbortSignal,
): Promise<Response> => {
  // Client disconnect interrupts the request fiber so scopes close and finalizers run (§7.4
  // Cancellation). Interruption never proves a durable mutation did not commit.
  const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);

  if (Exit.isSuccess(exit)) return exit.value;
  const failure = publicFailure(exit.cause, requestId);

  return errorResponse(failure.code, failure.message, failure.requestId, failure.details);
};

/**
 * Scrub free text before it reaches production logs: e-mail addresses, URL query strings and
 * fragments, bearer/basic credentials, `key=value` secrets, and long opaque tokens (session tokens,
 * signing keys, hashes) are replaced with placeholders.
 */
export const redactLogText = (text: string): string =>
  text
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 <redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)[?#][^\s"']*/gi, "$1?<redacted>")
    .replace(
      /\b(token|secret|key|password|signature|sig|code|auth[a-z]*)(\s*[=:]\s*)[^\s&"',;]+/gi,
      "$1$2<redacted>",
    )
    .replace(/(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{20,}/g, "<token>");

const MAX_LOG_MESSAGE = 200;

const STACK_FRAMES = 5;

/**
 * Redacted, bounded description of a failure for production logs (tag, message, top stack
 * frames) — enough to find the cause without request data. Full `Cause.pretty` stays debug-only.
 */
type MutableErrorDescription = { tag: string; message?: string; stack?: ReadonlyArray<string> };

type ErrorDescription = Readonly<MutableErrorDescription>;

export const describeError = <E>(error: E): ErrorDescription => {
  if (!Predicate.isObjectOrArray(error))
    return {
      tag: typeNameOf(error),
      message: redactLogText(String(error)).slice(0, MAX_LOG_MESSAGE),
    };
  const e = Predicate.isReadonlyObject(error) ? error : undefined;

  const tag = Predicate.isString(e?._tag)
    ? e._tag
    : Predicate.isString(e?.name)
      ? e.name
      : "unknown";

  const message =
    Predicate.isString(e?.message) && e.message
      ? redactLogText(e.message).slice(0, MAX_LOG_MESSAGE)
      : undefined;

  const stack = Predicate.isString(e?.stack)
    ? e.stack
        .split("\n")
        .filter((l) => /^\s+at\s/.test(l))
        .slice(0, STACK_FRAMES)
        .map((l) => redactLogText(l.trim()).slice(0, MAX_LOG_MESSAGE))
    : [];

  const described: MutableErrorDescription = { tag };

  if (message) described.message = message;

  if (stack.length) described.stack = stack;

  return described;
};

/** Read at most `maxBytes` of a body, cancelling the stream as soon as it goes past the cap. */
export const readBodyCapped = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number(declared) > maxBytes) throw new PayloadTooLargeError();

  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }

    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }

  return out;
};

export const readJson = async (request: Request, maxBytes = 1024 * 1024): Promise<Schema.Json> => {
  const text = new TextDecoder().decode(await readBodyCapped(request, maxBytes));

  try {
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new BadJsonError();
  }
};

export class PayloadTooLargeError extends Error {
  readonly _tag = "PayloadTooLarge";
}

export class BadJsonError extends Error {
  readonly _tag = "BadRequest";
}
