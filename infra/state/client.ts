// Stack-side selection of the self-hosted HTTP state backend (§15.6/§15.7).
// Uses alchemy's own HTTP state client, so the wire contract is the upstream one; only the
// server (infra/state/worker.ts) is ours. Credentials come from protected deploy config.
import { State } from "alchemy/State";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";

export type StateBackend = "cloudflare" | "http";

export const stateBackendFrom = (value: string | undefined): StateBackend => {
  if (value === undefined || value === "" || value === "cloudflare") return "cloudflare";

  if (value === "http") return "http";
  throw new Error(`STATE_BACKEND must be "cloudflare" or "http", got ${JSON.stringify(value)}`);
};

/** Telemetry-free state: alchemy's HTTP client against the foundation-owned state Worker. */
export const byeHttpState = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const url = yield* Config.String("BYE_STATE_URL");
      const token = yield* Config.Redacted("BYE_STATE_TOKEN");
      const context = yield* Effect.context<HttpClient.HttpClient>();

      return yield* Effect.cached(
        makeHttpStateStore({ url, authToken: Redacted.value(token), id: "bye-http" }).pipe(
          Effect.provideContext(context),
        ),
      );
    }).pipe(Effect.orDie),
  );

/** `STATE_BACKEND=http` selects the self-hosted backend; the default is `Cloudflare.state()`. */
export const selectState = (backend: StateBackend = stateBackendFrom(process.env.STATE_BACKEND)) =>
  backend === "http" ? byeHttpState() : Cloudflare.state();
