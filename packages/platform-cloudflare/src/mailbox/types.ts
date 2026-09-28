import type {
  AttentionState,
  BubbleCondition,
  Destination,
  Disposition,
  MailView,
  RecipientOutcome,
  RoutingStep,
  SafetyVerdict,
  SendJobState,
  TrafficClass,
} from "@bye/domain";
import type { Address, AttachmentMeta, MessageSummary } from "@bye/mail-codec";

// Public shapes of the mailbox authority. Kept apart from the sub-stores so modules can share
// them without importing each other (no store ↔ compose cycles).

export interface MailboxDeliveryInput {
  readonly ingestionId: string;
  readonly recipient: string;
  readonly messageKey: string;
  readonly rawSize: number;
  readonly summary: MessageSummary;
  /** From authenticated transport evidence only (§10). */
  readonly safety: SafetyVerdict;
  readonly receivedAt: number;
  /** Count of our own forwarding hops observed on the message (loop protection, E22). */
  readonly forwardHops?: number;
  /** Explicit, authorized internal redelivery between accounts (E19). Bypasses Screener only. */
  readonly authorizedTransfer?: boolean;
  /** The owner's calendar confirmed it organizes this iTIP REPLY's event (C04). */
  readonly calendarOrganizerReply?: boolean;
}

export interface MailboxDeliveryResult {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly disposition: Disposition;
  readonly destination: Destination;
  readonly decidedBy: RoutingStep | "transfer";
  readonly newForYou: boolean;
  readonly replayed: boolean;
}

export interface MailboxThread {
  readonly threadId: string;
  readonly subject: string;
  readonly originalSubject: string;
  readonly sender: string;
  readonly destination: Destination;
  readonly disposition: Disposition;
  readonly quarantined: boolean;
  readonly bundleKey: string | null;
  readonly bundleCount: number;
  readonly newForYou: boolean;
  readonly revision: number;
  readonly seenRevision: number;
  readonly lastActivityAt: number;
  readonly messageCount: number;
  readonly attention: AttentionState;
  readonly labels: ReadonlyArray<string>;
  readonly mergedInto: string | null;
  readonly newSinceVisit: boolean;
}

export type MailboxScanStatus =
  | "pending"
  | "clean"
  | "infected"
  | "failed"
  | "not-required"
  | "legacy";

export interface MailboxDeliveryRouting {
  readonly decidedBy: string;
  readonly hasCalendar: boolean;
  readonly calendarMethod: string | null;
}

export interface MailboxDelivery {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly originalThreadId: string;
  readonly direction: "in" | "out";
  readonly recipient: string;
  readonly messageKey: string;
  readonly messageIdHeader: string | null;
  readonly from: Address;
  readonly to: ReadonlyArray<Address>;
  readonly cc: ReadonlyArray<Address>;
  readonly subject: string;
  readonly date: number;
  readonly snippet: string;
  readonly attachments: ReadonlyArray<AttachmentMeta>;
  readonly routing: MailboxDeliveryRouting;
  readonly scan: { readonly status: MailboxScanStatus; readonly signature: string | null };
}

