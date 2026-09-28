import { Predicate } from "effect";
import { typeNameOf } from "./typename.ts";
import {
  CATALOG_SHARDS,
  type CatalogKind,
  ControlAuth,
  ControlDirectory,
  IngressJournal,
  REPLAY_ATTEMPT_CAP,
  SEARCH_SHARD_BUDGET_BYTES,
} from "@bye/platform-cloudflare";
import { sweepBlobGc } from "./blobgc.ts";
import { kernelClock } from "./durable-host.ts";
import { type CoreEnv, INGRESS_JOURNAL_PARTITIONS, journalPartition } from "./env.ts";
import { mailboxErased, replayUnverifiedTombstones } from "./erasure.ts";
import { metric, storageLevel } from "./metrics.ts";
import { MAILBOX_METADATA_BUDGET_BYTES } from "./objects/mailbox.ts";
import { reconcileNewsletters } from "./newsletter.ts";
import { reconcileUnknownSends } from "./sendevents.ts";
import { replayPendingPropagation } from "./topics/shared.ts";
import { sweepUsage } from "./usage.ts";
import { authConfig } from "./services.ts";
import { calendar, mailbox, space, world } from "./authorities.ts";

// Independent Cron reconciliation (§6) and daily sweeps (§12).
//   */5 * * * *  — probe a rotating slice of the catalog for EVERY authority kind (restores lost
//                  alarms without a user reopening the app), republish stranded ingress receipts,
//                  reconcile Unknown sends, report shard storage levels.
//   17 3 * * *   — blob GC, erasure tombstone replay, prune journals/receipts/ledgers and
//                  identity tables, release abandoned signups.

export const SHARDS_PER_RUN = 4;

/** Republish budget per ingress receipt; the journal owns the cap. */
export const MAX_REPLAYS = REPLAY_ATTEMPT_CAP;

export const DAILY_CRON = "17 3 * * *";

const RECONCILE_BATCH = 200;

const DAY = 24 * 3600_000;

/** Deterministic rotation: every catalog shard is visited once per CATALOG_SHARDS/SHARDS_PER_RUN runs. */
export const shardsForRun = (
  scheduledTime: number,
  total = CATALOG_SHARDS,
  perRun = SHARDS_PER_RUN,
): ReadonlyArray<number> => {
  const run = Math.floor(scheduledTime / (5 * 60_000));
  const start = (run * perRun) % total;

  return Array.from({ length: perRun }, (_, i) => (start + i) % total);
};

type Reconcilable = {
  reconcile(now: number): Promise<
    | {
        readonly nextWake?: number | null;
        readonly unknown?: number;
        readonly metadataBytes?: number;
      }
    | undefined
  >;
};

/** DO stub for a catalog entry; each kind maps to its namespace and object name. */
const stubFor = (env: CoreEnv, kind: CatalogKind, id: string): Reconcilable | null => {
  switch (kind) {
    case "mailbox":
      return mailbox(env, id);
    case "calendar":
      return calendar(env, id);
    case "space":
      return space(env, id);
    case "world":
      return world(env, id);
    default:
      return null;
  }
};

export const RECONCILED_KINDS: ReadonlyArray<CatalogKind> = [
  "mailbox",
  "calendar",
  "space",
  "world",
];

/** Authorities reconciled concurrently per catalog page (each call is one DO RPC). */
export const RECONCILE_CONCURRENCY = 8;

/** A failure's class for aggregated logging: the rejection code, the error name, or its type. */
const errorClass = <E>(error: E): string =>
  Predicate.isObjectOrArray(error) && "code" in error && Predicate.isString(error.code)
    ? error.code
    : error instanceof Error
      ? error.name
      : typeNameOf(error);

