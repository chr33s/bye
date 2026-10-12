import { Effect, Schema } from "effect";
import { CORE } from "./capabilities.ts";
import type { Invocation } from "./request.ts";

// Typed JMAP client for Bye's own clients and tests. It speaks only the standard protocol: one
// POST per batch, ordered calls, result references by call ID (RFC 8620 §3).

export class JmapClientError extends Schema.TaggedError<JmapClientError>()("JmapClientError", {
  status: Schema.Number,
  type: Schema.String,
  detail: Schema.String,
}) {}

export interface Reference {
  readonly resultOf: string;
  readonly name: string;
  readonly path: string;
}

/** A result reference to an earlier call in the same batch (RFC 8620 §3.7). */
export const ref = (resultOf: string, name: string, path: string): Reference => ({
  resultOf,
  name,
  path,
});

const MethodResponse = Schema.Tuple([Schema.String, Schema.JsonObject, Schema.String]);

const Response = Schema.Struct({
  methodResponses: Schema.Array(MethodResponse),
  sessionState: Schema.String,
  createdIds: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const Problem = Schema.Struct({ type: Schema.String, detail: Schema.optional(Schema.String) });

export type JmapClientResponse = typeof Response.Type;

export interface JmapClientOptions {
  readonly apiUrl: string;
  readonly using: ReadonlyArray<string>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly headers?: { readonly [name: string]: string };
}

export class JmapBatch {
  private readonly calls: Array<Invocation> = [];

  /** Add a call; returns its call ID for result references. */
  call(name: string, args: Schema.JsonObject, callId = `c${this.calls.length}`): string {
    this.calls.push([name, args, callId]);

    return callId;
  }

  invocations(): ReadonlyArray<Invocation> {
    return this.calls;
  }
}

export const sendBatch = (options: JmapClientOptions, batch: JmapBatch) =>
  Effect.gen(function* () {
    const using = options.using.includes(CORE) ? options.using : [CORE, ...options.using];

    const response = yield* Effect.tryPromise({
      try: () =>
        options.fetch(
          new Request(options.apiUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...options.headers },
            body: JSON.stringify({ using, methodCalls: batch.invocations() }),
          }),
        ),
      catch: (e) => new JmapClientError({ status: 0, type: "network", detail: String(e) }),
    });

    const text = yield* Effect.promise(() => response.text());

    if (!response.ok) {
      const problem = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Problem))(text).pipe(
        Effect.orElseSucceed(() => ({ type: "http", detail: text.slice(0, 200) })),
      );

      return yield* new JmapClientError({
        status: response.status,
        type: problem.type,
        detail: problem.detail ?? "",
      });
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Response))(text).pipe(
      Effect.mapError(
        () =>
          new JmapClientError({
            status: response.status,
            type: "notResponse",
            detail: "response is not a JMAP Response",
          }),
      ),
    );
  });
