// Required infrastructure inventory (§15.4) as reviewable data. Every group must appear in the
// declared graph or have an explicitly recorded external owner; infra/tests/inventory.test.ts
// cross-checks this manifest against the actual declarations and bindings.

export type InventoryGroup =
  | "api-and-clients"
  | "inbound-mail"
  | "authoritative-state"
  | "control-plane"
  | "content-storage"
  | "work-delivery"
  | "long-running-orchestration"
  | "scheduling"
  | "media-and-scans"
  | "protection-and-caching"
  | "transport-and-integrations"
  | "observability";

export const INVENTORY_GROUPS: ReadonlyArray<InventoryGroup> = [
  "api-and-clients",
  "inbound-mail",
  "authoritative-state",
  "control-plane",
  "content-storage",
  "work-delivery",
  "long-running-orchestration",
  "scheduling",
  "media-and-scans",
  "protection-and-caching",
  "transport-and-integrations",
  "observability",
];

export type ResourceType =
  | "Cloudflare.Worker"
  | "Cloudflare.D1.Database"
  | "Cloudflare.R2.Bucket"
  | "Cloudflare.KV.Namespace"
  | "Cloudflare.Queues.Queue"
  | "Cloudflare.Queues.Consumer"
  | "Cloudflare.DurableObject"
  | "Cloudflare.Workflow"
  | "Cloudflare.Email.Routing"
  | "Cloudflare.Email.CatchAll"
  | "Cloudflare.Email.SendEmail"
  | "Cloudflare.RateLimit"
  | "Cloudflare.Turnstile.Widget"
  | "Cloudflare.StateStore"
  | "Cloudflare.Container"
  | "Cloudflare.Ruleset";

/** Types whose deletion or replacement destroys data or routing (§15.6). */
export const PROTECTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  "Cloudflare.D1.Database",
  "Cloudflare.R2.Bucket",
  "Cloudflare.DurableObject",
  "Cloudflare.Workflow",
  "Cloudflare.Email.Routing",
  "Cloudflare.Email.CatchAll",
  "Cloudflare.StateStore",
]);

export interface InventoryEntry {
  readonly group: InventoryGroup;
  readonly logicalId: string;
  readonly type: ResourceType;
  readonly owner: "stack" | "foundation" | "external";
  /** Binding name when bound (on MailCore unless `worker` says otherwise). */
  readonly binding?: string;
  /** Host Worker for the binding; defaults to MailCore. */
  readonly worker?: "MailCore" | "SigMirror";
  readonly note?: string;
}

const QUEUES = [
  "Ingest",
  "ParseScan",
  "Index",
  "Dispatch",
  "Notify",
  "Propagate",
  "Publish",
] as const;