export const reconcileCatalog = async (
  env: CoreEnv,
  scheduledTime: number,
): Promise<{
  readonly mailboxes: number;
  readonly unknownSends: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly failures: number;
}> => {
  const directory = new ControlDirectory(env.DIRECTORY, kernelClock);
  const byKind: Record<string, number> = {};
  const failuresByClass = new Map<string, number>();
  let unknownSends = 0;
  let failures = 0;

  const reconcileOne = async (
    kind: CatalogKind,
    entry: { readonly id: string; readonly nextWakeHint: number | null },
  ): Promise<void> => {
    const stub = stubFor(env, kind, entry.id);

    if (!stub) return;

    try {
      const result = await stub.reconcile(scheduledTime);
      unknownSends += result?.unknown ?? 0;
      const nextWake = result?.nextWake ?? null;

      if (nextWake !== entry.nextWakeHint) await directory.setWakeHint(kind, entry.id, nextWake);
      byKind[kind] = (byKind[kind] ?? 0) + 1;

      if (kind === "mailbox") {
        await reportShardHealth(env, entry.id);

        if (Predicate.isNumber(result?.metadataBytes))
          await reportMetadataHealth(env, entry.id, result.metadataBytes);
      }
    } catch (error) {
      // Transient failures are retried next rotation; the classes are logged once per run below.
      failures++;
      const key = `${kind}:${errorClass(error)}`;
      failuresByClass.set(key, (failuresByClass.get(key) ?? 0) + 1);
    }
  };

  for (const kind of RECONCILED_KINDS) {
    for (const shard of shardsForRun(scheduledTime)) {
      let after = "";

      for (;;) {
        const page = await directory.listCatalog(kind, shard, after, RECONCILE_BATCH);

        if (page.length === 0) break;

        for (let i = 0; i < page.length; i += RECONCILE_CONCURRENCY) {
          await Promise.all(
            page.slice(i, i + RECONCILE_CONCURRENCY).map((entry) => reconcileOne(kind, entry)),
          );
        }

        after = page.at(-1)!.id;

        if (page.length < RECONCILE_BATCH) break;
      }
    }
  }

  for (const [key, count] of failuresByClass) {
    const [kind, cls] = key.split(":");
    console.warn(
      JSON.stringify({ level: "warn", op: "reconcile.failure", kind, errorClass: cls, count }),
    );
  }

  metric(
    "reconcile.catalog",
    Object.values(byKind).reduce((a, b) => a + b, 0),
    { failures },
  );

  return { mailboxes: byKind.mailbox ?? 0, unknownSends, byKind, failures };
};

/** §12 storage safety: alert at 50% of the shard budget, split/rebuild before 70%. */
export const reportShardHealth = async (
  env: CoreEnv,
  mailboxId: string,
): Promise<"ok" | "alert" | "rollover"> => {
  const health = await env.SEARCH_SHARDS.getByName(`search:${mailboxId}`).health();
  const level = storageLevel(health.storedBytes, SEARCH_SHARD_BUDGET_BYTES);
  metric("search.shard.bytes", health.storedBytes, { level });

  if (level !== "ok")
    console.warn(
      JSON.stringify({
        level: "warn",
        op: "storage.shard",
        state: level,
        ratio: Number((health.storedBytes / SEARCH_SHARD_BUDGET_BYTES).toFixed(3)),
      }),
    );

  return level;
};

/**
 * §12 mailbox metadata budget: record the probed SQLite size and level (operator-visible in
 * `authority_storage`), alerting at 50% and flagging "rollover" at 70% for the sharding plan
 * documented beside MAILBOX_METADATA_BUDGET_BYTES.
 */
export const reportMetadataHealth = async (
  env: CoreEnv,
  mailboxId: string,
  bytes: number,
  now = Date.now(),
): Promise<"ok" | "alert" | "rollover"> => {
  const level = storageLevel(bytes, MAILBOX_METADATA_BUDGET_BYTES);
  metric("mailbox.metadata.bytes", bytes, { level });

  if (level !== "ok")
    console.warn(
      JSON.stringify({
        level: "warn",
        op: "storage.mailbox-metadata",
        state: level,
        ratio: Number((bytes / MAILBOX_METADATA_BUDGET_BYTES).toFixed(3)),
      }),
    );
  await env.DIRECTORY.prepare(
    `INSERT INTO authority_storage (kind, id, bytes, level, checked_at) VALUES ('mailbox', ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE SET bytes = excluded.bytes, level = excluded.level, checked_at = excluded.checked_at`,
  )
    .bind(mailboxId, bytes, level, now)
    .run()
    .catch(() => undefined);

  return level;
};

