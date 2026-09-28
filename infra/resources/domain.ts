// One base domain instead of a value per host. Each shared stage gets its own base, so staging can
// never claim production's hosts (Worker custom domains are exclusive):
//
//   stage     base                      APP_ORIGIN / APP_DOMAIN        MAIL_RENDER_ORIGIN
//   prod      example.com               https://app.example.com         https://mail.example.com
//   staging   staging.example.com       https://app.staging.example.com https://mail.staging.example.com
//
// PUBLIC_DOMAIN defaults to the base itself (workers/core origins.ts derives the public origin and
// service domain from APP_ORIGIN the same way, by dropping `app.`). MAIL_ZONE defaults to DOMAIN
// on prod only, since a Cloudflare zone is the registered domain, not a stage subdomain; Email
// Routing still waits for BYE_MX_CUTOVER=approved. BYE_ONBOARDING_ORIGIN belongs to the one shared
// onboarding service, not a stage: https://onboarding.example.com.
//
// dev-* and preview-* stages get nothing from DOMAIN: their hosts are per developer or per PR
// (CI sets them from PREVIEW_DOMAIN; `pnpm dev` uses localhost), so they must be set explicitly.
//
// The stage is read from STAGE, the same variable the package scripts pass to `--stage`; the stack
// refuses to deploy when DOMAIN is set and the two differ (infra/stack.ts).
//
// A variable with a value always wins. An empty one counts as unset, because Effect's Config reads
// "" as missing, so empty cannot switch a DOMAIN default off. That is safe because DOMAIN never
// reaches the places that rely on empty meaning off: previews and the ephemeral CI jobs get no
// DOMAIN defaults (only the staging/prod jobs map it) and onboarding blanks it for installations
// (executor FORCED_EMPTY).
import { Config, ConfigProvider, Effect } from "effect";

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

export const DOMAIN_ORIGINS = { APP_ORIGIN: "app", MAIL_RENDER_ORIGIN: "mail" } as const;
export const DOMAIN_HOSTS = { APP_DOMAIN: "app", PUBLIC_DOMAIN: "" } as const;
export const ONBOARDING_ORIGIN = "BYE_ONBOARDING_ORIGIN";

export type DomainOrigin = keyof typeof DOMAIN_ORIGINS;
export type DomainHost = keyof typeof DOMAIN_HOSTS | "MAIL_ZONE";

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The base domain, or undefined when unset/empty. A scheme, port or path is refused, not stripped. */
export const parseDomain = (raw: string | undefined): string | undefined => {
  const domain = (raw ?? "").trim().toLowerCase();
  if (domain === "") return undefined;
  if (!HOSTNAME.test(domain))
    throw new Error(`DOMAIN must be a bare hostname like example.com, got ${JSON.stringify(raw)}`);
  return domain;
};

/** The stage's base domain: DOMAIN for prod, staging.DOMAIN for staging, none otherwise. */
export const stageBase = (domain: string, stage: string | undefined): string | undefined =>
  stage === "prod" ? domain : stage === "staging" ? `staging.${domain}` : undefined;

const host = (base: string, sub: string) => (sub === "" ? base : `${sub}.${base}`);
export const originFor = (base: string, name: DomainOrigin) =>
  `https://${host(base, DOMAIN_ORIGINS[name])}`;

/** Hostname defaults for a stage; MAIL_ZONE only on prod. */
export const hostFor = (domain: string, stage: string | undefined, name: DomainHost) => {
  if (name === "MAIL_ZONE") return stage === "prod" ? domain : undefined;
  const base = stageBase(domain, stage);
  return base === undefined ? undefined : host(base, DOMAIN_HOSTS[name]);
};

const unset = (v: string | undefined) => (v ?? "").trim() === "";

/**
 * Defaults for scripts that read process.env (build:web, check-config, onboarding): only the
 * unset or empty names, matching the stack. Spread it after `env`.
 */
export const domainDefaults = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const domain = parseDomain(env.DOMAIN);
  if (domain === undefined) return {};
  const out: Record<string, string> = {};
  if (unset(env[ONBOARDING_ORIGIN])) out[ONBOARDING_ORIGIN] = `https://onboarding.${domain}`;
  const base = stageBase(domain, env.STAGE);
  if (base === undefined) return out;
  for (const name of Object.keys(DOMAIN_ORIGINS) as Array<DomainOrigin>)
    if (unset(env[name])) out[name] = originFor(base, name);
  for (const name of [...Object.keys(DOMAIN_HOSTS), "MAIL_ZONE"] as Array<DomainHost>) {
    const value = hostFor(domain, env.STAGE, name);
    if (value !== undefined && unset(env[name])) out[name] = value;
  }
  return out;
};

const domainConfig = Config.String("DOMAIN").pipe(
  Config.withDefault(""),
  Config.mapEffect((raw) =>
    Effect.try({
      try: () => parseDomain(raw),
      catch: (e) => configError((e as Error).message),
    }),
  ),
);
const stageConfig = Config.String("STAGE").pipe(Config.withDefault(""));
const domainAndStage = Config.all({ domain: domainConfig, stage: stageConfig });

/** Stack form of an origin: the explicit value, else derived from DOMAIN for prod/staging, else required. */
export const originConfig = (own: Config.Config<string>, name: DomainOrigin) =>
  own.pipe(
    Config.orElse(() =>
      domainAndStage.pipe(
        Config.mapEffect(({ domain, stage }) => {
          const base = domain === undefined ? undefined : stageBase(domain, stage);
          return base === undefined
            ? Effect.fail(configError(`${name} is not set (DOMAIN covers only prod and staging)`))
            : Effect.succeed(originFor(base, name));
        }),
      ),
    ),
  );

/** Stack form of a hostname: the explicit value, else derived from DOMAIN for prod/staging, else "". */
export const hostConfig = (own: Config.Config<string>, name: DomainHost) =>
  own.pipe(
    Config.orElse(() =>
      domainAndStage.pipe(
        Config.map(({ domain, stage }) =>
          domain === undefined ? "" : (hostFor(domain, stage, name) ?? ""),
        ),
      ),
    ),
  );

/**
 * Config check for the stack: DOMAIN defaults are computed from STAGE, so when DOMAIN is set,
 * STAGE must name the stage being deployed. Returns a reason to refuse, or undefined.
 */
export const domainStageMismatch = Config.all({ domain: domainConfig, stage: stageConfig }).pipe(
  Config.map(
    ({ domain, stage }) =>
      (stageName: string) =>
        domain !== undefined && stage !== stageName
          ? `DOMAIN is set but STAGE (${JSON.stringify(stage)}) does not match the deployed stage ${stageName}; set STAGE=${stageName}`
          : undefined,
  ),
);
