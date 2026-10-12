import { mailbox } from "./authorities.ts";
import type { CoreEnv } from "./env.ts";

// Recovery generations (spec.md §16 C1/C2) live in D1, outside every authority snapshot: a
// point-in-time restore advances the generation before it runs, and JMAP state tokens bind it, so
// a token minted before the restore can never match a revision the restore rewound.

export type AuthorityKind = "mailbox" | "calendar" | "space";

/** Advance one authority's restore generation; must commit before the restore is armed. */
export const advanceRestoreGeneration = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  kind: AuthorityKind,
  id: string,
  now = Date.now(),
): Promise<void> => {
  await env.DIRECTORY.prepare(
    `INSERT INTO authority_generations (kind, authority_id, restore_generation, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (kind, authority_id)
     DO UPDATE SET restore_generation = restore_generation + 1, updated_at = excluded.updated_at`,
  )
    .bind(kind, id, now)
    .run();
};

/** Current restore generations for a set of authorities (0 when never restored). */
export const restoreGenerations = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  kind: AuthorityKind,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, number>> => {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));

  if (ids.length === 0) return out;

  const rows = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT authority_id, restore_generation FROM authority_generations
       WHERE kind = ? AND authority_id IN (SELECT value FROM json_each(?))`,
    )
    // One JSON parameter: a session can list more accounts than D1's 100 bound parameters.
    .bind(kind, JSON.stringify(ids))
    .all<{ authority_id: string; restore_generation: number }>();

  for (const r of rows.results) out.set(r.authority_id, Number(r.restore_generation));

  return out;
};

/**
 * The directory's grant intent for one mailbox (A3): owners and members with their send right.
 * The account authority commits the effective grants; this is only the input.
 */
export const directoryGrants = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
): Promise<
  ReadonlyArray<{
    readonly principalId: string;
    readonly canSend: boolean;
    readonly owner: boolean;
  }>
> =>
  (
    await env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT a.user_id, a.role, a.can_send FROM mailbox_access a
         JOIN users u ON u.id = a.user_id
         JOIN mailboxes m ON m.id = a.mailbox_id
         JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id
         WHERE a.mailbox_id = ? AND u.status = 'active' AND ms.status = 'active'
         ORDER BY a.created_at, a.user_id`,
      )
      .bind(mailboxId)
      .all<{ user_id: string; role: string; can_send: number }>()
  ).results.map((r) => ({
    principalId: r.user_id,
    canSend: Number(r.can_send) === 1,
    owner: r.role === "owner",
  }));

// ---- effective-grant convergence (A3) ----

/** Mailboxes whose grants converge at once (each is a D1 read plus an authority RPC). */
const GRANT_SYNC_CONCURRENCY = 8;

/** How the account took a grant sync (see `JmapHost.syncGrants`). */
export type GrantSyncOutcome = "committed" | "recorded" | "legacy" | "stale";

/**
 * Commit one mailbox's effective grants from a fresh directory read. The read's time orders it:
 * the account ignores a read older than one it already took, so a slow sync can't restore a
 * removed member. The pending mark is cleared only if the request predates the read.
 */
export const syncMailboxGrants = async (
  env: CoreEnv,
  mailboxId: string,
): Promise<{ readonly outcome: GrantSyncOutcome; readonly aclGeneration: number | null }> => {
  const readAt = Date.now();
  const grants = await directoryGrants(env, mailboxId);

  const out = await mailbox(env, mailboxId).jmapSyncGrants(
    grants.map((g) => ({ principalId: g.principalId, canSend: g.canSend })),
    readAt,
  );

  // Only a request this read already reflects is done; one made after the read stays marked.
  await env.DIRECTORY.prepare(
    "DELETE FROM jmap_grant_sync WHERE mailbox_id = ? AND requested_at <= ?",
  )
    .bind(mailboxId, readAt)
    .run();

  return out;
};

/**
 * Mark every active mailbox of an organization for grant convergence (one D1 write). The marks
 * are durable: whatever propagation doesn't finish, the cron's `convergeGrants` retries. A new
 * request resets a mailbox's backoff.
 */
export const requestOrgGrantSync = async (
  env: CoreEnv,
  orgId: string,
  now = Date.now(),
): Promise<ReadonlyArray<string>> =>
  (
    await env.DIRECTORY.prepare(
      `INSERT INTO jmap_grant_sync (mailbox_id, requested_at, attempts, next_at)
       SELECT id, ?, 0, ? FROM mailboxes WHERE org_id = ? AND status = 'active'
       ON CONFLICT (mailbox_id) DO UPDATE SET requested_at = excluded.requested_at, attempts = 0, next_at = excluded.next_at
       RETURNING mailbox_id`,
    )
      .bind(now, now, orgId)
      .all<{ mailbox_id: string }>()
  ).results.map((r) => r.mailbox_id);

