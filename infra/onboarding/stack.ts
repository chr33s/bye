// The hosted onboarding service (infra/onboarding/spec.md Part J): one Worker and one Durable Object
// in Bye's account, served at BYE_ONBOARDING_ORIGIN, else onboarding.<DOMAIN>. Separate from the MailboxPlatform stack: it is a
// single shared service, not a stage, and it never binds a management token (each installation's
// deploy runs in that installation's account through the operator's OAuth grant).
//
// Deployed only on its own (`pnpm deploy:onboarding`, or the opt-in CI job); `pnpm run deploy`
// never touches it.
//
// Usage: BYE_ONBOARDING_ORIGIN=https://bye.chr33s.dev … pnpm deploy:onboarding
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Redacted } from "effect";
import { COMPATIBILITY } from "../resources/compat.ts";
import { ONBOARDING_ORIGIN, parseDomain } from "../resources/domain.ts";
import { selectState } from "../state/client.ts";
import type { OnboardingDO } from "./worker/onboarding.ts";

export const OnboardingObjects = Cloudflare.DurableObject<OnboardingDO>("OnboardingObjects", {
  className: "OnboardingDO",
});

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

export default Alchemy.Stack(
  "ByeOnboarding",
  // Same state selection as the application stack: STATE_BACKEND=http in CI, else Cloudflare.state().
  { providers: Cloudflare.providers(), state: selectState() },
  Effect.gen(function* () {
    // An explicit origin wins (resources/domain.ts); only its host is used, served over https.
    const origin = yield* optional(ONBOARDING_ORIGIN);
    const domain = parseDomain(yield* optional("DOMAIN"));

    const host =
      origin !== ""
        ? new URL(origin).hostname
        : domain !== undefined
          ? `onboarding.${domain}`
          : undefined;

    if (host === undefined)
      return yield* Effect.die(
        new Error("set BYE_ONBOARDING_ORIGIN (e.g. https://bye.chr33s.dev) or DOMAIN"),
      );

    const worker = yield* Cloudflare.Worker("Onboarding", {
      name: "bye-onboarding",
      main: "./infra/onboarding/worker/onboarding.ts",
      // node:crypto (sealing, HMAC sessions, RSA key generation for installations).
      compatibility: { date: COMPATIBILITY.date, flags: ["nodejs_compat"] },
      domain: host,
      workersDev: false,
      logpush: false,
      // Invocation logs would record OAuth callback URLs (single-use codes); structured logs only.
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, invocationLogs: false, persist: true },
        traces: { enabled: false },
      },
      env: {
        ONBOARDING: OnboardingObjects,
        BYE_ONBOARDING_ORIGIN: `https://${host}`,
        BYE_ONBOARDING_KEYS: Config.Redacted("BYE_ONBOARDING_KEYS"),
        BYE_ONBOARDING_SESSION_KEY: Config.Redacted("BYE_ONBOARDING_SESSION_KEY"),
        BYE_ONBOARDING_DEPLOYER_KEY: Config.Redacted("BYE_ONBOARDING_DEPLOYER_KEY"),
        CLOUDFLARE_OAUTH_CLIENT_ID: Config.String("CLOUDFLARE_OAUTH_CLIENT_ID"),
        // Empty = a public client (PKCE only).
        CLOUDFLARE_OAUTH_CLIENT_SECRET: Config.Redacted("CLOUDFLARE_OAUTH_CLIENT_SECRET").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        BYE_ONBOARDING_ACCESS_TEAM_DOMAIN: optional("BYE_ONBOARDING_ACCESS_TEAM_DOMAIN"),
        BYE_ONBOARDING_ACCESS_AUD: optional("BYE_ONBOARDING_ACCESS_AUD"),
      },
    });

    return { url: `https://${host}`, workerName: worker.workerName };
  }),
);
