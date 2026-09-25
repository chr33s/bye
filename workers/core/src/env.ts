// MailCore runtime bindings. Names mirror `coreEnv` in infra/resources/workers.ts; the infra test
// `bindings.test.ts` asserts the two stay identical. Declared by hand so the Worker bundle never
// imports deployment modules (§7.5).

import type {
  CalendarDO,
  IngressJournalDO,
  MailboxDO,
  SearchShardDO,
  SharedSpaceDO,
} from "./objects.ts";
import type { ScannerContainer } from "./scan.ts";
import type { ProbeDO } from "./probe.ts";
import type { MimeContainer } from "./mime.ts";

export interface CoreEnv {
  readonly APP_ORIGIN: string;
  readonly MAIL_ORIGIN: string;
  readonly DIRECTORY: D1Database;
  readonly ORIGINALS: R2Bucket;
  readonly PARTS: R2Bucket;
  readonly EXPORTS: R2Bucket;
  readonly PUBLISHED: R2Bucket;
  readonly CONFIG_CACHE: KVNamespace;
  readonly INGEST: Queue;
  readonly PARSE_SCAN: Queue;
  readonly INDEX: Queue;
  readonly DISPATCH: Queue;
  readonly NOTIFY: Queue;
  readonly PROPAGATE: Queue;
  readonly PUBLISH: Queue;
  readonly MAILBOXES: DurableObjectNamespace<MailboxDO>;
  readonly CALENDARS: DurableObjectNamespace<CalendarDO>;
  readonly SHARED_SPACES: DurableObjectNamespace<SharedSpaceDO>;
  readonly SEARCH_SHARDS: DurableObjectNamespace<SearchShardDO>;
  readonly INGRESS_JOURNALS: DurableObjectNamespace<IngressJournalDO>;
  readonly PROVISION_DOMAIN: Workflow;
  readonly EXPORT_ACCOUNT: Workflow;
  readonly ERASE_ACCOUNT: Workflow;
  readonly REINDEX: Workflow;
  readonly FANOUT: Workflow;
  readonly TRANSACTIONAL_EMAIL: SendEmail;
  readonly SCANNER: DurableObjectNamespace<ScannerContainer>;
  /** Post-deploy async probes (§15.10); operator-only via PROBE_TOKEN. */
  readonly PROBES: DurableObjectNamespace<ProbeDO>;
  readonly PROBE_WORKFLOW: Workflow;
  readonly PROBE_TOKEN: string;
  /** Preview mail sandbox (§15.8): comma-separated allowed recipient domains; empty outside previews. */
  readonly MAIL_SANDBOX_DOMAINS: string;
  /** Staging-only ingress fault injection for §14.2 evidence (`throw|r2|timeout`); refused on prod/staging config by check-config. */
  readonly BYE_FAULT_INGRESS: string;
  /** Bounded MIME-processing container for exceptional messages (§5.1 step 5). */
  readonly MIME_PARSER: DurableObjectNamespace<MimeContainer>;
  /** Stack-wired service binding to the private signature mirror (CORE_STACK_BINDINGS). */
  readonly SIGMIRROR?: Fetcher;
  readonly AUTH_RATE_LIMIT: RateLimit;
  readonly PERSONAL_MAIL_API_KEY: string;
  /** Approved personal-mail provider submission URL; empty or `.invalid` = personal mail unavailable. */
  readonly PERSONAL_MAIL_ENDPOINT: string;
  /** HMAC secret for the personal-mail provider's send-event webhook (never the provider API key). */
  readonly SEND_EVENTS_WEBHOOK_SECRET?: string;
  readonly SESSION_KEY: string;
  readonly PROXY_SIGNING_KEY: string;
  readonly BILLING_WEBHOOK_SECRET: string;
  readonly TURNSTILE_SECRET: string;
  /** Optional geocoding provider key for location autocomplete (C10); empty disables it. */
  readonly LOCATION_API_KEY?: string;
  // Ops/transport configuration; empty string = not configured / not approved in this environment.
  readonly VAPID_PUBLIC_KEY: string;
  readonly VAPID_SUBJECT: string;
  readonly APNS_KEY_ID: string;
  readonly APNS_TEAM_ID: string;
  readonly APNS_TOPIC: string;
  readonly FORWARDING_ENDPOINT: string;
  readonly FORWARDING_DOMAIN: string;
  readonly ARC_SELECTOR: string;
  /** Comma-separated traffic classes MailTransport may dispatch here; empty = transactional only. */
  readonly MAIL_TRAFFIC_CLASSES: string;
  /** Newsletter provider adapter (`resend`); empty = newsletters blocked. */
  readonly NEWSLETTER_PROVIDER: string;
  /** Label of the provider account the newsletter credentials belong to (events bind to it). */
  readonly NEWSLETTER_ACCOUNT: string;
  /** Release-qualification evidence reference; empty = the provider is configured but not enabled. */
  readonly NEWSLETTER_QUALIFIED: string;
  readonly VAPID_PRIVATE_KEY: string;
  readonly APNS_KEY_P8: string;
  readonly FCM_SERVICE_ACCOUNT: string;
  readonly FORWARDING_API_KEY: string;
  readonly SRS_SECRET: string;
  readonly ARC_SIGNING_KEY: string;
  readonly NEWSLETTER_API_KEY: string;
  readonly NEWSLETTER_WEBHOOK_SECRET: string;
  readonly EXTERNAL_IDENTITY_SEAL_KEY: string;
  readonly OPS_TOKEN: string;
  // ---- control plane (O01, P01, A02, §10); empty/undefined disables the automation ----
  /** Scoped token: Zone DNS edit + Email Routing edit for customer-domain onboarding. */
  readonly CF_DNS_API_TOKEN?: string;
  /** Scoped token: Cache Purge for the public site zone. */
  readonly CF_CACHE_PURGE_TOKEN?: string;
  readonly CF_PUBLIC_ZONE_ID?: string;
  /** Worker script receiving customer-zone mail via the Email Routing catch-all rule. */
  readonly MAIL_WORKER_NAME?: string;
  readonly MAIL_DKIM_PUBLIC_KEY?: string;
  readonly BILLING_CHECKOUT_URL?: string;
  readonly BILLING_API_KEY?: string;
  /** Comma-separated platform operator user IDs (abuse review, support sessions, credits). */
  readonly OPERATOR_USER_IDS?: string;
  /** Single-use first-account token for onboarding installations (bootstrap.ts); empty = off. */
  readonly BOOTSTRAP_TOKEN?: string;
}