export const INVENTORY: ReadonlyArray<InventoryEntry> = [
  { group: "api-and-clients", logicalId: "MailCore", type: "Cloudflare.Worker", owner: "stack" },
  { group: "api-and-clients", logicalId: "PublicSite", type: "Cloudflare.Worker", owner: "stack" },
  {
    group: "api-and-clients",
    logicalId: "RenderOrigin",
    type: "Cloudflare.Worker",
    owner: "stack",
    note: "onboarding workers.dev installations only (BYE_WORKERS_DEV_NAME): forwards the render host to MailCore",
  },
  {
    group: "inbound-mail",
    logicalId: "MailRouting",
    type: "Cloudflare.Email.Routing",
    owner: "stack",
    note: "service-owned zone only; skipped for previews",
  },
  {
    group: "inbound-mail",
    logicalId: "MailCatchAll",
    type: "Cloudflare.Email.CatchAll",
    owner: "stack",
  },
  {
    group: "inbound-mail",
    logicalId: "IngressJournals",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "INGRESS_JOURNALS",
  },
  {
    group: "authoritative-state",
    logicalId: "Mailboxes",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "MAILBOXES",
  },
  {
    group: "authoritative-state",
    logicalId: "Calendars",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "CALENDARS",
  },
  {
    group: "authoritative-state",
    logicalId: "SharedSpaces",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "SHARED_SPACES",
  },
  {
    group: "authoritative-state",
    logicalId: "SearchShards",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "SEARCH_SHARDS",
  },
  {
    group: "control-plane",
    logicalId: "Directory",
    type: "Cloudflare.D1.Database",
    owner: "stack",
    binding: "DIRECTORY",
  },
  {
    group: "content-storage",
    logicalId: "Originals",
    type: "Cloudflare.R2.Bucket",
    owner: "stack",
    binding: "ORIGINALS",
  },
  {
    group: "content-storage",
    logicalId: "Parts",
    type: "Cloudflare.R2.Bucket",
    owner: "stack",
    binding: "PARTS",
  },
  {
    group: "content-storage",
    logicalId: "Exports",
    type: "Cloudflare.R2.Bucket",
    owner: "stack",
    binding: "EXPORTS",
  },
  {
    group: "content-storage",
    logicalId: "Published",
    type: "Cloudflare.R2.Bucket",
    owner: "stack",
    binding: "PUBLISHED",
  },
  ...QUEUES.flatMap((q): ReadonlyArray<InventoryEntry> => [
    { group: "work-delivery", logicalId: q, type: "Cloudflare.Queues.Queue", owner: "stack" },
    {
      group: "work-delivery",
      logicalId: `${q}DLQ`,
      type: "Cloudflare.Queues.Queue",
      owner: "stack",
    },
    {
      group: "work-delivery",
      logicalId: `${q}Consumer`,
      type: "Cloudflare.Queues.Consumer",
      owner: "stack",
    },
  ]),
  {
    group: "long-running-orchestration",
    logicalId: "ProvisionDomain",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "PROVISION_DOMAIN",
  },
  {
    group: "long-running-orchestration",
    logicalId: "ExportAccount",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "EXPORT_ACCOUNT",
  },
  {
    group: "long-running-orchestration",
    logicalId: "EraseAccount",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "ERASE_ACCOUNT",
  },
  {
    group: "long-running-orchestration",
    logicalId: "Reindex",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "REINDEX",
  },
  {
    group: "long-running-orchestration",
    logicalId: "Fanout",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "FANOUT",
  },
  {
    group: "long-running-orchestration",
    logicalId: "Probe",
    type: "Cloudflare.Workflow",
    owner: "stack",
    binding: "PROBE_WORKFLOW",
    note: "post-deploy Workflow checkpoint/resume probe (§15.10)",
  },
  {
    group: "scheduling",
    logicalId: "Probes",
    type: "Cloudflare.DurableObject",
    owner: "stack",
    binding: "PROBES",
    note: "post-deploy alarm probe (§15.10)",
  },
  {
    group: "scheduling",
    logicalId: "MailCore",
    type: "Cloudflare.Worker",
    owner: "stack",
    note: "crons: reconciler + retention sweep; DO alarms are runtime state",
  },
  {
    group: "media-and-scans",
    logicalId: "Scanner",
    type: "Cloudflare.Container",
    owner: "stack",
    binding: "SCANNER",
    note: "ClamAV image from containers/scanner; backs the ScannerContainer DO class on MailCore",
  },
  {
    group: "media-and-scans",
    logicalId: "MimeParser",
    type: "Cloudflare.Container",
    owner: "stack",
    binding: "MIME_PARSER",
    note: "Bounded MIME parser from containers/mime; backs the MimeContainer DO class on MailCore (§5.1 step 5)",
  },
  {
    group: "media-and-scans",
    logicalId: "ClamSignatures",
    type: "Cloudflare.R2.Bucket",
    owner: "stack",
    binding: "SIGNATURES",
    worker: "SigMirror",
    note: "private ClamAV signature mirror, bound only to the SigMirror Worker",
  },
  {
    group: "media-and-scans",
    logicalId: "SigMirrorJob",
    type: "Cloudflare.Container",
    owner: "stack",
    binding: "MIRROR_JOB",
    worker: "SigMirror",
    note: "cvdupdate job (containers/sigmirror); the single signature egress point, cron-started",
  },
  {
    group: "media-and-scans",
    logicalId: "SigMirror",
    type: "Cloudflare.Worker",
    owner: "stack",
    note: "serves the mirror; no routes or workers.dev; crons start the job",
  },
  {
    group: "protection-and-caching",
    logicalId: "ConfigCache",
    type: "Cloudflare.KV.Namespace",
    owner: "stack",
    binding: "CONFIG_CACHE",
  },
  {
    group: "protection-and-caching",
    logicalId: "AuthRateLimit",
    type: "Cloudflare.RateLimit",
    owner: "stack",
    binding: "AUTH_RATE_LIMIT",
  },
  {
    group: "protection-and-caching",
    logicalId: "PublicRateLimit",
    type: "Cloudflare.RateLimit",
    owner: "stack",
  },
  {
    group: "protection-and-caching",
    logicalId: "SubscribeRateLimit",
    type: "Cloudflare.RateLimit",
    owner: "stack",
  },
  {
    group: "protection-and-caching",
    logicalId: "SignupChallenge",
    type: "Cloudflare.Turnstile.Widget",
    owner: "stack",
  },
  {
    group: "protection-and-caching",
    logicalId: "ZoneWaf",
    type: "Cloudflare.Ruleset",
    owner: "foundation",
    note: "WafRules ruleset (http_request_firewall_custom) declared in infra/foundation/stack.ts",
  },
  {
    group: "transport-and-integrations",
    logicalId: "TransactionalEmail",
    type: "Cloudflare.Email.SendEmail",
    owner: "stack",
    binding: "TRANSACTIONAL_EMAIL",
  },
  {
    group: "observability",
    logicalId: "MailCore",
    type: "Cloudflare.Worker",
    owner: "stack",
    note: "structured opaque-ID logs only; invocation logs off (URLs carry bearer tokens); no logpush egress",
  },
  {
    group: "observability",
    logicalId: "StateStore",
    type: "Cloudflare.StateStore",
    owner: "foundation",
    note: "state backend bootstrap is a separate authorized operation",
  },
];
