import { DurableObject } from "cloudflare:workers";
import { IngressJournal, type KernelClock, type ReceiptIntent } from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";

/** Ingress receipt journal (§5.1 step 2), partitioned by ingestion ID. */
export class IngressJournalDO extends DurableObject<CoreEnv> {
  private readonly journal: IngressJournal;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.journal = new IngressJournal(ctx.storage, kernelClock satisfies KernelClock);
  }

  get(id: string) {
    return this.journal.get(id) ?? null;
  }
  register(intent: ReceiptIntent) {
    return this.journal.register(intent);
  }
  markBlobReady(id: string) {
    return this.journal.markBlobReady(id);
  }
  markEnqueued(id: string) {
    return this.journal.markEnqueued(id);
  }
  markCommitted(id: string) {
    return this.journal.markCommitted(id);
  }
  markRejected(id: string) {
    return this.journal.markRejected(id);
  }
  /** Quarantine of an exhausted receipt failed: park it (retried later, never pruned). */
  markQuarantineFailed(id: string) {
    return this.journal.markQuarantineFailed(id);
  }
  pendingReplay(olderThanMs: number, limit: number) {
    return this.journal.pendingReplay(olderThanMs, limit);
  }
  touchRepublished(id: string) {
    this.journal.touchRepublished(id);
  }
  /** Daily retention sweep (§12): committed/rejected receipts older than the window. */
  pruneCommitted(olderThanMs: number) {
    return this.journal.pruneCommitted(olderThanMs);
  }

  abandonStale(olderThanMs: number) {
    return this.journal.abandonStale(olderThanMs);
  }
}
