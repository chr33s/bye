import { Predicate } from "effect";

// Client error reporting shared by web and the native apps. The reporter is pluggable and a no-op
// by default: nothing leaves the device until a host installs one. Reports are built from the error
// object only — never from mail, drafts, addresses or request bodies — and carry the error type,
// an engine-generated message and code locations, nothing a user typed or received.

export interface ErrorReport {
  /** Where it was caught: an uncaught error, an unhandled rejection, or a UI error boundary. */
  readonly source: "error" | "unhandledrejection" | "boundary" | "native-fatal" | "native";
  /** Error constructor name (TypeError, ByeApiError, …). */
  readonly name: string;
  /**
   * Only for engine errors (TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError),
   * whose messages come from the runtime. Application errors can quote server or user content,
   * so their messages are dropped.
   */
  readonly message?: string;
  /** Up to 10 stack frames, file paths and positions only. */
  readonly frames: ReadonlyArray<string>;
  /** Client platform ("web", "ios", …) and build, when the host sets them. */
  readonly platform?: string;
  readonly release?: string;
  readonly at: number;
}

export type ErrorReporter = (report: ErrorReport) => void;

const ENGINE_ERRORS = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
]);

let reporter: ErrorReporter = () => undefined;

interface ErrorContext {
  platform?: string;
  release?: string;
}

let context: ErrorContext = {};

/** Install the reporter (e.g. an HTTP beacon to an error service). Pass null to restore the no-op. */
export const setErrorReporter = (
  next: ErrorReporter | null,
  meta: { readonly platform?: string; readonly release?: string } = {},
): void => {
  reporter = next ?? (() => undefined);
  context = { ...meta };
};

/** Keep only a frame's location: `at fn (file:line:col)` / `fn@file:line:col` → `fn file:line:col`. */
const frame = (line: string): string | null => {
  const trimmed = line.trim();
  const v8 = /^at (?:(.+?) \()?(.+?:\d+:\d+)\)?$/.exec(trimmed);

  if (v8) return `${v8[1] ?? "<anonymous>"} ${stripQuery(v8[2]!)}`;
  const moz = /^(.*?)@(.+?:\d+:\d+)$/.exec(trimmed);

  if (moz) return `${moz[1] || "<anonymous>"} ${stripQuery(moz[2]!)}`;

  return null;
};

/** URLs in frames can carry fragments/queries (routes with ids, search terms); keep the path. */
const stripQuery = (location: string): string => location.replace(/[?#][^:]*(?=:\d+:\d+$)/, "");

interface ErrorDetail {
  message?: string;
}

/** The runtime kind of a thrown value ("string", "object", …), used when it is not an Error. */
const kindOf = (cause: unknown): string => {
  if (Predicate.isString(cause)) return "string";

  if (Predicate.isNumber(cause)) return "number";

  if (Predicate.isBoolean(cause)) return "boolean";

  if (Predicate.isBigInt(cause)) return "bigint";

  if (Predicate.isSymbol(cause)) return "symbol";

  if (Predicate.isUndefined(cause)) return "undefined";

  return Predicate.isFunction(cause) ? "function" : "object";
};

/** Build a report that is safe to send: no message text from application errors, no user data. */
export const toErrorReport = (
  cause: unknown,
  source: ErrorReport["source"],
  now: number = Date.now(),
): ErrorReport => {
  const err = cause instanceof Error ? cause : null;
  const name = err?.name && /^[A-Za-z][\w.]{0,63}$/.test(err.name) ? err.name : kindOf(cause);

  const frames = (err?.stack ?? "")
    .split("\n")
    .map(frame)
    .filter((f): f is string => f !== null)
    .slice(0, 10);

  const detail: ErrorDetail = {};

  if (err && ENGINE_ERRORS.has(err.name)) detail.message = err.message.slice(0, 200);

  return {
    source,
    name,
    ...detail,
    frames,
    ...context,
    at: now,
  };
};

/** Report an error through the installed reporter; a reporter that throws is ignored. */
export const reportError = (cause: unknown, source: ErrorReport["source"]): void => {
  try {
    reporter(toErrorReport(cause, source));
  } catch {
    // Reporting must never cause another error.
  }
};
