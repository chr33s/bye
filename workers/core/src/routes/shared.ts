// Collaboration and publishing routes (O03–O05, P01, P02, E14).
import { Effect } from "effect";
import {
  createPublicThreadLink,
  Forbidden,
  NotFound,
  publishExistingPost,
  publishWorldPost,
  requireOperatorAccess,
  requireScope,
  requireStepUp,
  shareThread,
} from "@bye/application";
import {
  ApiError,
  CommentRequest,
  CollectionItemRequest,
  CreateCollectionRequest,
  CreateSpaceRequest,
  GrantRequest,
  NewsletterResolveRequest,
  PublicLinkRequest,
  ShareThreadRequest,
  SpaceMemberRequest,
  WorldDraftRequest,
  WorldPostRequest,
} from "@bye/contracts";
import { call, space, world } from "../authorities.ts";
import type { CoreEnv } from "../env.ts";
import { PayloadTooLargeError, readBodyCapped, route, type Route } from "../http.ts";
import { sniffRaster } from "../images.ts";
import { ledgerOf, runNewsletter } from "../newsletter.ts";
import { publicOrigin, serviceDomain } from "../origins.ts";
import {
  refreshSite,
  sendSubscriptionConfirmation,
  SystemMailRefused,
  worldAuthor,
  worldPublishingLayer,
} from "../publishing.ts";
import { pendingPropagation } from "../topics/shared.ts";
import { authed, authedBody, readTextCapped } from "./common.ts";
import { OrgsService, RegistryService } from "@bye/platform-cloudflare";

const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const CSV_MAX_BYTES = 1024 * 1024;
/**
 * Per-author World media storage (private uploads under t/<user>/world-media/). Media is outside
 * the mailbox quota, so it gets its own bound: bytes and objects, counted from the listing.
 */
const MEDIA_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MEDIA_MAX_OBJECTS = 1000;

const tooLarge = (message: string) =>
  Effect.fail(new ApiError({ code: "payload_too_large", message }));

