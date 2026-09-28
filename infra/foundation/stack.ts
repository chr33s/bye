// Foundation stack (§15.2): account-level infrastructure administered separately from the
// per-stage application stack. It owns the self-hosted deployment-state backend so the
// application stack can run with STATE_BACKEND=http and no third-party telemetry (§15.7).
//
// Bootstrap is an explicit, authorized operator action (§15.6, infra/RUNBOOK.md): this stack's
// own state is kept with alchemy's local state store, never the default Cloudflare state Worker,
// and the resulting `.alchemy/` directory is backed up by the operator.
import { stateBuildHash } from "../state/build-hash.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
import { Config, Effect, Redacted } from "effect";
import type { StateStoreObject } from "../state/worker.ts";
import { COMPATIBILITY } from "../resources/compat.ts";

export const StateStoreObjects = Cloudflare.DurableObject<StateStoreObject>("StateStoreObjects", {
  className: "StateStoreObject",
});

/** Encrypted daily snapshots; private, never force-emptied, retained on removal. */
export const StateBackups = Cloudflare.R2.Bucket("StateBackups", {
  forceDestroy: false,
  publicAccess: false,
});

export const stateEnv = {
  // One bare token, or per-stage grants (`prod=<t1>,staging|preview-*|dev-*=<t2>`; see
  // parseStateGrants in infra/state/core.ts) so nonprod CI can never reach prod state.
  STATE_TOKEN: Config.Redacted("BYE_STATE_TOKEN"),
  // Operator-only secret for /state/admin/{snapshot,restore} (state-drill-remote.md). Empty =
  // admin routes disabled. Never the same value as any STATE_TOKEN grant; never given to CI.
  STATE_ADMIN_TOKEN: Config.Redacted("BYE_STATE_ADMIN_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  // `v<n>:<64 hex>` entries, newest first; rotation prepends a version (RUNBOOK).
  STATE_ENCRYPTION_KEY: Config.Redacted("BYE_STATE_ENCRYPTION_KEY"),
  STATE: StateStoreObjects,
  BACKUPS: StateBackups,
  // CI's verify-worker.ts compares `/version` against the reviewed commit's source hash (§15.7).
  STATE_BUILD_HASH: stateBuildHash(),
};

export const makeStateWorker = (domain: string | undefined) => {
  const custom = domain ? { domain } : undefined;

  return Cloudflare.Worker("ByeStateStore", {
    main: "./infra/state/worker.ts",
    compatibility: COMPATIBILITY,
    // Reachable only through the reviewed custom domain; no workers.dev exposure.
    workersDev: false,
    logpush: false,
    observability: { enabled: true, headSamplingRate: 1 },
    ...custom,
    env: stateEnv,
  });
};

/**
 * Zone-level WAF (§15.4 protection and caching). The foundation owns each service zone's custom
 * firewall and rate-limiting phases; the application stack never declares zone-wide rulesets.
 * Rules are conservative defaults — probe paths and non-API methods — and are reviewed like code.
 */
export const WAF_RULES = [
  {
    description: "Block secret/dotfile probes",
    expression: `lower(http.request.uri.path) contains "/.env" or lower(http.request.uri.path) contains "/.git"`,
    action: "block",
  },
  {
    description: "Block unexpected methods",
    expression: `not http.request.method in {"GET" "HEAD" "POST" "PUT" "PATCH" "DELETE" "OPTIONS"}`,
    action: "block",
  },
] as const;

/** Paths whose abuse the Worker-side AuthRateLimit also bounds (signup, login, recovery, OAuth). */
export const AUTH_PATH_EXPRESSION = `starts_with(http.request.uri.path, "/auth/") or starts_with(http.request.uri.path, "/oauth/")`;

/**
 * Edge rate limiting for auth endpoints (`http_ratelimit` phase), replacing the deprecated
 * `cf.threat_score` challenge. Counted per client IP per colo, as every plan supports. The 10 s
 * period and mitigation timeout are the values every plan accepts; raise them on Pro/Business
 * zones. The Worker's own AuthRateLimit (20/min per key) still applies behind this.
 */
export const RATE_LIMIT_RULES = [
  {
    description: "Rate limit auth endpoints",
    expression: AUTH_PATH_EXPRESSION,
    action: "block",
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requestsPerPeriod: 20,
      mitigationTimeout: 10,
    },
  },
] as const;

/**
 * `BYE_SERVICE_ZONE` may list several zones (comma-separated: app, public and mail zones). The
 * first keeps the original logical IDs so an existing deployment is not replaced.
 */
export const serviceZones = (value: string): ReadonlyArray<{ name: string; id: string }> =>
  [
    ...new Set(
      value
        .split(",")
        .map((z) => z.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].map((name, i) => ({ name, id: i === 0 ? "" : `-${name.replace(/[^a-z0-9]+/g, "-")}` }));

export default Alchemy.Stack(
  "ByeFoundation",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const domain = yield* Config.String("BYE_STATE_DOMAIN").pipe(Config.withDefault(""));
    const retain = Alchemy.RemovalPolicy.retain(true);
    yield* StateBackups.pipe(retain);
    const worker = yield* makeStateWorker(domain || undefined).pipe(retain);
    // Adopt (never create) each service zone, then own its custom firewall and rate-limit phases.
    const zones = yield* Config.String("BYE_SERVICE_ZONE").pipe(Config.withDefault(""));

    for (const { name, id } of serviceZones(zones)) {
      const zone = yield* Cloudflare.Zone.Zone(`ServiceZone${id}`, { name }).pipe(retain);
      yield* Cloudflare.Ruleset.Ruleset(`WafRules${id}`, {
        zone,
        phase: "http_request_firewall_custom",
        rules: WAF_RULES.map((r) => ({ ...r })),
      }).pipe(retain);
      yield* Cloudflare.Ruleset.Ruleset(`AuthRateLimits${id}`, {
        zone,
        phase: "http_ratelimit",
        rules: RATE_LIMIT_RULES.map((r) => ({
          ...r,
          ratelimit: { ...r.ratelimit, characteristics: [...r.ratelimit.characteristics] },
        })),
      }).pipe(retain);
    }

    return { stateUrl: worker.url.as<string>() };
  }),
);
