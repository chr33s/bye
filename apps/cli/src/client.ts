import type { JsonValue } from "./json.ts";
import { Context, Effect, Layer, Schema } from "effect";
import {
  ByeApiError,
  ByeClient,
  type FetchLike,
  type Method,
  type QueryParams,
  type RequestBody,
} from "@bye/native-shared";

// Authenticated API access for the CLI and TUI (X02), through the shared client every first-party
// client uses (static bearer credential). Same command contracts as web/mobile (§8).

export type { FetchLike };

export class CliApiError extends Schema.TaggedError<CliApiError>()("CliApiError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

export interface CliConfig {
  /** The effective target: normalized instance URL (see config.ts for precedence). */
  readonly apiUrl: string;
  /** Where the target came from; reported by `bye instance show`, never mixed into output. */
  readonly source?: "BYE_API" | "saved" | "hosted";
  readonly token: string | undefined;
  readonly mailboxId: string | undefined;
  readonly calendarId: string | undefined;
}

export class CliApi extends Context.Service<
  CliApi,
  {
    readonly request: (
      method: Method,
      path: string,
      body?: RequestBody,
      query?: QueryParams,
    ) => Effect.Effect<JsonValue, CliApiError>;
    /** Raw byte upload (multipart upload parts). */
    readonly putBytes: (
      path: string,
      bytes: Uint8Array,
      query?: QueryParams,
    ) => Effect.Effect<JsonValue, CliApiError>;
    readonly config: CliConfig;
  }
>()("cli/CliApi") {}

/** API errors keep their HTTP status (exit codes); transport failures are status 0 (unavailable). */
const lift = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof ByeApiError
        ? new CliApiError({ status: error.status, code: error.code, message: error.message })
        : new CliApiError({ status: 0, code: "unavailable", message: String(error) }),
  });

export const cliApiLayer = (config: CliConfig, fetchImpl: FetchLike) => {
  const client = new ByeClient({
    origin: config.apiUrl,
    token: config.token,
    fetch: fetchImpl,
    headers: { "user-agent": "bye-cli/0.2" },
  });

  return Layer.succeed(CliApi, {
    config,
    putBytes: (path, bytes, query) =>
      lift(() =>
        client.raw<JsonValue>(
          "PUT",
          path,
          bytes,
          "application/octet-stream",
          query ? { query } : {},
        ),
      ),
    request: (method, path, body, query) =>
      lift(() => client.request<JsonValue>(method, path, body, query ? { query } : {})),
  });
};

/** Stable exit codes for scripts and agents. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
  rateLimited: 7,
  unavailable: 8,
} as const;

export const exitCodeFor = (error: CliApiError): number => {
  switch (error.status) {
    case 401:
      return EXIT.unauthenticated;
    case 403:
      return EXIT.forbidden;
    case 404:
      return EXIT.notFound;
    case 409:
      return EXIT.conflict;
    case 429:
      return EXIT.rateLimited;
    case 0:
    case 502:
    case 503:
    case 504:
      return EXIT.unavailable;
    default:
      return EXIT.failure;
  }
};
