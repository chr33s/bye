import { publishedKey } from "@bye/domain";
import { type D1Like, q, revokeAllCredentials, unwrapRpc } from "@bye/platform-cloudflare";
import { kernelClock } from "./durable-host.ts";
import type { CoreEnv } from "./env.ts";
import { worldFallbackHandle, worldHandle } from "./publishing.ts";
import { metric } from "./metrics.ts";

// Erasure (§12): a checkpointed EraseWorkflow removes an account's content across blobs, indexes,
// authorities, grants, published copies and D1 rows. Tombstones are written FIRST and replayed
// after any restore, so a backup can never resurrect erased data.

export interface ErasurePlan {
  readonly v: 1;
  readonly userId: string;
  readonly mailboxIds: ReadonlyArray<string>;
  readonly calendarIds: ReadonlyArray<string>;
  readonly spaceIds: ReadonlyArray<string>;
  /** World handle whose published copies are removed (site/<handle>/…). */
  readonly worldHandle: string | null;
  readonly reason: string;
}

export type TombstoneKind = "user" | "mailbox" | "calendar" | "space-member" | "world";

/**
 * Tombstones are written to D1 AND mirrored to an append-only R2 ledger. D1 and Durable Objects
 * are restored point-in-time; R2 is not, so a restore to before the erasure cannot roll the ledger
 * back — replay re-seeds D1 from it (§12 "tombstone replay after restore").
 */
export const TOMBSTONE_LEDGER_PREFIX = "_erasure/";