/** The author's stored World media (bytes, objects); stops counting once past the bounds. */
const mediaUsage = async (env: CoreEnv, userId: string) => {
  let bytes = 0;
  let objects = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.PARTS.list({
      prefix: `t/${userId}/world-media/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of listed.objects) {
      bytes += o.size ?? 0;
      objects += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && objects < MEDIA_MAX_OBJECTS && bytes < MEDIA_MAX_TOTAL_BYTES);
  return { bytes, objects };
};

const badRequest = (message: string) => Effect.fail(new ApiError({ code: "bad_request", message }));

/** The caller's World authority (idempotently initialized). */
const myWorld = (env: CoreEnv, userId: string) =>
  Effect.gen(function* () {
    const author = yield* Effect.tryPromise({
      try: () => worldAuthor(env, userId),
      catch: () => new ApiError({ code: "unavailable", message: "world unavailable" }),
    });
    if (!author) return yield* new NotFound({ resource: "author" });
    return { author, stub: world(env, author.handle) };
  });

type MediaRef = {
  readonly contentKey: string;
  readonly name: string;
  readonly contentType: string;
};

/** Draft media must be the author's own uploaded World media (never arbitrary private keys). */
const ownMedia = (userId: string, media: ReadonlyArray<MediaRef> | undefined) =>
  (media ?? []).every(
    (m) =>
      m.contentKey.startsWith(`t/${userId}/world-media/`) && m.contentType.startsWith("image/"),
  )
    ? Effect.succeed(
        (media ?? []).map((m) => ({
          contentKey: m.contentKey,
          name: m.name,
          contentType: m.contentType,
        })),
      )
    : badRequest("media must reference your uploaded images");

const postInput = (userId: string, body: typeof WorldDraftRequest.Type) =>
  body.title.trim()
    ? Effect.map(ownMedia(userId, body.media), (media) => ({
        title: body.title.trim(),
        html: body.html,
        text: body.text,
        media,
      }))
    : badRequest("title required");

/**
 * A space the caller's organizations own (registered in D1 at creation). Reads need `read`;
 * collaboration writes (comments, collections, grants) need `draft`; membership and revoking
 * others' access need `admin`. Read-only credentials (agents, support sessions, lapsed accounts)
 * can therefore never change a space.
 */
const orgSpace = (env: CoreEnv, spaceId: string, scope: "read" | "draft" | "admin" = "read") =>
  Effect.gen(function* () {
    const principal = yield* requireScope(scope);
    const s = yield* (yield* RegistryService).spaceOrg(spaceId);
    if (!s || !principal.organizationIds.includes(s.orgId))
      return yield* new NotFound({ resource: "space" });
    return { principal, orgId: s.orgId, stub: space(env, spaceId) };
  });

/**
 * `orgSpace` for the body-addressed sharing routes: a space outside the caller's active
 * organizations (unknown, foreign, or one they were removed/suspended from) is refused as
 * forbidden, alike for all three.
 */
const sharingSpace = (env: CoreEnv, spaceId: string) =>
  orgSpace(env, spaceId, "draft").pipe(
    Effect.catchTag("NotFound", () =>
      Effect.fail(new Forbidden({ reason: "not a member of the space's organization" })),
    ),
  );

export const sharedRoutes: ReadonlyArray<Route<CoreEnv>> = [
  // ---- shared spaces (O03/O04) ----
  route(
    "POST",
    "/v1/spaces",
    authedBody(
      CreateSpaceRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          const principal = yield* requireScope("admin");
          if (!principal.organizationIds.includes(body.organizationId))
            return yield* new Forbidden({ reason: "not a member of organization" });
          const spaceId = `spc_${crypto.randomUUID().replace(/-/g, "")}`;
          // Extension spaces are created with their mailbox (POST /v1/orgs/:orgId/extensions).
          yield* call(() =>
            space(env, spaceId).initSpace({
              spaceId,
              kind: "team",
              organizationId: body.organizationId,
              ownerId: principal.userId,
            }),
          );
          yield* (yield* RegistryService).registerSpace(
            spaceId,
            body.organizationId,
            "team",
            principal.userId,
          );
          return { spaceId };
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/spaces",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const all = yield* (yield* RegistryService).spacesForOrgs(principal.organizationIds);
        const member = yield* Effect.forEach(
          all,
          (s) => call(() => space(env, s.id).isMember(principal.userId)),
          { concurrency: 4 },
        );
        return { items: all.filter((_, i) => member[i] === true) };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/members",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return { items: yield* call(() => stub.listMembers(principal.userId)) };
      }),
    ),
  ),
  route(
    "PUT",
    "/v1/spaces/:id/members/:userId",
    authedBody(SpaceMemberRequest, ({ env, params, body }) =>
      Effect.gen(function* () {
        const { principal, orgId, stub } = yield* orgSpace(env, params.id!, "admin");
        // Only active organization members can join the organization's spaces.
        const m = yield* (yield* OrgsService).membership(orgId, params.userId!);
        if (!m || m.status !== "active")
          return yield* badRequest("user is not an active organization member");
        yield* call(() => stub.setMember(principal.userId, params.userId!, body.role));
        return { userId: params.userId, role: body.role };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/spaces/:id/members/:userId",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!, "admin");
        yield* call(() => stub.setMember(principal.userId, params.userId!, null));
        return { removed: true };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/threads",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        const items = yield* call(() => stub.listThreads(principal.userId));
        // Deliveries still propagating into this space (§6 row 6): clients show "syncing".
        return {
          items,
          pendingPropagation: yield* Effect.promise(() => pendingPropagation(env, params.id!)),
        };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/threads/:threadId",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        const thread = yield* call(() => stub.readThread(principal.userId, params.threadId!));
        return {
          ...thread,
          pendingPropagation: yield* Effect.promise(() =>
            pendingPropagation(env, params.id!, params.threadId!),
          ),
        };
      }),
    ),
  ),
  // Member-only change feed (§8); pair with `/v1/live?space=<id>` for change hints.
  route(
    "GET",
    "/v1/spaces/:id/changes",
    authed(({ env, params, url }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        if (!Number.isInteger(cursor) || cursor < 0) return yield* badRequest("invalid cursor");
        return yield* call(() => stub.changes(principal.userId, cursor));
      }),
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/threads/:threadId/comments",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return { items: yield* call(() => stub.comments(principal.userId, params.threadId!)) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/spaces/:id/threads/:threadId/comments",
    authedBody(
      CommentRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const { principal, stub } = yield* orgSpace(env, params.id!, "draft");
          const text = body.body.trim();
          if (!text) return yield* badRequest("comment body required");
          return {
            commentId: yield* call(() => stub.addComment(principal.userId, params.threadId!, text)),
          };
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/collections",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return { items: yield* call(() => stub.listCollections(principal.userId)) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/spaces/:id/collections",
    authedBody(
      CreateCollectionRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const { principal, stub } = yield* orgSpace(env, params.id!, "draft");
          const name = body.name.trim();
          if (!name) return yield* badRequest("name required");
          return {
            collectionId: yield* call(() =>
              stub.createCollection(principal.userId, name, body.shareWithMembers ?? false),
            ),
          };
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/collections/:collectionId",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return {
          items: yield* call(() => stub.collectionTimeline(principal.userId, params.collectionId!)),
        };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/spaces/:id/collections/:collectionId/threads",
    authedBody(
      CollectionItemRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const { principal, stub } = yield* orgSpace(env, params.id!, "draft");
          yield* call(() =>
            stub.addToCollection(principal.userId, params.collectionId!, body.threadId),
          );
          return { added: true };
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/grants",
    authed(({ env, params, url }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        const kind = url.searchParams.get("kind") === "collection" ? "collection" : "thread";
        return {
          items: yield* call(() =>
            stub.grantsFor(principal.userId, kind, url.searchParams.get("resourceId") ?? ""),
          ),
        };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/spaces/:id/grants",
    authedBody(
      GrantRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const { principal, stub } = yield* orgSpace(env, params.id!, "draft");
          yield* requireStepUp("sharing");
          const kind = body.resourceKind ?? body.kind ?? "thread";
          return {
            grantId: yield* call(() =>
              stub.grant(principal.userId, kind, body.resourceId, body.grantee),
            ),
          };
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/spaces/:id/grants/:grantId",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!, "admin");
        yield* call(() => stub.revoke(principal.userId, params.grantId!));
        return { revoked: true };
      }),
    ),
  ),
  // Sharing a thread registers it so future replies can be appended (O04, "shared.delivery" topic).
  route(
    "POST",
    "/v1/shared-threads",
    authedBody(
      ShareThreadRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          // The same organization binding as every /v1/spaces/:id route: a member removed from or
          // suspended in the space's organization can no longer share into it.
          yield* sharingSpace(env, body.spaceId);
          const input = {
            spaceId: body.spaceId,
            sourceMailboxId: body.mailboxId,
            sourceThreadId: body.threadId,
            messageRefs: body.messageRefs,
            grantees: body.grantees ?? [],
            includeFuture: body.includeFuture ?? false,
          };
          const sharedThreadId = yield* shareThread(input);
          yield* (yield* RegistryService).registerSharedThread({
            mailboxId: input.sourceMailboxId,
            threadId: input.sourceThreadId,
            spaceId: input.spaceId,
            sharedThreadId,
            includeFuture: input.includeFuture,
          });
          return sharedThreadId;
        }),
      { status: 201 },
    ),
  ),

  // ---- public links (O05) ----
  route(
    "POST",
    "/v1/public-links",
    authedBody(
      PublicLinkRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          // Organization binding first (as `orgSpace` routes): the space authority only knows
          // space membership, which org removal/suspension does not update.
          yield* sharingSpace(env, body.spaceId);
          return yield* createPublicThreadLink(
            {
              spaceId: body.spaceId,
              threadId: body.threadId,
              includeFuture: body.includeFuture ?? false,
              ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
            },
            publicOrigin(env),
          );
        }),
      { status: 201 },
    ),
  ),
  // Exactly what an anonymous viewer would see, before a link is created.
  route(
    "GET",
    "/v1/spaces/:id/threads/:threadId/public-preview",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return yield* call(() => stub.previewPublicLink(principal.userId, params.threadId!));
      }),
    ),
  ),
  route(
    "GET",
    "/v1/spaces/:id/threads/:threadId/public-links",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!);
        return {
          items: yield* call(() => stub.listPublicLinks(principal.userId, params.threadId!)),
        };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/spaces/:id/public-links/:linkId",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { principal, stub } = yield* orgSpace(env, params.id!, "admin");
        yield* call(() => stub.revokePublicLink(principal.userId, params.linkId!));
        return { revoked: true };
      }),
    ),
  ),

  // ---- World publishing (P01) and subscriptions (P02): one publish pipeline (publishing.ts) ----
  route(
    "POST",
    "/v1/world/posts",
    authedBody(
      WorldPostRequest,
      ({ body, env }) =>
        publishWorldPost({
          fromAddress: body.from,
          title: body.title,
          html: body.html,
          text: body.text,
          media: [],
          publish: body.publish ?? true,
        }).pipe(Effect.provide(worldPublishingLayer(env))),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/world",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const { author } = yield* myWorld(env, principal.userId);
        return {
          handle: author.handle,
          url: `${publicOrigin(env)}/@${author.handle}/`,
          publishAddress: `world@${serviceDomain(env)}`,
        };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/world/posts",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const { stub } = yield* myWorld(env, principal.userId);
        return { items: yield* call(() => stub.listPosts(principal.userId)) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/world/drafts",
    authedBody(
      WorldDraftRequest,
      ({ env, body }) =>
        Effect.gen(function* () {
          const principal = yield* requireScope("publish");
          const input = yield* postInput(principal.userId, body);
          const { stub } = yield* myWorld(env, principal.userId);
          return yield* call(() => stub.createDraft(principal.userId, input));
        }),
      { status: 201 },
    ),
  ),
  route(
    "PUT",
    "/v1/world/posts/:id",
    authedBody(WorldDraftRequest, ({ env, params, body }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("publish");
        const input = yield* postInput(principal.userId, body);
        const { stub } = yield* myWorld(env, principal.userId);
        return { revision: yield* call(() => stub.editPost(principal.userId, params.id!, input)) };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/world/posts/:id/preview",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const { stub } = yield* myWorld(env, principal.userId);
        return yield* call(() => stub.previewPost(principal.userId, params.id!));
      }),
    ),
  ),
  route(
    "POST",
    "/v1/world/posts/:id/publish",
    authed(({ env, params }) =>
      publishExistingPost(params.id!).pipe(Effect.provide(worldPublishingLayer(env))),
    ),
  ),
  route(
    "POST",
    "/v1/world/posts/:id/unpublish",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("publish");
        const { author, stub } = yield* myWorld(env, principal.userId);
        const post = yield* call(() => stub.previewPost(principal.userId, params.id!));
        yield* call(() => stub.unpublish(principal.userId, params.id!));
        const { purged } = yield* Effect.promise(() =>
          refreshSite(env, author.handle, [post.slug]),
        );
        return { unpublished: true, purged };
      }),
    ),
  ),
  // Newsletter publication status: intent, provider-observed state, recipient outcomes (spec.md §5.5).
  route(
    "GET",
    "/v1/world/posts/:id/newsletter",
    authed(({ env, params, url }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const { stub } = yield* myWorld(env, principal.userId);
        return yield* call(() =>
          stub.newsletterStatus(
            principal.userId,
            params.id!,
            Number(url.searchParams.get("revision") ?? "1"),
          ),
        );
      }),
    ),
  ),
  // Cancel a publication. Reported as requested/confirmed/unsupported/uncertain; never a recall.
  route(
    "POST",
    "/v1/world/posts/:id/newsletter/cancel",
    authed(({ env, params, url }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("publish");
        const { author, stub } = yield* myWorld(env, principal.userId);
        const publication = yield* call(() =>
          stub.cancelNewsletter(
            principal.userId,
            params.id!,
            Number(url.searchParams.get("revision") ?? "1"),
          ),
        );
        // Try the provider step now; the cron reconciler finishes it otherwise.
        yield* Effect.promise(() => runNewsletter(env, author.handle).catch(() => undefined));
        return publication;
      }),
    ),
  ),
  // Operator review of newsletter work that is held or unknown (never auto-resolved or failed over).
  route(
    "GET",
    "/v1/operator/newsletters/:handle",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        yield* requireOperatorAccess();
        const L = ledgerOf(env, params.handle!);
        const [health, held, publications] = yield* Effect.promise(() =>
          Promise.all([L("health"), L("heldOps"), L("publications")]),
        );
        return { health, held, publications };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/operator/newsletters/:handle/resolve",
    authedBody(NewsletterResolveRequest, ({ env, params, body }) =>
      Effect.gen(function* () {
        const operator = yield* requireOperatorAccess();
        const L = ledgerOf(env, params.handle!);
        const op = yield* Effect.tryPromise({
          try: () =>
            L(
              "resolveHeldOp",
              body.opId,
              body.resolution,
              `${operator.userId}: ${body.note}`,
              body.providerRef,
            ),
          catch: () => new ApiError({ code: "conflict", message: "operation cannot be resolved" }),
        });
        const publication = op.publicationId
          ? yield* Effect.tryPromise({
              try: () => L("resumeHeld", op.publicationId!),
              catch: () => new ApiError({ code: "conflict", message: "publication not resumable" }),
            }).pipe(Effect.orElseSucceed(() => null))
          : null;
        return { op, publication };
      }),
    ),
  ),
  // Raw image upload for drafts; stored privately and copied to the public bucket only on publish.
  route(
    "PUT",
    "/v1/world/media",
    authed(
      ({ env, request, url }) =>
        Effect.gen(function* () {
          const principal = yield* requireScope("publish");
          const contentType = (request.headers.get("content-type") ?? "")
            .split(";")[0]!
            .trim()
            .toLowerCase();
          if (!/^image\/(png|jpeg|gif|webp)$/.test(contentType))
            return yield* badRequest("media must be png, jpeg, gif or webp");
          // Streaming cap: a missing or false content-length never buffers past the limit.
          const bytes = yield* Effect.tryPromise({
            try: () => readBodyCapped(request, MEDIA_MAX_BYTES),
            catch: (e) =>
              e instanceof PayloadTooLargeError
                ? new ApiError({ code: "payload_too_large", message: "media too large" })
                : new ApiError({ code: "bad_request", message: "unreadable body" }),
          });
          if (bytes.byteLength === 0) return yield* tooLarge("media too large or empty");
          // Public media is raster-only, verified by magic bytes (never SVG/HTML) and matching the declaration.
          if (sniffRaster(bytes) !== contentType)
            return yield* badRequest("content does not match the declared image type");
          const used = yield* Effect.promise(() => mediaUsage(env, principal.userId));
          if (
            used.objects >= MEDIA_MAX_OBJECTS ||
            used.bytes + bytes.byteLength > MEDIA_MAX_TOTAL_BYTES
          )
            return yield* tooLarge("world media storage limit reached");
          const contentKey = `t/${principal.userId}/world-media/${crypto.randomUUID()}`;
          yield* Effect.promise(() =>
            env.PARTS.put(contentKey, bytes, { httpMetadata: { contentType } }),
          );
          return {
            contentKey,
            name: (url.searchParams.get("name") ?? "image").slice(0, 120),
            contentType,
          };
        }),
      { status: 201, rawBody: true },
    ),
  ),
  // CSV import creates double-opt-in invitations only; confirmations are single transactional messages.
  route(
    "POST",
    "/v1/world/subscribers/import",
    authed(
      ({ env, request }) =>
        Effect.gen(function* () {
          const principal = yield* requireScope("publish");
          const csv = yield* Effect.promise(() => readTextCapped(request, CSV_MAX_BYTES));
          if (csv === null) return yield* tooLarge("csv too large");
          const { author, stub } = yield* myWorld(env, principal.userId);
          const r = yield* call(() => stub.importSubscribers(principal.userId, csv));
          // Confirmations go to addresses the author chose: each is reserved against the author's
          // sending budget and refused while they are suspended (SendingPolicy). Once the policy
          // refuses the sender, the rest are not attempted; invitations stay pending.
          let halted = false;
          const sent = yield* Effect.forEach(
            r.invitations,
            (i) =>
              Effect.promise(() =>
                halted
                  ? Promise.resolve(0)
                  : sendSubscriptionConfirmation(env, author.handle, i.address, i.token, {
                      actorUserId: principal.userId,
                    }).then(
                      () => 1,
                      (error: unknown) => {
                        if (
                          error instanceof SystemMailRefused &&
                          (error.reason === "budget" || error.reason === "suspended")
                        )
                          halted = true;
                        return 0;
                      },
                    ),
              ),
            { concurrency: 4 },
          );
          return {
            invited: r.invitations.length,
            confirmationsSent: sent.reduce((a: number, b) => a + b, 0),
            skipped: r.skipped.length,
          };
        }),
      { rawBody: true },
    ),
  ),
  route(
    "GET",
    "/v1/world/subscribers/export",
    authed(
      ({ env }) =>
        Effect.gen(function* () {
          const principal = yield* requireScope("publish");
          const { stub } = yield* myWorld(env, principal.userId);
          return yield* call(() => stub.exportSubscribers(principal.userId));
        }),
      {
        raw: (csv) =>
          new Response(csv, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="subscribers.csv"',
              "cache-control": "private, no-store",
            },
          }),
      },
    ),
  ),
];
