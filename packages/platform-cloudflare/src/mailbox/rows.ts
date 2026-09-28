import { Match, type Schema } from "effect";
import type {
  BubbleCondition,
  BubbleState,
  Destination,
  Disposition,
  RecipientOutcome,
  SenderDecision,
  SenderPolicy,
  SendJobState,
} from "@bye/domain";
import type { Address } from "@bye/mail-codec";
import { bool, json } from "../durable/sql.ts";
import { reject } from "./context.ts";
import type {
  MailboxDelivery,
  MailboxDeliveryRouting,
  MailboxDraft,
  MailboxDraftContent,
  MailboxDraftState,
  MailboxIdentity,
  MailboxJobClass,
  MailboxScanStatus,
  MailboxSendJob,
  MailboxThread,
  MailboxUpload,
} from "./types.ts";

// Row codecs: each table's columns are declared once with their literal types, and one mapper
// turns a row into its public shape. SQL results are cast to these row types at the query site,
// so the rest of the mailbox code never re-casts individual columns.

export type BubbleTag = "None" | "Scheduled" | "Pinned";

export interface ThreadRow {
  readonly thread_id: string;
  readonly subject: string;
  readonly local_subject: string | null;
  readonly sender: string;
  readonly destination: Destination;
  readonly disposition: Disposition;
  readonly quarantined: number;
  readonly bundle_key: string | null;
  readonly new_for_you: number;
  readonly revision: number;
  readonly seen_revision: number;
  readonly activity_seq: number;
  readonly last_activity_at: number;
  readonly message_count: number;
  readonly reply_later: number;
  readonly set_aside: number;
  readonly unfollowed: number;
  readonly bubble_tag: BubbleTag;
  readonly bubble_at: number | null;
  readonly bubble_generation: number;
  readonly bubble_condition?: BubbleCondition;
  readonly merged_into: string | null;
  readonly bundle_count?: number;
}

export const bubbleOf = (r: ThreadRow): BubbleState =>
  Match.value(r.bubble_tag).pipe(
    Match.when("Scheduled", (): BubbleState => ({
      _tag: "Scheduled",
      at: Number(r.bubble_at),
      generation: Number(r.bubble_generation),
      condition: r.bubble_condition ?? "always",
    })),
    Match.when("Pinned", (): BubbleState => ({ _tag: "Pinned" })),
    Match.orElse((): BubbleState => ({ _tag: "None" })),
  );

export const toThread = (
  r: ThreadRow,
  labels: ReadonlyArray<string>,
  previousVisit = 0,
): MailboxThread => ({
  threadId: r.thread_id,
  subject: r.local_subject ?? r.subject,
  originalSubject: r.subject,
  sender: r.sender,
  destination: r.destination,
  disposition: r.disposition,
  quarantined: bool(r.quarantined),
  bundleKey: r.bundle_key,
  bundleCount: Number(r.bundle_count ?? 1),
  newForYou: bool(r.new_for_you),
  revision: Number(r.revision),
  seenRevision: Number(r.seen_revision),
  lastActivityAt: Number(r.last_activity_at),
  messageCount: Number(r.message_count),
  attention: {
    replyLater: bool(r.reply_later),
    setAside: bool(r.set_aside),
    unfollowed: bool(r.unfollowed),
    bubble: bubbleOf(r),
  },
  labels,
  mergedInto: r.merged_into,
  newSinceVisit: previousVisit > 0 && Number(r.last_activity_at) > previousVisit,
});

export interface DeliveryRow {
  readonly delivery_id: string;
  readonly ingestion_id: string;
  readonly recipient: string;
  readonly thread_id: string;
  readonly original_thread_id: string;
  readonly direction: "in" | "out";
  readonly message_key: string;
  readonly message_id_header: string | null;
  readonly in_reply_to: string;
  readonly refs: string;
  readonly from_address: string;
  readonly from_name: string | null;
  readonly to_json: string;
  readonly cc_json: string;
  readonly subject: string;
  readonly date: number;
  readonly snippet: string;
  readonly list_id: string | null;
  readonly automated: number;
  readonly raw_size: number;
  readonly routing: string | null;
  readonly received_at: number;
  readonly scan_status: MailboxScanStatus | null;
  readonly scan_signature: string | null;
}

export interface AttachmentRow {
  readonly delivery_id: string;
  readonly part_id: string;
  readonly thread_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size: number;
  readonly inline: number;
  readonly from_address: string;
  readonly received_at: number;
}

const UNKNOWN_ROUTING: MailboxDeliveryRouting = {
  decidedBy: "unknown",
  hasCalendar: false,
  calendarMethod: null,
};

export const toDelivery = (
  d: DeliveryRow,
  attachments: ReadonlyArray<AttachmentRow>,
): MailboxDelivery => ({
  deliveryId: d.delivery_id,
  threadId: d.thread_id,
  originalThreadId: d.original_thread_id,
  direction: d.direction,
  recipient: d.recipient,
  messageKey: d.message_key,
  messageIdHeader: d.message_id_header ?? null,
  from: { name: d.from_name ?? undefined, address: d.from_address },
  to: json<Array<Address>>(d.to_json, []),
  cc: json<Array<Address>>(d.cc_json, []),
  subject: d.subject,
  date: Number(d.date),
  snippet: d.snippet,
  attachments: attachments.map((a) => ({
    partId: a.part_id,
    filename: a.filename,
    contentType: a.content_type,
    size: Number(a.size),
    contentId: undefined,
    inline: bool(a.inline),
  })),
  routing: json(d.routing, UNKNOWN_ROUTING),
  scan: { status: d.scan_status ?? "legacy", signature: d.scan_signature ?? null },
});

