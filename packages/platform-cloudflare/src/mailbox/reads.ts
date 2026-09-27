import { SEND_JOB_STATES, type SendJobState } from "@bye/domain";
import { type RpcResult, toRpcSync } from "../durable/rpc.ts";
import { reject } from "./context.ts";
import type { MailboxStore } from "./store.ts";
import type { MailboxSendJob } from "./types.ts";

// Typed read queries served by MailboxDO over one RPC method (§8 API sketch). Reads never mutate
// authoritative state except `recentSearches` bookkeeping, which is explicit in its own query.
// Authorization (principal + mailbox grant + scope) is enforced by the Worker before the call.

export type MailboxReadQuery =
  | { readonly _tag: "Policies" }
  | { readonly _tag: "PolicyHistory"; readonly subject?: string }
  | { readonly _tag: "RecentSearches" }
  | { readonly _tag: "RecordSearch"; readonly query: string }
  | { readonly _tag: "SendJob"; readonly sendJobId: string }
  | { readonly _tag: "SendJobs"; readonly state?: string }
  | { readonly _tag: "FocusQueue" }
  | { readonly _tag: "Batch"; readonly batchId: string }
  | { readonly _tag: "Labels" }
  | { readonly _tag: "Rules" }
  | { readonly _tag: "Boards" }
  | { readonly _tag: "Board"; readonly boardId: string }
  | { readonly _tag: "Collections" }
  | { readonly _tag: "CollectionTimeline"; readonly collectionId: string }
  | {
      readonly _tag: "Notes";
      readonly threadId?: string;
      readonly kind?: "thread" | "sticky" | "cover";
    }
  | { readonly _tag: "Clips"; readonly query?: string }
  | { readonly _tag: "Contacts"; readonly query?: string }
  | { readonly _tag: "Contact"; readonly contactId: string }
  | { readonly _tag: "SuggestRecipients"; readonly prefix: string; readonly limit?: number }
  | { readonly _tag: "SenderHistory"; readonly address: string; readonly limit?: number }
  | { readonly _tag: "RecipientHistory"; readonly address: string; readonly limit?: number }
  | { readonly _tag: "ExportContacts" }
  | {
      readonly _tag: "Attachments";
      readonly contentTypePrefix?: string;
      readonly from?: string;
      readonly minSize?: number;
      readonly limit?: number;
    }
  | { readonly _tag: "Uploads"; readonly limit?: number }
  | { readonly _tag: "Upload"; readonly uploadId: string }
  | { readonly _tag: "FileLinks" }
  | { readonly _tag: "Identities" }
  | { readonly _tag: "ForwardingDestinations" }
  | { readonly _tag: "Preferences" }
  | { readonly _tag: "Drafts" }
  | { readonly _tag: "ScreenerSenders" }
  | { readonly _tag: "Bundle"; readonly bundleKey: string }
  | { readonly _tag: "Quota" };

/**
 * Transactional system jobs carry verification codes for a third party: the principal sees that
 * they exist and how they fared, never a handle on their draft or rendered content.
 */
const visibleJob = (j: MailboxSendJob): MailboxSendJob =>
  j.trafficClass === "transactional" ? { ...j, draftId: "", contentKey: "" } : j;

const isSendJobState = (state: string): state is SendJobState =>
  (SEND_JOB_STATES as ReadonlyArray<string>).includes(state);

export const applyMailboxRead = (store: MailboxStore, q: MailboxReadQuery): unknown => {
  const { organize: o, automation: a } = store;
  switch (q._tag) {
    case "Policies":
      return { items: store.ledger.listPolicies() };
    case "PolicyHistory":
      return { items: store.ledger.policyHistory(q.subject) };
    case "RecentSearches":
      return { items: a.recentSearches() };
    case "RecordSearch":
      a.recordSearch(q.query);
      return null;
    case "SendJob":
      return visibleJob(store.sends.job(q.sendJobId) ?? reject("not_found", "send job"));
    case "SendJobs":
      // An unknown state filter matches nothing rather than everything.
      return {
        items:
          q.state === undefined || isSendJobState(q.state)
            ? store.sends.jobs(q.state, 200).map(visibleJob)
            : [],
      };
    case "FocusQueue":
      return { items: store.views.focusQueue() };
    case "Batch":
      return { items: store.views.batch(q.batchId) };
    case "Labels":
      return { items: o.listLabels() };
    case "Rules":
      return { items: o.listRules() };
    case "Boards":
      return { items: o.listBoards() };
    case "Board":
      return o.board(q.boardId);
    case "Collections":
      return { items: o.listCollections() };
    case "CollectionTimeline":
      if (!o.collection(q.collectionId)) reject("not_found", "collection");
      return {
        collection: o.collection(q.collectionId),
        items: o.collectionTimeline(q.collectionId),
      };
    case "Notes":
      return {
        items: o.notes({
          ...(q.threadId ? { threadId: q.threadId } : {}),
          ...(q.kind ? { kind: q.kind } : {}),
        }),
      };
    case "Clips":
      return { items: o.clips(q.query) };
    case "Contacts":
      return { items: q.query ? o.searchContacts(q.query) : o.exportContacts() };
    case "Contact":
      return o.contact(q.contactId) ?? reject("not_found", "contact");
    case "SuggestRecipients":
      return { items: o.suggestRecipients(q.prefix, Math.min(q.limit ?? 10, 50)) };
    case "SenderHistory":
      return { items: o.senderHistory(q.address, Math.min(q.limit ?? 50, 200)) };
    case "RecipientHistory":
      return { items: o.recipientHistory(q.address, Math.min(q.limit ?? 50, 200)) };
    case "ExportContacts":
      return { items: o.exportContacts() };
    case "Attachments":
      return {
        items: store.uploads
          .attachments({
            ...(q.contentTypePrefix ? { contentTypePrefix: q.contentTypePrefix } : {}),
            ...(q.from ? { from: q.from } : {}),
            ...(q.minSize !== undefined ? { minSize: q.minSize } : {}),
            limit: Math.min(q.limit ?? 100, 500),
          })
          .map((x) => ({ ...x, scan: store.ingest.attachmentAccess(x.deliveryId).status })),
      };
    case "Uploads":
      return { items: store.uploads.uploads(Math.min(q.limit ?? 100, 500)) };
    case "Upload":
      return store.uploads.upload(q.uploadId) ?? reject("not_found", "upload");
    case "FileLinks":
      return { items: store.uploads.fileLinks() };
    case "Identities":
      return { items: store.identities.identities() };
    case "ForwardingDestinations":
      return { items: a.forwardingDestinations() };
    case "Preferences":
      return {
        preferences: a.preferences(),
        notifications: a.notificationSettings(),
        away: a.away(),
      };
    case "Drafts":
      return { items: store.drafts.drafts() };
    case "ScreenerSenders":
      return { items: store.screener.screenerSenders() };
    case "Bundle":
      return { items: store.views.bundle(q.bundleKey) };
    case "Quota":
      return store.uploads.quota();
  }
};

/** RPC-safe wrapper: expected rejections travel as data; anything else stays a defect. */
export const guardMailboxRead = (store: MailboxStore, q: MailboxReadQuery): RpcResult<unknown> =>
  toRpcSync(() => applyMailboxRead(store, q) ?? null);
