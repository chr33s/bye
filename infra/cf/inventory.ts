import { INVENTORY, PROTECTED_TYPES } from "../resources/inventory.ts";
import { HOSTED_NAMESPACES } from "../migrations/durable/durable-class-migrations.ts";

export const CF_INVENTORY = INVENTORY.filter((entry) => entry.type !== "Cloudflare.StateStore");

export const protectedType = (type: string): boolean =>
  [...PROTECTED_TYPES].some((protectedType) => protectedType === type) ||
  [
    "Cloudflare.Worker",
    "Cloudflare.Queues.Queue",
    "Cloudflare.Queues.Consumer",
    "Cloudflare.KV.Namespace",
    "Cloudflare.Container",
    "Cloudflare.Turnstile.Widget",
  ].includes(type);

export const DURABLE_BINDINGS = {
  Mailboxes: "MAILBOXES",
  Calendars: "CALENDARS",
  SharedSpaces: "SHARED_SPACES",
  SearchShards: "SEARCH_SHARDS",
  IngressJournals: "INGRESS_JOURNALS",
  Probes: "PROBES",
  Scanner: "SCANNER",
  MimeParser: "MIME_PARSER",
  SigMirrorJob: "MIRROR_JOB",
} as const;

export const WORKFLOWS = {
  ProvisionDomain: { binding: "PROVISION_DOMAIN", exportName: "ProvisionDomainWorkflow" },
  ExportAccount: { binding: "EXPORT_ACCOUNT", exportName: "ExportWorkflow" },
  EraseAccount: { binding: "ERASE_ACCOUNT", exportName: "EraseWorkflow" },
  Reindex: { binding: "REINDEX", exportName: "ReindexWorkflow" },
  Fanout: { binding: "FANOUT", exportName: "FanoutWorkflow" },
  Probe: { binding: "PROBE_WORKFLOW", exportName: "ProbeWorkflow" },
} as const;

export { HOSTED_NAMESPACES };
