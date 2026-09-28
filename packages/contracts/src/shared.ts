import { Schema } from "effect";

// Collaboration and publishing contracts (O03–O05, E14 shared collections, P01, P02).

const Id = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)));

const Text = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));

const Address = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/), Schema.isMaxLength(320)),
);

const Timestamp = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export const SharedAddressSchema = Schema.Struct({
  name: Schema.optional(Text(200)),
  address: Address,
});

export const ShareThreadRequest = Schema.Struct({
  spaceId: Id,
  /** The caller's mailbox and thread the history is shared from. */
  mailboxId: Id,
  threadId: Id,
  /** Explicitly selected history; nothing else is shared. */
  messageRefs: Schema.Array(Id).pipe(Schema.check(Schema.isMaxLength(500))),
  grantees: Schema.optional(Schema.Array(Id).pipe(Schema.check(Schema.isMaxLength(500)))),
  includeFuture: Schema.optional(Schema.Boolean),
});

export type ShareThreadRequest = typeof ShareThreadRequest.Type;

export const GrantRequest = Schema.Struct({
  /** Defaults to "thread". `kind` is the older spelling of the same field. */
  resourceKind: Schema.optional(Schema.Literals(["thread", "collection"])),
  kind: Schema.optional(Schema.Literals(["thread", "collection"])),
  resourceId: Id,
  grantee: Id,
});

export const CommentRequest = Schema.Struct({
  body: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20_000))),
});

export const CreateCollectionRequest = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  shareWithMembers: Schema.optional(Schema.Boolean),
});

export const CollectionItemRequest = Schema.Struct({ threadId: Id });

export const SharedMessageViewSchema = Schema.Struct({
  messageRef: Id,
  from: SharedAddressSchema,
  to: Schema.Array(SharedAddressSchema),
  cc: Schema.Array(SharedAddressSchema),
  subject: Schema.String,
  snippet: Schema.String,
  sentAt: Timestamp,
});

export const SharedThreadViewSchema = Schema.Struct({
  id: Id,
  subject: Schema.String,
  includeFuture: Schema.Boolean,
  messages: Schema.Array(SharedMessageViewSchema),
});

export const PublicLinkRequest = Schema.Struct({
  spaceId: Id,
  threadId: Id,
  includeFuture: Schema.optional(Schema.Boolean),
  expiresAt: Schema.optional(Timestamp),
});

export const PublicLinkCreated = Schema.Struct({ linkId: Id, url: Schema.String });

export const PublicThreadViewSchema = Schema.Struct({
  subject: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      from: SharedAddressSchema,
      to: Schema.Array(SharedAddressSchema),
      cc: Schema.Array(SharedAddressSchema),
      subject: Schema.String,
      snippet: Schema.String,
      sentAt: Timestamp,
    }),
  ),
});

export const WorldMedia = Schema.Struct({
  contentKey: Text(512),
  name: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.\- ]{1,200}$/))),
  contentType: Text(200),
});

/** Publish (or save) a post authored from one of the caller's own identities (`from`). */
export const WorldPostRequest = Schema.Struct({
  from: Address,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
  html: Text(1_000_000),
  text: Text(1_000_000),
  /** Defaults to true; false saves without publishing. */
  publish: Schema.optional(Schema.Boolean),
});

export type WorldPostRequest = typeof WorldPostRequest.Type;

export const CreateSpaceRequest = Schema.Struct({ organizationId: Id });

export const SpaceMemberRequest = Schema.Struct({ role: Schema.Literals(["owner", "member"]) });

export const WorldDraftRequest = Schema.Struct({
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
  html: Text(512 * 1024),
  text: Text(512 * 1024),
  media: Schema.optional(Schema.Array(WorldMedia).pipe(Schema.check(Schema.isMaxLength(20)))),
});

/**
 * Connect (or repair) the instance newsletter provider with one API key. The key is only
 * type-checked here, so a decode error never echoes it; its format is checked by the handler.
 */
export const NewsletterConfigRequest = Schema.Struct({
  provider: Schema.Literals(["resend"]),
  apiKey: Schema.String,
});

/** What any signed-in user may learn about the instance's newsletter provider. No secrets. */
export const NewsletterConfigView = Schema.Struct({
  provider: Schema.Literals(["resend"]),
  status: Schema.Literals(["unconfigured", "ready", "blocked", "needs-attention"]),
  qualified: Schema.Boolean,
  canConfigure: Schema.Boolean,
  configuredAt: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
});

export type NewsletterConfigView = typeof NewsletterConfigView.Type;

/** Operator resolution of a held newsletter operation, with the evidence relied on. */
export const NewsletterResolveRequest = Schema.Struct({
  opId: Text(256),
  resolution: Schema.Literals(["accepted", "not-accepted"]),
  note: Text(300),
  providerRef: Schema.optional(Text(256)),
});

// ---- responses (§8): plain wire shapes, exactly what the handlers answer ----

