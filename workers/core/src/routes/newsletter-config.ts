// Instance newsletter provider configuration (infra/onboarding/spec.md §23): a status any signed-in user
// may read (configured / not configured / unavailable, no secrets), and a setup that only a platform
// operator with a recent step-up may perform: once, or again to repair a stored configuration that
// can no longer be used. A usable configuration is never replaced here. The API key is write-only.
import { Authorization, requireOperatorAccess, requireStepUp } from "@bye/application";
import { ApiError, NewsletterConfigRequest } from "@bye/contracts";
import { Effect } from "effect";
import type { CoreEnv } from "../env.ts";
import { route, type Route } from "../http.ts";
import { configureNewsletterProvider, newsletterConfigView } from "../newsletter-config.ts";
import { authed, authedBody, requireUser } from "./common.ts";

export const newsletterConfigRoutes: ReadonlyArray<Route<CoreEnv>> = [
  route(
    "GET",
    "/v1/newsletter/config",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireUser("read");
        const isOperator = (yield* Authorization).isOperator(principal.userId);
        return yield* Effect.promise(() => newsletterConfigView(env, isOperator));
      }),
    ),
  ),
  route(
    "POST",
    "/v1/newsletter/config",
    authedBody(NewsletterConfigRequest, ({ env, body }) =>
      Effect.gen(function* () {
        const operator = yield* requireOperatorAccess();
        yield* requireStepUp("admin");
        const result = yield* Effect.promise(() =>
          configureNewsletterProvider(env, {
            provider: body.provider,
            apiKey: body.apiKey.trim(),
            actorId: operator.userId,
          }),
        );
        switch (result._tag) {
          case "Rejected":
            return yield* new ApiError({ code: result.code, message: result.message });
          case "NeedsAttention":
            return yield* new ApiError({ code: "unavailable", message: result.message });
          case "Ready":
            return yield* Effect.promise(() => newsletterConfigView(env, true));
        }
      }),
    ),
  ),
];
