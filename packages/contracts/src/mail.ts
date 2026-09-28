import { Schema } from "effect";

// Mailbox wire contracts (§8 API sketch). Versioned independently of Effect/HTTP libraries.
// Every mutation carries a client command ID; conflicting writes carry an expected revision.

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_.:-]+$/),
);

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const EmailAddress = Schema.String.check(
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@<>()",;]+@[^\s@<>()",;]+$/),
);

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Revision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const MailAddress = Schema.Struct({
  name: Schema.optional(Text(256)),
  address: EmailAddress,
});

export type MailAddress = typeof MailAddress.Type;

export const MailDestination = Schema.Literals(["imbox", "feed", "paper-trail"]);

export const MailViewName = Schema.Literals([
  "imbox",
  "feed",
  "paper-trail",
  "screener",
  "reply-later",
  "set-aside",
  "bubble-up",
  "screened-out",
  "spam",
  "trash",
  "everything",
  "label",
]);

export type MailViewName = typeof MailViewName.Type;

export const MailSenderPolicy = Schema.Struct({
  decision: Schema.Literals(["unknown", "allowed", "blocked"]),
  destination: MailDestination,
  labels: Schema.Array(Text(64)),
  bundle: Schema.Boolean,
  notify: Schema.Boolean,
});

/**
 * Recipients one message may address (to + cc + bcc combined, and each list on its own). Transport
 * adapters declare lower limits (Cloudflare Email Sending: 50) and reject above them; this is the
 * wire ceiling that keeps per-recipient work (suppression lookups, outcome rows) bounded.
 */
export const MAX_MESSAGE_RECIPIENTS = 100;

const Recipients = Schema.Array(MailAddress).check(Schema.isMaxLength(MAX_MESSAGE_RECIPIENTS));

export const MailDraftContent = Schema.Struct({
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: Text(998),
  text: Text(2_000_000),
  html: Schema.optional(Text(5_000_000)),
  attachments: Schema.Array(Id),
  fileLinks: Schema.optional(Schema.Array(Id)),
  inReplyTo: Schema.optional(Text(998)),
  references: Schema.optional(Schema.Array(Text(998))),
  identityId: Schema.optional(Id),
  /** Contact groups expanded into To when the send is frozen (E17). */
  groups: Schema.optional(Schema.Array(Text(128)).check(Schema.isMaxLength(20))),
}).check(
  Schema.makeFilter(
    (c) =>
      c.to.length + c.cc.length + c.bcc.length <= MAX_MESSAGE_RECIPIENTS ||
      `at most ${MAX_MESSAGE_RECIPIENTS} recipients (to + cc + bcc)`,
  ),
);

export type MailDraftContent = typeof MailDraftContent.Type;

/** `if-no-reply` bubbles are cancelled by a qualifying reply (E09); absent means `always`. */
export const MailBubbleCondition = Schema.Literals(["always", "if-no-reply"]);

export type MailBubbleCondition = typeof MailBubbleCondition.Type;

export const MailAfterSend = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("MarkDone", {}),
  Schema.TaggedStruct("BubbleUp", {
    at: Timestamp,
    condition: Schema.optional(MailBubbleCondition),
  }),
  /** Send-and-pop: the reply resolves the bubble; the thread is not resurfaced (as ClearBubble). */
  Schema.TaggedStruct("ClearBubble", {}),
]);

const RuleConditions = Schema.Struct({
  from: Schema.optional(EmailAddress),
  fromDomain: Schema.optional(Text(253)),
  to: Schema.optional(EmailAddress),
  subjectContains: Schema.optional(Text(256)),
  listId: Schema.optional(Text(256)),
});

const RuleActions = Schema.Struct({
  labels: Schema.optional(Schema.Array(Text(64))),
  destination: Schema.optional(MailDestination),
  bundle: Schema.optional(Schema.Boolean),
  workflowBoardId: Schema.optional(Id),
  /** Copy matching mail to another mailbox the principal is authorized to send into (E22). */
  redeliverTo: Schema.optional(Id),
});

const Preference = Schema.Literals([
  "theme",
  "shortcuts",
  "remoteImages",
  "recycling",
  "undoWindowMs",
  "density",
  "calendarPanel",
  "coverArt",
]);

const cmd = <const Tag extends string, const F extends Schema.Struct.Fields>(tag: Tag, fields: F) =>
  Schema.TaggedStruct(tag, { commandId: Id, ...fields });

const ThreadIds = Schema.Array(Id).check(Schema.isMaxLength(500));

