import { normalizeAddress } from "@bye/domain";
import { Predicate } from "effect";
import type { KernelClock } from "../durable/kernel.ts";
import {
  hmacSha256,
  parseSecretRing,
  randomToken,
  type SecretRing,
  secretFor,
  sha256Hex,
  tagVersion,
  timingSafeEqual,
  toHex,
  untagVersion,
} from "./crypto.ts";
import { revokeAllCredentials } from "./auth.ts";
import {
  audit,
  changesOf,
  type D1BatchResult,
  type D1Like,
  type D1StatementLike,
  primary,
  q,
} from "./d1.ts";
import type { ControlCommerce } from "./commerce.ts";
import { guardD1 } from "./errors.ts";
import { reject } from "@bye/contracts";

// Billing ledger, entitlements (A01, A02) and account closure / reservation (A04, §11).
// A payment processor is an external boundary: only signed webhook events change entitlements.
// A browser "checkout success" redirect never grants access.

export type PlanInterval = "monthly" | "annual";

export type EntitlementStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export interface EntitlementRecord {
  readonly org_id: string;
  readonly plan: string;
  readonly interval: PlanInterval;
  readonly status: EntitlementStatus;
  readonly seats: number;
  readonly trial_ends_at: number | null;
  readonly period_end: number | null;
  readonly credits_cents: number;
  readonly short_address: number;
  readonly updated_at: number;
  /** Processor `created` time of the event that last changed this state (null: none yet). */
  readonly processor_event_at?: number | null;
}

export type BillingProcessorEvent =
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "trial.started";
      readonly plan: string;
      readonly trialEndsAt: number;
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "subscription.activated";
      readonly plan: string;
      readonly interval: PlanInterval;
      readonly seats: number;
      readonly periodEnd: number;
      readonly shortAddress?: boolean;
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "subscription.renewed";
      readonly periodEnd: number;
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "subscription.seats_changed";
      readonly seats: number;
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "subscription.cancelled";
      readonly atPeriodEnd: boolean;
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "invoice.payment_failed";
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "credit.granted";
      readonly cents: number;
      readonly reason: "refund" | "referral" | "goodwill";
    }
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "subscription.expired";
    }
  /** Processor-confirmed checkout (subscription or short-address purchase). */
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "checkout.completed";
      readonly sessionId: string;
    }
  /** Money returned to the customer; recorded in the ledger (no entitlement change by itself). */
  | {
      readonly id: string;
      readonly created: number;
      readonly orgId: string;
      readonly type: "refund.issued";
      readonly cents: number;
    };

export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Webhook signing secrets shorter than this are treated as unset. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** Verify `t=<unix>,v1=<hex hmac>` over `${t}.${body}` with timestamp tolerance (replay window). */
export const verifyBillingSignature = async (
  body: string,
  header: string | null,
  secret: string,
  nowMs: number,
): Promise<boolean> => {
  // An empty or short secret would let anyone forge events: refuse to verify at all.
  if (!header || secret.length < MIN_WEBHOOK_SECRET_LENGTH) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=") as [string, string]),
  );

  const t = Number(parts["t"]);
  const sig = parts["v1"];

  if (!Number.isFinite(t) || !sig) return false;

  if (Math.abs(nowMs - t * 1000) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = toHex(await hmacSha256(secret, `${t}.${body}`));

  return timingSafeEqual(expected, sig);
};

export const signBillingPayload = async (
  body: string,
  secret: string,
  nowMs: number,
): Promise<string> => {
  const t = Math.floor(nowMs / 1000);

  return `t=${t},v1=${toHex(await hmacSha256(secret, `${t}.${body}`))}`;
};

