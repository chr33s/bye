// Mailbox, search, drafts, uploads and sending (§8, E01–E24). Downloads, vCard import/export, part
// uploads and public file links stay native routes (see ../routes/mail.ts).
import {
  MailAttachmentLink,
  MailAttachmentPreview,
  MailAuthorityResult,
  MailboxCommand,
  MailboxWriteRequest,
  MailChangeFeed,
  MailDeliveryText,
  MailDraftCreateRequest,
  MailDraftSaveRequest,
  MailFeedPage,
  MailSearchResponse,
  MailSendRequest,
  MailThreadDetail,
  MailUnifiedPage,
  MailUploadReservation,
  MailUploadReserveRequest,
  MailViewPage,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { RequestServices, SchemaErrors } from "../httpapi.ts";

// Query parameters are read as the plain strings they were: the handlers clamp and parse them,
// and a malformed number is ignored rather than refused.
const optional = Schema.optional(Schema.String);

const mailbox = { id: Schema.String };

/** Personal collections and grants name their mailbox in the query. */
const mailboxQuery = { mailbox: optional };

const attachment = { id: Schema.String, deliveryId: Schema.String, partId: Schema.String };

export class MailApi extends HttpApiGroup.make("mail")
  .add(
    // ---- views and threads (E04–E06, E10, E11) ----
    HttpApiEndpoint.get("getView", "/v1/mailboxes/:id/views/:view", {
      params: { ...mailbox, view: Schema.String },
      query: { label: optional, cursor: optional, limit: optional },
      success: MailViewPage,
    }),
    HttpApiEndpoint.get("getThread", "/v1/mailboxes/:id/threads/:threadId", {
      params: { ...mailbox, threadId: Schema.String },
      success: MailThreadDetail,
    }),
    // Plain-text body for terminal and agent clients (X02): the same stored, sanitized body the
    // render origin serves, as text. HTML-only messages are converted here, so clients never parse
    // HTML themselves. Output is data, not markup: clients must still sanitize control characters.
    HttpApiEndpoint.get("getDeliveryText", "/v1/mailboxes/:id/deliveries/:deliveryId/text", {
      params: { ...mailbox, deliveryId: Schema.String },
      success: MailDeliveryText,
    }),
    // Expanded Feed (E05): one page of feed threads, each with its latest message's render URL for
    // safe lazy rendering; visit markers and remembered position come with the page.
    HttpApiEndpoint.get("getFeed", "/v1/mailboxes/:id/feed", {
      params: mailbox,
      query: { cursor: optional, limit: optional },
      success: MailFeedPage,
    }),
    // Unified view across the principal's mailboxes with identity badges (E19). Bounded fan-out.
    HttpApiEndpoint.get("getUnifiedView", "/v1/unified/views/:view", {
      params: { view: Schema.String },
      query: { cursor: optional, limit: optional },
      success: MailUnifiedPage,
    }),

    // ---- commands ----
    // Per-command guards (step-up, redelivery, rule targets, send-as) live with the scope table in
    // the application's `executeMailboxCommand` (COMMAND_GUARDS).
    HttpApiEndpoint.post("executeCommand", "/v1/mailboxes/:id/commands", {
      params: mailbox,
      payload: MailboxCommand,
      success: MailAuthorityResult,
    }),

    // ---- search (§8, E21): fan out over the mailbox's shards, merge by date, rehydrate ----
    HttpApiEndpoint.get("search", "/v1/mailboxes/:id/search", {
      params: mailbox,
      query: { q: optional, limit: optional, cursor: optional },
      success: MailSearchResponse,
    }),
    HttpApiEndpoint.get("listChanges", "/v1/changes", {
      query: { ...mailboxQuery, cursor: optional },
      success: MailChangeFeed,
    }),
    HttpApiEndpoint.delete("revokeGrant", "/v1/grants/:grantId", {
      params: { grantId: Schema.String },
      query: mailboxQuery,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getQuota", "/v1/mailboxes/:id/quota", {
      params: mailbox,
      success: MailAuthorityResult,
    }),

    // ---- drafts and sending (E17/E18) ----
    HttpApiEndpoint.post("createDraft", "/v1/drafts", {
      payload: MailDraftCreateRequest,
      success: MailAuthorityResult.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.patch("saveDraft", "/v1/drafts/:id", {
      params: mailbox,
      payload: MailDraftSaveRequest,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.post("sendDraft", "/v1/drafts/:id/send", {
      params: mailbox,
      payload: MailSendRequest,
      success: MailAuthorityResult.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("cancelSend", "/v1/send-jobs/:id/cancel", {
      params: mailbox,
      payload: MailboxWriteRequest,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getDraft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { ...mailbox, draftId: Schema.String },
      success: MailAuthorityResult,
    }),

    // ---- uploads (§8 `/v1/uploads`, E20): reserve → PUT parts (R2 multipart) → complete ----
    HttpApiEndpoint.post("reserveUpload", "/v1/uploads", {
      payload: MailUploadReserveRequest,
      success: MailUploadReservation.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("completeUpload", "/v1/uploads/:uploadId/complete", {
      params: { uploadId: Schema.String },
      payload: MailboxWriteRequest,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.post("abortUpload", "/v1/uploads/:uploadId/abort", {
      params: { uploadId: Schema.String },
      payload: MailboxWriteRequest,
      success: MailAuthorityResult,
    }),

    // ---- attachments (E20) ----
    // Signed, short-lived download link on the render origin for clients that open links outside the app.
    HttpApiEndpoint.post(
      "createAttachmentLink",
      "/v1/mailboxes/:id/deliveries/:deliveryId/attachments/:partId/link",
      { params: attachment, success: MailAttachmentLink },
    ),
    // Sandboxed preview on the render origin (text and raster images only).
    HttpApiEndpoint.get(
      "getAttachmentPreview",
      "/v1/mailboxes/:id/deliveries/:deliveryId/attachments/:partId/preview",
      { params: attachment, success: MailAttachmentPreview },
    ),

    // ---- plain authority reads: one typed read each, answered as the authority returns it ----
    HttpApiEndpoint.get("getFocusQueue", "/v1/mailboxes/:id/focus", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getBatch", "/v1/mailboxes/:id/batches/:batchId", {
      params: { ...mailbox, batchId: Schema.String },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getBundle", "/v1/mailboxes/:id/bundles/:bundleKey", {
      params: { ...mailbox, bundleKey: Schema.String },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listScreenerSenders", "/v1/mailboxes/:id/screener/senders", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listRecentSearches", "/v1/mailboxes/:id/searches/recent", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    // ---- sender policies (E02) ----
    HttpApiEndpoint.get("listPolicies", "/v1/mailboxes/:id/policies", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listPolicyHistory", "/v1/mailboxes/:id/policies/history", {
      params: mailbox,
      query: { subject: optional },
      success: MailAuthorityResult,
    }),
    // ---- organization reads (E11–E16) ----
    HttpApiEndpoint.get("listLabels", "/v1/mailboxes/:id/labels", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listRules", "/v1/mailboxes/:id/rules", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listBoards", "/v1/mailboxes/:id/workflows", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getBoard", "/v1/mailboxes/:id/workflows/:boardId", {
      params: { ...mailbox, boardId: Schema.String },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listNotes", "/v1/mailboxes/:id/notes", {
      params: mailbox,
      query: { threadId: optional, kind: optional },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listClips", "/v1/mailboxes/:id/clips", {
      params: mailbox,
      query: { q: optional },
      success: MailAuthorityResult,
    }),
    // Personal collections (§8 `/v1/collections`, E14) and grants (the revocable large-file links).
    HttpApiEndpoint.get("listCollections", "/v1/collections", {
      query: mailboxQuery,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getCollection", "/v1/collections/:collectionId", {
      params: { collectionId: Schema.String },
      query: mailboxQuery,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listGrants", "/v1/grants", {
      query: mailboxQuery,
      success: MailAuthorityResult,
    }),
    // ---- contacts (E16) ----
    HttpApiEndpoint.get("listContacts", "/v1/mailboxes/:id/contacts", {
      params: mailbox,
      query: { q: optional },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("suggestRecipients", "/v1/mailboxes/:id/contacts/suggest", {
      params: mailbox,
      query: { prefix: optional, limit: optional },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getContact", "/v1/mailboxes/:id/contacts/:contactId", {
      params: { ...mailbox, contactId: Schema.String },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getSenderHistory", "/v1/mailboxes/:id/senders/:address/history", {
      params: { ...mailbox, address: Schema.String },
      query: { limit: optional },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getRecipientHistory", "/v1/mailboxes/:id/recipients/:address/history", {
      params: { ...mailbox, address: Schema.String },
      query: { limit: optional },
      success: MailAuthorityResult,
    }),
    // ---- settings reads (E19, E22–E24) ----
    HttpApiEndpoint.get("listIdentities", "/v1/mailboxes/:id/identities", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listForwardingDestinations", "/v1/mailboxes/:id/forwarding", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getPreferences", "/v1/mailboxes/:id/preferences", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    // ---- drafts and send jobs (E17/E18) ----
    HttpApiEndpoint.get("listDrafts", "/v1/mailboxes/:id/drafts", {
      params: mailbox,
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listSendJobs", "/v1/mailboxes/:id/send-jobs", {
      params: mailbox,
      query: { state: optional },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("getSendJob", "/v1/mailboxes/:id/send-jobs/:sendJobId", {
      params: { ...mailbox, sendJobId: Schema.String },
      success: MailAuthorityResult,
    }),
    HttpApiEndpoint.get("listUploads", "/v1/mailboxes/:id/uploads", {
      params: mailbox,
      query: { limit: optional },
      success: MailAuthorityResult,
    }),
    // ---- attachments (E20) ----
    HttpApiEndpoint.get("listAttachments", "/v1/mailboxes/:id/attachments", {
      params: mailbox,
      query: { limit: optional, type: optional, from: optional, minSize: optional },
      success: MailAuthorityResult,
    }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
