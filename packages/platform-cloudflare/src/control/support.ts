import type { KernelClock } from "../durable/kernel.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { audit, auditIfChanged, changesOf, type D1Like, primary, q } from "./d1.ts";
import { guardD1 } from "./errors.ts";
import { reject } from "@bye/contracts";

// Audited support access (§10). A user explicitly consents to a time-boxed, read-only grant. An
// operator can then open a short-lived support session bound to that grant; every use is audited
// on the user's own log, and revoking the grant ends all its sessions immediately.

export const SUPPORT_MAX_HOURS = 72;

export const SUPPORT_SESSION_MS = 60 * 60_000;

export const SUPPORT_TOKEN_PREFIX = "bsp_";

export class ControlSupport {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
  ) {}

  async grant(
    userId: string,
    reason: string,
    hours: number,
  ): Promise<{ readonly id: string; readonly expiresAt: number }> {
    if (!reason.trim() || reason.length > 500) reject("bad_request", "reason required");

    if (!(hours > 0 && hours <= SUPPORT_MAX_HOURS))
      reject("bad_request", `grant must be 1–${SUPPORT_MAX_HOURS} hours`);
    const id = this.clock.id("sup");
    const expiresAt = this.clock.now() + Math.floor(hours * 3600_000);
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO support_grants (id, user_id, reason, granted_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        id,
        userId,
        reason.trim(),
        this.clock.now(),
        expiresAt,
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "support.grant",
        target: id,
        detail: { hours },
      }),
    ]);

    return { id, expiresAt };
  }

  async revoke(userId: string, grantId: string): Promise<boolean> {
    const results = await this.db.batch([
      q(
        this.db,
        "UPDATE support_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        this.clock.now(),
        grantId,
        userId,
      ),
      auditIfChanged(this.db, this.clock, {
        actorId: userId,
        action: "support.revoke",
        target: grantId,
      }),
    ]);

    return changesOf(results[0]) === 1;
  }

  async list(userId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly reason: string;
      readonly grantedAt: number;
      readonly expiresAt: number;
      readonly active: boolean;
    }>
  > {
    const now = this.clock.now();

    const rows = await q(
      primary(this.db),
      "SELECT id, reason, granted_at, expires_at, revoked_at FROM support_grants WHERE user_id = ? ORDER BY granted_at DESC LIMIT 50",
      userId,
    ).all<{
      id: string;
      reason: string;
      granted_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>();

    return rows.results.map((r) => ({
      id: r.id,
      reason: r.reason,
      grantedAt: Number(r.granted_at),
      expiresAt: Number(r.expires_at),
      active: r.revoked_at === null && Number(r.expires_at) > now,
    }));
  }

  /** Operator opens a read-only support session under an active grant. */
  async openSession(
    operatorId: string,
    grantId: string,
  ): Promise<{ readonly token: string; readonly expiresAt: number; readonly userId: string }> {
    const g = await guardD1("support", () =>
      q(
        primary(this.db),
        "SELECT user_id, expires_at, revoked_at FROM support_grants WHERE id = ?",
        grantId,
      ).first<{ user_id: string; expires_at: number; revoked_at: number | null }>(),
    );

    const now = this.clock.now();

    if (!g || g.revoked_at !== null || g.expires_at <= now)
      return reject("forbidden", "no active support grant");
    const token = `${SUPPORT_TOKEN_PREFIX}${randomToken()}`;
    const expiresAt = Math.min(Number(g.expires_at), now + SUPPORT_SESSION_MS);
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO support_sessions (token_hash, grant_id, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        await sha256Hex(token),
        grantId,
        operatorId,
        now,
        expiresAt,
      ),
      audit(this.db, this.clock, {
        actorId: g.user_id,
        action: "support.session.open",
        target: grantId,
        detail: { operatorId },
      }),
    ]);

    return { token, expiresAt, userId: g.user_id };
  }

  /** Resolve a support token. Each successful use is audited on the user's log. */
  async authenticate(token: string): Promise<{
    readonly grantId: string;
    readonly userId: string;
    readonly operatorId: string;
  } | null> {
    const now = this.clock.now();

    const row = await guardD1("support", async () =>
      q(
        primary(this.db),
        `SELECT s.grant_id, s.operator_id, g.user_id FROM support_sessions s JOIN support_grants g ON g.id = s.grant_id JOIN users u ON u.id = g.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.status = 'active'`,
        await sha256Hex(token),
        now,
        now,
      ).first<{ grant_id: string; operator_id: string; user_id: string }>(),
    );

    if (!row) return null;
    await audit(this.db, this.clock, {
      actorId: row.user_id,
      action: "support.access",
      target: row.grant_id,
      detail: { operatorId: row.operator_id },
    }).run();

    return { grantId: row.grant_id, userId: row.user_id, operatorId: row.operator_id };
  }
}