/** Bindings added by the stack itself (they reference other stack resources), not by `coreEnv`. */
export const CORE_STACK_BINDINGS = ["SIGMIRROR"] as const;

export const CORE_BINDING_NAMES = [
  "APP_ORIGIN",
  "MAIL_ORIGIN",
  "DIRECTORY",
  "ORIGINALS",
  "PARTS",
  "EXPORTS",
  "PUBLISHED",
  "CONFIG_CACHE",
  "INGEST",
  "PARSE_SCAN",
  "INDEX",
  "DISPATCH",
  "NOTIFY",
  "PROPAGATE",
  "PUBLISH",
  "MAILBOXES",
  "CALENDARS",
  "SHARED_SPACES",
  "SEARCH_SHARDS",
  "INGRESS_JOURNALS",
  "PROVISION_DOMAIN",
  "EXPORT_ACCOUNT",
  "ERASE_ACCOUNT",
  "REINDEX",
  "FANOUT",
  "TRANSACTIONAL_EMAIL",
  "SCANNER",
  "PROBES",
  "PROBE_WORKFLOW",
  "PROBE_TOKEN",
  "MAIL_SANDBOX_DOMAINS",
  "BYE_FAULT_INGRESS",
  "MIME_PARSER",
  "AUTH_RATE_LIMIT",
  "PERSONAL_MAIL_API_KEY",
  "PERSONAL_MAIL_ENDPOINT",
  "SEND_EVENTS_WEBHOOK_SECRET",
  "SESSION_KEY",
  "PROXY_SIGNING_KEY",
  "BILLING_WEBHOOK_SECRET",
  "TURNSTILE_SECRET",
  "LOCATION_API_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_TOPIC",
  "FORWARDING_ENDPOINT",
  "FORWARDING_DOMAIN",
  "ARC_SELECTOR",
  "MAIL_TRAFFIC_CLASSES",
  "NEWSLETTER_PROVIDER",
  "NEWSLETTER_ACCOUNT",
  "NEWSLETTER_QUALIFIED",
  "VAPID_PRIVATE_KEY",
  "APNS_KEY_P8",
  "FCM_SERVICE_ACCOUNT",
  "FORWARDING_API_KEY",
  "SRS_SECRET",
  "ARC_SIGNING_KEY",
  "NEWSLETTER_API_KEY",
  "NEWSLETTER_WEBHOOK_SECRET",
  "EXTERNAL_IDENTITY_SEAL_KEY",
  "OPS_TOKEN",
  "CF_DNS_API_TOKEN",
  "CF_CACHE_PURGE_TOKEN",
  "CF_PUBLIC_ZONE_ID",
  "MAIL_WORKER_NAME",
  "MAIL_DKIM_PUBLIC_KEY",
  "BILLING_CHECKOUT_URL",
  "BILLING_API_KEY",
  "OPERATOR_USER_IDS",
  "BOOTSTRAP_TOKEN",
] as const satisfies ReadonlyArray<keyof CoreEnv>;

/** Ingress journals are partitioned so one hot object never serializes all inbound mail. */
export const INGRESS_JOURNAL_PARTITIONS = 16;
export const journalPartition = (ingestionId: string): string => {
  let h = 0;
  for (let i = 0; i < ingestionId.length; i++) h = (h * 31 + ingestionId.charCodeAt(i)) >>> 0;
  return `journal-${h % INGRESS_JOURNAL_PARTITIONS}`;
};