export const writeTombstone = async (
  env: CoreEnv,
  kind: TombstoneKind,
  id: string,
  now = Date.now(),
): Promise<void> => {
  await env.ORIGINALS.put(
    `${TOMBSTONE_LEDGER_PREFIX}${kind}/${encodeURIComponent(id)}`,
    JSON.stringify({ kind, id, erasedAt: now }),
    { httpMetadata: { contentType: "application/json" } },
  );
  await env.DIRECTORY.prepare(
    "INSERT INTO erasure_tombstones (resource_kind, resource_id, erased_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(kind, id, now)
    .run();
};

/** Re-seed D1 tombstones from the R2 ledger (after a D1 restore). Returns rows re-inserted. */
export const reseedTombstones = async (env: CoreEnv): Promise<number> => {
  let reseeded = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.ORIGINALS.list({
      prefix: TOMBSTONE_LEDGER_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of listed.objects) {
      const [kind = "", rawId = ""] = o.key.slice(TOMBSTONE_LEDGER_PREFIX.length).split("/");
      const r = await env.DIRECTORY.prepare(
        "INSERT INTO erasure_tombstones (resource_kind, resource_id, erased_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
        .bind(
          kind,
          decodeURIComponent(rawId),
          o.uploaded instanceof Date ? o.uploaded.getTime() : Date.now(),
        )
        .run();
      reseeded += r.meta.changes ?? 0;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return reseeded;
};

/** Everything owned by (or granted to) a user that erasure must cover. */
export const planErasure = async (
  env: CoreEnv,
  userId: string,
  reason: string,
): Promise<ErasurePlan> => {
  const db = env.DIRECTORY.withSession("first-primary");
  const mailboxes = await db
    .prepare("SELECT id FROM mailboxes WHERE owner_user_id = ?")
    .bind(userId)
    .all<{ id: string }>();
  const calendars = await db
    .prepare("SELECT id FROM calendars WHERE owner_user_id = ?")
    .bind(userId)
    .all<{ id: string }>();
  const user = await db
    .prepare("SELECT primary_address FROM users WHERE id = ?")
    .bind(userId)
    .first<{ primary_address: string }>();
  // Space membership lives in each SharedSpaceDO; D1 keeps an index when the control area provides
  // one (`space_memberships`). Without it, membership removal follows account closure instead.
  const spaces = await db
    .prepare("SELECT space_id AS id FROM space_memberships WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string }>()
    .catch(() => ({ results: [] as Array<{ id: string }> }));
  const handle = user?.primary_address
    ? await ownedWorldHandle(env, userId, user.primary_address)
    : null;
  return {
    v: 1,
    userId,
    mailboxIds: mailboxes.results.map((r) => r.id),
    calendarIds: calendars.results.map((r) => r.id),
    spaceIds: spaces.results.map((r) => r.id),
    worldHandle: handle,
    reason,
  };
};

/** Start erasure (callable by account closure and the operator route). Idempotent per user. */
export const startErasure = async (
  env: CoreEnv,
  userId: string,
  reason: string,
): Promise<{ readonly instanceId: string; readonly plan: ErasurePlan }> => {
  const plan = await planErasure(env, userId, reason);
  await writeTombstone(env, "user", userId);
  for (const id of plan.mailboxIds) await writeTombstone(env, "mailbox", id);
  for (const id of plan.mailboxIds) await fenceErasedMailbox(env, id);
  for (const id of plan.calendarIds) await writeTombstone(env, "calendar", id);
  for (const spaceId of plan.spaceIds)
    await writeTombstone(env, "space-member", spaceMemberTombstoneId(spaceId, userId));
  if (plan.worldHandle)
    await writeTombstone(env, "world", worldTombstoneId(plan.worldHandle, userId));
  const instanceId = `erase-${userId}`;
  try {
    await env.ERASE_ACCOUNT.create({ id: instanceId, params: plan });
  } catch (e) {
    // Already running/finished: tombstones still guarantee completion via replay.
    if (!String(e).match(/already|exists/i)) throw e;
  }
  metric("erasure.started", 1);
  return { instanceId, plan };
};

/**
 * Persistent erased fence in D1 (§12): the mailbox is closed and every address route to it
 * disabled, so SMTP stops accepting mail for it and authorization checks that require an active
 * mailbox (redelivery, access) refuse it. Idempotent; replay re-applies it after a D1 restore.
 */
export const fenceErasedMailbox = async (env: CoreEnv, mailboxId: string): Promise<void> => {
  const now = Date.now();
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("UPDATE mailboxes SET status = 'closed' WHERE id = ?").bind(mailboxId),
    env.DIRECTORY.prepare(
      "UPDATE address_routes SET disabled_at = ? WHERE mailbox_id = ? AND disabled_at IS NULL",
    ).bind(now, mailboxId),
  ]);
};

/**
 * Whether a mailbox has been erased (a tombstone exists). Asynchronous write paths — the ingest
 * consumer, journal quarantine, the indexer — check this before writing, so queued work cannot
 * recreate an erased mailbox's content after (or while) erasure runs.
 */
export const mailboxErased = async (
  env: CoreEnv,
  mailboxId: string,
  session: "first-primary" | "first-unconstrained" = "first-primary",
): Promise<boolean> =>
  (await env.DIRECTORY.withSession(session)
    .prepare(
      "SELECT 1 AS e FROM erasure_tombstones WHERE resource_kind = 'mailbox' AND resource_id = ? LIMIT 1",
    )
    .bind(mailboxId)
    .first<{ e: number }>()) !== null;

const purgePrefix = async (bucket: R2Bucket, prefix: string): Promise<number> => {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((o) => o.key));
      removed += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
};

/** Optional RPCs owned by other areas; missing methods are tolerated (tombstone replay retries). */
const tryRpc = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
};

export const eraseMailboxContent = async (env: CoreEnv, mailboxId: string): Promise<number> => {
  await fenceErasedMailbox(env, mailboxId);
  const removed =
    (await purgePrefix(env.ORIGINALS, `t/${mailboxId}/`)) +
    (await purgePrefix(env.PARTS, `t/${mailboxId}/`));
  // Every search shard, including ones opened by size rollover (`search:<mailbox>:<ts>`), not just
  // the base shard. The shard catalog lives in the mailbox authority, so every clear must succeed
  // BEFORE the authority is erased: a failure throws (the Workflow step retries, replay does not
  // mark the tombstone verified) while the catalog is still there to rediscover rollover shards.
  for (const shard of await mailboxShardNames(env, mailboxId))
    await env.SEARCH_SHARDS.getByName(shard).clear();
  await env.MAILBOXES.getByName(mailboxId).eraseAll();
  await env.DIRECTORY.prepare(
    "DELETE FROM storage_usage WHERE owner_kind = 'mailbox' AND owner_id = ?",
  )
    .bind(mailboxId)
    .run();
  await env.DIRECTORY.prepare(
    "UPDATE external_identity_credentials SET revoked_at = ?, ciphertext = '', iv = '' WHERE mailbox_id = ?",
  )
    .bind(Date.now(), mailboxId)
    .run();
  return removed;
};

/** All search shards a mailbox has used; always includes the base shard. */
export const mailboxShardNames = async (
  env: CoreEnv,
  mailboxId: string,
): Promise<ReadonlyArray<string>> => {
  // Never degrades to the base shard alone: an unreadable catalog fails the erase step (retried)
  // rather than skipping rollover shards whose names only the catalog records.
  const names = new Set<string>([`search:${mailboxId}`]);
  for (const shard of await env.MAILBOXES.getByName(mailboxId).searchShards())
    names.add(shard.name);
  return [...names];
};

export const eraseCalendarContent = async (env: CoreEnv, calendarId: string): Promise<boolean> => {
  // Day photos live in PARTS under the calendar's own prefix (`cal/<id>/photo/…`), outside any
  // mailbox prefix; the authority only holds references to them.
  await purgePrefix(env.PARTS, `cal/${calendarId}/`);
  return tryRpc(() => env.CALENDARS.getByName(calendarId).eraseAll());
};

/** Revoke the user's membership/grants in shared spaces (their authored shared copies stay with the space). */
export const eraseSpaceMembership = async (
  env: CoreEnv,
  spaceId: string,
  userId: string,
): Promise<boolean> =>
  tryRpc(() => env.SHARED_SPACES.getByName(`space:${spaceId}`).eraseMember(userId));

/** Tombstone ID for a space membership: `<spaceId>:<userId>`. */
export const spaceMemberTombstoneId = (spaceId: string, userId: string): string =>
  `${spaceId}:${userId}`;

export const erasePublished = async (env: CoreEnv, handle: string): Promise<number> =>
  purgePrefix(env.PUBLISHED, publishedKey.prefix(handle));

const worldStub = (env: CoreEnv, handle: string) => env.SHARED_SPACES.getByName(`world:${handle}`);

/** The World handle this user actually owns (natural or collision fallback), if any. */
export const ownedWorldHandle = async (
  env: CoreEnv,
  userId: string,
  address: string,
): Promise<string | null> => {
  const natural = worldHandle(address, new URL(env.APP_ORIGIN).hostname.replace(/^app\./, ""));
  for (const handle of [natural, await worldFallbackHandle(address, natural)]) {
    const r = await worldStub(env, handle).worldAuthorId();
    if (r.ok && r.value === userId) return handle;
  }
  return null;
};

/** World tombstone ID `<handle>#<userId>`: replay erases only while the handle is still the user's. */
export const worldTombstoneId = (handle: string, userId: string): string => `${handle}#${userId}`;

/**
 * Erase a World author: posts, revisions, subscriber addresses and newsletter state in the
 * authority, then the public copies and newsletter routing rows; the handle is released. Skipped
 * when the handle was re-claimed. Provider-side contacts follow the provider retention decision.
 */
export const eraseWorldAuthor = async (
  env: CoreEnv,
  handle: string,
  userId: string | null,
): Promise<boolean> => {
  const erased = unwrapRpc(await worldStub(env, handle).eraseWorld(userId));
  if (erased) {
    await erasePublished(env, handle);
    // Private site-render markers (`t/world/<handle>/site-rendered/…`) in PARTS.
    await purgePrefix(env.PARTS, `t/world/${handle}/`);
    // Newsletter routing rows carry subscriber addresses; the ledger itself went with the authority.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM newsletter_contacts WHERE handle = ?").bind(handle),
      env.DIRECTORY.prepare("DELETE FROM newsletter_refs WHERE handle = ?").bind(handle),
    ]);
  }
  return erased;
};

