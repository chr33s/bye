import { Context, Effect } from "effect";
import { requireStepUp, type StepUpRequired } from "../control/index.ts";
import type { Rejection } from "@bye/contracts";
import { NotFound, requireMailbox, requireScope, type Unavailable } from "../services.ts";

// Collaboration and publishing use cases (O03–O05, P01, P02). Shared resources live in
// SharedSpaceDO/WorldDO; these use cases enforce principal scopes, step-up for consequential
// sharing, and construct publish operations only from authenticated internal requests.

/** Authority refusals travel as the one `Rejection` (mapped to HTTP by `publicError`). */
export type SharedFailure = Rejection | NotFound | Unavailable | StepUpRequired;

export interface SharedAddressShape {
  readonly name?: string | undefined;
  readonly address: string;
}

export interface SharedMessageShape {
  readonly messageRef: string;
  readonly from: SharedAddressShape;
  readonly to: ReadonlyArray<SharedAddressShape>;
  readonly cc: ReadonlyArray<SharedAddressShape>;
  readonly subject: string;
  readonly snippet: string;
  readonly contentKey: string;
  readonly sentAt: number;
}

export interface PublicThreadShape {
  readonly subject: string;
  readonly messages: ReadonlyArray<Omit<SharedMessageShape, "messageRef">>;
}

/** RPC surface of SharedSpaceDO instances, selected by space ID. */
export class SharedSpaces extends Context.Service<
  SharedSpaces,
  {
    readonly shareThread: (
      spaceId: string,
      input: {
        readonly actorId: string;
        readonly sourceMailboxId: string;
        readonly sourceThreadId: string;
        readonly subject: string;
        readonly messages: ReadonlyArray<SharedMessageShape>;
        readonly grantees: ReadonlyArray<string>;
        readonly includeFuture: boolean;
      },
    ) => Effect.Effect<string, SharedFailure>;
    readonly revokeGrant: (
      spaceId: string,
      actorId: string,
      grantId: string,
    ) => Effect.Effect<void, SharedFailure>;
    readonly createPublicLink: (
      spaceId: string,
      actorId: string,
      threadId: string,
      options: { readonly includeFuture: boolean; readonly expiresAt?: number },
    ) => Effect.Effect<{ readonly linkId: string; readonly token: string }, SharedFailure>;
    readonly resolvePublicLink: (
      spaceId: string,
      token: string,
    ) => Effect.Effect<PublicThreadShape, SharedFailure>;
  }
>()("shared/SharedSpaces") {}

/** Reads the explicitly selected messages from the caller's own mailbox authority. */
export class MailboxSelection extends Context.Service<
  MailboxSelection,
  {
    readonly selectMessages: (
      mailboxId: string,
      threadId: string,
      messageRefs: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly subject: string; readonly messages: ReadonlyArray<SharedMessageShape> },
      SharedFailure
    >;
  }
>()("shared/MailboxSelection") {}

export interface WorldPublishShape {
  readonly origin: "internal-send";
  readonly authenticatedUserId: string;
  readonly fromAddress: string;
  readonly title: string;
  readonly html: string;
  readonly text: string;
  readonly media: ReadonlyArray<{
    readonly contentKey: string;
    readonly name: string;
    readonly contentType: string;
  }>;
  readonly publish: boolean;
}

/** Outcome of one publish: the committed version, and whether public caches were purged. */
export interface WorldPublished {
  readonly postId: string;
  readonly revision: number;
  readonly purged?: boolean;
}

/**
 * The World publish port. The adapter commits in the author's authority and owns every public side
 * effect (media copies, site, cache purge, fanout) durably — the use case never copies content.
 */
export class WorldPublishing extends Context.Service<
  WorldPublishing,
  {
    readonly publish: (
      authorId: string,
      op: WorldPublishShape,
    ) => Effect.Effect<WorldPublished, SharedFailure>;
  }
>()("shared/WorldPublishing") {}

/** Publishing an existing draft/post goes through the same adapter pipeline as `publish`. */
export class WorldPostPublishing extends Context.Service<
  WorldPostPublishing,
  {
    readonly publishExisting: (
      authorId: string,
      postId: string,
    ) => Effect.Effect<WorldPublished, SharedFailure>;
  }
>()("shared/WorldPostPublishing") {}

/** Share explicitly selected history of a thread from the caller's mailbox into a space (O04). */
export const shareThread = (input: {
  readonly spaceId: string;
  readonly sourceMailboxId: string;
  readonly sourceThreadId: string;
  readonly messageRefs: ReadonlyArray<string>;
  readonly grantees: ReadonlyArray<string>;
  readonly includeFuture: boolean;
}) =>
  Effect.gen(function* () {
    // Sharing copies content out of the mailbox: a write, never allowed to read-only credentials.
    const principal = yield* requireMailbox(input.sourceMailboxId, "draft");
    yield* requireStepUp("sharing");
    const selection = yield* (yield* MailboxSelection).selectMessages(
      input.sourceMailboxId,
      input.sourceThreadId,
      input.messageRefs,
    );
    if (selection.messages.length !== input.messageRefs.length)
      return yield* new NotFound({ resource: "message" });
    return yield* (yield* SharedSpaces).shareThread(input.spaceId, {
      actorId: principal.userId,
      sourceMailboxId: input.sourceMailboxId,
      sourceThreadId: input.sourceThreadId,
      subject: selection.subject,
      messages: selection.messages,
      grantees: input.grantees,
      includeFuture: input.includeFuture,
    });
  }).pipe(Effect.withSpan("shared.shareThread"));

/** Public bearer links are consequential: they require a recent step-up (§10). */
export const createPublicThreadLink = (
  input: {
    readonly spaceId: string;
    readonly threadId: string;
    readonly includeFuture: boolean;
    readonly expiresAt?: number;
  },
  publicOrigin: string,
) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("draft");
    yield* requireStepUp("sharing");
    const link = yield* (yield* SharedSpaces).createPublicLink(
      input.spaceId,
      principal.userId,
      input.threadId,
      input.expiresAt === undefined
        ? { includeFuture: input.includeFuture }
        : { includeFuture: input.includeFuture, expiresAt: input.expiresAt },
    );
    return { linkId: link.linkId, url: `${publicOrigin}/s/${input.spaceId}/${link.token}` };
  });

/**
 * Publish a World post from the authenticated API/internal send path. The publish operation is
 * constructed here from the verified principal; an inbound SMTP message can never reach it.
 */
export const publishWorldPost = (input: {
  readonly fromAddress: string;
  readonly title: string;
  readonly html: string;
  readonly text: string;
  readonly media: ReadonlyArray<{
    readonly contentKey: string;
    readonly name: string;
    readonly contentType: string;
  }>;
  readonly publish: boolean;
}) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("publish");
    const published = yield* (yield* WorldPublishing).publish(principal.userId, {
      origin: "internal-send",
      authenticatedUserId: principal.userId,
      ...input,
    });
    return {
      postId: published.postId,
      revision: published.revision,
      ...(published.purged === undefined ? {} : { purged: published.purged }),
    };
  }).pipe(Effect.withSpan("world.publish"));

/** Publish an existing draft or unpublished post through the same pipeline (P01). */
export const publishExistingPost = (postId: string) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("publish");
    const published = yield* (yield* WorldPostPublishing).publishExisting(principal.userId, postId);
    return {
      postId: published.postId,
      revision: published.revision,
      purged: published.purged ?? false,
    };
  }).pipe(Effect.withSpan("world.publishExisting"));
