import { Option, Predicate, Schema } from "effect";
import { type DueJob, Kernel, KERNEL_MIGRATIONS, type KernelClock } from "../durable/kernel.ts";
import { migrate, Sql, type TransactionalStorage } from "../durable/sql.ts";
import { MailboxAutomation } from "./automation.ts";
import { type MailboxCodec, MailboxContext } from "./context.ts";
import { MailboxDrafts } from "./drafts.ts";
import { IdentityDirectory, MailboxIdentities } from "./identities.ts";
import { MailboxIngest } from "./ingest.ts";
import { JmapAccount } from "../jmap/account.ts";
import { RETENTION_JOB, type RetentionBatch, TIMER_JOB } from "../jmap/core.ts";
import type { DeliveredEffects, DeliveredOutcome } from "../jmap/ingest.ts";
import { JMAP_MIGRATIONS } from "../jmap/schema.ts";
import { MailboxJmap } from "./jmap.ts";
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

type RunDueJobsResult = {
  readonly ran: number;
  readonly stale: number;
  readonly failed: ReadonlyArray<{
    readonly kind: string;
    readonly key: string;
    readonly outcome: "retry" | "failed" | "stale";
    readonly error: string;
  }>;
};

/**
 * Single-authority mailbox state (§3.2 `MailboxDO(mailboxId)`): the composition root of the
 * mailbox modules. Every method is synchronous over DO SQLite; commands are made idempotent by
 * the dispatcher (`applyMailboxCommand`), which runs each one inside `ctx.cmd`.
 */
const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const decodeEmptyDispositionPayload = Schema.decodeUnknownOption(
  Schema.Struct({ before: Schema.optional(Schema.Number) }),
);

