// First-account bootstrap for self-hosted installations (infra/onboarding). An onboarding
// installation has no Turnstile widget; instead the onboarding service
// generates BOOTSTRAP_TOKEN and hands the operator a setup link. The token stands in for
// Turnstile exactly once, only while the instance has no users, and the account it creates
// becomes a platform operator. Empty token = disabled (every CI-managed stage).
import { timingSafeEqual } from "@bye/domain";
import type { CoreEnv } from "./env.ts";
import { serviceDomain } from "./origins.ts";

/** An unfinished claim (signup failed after claiming, or the Worker died) can be retaken after this. */
export const BOOTSTRAP_CLAIM_LEASE_MS = 5 * 60_000;

type BootstrapEnv = Pick<CoreEnv, "DIRECTORY" | "BOOTSTRAP_TOKEN">;

export const bootstrapEnabled = (env: Pick<CoreEnv, "BOOTSTRAP_TOKEN">): boolean =>
  (env.BOOTSTRAP_TOKEN ?? "").length >= 32;

/**
 * The address domain the bootstrap account must use: the Cloudflare zone chosen in onboarding
 * (BOOTSTRAP_ADDRESS_DOMAIN, e.g. `example.com` for an app at `bye.example.com`), else the service
 * domain. Choosing it never activates MX or Email Routing; incoming mail is a separate step.
 */
export const bootstrapAddressDomain = (
  env: Pick<CoreEnv, "APP_ORIGIN" | "BOOTSTRAP_ADDRESS_DOMAIN">,
): string =>
  (env.BOOTSTRAP_ADDRESS_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "") ||
  serviceDomain(env);

/**
 * Claims the single bootstrap slot. True only for the correct token, on an instance without
 * users, when no claim is live and none has completed.
 */
export const claimBootstrap = async (
  env: BootstrapEnv,
  token: string,
  now: number,
): Promise<boolean> => {
  if (!bootstrapEnabled(env) || !timingSafeEqual(token, env.BOOTSTRAP_TOKEN!)) return false;

  const users = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM users").first<{
    n: number;
  }>();

  if (Number(users?.n ?? 0) > 0) return false;

  const claimed = await env.DIRECTORY.prepare(
    `INSERT INTO instance_bootstrap (id, claimed_at, user_id) VALUES (1, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET claimed_at = excluded.claimed_at
     WHERE instance_bootstrap.user_id IS NULL AND instance_bootstrap.claimed_at < ?`,
  )
    .bind(now, now - BOOTSTRAP_CLAIM_LEASE_MS)
    .run();

  return claimed.meta.changes === 1;
};

/** Signup failed after the claim: free the slot so the operator can try again. */
export const releaseBootstrap = async (env: BootstrapEnv): Promise<void> => {
  await env.DIRECTORY.prepare(
    "DELETE FROM instance_bootstrap WHERE id = 1 AND user_id IS NULL",
  ).run();
};

export const completeBootstrap = async (env: BootstrapEnv, userId: string): Promise<void> => {
  await env.DIRECTORY.prepare(
    "UPDATE instance_bootstrap SET user_id = ? WHERE id = 1 AND user_id IS NULL",
  )
    .bind(userId)
    .run();
};

// Immutable once set, so a found operator is cached for the isolate's lifetime.
let cachedOperator: string | null = null;

/** The operator created by bootstrap, if any (in addition to OPERATOR_USER_IDS). */
export const bootstrapOperatorIds = async (env: BootstrapEnv): Promise<ReadonlyArray<string>> => {
  if (!bootstrapEnabled(env)) return [];

  if (cachedOperator !== null) return [cachedOperator];
  // Never rejects: callers (policyLayers) create this promise before they need it.
  let row: { user_id: string } | null = null;

  try {
    row = await env.DIRECTORY.prepare(
      "SELECT user_id FROM instance_bootstrap WHERE id = 1 AND user_id IS NOT NULL",
    ).first<{ user_id: string }>();
  } catch {
    row = null;
  }

  if (row?.user_id) cachedOperator = row.user_id;

  return row?.user_id ? [row.user_id] : [];
};

/** Tests only: isolates are reused across harnesses. */
export const resetBootstrapCache = (): void => {
  cachedOperator = null;
};
