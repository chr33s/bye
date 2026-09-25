import { RejectionCode } from "@bye/contracts";
import type { MailboxCommand, MailViewPage, MailViewQuery } from "@bye/contracts";
import type { SafetyVerdict } from "@bye/domain";
import type { MessageSummary } from "@bye/mail-codec";
import { Context, type Effect, Schema } from "effect";

/** Expected, structured mailbox rejection mapped to the public error envelope. */
export class MailboxRejected extends Schema.TaggedError<MailboxRejected>()("MailboxRejected", {
  code: RejectionCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class MailboxUnavailable extends Schema.TaggedError<MailboxUnavailable>()(
  "MailboxUnavailable",
  {
    detail: Schema.String,
  },
) {}

export interface MailboxDeliveryCommit {
  readonly ingestionId: string;
  readonly recipient: string;
  readonly messageKey: string;
  readonly rawSize: number;
  readonly summary: MessageSummary;
  readonly safety: SafetyVerdict;
  readonly receivedAt: number;
  readonly forwardHops?: number;
  /**
   * Set by the mailbox host after asking the owner's calendar authority: this iTIP REPLY answers
   * an event the owner organizes, so it may bypass the Screener (C04). Safety and blocks still apply.
   */
  readonly calendarOrganizerReply?: boolean;
}

export interface MailboxDeliveryCommitted {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly disposition: string;
  readonly replayed: boolean;
}

type Op<A> = Effect.Effect<A, MailboxRejected | MailboxUnavailable>;

/** A mailbox read query (`_tag` selects the read; the platform defines the exact union). */
export type MailboxReadRequest = { readonly _tag: string };

/**
 * Client of the MailboxDO authority. The Worker implementation wraps DO RPC stubs; tests use the
 * SQLite-backed store directly. Authorization happens before any repository call.
 */
export class MailboxRepository extends Context.Service<
  MailboxRepository,
  {
    readonly execute: (mailboxId: string, command: MailboxCommand) => Op<unknown>;
    readonly view: (mailboxId: string, query: MailViewQuery) => Op<MailViewPage>;
    readonly thread: (mailboxId: string, threadId: string) => Op<unknown>;
    readonly changes: (
      mailboxId: string,
      cursor: number,
    ) => Op<{
      readonly changes: ReadonlyArray<unknown>;
      readonly cursor: number;
      readonly expired: boolean;
    }>;
    readonly commitDelivery: (
      mailboxId: string,
      input: MailboxDeliveryCommit,
    ) => Op<MailboxDeliveryCommitted>;
    /** Typed reads (policies, labels, contacts, send jobs…): the authority validates the query. */
    readonly read: (mailboxId: string, query: MailboxReadRequest) => Op<unknown>;
  }
>()("mail/MailboxRepository") {}
