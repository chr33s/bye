import type { SendingDecision } from "@bye/application";
import { domainOf, normalizeAddress } from "@bye/domain";
import type { KernelClock } from "../durable/kernel.ts";
import { inListChunks } from "../durable/sql.ts";
import {
  audit,
  auditIfChanged,
  changesOf,
  type D1Like,
  type D1SessionLike,
  type D1StatementLike,
  primary,
  q,
} from "./d1.ts";
import { guardD1 } from "./errors.ts";
import { reject } from "@bye/contracts";

// Outbound abuse controls (§10 Abuse and deliverability): per-user, per-identity, per-domain and
// platform sending budgets with new-account ramp-up, a suppression list, suspensions, and anomaly
// signals (bounce/complaint rates) that auto-suspend a compromised or abusive sender pending
// operator review.
//
// Call sites (dispatch path, owned by the ops area):
//   before claiming a send job:  const verdict = await policy.reserve({ userId, identity: from, recipients })
//                                 → if !verdict.allowed: fail the job (Rejected, verdict.reason) without I/O
//                                 → drop `verdict.suppressed` recipients (or reject if none remain)
//                                 → the deliverable count is already counted against every budget
//   send never accepted:         await policy.release({ userId, identity: from, recipients: reserved })
//   on provider events:          await policy.recordOutcome({ userId, identity, recipient, outcome })

export type SendingScope = "user" | "domain" | "identity" | "platform";

export interface RampTier {
  readonly maxAgeDays: number;
  readonly perDay: number;
}

/** New accounts ramp up; established accounts get the steady-state budget. */
export const RAMP_TIERS: ReadonlyArray<RampTier> = [
  { maxAgeDays: 1, perDay: 50 },
  { maxAgeDays: 7, perDay: 200 },
  { maxAgeDays: 30, perDay: 500 },
  { maxAgeDays: Number.POSITIVE_INFINITY, perDay: 2000 },
];

export interface SendingLimits {
  readonly identityPerDay: number;
  readonly domainPerDay: number;
  readonly platformPerHour: number;
  /** Minimum recipients in the review window before rates are evaluated. */
  readonly minVolume: number;
  readonly maxComplaintRate: number;
  readonly maxBounceRate: number;
}

export const DEFAULT_SENDING_LIMITS: SendingLimits = {
  identityPerDay: 1000,
  domainPerDay: 20_000,
  platformPerHour: 250_000,
  minVolume: 50,
  maxComplaintRate: 0.003,
  maxBounceRate: 0.08,
};

const HOUR = 3600_000;

interface SendingInput {
  readonly userId: string;
  readonly identity: string;
  readonly recipients: ReadonlyArray<string>;
}

type UsageRow = { scope: SendingScope; key: string; day: number; hour: number };

const MATCH_SCOPES =
  "(scope = ? AND key = ?) OR (scope = ? AND key = ?) OR (scope = ? AND key = ?) OR (scope = ? AND key = ?)";

const sendingScopes = (userId: string, identity: string) =>
  [
    ["platform", "*"],
    ["user", userId],
    ["identity", identity],
    ["domain", domainOf(identity)],
  ] as const satisfies ReadonlyArray<readonly [SendingScope, string]>;

const usedIn = (
  usage: ReadonlyArray<UsageRow>,
  scope: SendingScope,
  key: string,
  window: number,
): number => {
  const row = usage.find((u) => u.scope === scope && u.key === key);
  return Number((window === HOUR ? row?.hour : row?.day) ?? 0);
};
const DAY = 24 * HOUR;
const REVIEW_WINDOW = 7 * DAY;

/** The application's `SendingDecision`, narrowed to this adapter's scopes. */
export type SendingVerdict =
  | Exclude<SendingDecision, { readonly allowed: false }>
  | (Extract<SendingDecision, { readonly allowed: false }> & { readonly scope?: SendingScope });