export interface PolicyRow {
  readonly kind: "address" | "domain";
  readonly subject: string;
  readonly decision: SenderDecision;
  readonly destination: Destination;
  readonly labels: string;
  readonly bundle: number;
  readonly notify: number;
}

export const toPolicy = (r: PolicyRow): SenderPolicy => ({
  decision: r.decision,
  destination: r.destination,
  labels: json<Array<string>>(r.labels, []),
  bundle: bool(r.bundle),
  notify: bool(r.notify),
});

export interface IdentityRow {
  readonly identity_id: string;
  readonly address: string;
  readonly name: string | null;
  readonly kind: "hosted" | "external";
  readonly verified: number;
  readonly is_default: number;
  readonly signature: string | null;
  readonly challenge_token: string | null;
  readonly challenge_sent_at: number | null;
}

export const toIdentity = (r: IdentityRow): MailboxIdentity => ({
  identityId: r.identity_id,
  address: r.address,
  name: r.name ?? null,
  kind: r.kind,
  verified: bool(r.verified),
  isDefault: bool(r.is_default),
  signature: r.signature ?? "",
});

export interface DraftRow {
  readonly draft_id: string;
  readonly thread_id: string | null;
  readonly identity_id: string | null;
  readonly revision: number;
  readonly content: string;
  readonly state: MailboxDraftState;
  readonly updated_at: number;
}

export const EMPTY_CONTENT: MailboxDraftContent = {
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  text: "",
  attachments: [],
};

export const toDraft = (r: DraftRow): MailboxDraft => ({
  draftId: r.draft_id,
  threadId: r.thread_id,
  revision: Number(r.revision),
  content: json(r.content, EMPTY_CONTENT),
  state: r.state,
  updatedAt: Number(r.updated_at),
});

export interface SendJobRow {
  readonly send_job_id: string;
  readonly draft_id: string;
  readonly draft_revision: number;
  readonly split_key: string;
  readonly state: SendJobState;
  readonly due_at: number;
  readonly identity_id: string | null;
  readonly from_address: string;
  readonly recipients: string;
  readonly thread_id: string | null;
  readonly traffic_class: MailboxJobClass;
  readonly content_key: string;
  readonly bytes: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly provider_id: string | null;
  readonly wire_message_id: string | null;
  readonly failure: string | null;
  readonly after_send: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface RecipientRow {
  readonly send_job_id: string;
  readonly address: string;
  readonly outcome: RecipientOutcome;
  readonly detail: string | null;
}

export const toJob = (r: SendJobRow, outcomes: ReadonlyArray<RecipientRow>): MailboxSendJob => ({
  sendJobId: r.send_job_id,
  draftId: r.draft_id,
  draftRevision: Number(r.draft_revision),
  state: r.state,
  dueAt: Number(r.due_at),
  identityId: r.identity_id,
  from: r.from_address,
  recipients: json<Array<string>>(r.recipients, []),
  threadId: r.thread_id ?? null,
  trafficClass: r.traffic_class,
  contentKey: r.content_key,
  bytes: Number(r.bytes),
  attempts: Number(r.attempts),
  providerId: r.provider_id ?? null,
  wireMessageId: r.wire_message_id ?? null,
  failure: json<{ kind: string; detail: string } | null>(r.failure, null),
  outcomes: outcomes.map((o) => ({ address: o.address, outcome: o.outcome, detail: o.detail })),
});

export interface UploadRow {
  readonly upload_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly declared_size: number;
  readonly actual_size: number | null;
  readonly state: MailboxUpload["state"];
  readonly scan_status: MailboxUpload["scanStatus"];
  readonly parts: string;
  readonly blob_key: string;
  readonly r2_upload_id: string | null;
  readonly created_at: number;
}

export const toUpload = (r: UploadRow): MailboxUpload => ({
  uploadId: r.upload_id,
  filename: r.filename,
  contentType: r.content_type,
  declaredSize: Number(r.declared_size),
  actualSize: r.actual_size === null ? null : Number(r.actual_size),
  state: r.state,
  scanStatus: r.scan_status,
  blobKey: r.blob_key,
});

/** Uploads may be attached, linked, previewed or indexed only once complete and scanned clean. */
export const isServableUpload = (u: Pick<MailboxUpload, "state" | "scanStatus">): boolean =>
  u.state === "complete" && u.scanStatus === "clean";

// IN-list helpers live with the SQL layer so every authority shares the 100-parameter guard.
export { allInChunks, inListChunks, placeholders } from "../durable/sql.ts";

/** Group rows by a key (for single-query child loads instead of one query per parent). */
export const groupBy = <T, K>(rows: ReadonlyArray<T>, key: (r: T) => K): Map<K, Array<T>> => {
  const out = new Map<K, Array<T>>();

  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);

    if (list) list.push(r);
    else out.set(k, [r]);
  }

  return out;
};

export const encodeCursor = (value: Schema.Json): string => btoa(JSON.stringify(value));

export const decodeCursor = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined;

  try {
    return JSON.parse(atob(value)) as T;
  } catch {
    return reject("bad_request", "invalid cursor");
  }
};
