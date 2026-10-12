import type { ChangeType, MailReadResult } from "@bye/jmap";
import type { Sql } from "../durable/sql.ts";

// Typed history (spec.md §16 C1). Every committed mutation advances one account revision and
// records the objects it actually changed, per type. `/changes` coalesces each object's net
// lifecycle over (base, target] and pages by object ID within that fixed target.

/** Offline catch-up guaranteed in normal operation (C1 retention policy). */
export const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Rows compacted per call, so housekeeping fits one alarm budget. */
const COMPACT_BATCH = 2000;

export type ChangeOp = "created" | "updated" | "destroyed";

/**
 * Types whose objects belong to one principal (A2/A3): their history is keyed
 * `<principal>/<id>`, so a principal's state and `/changes` cover only its own objects and
 * another principal's submissions or drafts never surface, not even as IDs or state moves.
 */
export const PRINCIPAL_SCOPED: ReadonlySet<ChangeType> = new Set<ChangeType>([
  "EmailSubmission",
  "DraftSession",
]);

/** History key range `[lo, hi)` of one principal's objects. */
const scopeRange = (scope: string): readonly [string, string] => [`${scope}/`, `${scope}/\uffff`];

export class History {
  /** Revision opened by the current transaction, if any (one revision per transaction). */
  private open: number | null = null;

  private depth = 0;

  constructor(
    private readonly sql: Sql,
    private readonly now: () => number,
  ) {}

  revision(): number {
    return Number(
      this.sql.one<{ value: string }>("SELECT value FROM jmap_meta WHERE key = 'revision'")
        ?.value ?? 0,
    );
  }

  /**
   * Run `fn` in one transaction that commits at most one new revision. Nested calls share the
   * outer transaction and revision.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();

    return this.sql.tx(() => {
      this.depth++;

      try {
        return fn();
      } finally {
        this.depth--;
        this.open = null;
      }
    });
  }

  private rev(): number {
    if (this.depth === 0) throw new Error("history records only inside History.tx");

    if (this.open !== null) return this.open;
    const next = this.revision() + 1;
    this.sql.run(
      "INSERT INTO jmap_meta (key, value) VALUES ('revision', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(next),
    );
    this.open = next;

    return next;
  }

  /** Record that `type` object `id` was created, updated or destroyed in this transaction. */
  record(type: ChangeType, id: string, op: ChangeOp): void {
    const rev = this.rev();
    this.sql.run(
      "INSERT INTO jmap_history (rev, type, object_id, op, created_at) VALUES (?, ?, ?, ?, ?)",
      rev,
      type,
      id,
      op,
      this.now(),
    );
    this.sql.run(
      "INSERT INTO jmap_type_state (type, rev) VALUES (?, ?) ON CONFLICT (type) DO UPDATE SET rev = excluded.rev",
      type,
      rev,
    );
  }

  /** Record a change to one principal's object of a principal-scoped type. */
  recordFor(principalId: string, type: ChangeType, id: string, op: ChangeOp): void {
    this.record(type, `${principalId}/${id}`, op);
    this.sql.run(
      `INSERT INTO jmap_scoped_state (type, principal_id, rev) VALUES (?, ?, ?)
       ON CONFLICT (type, principal_id) DO UPDATE SET rev = excluded.rev`,
      type,
      principalId,
      this.rev(),
    );
  }

  /**
   * The type's state: the latest revision that changed it — with a scope, the latest that
   * changed that principal's objects (never below the compaction floor, so it never regresses).
   */
  typeRevision(type: ChangeType, scope?: string): number {
    if (scope === undefined)
      return Number(
        this.sql.one<{ rev: number }>("SELECT rev FROM jmap_type_state WHERE type = ?", type)
          ?.rev ?? 0,
      );

    const own = Number(
      this.sql.one<{ rev: number }>(
        "SELECT rev FROM jmap_scoped_state WHERE type = ? AND principal_id = ?",
        type,
        scope,
      )?.rev ?? 0,
    );

    return Math.max(own, this.floor(type));
  }