/** Typed mailbox commands (POST /v1/mailboxes/:id/commands). Bulk operations are bounded. */
export const MailboxCommand = Schema.Union([
  cmd("Screen", {
    decisions: Schema.Array(
      Schema.Struct({
        sender: EmailAddress,
        decision: Schema.Literals(["allow", "block"]),
        destination: Schema.optional(MailDestination),
        asSeen: Schema.optional(Schema.Boolean),
        reply: Schema.optional(Schema.Boolean),
        bundle: Schema.optional(Schema.Boolean),
        notify: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(500)),
  }),
  cmd("ClearScreener", { boundary: Revision }),
  cmd("SetPolicy", {
    kind: Schema.Literals(["address", "domain"]),
    subject: Text(320),
    policy: Schema.NullOr(MailSenderPolicy),
  }),
  cmd("RevertPolicy", { historyId: Id }),
  cmd("RotateSpeakeasy", {}),
  cmd("DisableSpeakeasy", {}),
  cmd("MarkSeen", { threadId: Id, observedRevision: Revision }),
  cmd("MarkUnseen", { threadId: Id }),
  cmd("MarkAllSeen", { view: MailViewName, boundary: Revision, label: Schema.optional(Text(64)) }),
  cmd("VisitView", { view: MailViewName, position: Schema.optional(Text(128)) }),
  cmd("SetViewPosition", { view: MailViewName, position: Text(128) }),
  cmd("SetAttention", {
    threadId: Id,
    flag: Schema.Literals(["replyLater", "setAside", "unfollowed"]),
    on: Schema.Boolean,
  }),
  cmd("BubbleUp", { threadId: Id, at: Timestamp, condition: Schema.optional(MailBubbleCondition) }),
  cmd("PinBubble", { threadId: Id }),
  cmd("PopBubble", { threadId: Id }),
  cmd("ClearBubble", { threadId: Id }),
  cmd("CreateBatch", { threadIds: Schema.Union([ThreadIds, Schema.Literal("new-for-you")]) }),
  cmd("RenameThread", { threadId: Id, subject: Schema.NullOr(Text(998)) }),
  cmd("MergeThreads", { targetId: Id, sourceIds: ThreadIds }),
  cmd("UnmergeThreads", { mergeId: Id }),
  cmd("MoveToTrash", { threadIds: ThreadIds }),
  cmd("MarkSpam", { threadIds: ThreadIds }),
  cmd("Restore", { threadIds: ThreadIds }),
  cmd("Empty", { disposition: Schema.Literals(["trash", "spam", "screened-out"]) }),
  cmd("CreateLabel", { name: Text(64), color: Schema.optional(Text(16)) }),
  cmd("DeleteLabel", { labelId: Id }),
  cmd("RenameLabel", { labelId: Id, name: Text(64) }),
  cmd("SetThreadLabels", {
    threadId: Id,
    add: Schema.Array(Text(64)),
    remove: Schema.Array(Text(64)),
  }),
  cmd("PutRule", {
    ruleId: Schema.optional(Id),
    conditions: RuleConditions,
    actions: RuleActions,
    enabled: Schema.optional(Schema.Boolean),
    position: Schema.optional(Revision),
  }),
  cmd("DeleteRule", { ruleId: Id }),
  cmd("CreateBoard", {
    name: Text(128),
    stages: Schema.Array(Text(128)),
    enrollAddress: Schema.optional(EmailAddress),
  }),
  cmd("AddToBoard", { boardId: Id, threadId: Id }),
  cmd("AddStage", { boardId: Id, name: Text(128) }),
  cmd("RenameStage", { stageId: Id, name: Text(128) }),
  cmd("MoveCard", { cardId: Id, stageId: Id, position: Revision }),
  cmd("CompleteCard", { cardId: Id, done: Schema.Boolean }),
  cmd("CreateCollection", { name: Text(128) }),
  cmd("SetCollectionItems", { collectionId: Id, add: ThreadIds, remove: ThreadIds }),
  cmd("PutNote", {
    noteId: Schema.optional(Id),
    kind: Schema.Literals(["thread", "sticky", "cover"]),
    threadId: Schema.optional(Id),
    body: Text(100_000),
    fileKeys: Schema.optional(Schema.Array(Text(512))),
    expectedRevision: Schema.optional(Revision),
  }),
  cmd("DeleteNote", { noteId: Id }),
  cmd("CreateClip", { threadId: Id, deliveryId: Id, text: Text(20_000) }),
  cmd("PutContact", {
    contactId: Schema.optional(Id),
    name: Text(256),
    emails: Schema.Array(EmailAddress),
    notes: Schema.optional(Text(20_000)),
    groups: Schema.optional(Schema.Array(Text(128))),
  }),
  cmd("DeleteContact", { contactId: Id }),
  cmd("ImportContacts", {
    contacts: Schema.Array(
      Schema.Struct({
        name: Text(256),
        emails: Schema.Array(EmailAddress),
        notes: Schema.optional(Text(20_000)),
      }),
    ).check(Schema.isMaxLength(5000)),
  }),
  cmd("SetPreference", { key: Preference, value: Schema.Unknown }),
  cmd("SetNotifyOptIn", {
    kind: Schema.Literals(["contact", "domain", "thread"]),
    subject: Text(320),
    on: Schema.Boolean,
  }),
  cmd("SetNotificationSettings", {
    quietHours: Schema.NullOr(Schema.Struct({ start: Text(5), end: Text(5), timeZone: Text(64) })),
    devices: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
  }),
  cmd("SetAway", {
    enabled: Schema.Boolean,
    startAt: Schema.NullOr(Timestamp),
    endAt: Schema.NullOr(Timestamp),
    subject: Text(998),
    text: Text(20_000),
    cooldownMs: Timestamp,
  }),
  cmd("AddForwardingDestination", { address: EmailAddress }),
  cmd("VerifyForwardingDestination", { address: EmailAddress, token: Text(128) }),
  cmd("PutForwardingRule", {
    ruleId: Schema.optional(Id),
    matchSender: Schema.optional(Text(320)),
    destination: EmailAddress,
    keepCopy: Schema.Boolean,
  }),
  cmd("DeleteForwardingRule", { ruleId: Id }),
  cmd("AddIdentity", {
    address: EmailAddress,
    name: Schema.optional(Text(256)),
    kind: Schema.Literals(["hosted", "external"]),
    signature: Schema.optional(Text(10_000)),
  }),
  cmd("SetDefaultIdentity", { identityId: Id }),
  cmd("VerifyIdentity", { identityId: Id, token: Text(128) }),
  cmd("ResendIdentityChallenge", { identityId: Id }),
  cmd("ClearRecentSearches", {}),
  cmd("CreateDraft", { threadId: Schema.optional(Id), content: MailDraftContent }),
  cmd("CreateReplyDraft", {
    threadId: Id,
    mode: Schema.Literals(["reply", "reply-all", "forward"]),
  }),
  cmd("SaveDraft", { draftId: Id, expectedRevision: Revision, content: MailDraftContent }),
  cmd("DeleteDraft", { draftId: Id }),
  cmd("Send", {
    draftId: Id,
    expectedRevision: Revision,
    sendAt: Schema.optional(Timestamp),
    afterSend: Schema.optional(MailAfterSend),
    individually: Schema.optional(Schema.Boolean),
  }),
  cmd("CancelSend", { sendJobId: Id }),
  cmd("ResolveUnknownSend", {
    sendJobId: Id,
    decision: Schema.Union([
      Schema.TaggedStruct("Accepted", { providerId: Text(256) }),
      Schema.TaggedStruct("Rejected", {}),
      Schema.TaggedStruct("Resend", {}),
    ]),
  }),
  cmd("ReserveUpload", { filename: Text(255), contentType: Text(255), declaredSize: Revision }),
  cmd("CompleteUpload", { uploadId: Id, actualSize: Revision }),
  cmd("AbortUpload", { uploadId: Id }),
  cmd("CreateFileLink", { uploadId: Id, expiresAt: Schema.optional(Timestamp) }),
  cmd("RevokeFileLink", { linkId: Id }),
  cmd("Redeliver", {
    deliveryId: Id,
    targetMailboxId: Id,
    mode: Schema.Literals(["copy", "move"]),
  }),
]);

export type MailboxCommand = typeof MailboxCommand.Type;

export type MailboxCommandTag = MailboxCommand["_tag"];

export const decodeMailboxCommand = Schema.decodeUnknownEffect(MailboxCommand);

export const MailViewQuery = Schema.Struct({
  view: MailViewName,
  label: Schema.optional(Text(64)),
  cursor: Schema.optional(Text(1024)),
  limit: Schema.optional(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
  ),
});

export type MailViewQuery = typeof MailViewQuery.Type;

export const MailBubble = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Scheduled", {
    at: Timestamp,
    generation: Revision,
    condition: Schema.optional(MailBubbleCondition),
  }),
  Schema.TaggedStruct("Pinned", {}),
]);

