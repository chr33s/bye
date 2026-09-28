// Collaboration and publishing (O03–O05, P01, P02, E14). Media upload, subscriber import and
// export stay native routes (raw bodies and a CSV download).
import {
  CollectionItemRequest,
  CommentRequest,
  CreateCollectionRequest,
  CreateSpaceRequest,
  GrantRequest,
  MailChangesResponse,
  NewsletterPublication,
  NewsletterResolved,
  NewsletterResolveRequest,
  NewsletterReview,
  NewsletterStatusView,
  PublicLinkCreated,
  PublicLinkList,
  PublicLinkRequest,
  PublicThreadPreview,
  ShareThreadRequest,
  SpaceCollectionCreated,
  SpaceCollectionItemAdded,
  SpaceCollectionList,
  SpaceCollectionTimeline,
  SpaceCommentCreated,
  SpaceCommentList,
  SpaceCreated,
  SpaceGrantCreated,
  SpaceGrantList,
  SpaceList,
  SpaceMemberList,
  SpaceMemberRemoved,
  SpaceMemberRequest,
  SpaceMemberSet,
  SpaceRevoked,
  SpaceThreadList,
  SpaceThreadView,
  WorldDraftCreated,
  WorldDraftRequest,
  WorldInfo,
  WorldPostList,
  WorldPostPublished,
  WorldPostRequest,
  WorldPostRevision,
  WorldPostUnpublished,
  WorldPostView,
  WorldPublished,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { RequestServices, SchemaErrors } from "../httpapi.ts";

const created = HttpApiSchema.status(201);

const byId = { id: Schema.String };

const spaceThread = { id: Schema.String, threadId: Schema.String };

export class SharedApi extends HttpApiGroup.make("shared")
  .add(
    // ---- shared spaces (O03/O04) ----
    HttpApiEndpoint.post("createSpace", "/v1/spaces", {
      payload: CreateSpaceRequest,
      success: SpaceCreated.pipe(created),
    }),
    HttpApiEndpoint.get("listSpaces", "/v1/spaces", { success: SpaceList }),
    HttpApiEndpoint.get("listSpaceMembers", "/v1/spaces/:id/members", {
      params: byId,
      success: SpaceMemberList,
    }),
    HttpApiEndpoint.put("setSpaceMember", "/v1/spaces/:id/members/:userId", {
      params: { id: Schema.String, userId: Schema.String },
      payload: SpaceMemberRequest,
      success: SpaceMemberSet,
    }),
    HttpApiEndpoint.delete("removeSpaceMember", "/v1/spaces/:id/members/:userId", {
      params: { id: Schema.String, userId: Schema.String },
      success: SpaceMemberRemoved,
    }),
    HttpApiEndpoint.get("listSpaceThreads", "/v1/spaces/:id/threads", {
      params: byId,
      success: SpaceThreadList,
    }),
    HttpApiEndpoint.get("getSpaceThread", "/v1/spaces/:id/threads/:threadId", {
      params: spaceThread,
      success: SpaceThreadView,
    }),
    // Member-only change feed (§8); pair with `/v1/live?space=<id>` for change hints.
    HttpApiEndpoint.get("spaceChanges", "/v1/spaces/:id/changes", {
      params: byId,
      query: { cursor: Schema.optional(Schema.String) },
      success: MailChangesResponse,
    }),
    HttpApiEndpoint.get("listComments", "/v1/spaces/:id/threads/:threadId/comments", {
      params: spaceThread,
      success: SpaceCommentList,
    }),
    HttpApiEndpoint.post("addComment", "/v1/spaces/:id/threads/:threadId/comments", {
      params: spaceThread,
      payload: CommentRequest,
      success: SpaceCommentCreated.pipe(created),
    }),
    HttpApiEndpoint.get("listCollections", "/v1/spaces/:id/collections", {
      params: byId,
      success: SpaceCollectionList,
    }),
    HttpApiEndpoint.post("createCollection", "/v1/spaces/:id/collections", {
      params: byId,
      payload: CreateCollectionRequest,
      success: SpaceCollectionCreated.pipe(created),
    }),
    HttpApiEndpoint.get("collectionTimeline", "/v1/spaces/:id/collections/:collectionId", {
      params: { id: Schema.String, collectionId: Schema.String },
      success: SpaceCollectionTimeline,
    }),
    HttpApiEndpoint.post("addToCollection", "/v1/spaces/:id/collections/:collectionId/threads", {
      params: { id: Schema.String, collectionId: Schema.String },
      payload: CollectionItemRequest,
      success: SpaceCollectionItemAdded.pipe(created),
    }),
    HttpApiEndpoint.get("listGrants", "/v1/spaces/:id/grants", {
      params: byId,
      query: { kind: Schema.optional(Schema.String), resourceId: Schema.optional(Schema.String) },
      success: SpaceGrantList,
    }),
    HttpApiEndpoint.post("createGrant", "/v1/spaces/:id/grants", {
      params: byId,
      payload: GrantRequest,
      success: SpaceGrantCreated.pipe(created),
    }),
    HttpApiEndpoint.delete("revokeGrant", "/v1/spaces/:id/grants/:grantId", {
      params: { id: Schema.String, grantId: Schema.String },
      success: SpaceRevoked,
    }),
    // Sharing a thread registers it so future replies can be appended (O04, "shared.delivery"
    // topic). Answers the shared thread's ID as a bare JSON string.
    HttpApiEndpoint.post("shareThread", "/v1/shared-threads", {
      payload: ShareThreadRequest,
      success: Schema.String.pipe(created),
    }),

    // ---- public links (O05) ----
    HttpApiEndpoint.post("createPublicLink", "/v1/public-links", {
      payload: PublicLinkRequest,
      success: PublicLinkCreated.pipe(created),
    }),
    // Exactly what an anonymous viewer would see, before a link is created.
    HttpApiEndpoint.get("publicPreview", "/v1/spaces/:id/threads/:threadId/public-preview", {
      params: spaceThread,
      success: PublicThreadPreview,
    }),
    HttpApiEndpoint.get("listPublicLinks", "/v1/spaces/:id/threads/:threadId/public-links", {
      params: spaceThread,
      success: PublicLinkList,
    }),
    HttpApiEndpoint.delete("revokePublicLink", "/v1/spaces/:id/public-links/:linkId", {
      params: { id: Schema.String, linkId: Schema.String },
      success: SpaceRevoked,
    }),

    // ---- World publishing (P01) and subscriptions (P02): one publish pipeline (publishing.ts) ----
    HttpApiEndpoint.post("createWorldPost", "/v1/world/posts", {
      payload: WorldPostRequest,
      success: WorldPublished.pipe(created),
    }),
    HttpApiEndpoint.get("getWorld", "/v1/world", { success: WorldInfo }),
    HttpApiEndpoint.get("listWorldPosts", "/v1/world/posts", { success: WorldPostList }),
    HttpApiEndpoint.post("createWorldDraft", "/v1/world/drafts", {
      payload: WorldDraftRequest,
      success: WorldDraftCreated.pipe(created),
    }),
    HttpApiEndpoint.put("editWorldPost", "/v1/world/posts/:id", {
      params: byId,
      payload: WorldDraftRequest,
      success: WorldPostRevision,
    }),
    HttpApiEndpoint.get("previewWorldPost", "/v1/world/posts/:id/preview", {
      params: byId,
      success: WorldPostView,
    }),
    HttpApiEndpoint.post("publishWorldPost", "/v1/world/posts/:id/publish", {
      params: byId,
      success: WorldPostPublished,
    }),
    HttpApiEndpoint.post("unpublishWorldPost", "/v1/world/posts/:id/unpublish", {
      params: byId,
      success: WorldPostUnpublished,
    }),
    // Newsletter publication status: intent, provider-observed state, recipient outcomes (spec.md §5.5).
    HttpApiEndpoint.get("newsletterStatus", "/v1/world/posts/:id/newsletter", {
      params: byId,
      query: { revision: Schema.optional(Schema.String) },
      success: NewsletterStatusView,
    }),
    // Cancel a publication. Reported as requested/confirmed/unsupported/uncertain; never a recall.
    HttpApiEndpoint.post("cancelNewsletter", "/v1/world/posts/:id/newsletter/cancel", {
      params: byId,
      query: { revision: Schema.optional(Schema.String) },
      success: NewsletterPublication,
    }),
    // Operator review of newsletter work that is held or unknown (never auto-resolved or failed over).
    HttpApiEndpoint.get("reviewNewsletters", "/v1/operator/newsletters/:handle", {
      params: { handle: Schema.String },
      success: NewsletterReview,
    }),
    HttpApiEndpoint.post("resolveNewsletterOp", "/v1/operator/newsletters/:handle/resolve", {
      params: { handle: Schema.String },
      payload: NewsletterResolveRequest,
      success: NewsletterResolved,
    }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