/** A stored address as the space recorded it (unchecked: responses echo what was stored). */
const StoredAddress = Schema.Struct({
  name: Schema.optional(Schema.String),
  address: Schema.String,
});

const StoredMessage = Schema.Struct({
  messageRef: Schema.String,
  from: StoredAddress,
  to: Schema.Array(StoredAddress),
  cc: Schema.Array(StoredAddress),
  subject: Schema.String,
  snippet: Schema.String,
  contentKey: Schema.String,
  sentAt: Schema.Number,
  addedAt: Schema.Number,
});

export const SpaceCreated = Schema.Struct({ spaceId: Schema.String });

export type SpaceCreated = typeof SpaceCreated.Type;

export const SpaceList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, orgId: Schema.String, kind: Schema.String }),
  ),
});

export type SpaceList = typeof SpaceList.Type;

export const SpaceMemberList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      role: Schema.Literals(["owner", "member"]),
      addedAt: Schema.Number,
    }),
  ),
});

export type SpaceMemberList = typeof SpaceMemberList.Type;

export const SpaceMemberSet = Schema.Struct({
  userId: Schema.String,
  role: Schema.Literals(["owner", "member"]),
});

export type SpaceMemberSet = typeof SpaceMemberSet.Type;

export const SpaceMemberRemoved = Schema.Struct({ removed: Schema.Literal(true) });

export type SpaceMemberRemoved = typeof SpaceMemberRemoved.Type;

/** Shared threads the caller can read, and deliveries still propagating into the space (§6 row 6). */
export const SpaceThreadList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      subject: Schema.String,
      includeFuture: Schema.Boolean,
      createdAt: Schema.Number,
      messages: Schema.Number,
    }),
  ),
  pendingPropagation: Schema.Number,
});

export type SpaceThreadList = typeof SpaceThreadList.Type;

export const SpaceThreadView = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  includeFuture: Schema.Boolean,
  messages: Schema.Array(StoredMessage),
  pendingPropagation: Schema.Number,
});

export type SpaceThreadView = typeof SpaceThreadView.Type;

export const SpaceCommentList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      authorId: Schema.String,
      body: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
});

export type SpaceCommentList = typeof SpaceCommentList.Type;

export const SpaceCommentCreated = Schema.Struct({ commentId: Schema.String });

export type SpaceCommentCreated = typeof SpaceCommentCreated.Type;

export const SpaceCollectionList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      ownerId: Schema.String,
      items: Schema.Number,
    }),
  ),
});

export type SpaceCollectionList = typeof SpaceCollectionList.Type;

export const SpaceCollectionCreated = Schema.Struct({ collectionId: Schema.String });

export type SpaceCollectionCreated = typeof SpaceCollectionCreated.Type;

/** A collection's aggregated timeline: messages of the threads the viewer can read. */
export const SpaceCollectionTimeline = Schema.Struct({
  items: Schema.Array(Schema.Struct({ ...StoredMessage.fields, threadId: Schema.String })),
});

export type SpaceCollectionTimeline = typeof SpaceCollectionTimeline.Type;

export const SpaceCollectionItemAdded = Schema.Struct({ added: Schema.Literal(true) });

export type SpaceCollectionItemAdded = typeof SpaceCollectionItemAdded.Type;

export const SpaceGrantList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      grantee: Schema.String,
      createdBy: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
});

export type SpaceGrantList = typeof SpaceGrantList.Type;

export const SpaceGrantCreated = Schema.Struct({ grantId: Schema.String });

export type SpaceGrantCreated = typeof SpaceGrantCreated.Type;

export const SpaceRevoked = Schema.Struct({ revoked: Schema.Literal(true) });

export type SpaceRevoked = typeof SpaceRevoked.Type;

/** Exactly what an anonymous viewer of a public link would see. */
export const PublicThreadPreview = Schema.Struct({
  subject: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      from: StoredAddress,
      to: Schema.Array(StoredAddress),
      cc: Schema.Array(StoredAddress),
      subject: Schema.String,
      snippet: Schema.String,
      contentKey: Schema.String,
      sentAt: Schema.Number,
    }),
  ),
});

export type PublicThreadPreview = typeof PublicThreadPreview.Type;

export const PublicLinkList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      includeFuture: Schema.Boolean,
      createdAt: Schema.Number,
      expiresAt: Schema.NullOr(Schema.Number),
    }),
  ),
});

export type PublicLinkList = typeof PublicLinkList.Type;

/** The committed version of a publish; `purged` when the public caches were refreshed. */
export const WorldPublished = Schema.Struct({
  postId: Schema.String,
  revision: Schema.Number,
  purged: Schema.optionalKey(Schema.Boolean),
});

export type WorldPublished = typeof WorldPublished.Type;

export const WorldInfo = Schema.Struct({
  handle: Schema.String,
  url: Schema.String,
  publishAddress: Schema.String,
});

export type WorldInfo = typeof WorldInfo.Type;

