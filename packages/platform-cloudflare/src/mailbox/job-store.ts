import {
  type Acceptance,
  JobStore,
  JobStoreFailure,
  type Submission,
  type TransportFailure,
} from "@bye/application";
import { Effect, Layer } from "effect";

/**
 * Port onto the owning MailboxDO's send-job methods. In production this is the DO RPC stub
 * (async); in tests it is `MailboxStore.sends` directly (sync).
 */
export interface MailboxJobPort {
  claim(sendJobId: string): Submission | null | Promise<Submission | null>;
  accepted(sendJobId: string, receipt: Acceptance): void | Promise<void>;
  failed(
    sendJobId: string,
    failure: { readonly kind: TransportFailure["kind"]; readonly detail: string },
  ): void | Promise<void>;
}

const call = <A>(op: string, f: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: async () => await f(),
    catch: (cause) =>
      new JobStoreFailure({
        detail: `${op}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** JobStore over a mailbox authority. Persists encoded error fields only, never live Error objects. */
export const makeMailboxJobStore = (port: MailboxJobPort) =>
  JobStore.of({
    claim: (id) => call("claim", () => port.claim(id)),
    accepted: (id, receipt) =>
      call("accepted", () =>
        port.accepted(id, {
          providerId: receipt.providerId,
          ...(receipt.wireMessageId ? { wireMessageId: receipt.wireMessageId } : {}),
        }),
      ),
    failed: (id, failure) =>
      call("failed", () => port.failed(id, { kind: failure.kind, detail: failure.detail })),
  });

export const MailboxJobStoreLive = (port: MailboxJobPort) =>
  Layer.succeed(JobStore, makeMailboxJobStore(port));