/** An organization's active mailboxes (the fallback when marking them failed). */
export const orgMailboxIds = async (env: CoreEnv, orgId: string): Promise<ReadonlyArray<string>> =>
  (
    await env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT id FROM mailboxes WHERE org_id = ? AND status = 'active' ORDER BY id")
      .bind(orgId)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

/** Converge the given mailboxes, a bounded number at a time; returns how many failed. */
export const syncGrantsFor = async (
  env: CoreEnv,
  mailboxIds: ReadonlyArray<string>,
): Promise<number> => {
  let failed = 0;

  for (let i = 0; i < mailboxIds.length; i += GRANT_SYNC_CONCURRENCY) {
    const settled = await Promise.allSettled(
      mailboxIds.slice(i, i + GRANT_SYNC_CONCURRENCY).map((id) => syncMailboxGrants(env, id)),
    );

    failed += settled.filter((s) => s.status === "rejected").length;
  }

  return failed;
};

/** First retry delay of a failing grant sync; it doubles per attempt (capped at ~17 h). */
const GRANT_RETRY_MS = 60_000;

/**
 * Cron: retry due marks, earliest first. Each pick pushes its next attempt out with exponential
 * backoff, so mailboxes that keep failing never starve newer marks (revocations included).
 */
export const convergeGrants = async (
  env: CoreEnv,
  now = Date.now(),
  limit = 50,
): Promise<{ readonly converged: number; readonly failed: number }> => {
  const pending = (
    await env.DIRECTORY.prepare(
      `UPDATE jmap_grant_sync SET attempts = attempts + 1, next_at = ? + ? * (1 << MIN(attempts, 10))
       WHERE mailbox_id IN (SELECT mailbox_id FROM jmap_grant_sync WHERE next_at <= ? ORDER BY next_at LIMIT ?)
       RETURNING mailbox_id`,
    )
      .bind(now, GRANT_RETRY_MS, now, limit)
      .all<{ mailbox_id: string }>()
  ).results.map((r) => r.mailbox_id);

  const failed = await syncGrantsFor(env, pending);

  return { converged: pending.length - failed, failed };
};

// ---- dispatch recovery registry (C2) ----

/** Journal one external send attempt before the provider is contacted. Throws on failure. */
export const recordAttempt = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
  sendJobId: string,
  attempt: number,
  now = Date.now(),
): Promise<void> => {
  await env.DIRECTORY.prepare(
    "INSERT OR IGNORE INTO send_attempts (mailbox_id, send_job_id, attempt, recorded_at) VALUES (?, ?, ?, ?)",
  )
    .bind(mailboxId, sendJobId, attempt, now)
    .run();
};

/** Whether new attempts are held for this authority (restore or reconciliation in progress). */
export const dispatchHeld = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
): Promise<boolean> =>
  (await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT 1 AS held FROM dispatch_holds WHERE mailbox_id = ?")
    .bind(mailboxId)
    .first<{ held: number }>()) !== null;

/** Hold reason of a restored mailbox whose sends still await reconciliation (C2). */
export const RESTORE_HOLD_REASON = "point-in-time restore";

/** How long a restore hold that never recorded its armed epoch waits for the sweep (C2). */
const UNARMED_RESTORE_HOLD_MS = 60 * 60_000;

/** A restored mailbox still held for reconciliation. */
export interface RestoreHold {
  readonly mailboxId: string;
  readonly createdAt: number;
  /** The session epoch before the restore was armed; null when the route never recorded it. */
  readonly armedEpoch: string | null;
}

/**
 * Restored mailboxes still held for reconciliation: armed ones held for at least `minAgeMs`, and
 * ones whose arming was never recorded once no restore can still be running (an hour).
 */