export class ControlBilling {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    /** Optional: commercial side effects (checkout completion, referral credits) of webhook events. */
    readonly commerce?: ControlCommerce,
  ) {}

  async entitlement(orgId: string): Promise<EntitlementRecord | null> {
    return guardD1("entitlement", () =>
      q(
        primary(this.db),
        "SELECT * FROM entitlements WHERE org_id = ?",
        orgId,
      ).first<EntitlementRecord>(),
    );
  }

  /** Whether the organization currently has service. Trials lapse at trial_ends_at. */
  async isEntitled(orgId: string): Promise<boolean> {
    const e = await this.entitlement(orgId);

    if (!e) return false;
    const now = this.clock.now();

    if (e.status === "trialing") return e.trial_ends_at !== null && e.trial_ends_at > now;

    if (e.status === "active" || e.status === "past_due") return true;

    // Cancelled at period end keeps service until the paid period finishes.
    return e.status === "cancelled" && e.period_end !== null && e.period_end > now;
  }

  /**
   * Verify and apply a processor webhook. Idempotent by provider event ID: the event row and the
   * entitlement change commit in one batch, so a replay changes nothing.
   */
  async handleWebhook(
    body: string,
    signature: string | null,
    secret: string,
  ): Promise<{ applied: boolean; duplicate: boolean }> {
    if (!(await verifyBillingSignature(body, signature, secret, this.clock.now())))
      return reject("unauthenticated", "invalid webhook signature");
    let event: BillingProcessorEvent;

    try {
      event = JSON.parse(body) as BillingProcessorEvent;
    } catch {
      return reject("bad_request", "invalid webhook body");
    }

    if (
      !Predicate.isString(event.id) ||
      !Predicate.isString(event.orgId) ||
      !Predicate.isString(event.type)
    )
      reject("bad_request", "invalid webhook event");

    return this.apply(event, body);
  }

  async apply(
    event: BillingProcessorEvent,
    raw = JSON.stringify(event),
  ): Promise<{ applied: boolean; duplicate: boolean }> {
    const seen = await q(
      primary(this.db),
      "SELECT 1 AS s FROM billing_events WHERE provider_event_id = ?",
      event.id,
    ).first();

    if (seen) return { applied: false, duplicate: true };
    const current = await this.entitlement(event.orgId);
    const now = this.clock.now();
    // Out-of-order delivery: an older status event never overwrites a newer state.
    // Compared with the processor time of the last applied event, not local `updated_at`: our
    // receipt time says nothing about the processor's ordering (a genuine later event can carry a
    // `created` earlier than the moment we happened to write the previous one).
    const lastProcessorAt = current?.processor_event_at ?? null;

    const stale =
      lastProcessorAt !== null &&
      event.created < lastProcessorAt &&
      !["credit.granted", "checkout.completed", "refund.issued"].includes(event.type);

    const change = stale ? [] : this.transition(event, current, now);

    if (this.commerce && !stale) {
      if (event.type === "checkout.completed")
        change.push(...this.commerce.completeCheckoutStatements(event.sessionId, event.id));

      // First paid activation credits referral participants exactly once (A02).
      if (event.type === "subscription.activated" && current?.status !== "active")
        change.push(...(await this.commerce.referralCreditStatements(event.orgId, event.id)));
    }

    if (event.type === "refund.issued") {
      change.push(
        q(
          this.db,
          "INSERT INTO billing_ledger (id, org_id, kind, amount_cents, reason, provider_event_id, created_at) VALUES (?, ?, 'refund', ?, 'processor', ?, ?)",
          this.clock.id("led"),
          event.orgId,
          Math.max(0, Math.floor(event.cents)),
          event.id,
          now,
        ),
      );
    }

    let results: Array<D1BatchResult>;

    try {
      results = await this.db.batch([
        q(
          this.db,
          "INSERT INTO billing_events (provider_event_id, org_id, type, payload, received_at) VALUES (?, ?, ?, ?, ?)",
          event.id,
          event.orgId,
          event.type,
          raw,
          now,
        ),
        ...change,
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return { applied: false, duplicate: true };
      throw e;
    }

    // The SQL ordering guard may have skipped a change that raced a newer event.
    return { applied: results.slice(1).some((r) => changesOf(r) > 0), duplicate: false };
  }

  /**
   * Entitlement change for one event, with the read-modify-write done in SQL so concurrent
   * webhooks cannot overwrite each other from a stale read: only the columns the event changes are
   * updated, credits are added in place (`credits_cents = credits_cents + ?`), and an older status
   * event never overwrites the state of a newer one (`WHERE excluded.processor_event_at >= …`).
   * `current` is used only to pick defaults for a first insert.
   */
  private transition(
    event: BillingProcessorEvent,
    current: EntitlementRecord | null,
    now: number,
  ): Array<D1StatementLike> {
    type Column = Exclude<keyof EntitlementRecord, "org_id" | "updated_at" | "processor_event_at">;

    type ColumnValue = string | number | null;

    const defaults: Record<Column, ColumnValue> = {
      plan: "personal",
      interval: "annual",
      status: "expired",
      seats: 1,
      trial_ends_at: null,
      period_end: null,
      credits_cents: 0,
      short_address: 0,
    };

    const ordered =
      "(entitlements.processor_event_at IS NULL OR excluded.processor_event_at >= entitlements.processor_event_at)";

    const upsert = (
      fields: Partial<Record<Column, ColumnValue>>,
      opts: {
        /** Only update an existing row (never create one). */
        readonly onlyWhen?: string;
        /** SQL per column instead of `excluded.<column>`. */
        readonly set?: Partial<Record<Column, string>>;
        /** Skip the ordering guard (additive events apply whenever they arrive). */
        readonly unordered?: boolean;
      } = {},
    ) => {
      const row = { ...defaults, ...fields };
      const columns = Object.keys(defaults) as Array<Column>;
      const changed = Object.keys(fields) as Array<Column>;

      const sets = [
        ...changed.map((c) => `${c} = ${opts.set?.[c] ?? `excluded.${c}`}`),
        "updated_at = excluded.updated_at",
        opts.unordered
          ? "processor_event_at = MAX(COALESCE(entitlements.processor_event_at, excluded.processor_event_at), excluded.processor_event_at)"
          : "processor_event_at = excluded.processor_event_at",
      ];

      const where = [opts.unordered ? null : ordered, opts.onlyWhen ?? null].filter(Boolean);

      return q(
        this.db,
        `INSERT INTO entitlements (org_id, ${columns.join(", ")}, updated_at, processor_event_at) VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET ${sets.join(", ")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
        event.orgId,
        ...columns.map((c) => row[c]),
        now,
        event.created,
      );
    };

    switch (event.type) {
      case "trial.started":
        return [
          q(
            this.db,
            "INSERT INTO entitlements (org_id, plan, interval, status, seats, trial_ends_at, period_end, credits_cents, short_address, updated_at, processor_event_at) VALUES (?, ?, 'annual', 'trialing', 1, ?, NULL, 0, 0, ?, ?) ON CONFLICT (org_id) DO NOTHING",
            event.orgId,
            event.plan,
            event.trialEndsAt,
            now,
            event.created,
          ),
        ];
      case "subscription.activated":
        return [
          upsert({
            plan: event.plan,
            interval: event.interval,
            status: "active",
            seats: event.seats,
            period_end: event.periodEnd,
            short_address: event.shortAddress ? 1 : 0,
          }),
        ];
      case "subscription.renewed":
        return [upsert({ status: "active", period_end: event.periodEnd })];
      case "subscription.seats_changed":
        return [upsert({ seats: Math.max(1, event.seats) })];
      case "subscription.cancelled":
        // At period end the paid period is kept (`period_end` untouched); otherwise it ends now.
        return [
          event.atPeriodEnd
            ? upsert({ status: "cancelled" })
            : upsert({ status: "expired", period_end: now }),
        ];
      case "invoice.payment_failed":
        // Only an active subscription becomes past due; nothing is created for an unknown org.
        return current
          ? [upsert({ status: "past_due" }, { onlyWhen: "entitlements.status = 'active'" })]
          : [];
      case "credit.granted":
        return [
          upsert(
            { credits_cents: Math.max(0, Math.floor(event.cents)) },
            {
              set: { credits_cents: "entitlements.credits_cents + excluded.credits_cents" },
              unordered: true,
            },
          ),
        ];
      case "subscription.expired":
        return [upsert({ status: "expired" })];
      case "checkout.completed":
      case "refund.issued":
        return [];
    }
  }
}

/**
 * Account lifecycle (A04, §11). Cancellation (billing), account closure (identity) and domain
 * removal (ControlDomains.remove) are separate operations. Closure keeps reserved addresses and an
 * optional verified forwarding entitlement as durable records independent of any mailbox.
 */
export class ControlLifecycle {
  private readonly secrets: SecretRing;

  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    /** SESSION_KEY: a plain secret (version 1) or a `v2:<key>,v1:<key>` ring. */
    secret: string | SecretRing,
  ) {
    this.secrets = parseSecretRing(secret);
  }

  /** Verification-token hash under ring `version`, tagged with it (`v<n>.<hex>`). */
  private async forwardingHash(token: string, version: number): Promise<string> {
    const hash = await sha256Hex(
      `${secretFor(this.secrets, version, "forwarding-verification")}:${token}`,
    );

    return tagVersion(version, hash);
  }

  async closeAccount(
    userId: string,
    input: { reserveAddressDays: number; forwardingDays: number },
  ): Promise<{ reserved: ReadonlyArray<string> }> {
    const db = primary(this.db);

    const user = await q(db, "SELECT status FROM users WHERE id = ?", userId).first<{
      status: string;
    }>();

    if (!user || user.status === "closed") return reject("not_found", "account");

    const routes = (
      await q(
        db,
        "SELECT r.address FROM address_routes r JOIN mailboxes m ON m.id = r.mailbox_id WHERE m.owner_user_id = ? AND m.kind = 'personal' AND r.disabled_at IS NULL",
        userId,
      ).all<{ address: string }>()
    ).results.map((r) => r.address);

    const now = this.clock.now();
    await this.db.batch([
      q(this.db, "UPDATE users SET status = 'closed', closed_at = ? WHERE id = ?", now, userId),
      // Every credential kind — sessions, API tokens, device sessions, support grants.
      ...revokeAllCredentials(this.db, this.clock, userId, "account-closed"),
      q(
        this.db,
        "UPDATE mailboxes SET status = 'closed' WHERE owner_user_id = ? AND kind = 'personal'",
        userId,
      ),
      q(
        this.db,
        "UPDATE address_routes SET disabled_at = ? WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE owner_user_id = ? AND kind = 'personal') AND disabled_at IS NULL",
        now,
        userId,
      ),
      ...routes.map((a) =>
        q(
          this.db,
          `INSERT INTO address_reservations (address, user_id, reason, reserved_until, forwarding_until, created_at) VALUES (?, ?, 'closure-hold', ?, ?, ?)
           ON CONFLICT (address) DO UPDATE SET reserved_until = excluded.reserved_until, forwarding_until = excluded.forwarding_until`,
          a,
          userId,
          now + input.reserveAddressDays * 86400_000,
          input.forwardingDays > 0 ? now + input.forwardingDays * 86400_000 : null,
          now,
        ),
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "account.close",
        target: userId,
        detail: { addresses: routes.length },
      }),
    ]);

    return { reserved: routes };
  }

  /** Request post-cancellation forwarding to an external address; requires destination verification. */
  async requestForwarding(
    userId: string,
    address: string,
    destination: string,
  ): Promise<{ verificationToken: string }> {
    const a = normalizeAddress(address);

    const r = await q(
      primary(this.db),
      "SELECT user_id, forwarding_until FROM address_reservations WHERE address = ?",
      a,
    ).first<{ user_id: string; forwarding_until: number | null }>();

    if (!r || r.user_id !== userId) return reject("not_found", "reservation");

    if (r.forwarding_until === null) reject("forbidden", "no forwarding entitlement");

    if (r.forwarding_until !== null && r.forwarding_until <= this.clock.now())
      reject("forbidden", "forwarding entitlement expired");
    const token = randomToken();
    await q(
      this.db,
      "UPDATE address_reservations SET forwarding_to = ?, forwarding_verified_at = NULL WHERE address = ?",
      `${normalizeAddress(destination)}#${await this.forwardingHash(token, this.secrets.current)}`,
      a,
    ).run();

    return { verificationToken: token };
  }

  async confirmForwarding(address: string, token: string): Promise<void> {
    const a = normalizeAddress(address);

    const r = await q(
      primary(this.db),
      "SELECT forwarding_to, forwarding_until FROM address_reservations WHERE address = ?",
      a,
    ).first<{ forwarding_to: string | null; forwarding_until: number | null }>();

    const [dest, stored] = (r?.forwarding_to ?? "").split("#");

    if (!dest || !stored) return reject("forbidden", "invalid verification");
    // Untagged hashes predate key rings and are version 1; an unknown version is a tagged error.
    const { version, value } = untagVersion(stored);
    const expected = untagVersion(await this.forwardingHash(token, version)).value;

    if (!timingSafeEqual(value, expected)) return reject("forbidden", "invalid verification");

    // A token issued inside the window must not activate forwarding after it has ended.
    if (r!.forwarding_until === null || r!.forwarding_until <= this.clock.now())
      return reject("forbidden", "forwarding entitlement expired");
    await q(
      this.db,
      "UPDATE address_reservations SET forwarding_to = ?, forwarding_verified_at = ? WHERE address = ?",
      dest,
      this.clock.now(),
      a,
    ).run();
  }

  /** Paid short-address reservation that survives subscription changes. */
  async reservePaidAddress(userId: string, address: string, until: number | null): Promise<void> {
    try {
      await q(
        this.db,
        "INSERT INTO address_reservations (address, user_id, reason, reserved_until, created_at) VALUES (?, ?, 'paid-address', ?, ?)",
        normalizeAddress(address),
        userId,
        until,
        this.clock.now(),
      ).run();
    } catch {
      reject("conflict", "address already reserved");
    }
  }
}