export const eraseUserRows = async (env: CoreEnv, userId: string): Promise<void> => {
  // Every credential kind (sessions, API tokens, device sessions, support grants) through the one
  // revocation table, so erasure can never drift from recovery or closure.
  const db: D1Like = env.DIRECTORY;
  await db.batch([
    ...revokeAllCredentials(db, kernelClock, userId, "erasure"),
    q(db, "DELETE FROM push_devices WHERE user_id = ?", userId),
    q(db, "DELETE FROM passkeys WHERE user_id = ?", userId),
    q(db, "DELETE FROM storage_usage WHERE owner_kind = 'user' AND owner_id = ?", userId),
    q(db, "DELETE FROM account_exports WHERE user_id = ?", userId),
  ]);
  await purgePrefix(env.EXPORTS, `t/${userId}/export/`);
  // User-keyed private World media originals (`t/<userId>/world-media/…`), outside mailbox prefixes.
  await purgePrefix(env.PARTS, `t/${userId}/world-media/`);
};

type TombstoneRow = { erased_at: number; resource_kind: TombstoneKind; resource_id: string };

const markVerified = (env: CoreEnv, t: TombstoneRow) =>
  env.DIRECTORY.prepare(
    "UPDATE erasure_tombstones SET verified_at = ? WHERE resource_kind = ? AND resource_id = ?",
  )
    .bind(Date.now(), t.resource_kind, t.resource_id)
    .run();

/**
 * Replay one tombstone and mark it verified only if every step of it succeeded; a failure (e.g. a
 * search shard that could not be cleared) leaves it unverified so the daily sweep retries it.
 */
const replayAndVerify = async (env: CoreEnv, t: TombstoneRow): Promise<boolean> => {
  try {
    await replayTombstone(env, t);
  } catch (error) {
    metric("erasure.tombstones.replay_failed", 1, { kind: t.resource_kind });
    console.error(
      JSON.stringify({
        level: "error",
        op: "erasure.replay-failed",
        kind: t.resource_kind,
        error: String(error).slice(0, 200),
      }),
    );
    return false;
  }
  await markVerified(env, t);
  return true;
};

