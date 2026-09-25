import { Context, Effect, Result, Schema } from "effect";
import { Directory, SendingPolicyService } from "./control/policy.ts";

// Outbound dispatch contract (§7.3). Provider acceptance, transport uncertainty, and durable job
// persistence are different events. Never wrap `dispatch` in an automatic transport retry.

export class TransportFailure extends Schema.TaggedError<TransportFailure>()("TransportFailure", {
  kind: Schema.Literals(["Rejected", "RetryableBeforeAcceptance", "Unknown"]),
  detail: Schema.String,
}) {}

export interface Submission {
  readonly sendJobId: string;
  readonly identityId: string;
  readonly from: string;
  readonly contentKey: string;
  readonly envelopeRecipients: ReadonlyArray<string>;
  readonly trafficClass:
    | "transactional"
    | "personal"
    | "subscription"
    | "external-identity"
    | "forwarding";
  readonly bytes: number;
}

export interface Acceptance {
  readonly providerId: string;
  readonly wireMessageId?: string;
}

export class MailTransport extends Context.Service<
  MailTransport,
  {
    readonly submit: (submission: Submission) => Effect.Effect<Acceptance, TransportFailure>;
  }
>()("mail/MailTransport") {}

export class JobStoreFailure extends Schema.TaggedError<JobStoreFailure>()("JobStoreFailure", {
  detail: Schema.String,
}) {}

export class JobStore extends Context.Service<
  JobStore,
  {
    // Persist Submitting atomically; duplicates and in-flight jobs are no-ops.
    readonly claim: (sendJobId: string) => Effect.Effect<Submission | null, JobStoreFailure>;
    readonly accepted: (
      sendJobId: string,
      receipt: Acceptance,
    ) => Effect.Effect<void, JobStoreFailure>;
    readonly failed: (
      sendJobId: string,
      failure: TransportFailure,
    ) => Effect.Effect<void, JobStoreFailure>;
  }
>()("mail/JobStore") {}

export const DispatchCommand = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sendJobId: Schema.String,
});

export const decodeDispatchCommand = Schema.decodeUnknownEffect(DispatchCommand);

export const dispatch = (sendJobId: string) =>
  Effect.gen(function* () {
    const jobs = yield* JobStore;
    const transport = yield* MailTransport;
    const submission = yield* jobs.claim(sendJobId);
    if (submission === null) return;

    const outcome = yield* Effect.result(transport.submit(submission));
    if (Result.isFailure(outcome)) {
      yield* jobs.failed(sendJobId, outcome.failure);
    } else {
      yield* jobs.accepted(sendJobId, outcome.success);
    }
  }).pipe(Effect.withSpan("mail.dispatch"));

// ---- dispatch policy (§5.2, §10) ----
// Decided BEFORE a job is claimed, so a directory or policy outage fails the decision (the
// dispatch message retries) instead of stranding a claimed, never-attempted job.

/** What the policy needs to know about a `ready` send job. */
export interface DispatchJobFacts {
  readonly mailboxId: string;
  /** Whose sending budget applies: the mailbox owner, or the mailbox for shared mailboxes. */
  readonly budgetUserId: string;
  readonly from: string;
  readonly trafficClass: string;
  readonly recipients: ReadonlyArray<string>;
  /** Forwarding only: the inbound scan verdict of the stored original it re-sends. */
  readonly forwardingScan: string | null;
}

export type DispatchDecision =
  | {
      readonly _tag: "Proceed";
      readonly suppressed: ReadonlySet<string>;
      /** Recipients reserved against the sending budgets (see `releaseDispatch`). */
      readonly reserved: number;
    }
  | {
      readonly _tag: "Refuse";
      readonly failure: TransportFailure;
      readonly blockedBy?: "suspended" | "budget" | "all-suppressed";
    };

const refuse = (
  kind: TransportFailure["kind"],
  detail: string,
  blockedBy?: "suspended" | "budget" | "all-suppressed",
): DispatchDecision => ({
  _tag: "Refuse",
  failure: new TransportFailure({ kind, detail }),
  ...(blockedBy ? { blockedBy } : {}),
});

/**
 * The dispatch-time policy: forwarding waits for (and respects) the inbound scan; hosted senders
 * must still be authorized for the mailbox; every class — transactional included — is bounded by
 * suspensions, suppressions and budgets. Suppressed recipients are dropped from the envelope.
 */
export const decideDispatch = (job: DispatchJobFacts) =>
  Effect.gen(function* () {
    if (job.trafficClass === "forwarding") {
      if (job.forwardingScan === "pending")
        return refuse("RetryableBeforeAcceptance", "awaiting attachment scan");
      if (job.forwardingScan === "infected" || job.forwardingScan === "failed")
        return refuse("Rejected", `message scan ${job.forwardingScan}`);
    }
    const hosted = job.trafficClass !== "external-identity" && job.trafficClass !== "forwarding";
    const allowed =
      !hosted || (yield* (yield* Directory).mailboxMaySendAs(job.mailboxId, job.from));
    // Authorization first: the policy check reserves budget, and an unauthorized send must not.
    if (!allowed) return refuse("Rejected", "sender not authorized");
    const verdict = yield* (yield* SendingPolicyService).check({
      userId: job.budgetUserId,
      identity: job.from,
      recipients: job.recipients,
    });
    if (!verdict.allowed) {
      // Budgets retry later; suspensions and fully suppressed recipient sets are rejected.
      return verdict.reason === "budget"
        ? refuse("RetryableBeforeAcceptance", `sending budget (${verdict.scope})`, "budget")
        : refuse("Rejected", `sending ${verdict.reason}`, verdict.reason);
    }
    const decision: DispatchDecision = {
      _tag: "Proceed",
      suppressed: new Set(verdict.suppressed.map((a) => a.toLowerCase())),
      reserved: verdict.reserved ?? 0,
    };
    return decision;
  }).pipe(Effect.withSpan("mail.dispatch.policy"));

/**
 * Budgets are reserved atomically by `decideDispatch` (the policy check), so an accepted send is
 * already counted. Kept for callers that still report acceptance; it no longer increments.
 */
export const recordDispatched = (_input: {
  readonly budgetUserId: string;
  readonly from: string;
  readonly recipients: number;
}): Effect.Effect<void> => Effect.void;

/**
 * Hand back the budget `decideDispatch` reserved when the send never reached a provider (the
 * claim lost a race, or the transport failed before acceptance), so retries are not counted twice.
 */
export const releaseDispatch = (input: {
  readonly budgetUserId: string;
  readonly from: string;
  readonly recipients: number;
}) =>
  SendingPolicyService.use((policy) =>
    input.recipients > 0
      ? policy.release({
          userId: input.budgetUserId,
          identity: input.from,
          recipients: input.recipients,
        })
      : Effect.void,
  );