/**
 * Poison MIME (§6 row 7): after the replay budget is exhausted the original is preserved and a
 * quarantined placeholder delivery is committed so the user can see (and recover) it, instead of
 * the message silently disappearing. Returns false (nothing written) for an erased mailbox: a
 * journal receipt must never recreate content in it (§12).
 */
export const quarantineUnprocessable = async (
  env: CoreEnv,
  r: {
    readonly ingestionId: string;
    readonly mailboxId: string;
    readonly recipient: string;
    readonly envelopeFrom: string;
    readonly objectKey: string;
    readonly rawSize: number;
    readonly receivedAt: number;
  },
): Promise<boolean> => {
  if (await mailboxErased(env, r.mailboxId)) return false;
  const from = r.envelopeFrom || "mailer-daemon@invalid";

  // Forced by Cloudflare's RPC type mapping (see consumers.ts commitParsed): the full envelope.
  const result = (await mailbox(env, r.mailboxId).commitDelivery({
    ingestionId: r.ingestionId,
    recipient: r.recipient,
    messageKey: r.objectKey,
    rawSize: r.rawSize,
    summary: {
      from: { name: undefined, address: from },
      to: [{ name: undefined, address: r.recipient }],
      cc: [],
      replyTo: [],
      subject: "(message could not be processed)",
      date: r.receivedAt,
      messageIdHeader: undefined,
      inReplyTo: [],
      references: [],
      listId: undefined,
      listUnsubscribe: undefined,
      automated: false,
      snippet: "This message could not be processed safely. The original is preserved for review.",
      attachments: [],
      hasCalendar: false,
      calendarMethod: undefined,
    },
    // Quarantine (not just Spam): the unparsed original must never render or release attachments.
    safety: { _tag: "Malware", reason: "unprocessable message quarantined" },
    receivedAt: r.receivedAt,
  })) as { readonly ok: boolean; readonly code?: string };

  if (result.ok === false && result.code === "gone") return false;
  metric("ingest.quarantined", 1);

  return true;
};

export const reconcileIngress = async (env: CoreEnv): Promise<number> => {
  let republished = 0;

  for (let p = 0; p < INGRESS_JOURNAL_PARTITIONS; p++) {
    const journal = env.INGRESS_JOURNALS.getByName(`journal-${p}`);
    await journal.abandonStale(60 * 60_000);

    for (const r of await journal.pendingReplay(10 * 60_000, 100)) {
      if (IngressJournal.exhausted(r)) {
        try {
          // An erased mailbox's receipt is rejected (and later pruned): nothing is kept for it.
          if (await quarantineUnprocessable(env, r)) await journal.markCommitted(r.ingestionId);
          else await journal.markRejected(r.ingestionId);
        } catch {
          // Never `rejected`: that would let the prune sweep forget an SMTP-acknowledged message.
          // `quarantine-failed` rows are retried at QUARANTINE_RETRY_MS and never pruned.
          await journal.markQuarantineFailed(r.ingestionId);
        }

        console.error(
          JSON.stringify({
            level: "error",
            op: "ingest.replay-exhausted",
            partition: journalPartition(r.ingestionId),
          }),
        );
        continue;
      }

      await env.INGEST.send(
        {
          schemaVersion: 1,
          type: "ingest",
          eventId: `ingest:${r.ingestionId}`,
          ingestionId: r.ingestionId,
          mailboxId: r.mailboxId,
          recipient: r.recipient,
          envelopeFrom: r.envelopeFrom,
          objectKey: r.objectKey,
          rawSize: r.rawSize,
          receivedAt: r.receivedAt,
        },
        { contentType: "json" },
      );
      await journal.touchRepublished(r.ingestionId);
      republished++;
    }
  }

  metric("ingest.republished", republished);

  return republished;
};

/** Rows deleted per statement, and statements per table per run, so no prune exceeds limits. */
export const PRUNE_PAGE = 500;