/**
 * Tombstones that can affect one restored authority (§12). A point-in-time restore of a single
 * object only needs these re-applied — not every erasure ever performed.
 */
export const replayTombstonesFor = async (
  env: CoreEnv,
  kind: "mailbox" | "calendar" | "space",
  id: string,
): Promise<{ readonly replayed: number }> => {
  const rows = (
    kind === "space"
      ? await env.DIRECTORY.prepare(
          "SELECT erased_at, resource_kind, resource_id FROM erasure_tombstones WHERE resource_kind = 'space-member' AND resource_id LIKE ? ESCAPE '\\'",
        )
          .bind(`${id.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`)
          .all<TombstoneRow>()
      : await env.DIRECTORY.prepare(
          "SELECT erased_at, resource_kind, resource_id FROM erasure_tombstones WHERE resource_kind = ? AND resource_id = ?",
        )
          .bind(kind, id)
          .all<TombstoneRow>()
  ).results;
  let replayed = 0;
  for (const t of rows) if (await replayAndVerify(env, t)) replayed++;
  metric("erasure.tombstones.replayed", replayed, { scope: kind });
  return { replayed };
};

/** Routine sweep: only tombstones whose erasure has not been verified yet (e.g. an interrupted run). */
export const replayUnverifiedTombstones = async (
  env: CoreEnv,
  limit = 500,
): Promise<{ readonly replayed: number }> => {
  const rows = (
    await env.DIRECTORY.prepare(
      "SELECT erased_at, resource_kind, resource_id FROM erasure_tombstones WHERE verified_at IS NULL ORDER BY erased_at LIMIT ?",
    )
      .bind(limit)
      .all<TombstoneRow>()
  ).results;
  let replayed = 0;
  for (const t of rows) if (await replayAndVerify(env, t)) replayed++;
  metric("erasure.tombstones.replayed", replayed, { scope: "unverified" });
  return { replayed };
};

/**
 * Full replay of EVERY tombstone (idempotent), reseeding D1 from the R2 ledger first. Only for
 * platform-level restores (D1/R2 recovered from backup), triggered explicitly by an operator (§12).
 */
export const replayTombstones = async (
  env: CoreEnv,
  pageSize = 500,
): Promise<{ readonly replayed: number }> => {
  await reseedTombstones(env);
  // Keyset pagination over (erased_at, kind, id): every tombstone is replayed, however many exist.
  let replayed = 0;
  let after: { erased_at: number; resource_kind: string; resource_id: string } | null = null;
  for (;;) {
    const page: ReadonlyArray<{
      erased_at: number;
      resource_kind: TombstoneKind;
      resource_id: string;
    }> = (
      await (
        after
          ? env.DIRECTORY.prepare(
              "SELECT erased_at, resource_kind, resource_id FROM erasure_tombstones WHERE (erased_at, resource_kind, resource_id) > (?, ?, ?) ORDER BY erased_at, resource_kind, resource_id LIMIT ?",
            ).bind(after.erased_at, after.resource_kind, after.resource_id, pageSize)
          : env.DIRECTORY.prepare(
              "SELECT erased_at, resource_kind, resource_id FROM erasure_tombstones ORDER BY erased_at, resource_kind, resource_id LIMIT ?",
            ).bind(pageSize)
      ).all<{ erased_at: number; resource_kind: TombstoneKind; resource_id: string }>()
    ).results;
    for (const t of page) if (await replayAndVerify(env, t)) replayed++;
    if (page.length < pageSize) break;
    after = page.at(-1)!;
  }
  metric("erasure.tombstones.replayed", replayed);
  return { replayed };
};

const replayTombstone = async (
  env: CoreEnv,
  t: { readonly resource_kind: TombstoneKind; readonly resource_id: string },
): Promise<void> => {
  switch (t.resource_kind) {
    case "mailbox":
      await eraseMailboxContent(env, t.resource_id);
      break;
    case "calendar":
      await eraseCalendarContent(env, t.resource_id);
      break;
    case "world": {
      const sep = t.resource_id.indexOf("#");
      await eraseWorldAuthor(
        env,
        sep > 0 ? t.resource_id.slice(0, sep) : t.resource_id,
        sep > 0 ? t.resource_id.slice(sep + 1) : null,
      );
      break;
    }
    case "space-member": {
      const sep = t.resource_id.indexOf(":");
      if (sep > 0)
        await eraseSpaceMembership(env, t.resource_id.slice(0, sep), t.resource_id.slice(sep + 1));
      break;
    }
    case "user":
      await eraseUserRows(env, t.resource_id);
      break;
    default:
      break;
  }
};
