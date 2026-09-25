// Data restore (§12 recovery objective, restore drills). SQLite-backed Durable Objects keep 30 days
// of point-in-time recovery: resolve a bookmark for the requested time, arm it for the next
// session, then abort the object so the next request starts from the restored state. D1 is
// restored separately with Time Travel (see infra/drills/DATA_RESTORE.md). After any restore the
// erasure tombstone ledger is replayed so erased data is never resurrected.

export const PITR_WINDOW_MS = 30 * 24 * 3600 * 1000;

interface PitrStorage {
  getBookmarkForTime(timestamp: number | Date): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

export interface RestorableState {
  readonly storage: unknown;
  abort(reason?: string): void;
}

export class RestoreRejected extends Error {
  override readonly name = "RestoreRejected";
}

/** Validate a requested restore point against the platform's recovery window. */
export const validateRestorePoint = (at: number, now: number): number => {
  if (!Number.isFinite(at)) throw new RestoreRejected("restore point must be a timestamp");
  if (at >= now) throw new RestoreRejected("restore point must be in the past");
  if (now - at > PITR_WINDOW_MS)
    throw new RestoreRejected("restore point is outside the 30-day recovery window");
  return Math.floor(at);
};

/**
 * Arm a point-in-time restore for this object. The abort happens after the RPC returns so the
 * caller receives the bookmark; the restore takes effect on the object's next session.
 */
export const pointInTimeRestore = async (
  ctx: RestorableState,
  at: number,
  now = Date.now(),
): Promise<{ readonly bookmark: string; readonly at: number }> => {
  const point = validateRestorePoint(at, now);
  const storage = ctx.storage as Partial<PitrStorage>;
  if (
    typeof storage.getBookmarkForTime !== "function" ||
    typeof storage.onNextSessionRestoreBookmark !== "function"
  ) {
    throw new RestoreRejected("this storage back-end does not support point-in-time recovery");
  }
  const bookmark = await storage.getBookmarkForTime(point);
  await storage.onNextSessionRestoreBookmark(bookmark);
  setTimeout(() => ctx.abort("point-in-time restore"), 0);
  return { bookmark, at: point };
};

/**
 * Wait until the restored object is serving from the restored storage (§12). `restoreTo` arms the
 * bookmark and aborts the instance asynchronously; any write that reaches the OLD instance first
 * would be rolled back. We therefore poll a per-instance epoch until it changes, and refuse to
 * continue (no replay) if the restart is not observed in time.
 */
export const awaitRestart = async (
  epoch: () => Promise<string>,
  before: string,
  timeoutMs = 15_000,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1_000)) {
    try {
      if ((await epoch()) !== before) return;
    } catch {
      // the aborting instance may reject calls; keep polling
    }
    if (Date.now() > deadline)
      throw new RestoreRejected("restored object did not restart in time; tombstones not replayed");
    await sleep(delay);
  }
};
