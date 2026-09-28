// API and clients, inbound mail, scheduling, transport, observability (§15.4).
// MailCore is the single host for every authority namespace and Workflow class so namespace
// ownership is unambiguous (§15.3). The Public worker receives only published-content bindings.
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Redacted } from "effect";
import {
  EraseAccount,
  ExportAccount,
  Fanout,
  IngressJournals,
  Calendars,
  Mailboxes,
  Probe,
  Probes,
  ProvisionDomain,
  Reindex,
  SearchShards,
  SharedSpaces,
} from "./durable.ts";
import { queueBindings } from "./queues.ts";
import { MimeParser } from "./mime.ts";
import { Scanner } from "./scanner.ts";
import type { StageInfo } from "./stage.ts";
import { ConfigCache, Directory, Exports, Originals, Parts, Published } from "./storage.ts";

export { COMPATIBILITY } from "./compat.ts";
import { COMPATIBILITY } from "./compat.ts";
import { devServer } from "./dev.ts";

/** Independent reconciliation (§6): catalog probe every 5 minutes; retention sweep daily. */
export const CORE_CRONS = ["*/5 * * * *", "17 3 * * *"] as const;

/** Product notification sender. Transactional use only (§1, [C3]). */
export const TransactionalEmail = Cloudflare.Email.SendEmail("TransactionalEmail");

/** Abuse protection for signup, login, recovery, and public-link resolution (§3.1). */
export const AuthRateLimit = Cloudflare.RateLimit("AuthRateLimit", {
  namespaceId: 1001,
  simple: { limit: 20, period: 60 },
});
export const PublicRateLimit = Cloudflare.RateLimit("PublicRateLimit", {
  namespaceId: 1002,
  simple: { limit: 120, period: 60 },
});
/** Newsletter subscribe (confirmation mail to arbitrary addresses): far tighter than reads. */
export const SubscribeRateLimit = Cloudflare.RateLimit("SubscribeRateLimit", {
  namespaceId: 1003,
  simple: { limit: 5, period: 60 },
});

/**
 * MailCore bindings. Secrets are declared here, at construction, never first requested inside
 * `fetch` (§15.5). Management credentials (CLOUDFLARE_API_TOKEN) are never bound.
 */
