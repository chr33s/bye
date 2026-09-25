import {
  type MailboxCommand,
  type MailboxCommandTag,
  MailViewQuery,
  decodeMailboxCommand,
} from "@bye/contracts";
import { Effect, Schema } from "effect";
import { requireMailbox, type Scope } from "../services.ts";
import { guardMailboxCommand } from "./guards.ts";
import {
  type MailboxDeliveryCommit,
  type MailboxReadRequest,
  MailboxRepository,
} from "./repository.ts";

/**
 * Scope required per mailbox command (§8: agents default to read/draft; consequential actions
 * need explicit scopes). Triage/organization of one's own mail is "screen" — including seen state
 * and reading positions: the "read" scope never mutates mailbox state.
 */
export const MAILBOX_COMMAND_SCOPES: Readonly<Record<MailboxCommandTag, Scope>> = {
  Screen: "screen",
  ClearScreener: "screen",
  SetPolicy: "screen",
  RevertPolicy: "screen",
  RotateSpeakeasy: "admin",
  DisableSpeakeasy: "admin",
  MarkSeen: "screen",
  MarkUnseen: "screen",
  MarkAllSeen: "screen",
  VisitView: "screen",
  SetViewPosition: "screen",
  SetAttention: "screen",
  BubbleUp: "screen",
  PinBubble: "screen",
  PopBubble: "screen",
  ClearBubble: "screen",
  CreateBatch: "screen",
  RenameThread: "screen",
  MergeThreads: "screen",
  UnmergeThreads: "screen",
  MoveToTrash: "delete",
  MarkSpam: "screen",
  Restore: "delete",
  Empty: "delete",
  CreateLabel: "screen",
  DeleteLabel: "screen",
  RenameLabel: "screen",
  SetThreadLabels: "screen",
  PutRule: "screen",
  DeleteRule: "screen",
  CreateBoard: "screen",
  AddToBoard: "screen",
  AddStage: "screen",
  RenameStage: "screen",
  MoveCard: "screen",
  CompleteCard: "screen",
  CreateCollection: "screen",
  SetCollectionItems: "screen",
  PutNote: "draft",
  DeleteNote: "delete",
  CreateClip: "draft",
  PutContact: "draft",
  DeleteContact: "delete",
  ImportContacts: "draft",
  SetPreference: "admin",
  SetNotifyOptIn: "admin",
  SetNotificationSettings: "admin",
  SetAway: "admin",
  AddForwardingDestination: "admin",
  VerifyForwardingDestination: "admin",
  PutForwardingRule: "admin",
  DeleteForwardingRule: "admin",
  AddIdentity: "admin",
  SetDefaultIdentity: "admin",
  VerifyIdentity: "admin",
  ResendIdentityChallenge: "admin",
  ClearRecentSearches: "screen",
  CreateDraft: "draft",
  CreateReplyDraft: "draft",
  SaveDraft: "draft",
  DeleteDraft: "draft",
  Send: "send",
  CancelSend: "send",
  ResolveUnknownSend: "send",
  ReserveUpload: "draft",
  CompleteUpload: "draft",
  AbortUpload: "draft",
  CreateFileLink: "send",
  RevokeFileLink: "send",
  Redeliver: "send",
};

/** Decode at the trust boundary, authorize against the current principal, then execute. */
export const executeMailboxCommand = (mailboxId: string, raw: unknown) =>
  Effect.gen(function* () {
    const command: MailboxCommand = yield* decodeMailboxCommand(raw);
    yield* guardMailboxCommand(mailboxId, command);
    yield* requireMailbox(mailboxId, MAILBOX_COMMAND_SCOPES[command._tag]);
    const repo = yield* MailboxRepository;
    return yield* repo.execute(mailboxId, command);
  }).pipe(Effect.withSpan("mail.command"));

export const readMailboxView = (mailboxId: string, raw: unknown) =>
  Effect.gen(function* () {
    const query = yield* Schema.decodeUnknownEffect(MailViewQuery)(raw);
    yield* requireMailbox(mailboxId, "read");
    const repo = yield* MailboxRepository;
    return yield* repo.view(mailboxId, query);
  }).pipe(Effect.withSpan("mail.view"));

export const readMailboxThread = (mailboxId: string, threadId: string) =>
  Effect.gen(function* () {
    yield* requireMailbox(mailboxId, "read");
    const repo = yield* MailboxRepository;
    return yield* repo.thread(mailboxId, threadId);
  });

/** One typed mailbox read, authorized for `scope` on that mailbox (default `read`). */
export const readMailboxQuery = <A = unknown>(
  mailboxId: string,
  query: MailboxReadRequest,
  scope: Scope = "read",
) =>
  Effect.gen(function* () {
    yield* requireMailbox(mailboxId, scope);
    return (yield* (yield* MailboxRepository).read(mailboxId, query)) as A;
  }).pipe(Effect.withSpan("mail.read"));

export const readMailboxChanges = (mailboxId: string, cursor: number) =>
  Effect.gen(function* () {
    yield* requireMailbox(mailboxId, "read");
    const repo = yield* MailboxRepository;
    return yield* repo.changes(mailboxId, cursor);
  });

/**
 * Ingest step 6 (§5.1): commit a parsed, inspected message to its mailbox. System-internal
 * (queue consumer) — no end-user principal; the recipient was resolved by the directory.
 */
export const ingestCommit = (mailboxId: string, input: MailboxDeliveryCommit) =>
  Effect.gen(function* () {
    const repo = yield* MailboxRepository;
    return yield* repo.commitDelivery(mailboxId, input);
  }).pipe(Effect.withSpan("mail.ingest.commit"));
