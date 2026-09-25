import type { MailboxCommand, MailboxCommandTag } from "@bye/contracts";
import type { MailboxStore } from "./store.ts";
import type { MailboxDraftContent } from "./types.ts";

type WireContent = Extract<MailboxCommand, { _tag: "CreateDraft" }>["content"];

const toDraftContent = (c: WireContent): MailboxDraftContent => {
  const addr = (list: WireContent["to"]) => list.map((a) => ({ name: a.name, address: a.address }));
  return { ...c, to: addr(c.to), cc: addr(c.cc), bcc: addr(c.bcc) };
};

type CommandOf<K extends MailboxCommandTag> = Extract<MailboxCommand, { _tag: K }>;

/**
 * One command: `run` executes inside the command's receipt transaction (its result is what a
 * replay returns); `present` shapes the wire response outside it, so receipts written before a
 * response shape changed still replay correctly.
 */
interface Handler<C> {
  readonly run: (store: MailboxStore, c: C) => unknown;
  readonly present?: (result: never) => unknown;
}

const handler = <C, R>(
  run: (store: MailboxStore, c: C) => R,
  present?: (result: R) => unknown,
): Handler<C> => ({ run, ...(present ? { present } : {}) });

const HANDLERS: { readonly [K in MailboxCommandTag]: Handler<CommandOf<K>> } = {
  Screen: handler((s, c) => s.screener.screen(c.decisions)),
  ClearScreener: handler((s, c) => s.screener.clearScreener(c.boundary)),
  SetPolicy: handler((s, c) => s.screener.setPolicy(c.kind, c.subject, c.policy)),
  RevertPolicy: handler((s, c) => s.screener.revertPolicy(c.historyId)),
  RotateSpeakeasy: handler(
    (s) => s.screener.rotateSpeakeasy(),
    (code) => ({ code }),
  ),
  DisableSpeakeasy: handler((s) => s.screener.disableSpeakeasy()),
  MarkSeen: handler((s, c) => s.views.markSeen(c.threadId, c.observedRevision)),
  MarkUnseen: handler((s, c) => s.views.markUnseen(c.threadId)),
  MarkAllSeen: handler((s, c) => s.views.markAllSeen(c.view, c.boundary, c.label)),
  VisitView: handler((s, c) => s.views.visitView(c.view, c.position)),
  SetViewPosition: handler((s, c) => s.views.setViewPosition(c.view, c.position)),
  SetAttention: handler((s, c) => s.triage.setAttention(c.threadId, c.flag, c.on)),
  BubbleUp: handler((s, c) => s.triage.bubbleUp(c.threadId, c.at)),
  PinBubble: handler((s, c) => s.triage.pinBubble(c.threadId)),
  PopBubble: handler((s, c) => s.triage.popBubble(c.threadId)),
  ClearBubble: handler((s, c) => s.triage.clearBubble(c.threadId)),
  CreateBatch: handler((s, c) => s.views.createBatch(c.threadIds)),
  RenameThread: handler((s, c) => s.triage.renameThread(c.threadId, c.subject)),
  MergeThreads: handler((s, c) => s.triage.mergeThreads(c.targetId, c.sourceIds)),
  UnmergeThreads: handler((s, c) => s.triage.unmergeThreads(c.mergeId)),
  MoveToTrash: handler((s, c) => s.triage.moveToTrash(c.threadIds)),
  MarkSpam: handler((s, c) => s.triage.markSpam(c.threadIds)),
  Restore: handler((s, c) => s.triage.restore(c.threadIds)),
  Empty: handler((s, c) => s.retention.emptyDisposition(c.disposition)),
  CreateLabel: handler(
    (s, c) => s.organize.createLabel(c.name, c.color),
    (labelId) => ({ labelId }),
  ),
  DeleteLabel: handler((s, c) => s.organize.deleteLabel(c.labelId)),
  RenameLabel: handler((s, c) => s.organize.renameLabel(c.labelId, c.name)),
  SetThreadLabels: handler((s, c) => s.organize.setThreadLabels(c.threadId, c.add, c.remove)),
  PutRule: handler(
    (s, c) => s.organize.putRule(c),
    (ruleId) => ({ ruleId }),
  ),
  DeleteRule: handler((s, c) => s.organize.deleteRule(c.ruleId)),
  CreateBoard: handler((s, c) => s.organize.createBoard(c.name, c.stages, c.enrollAddress)),
  AddToBoard: handler(
    (s, c) => s.organize.addToBoard(c.boardId, c.threadId),
    (cardId) => ({ cardId }),
  ),
  AddStage: handler(
    (s, c) => s.organize.addStage(c.boardId, c.name),
    (stageId) => ({ stageId }),
  ),
  RenameStage: handler((s, c) => s.organize.renameStage(c.stageId, c.name)),
  MoveCard: handler((s, c) => s.organize.moveCard(c.cardId, c.stageId, c.position)),
  CompleteCard: handler((s, c) => s.organize.completeCard(c.cardId, c.done)),
  CreateCollection: handler(
    (s, c) => s.organize.createCollection(c.name),
    (collectionId) => ({ collectionId }),
  ),
  SetCollectionItems: handler((s, c) =>
    s.organize.setCollectionItems(c.collectionId, c.add, c.remove),
  ),
  PutNote: handler((s, c) => s.organize.putNote(c)),
  DeleteNote: handler((s, c) => s.organize.deleteNote(c.noteId)),
  CreateClip: handler(
    (s, c) => s.organize.createClip(c.threadId, c.deliveryId, c.text),
    (clipId) => ({ clipId }),
  ),
  PutContact: handler(
    (s, c) => s.organize.putContact(c),
    (contactId) => ({ contactId }),
  ),
  DeleteContact: handler((s, c) => s.organize.deleteContact(c.contactId)),
  ImportContacts: handler((s, c) => s.organize.importContacts(c.contacts)),
  SetPreference: handler((s, c) => s.automation.setPreference(c.key, c.value)),
  SetNotifyOptIn: handler((s, c) => s.automation.setNotifyOptIn(c.kind, c.subject, c.on)),
  SetNotificationSettings: handler((s, c) =>
    s.automation.setNotificationSettings({ quietHours: c.quietHours, devices: c.devices }),
  ),
  SetAway: handler((s, c) => s.automation.setAway(c)),
  // The verification code is mailed to the destination, never returned to the caller.
  AddForwardingDestination: handler(
    (s, c) => s.automation.addForwardingDestination(c.address),
    () => ({ pending: true }),
  ),
  VerifyForwardingDestination: handler(
    (s, c) => s.automation.verifyForwardingDestination(c.address, c.token),
    (verified) => ({ verified }),
  ),
  PutForwardingRule: handler(
    (s, c) => s.automation.putForwardingRule(c),
    (ruleId) => ({ ruleId }),
  ),
  DeleteForwardingRule: handler((s, c) => s.automation.deleteForwardingRule(c.ruleId)),
  AddIdentity: handler(
    (s, c) => s.identities.addIdentity(c),
    (identityId) => ({ identityId }),
  ),
  SetDefaultIdentity: handler((s, c) => s.identities.setDefaultIdentity(c.identityId)),
  VerifyIdentity: handler((s, c) => s.identities.verifyIdentity(c.identityId, c.token)),
  ResendIdentityChallenge: handler((s, c) => s.identities.resendIdentityChallenge(c.identityId)),
  ClearRecentSearches: handler((s) => s.automation.clearRecentSearches()),
  CreateDraft: handler((s, c) =>
    s.drafts.createDraft({
      ...(c.threadId ? { threadId: c.threadId } : {}),
      content: toDraftContent(c.content),
    }),
  ),
  CreateReplyDraft: handler(
    (s, c) =>
      s.drafts.createReplyDraft(c.threadId, c.mode, s.views.getThread(c.threadId).deliveries),
    (draftId) => ({ draftId }),
  ),
  SaveDraft: handler((s, c) =>
    s.drafts.saveDraft(c.draftId, c.expectedRevision, toDraftContent(c.content)),
  ),
  DeleteDraft: handler((s, c) => s.drafts.deleteDraft(c.draftId)),
  Send: handler((s, c) =>
    s.sends.send(c.draftId, {
      expectedRevision: c.expectedRevision,
      ...(c.sendAt !== undefined ? { sendAt: c.sendAt } : {}),
      ...(c.afterSend ? { afterSend: c.afterSend } : {}),
      ...(c.individually !== undefined ? { individually: c.individually } : {}),
    }),
  ),
  CancelSend: handler((s, c) => s.sends.cancelSend(c.sendJobId)),
  ResolveUnknownSend: handler((s, c) => s.sends.resolveUnknown(c.sendJobId, c.decision)),
  ReserveUpload: handler((s, c) => s.uploads.reserveUpload(c)),
  CompleteUpload: handler((s, c) => s.uploads.completeUpload(c.uploadId, c.actualSize)),
  AbortUpload: handler((s, c) => s.uploads.abortUpload(c.uploadId)),
  CreateFileLink: handler((s, c) => s.uploads.createFileLink(c.uploadId, c.expiresAt)),
  RevokeFileLink: handler((s, c) => s.uploads.revokeFileLink(c.linkId)),
  // The target commits a real MessageSummary reconstructed from the stored delivery (E19).
  Redeliver: handler((s, c) =>
    s.transfers.redeliver({
      deliveryId: c.deliveryId,
      targetMailboxId: c.targetMailboxId,
      mode: c.mode,
      summary: s.ingest.deliverySummary(c.deliveryId),
    }),
  ),
};