export interface MailboxViewQuery {
  readonly view: MailView | "label";
  readonly label?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MailboxViewPage {
  readonly view: string;
  readonly items: ReadonlyArray<MailboxThread>;
  readonly nextCursor: string | null;
  /** Snapshot boundary: items changed after this sequence are excluded from later pages. */
  readonly boundary: number;
  /**
   * On continuation pages: threads in this view that changed after the boundary. They are
   * excluded from the stable pagination, so they are returned here (flagged) instead of silently
   * disappearing; clients merge them at the top.
   */
  readonly changedSinceBoundary: ReadonlyArray<MailboxThread>;
  /** Per-item sort keys, direction and resume-after cursors (for cross-mailbox merging). */
  readonly order: {
    readonly ascending: boolean;
    readonly keys: ReadonlyArray<number>;
    readonly cursors: ReadonlyArray<string>;
  };
  /** Remembered reading position and previous visit marker (E05/E06). */
  readonly position: string | null;
  readonly previousVisitAt: number;
}

export type MailboxAfterSend =
  | { readonly _tag: "None" }
  | { readonly _tag: "MarkDone" }
  /** `condition` is absent on send jobs queued before E09 conditions existed: treat as `always`. */
  | { readonly _tag: "BubbleUp"; readonly at: number; readonly condition?: BubbleCondition }
  /** Send-and-pop: the reply resolves the thread's bubble without resurfacing it. */
  | { readonly _tag: "ClearBubble" };

export type MailboxDraftContent = {
  readonly to: ReadonlyArray<Address>;
  readonly cc: ReadonlyArray<Address>;
  readonly bcc: ReadonlyArray<Address>;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Upload IDs; must be scanned clean before send. */
  readonly attachments: ReadonlyArray<string>;
  /** Large-file link IDs rendered as links, not MIME attachments (E20). */
  readonly fileLinks?: ReadonlyArray<string>;
  readonly inReplyTo?: string;
  readonly references?: ReadonlyArray<string>;
  readonly identityId?: string;
  readonly forwardOf?: string;
  /** Extra headers for system messages (Auto-Submitted etc.). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Contact groups expanded into To when the send intent is frozen (E17 recipient groups). */
  readonly groups?: ReadonlyArray<string>;
};

export type MailboxDraftState = "open" | "sending" | "sent";

export type MailboxDraft = {
  readonly draftId: string;
  readonly threadId: string | null;
  readonly revision: number;
  readonly content: MailboxDraftContent;
  readonly state: MailboxDraftState;
  readonly updatedAt: number;
};

export interface MailboxIdentity {
  readonly identityId: string;
  readonly address: string;
  readonly name: string | null;
  readonly kind: "hosted" | "external";
  readonly verified: boolean;
  readonly isDefault: boolean;
  readonly signature: string;
}

/**
 * Traffic class of a send job. `publish` jobs (P01 publish-by-mail) never reach a transport:
 * when due they emit `world.publish` and complete locally.
 */
export type MailboxJobClass = TrafficClass | "publish";

export interface MailboxSendJob {
  readonly sendJobId: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly state: SendJobState;
  readonly dueAt: number;
  /** Null for forwarding jobs: they reuse the original bytes and send as no identity of ours. */
  readonly identityId: string | null;
  readonly from: string;
  readonly recipients: ReadonlyArray<string>;
  readonly threadId: string | null;
  readonly trafficClass: MailboxJobClass;
  readonly contentKey: string;
  readonly bytes: number;
  readonly attempts: number;
  readonly providerId: string | null;
  readonly wireMessageId: string | null;
  readonly failure: { readonly kind: string; readonly detail: string } | null;
  readonly outcomes: ReadonlyArray<{
    readonly address: string;
    readonly outcome: RecipientOutcome;
    readonly detail: string | null;
  }>;
}

export interface MailboxSubmission {
  readonly sendJobId: string;
  readonly identityId: string;
  readonly from: string;
  readonly contentKey: string;
  readonly envelopeRecipients: ReadonlyArray<string>;
  readonly trafficClass: TrafficClass;
  readonly bytes: number;
}

export type MailboxSendResult =
  | {
      readonly _tag: "Queued";
      readonly sendJobIds: ReadonlyArray<string>;
      readonly dueAt: number;
      readonly deduplicated: boolean;
    }
  | { readonly _tag: "Conflict"; readonly currentRevision: number };

export type MailboxUpload = {
  readonly uploadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly declaredSize: number;
  readonly actualSize: number | null;
  readonly state: "reserved" | "uploading" | "complete" | "failed" | "aborted";
  readonly scanStatus: "pending" | "clean" | "infected" | "failed";
  readonly blobKey: string;
};

/** Search candidate hydrated back into a result the caller may see (§8). */
export interface MailboxSearchHit {
  readonly kind: string;
  readonly id: string;
  readonly threadId: string | null;
  readonly date: number;
  readonly snippet: string;
}