export const MailThreadSummary = Schema.Struct({
  threadId: Id,
  subject: Schema.String,
  originalSubject: Schema.String,
  sender: Schema.String,
  destination: MailDestination,
  disposition: Schema.Literals(["active", "screening", "screened-out", "spam", "trash"]),
  quarantined: Schema.Boolean,
  bundleKey: Schema.NullOr(Schema.String),
  bundleCount: Revision,
  newForYou: Schema.Boolean,
  revision: Revision,
  seenRevision: Revision,
  lastActivityAt: Timestamp,
  messageCount: Revision,
  attention: Schema.Struct({
    replyLater: Schema.Boolean,
    setAside: Schema.Boolean,
    unfollowed: Schema.Boolean,
    bubble: MailBubble,
  }),
  labels: Schema.Array(Schema.String),
  mergedInto: Schema.NullOr(Schema.String),
  newSinceVisit: Schema.Boolean,
});

export const MailViewPage = Schema.Struct({
  view: Schema.String,
  items: Schema.Array(MailThreadSummary),
  nextCursor: Schema.NullOr(Schema.String),
  /** Snapshot boundary to pass to bulk operations such as MarkAllSeen/ClearScreener. */
  boundary: Revision,
  /** Continuation pages only: threads that changed after the boundary (merge them at the top). */
  changedSinceBoundary: Schema.optional(Schema.Array(MailThreadSummary)),
  /** Remembered reading position and previous visit marker (E05/E06). */
  position: Schema.optional(Schema.NullOr(Schema.String)),
  previousVisitAt: Schema.optional(Timestamp),
  /**
   * Per-item ordering for merging pages across mailboxes (unified views): each item's sort key,
   * the view's direction, and a cursor that resumes right after that item.
   */
  order: Schema.optional(
    Schema.Struct({
      ascending: Schema.Boolean,
      keys: Schema.Array(Schema.Number),
      cursors: Schema.Array(Schema.String),
    }),
  ),
});