  private floor(type: ChangeType): number {
    return Number(
      this.sql.one<{ floor: number }>("SELECT floor FROM jmap_type_state WHERE type = ?", type)
        ?.floor ?? 0,
    );
  }

  /**
   * Net changes of `type` in (base, target], IDs after `cursor`, at most `limit`. A base below the
   * compaction floor, or past the current state, can't be calculated.
   */
  changes(
    type: ChangeType,
    base: number,
    target: number | null,
    cursor: string | null,
    limit: number,
    /** For a principal-scoped type: only this principal's objects, IDs unprefixed. */
    scope?: string,
  ): MailReadResult {
    const current = this.typeRevision(type, scope);
    const [lo, hi] = scope === undefined ? ["", "\uffff"] : scopeRange(scope);
    const upTo = target ?? current;

    if (base < this.floor(type) || base > current || upTo > current || upTo < base)
      return {
        _tag: "Refused",
        type: "cannotCalculateChanges",
        description: "state is outside the retained history",
      };

    // One grouped pass: each object's first and last operation in (base, upTo], by sequence.
    const rows = this.sql.all<{ object_id: string; first_op: ChangeOp; last_op: ChangeOp }>(
      `WITH g AS (
         SELECT object_id, MIN(seq) AS f, MAX(seq) AS l FROM jmap_history
         WHERE type = ? AND rev > ? AND rev <= ? AND object_id > ? AND object_id >= ? AND object_id < ?
         GROUP BY object_id ORDER BY object_id LIMIT ?
       )
       SELECT g.object_id, hf.op AS first_op, hl.op AS last_op
       FROM g JOIN jmap_history hf ON hf.seq = g.f JOIN jmap_history hl ON hl.seq = g.l
       ORDER BY g.object_id`,
      type,
      base,
      upTo,
      cursor === null ? "" : `${scope === undefined ? "" : lo}${cursor}`,
      lo,
      hi,
      limit + 1,
    );

    const page = rows.slice(0, limit);
    const id = (objectId: string) => objectId.slice(scope === undefined ? 0 : lo.length);
    const created: Array<string> = [];
    const updated: Array<string> = [];
    const destroyed: Array<string> = [];

    for (const r of page) {
      // Create-then-delete inside the interval disappears; create-then-update is a creation.
      if (r.first_op === "created" && r.last_op === "destroyed") continue;

      if (r.first_op === "created") created.push(id(r.object_id));
      else if (r.last_op === "destroyed") destroyed.push(id(r.object_id));
      else updated.push(id(r.object_id));
    }

    return {
      _tag: "Changes",
      state: { revision: String(upTo) },
      created,
      updated,
      destroyed,
      nextCursor: rows.length > limit ? id(page.at(-1)?.object_id ?? "") || null : null,
    };
  }

  /**
   * Drop history older than the retention window, raising each type's floor to the newest
   * revision dropped, so no `/changes` silently loses evidence (C1).
   */
  compact(now: number): number {
    const cutoff = now - HISTORY_RETENTION_MS;

    const old = this.sql.all<{ seq: number; type: string; rev: number }>(
      "SELECT seq, type, rev FROM jmap_history WHERE created_at < ? ORDER BY seq LIMIT ?",
      cutoff,
      COMPACT_BATCH,
    );

    if (old.length === 0) return 0;

    return this.sql.tx(() => {
      const floors = new Map<string, number>();

      for (const r of old) floors.set(r.type, Math.max(floors.get(r.type) ?? 0, Number(r.rev)));

      for (const [type, floor] of floors)
        this.sql.run(
          "UPDATE jmap_type_state SET floor = MAX(floor, ?) WHERE type = ?",
          floor,
          type,
        );
      this.sql.run("DELETE FROM jmap_history WHERE seq <= ?", old.at(-1)!.seq);

      return old.length;
    });
  }
}
