// Outbound send-job state machine (§5.2).
//
// Draft -> Scheduled / UndoWindow -> Ready -> Submitting -> AcceptedByTransport
//                     |                         |                 |
//                  Cancelled                 Unknown        recipient outcomes

export type SendJobState =
  | "undo-window"
  | "scheduled"
  | "ready"
  | "submitting"
  | "accepted"
  | "unknown"
  | "rejected"
  | "cancelled";

export const SEND_JOB_STATES: ReadonlyArray<SendJobState> = [
  "undo-window",
  "scheduled",
  "ready",
  "submitting",
  "accepted",
  "unknown",
  "rejected",
  "cancelled",
];

export type RecipientOutcome =
  | "pending"
  | "delivered"
  | "bounced"
  | "deferred"
  | "rejected"
  | "complained";

const TRANSITIONS: Readonly<Record<SendJobState, ReadonlyArray<SendJobState>>> = {
  "undo-window": ["ready", "cancelled"],
  scheduled: ["ready", "cancelled"],
  // A pre-acceptance retryable failure returns to ready with a new attempt.
  ready: ["submitting", "cancelled"],
  submitting: ["accepted", "unknown", "rejected", "ready"],
  accepted: [],
  // Unknown requires an explicit operator/user decision (§5.2 ambiguous send).
  unknown: ["accepted", "rejected", "ready"],
  rejected: [],
  cancelled: [],
};

export const canTransition = (from: SendJobState, to: SendJobState): boolean =>
  TRANSITIONS[from].includes(to);

/** Cancellation succeeds only before Submitting wins the local transaction. */
export const isCancellable = (state: SendJobState): boolean =>
  state === "undo-window" || state === "scheduled" || state === "ready";

export const isTerminal = (state: SendJobState): boolean => TRANSITIONS[state].length === 0;

export type CancelResult =
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "TooLate"; readonly state: SendJobState };

export const DEFAULT_UNDO_WINDOW_MS = 10_000;

/** Per-recipient outcome precedence: later provider events never regress a terminal outcome. */
const OUTCOME_RANK: Readonly<Record<RecipientOutcome, number>> = {
  pending: 0,
  deferred: 1,
  delivered: 2,
  bounced: 3,
  rejected: 3,
  complained: 4,
};

export const mergeOutcome = (
  current: RecipientOutcome,
  next: RecipientOutcome,
): RecipientOutcome => (OUTCOME_RANK[next] >= OUTCOME_RANK[current] ? next : current);
