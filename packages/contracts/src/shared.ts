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
/** Operator resolution of a held newsletter operation, with the evidence relied on. */
export const NewsletterResolveRequest = Schema.Struct({
  opId: Text(256),
  resolution: Schema.Literals(["accepted", "not-accepted"]),
  note: Text(300),
  providerRef: Schema.optional(Text(256)),
});
