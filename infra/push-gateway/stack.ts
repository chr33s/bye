// The native push gateway (workers/push-gateway, spec P1.7): one Worker in Bye's account, served at
// push.<DOMAIN>. It holds the app publisher's APNs key and FCM service account, which a self-hosted
// instance can't have, and relays instances' end-to-end encrypted Web Push to them. Separate from
// the MailboxPlatform stack: a single shared service, not a stage.
//
// Deployed only on its own (`pnpm deploy:push-gateway`, or the opt-in CI job); `pnpm run deploy`
// never touches it.
//
// Usage: DOMAIN=bye.software RELAY_SEAL_KEY=… APNS_…=… FCM_SERVICE_ACCOUNT=… pnpm deploy:push-gateway
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Redacted } from "effect";
import { COMPATIBILITY } from "../resources/compat.ts";
import { parseDomain } from "../resources/domain.ts";
import { selectState } from "../state/client.ts";

/** Registration mints sealed endpoints; per client address. */
export const RegisterRateLimit = Cloudflare.RateLimit("PushRegisterRateLimit", {
  namespaceId: 1101,
  simple: { limit: 30, period: 60 },
});

/** Relayed pushes per endpoint: bounds what one instance can send to one device. */
export const RelayRateLimit = Cloudflare.RateLimit("PushRelayRateLimit", {
  namespaceId: 1102,
  simple: { limit: 60, period: 60 },
});

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

export default Alchemy.Stack(
  "ByePushGateway",
  // Same state selection as the application stack: STATE_BACKEND=http in CI, else Cloudflare.state().
  { providers: Cloudflare.providers(), state: selectState() },
  Effect.gen(function* () {
    const domain = parseDomain(yield* Config.String("DOMAIN"));

    if (domain === undefined) return yield* Effect.die(new Error("set DOMAIN, e.g. bye.software"));
    const host = `push.${domain}`;

    const worker = yield* Cloudflare.Worker("PushGateway", {
      name: "bye-push-gateway",
      main: "./workers/push-gateway/src/index.ts",
      compatibility: { date: COMPATIBILITY.date },
      domain: host,
      workersDev: false,
      logpush: false,
      // Invocation logs would record relay URLs (sealed device tokens); structured logs only.
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, invocationLogs: false, persist: true },
        traces: { enabled: false },
      },
      env: {
        GATEWAY_ORIGIN: `https://${host}`,
        RELAY_SEAL_KEY: Config.Redacted("RELAY_SEAL_KEY"),
        REGISTER_RATE_LIMIT: RegisterRateLimit,
        RELAY_RATE_LIMIT: RelayRateLimit,
        // Either platform may be left unconfigured; its relays then answer 503 (retried by
        // instances, never counted against the device).
        APNS_KEY_P8: optionalSecret("APNS_KEY_P8"),
        APNS_KEY_ID: optional("APNS_KEY_ID"),
        APNS_TEAM_ID: optional("APNS_TEAM_ID"),
        APNS_TOPIC: optional("APNS_TOPIC"),
        FCM_SERVICE_ACCOUNT: optionalSecret("FCM_SERVICE_ACCOUNT"),
      },
    });

    return { url: `https://${host}`, workerName: worker.workerName };
  }),
);
