import { BYE, CORE, MAIL, SUBMISSION, VACATION_RESPONSE } from "./capabilities.ts";

// Implementation registry (spec.md §16 D1): every standard method of the Core, Mail, Submission
// and VacationResponse specifications plus the Bye extensions, with its status. A test holds it
// against the dispatch tables, so a method can't silently appear, disappear or be mislabeled.
// Statuses describe the code; readiness is decided by the D1 tests and the D2 release profile.

/**
 * - `implemented`: answered with standard semantics on the JMAP core (and on the read-only
 *   projection where it applies; projection writes answer `accountReadOnly`).
 * - `fallback`: answered with the standard fallback (`cannotCalculateChanges`), allowed by C1 for
 *   the initial query profiles.
 * - `host`: answered by the API host (cross-account or not account-scoped).
 */
export type MethodStatus = "implemented" | "fallback" | "host";

export interface RegistryEntry {
  readonly method: string;
  readonly capability: string;
  readonly status: MethodStatus;
  readonly note?: string;
}

const implemented = (method: string, capability: string, note?: string): RegistryEntry =>
  note === undefined
    ? { method, capability, status: "implemented" }
    : { method, capability, status: "implemented", note };

export const METHOD_REGISTRY: ReadonlyArray<RegistryEntry> = [
  { method: "Core/echo", capability: CORE, status: "host" },
  { method: "Blob/copy", capability: CORE, status: "host", note: "B3 multi-phase copy" },
  { method: "PushSubscription/get", capability: CORE, status: "host" },
  {
    method: "PushSubscription/set",
    capability: CORE,
    status: "host",
    note: "verification + SSRF validation",
  },
  implemented("Mailbox/get", MAIL),
  implemented("Mailbox/changes", MAIL, "typed history on the core; projection: same-revision only"),
  implemented("Mailbox/query", MAIL),
  { method: "Mailbox/queryChanges", capability: MAIL, status: "fallback" },
  implemented("Mailbox/set", MAIL),
  implemented("Thread/get", MAIL),
  implemented("Thread/changes", MAIL),
  implemented("Email/get", MAIL, "body values filled by the host from immutable bytes"),
  implemented("Email/changes", MAIL),
  implemented("Email/query", MAIL, "text/body via chunked FTS5; projection refuses text filters"),
  { method: "Email/queryChanges", capability: MAIL, status: "fallback" },
  implemented("Email/set", MAIL),
  { method: "Email/copy", capability: MAIL, status: "host", note: "B3 multi-phase copy" },
  implemented("Email/import", MAIL),
  { method: "Email/parse", capability: MAIL, status: "host" },
  implemented("SearchSnippet/get", MAIL, "no highlighting: snippets are null"),
  implemented("Identity/get", SUBMISSION),
  implemented("Identity/changes", SUBMISSION),
  implemented("Identity/set", SUBMISSION, "update only; identities are provisioned by settings"),
  implemented("EmailSubmission/get", SUBMISSION),
  implemented("EmailSubmission/changes", SUBMISSION),
  implemented("EmailSubmission/query", SUBMISSION),
  { method: "EmailSubmission/queryChanges", capability: SUBMISSION, status: "fallback" },
  implemented("EmailSubmission/set", SUBMISSION, "B2 content pins; relay acceptance is `queued`"),
  implemented("VacationResponse/get", VACATION_RESPONSE),
  implemented("VacationResponse/set", VACATION_RESPONSE, "text bodies only"),
  implemented("Conversation/get", BYE),
  implemented("Conversation/changes", BYE),
  implemented("Conversation/set", BYE),
  implemented("DraftSession/get", BYE),
  implemented("DraftSession/changes", BYE),
  implemented("DraftSession/set", BYE, "B1 compare-and-swap head"),
  implemented("EmailAction/apply", BYE, "A1 native actions with intent receipts"),
];

/** Session/endpoint surfaces with their status. */
export const ENDPOINT_REGISTRY: ReadonlyArray<{
  readonly endpoint: "session" | "api" | "download" | "upload" | "eventSource";
  readonly status: "implemented";
}> = [
  { endpoint: "session", status: "implemented" },
  { endpoint: "api", status: "implemented" },
  { endpoint: "download", status: "implemented" },
  { endpoint: "upload", status: "implemented" },
  { endpoint: "eventSource", status: "implemented" },
];
