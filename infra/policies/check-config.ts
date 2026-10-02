// Stage config/secret presence check for deploy jobs (§15.5). Names are discovered from the
// stack's own declarations — `Config.String("X")`, `Config.Redacted("Y")` (required unless piped
// through `Config.withDefault`) and the stack's `optional("Z")` reads — so a newly declared name
// cannot be forgotten: required ones must be present at deploy time, and every declared name
// must be mapped into the CI deploy environment (optional ones may still resolve empty). Values
// are never printed — only names.
//
// Usage: node --experimental-strip-types infra/policies/check-config.ts   (exit 1 lists missing names)
import { Predicate } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { domainDefaults, parseDomain } from "../resources/domain.ts";
import { PREBUILT_IMAGE_ENV, prebuiltImage } from "../resources/container-images.ts";
import { SCANNER_DEPLOY_ENV, scannerSignatureSource } from "../resources/scanner-source.ts";
import { classifyStage } from "../resources/stage.ts";

export interface ConfigName {
  readonly name: string;
  readonly secret: boolean;
  readonly optional: boolean;
}

const DECLARATION =
  /Config\.(String|Redacted|Number|Boolean|Url|Integer)\(\s*"([A-Z0-9_]+)"\s*\)(\s*\.pipe\(\s*Config\.withDefault)?/g;

/** The stack's `optional("NAME")` and `domainHost("NAME")` helpers (Strings that may resolve empty). */
const OPTIONAL_READ = /\b(?:optional|domainHost)\(\s*"([A-Z0-9_]+)"\s*\)/g;

export const scanConfig = (source: string): ReadonlyArray<ConfigName> => [
  ...[...source.matchAll(DECLARATION)].map((m) => ({
    name: m[2]!,
    secret: m[1] === "Redacted",
    optional: m[3] !== undefined,
  })),
  ...[...source.matchAll(OPTIONAL_READ)].map((m) => ({
    name: m[1]!,
    secret: false,
    optional: true,
  })),
];

/** Every declared name, required and optional (secret if declared secret anywhere). */
export const declaredConfig = (
  dir = join(import.meta.dirname, "../resources"),
): ReadonlyArray<ConfigName> => {
  const found = new Map<string, ConfigName>();

  const files = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f)),
    join(dir, "../stack.ts"),
  ];

  for (const file of files) {
    for (const c of scanConfig(readFileSync(file, "utf8"))) {
      const prior = found.get(c.name);
      // Required anywhere → required.
      found.set(
        c.name,
        prior
          ? { ...c, optional: prior.optional && c.optional, secret: prior.secret || c.secret }
          : c,
      );
    }
  }

  // Deploy-time names the stack reads from process.env rather than a Config declaration.
  for (const name of [...SCANNER_DEPLOY_ENV, ...PREBUILT_IMAGE_ENV])
    if (!found.has(name)) found.set(name, { name, secret: false, optional: true });

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const requiredConfig = (
  dir = join(import.meta.dirname, "../resources"),
): ReadonlyArray<ConfigName> => declaredConfig(dir).filter((c) => !c.optional);

/**
 * Declared names deliberately NOT mapped into CI deploy jobs: evidence-only switches that are set
 * by hand on a dedicated `dev-*` evidence stage (EVIDENCE.md §14.2), never by the pipeline, and
 * the workers.dev installation name and first-account bootstrap token that only Cloudflare
 * onboarding sets (infra/onboarding). DOMAIN is mapped only into the staging/prod release and
 * drift jobs: it has no defaults for preview stages, whose per-PR hosts come from PREVIEW_DOMAIN.
 */
export const CI_UNMAPPED: ReadonlyArray<string> = [
  "BYE_FAULT_INGRESS",
  "BYE_WORKERS_DEV_NAME",
  "BOOTSTRAP_TOKEN",
  "BOOTSTRAP_ADDRESS_DOMAIN",
  "INSTALL_ACCOUNT_ID",
  "INSTALL_ZONE_ID",
  "INSTALL_ZONE_NAME",
  "NEWSLETTER_CONFIG_SEAL_KEY",
  "ZONE_TOKEN_SEAL_KEY",
  // Prebuilt MIME/SigMirror images: onboarding deploys from hosts without Docker (§45); CI builds.
  ...PREBUILT_IMAGE_ENV,
];

/**
 * Declared names that the CI workflow never maps into any job environment (`  NAME: …`). An
 * unmapped optional name is silently empty on every deployed stage, which turns features off
 * without anyone deciding so.
 */
export const unmappedInCi = (
  ciWorkflow: string,
  names: ReadonlyArray<ConfigName> = declaredConfig(),
): ReadonlyArray<string> =>
  names.flatMap((c) =>
    !CI_UNMAPPED.includes(c.name) && !new RegExp(`^\\s+${c.name}:\\s`, "m").test(ciWorkflow)
      ? [c.name]
      : [],
  );

