import { Effect, type Layer, Predicate, Schema } from "effect";
import type { WorkflowStepConfig } from "cloudflare:workers";

// Cloudflare Workflows for checkpointed multi-step operations (§6). Each step runs a fresh, fully
// provided Effect and persists only its Schema-encoded result; no fibers, streams, or cursors cross
// a checkpoint (§7.4 Workflow steps). Step names are versioned (`v1:…`) and must stay stable: a
// renamed step re-runs for instances that were in flight when the new code deployed.

export const enc = new TextEncoder();

export const PART_BYTES = 8 * 1024 * 1024;

/** Thrown for parameters no deployed code version can run; Workflows must not retry it. */
export class WorkflowParamsError extends Error {
  override readonly name = "WorkflowParamsError";
}

/**
 * Decode versioned Workflow parameters at `run` (§15.9, P0 #12). Every params schema carries a
 * literal `v`; a payload from an older release keeps decoding as long as its version stays in the
 * schema, and an unknown version fails loudly instead of running with guessed fields.
 *
 * The one compatibility rule: instances created before payloads were versioned carry no `v` at
 * all, and decode as v1. Anything that does carry a `v` must match the schema exactly.
 *
 *   const Params = Schema.Union([Schema.Struct({ v: Schema.Literal(1), exportId: Schema.String }), …]);
 *   const params = decodeParams(Params)(event.payload);
 */
export const decodeParams =
  <S extends Schema.Codec<{ readonly v: number }, unknown>>(schema: S) =>
  <P>(payload: P): S["Type"] => {
    const versioned =
      Predicate.isObjectOrArray(payload) && !("v" in payload)
        ? Object.assign({}, payload, { v: 1 })
        : payload;

    try {
      return Schema.decodeUnknownSync(schema as never)(versioned) as S["Type"];
    } catch (error) {
      const v = (versioned as { v?: unknown } | null)?.v;
      throw new WorkflowParamsError(
        `unsupported workflow params (v=${String(v)}): ${error instanceof Error ? error.message.split("\n")[0] : "invalid"}`,
      );
    }
  };

/** Structural subset of `WorkflowStep` used here (keeps this module testable in Node). */
export interface StepRunner {
  do<T>(name: string, run: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, run: () => Promise<T>): Promise<T>;
}

/**
 * Run a fresh, fully provided Effect inside one durable step and persist only its
 * Schema-encoded result (§7.4 "Workflow steps"). On replay the checkpointed encoding is decoded
 * again, so step outputs keep a versioned wire shape instead of whatever object the code built.
 * Failures reject, so the Workflow's retry policy (or `config.retries`) applies.
 */
export const effectStep = async <A, I, E, R>(
  step: StepRunner,
  name: string,
  program: Effect.Effect<A, E, R>,
  options: {
    readonly schema: Schema.Codec<A, I, never, never>;
    readonly layer?: Layer.Layer<R>;
    readonly config?: WorkflowStepConfig;
  },
): Promise<A> => {
  const encode = Schema.encodeSync(options.schema);
  const decode = Schema.decodeUnknownSync(options.schema);

  const run = async (): Promise<I> => {
    const provided = (
      options.layer ? program.pipe(Effect.provide(options.layer)) : program
    ) as Effect.Effect<A, E, never>;

    return encode(await Effect.runPromise(provided));
  };

  const encoded =
    options.config === undefined
      ? await step.do(name, run)
      : await step.do(name, options.config, run);

  return decode(encoded);
};

/** Lift a Promise-returning operation into a step Effect with a tagged failure and a span. */
export const attemptStep = <A>(label: string, f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`),
  }).pipe(Effect.withSpan(`workflow.${label}`));

/** Shorthand: one versioned step whose body is a Promise-returning operation. */
export const promiseStep = <A, I>(
  step: StepRunner,
  name: string,
  schema: Schema.Codec<A, I>,
  f: () => Promise<A>,
  config?: WorkflowStepConfig,
): Promise<A> => {
  const effect = attemptStep(name.replace(/^v\d+:/, "").split(":")[0]!, f);

  return config !== undefined
    ? effectStep(step, name, effect, { schema, config })
    : effectStep(step, name, effect, { schema });
};