export type MailViewPage = typeof MailViewPage.Type;

export const MailSendResponse = Schema.Union([
  Schema.TaggedStruct("Queued", {
    sendJobIds: Schema.Array(Id),
    dueAt: Timestamp,
    deduplicated: Schema.Boolean,
  }),
  Schema.TaggedStruct("Conflict", { currentRevision: Revision }),
]);

export const MailCancelResponse = Schema.Union([
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("TooLate", { state: Schema.String }),
]);

export const MailSearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      id: Id,
      threadId: Schema.NullOr(Schema.String),
      date: Timestamp,
      snippet: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
  /** Indexing watermark; clients show "results may be incomplete" when lagging. */
  watermark: Revision,
  lagging: Schema.Boolean,
});

export const MailChangesResponse = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      seq: Revision,
      resource: Schema.String,
      kind: Schema.String,
      payload: Schema.Unknown,
      createdAt: Timestamp,
    }),
  ),
  cursor: Revision,
  /** When true, the client must refresh a snapshot instead of replaying. */
  expired: Schema.Boolean,
});

export const MailSendEventWebhook = Schema.Struct({
  eventId: Id,
  sendJobId: Id,
  mailboxId: Id,
  recipient: EmailAddress,
  outcome: Schema.Literals(["delivered", "bounced", "deferred", "rejected", "complained"]),
  detail: Schema.optional(Text(500)),
});

/** Unified view across the principal's mailboxes (E19): each row names its owning account. */
export const MailUnifiedItem = Schema.Struct({
  mailboxId: Id,
  identity: Schema.NullOr(
    Schema.Struct({ address: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  thread: MailThreadSummary,
});

export const MailUnifiedPage = Schema.Struct({
  view: Schema.String,
  items: Schema.Array(MailUnifiedItem),
  /** Per-mailbox continuation cursors; omitted mailboxes are exhausted. */
  cursors: Schema.Record(Schema.String, Schema.String),
});

/** Upload session (E20, §8 `/v1/uploads`): reserve → PUT parts → complete (size-verified, then scanned). */
export const MailUploadReserveRequest = Schema.Struct({
  mailboxId: Id,
  commandId: Id,
  filename: Text(255),
  /** Defaults to application/octet-stream; never trusted (uploads are scanned and sniffed). */
  contentType: Schema.optional(Text(255)),
  declaredSize: Revision,
});

/** A mailbox-scoped write that carries only the target mailbox and the client command ID. */
export const MailboxWriteRequest = Schema.Struct({ mailboxId: Id, commandId: Id });

export const MailDraftCreateRequest = Schema.Struct({
  mailboxId: Id,
  commandId: Id,
  threadId: Schema.optional(Id),
  content: MailDraftContent,
});

export const MailDraftSaveRequest = Schema.Struct({
  mailboxId: Id,
  commandId: Id,
  expectedRevision: Revision,
  content: MailDraftContent,
});

export const MailSendRequest = Schema.Struct({
  mailboxId: Id,
  commandId: Id,
  /** The draft revision being sent (optimistic concurrency). */
  revision: Revision,
  sendAt: Schema.optional(Timestamp),
  individually: Schema.optional(Schema.Boolean),
  /** Send-and-mark-done / send-and-bubble-up / send-and-pop (`ClearBubble`) (E08/E09). */
  afterSend: Schema.optional(MailAfterSend),
});

export const MailAttachmentZipRequest = Schema.Struct({
  items: Schema.Array(Schema.Struct({ deliveryId: Id, partId: Text(64) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
});
