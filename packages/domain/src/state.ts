// Orthogonal mailbox state (§4.2). None of these collapse into a single folder field.

export type SenderDecision = "unknown" | "allowed" | "blocked";

export const SENDER_DECISIONS: ReadonlyArray<SenderDecision> = ["unknown", "allowed", "blocked"];

export type Destination = "imbox" | "feed" | "paper-trail";

export const DESTINATIONS: ReadonlyArray<Destination> = ["imbox", "feed", "paper-trail"];

export type Disposition = "active" | "screening" | "screened-out" | "spam" | "trash";

export const DISPOSITIONS: ReadonlyArray<Disposition> = [
  "active",
  "screening",
  "screened-out",
  "spam",
  "trash",
];

/** `if-no-reply` bubbles are cancelled by a qualifying reply; `always` by any new reply (E09). */
export type BubbleCondition = "always" | "if-no-reply";

export type BubbleState =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Scheduled";
      readonly at: number;
      readonly generation: number;
      readonly condition: BubbleCondition;
    }
  | { readonly _tag: "Pinned" };

export type AttentionState = {
  readonly replyLater: boolean;
  readonly setAside: boolean;
  readonly unfollowed: boolean;
  readonly bubble: BubbleState;
};

export const emptyAttention: AttentionState = {
  replyLater: false,
  setAside: false,
  unfollowed: false,
  bubble: { _tag: "None" },
};

/** Mailbox views exposed to clients (§2.1). */
export type MailView =
  | "imbox"
  | "feed"
  | "paper-trail"
  | "screener"
  | "reply-later"
  | "set-aside"
  | "bubble-up"
  | "screened-out"
  | "spam"
  | "trash"
  | "everything";

export const MAIL_VIEWS: ReadonlyArray<MailView> = [
  "imbox",
  "feed",
  "paper-trail",
  "screener",
  "reply-later",
  "set-aside",
  "bubble-up",
  "screened-out",
  "spam",
  "trash",
  "everything",
];

/** Retention defaults (§12). Milliseconds. */
export const RETENTION = {
  trashMs: 30 * 24 * 3600 * 1000,
  spamMs: 90 * 24 * 3600 * 1000,
  screenedOutMs: 90 * 24 * 3600 * 1000,
} as const;
