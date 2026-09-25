import { type DueJob, Kernel, KERNEL_MIGRATIONS, type KernelClock } from "../durable/kernel.ts";
import { migrate, Sql, type TransactionalStorage } from "../durable/sql.ts";
import { MailboxAutomation } from "./automation.ts";
import { type MailboxCodec, MailboxContext } from "./context.ts";
import { MailboxDrafts } from "./drafts.ts";
import { IdentityDirectory, MailboxIdentities } from "./identities.ts";
import { MailboxIngest } from "./ingest.ts";
import { MailboxOrganizer } from "./organize.ts";
import { MailboxRetention } from "./retention.ts";
import { MAILBOX_MIGRATIONS } from "./schema.ts";
import { MailboxScreener } from "./screener.ts";
import { MailboxSearch } from "./search-catalog.ts";
import { MailboxSends } from "./send-jobs.ts";
import { ThreadLedger } from "./threads.ts";
import { MailboxTransfers } from "./transfers.ts";
import { MailboxTriage } from "./triage.ts";
import { MailboxUploads } from "./uploads.ts";
import { MailboxViews } from "./views.ts";

export * from "./types.ts";

export interface MailboxStoreOptions {
  readonly mailboxId: string;
  readonly clock: KernelClock;
  readonly codec: MailboxCodec;
  /** `world@<service domain>` (P01); null disables publish-by-mail. */
  readonly publishAddress: string | null;
}

/**
 * Single-authority mailbox state (§3.2 `MailboxDO(mailboxId)`): the composition root of the
 * mailbox modules. Every method is synchronous over DO SQLite; commands are made idempotent by
 * the dispatcher (`applyMailboxCommand`), which runs each one inside `ctx.cmd`.
 */
export class MailboxStore {
  readonly ctx: MailboxContext;
  readonly kernel: Kernel;
  readonly ledger: ThreadLedger;
  readonly organize: MailboxOrganizer;
  readonly views: MailboxViews;
  readonly uploads: MailboxUploads;
  readonly drafts: MailboxDrafts;
  readonly triage: MailboxTriage;
  readonly sends: MailboxSends;
  readonly identities: MailboxIdentities;
  readonly automation: MailboxAutomation;
  readonly screener: MailboxScreener;
  readonly transfers: MailboxTransfers;
  readonly ingest: MailboxIngest;
  readonly retention: MailboxRetention;
  readonly search: MailboxSearch;

  constructor(storage: TransactionalStorage, options: MailboxStoreOptions) {
    const sql = new Sql(storage);
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    migrate(sql, "mailbox", MAILBOX_MIGRATIONS);
    this.kernel = new Kernel(sql, options.clock);
    const ctx = (this.ctx = new MailboxContext(
      options.mailboxId,
      sql,
      this.kernel,
      options.clock,
      options.codec,
    ));
    const directory = new IdentityDirectory(ctx);
    this.ledger = new ThreadLedger(ctx);
    this.organize = new MailboxOrganizer(ctx);
    this.views = new MailboxViews(ctx, this.ledger, this.organize);
    this.uploads = new MailboxUploads(ctx);
    this.drafts = new MailboxDrafts(ctx, directory, (group) => this.organize.groupMembers(group));
    this.triage = new MailboxTriage(ctx, this.ledger);
    this.sends = new MailboxSends(
      ctx,
      this.ledger,
      directory,
      this.drafts,
      this.uploads,
      this.triage,
      (addresses) => this.organize.recordRecipients(addresses),
      options.publishAddress,
    );
    this.identities = new MailboxIdentities(ctx, this.sends);
    this.automation = new MailboxAutomation(ctx, directory, this.sends);
    this.screener = new MailboxScreener(ctx, this.ledger, this.views, this.drafts);
    this.transfers = new MailboxTransfers(ctx, this.ledger);
    this.ingest = new MailboxIngest(
      ctx,
      this.ledger,
      this.views,
      this.screener,
      this.organize,
      this.automation,
      this.transfers,
    );
    this.retention = new MailboxRetention(ctx);
    this.search = new MailboxSearch(ctx, this.ledger, this.views, this.organize, this.uploads);
  }

  // ---------------------------------------------------------------- scheduling (§6)

  /**
   * DO alarm body: drain a bounded batch of due jobs. Each job revalidates its generation and the
   * current resource state inside its own transaction; stale jobs are skipped without effects.
   * A job that throws is isolated: its transaction rolls back, the kernel records the error and
   * retries it with backoff (then parks it as `failed`), and the remaining jobs still run.
   */
  runDueJobs(
    now: number,
    limit = 100,
  ): {
    readonly ran: number;
    readonly stale: number;
    readonly failed: ReadonlyArray<{
      readonly kind: string;
      readonly key: string;
      readonly outcome: "retry" | "failed" | "stale";
      readonly error: string;
    }>;
  } {
    let ran = 0;
    let stale = 0;
    const failed: Array<{
      kind: string;
      key: string;
      outcome: "retry" | "failed" | "stale";
      error: string;
    }> = [];
    for (const job of this.kernel.dueJobs(now, limit)) {
      let ok: boolean;
      try {
        ok = this.ctx.sql.tx(() => {
          if (!this.kernel.completeJob(job)) return false;
          return this.runJob(job);
        });
      } catch (error) {
        const outcome = this.ctx.sql.tx(() => this.kernel.failJob(job, error));
        failed.push({
          kind: job.kind,
          key: job.key,
          outcome,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (ok) ran++;
      else stale++;
    }
    return { ran, stale, failed };
  }

  private runJob(job: DueJob): boolean {
    switch (job.kind) {
      case "bubble": {
        const t = this.ledger.row(job.key);
        if (!t || t.bubble_tag !== "Scheduled" || Number(t.bubble_generation) !== job.generation)
          return false;
        this.ledger.setBubble(t.thread_id, { _tag: "Popped", surface: true });
        return true;
      }
      case "send":
      case "send-retry":
        return this.sends.onSendDue(job.key, job.kind);
      case "world-publish":
        return this.sends.onLegacyWorldPublishDue(job.key, job.payload);
      case "retention-sweep":
        this.retention.sweepRetention(this.ctx.now());
        return true;
      case "empty-disposition": {
        const d = job.key;
        if (d !== "trash" && d !== "spam" && d !== "screened-out") return false;
        const before = (job.payload as { before?: unknown } | null)?.before;
        this.retention.emptyDisposition(d, typeof before === "number" ? before : this.ctx.now());
        return true;
      }
      default:
        return false;
    }
  }

  /** Next alarm time: earliest due job, or now if outbox work is pending (recovers lost alarms). */
  nextWakeAt(now: number): number | null {
    if (this.kernel.hasPendingOutbox()) return now;
    return this.kernel.nextDueAt();
  }

  changes(cursor: number, limit = 200) {
    return this.kernel.changesSince(cursor, limit);
  }
}