/** Scheduled jobs that mutate the legacy thread model (held while fenced, stale once migrated). */
const LEGACY_MAIL_JOBS: ReadonlySet<string> = new Set([
  "bubble",
  "retention-sweep",
  "empty-disposition",
]);

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
  /** Read-only JMAP projection of the legacy model (accounts not yet migrated). */
  readonly jmapProjection: MailboxJmap;
  /** The JMAP account: projection before migration, the JMAP core after (spec.md §16 C3). */
  readonly jmap: JmapAccount;

  constructor(storage: TransactionalStorage, options: MailboxStoreOptions) {
    const sql = new Sql(storage);
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    migrate(sql, "mailbox", MAILBOX_MIGRATIONS);
    migrate(sql, "jmap", JMAP_MIGRATIONS);
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
      {
        legacyFrozen: () => this.jmap.migration.fenced() || this.jmap.active(),
        recordOutgoing: (sendJobId) => this.jmapOutgoing(sendJobId),
        jobChanged: (sendJobId) => this.jmap.objects.touchSubmissionByJob(sendJobId),
      },
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
    this.jmapProjection = new MailboxJmap(ctx);
    this.jmap = new JmapAccount(
      sql,
      options.clock,
      this.jmapProjection,
      {
        identities: () => this.identities.identities(),
        updateIdentity: (id, patch) => this.identities.updateIdentity(id, patch),
        createSubmissionJob: (input) => this.sends.createSubmissionJob(input),
        cancelJob: (id) =>
          Predicate.isTagged(this.sends.cancelSend(id), "Cancelled") ? "Cancelled" : "TooLate",
        job: (id) => this.sends.job(id),
        away: () => this.automation.away(),
        setAway: (settings) => this.automation.setAway(settings),
      },
      {
        policy: (kind, subject) => this.ledger.policy(kind, subject),
        speakeasyMatches: (subject) => this.screener.speakeasyMatches(subject),
        rules: (summary, recipient) => {
          const r = this.organize.evaluateRules(summary, recipient);

          return { destination: r.destination, labels: r.labels, redeliverTo: r.redeliverTo };
        },
        delivered: (input) => this.jmapDelivered(input),
      },
      (kind, key, dueAt) => this.kernel.schedule(kind, key, dueAt, {}),
    );
  }

  /**
   * A legacy send accepted after the ledger froze (C3): on the core it is staged as an outgoing
   * arrival the host publishes into Sent; while fenced it is buffered and replayed through
   * whichever authority the migration ends on.
   */
  private jmapOutgoing(sendJobId: string): void {
    const acceptedAt = this.ctx.now();

    if (!this.jmap.active()) {
      this.jmap.migration.buffer(
        "outgoing",
        `outgoing:${sendJobId}`,
        JSON.stringify({ sendJobId, acceptedAt }),
      );

      return;
    }

    this.stageOutgoing(sendJobId, acceptedAt);
  }

  /**
   * Stage a post-cutover legacy send's Sent copy, dated when the provider accepted it. Its
   * after-send action targets the thread model: follow-up (Bubble Up) has no JMAP counterpart,
   * so a scheduled one is audited rather than dropped silently; mark-done and send-and-pop have
   * nothing to clear on the core.
   */
  stageOutgoing(sendJobId: string, acceptedAt: number): string | undefined {
    const arrival = this.sends.outgoingArrival(sendJobId, acceptedAt);

    if (!arrival) return undefined;

    if (Predicate.isTagged(this.sends.afterSendOf(sendJobId), "BubbleUp"))
      this.jmap.core.audit(
        "after-send",
        sendJobId,
        "follow-up was scheduled before the JMAP cutover and is not applied",
      );

    return this.jmap.ingest.stage(arrival).arrivalId;
  }

  /** JMAP retention batch (E24 on the core) with the account's recycling preference. */
  jmapRetention(now: number): RetentionBatch {
    const recycleDays = this.ctx.setting<{ days: number | null }>("pref:recycling", {
      days: null,
    }).days;

    return this.jmap.core.sweepRetention(now, recycleDays);
  }

  /**
   * A published JMAP arrival's effects, matching a legacy delivery's (spec.md §16 B4): the topic
   * payloads keep their shape, with the Email and Thread IDs in place of the legacy delivery and
   * thread, and the consumers resolve those through the JMAP core. Nothing here writes the
   * frozen legacy thread ledger: system jobs carry no legacy thread.
   */
  private jmapDelivered(input: DeliveredEffects): DeliveredOutcome {
    if (
      this.automation.shouldNotify({
        threadId: input.threadId,
        from: input.from,
        notifyPolicy: input.notify,
        unfollowed: false,
      })
    )
      this.kernel.outbox("notify", this.ctx.mailboxId, {
        kind: "delivery",
        threadId: input.emailId,
      });

    this.kernel.emit("shared.delivery", this.ctx.mailboxId, {
      deliveryId: input.emailId,
      threadId: input.threadId,
    });

    if (input.summary.hasCalendar)
      this.kernel.emit("calendar.invitation", this.ctx.mailboxId, {
        deliveryId: input.emailId,
        messageKey: input.messageKey,
      });

    if (input.redeliverTo !== undefined)
      this.transfers.emitTransfer(input.emailId, input.redeliverTo, "copy", input.summary, {
        messageKey: input.messageKey,
        rawSize: input.rawSize,
      });

    this.automation.maybeAwayReply({
      threadId: null,
      from: input.from,
      recipient: input.recipient,
      summary: input.summary,
      deliveredAt: input.receivedAt,
    });

    const forwarded = this.automation.maybeForward({
      from: input.from,
      recipient: input.recipient,
      messageKey: input.messageKey,
      threadId: null,
      hops: input.forwardHops,
      bytes: input.rawSize,
    });

    return { discardLocal: forwarded.discardLocal };
  }

  // ---------------------------------------------------------------- scheduling (§6)

  /**
   * DO alarm body: drain a bounded batch of due jobs. Each job revalidates its generation and the
   * current resource state inside its own transaction; stale jobs are skipped without effects.
   * A job that throws is isolated: its transaction rolls back, the kernel records the error and
   * retries it with backoff (then parks it as `failed`), and the remaining jobs still run.
   */
  runDueJobs(now: number, limit = 100): RunDueJobsResult {
    let ran = 0;
    let stale = 0;

    const failed: Array<{
      kind: string;
      key: string;
      outcome: "retry" | "failed" | "stale";
      error: string;
    }> = [];

    // C3: legacy timer/retention intents wait while the account is fenced for migration.
    for (const job of this.kernel.dueJobs(now, limit, this.deferredJobs())) {
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
    // After activation the legacy thread tables are read-only: their timers are stale (C3).
    if (this.jmap.active() && LEGACY_MAIL_JOBS.has(job.kind)) {
      this.jmap.core.audit(
        "stale-legacy-job",
        `${job.kind}:${job.key}`,
        "legacy mail timer after activation",
      );

      return false;
    }

    switch (job.kind) {
      case "bubble": {
        const t = this.ledger.row(job.key);

        if (!t || t.bubble_tag !== "Scheduled" || Number(t.bubble_generation) !== job.generation)
          return false;
        this.ledger.setBubble(t.thread_id, { _tag: "Popped", surface: true });

        return true;
      }

      case TIMER_JOB:
        this.jmap.core.runTimer(job.key);

        return true;
      case RETENTION_JOB:
        if (!this.jmap.active()) return false;
        this.jmapRetention(this.ctx.now());

        return true;
      case "send":
      case "send-retry":
        return this.sends.onSendDue(job.key, job.kind);
      case "world-publish":
        return this.sends.onLegacyWorldPublishDue(
          job.key,
          Option.getOrElse(decodeJson(job.payload), () => null),
        );
      case "retention-sweep":
        this.retention.sweepRetention(this.ctx.now());

        return true;
      case "empty-disposition": {
        const d = job.key;

        if (d !== "trash" && d !== "spam" && d !== "screened-out") return false;
        const payload = decodeEmptyDispositionPayload(job.payload);
        const before = Option.isSome(payload) ? payload.value.before : undefined;
        this.retention.emptyDisposition(d, before ?? this.ctx.now());

        return true;
      }

      default:
        return false;
    }
  }

  /** Job kinds that wait out a migration fence (they stay pending, and don't wake the alarm). */
  private deferredJobs(): ReadonlyArray<string> {
    return this.jmap.migration.fenced() ? [...LEGACY_MAIL_JOBS] : [];
  }

  /** Next alarm time: earliest due job, or now if outbox work is pending (recovers lost alarms). */
  nextWakeAt(now: number): number | null {
    if (this.kernel.hasPendingOutbox()) return now;
    const due = this.kernel.nextDueAt(this.deferredJobs());
    const retry = this.jmap.active() ? this.jmap.ingest.nextRetryAt() : null;

    if (due === null) return retry;

    return retry === null ? due : Math.min(due, retry);
  }

  changes(cursor: number, limit = 200) {
    return this.kernel.changesSince(cursor, limit);
  }
}