const WorldPostStatus = Schema.Literals(["draft", "published", "unpublished"]);

export const WorldPostList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      status: WorldPostStatus,
      title: Schema.String,
      revision: Schema.Number,
      publishedAt: Schema.NullOr(Schema.Number),
      updatedAt: Schema.Number,
    }),
  ),
});

export type WorldPostList = typeof WorldPostList.Type;

export const WorldDraftCreated = Schema.Struct({ postId: Schema.String, revision: Schema.Number });

export type WorldDraftCreated = typeof WorldDraftCreated.Type;

export const WorldPostRevision = Schema.Struct({ revision: Schema.Number });

export type WorldPostRevision = typeof WorldPostRevision.Type;

/** Author-only view of a post's latest revision, including unpublished drafts. */
export const WorldPostView = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  status: WorldPostStatus,
  revision: Schema.Number,
  title: Schema.String,
  html: Schema.String,
  text: Schema.String,
  media: Schema.Array(
    Schema.Struct({ name: Schema.String, contentType: Schema.String, publicKey: Schema.String }),
  ),
  publishedAt: Schema.NullOr(Schema.Number),
});

export type WorldPostView = typeof WorldPostView.Type;

export const WorldPostPublished = Schema.Struct({
  postId: Schema.String,
  revision: Schema.Number,
  purged: Schema.Boolean,
});

export type WorldPostPublished = typeof WorldPostPublished.Type;

export const WorldPostUnpublished = Schema.Struct({
  unpublished: Schema.Literal(true),
  purged: Schema.Boolean,
});

export type WorldPostUnpublished = typeof WorldPostUnpublished.Type;

/** One newsletter publication (spec.md §5.5): intent, provider-observed state, cancellation. */
export const NewsletterPublication = Schema.Struct({
  id: Schema.String,
  postId: Schema.String,
  revision: Schema.Number,
  provider: Schema.String,
  account: Schema.String,
  configVersion: Schema.String,
  sender: Schema.String,
  subject: Schema.String,
  fingerprint: Schema.String,
  recipients: Schema.Number,
  scheduledAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.Number,
  state: Schema.Literals([
    "approved",
    "draft-pending",
    "drafted",
    "submit-pending",
    "submitted",
    "scheduled",
    "sent",
    "cancelled",
    "held",
    "failed",
  ]),
  providerRef: Schema.NullOr(Schema.String),
  observed: Schema.NullOr(
    Schema.Literals(["draft", "scheduled", "queued", "sending", "sent", "cancelled"]),
  ),
  /** Reported as requested/confirmed/unsupported/uncertain; never a recall. */
  cancel: Schema.NullOr(
    Schema.Union([
      Schema.TaggedStruct("Requested", {}),
      Schema.TaggedStruct("Confirmed", { coverage: Schema.Literals(["complete", "partial"]) }),
      Schema.TaggedStruct("Unsupported", { detail: Schema.String }),
      Schema.TaggedStruct("Uncertain", { detail: Schema.String }),
    ]),
  ),
  detail: Schema.NullOr(Schema.String),
});

export type NewsletterPublication = typeof NewsletterPublication.Type;

/** One provider operation of a publication, with its own persisted identity. */
export const NewsletterOperation = Schema.Struct({
  opId: Schema.String,
  publicationId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["audience", "create", "send", "cancel"]),
  state: Schema.Literals(["pending", "in-flight", "accepted", "rejected", "unknown", "held"]),
  attempts: Schema.Number,
  firstAttemptAt: Schema.NullOr(Schema.Number),
  providerRef: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});

export type NewsletterOperation = typeof NewsletterOperation.Type;

/** Author-scoped publication status: recipient outcomes, audience drift, operations. */
export const NewsletterStatusView = Schema.Struct({
  publication: NewsletterPublication,
  outcomes: Schema.Record(Schema.String, Schema.Number),
  drift: Schema.Number,
  ops: Schema.Array(NewsletterOperation),
});

export type NewsletterStatusView = typeof NewsletterStatusView.Type;

/** Operator review of one creator's newsletter work that is held or unknown. */
export const NewsletterReview = Schema.Struct({
  health: Schema.Struct({
    unknownOps: Schema.Number,
    heldOps: Schema.Number,
    syncPending: Schema.Number,
    syncHeld: Schema.Number,
    oldestSyncPendingAt: Schema.NullOr(Schema.Number),
    openPublication: Schema.NullOr(Schema.String),
    uncertainCancels: Schema.Number,
    unmappedEvents: Schema.Number,
  }),
  held: Schema.Array(NewsletterOperation),
  publications: Schema.Array(NewsletterPublication),
});

export type NewsletterReview = typeof NewsletterReview.Type;

export const NewsletterResolved = Schema.Struct({
  op: NewsletterOperation,
  publication: Schema.NullOr(NewsletterPublication),
});

export type NewsletterResolved = typeof NewsletterResolved.Type;