/**
 * Secrets the PR-executed `preview`/`preview-destroy` jobs may resolve (besides the tiered
 * NONPROD Cloudflare and state credentials): the required runtime secrets (`requiredConfig`) plus
 * the send-events webhook secret. Every other optional application secret is pinned to "" in the
 * preview env, so PR code never sees a DNS/cache-purge token, a signing key or a provider API key
 * (RUNBOOK "Previews": runtime secrets are environment-scoped with preview-only values).
 */
export const PREVIEW_OPTIONAL_SECRETS: ReadonlyArray<string> = ["SEND_EVENTS_WEBHOOK_SECRET"];

/** Tiered deploy credentials the preview job resolves by their nonprod names. */
export const PREVIEW_DEPLOY_SECRETS: ReadonlyArray<string> = [
  "BYE_STATE_TOKEN",
  "NONPROD_CF_LOCK_CREDENTIAL",
  "NONPROD_CLOUDFLARE_ACCOUNT_ID",
  "NONPROD_CLOUDFLARE_API_TOKEN",
];

/** `secrets.X` names referenced by a workflow job's text that previews must not resolve. */
export const previewSecretOverreach = (
  jobText: string,
  names: ReadonlyArray<ConfigName> = declaredConfig(),
): ReadonlyArray<string> => {
  const allowed = new Set([
    ...names.flatMap((c) => (!c.optional && c.secret ? [c.name] : [])),
    ...PREVIEW_OPTIONAL_SECRETS,
    ...PREVIEW_DEPLOY_SECRETS,
  ]);

  const used = [...jobText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!);

  return [...new Set(used)].filter((n) => !allowed.has(n)).sort();
};

/**
 * Credentials that let the platform send mail to arbitrary recipients. Personal mail itself needs
 * no credential (it uses the Cloudflare sending binding once MAIL_TRAFFIC_CLASSES enables
 * `personal`); its DKIM key is listed so a stage that signs as a real domain is treated as mailing.
 */
export const MAIL_CREDENTIALS: ReadonlyArray<string> = [
  "MAIL_DKIM_PRIVATE_KEY",
  "NEWSLETTER_API_KEY",
  "FORWARDING_API_KEY",
  "EXTERNAL_IDENTITY_SEAL_KEY",
];

/** Traffic classes that mail arbitrary recipients without any credential of their own. */
export const CREDENTIAL_FREE_CLASSES: ReadonlyArray<string> = ["personal"];

