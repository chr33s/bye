// Cloudflare OAuth scope-to-operation matrix for onboarding (spec.md §15.11 "OAuth,
// credentials, and disconnect"; infra/onboarding/spec.md §4). Only what the stack needs: zone read (to
// list and re-verify the chosen zone) and Workers Routes write (the one MailCore custom hostname),
// never DNS writes, Email Routing, email sending or zone settings. Each entry stays `verified: false`
// until an end-to-end nonproduction deployment with exactly this set has been recorded
// (infra/onboarding/README.md "Release record"); unverified coverage blocks persistent stages.

export interface ScopeGrant {
  readonly scope: string;
  /** Management operations the scope is requested for. */
  readonly operations: ReadonlyArray<string>;
  /** Plan resource types (inventory names) whose writes it covers. */
  readonly resourceTypes: ReadonlyArray<string>;
  readonly verified: boolean;
}

// Scope IDs are Cloudflare's OAuth scope catalog names, as mirrored in Alchemy's own OAuth client
// (alchemy/src/Cloudflare/Auth/OAuthScopes.ts), not Wrangler's legacy `x:write` names.
// No offline_access: Cloudflare refuses it (invalid_scope) for third-party clients, so a refresh
// token arrives only if the token response carries one anyway; without it an expired authorization
// asks the operator to reconnect.
export const ONBOARDING_SCOPES: ReadonlyArray<ScopeGrant> = [
  {
    scope: "memberships.read",
    operations: ["list the accounts the operator can choose (GET /memberships)"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "account-settings.read",
    operations: ["verify and display the selected account"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-scripts.read",
    operations: ["read the workers.dev subdomain", "detect Worker name collisions"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-scripts.write",
    operations: ["upload Workers, Durable Object classes, Workflows and bindings"],
    resourceTypes: [
      "Cloudflare.Worker",
      "Cloudflare.DurableObject",
      "Cloudflare.Workflow",
      "Cloudflare.Email.SendEmail",
      "Cloudflare.RateLimit",
    ],
    verified: false,
  },
  {
    scope: "workers-kv-storage.write",
    operations: ["create the ConfigCache namespace"],
    resourceTypes: ["Cloudflare.KV.Namespace"],
    verified: false,
  },
  {
    scope: "d1.write",
    operations: ["create the Directory database and apply its migrations"],
    resourceTypes: ["Cloudflare.D1.Database"],
    verified: false,
  },
  {
    scope: "workers-r2.write",
    operations: ["create the mail, export, published-content and signature buckets"],
    resourceTypes: ["Cloudflare.R2.Bucket"],
    verified: false,
  },
  {
    scope: "queues.write",
    operations: ["create queues, dead-letter queues and consumers"],
    resourceTypes: ["Cloudflare.Queues.Queue", "Cloudflare.Queues.Consumer"],
    verified: false,
  },
  {
    scope: "containers.write",
    operations: ["deploy the scanner, MIME parser and signature-mirror containers"],
    resourceTypes: ["Cloudflare.Container"],
    verified: false,
  },
  {
    scope: "secrets-store.write",
    operations: [
      "Alchemy's state store in the operator's account keeps its bearer token in Secrets Store",
    ],
    resourceTypes: ["Cloudflare.StateStore"],
    verified: false,
  },
  {
    scope: "zone.read",
    operations: [
      "list the selected account's active zones for the Bye address",
      "re-verify that the chosen zone still exists in the account before each deploy",
    ],
    // Discovery only: never authorizes a plan write.
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-routes.write",
    operations: [
      "attach the chosen Bye hostname (APP_DOMAIN) to MailCore as a Worker custom domain",
    ],
    resourceTypes: ["Cloudflare.Workers.CustomDomain"],
    verified: false,
  },
];

/**
 * Plan resource types with no known OAuth scope. Listed, not guessed: requesting a broader scope
 * to cover them is not allowed, so they block persistent stages until coverage is verified.
 */
export const UNCOVERED_TYPES: ReadonlyArray<{ readonly type: string; readonly note: string }> = [];

/**
 * Never requested, and refused if a provider grants them anyway: DNS, zones, routes and custom
 * domains, Email Routing/Sending, security rules, API tokens, billing, and any write to members,
 * account settings or user details — except the exact narrow grants in `PERMITTED_ZONE_SCOPES`.
 */
export const FORBIDDEN_SCOPE =
  /dns|zone|email|route|ssl|firewall|waf|ruleset|token|billing|(memberships|account-settings|user-details)\.write/i;

/**
 * The only zone/route scopes onboarding holds, matched exactly: `zone.read` for discovery and
 * `workers-routes.write` for the MailCore custom hostname. `dns-records.write`, `zone.write`,
 * `zone-settings.write` and every Email Routing scope stay forbidden.
 */
export const PERMITTED_ZONE_SCOPES: ReadonlySet<string> = new Set([
  "zone.read",
  "workers-routes.write",
]);

export const requestedScopes = (): ReadonlyArray<string> => ONBOARDING_SCOPES.map((s) => s.scope);

export const forbiddenScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  scopes.filter((s) => FORBIDDEN_SCOPE.test(s) && !PERMITTED_ZONE_SCOPES.has(s));

/** Types in a plan that no granted scope covers, or whose covering scope is unverified. */
export const coverageGaps = (
  types: ReadonlyArray<string>,
  granted: ReadonlyArray<string> = requestedScopes(),
  matrix: ReadonlyArray<ScopeGrant> = ONBOARDING_SCOPES,
): ReadonlyArray<string> => {
  const gaps: Array<string> = [];

  for (const type of new Set(types)) {
    const uncovered = UNCOVERED_TYPES.find((u) => u.type === type);

    if (uncovered) {
      gaps.push(`${type}: ${uncovered.note}`);
      continue;
    }

    const grant = matrix.find((g) => g.resourceTypes.includes(type));

    if (!grant) gaps.push(`${type}: not in the scope matrix`);
    else if (!granted.includes(grant.scope)) gaps.push(`${type}: scope ${grant.scope} not granted`);
    else if (!grant.verified) gaps.push(`${type}: scope ${grant.scope} is unverified`);
  }

  return gaps.sort();
};
