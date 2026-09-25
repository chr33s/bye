import type { CoreEnv } from "./env.ts";
import { metric } from "./metrics.ts";

// Storage accounting outside the mailbox authority (§12 blob quota): extracted parts, normalized
// bodies and retained exports. The mailbox store accounts originals and uploads itself; the quota
// check adds these D1 totals (see `extraUsageBytes`).

export type UsageOwner = "mailbox" | "user";
export type UsageCategory = "parts" | "bodies" | "exports";

export const recordUsage = async (
  env: CoreEnv,
  ownerKind: UsageOwner,
  ownerId: string,
  category: UsageCategory,
  deltaBytes: number,
): Promise<void> => {
  if (deltaBytes === 0) return;
  await env.DIRECTORY.prepare(
    `INSERT INTO storage_usage (owner_kind, owner_id, category, bytes, updated_at) VALUES (?, ?, ?, MAX(0, ?), ?)
     ON CONFLICT (owner_kind, owner_id, category) DO UPDATE SET bytes = MAX(0, bytes + excluded.bytes), updated_at = excluded.updated_at`,
  )
    .bind(ownerKind, ownerId, category, deltaBytes, Date.now())
    .run()
    .catch(() => undefined); // accounting must never fail ingestion; the daily sweep can recompute
};

export const extraUsageBytes = async (
  env: CoreEnv,
  ownerKind: UsageOwner,
  ownerId: string,
): Promise<{
  readonly parts: number;
  readonly bodies: number;
  readonly exports: number;
  readonly total: number;
}> => {
  const rows = await env.DIRECTORY.prepare(
    "SELECT category, bytes FROM storage_usage WHERE owner_kind = ? AND owner_id = ?",
  )
    .bind(ownerKind, ownerId)
    .all<{ category: UsageCategory; bytes: number }>();
  const by = Object.fromEntries(rows.results.map((r) => [r.category, Number(r.bytes)])) as Partial<
    Record<UsageCategory, number>
  >;
  const parts = by.parts ?? 0;
  const bodies = by.bodies ?? 0;
  const exports = by.exports ?? 0;
  return { parts, bodies, exports, total: parts + bodies + exports };
};

// ---- recompute sweep (§12) ----
//
// The incremental deltas above can drift: `recordUsage` swallows D1 failures, and head→put→record
// sequences on the same key can race (two consumers both see "absent" and both count it). The
// daily sweep recomputes each owner's totals from R2 listings and corrects the stored rows. It is
// bounded (owners per run, pages per prefix) and writes compare-and-set on `updated_at`, so a delta
// recorded while listing is never overwritten by a stale total; the next run retries that row.

const RECOMPUTE_OWNERS_PER_RUN = 50;
const RECOMPUTE_MAX_PAGES = 20;

/** Bytes under `prefix` (optionally filtered), or null when the listing exceeds the page bound. */
const sumPrefix = async (
  bucket: R2Bucket,
  prefix: string,
  include: (key: string) => boolean = () => true,
): Promise<number | null> => {
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < RECOMPUTE_MAX_PAGES; page++) {
    const listed = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) if (include(o.key)) total += o.size ?? 0;
    if (!listed.truncated) return total;
    cursor = listed.cursor;
  }
  return null;
};

/** Actual bytes per category from R2 (the same layout `classifyKey` reads); null when unbounded. */
const actualUsage = async (
  env: CoreEnv,
  ownerKind: UsageOwner,
  ownerId: string,
): Promise<Partial<Record<UsageCategory, number | null>>> => {
  if (ownerKind === "user")
    return { exports: await sumPrefix(env.EXPORTS, `t/${ownerId}/export/`) };
  const [bodies, sentBodies, parts] = await Promise.all([
    sumPrefix(env.PARTS, `t/${ownerId}/body/`),
    sumPrefix(env.PARTS, `t/${ownerId}/out/`, (key) => key.endsWith(".json")),
    sumPrefix(env.PARTS, `t/${ownerId}/part/`),
  ]);
  return { bodies: bodies === null || sentBodies === null ? null : bodies + sentBodies, parts };
};

/** Recompute one owner's usage rows; returns how many rows were corrected. */
export const recomputeUsage = async (
  env: CoreEnv,
  ownerKind: UsageOwner,
  ownerId: string,
  now = Date.now(),
): Promise<{ readonly corrected: number; readonly skipped: number }> => {
  const rows = await env.DIRECTORY.prepare(
    "SELECT category, bytes, updated_at FROM storage_usage WHERE owner_kind = ? AND owner_id = ?",
  )
    .bind(ownerKind, ownerId)
    .all<{ category: UsageCategory; bytes: number; updated_at: number }>();
  const stored = new Map(rows.results.map((r) => [r.category, r]));
  const actual = await actualUsage(env, ownerKind, ownerId);
  let corrected = 0;
  let skipped = 0;
  for (const [category, bytes] of Object.entries(actual) as Array<[UsageCategory, number | null]>) {
    if (bytes === null) {
      skipped++;
      continue;
    }
    // A correct row is still re-stamped (compare-and-set), so the rotation moves on to other owners.
    const row = stored.get(category);
    const result = row
      ? await env.DIRECTORY.prepare(
          "UPDATE storage_usage SET bytes = ?, updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND category = ? AND updated_at = ?",
        )
          .bind(bytes, now, ownerKind, ownerId, category, row.updated_at)
          .run()
      : bytes > 0
        ? await env.DIRECTORY.prepare(
            "INSERT INTO storage_usage (owner_kind, owner_id, category, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          )
            .bind(ownerKind, ownerId, category, bytes, now)
            .run()
        : null;
    if (result?.meta.changes === 1 && Number(row?.bytes ?? 0) !== bytes) {
      corrected++;
      metric("usage.drift", bytes - Number(row?.bytes ?? 0), { category });
    }
  }
  return { corrected, skipped };
};

/**
 * Daily, bounded recompute over the owners whose rows were touched longest ago. Failures are
 * per owner and logged by error class; the rest of the sweep continues.
 */
export const sweepUsage = async (
  env: CoreEnv,
  now = Date.now(),
  limit = RECOMPUTE_OWNERS_PER_RUN,
): Promise<{ readonly owners: number; readonly corrected: number; readonly failed: number }> => {
  const owners = await env.DIRECTORY.prepare(
    "SELECT owner_kind, owner_id, MIN(updated_at) AS oldest FROM storage_usage GROUP BY owner_kind, owner_id ORDER BY oldest LIMIT ?",
  )
    .bind(limit)
    .all<{ owner_kind: UsageOwner; owner_id: string }>();
  let corrected = 0;
  let failed = 0;
  for (const o of owners.results) {
    try {
      corrected += (await recomputeUsage(env, o.owner_kind, o.owner_id, now)).corrected;
    } catch (error) {
      failed++;
      console.warn(
        JSON.stringify({
          level: "warn",
          op: "usage.recompute",
          ownerKind: o.owner_kind,
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
  metric("usage.recomputed", owners.results.length, { corrected, failed });
  return { owners: owners.results.length, corrected, failed };
};