const enabledClasses = (env: Readonly<Record<string, string | undefined>>) =>
  new Set(
    (env.MAIL_TRAFFIC_CLASSES ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  );

/**
 * Preview mail sandbox (§15.8): on ephemeral stages (preview-*, dev-*) any mail credential, or a
 * credential-free class such as `personal` in MAIL_TRAFFIC_CLASSES, makes a non-empty
 * MAIL_SANDBOX_DOMAINS mandatory, otherwise a preview could mail real people. Returns the names
 * that are set without a sandbox (`MAIL_TRAFFIC_CLASSES=<class>` for classes).
 */
export const unsandboxedMail = (
  env: Readonly<Record<string, string | undefined>>,
  stage = env.STAGE ?? "",
): ReadonlyArray<string> => {
  const classified = classifyStage(stage);

  if (!Predicate.isTagged(classified, "Valid") || classified.stage.persistent) return [];

  if ((env.MAIL_SANDBOX_DOMAINS ?? "").trim() !== "") return [];
  const classes = enabledClasses(env);

  return [
    ...MAIL_CREDENTIALS.filter((n) => (env[n] ?? "").trim() !== ""),
    ...CREDENTIAL_FREE_CLASSES.flatMap((c) =>
      classes.has(c) ? [`MAIL_TRAFFIC_CLASSES=${c}`] : [],
    ),
  ];
};

/** The environment the stack sees: absent names filled from DOMAIN (infra/resources/domain.ts). */
export const withDomainDefaults = (env: Readonly<Record<string, string | undefined>>) => ({
  ...env,
  ...domainDefaults(env),
});

export const missingConfig = (
  env: Readonly<Record<string, string | undefined>>,
  names = requiredConfig(),
): ReadonlyArray<string> => {
  const resolved = withDomainDefaults(env);

  return names
    .filter((c) => !resolved[c.name] || resolved[c.name]!.trim() === "")
    .map((c) => c.name);
};

/** A malformed DOMAIN (a scheme, port or path instead of a bare hostname). */
export const domainProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  try {
    parseDomain(env.DOMAIN);

    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
};

/**
 * HMAC webhook secrets verified in the `t=<unix>,v1=<hex>` scheme. The worker refuses every
 * delivery when one is shorter than MIN_WEBHOOK_SECRET_LENGTH (packages/platform-cloudflare
 * control/billing.ts), so a short value is a silent outage: refuse it at deploy time instead.
 * Empty is allowed (the feature is off).
 */
export const WEBHOOK_SECRETS: ReadonlyArray<string> = [
  "BILLING_WEBHOOK_SECRET",
  "SEND_EVENTS_WEBHOOK_SECRET",
];

export const MIN_WEBHOOK_SECRET_LENGTH = 32;

export const webhookSecretProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> =>
  WEBHOOK_SECRETS.flatMap((n) => {
    const v = (env[n] ?? "").trim();

    return v !== "" && v.length < MIN_WEBHOOK_SECRET_LENGTH
      ? [`${n} is shorter than ${MIN_WEBHOOK_SECRET_LENGTH} characters`]
      : [];
  });

/**
 * SCANNER_SIGNATURES/SCANNER_IMAGE and the prebuilt MIME/SigMirror images, validated with the
 * stack's own rules before any plan.
 */
export const scannerProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> =>
  [
    () => scannerSignatureSource(env),
    ...PREBUILT_IMAGE_ENV.map((n) => () => prebuiltImage(env, n)),
  ].flatMap((check) => {
    try {
      check();

      return [];
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
  });

/** Test/fault switches that must never reach shared stages (EVIDENCE.md §14.2, preview mail sandbox). */
export const FORBIDDEN_ON_PROD: ReadonlyArray<string> = [
  "BYE_FAULT_INGRESS",
  "MAIL_SANDBOX_DOMAINS",
];

export const forbiddenConfig = (
  env: Readonly<Record<string, string | undefined>>,
  stage = env.STAGE ?? "",
): ReadonlyArray<string> =>
  stage === "prod" || stage === "staging"
    ? FORBIDDEN_ON_PROD.filter((n) => (env[n] ?? "").trim() !== "")
    : [];

/**
 * Provider sent-email previews (§10, `PROVIDER_PREVIEW_POLICY` in
 * packages/platform-cloudflare/src/control/sending.ts): private mail must not be kept or shown by
 * the sending provider's dashboard. No provider API exposes the setting, so the operator turns it
 * off in the provider console (RUNBOOK "Provider sent-email previews") and records that in the
 * stage's protected config as PROVIDER_SENT_PREVIEWS=disabled. Shared stages that hold a mail
 * credential refuse to deploy without that attestation.
 */
export const PROVIDER_PREVIEW_ATTESTATION = {
  name: "PROVIDER_SENT_PREVIEWS",
  value: "disabled",
} as const;

export const missingPreviewAttestation = (
  env: Readonly<Record<string, string | undefined>>,
  stage = env.STAGE ?? "",
): boolean => {
  const classified = classifyStage(stage);

  if (!Predicate.isTagged(classified, "Valid") || !classified.stage.persistent) return false;
  const classes = enabledClasses(env);

  if (
    !MAIL_CREDENTIALS.some((n) => (env[n] ?? "").trim() !== "") &&
    !CREDENTIAL_FREE_CLASSES.some((c) => classes.has(c))
  )
    return false;

  return (
    (env[PROVIDER_PREVIEW_ATTESTATION.name] ?? "").trim() !== PROVIDER_PREVIEW_ATTESTATION.value
  );
};

if (import.meta.main) {
  const domain = domainProblems(process.env);

  for (const problem of domain) console.error(`config: ${problem}`);

  if (domain.length) process.exit(1);
  const missing = missingConfig(process.env);

  for (const name of missing) console.error(`config: ${name} is not set`);
  const forbidden = forbiddenConfig(process.env);

  for (const name of forbidden)
    console.error(`config: ${name} must not be set on ${process.env.STAGE}`);
  const unsandboxed = unsandboxedMail(process.env);

  for (const name of unsandboxed)
    console.error(
      `config: ${name} is set on ${process.env.STAGE} but MAIL_SANDBOX_DOMAINS is empty (§15.8)`,
    );
  const attestation = missingPreviewAttestation(process.env);

  if (attestation)
    console.error(
      `config: ${PROVIDER_PREVIEW_ATTESTATION.name} must be "${PROVIDER_PREVIEW_ATTESTATION.value}" on ${process.env.STAGE} (provider sent-email previews off, §10)`,
    );
  const pairing = [...webhookSecretProblems(process.env), ...scannerProblems(process.env)];

  for (const problem of pairing) console.error(`config: ${problem}`);

  if (missing.length || forbidden.length || unsandboxed.length || attestation || pairing.length)
    process.exit(1);
  console.log(`config: ${requiredConfig().length} required names present`);
}
