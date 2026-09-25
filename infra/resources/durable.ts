// Authoritative state and long-running orchestration (§15.4). One namespace per authority
// class, all hosted by MailCore; object instances are selected dynamically by opaque ID (§15.2).
// Class names are compatibility-sensitive identities: see infra/migrations/durable.
import * as Cloudflare from "alchemy/Cloudflare";
import type { CoreClasses } from "./runtime-types.ts";
import type {
  DomainParams,
  EraseParams,
  ExportParams,
  FanoutParams,
  ReindexParams,
} from "../../workers/core/src/workflows.ts";
import type { ProbeParams } from "../../workers/core/src/probe.ts";

export const Mailboxes = Cloudflare.DurableObject<CoreClasses["MailboxDO"]>("Mailboxes", {
  className: "MailboxDO",
});
export const Calendars = Cloudflare.DurableObject<CoreClasses["CalendarDO"]>("Calendars", {
  className: "CalendarDO",
});
export const SharedSpaces = Cloudflare.DurableObject<CoreClasses["SharedSpaceDO"]>("SharedSpaces", {
  className: "SharedSpaceDO",
});
export const SearchShards = Cloudflare.DurableObject<CoreClasses["SearchShardDO"]>("SearchShards", {
  className: "SearchShardDO",
});
export const IngressJournals = Cloudflare.DurableObject<CoreClasses["IngressJournalDO"]>(
  "IngressJournals",
  {
    className: "IngressJournalDO",
  },
);

/** Post-deploy probe namespace (§15.10): proves DO alarms fire after each deploy. */
export const Probes = Cloudflare.DurableObject<CoreClasses["ProbeDO"]>("Probes", {
  className: "ProbeDO",
});

/**
 * Workflow parameter types come from the Worker modules themselves (P0 #12): the declaration can
 * no longer drift from what the API actually sends. Each params type carries a `v` discriminator
 * decoded at `run` (workers/core/src/workflows/common.ts `decodeParams`).
 */
export const ProvisionDomain = Cloudflare.Workflow<DomainParams>("ProvisionDomain", {
  className: "ProvisionDomainWorkflow",
});
export const ExportAccount = Cloudflare.Workflow<ExportParams>("ExportAccount", {
  className: "ExportWorkflow",
});
export const EraseAccount = Cloudflare.Workflow<EraseParams>("EraseAccount", {
  className: "EraseWorkflow",
});
export const Reindex = Cloudflare.Workflow<ReindexParams>("Reindex", {
  className: "ReindexWorkflow",
});
export const Fanout = Cloudflare.Workflow<FanoutParams>("Fanout", {
  className: "FanoutWorkflow",
});

export const Probe = Cloudflare.Workflow<ProbeParams>("Probe", { className: "ProbeWorkflow" });
