// Stage config/secret presence check for deploy jobs (§15.5). Names are discovered from the
// stack's own declarations — `Config.String("X")`, `Config.Redacted("Y")` (required unless piped
// through `Config.withDefault`) and the stack's `optional("Z")` reads — so a newly declared name
// cannot be forgotten: required ones must be present at deploy time, and every declared name
// must be mapped into the CI deploy environment (optional ones may still resolve empty). Values
// are never printed — only names.
//
// Usage: node --experimental-strip-types infra/policies/check-config.ts   (exit 1 lists missing names)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCANNER_DEPLOY_ENV, scannerSignatureSource } from "../resources/scanner-source.ts";
import { classifyStage } from "../resources/stage.ts";

export interface ConfigName {
  readonly name: string;
  readonly secret: boolean;
  readonly optional: boolean;
}

const DECLARATION =
  /Config\.(String|Redacted|Number|Boolean|Url|Integer)\(\s*"([A-Z0-9_]+)"\s*\)(\s*\.pipe\(\s*Config\.withDefault)?/g;

/** The stack's `optional("NAME")` helper (a String with an empty default). */
const OPTIONAL_READ = /\boptional\(\s*"([A-Z0-9_]+)"\s*\)/g;

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
  for (const name of SCANNER_DEPLOY_ENV)
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
 * onboarding sets (infra/onboarding).
 */
export const CI_UNMAPPED: ReadonlyArray<string> = [
  "BYE_FAULT_INGRESS",
  "BYE_WORKERS_DEV_NAME",
  "BOOTSTRAP_TOKEN",
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
  names
    .filter((c) => !CI_UNMAPPED.includes(c.name))
    .filter((c) => !new RegExp(`^\\s+${c.name}:\\s`, "m").test(ciWorkflow))
    .map((c) => c.name);

/**
 * Secrets the PR-executed `preview`/`preview-destroy` jobs may resolve (besides the tiered
 * NONPROD Cloudflare and state credentials): the required runtime secrets (`requiredConfig`) plus
 * the sandboxed personal-mail pair. Every other optional application secret is pinned to "" in the
 * preview env, so PR code never sees a DNS/cache-purge token, a signing key or a provider API key
 * (RUNBOOK "Previews": runtime secrets are environment-scoped with preview-only values).
 */
export const PREVIEW_OPTIONAL_SECRETS: ReadonlyArray<string> = [
  "PERSONAL_MAIL_API_KEY",
  "SEND_EVENTS_WEBHOOK_SECRET",
];

/** Tiered deploy credentials the preview job resolves by their nonprod names. */
export const PREVIEW_DEPLOY_SECRETS: ReadonlyArray<string> = [
  "BYE_STATE_TOKEN",
  "NONPROD_CLOUDFLARE_ACCOUNT_ID",
  "NONPROD_CLOUDFLARE_API_TOKEN",
];

/** `secrets.X` names referenced by a workflow job's text that previews must not resolve. */
export const previewSecretOverreach = (
  jobText: string,
  names: ReadonlyArray<ConfigName> = declaredConfig(),
): ReadonlyArray<string> => {
  const allowed = new Set([
    ...names.filter((c) => !c.optional && c.secret).map((c) => c.name),
    ...PREVIEW_OPTIONAL_SECRETS,
    ...PREVIEW_DEPLOY_SECRETS,
  ]);
  const used = [...jobText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
  return [...new Set(used)].filter((n) => !allowed.has(n)).sort();
};

/** Credentials that let the platform send mail to arbitrary recipients. */
export const MAIL_CREDENTIALS: ReadonlyArray<string> = [
  "PERSONAL_MAIL_API_KEY",
  "NEWSLETTER_API_KEY",
  "FORWARDING_API_KEY",
  "EXTERNAL_IDENTITY_SEAL_KEY",
];

/**
 * Preview mail sandbox (§15.8): on ephemeral stages (preview-*, dev-*) any mail credential makes
 * a non-empty MAIL_SANDBOX_DOMAINS mandatory, otherwise a preview could mail real people. Returns
 * the credential names that are set without a sandbox.
 */
export const unsandboxedMail = (
  env: Readonly<Record<string, string | undefined>>,
  stage = env.STAGE ?? "",
): ReadonlyArray<string> => {
  const classified = classifyStage(stage);
  if (classified._tag !== "Valid" || classified.stage.persistent) return [];
  if ((env.MAIL_SANDBOX_DOMAINS ?? "").trim() !== "") return [];
  return MAIL_CREDENTIALS.filter((n) => (env[n] ?? "").trim() !== "");
};

export const missingConfig = (
  env: Readonly<Record<string, string | undefined>>,
  names = requiredConfig(),
): ReadonlyArray<string> =>
  names.filter((c) => !env[c.name] || env[c.name]!.trim() === "").map((c) => c.name);

/** Hosts that can never accept mail: RFC 2606 reserved names and loopback. */
const PLACEHOLDER_HOST =
  /(^|\.)(invalid|example|test|localhost)$|(^|\.)example\.(com|net|org)$|^127\.|^\[?::1\]?$/;

/**
 * Personal-mail transport pairing (§15.5): the credential and the submission endpoint are set
 * together or not at all, and the endpoint is a real https host. A key with no endpoint (or a
 * placeholder one) would make every personal send fail at the provider; an endpoint with no key
 * is a half-configured provider. Returns the problems, by name only.
 */
export const personalMailProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const key = (env.PERSONAL_MAIL_API_KEY ?? "").trim();
  const endpoint = (env.PERSONAL_MAIL_ENDPOINT ?? "").trim();
  if (key === "" && endpoint === "") return [];
  if (endpoint === "") return ["PERSONAL_MAIL_API_KEY is set but PERSONAL_MAIL_ENDPOINT is empty"];
  if (key === "") return ["PERSONAL_MAIL_ENDPOINT is set but PERSONAL_MAIL_API_KEY is empty"];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return ["PERSONAL_MAIL_ENDPOINT is not a URL"];
  }
  if (url.protocol !== "https:") return ["PERSONAL_MAIL_ENDPOINT must be an https URL"];
  if (PLACEHOLDER_HOST.test(url.hostname.toLowerCase().replace(/\.$/, "")))
    return ["PERSONAL_MAIL_ENDPOINT names a placeholder host"];
  return [];
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
  WEBHOOK_SECRETS.filter((n) => {
    const v = (env[n] ?? "").trim();
    return v !== "" && v.length < MIN_WEBHOOK_SECRET_LENGTH;
  }).map((n) => `${n} is shorter than ${MIN_WEBHOOK_SECRET_LENGTH} characters`);

/** SCANNER_SIGNATURES/SCANNER_IMAGE, validated with the stack's own rule before any plan. */
export const scannerProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  try {
    scannerSignatureSource(env);
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
};

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
  if (classified._tag !== "Valid" || !classified.stage.persistent) return false;
  if (!MAIL_CREDENTIALS.some((n) => (env[n] ?? "").trim() !== "")) return false;
  return (
    (env[PROVIDER_PREVIEW_ATTESTATION.name] ?? "").trim() !== PROVIDER_PREVIEW_ATTESTATION.value
  );
};

if (import.meta.main) {
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
  const pairing = [
    ...personalMailProblems(process.env),
    ...webhookSecretProblems(process.env),
    ...scannerProblems(process.env),
  ];
  for (const problem of pairing) console.error(`config: ${problem}`);
  if (missing.length || forbidden.length || unsandboxed.length || attestation || pairing.length)
    process.exit(1);
  console.log(`config: ${requiredConfig().length} required names present`);
}