/** Receipt kinds that predate the command tags; stored receipts keep replaying under them. */
const LEGACY_KINDS: Partial<Readonly<Record<MailboxCommandTag, string>>> = {
  SetCollectionItems: "CollectionItems",
  SetNotifyOptIn: "NotifyOptIn",
  SetNotificationSettings: "SetNotifications",
  ResolveUnknownSend: "ResolveUnknown",
};

/** The receipt kind a command is recorded under. */
export const kindFor = (c: MailboxCommand): string =>
  c._tag === "SetAttention" ? `Attention:${c.flag}` : (LEGACY_KINDS[c._tag] ?? c._tag);

/**
 * Apply one decoded wire command to the mailbox authority. This is the MailboxDO RPC entry; the
 * Worker has already decoded the command with Effect Schema and checked principal scopes. Every
 * command runs exactly once per command ID, in one transaction with its receipt; reusing an ID
 * for a different command is a `conflict`.
 */
export const applyMailboxCommand = (store: MailboxStore, c: MailboxCommand): unknown => {
  // The map is keyed by tag, so this handler accepts exactly this command (TS can't correlate them).
  const h = HANDLERS[c._tag] as Handler<MailboxCommand>;
  const result = store.ctx.cmd(c.commandId, kindFor(c), () => h.run(store, c), c);
  return h.present ? h.present(result as never) : result;
};