export const coreEnv = {
  APP_ORIGIN: Config.String("APP_ORIGIN"),
  MAIL_ORIGIN: Config.String("MAIL_RENDER_ORIGIN"),
  DIRECTORY: Directory,
  ORIGINALS: Originals,
  PARTS: Parts,
  EXPORTS: Exports,
  PUBLISHED: Published,
  CONFIG_CACHE: ConfigCache,
  ...queueBindings,
  MAILBOXES: Mailboxes,
  CALENDARS: Calendars,
  SHARED_SPACES: SharedSpaces,
  SEARCH_SHARDS: SearchShards,
  INGRESS_JOURNALS: IngressJournals,
  PROVISION_DOMAIN: ProvisionDomain,
  EXPORT_ACCOUNT: ExportAccount,
  ERASE_ACCOUNT: EraseAccount,
  REINDEX: Reindex,
  FANOUT: Fanout,
  TRANSACTIONAL_EMAIL: TransactionalEmail,
  // Container-backed Durable Object namespace for attachment/upload scanning (§10).
  SCANNER: Scanner,
  MIME_PARSER: MimeParser,
  // Post-deploy async probes (§15.10); PROBE_TOKEN is an operator secret held only by CI probes.
  PROBES: Probes,
  PROBE_WORKFLOW: Probe,
  PROBE_TOKEN: Config.Redacted("PROBE_TOKEN"),
  // Preview mail sandbox (§15.8): set for preview stages only; empty = no sandbox.
  MAIL_SANDBOX_DOMAINS: Config.String("MAIL_SANDBOX_DOMAINS").pipe(Config.withDefault("")),
  // Ingress fault injection for §14.2 evidence; empty everywhere except explicit evidence runs.
  BYE_FAULT_INGRESS: Config.String("BYE_FAULT_INGRESS").pipe(Config.withDefault("")),
  AUTH_RATE_LIMIT: AuthRateLimit,
  SESSION_KEY: Config.Redacted("SESSION_KEY"),
  PROXY_SIGNING_KEY: Config.Redacted("PROXY_SIGNING_KEY"),
  BILLING_WEBHOOK_SECRET: Config.Redacted("BILLING_WEBHOOK_SECRET"),
  // Signing secret (>= 32 chars, `t=<unix>,v1=<hex>` scheme) for /webhooks/send-events, shared
  // only with a delivery-event source. Empty = every delivery event is refused.
  SEND_EVENTS_WEBHOOK_SECRET: Config.Redacted("SEND_EVENTS_WEBHOOK_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  TURNSTILE_SECRET: Config.Redacted("TURNSTILE_SECRET"),
  // Optional geocoder key for calendar location autocomplete (C10); empty disables the provider.
  LOCATION_API_KEY: Config.Redacted("LOCATION_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  // Optional per-environment transport/push/ops configuration (§5.3, §5.1 step 7). Empty = disabled.
  VAPID_PUBLIC_KEY: Config.String("VAPID_PUBLIC_KEY").pipe(Config.withDefault("")),
  VAPID_SUBJECT: Config.String("VAPID_SUBJECT").pipe(Config.withDefault("")),
  APNS_KEY_ID: Config.String("APNS_KEY_ID").pipe(Config.withDefault("")),
  APNS_TEAM_ID: Config.String("APNS_TEAM_ID").pipe(Config.withDefault("")),
  APNS_TOPIC: Config.String("APNS_TOPIC").pipe(Config.withDefault("")),
  FORWARDING_ENDPOINT: Config.String("FORWARDING_ENDPOINT").pipe(Config.withDefault("")),
  FORWARDING_DOMAIN: Config.String("FORWARDING_DOMAIN").pipe(Config.withDefault("")),
  ARC_SELECTOR: Config.String("ARC_SELECTOR").pipe(Config.withDefault("")),
  // Traffic classes MailTransport may dispatch in this stage (spec.md §5.3); empty = transactional
  // only. `personal` sends personal correspondence through the TransactionalEmail binding
  // (Cloudflare Email Sending), DKIM-signed with MAIL_DKIM_PRIVATE_KEY when set.
  MAIL_TRAFFIC_CLASSES: Config.String("MAIL_TRAFFIC_CLASSES").pipe(Config.withDefault("")),
  // Newsletter provider (spec.md §5.5). Empty provider or qualification evidence = newsletters blocked.
  NEWSLETTER_PROVIDER: Config.String("NEWSLETTER_PROVIDER").pipe(Config.withDefault("")),
  NEWSLETTER_ACCOUNT: Config.String("NEWSLETTER_ACCOUNT").pipe(Config.withDefault("")),
  NEWSLETTER_QUALIFIED: Config.String("NEWSLETTER_QUALIFIED").pipe(Config.withDefault("")),
  VAPID_PRIVATE_KEY: Config.Redacted("VAPID_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  APNS_KEY_P8: Config.Redacted("APNS_KEY_P8").pipe(Config.withDefault(Redacted.make(""))),
  FCM_SERVICE_ACCOUNT: Config.Redacted("FCM_SERVICE_ACCOUNT").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  FORWARDING_API_KEY: Config.Redacted("FORWARDING_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  SRS_SECRET: Config.Redacted("SRS_SECRET").pipe(Config.withDefault(Redacted.make(""))),
  ARC_SIGNING_KEY: Config.Redacted("ARC_SIGNING_KEY").pipe(Config.withDefault(Redacted.make(""))),
  NEWSLETTER_API_KEY: Config.Redacted("NEWSLETTER_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  NEWSLETTER_WEBHOOK_SECRET: Config.Redacted("NEWSLETTER_WEBHOOK_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  EXTERNAL_IDENTITY_SEAL_KEY: Config.Redacted("EXTERNAL_IDENTITY_SEAL_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  OPS_TOKEN: Config.Redacted("OPS_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
  // Control plane (O01, P01, A02, §10). Narrowly scoped, revocable Cloudflare tokens — never the
  // deployment management token. Empty = the corresponding automation is disabled (manual path).
  CF_DNS_API_TOKEN: Config.Redacted("CF_DNS_API_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
  CF_CACHE_PURGE_TOKEN: Config.Redacted("CF_CACHE_PURGE_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  CF_PUBLIC_ZONE_ID: Config.String("CF_PUBLIC_ZONE_ID").pipe(Config.withDefault("")),
  MAIL_WORKER_NAME: Config.String("MAIL_WORKER_NAME").pipe(Config.withDefault("")),
  MAIL_DKIM_PUBLIC_KEY: Config.String("MAIL_DKIM_PUBLIC_KEY").pipe(Config.withDefault("")),
  // PKCS#8 PEM private key for MAIL_DKIM_PUBLIC_KEY (selector `bye1`): signs outbound personal
  // mail. Empty = personal mail is not DKIM-signed by Bye.
  MAIL_DKIM_PRIVATE_KEY: Config.Redacted("MAIL_DKIM_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  BILLING_CHECKOUT_URL: Config.String("BILLING_CHECKOUT_URL").pipe(Config.withDefault("")),
  BILLING_API_KEY: Config.Redacted("BILLING_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  OPERATOR_USER_IDS: Config.String("OPERATOR_USER_IDS").pipe(Config.withDefault("")),
  // First-account bootstrap for onboarding installations (workers/core/src/bootstrap.ts). Empty = off.
  BOOTSTRAP_TOKEN: Config.Redacted("BOOTSTRAP_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
  // Address domain the bootstrap account must use (the zone chosen in onboarding). Non-secret; it
  // does not activate MX or Email Routing. Empty = any domain the signup rules accept.
  BOOTSTRAP_ADDRESS_DOMAIN: Config.String("BOOTSTRAP_ADDRESS_DOMAIN").pipe(Config.withDefault("")),
  // Onboarding-selected Cloudflare account and zone (non-secret installation metadata). Incoming
  // email activation binds the customer domain to exactly this zone. Empty on CI-managed stages.
  INSTALL_ACCOUNT_ID: Config.String("INSTALL_ACCOUNT_ID").pipe(Config.withDefault("")),
  INSTALL_ZONE_ID: Config.String("INSTALL_ZONE_ID").pipe(Config.withDefault("")),
  INSTALL_ZONE_NAME: Config.String("INSTALL_ZONE_NAME").pipe(Config.withDefault("")),
  // Seals the runtime newsletter provider credentials (newsletter-config.ts). 32 random bytes,
  // generated once by onboarding. Empty = runtime newsletter configuration unavailable.
  NEWSLETTER_CONFIG_SEAL_KEY: Config.Redacted("NEWSLETTER_CONFIG_SEAL_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  // Seals the owner-entered Cloudflare token scoped to the installation zone (zone-token.ts). 32
  // random bytes, generated once by onboarding. Empty = incoming email stays in manual-records mode.
  ZONE_TOKEN_SEAL_KEY: Config.Redacted("ZONE_TOKEN_SEAL_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
};

/**
 * Public worker bindings: published copies and rate limiting only. Share-link resolution goes
 * through a narrow service binding to MailCore, which rechecks grants per request (§11).
 */
export const publicEnvBase = {
  APP_ORIGIN: Config.String("APP_ORIGIN"),
  PUBLISHED: Published,
  PUBLIC_RATE_LIMIT: PublicRateLimit,
  SUBSCRIBE_RATE_LIMIT: SubscribeRateLimit,
  // Render origin (same value MailCore binds as MAIL_ORIGIN): published posts' proxied images.
  MAIL_ORIGIN: Config.String("MAIL_RENDER_ORIGIN"),
};

export { PRIVATE_BINDINGS, PUBLIC_SERVICE_BINDINGS } from "./bindings.ts";

/**
 * Self-hosted installations created by Cloudflare onboarding (spec.md §15.11) serve on
 * workers.dev under names fixed before the first deploy, so APP_ORIGIN and the render origin are
 * known up front. Unset for every CI-managed stage, whose names and surfaces stay unchanged.
 */
export interface WorkersDevInstall {
  /** Base Worker name: MailCore is `<name>`, PublicSite `<name>-site`, RenderOrigin `<name>-render`. */
  readonly name: string;
}

export const workersDevNames = (install: WorkersDevInstall) => ({
  core: install.name,
  site: `${install.name}-site`,
  render: `${install.name}-render`,
});

const workersDevFor = (stage: StageInfo, install?: WorkersDevInstall) =>
  // Nonproduction stages use synthetic data and may expose workers.dev; persistent stages
  // serve only through reviewed custom domains, unless this is an onboarding installation
  // without a custom domain. Version preview URLs stay off either way.
  stage.persistent && install === undefined ? false : { enabled: true, previewsEnabled: false };

/**
 * Structured application logs only (opaque IDs, §7.4 Observability). Automatic invocation logs are
 * off because they record full request URLs, and share/feed/render bearer tokens travel in paths.
 * beta.79's script upload does not carry `redactQueryString`, so it is not relied upon.
 * Every stage samples at 1: metric, DLQ and review log lines are the operational record, and head
 * sampling would drop them. Logpush stays off (`logpush: false`): it would export invocation
 * metadata (request URLs) to a third-party sink; persisted Workers Logs are the only sink.
 */
export const observabilityFor = (_stage: StageInfo): Cloudflare.WorkerObservability => ({
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, invocationLogs: false, persist: true },
  traces: { enabled: false },
});

/**
 * `canaryPercent` 1–99 deploys MailCore as a gradual rollout (session-affine, IP fallback); the
 * CI canary step (infra/policies/canary.ts) promotes to 100 or rolls back to 0 based on probes.
 */
export const makeCore = (
  stage: StageInfo,
  domain: string | undefined,
  sigmirror?: Cloudflare.Worker,
  canaryPercent?: number,
  install?: WorkersDevInstall,
) =>
  Cloudflare.Worker("MailCore", {
    ...(install === undefined ? {} : { name: workersDevNames(install).core }),
    main: "./workers/core/src/index.ts",
    compatibility: COMPATIBILITY,
    ...devServer("MailCore"),
    workersDev: workersDevFor(stage, install),
    ...(domain === undefined ? {} : { domain }),
    // Web/PWA shell (X01). API paths fall through to the Worker; assets carry no secrets.
    assets: {
      directory: "./apps/web/dist",
      runWorkerFirst: [
        "/v1/*",
        "/render/*",
        "/img",
        "/auth/*",
        "/oauth/*",
        "/feeds/*",
        "/webhooks/*",
      ],
    },
    crons: [...CORE_CRONS],
    logpush: false,
    observability: observabilityFor(stage),
    ...(canaryPercent !== undefined && canaryPercent >= 0 && canaryPercent < 100
      ? { version: { traffic: canaryPercent, affinity: { cookie: "__Host-session", ip: true } } }
      : {}),
    // SIGMIRROR is stack-wired (CORE_STACK_BINDINGS): scanner containers reach the private mirror
    // only through this service binding via interceptOutboundHttp.
    env: sigmirror ? { ...coreEnv, SIGMIRROR: sigmirror } : coreEnv,
  });

export const makePublic = (
  stage: StageInfo,
  domain: string | undefined,
  core: Cloudflare.Worker,
  install?: WorkersDevInstall,
) =>
  Cloudflare.Worker("PublicSite", {
    ...(install === undefined ? {} : { name: workersDevNames(install).site }),
    main: "./workers/public/src/index.ts",
    compatibility: COMPATIBILITY,
    ...devServer("PublicSite"),
    workersDev: workersDevFor(stage, install),
    ...(domain === undefined ? {} : { domain }),
    logpush: false,
    observability: observabilityFor(stage),
    env: { ...publicEnvBase, CORE: Cloudflare.WorkerEntrypoint(core, "PublicGateway") },
  });

/**
 * Separate render origin (§10) for workers.dev installations, which have no second custom
 * hostname: a forwarder whose only binding is MailCore. MailCore serves just `/render/*` and
 * `/img` on this host (MAIL_RENDER_ORIGIN), so the forwarder adds no new surface.
 */
export const makeRenderOrigin = (
  stage: StageInfo,
  core: Cloudflare.Worker,
  install: WorkersDevInstall,
) =>
  Cloudflare.Worker("RenderOrigin", {
    name: workersDevNames(install).render,
    main: "./workers/core/src/render-origin.ts",
    compatibility: COMPATIBILITY,
    ...devServer("RenderOrigin"),
    workersDev: workersDevFor(stage, install),
    logpush: false,
    observability: observabilityFor(stage),
    env: { CORE: core },
  });

export type CoreEnv = Cloudflare.InferEnv<typeof coreEnv>;
export type PublicEnv = Cloudflare.InferEnv<typeof publicEnvBase> & {
  readonly CORE: { fetch(request: Request): Promise<Response> };
};