export const restoreHolds = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  now: number,
  minAgeMs: number,
  limit = 20,
): Promise<ReadonlyArray<RestoreHold>> =>
  (
    await env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT mailbox_id, created_at, armed_epoch FROM dispatch_holds
         WHERE reason = ? AND created_at <= CASE WHEN armed_epoch IS NULL THEN ? ELSE ? END
         ORDER BY created_at LIMIT ?`,
      )
      .bind(RESTORE_HOLD_REASON, now - UNARMED_RESTORE_HOLD_MS, now - minAgeMs, limit)
      .all<{ mailbox_id: string; created_at: number; armed_epoch: string | null }>()
  ).results.map((r) => ({
    mailboxId: r.mailbox_id,
    createdAt: r.created_at,
    armedEpoch: r.armed_epoch,
  }));

/** One authority's hold, as it was before a new hold replaced it. */
export interface DispatchHold {
  readonly reason: string;
  readonly createdAt: number;
  readonly armedEpoch: string | null;
}

/** The current hold on an authority, or null when none is. */
export const dispatchHold = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
): Promise<DispatchHold | null> => {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT reason, created_at, armed_epoch FROM dispatch_holds WHERE mailbox_id = ?")
    .bind(mailboxId)
    .first<{ reason: string; created_at: number; armed_epoch: string | null }>();

  return row
    ? { reason: row.reason, createdAt: row.created_at, armedEpoch: row.armed_epoch }
    : null;
};

/**
 * Hold new attempts for an authority; returns when this hold was armed. A repeated hold (a
 * retried restore) restarts its clock and forgets the earlier armed epoch, so the restore-hold
 * sweep never reconciles under a restore that is still running.
 */
export const holdDispatch = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
  reason: string,
  now = Date.now(),
): Promise<number> => {
  await env.DIRECTORY.prepare(
    "INSERT INTO dispatch_holds (mailbox_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (mailbox_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, armed_epoch = NULL",
  )
    .bind(mailboxId, reason, now)
    .run();

  return now;
};

/** Record the session epoch a restore was armed from, on the hold it was armed under (C2). */
export const armDispatchHold = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
  heldAt: number,
  epoch: string,
): Promise<void> => {
  await env.DIRECTORY.prepare(
    "UPDATE dispatch_holds SET armed_epoch = ? WHERE mailbox_id = ? AND created_at = ?",
  )
    .bind(epoch, mailboxId, heldAt)
    .run();
};

/**
 * Undo a hold that was never armed: put back the hold it replaced (an earlier restore still
 * awaiting reconciliation), or lift it when there was none. A newer hold is left alone.
 */
export const revertDispatchHold = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
  heldAt: number,
  prior: DispatchHold | null,
): Promise<void> => {
  if (prior === null) return liftDispatchHold(env, mailboxId, heldAt);

  await env.DIRECTORY.prepare(
    "UPDATE dispatch_holds SET reason = ?, created_at = ?, armed_epoch = ? WHERE mailbox_id = ? AND created_at = ?",
  )
    .bind(prior.reason, prior.createdAt, prior.armedEpoch, mailboxId, heldAt)
    .run();
};

/**
 * Lift a hold. With `heldAt`, only the hold reconciliation started under: one a newer restore
 * re-armed meanwhile (a later `created_at`) stays.
 */
export const liftDispatchHold = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
  heldAt?: number,
): Promise<void> => {
  await (
    heldAt === undefined
      ? env.DIRECTORY.prepare("DELETE FROM dispatch_holds WHERE mailbox_id = ?").bind(mailboxId)
      : env.DIRECTORY.prepare(
          "DELETE FROM dispatch_holds WHERE mailbox_id = ? AND created_at = ?",
        ).bind(mailboxId, heldAt)
  ).run();
};

/** When the current hold on an authority was (re)armed, or null when none is. */
export const dispatchHeldAt = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
): Promise<number | null> => (await dispatchHold(env, mailboxId))?.createdAt ?? null;

/** Attempt and acceptance evidence for an authority's jobs, from outside its snapshot. */
export const dispatchEvidence = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  mailboxId: string,
): Promise<
  ReadonlyArray<{
    readonly sendJobId: string;
    readonly attempted: boolean;
    readonly providerId: string | null;
  }>
> => {
  const db = env.DIRECTORY.withSession("first-primary");

  const attempts = (
    await db
      .prepare("SELECT DISTINCT send_job_id FROM send_attempts WHERE mailbox_id = ?")
      .bind(mailboxId)
      .all<{ send_job_id: string }>()
  ).results;

  const accepted = (
    await db
      .prepare("SELECT send_job_id, provider_id FROM send_acceptances WHERE mailbox_id = ?")
      .bind(mailboxId)
      .all<{ send_job_id: string; provider_id: string }>()
  ).results;

  const byJob = new Map<
    string,
    { sendJobId: string; attempted: boolean; providerId: string | null }
  >();

  for (const a of attempts)
    byJob.set(a.send_job_id, { sendJobId: a.send_job_id, attempted: true, providerId: null });

  for (const a of accepted)
    byJob.set(a.send_job_id, {
      sendJobId: a.send_job_id,
      attempted: true,
      providerId: a.provider_id,
    });

  return [...byJob.values()];
};