export class SendingPolicy {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    readonly limits: SendingLimits = DEFAULT_SENDING_LIMITS,
  ) {}

  private bucket(now: number): number {
    return now - (now % HOUR);
  }

  async isSuspended(scope: SendingScope, key: string): Promise<boolean> {
    return (
      (await q(
        primary(this.db),
        "SELECT 1 AS s FROM sending_suspensions WHERE scope = ? AND key = ? AND lifted_at IS NULL",
        scope,
        key,
      ).first()) !== null
    );
  }

  async dailyBudget(userId: string): Promise<number> {
    // Personal budgets age with the user; shared (extension) mailboxes, keyed by mailbox ID, age
    // with their organization so they are not pinned to the new-account tier forever.
    const row = await q(
      primary(this.db),
      "SELECT COALESCE((SELECT created_at FROM users WHERE id = ?), (SELECT o.created_at FROM mailboxes m JOIN organizations o ON o.id = m.org_id WHERE m.id = ?)) AS created_at",
      userId,
      userId,
    ).first<{ created_at: number | null }>();
    const created = row?.created_at ?? null;
    const ageDays = created !== null ? (this.clock.now() - Number(created)) / DAY : 0;
    return RAMP_TIERS.find((t) => ageDays < t.maxAgeDays)!.perDay;
  }

  /**
   * Decide whether a send may proceed. Pure read: dispatch uses `reserve`, which re-checks the
   * budget after atomically counting the send. All reads run concurrently (one round trip):
   * suppressions, active suspensions for the four scopes, and the day/hour sums for the four
   * scopes, plus the user's (or org's) age for the ramp tier.
   * Decision order is fixed: suspended → all-suppressed → budget.
   */
  async check(input: SendingInput): Promise<SendingVerdict> {
    return guardD1("sending-policy", async () => (await this.evaluate(input)).verdict);
  }

  /**
   * `check`, then reserve the deliverable recipients against every budget. The increment and the
   * re-read of the windows commit in one batch, so concurrent dispatches each see the others'
   * reservations: at most the budget is ever admitted (a race can only over-refuse, which retries).
   * An over-budget reservation is compensated and refused. `release` returns a reservation whose
   * send never reached the provider.
   */
  async reserve(input: SendingInput): Promise<SendingVerdict> {
    return guardD1("sending-policy", async () => {
      const { verdict, deliverable, checks } = await this.evaluate(input);
      if (!verdict.allowed || deliverable === 0) return verdict;
      const identity = normalizeAddress(input.identity);
      const now = this.clock.now();
      const results = await this.db.batch([
        ...this.increments(input.userId, identity, deliverable),
        this.usageStatement(this.db, input.userId, identity, this.bucket(now)),
      ]);
      const usage = (results.at(-1) as { results?: Array<UsageRow> } | undefined)?.results ?? [];
      let remaining = Number.POSITIVE_INFINITY;
      for (const [scope, key, limit, window] of checks) {
        const used = usedIn(usage, scope, key, window);
        if (used > limit) {
          await this.db.batch(this.increments(input.userId, identity, -deliverable));
          return {
            allowed: false,
            reason: "budget",
            scope,
            retryAfterMs: HOUR - (now % HOUR),
            suppressed: verdict.suppressed,
          };
        }
        remaining = Math.min(remaining, limit - used);
      }
      return { allowed: true, suppressed: verdict.suppressed, remaining, reserved: deliverable };
    });
  }

  /** Return a reservation (`reserve`) whose send was never accepted by a provider. */
  async release(input: {
    readonly userId: string;
    readonly identity: string;
    readonly recipients: number;
  }): Promise<void> {
    const n = Math.max(0, Math.floor(input.recipients));
    if (n === 0) return;
    await this.db.batch(this.increments(input.userId, normalizeAddress(input.identity), -n));
  }

  private usageStatement(
    db: D1SessionLike,
    userId: string,
    identity: string,
    bucket: number,
  ): D1StatementLike {
    const scopeArgs = sendingScopes(userId, identity).flatMap(([scope, key]) => [scope, key]);
    // Day window per scope, plus the hour window (the platform's budget is hourly).
    return q(
      db,
      `SELECT scope, key, COALESCE(SUM(sent), 0) AS day, COALESCE(SUM(CASE WHEN window_start >= ? THEN sent ELSE 0 END), 0) AS hour
       FROM sending_counters WHERE (${MATCH_SCOPES}) AND window_start >= ? GROUP BY scope, key`,
      bucket,
      ...scopeArgs,
      bucket - DAY + HOUR,
    );
  }

  private async evaluate(input: SendingInput): Promise<{
    readonly verdict: SendingVerdict;
    readonly deliverable: number;
    readonly checks: ReadonlyArray<readonly [SendingScope, string, number, number]>;
  }> {
    const identity = normalizeAddress(input.identity);
    const domain = domainOf(identity);
    const recipients = [...new Set(input.recipients.map(normalizeAddress))];
    const now = this.clock.now();
    const bucket = this.bucket(now);
    const db = primary(this.db);
    const scopes = sendingScopes(input.userId, identity);
    const scopeArgs = scopes.flatMap(([scope, key]) => [scope, key]);
    const [suppressedRows, suspendedRows, usage, userBudget] = await Promise.all([
      // D1 binds at most 100 parameters per statement: look suppressions up in bounded chunks,
      // one after another.
      (async () => {
        const found: Array<{ address: string }> = [];
        for (const chunk of inListChunks(recipients)) {
          const rows = await q(
            db,
            `SELECT address FROM suppressions WHERE address IN (${chunk.map(() => "?").join(",")}) AND (expires_at IS NULL OR expires_at > ?)`,
            ...chunk,
            now,
          ).all<{ address: string }>();
          found.push(...rows.results);
        }
        return found;
      })(),
      q(
        db,
        `SELECT scope, key FROM sending_suspensions WHERE lifted_at IS NULL AND (${MATCH_SCOPES})`,
        ...scopeArgs,
      )
        .all<{ scope: SendingScope; key: string }>()
        .then((r) => r.results),
      this.usageStatement(db, input.userId, identity, bucket)
        .all<UsageRow>()
        .then((r) => r.results),
      this.dailyBudget(input.userId),
    ]);
    const suppressed = suppressedRows.map((r) => r.address);
    const deliverable = recipients.length - suppressed.length;
    const checks: ReadonlyArray<readonly [SendingScope, string, number, number]> = [
      ["user", input.userId, userBudget, DAY],
      ["identity", identity, this.limits.identityPerDay, DAY],
      ["domain", domain, this.limits.domainPerDay, DAY],
      ["platform", "*", this.limits.platformPerHour, HOUR],
    ];
    const decide = (): SendingVerdict => {
      const isSuspended = (scope: SendingScope, key: string) =>
        suspendedRows.some((r) => r.scope === scope && r.key === key);
      for (const [scope, key] of scopes) {
        if (isSuspended(scope, key))
          return { allowed: false, reason: "suspended", scope, suppressed };
      }
      if (recipients.length > 0 && deliverable === 0)
        return { allowed: false, reason: "all-suppressed", suppressed };
      let remaining = Number.POSITIVE_INFINITY;
      for (const [scope, key, limit, window] of checks) {
        const used = usedIn(usage, scope, key, window);
        if (used + deliverable > limit)
          return {
            allowed: false,
            reason: "budget",
            scope,
            retryAfterMs: HOUR - (now % HOUR),
            suppressed,
          };
        remaining = Math.min(remaining, limit - used - deliverable);
      }
      return { allowed: true, suppressed, remaining };
    };
    return { verdict: decide(), deliverable, checks };
  }

  private increments(userId: string, identity: string, n: number): Array<D1StatementLike> {
    return [
      this.increment("user", userId, "sent", n),
      this.increment("identity", identity, "sent", n),
      this.increment("domain", domainOf(identity), "sent", n),
      this.increment("platform", "*", "sent", n),
    ];
  }

  private increment(
    scope: SendingScope,
    key: string,
    field: "sent" | "bounced" | "complained",
    n: number,
  ): D1StatementLike {
    return q(
      this.db,
      `INSERT INTO sending_counters (scope, key, window_start, ${field}) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key, window_start) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
      scope,
      key,
      this.bucket(this.clock.now()),
      n,
    );
  }

  async record(input: {
    readonly userId: string;
    readonly identity: string;
    readonly recipients: number;
  }): Promise<void> {
    const identity = normalizeAddress(input.identity);
    const n = Math.max(0, Math.floor(input.recipients));
    await this.db.batch(this.increments(input.userId, identity, n));
  }

  /**
   * Provider feedback. Hard bounces and complaints suppress the recipient; rates over the review
   * window raise a signal and auto-suspend the sender until an operator reviews it.
   */
  async recordOutcome(input: {
    readonly userId: string;
    readonly identity: string;
    readonly recipient: string;
    readonly outcome: "hard-bounce" | "soft-bounce" | "complaint";
  }): Promise<{ readonly suspended: boolean }> {
    const identity = normalizeAddress(input.identity);
    const field = input.outcome === "complaint" ? "complained" : "bounced";
    const statements: Array<D1StatementLike> = [
      this.increment("user", input.userId, field, 1),
      this.increment("identity", identity, field, 1),
    ];
    if (input.outcome !== "soft-bounce")
      statements.push(
        this.suppressStatement(
          input.recipient,
          input.outcome === "complaint" ? "complaint" : "hard-bounce",
          `user:${input.userId}`,
        ),
      );
    await this.db.batch(statements);

    const since = this.bucket(this.clock.now()) - REVIEW_WINDOW;
    const r = await q(
      primary(this.db),
      "SELECT COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(bounced), 0) AS bounced, COALESCE(SUM(complained), 0) AS complained FROM sending_counters WHERE scope = 'user' AND key = ? AND window_start >= ?",
      input.userId,
      since,
    ).first<{ sent: number; bounced: number; complained: number }>();
    const sent = Number(r?.sent ?? 0);
    if (sent < this.limits.minVolume) return { suspended: false };
    const complaintRate = Number(r?.complained ?? 0) / sent;
    const bounceRate = Number(r?.bounced ?? 0) / sent;
    const signal =
      complaintRate > this.limits.maxComplaintRate
        ? "complaint-rate"
        : bounceRate > this.limits.maxBounceRate
          ? "bounce-rate"
          : null;
    if (!signal || (await this.isSuspended("user", input.userId))) return { suspended: false };
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO sending_signals (id, scope, key, signal, detail, created_at) VALUES (?, 'user', ?, ?, ?, ?)",
        this.clock.id("sig"),
        input.userId,
        signal,
        JSON.stringify({ sent, complaintRate, bounceRate }),
        this.clock.now(),
      ),
      this.suspendStatement("user", input.userId, `auto:${signal}`, "system"),
    ]);
    return { suspended: true };
  }

  private suppressStatement(
    address: string,
    reason: "hard-bounce" | "complaint" | "manual" | "unsubscribe",
    source: string,
  ): D1StatementLike {
    return q(
      this.db,
      "INSERT INTO suppressions (address, reason, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET reason = excluded.reason, source = excluded.source, created_at = excluded.created_at, expires_at = NULL",
      normalizeAddress(address),
      reason,
      source,
      this.clock.now(),
    );
  }

  private suspendStatement(
    scope: SendingScope,
    key: string,
    reason: string,
    actorId: string,
  ): D1StatementLike {
    return q(
      this.db,
      "INSERT INTO sending_suspensions (scope, key, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at, lifted_at = NULL, lifted_by = NULL",
      scope,
      key,
      reason,
      actorId,
      this.clock.now(),
    );
  }

  async suppress(address: string, reason: "manual" | "unsubscribe", source: string): Promise<void> {
    await this.db.batch([this.suppressStatement(address, reason, source)]);
  }

  async unsuppress(address: string): Promise<boolean> {
    const { meta } = await q(
      this.db,
      "DELETE FROM suppressions WHERE address = ?",
      normalizeAddress(address),
    ).run();
    return meta.changes === 1;
  }

  /** Operator suspension (immediately disables outbound for the scope). */
  async suspend(scope: SendingScope, key: string, reason: string, actorId: string): Promise<void> {
    if (!reason.trim()) reject("bad_request", "reason required");
    await this.db.batch([
      this.suspendStatement(scope, key, reason, actorId),
      audit(this.db, this.clock, {
        actorId,
        action: "sending.suspend",
        target: `${scope}:${key}`,
        detail: { reason },
      }),
    ]);
  }

  async lift(scope: SendingScope, key: string, actorId: string): Promise<boolean> {
    const results = await this.db.batch(this.liftStatements(scope, key, actorId));
    return changesOf(results[0]) === 1;
  }

  /** Lift plus its audit row (written only if a suspension was actually lifted), for one batch. */
  private liftStatements(
    scope: SendingScope,
    key: string,
    actorId: string,
  ): Array<D1StatementLike> {
    const now = this.clock.now();
    return [
      q(
        this.db,
        "UPDATE sending_suspensions SET lifted_at = ?, lifted_by = ? WHERE scope = ? AND key = ? AND lifted_at IS NULL",
        now,
        actorId,
        scope,
        key,
      ),
      auditIfChanged(this.db, this.clock, {
        actorId,
        action: "sending.lift",
        target: `${scope}:${key}`,
      }),
    ];
  }

  async openSignals(limit = 100): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly scope: string;
      readonly key: string;
      readonly signal: string;
      readonly detail: unknown;
      readonly createdAt: number;
    }>
  > {
    const rows = await q(
      primary(this.db),
      "SELECT id, scope, key, signal, detail, created_at FROM sending_signals WHERE reviewed_at IS NULL ORDER BY created_at LIMIT ?",
      limit,
    ).all<{
      id: string;
      scope: string;
      key: string;
      signal: string;
      detail: string;
      created_at: number;
    }>();
    return rows.results.map((r) => ({
      id: r.id,
      scope: r.scope,
      key: r.key,
      signal: r.signal,
      detail: JSON.parse(r.detail) as unknown,
      createdAt: Number(r.created_at),
    }));
  }

  /** Operator review: resolve a signal and optionally lift the automatic suspension. */
  async reviewSignal(
    id: string,
    actorId: string,
    resolution: "confirmed-abuse" | "false-positive",
  ): Promise<void> {
    const s = await q(
      primary(this.db),
      "SELECT scope, key FROM sending_signals WHERE id = ? AND reviewed_at IS NULL",
      id,
    ).first<{ scope: SendingScope; key: string }>();
    if (!s) return reject("not_found", "signal");
    // Review and (for a false positive) the lift commit together.
    await this.db.batch([
      q(
        this.db,
        "UPDATE sending_signals SET reviewed_at = ?, reviewed_by = ?, resolution = ? WHERE id = ?",
        this.clock.now(),
        actorId,
        resolution,
        id,
      ),
      ...(resolution === "false-positive" ? this.liftStatements(s.scope, s.key, actorId) : []),
    ]);
  }
}

/**
 * Provider-side sent-email previews stay disabled for private mail (§10, [C19]). No provider API
 * exposes the setting, so it is enforced at deploy time: `infra/policies/check-config.ts`
 * (`missingPreviewAttestation`) refuses a shared stage that holds a mail credential unless the
 * operator has attested PROVIDER_SENT_PREVIEWS=disabled after the RUNBOOK console step.
 * `infra/tests/check-config.test.ts` keeps the two in step.
 */
export const PROVIDER_PREVIEW_POLICY = { disableSentEmailPreviews: true } as const;
