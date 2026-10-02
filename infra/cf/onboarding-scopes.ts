import type { ScopeGrant } from "../onboarding/scopes.ts";

/** Candidate cf-only matrix. Selected only by explicit opt-in; live least-privilege coverage remains unverified. */
export const CF_ONBOARDING_SCOPES: ReadonlyArray<ScopeGrant> = [
  {
    scope: "memberships.read",
    operations: ["GET /memberships (onboarding account selector)"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "account-settings.read",
    operations: ["GET /accounts/{account_id} (selected account verification)"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-scripts.read",
    operations: [
      "cf workers list",
      "cf workers get",
      "cf workers versions get",
      "cf workers deployments list",
    ],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-scripts.write",
    operations: [
      "cf workers versions create",
      "cf workers deployments create",
      "cf workers triggers deploy",
    ],
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
    operations: ["cf kv namespaces list", "cf kv namespaces get", "cf kv namespaces create"],
    resourceTypes: ["Cloudflare.KV.Namespace"],
    verified: false,
  },
  {
    scope: "d1.write",
    operations: [
      "cf d1 list",
      "cf d1 get",
      "cf d1 create",
      "cf d1 migrations list",
      "cf d1 migrations apply",
    ],
    resourceTypes: ["Cloudflare.D1.Database"],
    verified: false,
  },
  {
    scope: "workers-r2.write",
    operations: [
      "cf r2 buckets list",
      "cf r2 buckets create",
      "cf r2 buckets lifecycle get",
      "cf r2 buckets lifecycle update",
    ],
    resourceTypes: ["Cloudflare.R2.Bucket"],
    verified: false,
  },
  {
    scope: "queues.write",
    operations: [
      "cf queues list",
      "cf queues consumers list",
      "cf queues create",
      "cf workers triggers deploy (Queue consumers)",
    ],
    resourceTypes: ["Cloudflare.Queues.Queue", "Cloudflare.Queues.Consumer"],
    verified: false,
  },
  {
    scope: "containers.write",
    operations: [
      "cf containers applications list",
      "cf workers versions create (Container images)",
      "cf workers deployments create (Container rollout)",
    ],
    resourceTypes: ["Cloudflare.Container"],
    verified: false,
  },
  {
    scope: "zone.read",
    operations: ["GET /zones (selected installation zone verification)"],
    resourceTypes: [],
    verified: false,
  },
  {
    scope: "workers-routes.write",
    operations: ["cf workers triggers deploy (only approved MailCore hostname)"],
    resourceTypes: ["Cloudflare.Workers.CustomDomain"],
    verified: false,
  },
];
