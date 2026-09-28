import { publicError, REJECTION_CODES, type RejectionCode } from "@bye/platform-cloudflare";
import { typeNameOf } from "./typename.ts";
import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { ErrorCode, HTTP_STATUS } from "@bye/contracts";

// HTTP boundary helpers: typed routing, JSON envelopes, and mapping of expected tagged failures
// to public error codes. Defects are logged with an opaque request ID and returned as `internal`
// without details (§7.4 Errors).

export type Params = Readonly<Record<string, string>>;

export interface Route<Env> {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: ReadonlyArray<string>;
  readonly handler: (
    request: Request,
    params: Params,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
}

export const route = <Env>(
  method: string,
  path: string,
  handler: Route<Env>["handler"],
): Route<Env> => {
  const keys: Array<string> = [];

  const pattern = new RegExp(
    `^${path.replace(/\/:([a-zA-Z]+)/g, (_, key: string) => {
      keys.push(key);

      return "/([^/]+)";
    })}$`,
  );

  return { method, pattern, keys, handler };
};

export const matchRoute = <Env>(
  routes: ReadonlyArray<Route<Env>>,
  method: string,
  pathname: string,
) => {
  let pathMatched = false;

  for (const r of routes) {
    const m = r.pattern.exec(pathname);

    if (!m) continue;
    pathMatched = true;

    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));

    return { route: r, params };
  }

  return pathMatched ? "method-not-allowed" : undefined;
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
 * the web build's `_headers`): HSTS, nosniff, no-referrer, and a Content-Security-Policy when the
 * handler set none. Handler-set values win — the consent page's `same-origin` referrer policy and
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
  const failure = Cause.findErrorOption(exit.cause);

  if (Predicate.isTagged(failure, "Some")) {
    const error = failure.value as {
      _tag?: string;
      code?: ErrorCode;
      message?: string;
      reason?: string;
      details?: ErrorDetails;
    };

    if (Predicate.isTagged(failure.value, "ApiError") && error.code)
      return errorResponse(error.code, error.message ?? error.code, requestId, error.details);
    // Structured domain rejections (Rejection, MailboxRejected, CalendarFailure, …) carry their own
    // code; `publicError` is the one mapping to the public vocabulary.
    const domainCode = rejectionCode(error.code);

    if (domainCode) {
      const pub = publicError(domainCode, error.details);

      return errorResponse(
        pub.code,
        error.message ?? pub.code,
        requestId,
        pub.details ? { ...pub.details } : undefined,
      );
    }

    // Step-up is a 403 like any refusal, but machine-readable so clients prompt for a passkey only
    // when a fresh confirmation would actually help.
    if (Predicate.isTagged(failure.value, "StepUpRequired")) {
      const action = (error as { action?: string }).action;

      return errorResponse(
        "forbidden",
        "recent passkey confirmation required",
        requestId,
        action ? { stepUp: true, action } : { stepUp: true },
      );
    }

    const code = codeForTag(error._tag ?? "");

    if (code !== "internal") {
      const message =
        code === "bad_request" ? "invalid request" : (error.reason ?? error.message ?? code);

      return errorResponse(code, message, requestId);
    }
  }

  const interrupted = Cause.hasInterrupts(exit.cause);

  console.error(
    JSON.stringify(
      interrupted
        ? { level: "error", requestId, kind: "interrupted" }
        : {
            level: "error",
            requestId,
            kind: "defect",
            error: describeError(Cause.squash(exit.cause)),
          },
    ),
  );

  if ((globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__)
    console.error(Cause.pretty(exit.cause));

  return errorResponse("internal", "internal error", requestId);
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