export const PRUNE_MAX_PAGES = 20;

/**
 * Audit history kept in D1 (O02/X02 auditable administrative and API writes). The spec sets no
 * period; 400 days covers a full year of look-back plus a month of slack for annual reviews.
 */
export const AUDIT_RETENTION_DAYS = 400;

/** Revoked or expired credentials stay this long for incident review and reuse detection. */
export const CREDENTIAL_RETENTION_DAYS = 30;

/**
 * A signup that has not registered a passkey this long after creation is released. The retry
 * token lasts 30 minutes (routes/common.ts SIGNUP_TOKEN_TTL_MS); a day leaves ample margin.
 */
export const ABANDONED_SIGNUP_MS = DAY;

/**
 * Delete matching rows a page at a time (`rowid IN (… LIMIT n)`: D1 has no DELETE … LIMIT), up to
 * `PRUNE_MAX_PAGES` pages; the next daily run continues a larger backlog. Returns rows deleted.
 */
export const pruneBounded = async (
  env: CoreEnv,
  table: string,
  where: string,
  ...args: ReadonlyArray<unknown>
): Promise<number> => {
  let deleted = 0;

  for (let page = 0; page < PRUNE_MAX_PAGES; page++) {
    const r = await env.DIRECTORY.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
    )
      .bind(...args, PRUNE_PAGE)
      .run();

    const n = Number(r.meta.changes ?? 0);
    deleted += n;

    if (n < PRUNE_PAGE) break;
  }

  return deleted;
};

/** Daily prunes of bounded-retention ledgers (§12). */
export const pruneLedgers = async (env: CoreEnv, now: number): Promise<number> => {
  const credentialCutoff = now - CREDENTIAL_RETENTION_DAYS * DAY;
  // A device session past retention: revoked, or absolutely expired, long enough ago.
  const deadDevice = "(revoked_at IS NOT NULL AND revoked_at < ?) OR absolute_expires_at < ?";

  const prunes: ReadonlyArray<readonly [string, string, ...Array<unknown>]> = [
    ["push_deliveries", "delivered_at < ?", now - 30 * DAY],
    ["dead_letters", "state <> 'held' AND resolved_at < ?", now - 90 * DAY],
    ["blob_gc_intents", "state = 'deleted' AND checked_at < ?", now - 30 * DAY],
    ["send_unknowns", "resolved_at IS NOT NULL AND resolved_at < ?", now - 90 * DAY],
    ["oauth_codes", "expires_at < ?", now - DAY],
    // Provider event evidence (addresses included): 90 days once applied. Unmapped rows are kept
    // for operator review. The retention period awaits release approval (spec.md §5.6, §14).
    ["newsletter_events", "state = 'applied' AND received_at < ?", now - 90 * DAY],
    ["shared_propagation", "state <> 'pending' AND updated_at < ?", now - 30 * DAY],
    // Identity tables that otherwise grow forever (§10): audit history, spent challenges,
    // dead sessions and device credentials, expired device codes, stale lockout counters.
    ["audit_log", "created_at < ?", now - AUDIT_RETENTION_DAYS * DAY],
    ["auth_challenges", "expires_at < ?", now - DAY],
    [
      "sessions",
      "expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
      credentialCutoff,
      credentialCutoff,
    ],
    ["device_access_tokens", "expires_at < ?", now - DAY],
    [
      "device_refresh_tokens",
      `session_id IN (SELECT id FROM device_sessions WHERE ${deadDevice})`,
      credentialCutoff,
      credentialCutoff,
    ],
    // Children first (foreign keys): a session goes only once none of its tokens remain.
    [
      "device_sessions",
      `(${deadDevice}) AND NOT EXISTS (SELECT 1 FROM device_refresh_tokens r WHERE r.session_id = device_sessions.id) AND NOT EXISTS (SELECT 1 FROM device_access_tokens a WHERE a.session_id = device_sessions.id)`,
      credentialCutoff,
      credentialCutoff,
    ],
    ["device_codes", "expires_at < ?", now - DAY],
    [
      "auth_lockouts",
      "window_start < ? AND (locked_until IS NULL OR locked_until < ?)",
      now - DAY,
      now,
    ],
  ];

  let deleted = 0;

  for (const [table, where, ...args] of prunes) {
    try {
      deleted += await pruneBounded(env, table, where, ...args);
    } catch {
      // One table's failure never stops the others; the next daily run retries.
      console.warn(JSON.stringify({ level: "warn", op: "prune.ledger", table }));
    }
  }

  for (let p = 0; p < INGRESS_JOURNAL_PARTITIONS; p++) {
    try {
      await env.INGRESS_JOURNALS.getByName(`journal-${p}`).pruneCommitted(30 * DAY);
    } catch {
      console.warn(JSON.stringify({ level: "warn", op: "prune.journal", partition: p }));
    }
  }

  return deleted;
};

