// Instance newsletter provider configuration (infra/onboarding/spec.md §23): a status any signed-in user
// may read (configured / not configured / unavailable, no secrets), and a setup that only a platform
// operator with a recent step-up may perform: once, or again to repair a stored configuration that
// can no longer be used. A usable configuration is never replaced here. The API key is write-only.
import { Authorization, requireOperatorAccess, requireStepUp } from "@bye/application";
import { ApiError } from "@bye/contracts";
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Invocation } from "../http.ts";
import { publicly } from "../httpapi.ts";
import { configureNewsletterProvider, newsletterConfigView } from "../newsletter-config.ts";
import { CoreApi } from "../spec/index.ts";
import { requireUser } from "./common.ts";

export const NewsletterConfigHandlers = HttpApiBuilder.group(
  CoreApi,
  "newsletterConfig",
  (handlers) =>
    handlers
      .handle("status", () =>
        Effect.gen(function* () {
          const { env } = yield* Invocation;
          const principal = yield* requireUser("read");
          const isOperator = (yield* Authorization).isOperator(principal.userId);

          return yield* Effect.promise(() => newsletterConfigView(env, isOperator));
        }).pipe(publicly),
      )
      .handle("configure", ({ payload }) =>
        Effect.gen(function* () {
          const { env } = yield* Invocation;
          const operator = yield* requireOperatorAccess();
          yield* requireStepUp("admin");

          const result = yield* Effect.promise(() =>
            configureNewsletterProvider(env, {
              provider: payload.provider,
              apiKey: payload.apiKey.trim(),
              actorId: operator.userId,
            }),
          );

          return yield* Match.value(result).pipe(
            Match.tagsExhaustive({
              Rejected: (rejected) =>
                new ApiError({ code: rejected.code, message: rejected.message }),
              NeedsAttention: (attention) =>
                new ApiError({ code: "unavailable", message: attention.message }),
              Ready: () => Effect.promise(() => newsletterConfigView(env, true)),
            }),
          );
        }).pipe(publicly),
      ),
);