/**
 * Re-seal TOTP secrets still under an older SESSION_KEY ring version (a no-op query when none
 * are), bounded per run; once it reports 0 the old version may leave the ring.
 */
export const rotateTotpSeals = async (env: CoreEnv): Promise<number> => {
  const auth = new ControlAuth(env.DIRECTORY, kernelClock, await authConfig(env));
  const rotated = await auth.rotateTotpKeys(100, 10);

  if (rotated > 0)
    console.log(JSON.stringify({ level: "info", op: "totp.rotated", count: rotated }));

  return rotated;
};

/** Release signups that never registered a passkey (see `ControlDirectory.releaseAbandonedSignups`). */
export const releaseAbandonedSignups = async (env: CoreEnv, now: number): Promise<number> => {
  const released = await new ControlDirectory(env.DIRECTORY, kernelClock).releaseAbandonedSignups(
    now - ABANDONED_SIGNUP_MS,
    200,
  );

  if (released > 0)
    console.log(JSON.stringify({ level: "info", op: "signup.released", count: released }));

  return released;
};

export const runDaily = async (
  env: CoreEnv,
  now: number,
): Promise<{
  readonly gc: { deleted: number; retained: number };
  readonly tombstones: number;
  readonly usage: { readonly owners: number; readonly corrected: number; readonly failed: number };
}> => {
  const gc = await sweepBlobGc(env, now);
  const { replayed } = await replayUnverifiedTombstones(env);
  await pruneLedgers(env, now);
  await releaseAbandonedSignups(env, now).catch(() =>
    console.warn(JSON.stringify({ level: "warn", op: "signup.release-failed" })),
  );
  await rotateTotpSeals(env).catch((e) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        op: "totp.rotate-failed",
        error: e instanceof Error ? e.name : "unknown",
      }),
    ),
  );
  const usage = await sweepUsage(env, now);

  return { gc, tombstones: replayed, usage };
};

export const handleScheduled = async (
  controller: ScheduledController,
  env: CoreEnv,
): Promise<void> => {
  if (controller.cron === DAILY_CRON) {
    const daily = await runDaily(env, controller.scheduledTime);
    console.log(
      JSON.stringify({
        level: "info",
        op: "daily",
        deleted: daily.gc.deleted,
        retained: daily.gc.retained,
        tombstones: daily.tombstones,
        usageCorrected: daily.usage.corrected,
      }),
    );

    return;
  }

  const [catalog, ingress, unknown, propagation, newsletters] = await Promise.all([
    reconcileCatalog(env, controller.scheduledTime),
    reconcileIngress(env),
    reconcileUnknownSends(env),
    replayPendingPropagation(env, controller.scheduledTime),
    reconcileNewsletters(env, controller.scheduledTime),
  ]);

  console.log(
    JSON.stringify({
      level: "info",
      op: "reconcile",
      cron: controller.cron,
      byKind: catalog.byKind,
      failures: catalog.failures,
      unknownSends: catalog.unknownSends,
      republished: ingress,
      unknownResolved: unknown.resolved,
      propagationReplayed: propagation.replayed,
      propagationFailed: propagation.failed,
      newsletterEvents: newsletters.events,
      newsletterCreators: newsletters.creators,
      newsletterFailures: newsletters.failures,
    }),
  );
};
