import { normalizeAddress } from "@bye/domain";
import type { KernelClock } from "../durable/kernel.ts";
import type { EntitlementRecord, PlanInterval } from "./billing.ts";
import { base32Encode } from "./totp.ts";
import {
  hmacSha256,
  parseSecretRing,
  randomBytes,
  type SecretRing,
  secretFor,
  tagVersion,
  timingSafeEqual,
  toHex,
  untagVersion,
} from "./crypto.ts";
import { type D1Like, type D1StatementLike, primary, q } from "./d1.ts";
import { guardD1 } from "./errors.ts";
import { reject } from "@bye/contracts";

// Commercial lifecycle (A01, A02, A04). Checkout, plan changes and cancellation are REQUESTS to an
// external processor; entitlements change only when a signed processor webhook arrives (§11). The
// browser return from checkout is signed so it can show status, but it never grants access.

export interface PlanDefinition {
  readonly id: string;
  readonly kind: "personal" | "domain" | "family";
  readonly monthlyCents: number;
  readonly annualCents: number;
  readonly perSeat: boolean;
  /** Post-closure address reservation and forwarding entitlement (A04). */
  readonly closure: { readonly reserveAddressDays: number; readonly forwardingDays: number };
}

/** Prices are our own product decisions (A02); the catalog is data, not processor state. */
export const PLAN_CATALOG: Readonly<Record<string, PlanDefinition>> = {
  personal: {
    id: "personal",
    kind: "personal",
    monthlyCents: 1200,
    annualCents: 9900,
    perSeat: false,
    closure: { reserveAddressDays: 3650, forwardingDays: 3650 },
  },
  family: {
    id: "family",
    kind: "family",
    monthlyCents: 2400,
    annualCents: 19900,
    perSeat: false,
    closure: { reserveAddressDays: 3650, forwardingDays: 3650 },
  },
  domain: {
    id: "domain",
    kind: "domain",
    monthlyCents: 1200,
    annualCents: 12000,
    perSeat: true,
    closure: { reserveAddressDays: 365, forwardingDays: 365 },
  },
  "short-address": {
    id: "short-address",
    kind: "personal",
    monthlyCents: 0,
    annualCents: 35000,
    perSeat: false,
    closure: { reserveAddressDays: 3650, forwardingDays: 3650 },
  },
};

/** Closure terms for accounts without a paid plan (trial or lapsed). */
export const UNPAID_CLOSURE = { reserveAddressDays: 90, forwardingDays: 0 } as const;

export const TRIAL_DAYS = 14;
/** Service continues this long after a lapse (past due, expiry) before scopes drop to read-only. */
export const ENTITLEMENT_GRACE_MS = 14 * 86_400_000;
/** Local parts at or below this length are premium (configurable short-address pricing, A02). */
export const SHORT_ADDRESS_MAX_LOCAL = 2;
export const REFERRAL_CREDIT_CENTS = 1000;
export const CHECKOUT_TTL_MS = 60 * 60_000;

export const isShortAddress = (address: string): boolean => {
  const local = normalizeAddress(address).split("@")[0] ?? "";
  return local.length > 0 && local.length <= SHORT_ADDRESS_MAX_LOCAL;
};

export type EntitlementState = "entitled" | "grace" | "lapsed";

/**
 * Evaluate service state. Accounts without an entitlement row predate billing and are treated as
 * entitled (grandfathered); new accounts start a trial at provisioning.
 */
export const entitlementState = (
  e: EntitlementRecord | null,
  now: number,
  graceMs = ENTITLEMENT_GRACE_MS,
): EntitlementState => {
  if (!e) return "entitled";
  const withinGrace = (since: number): EntitlementState =>
    since + graceMs > now ? "grace" : "lapsed";
  const byDeadline = (deadline: number | null): EntitlementState => {
    if (deadline === null) return "lapsed";
    if (deadline > now) return "entitled";
    return withinGrace(deadline);
  };
  switch (e.status) {
    case "trialing":
      return byDeadline(e.trial_ends_at);
    case "active":
      return e.period_end === null ? "entitled" : byDeadline(e.period_end);
    case "past_due":
      return e.period_end === null ? "grace" : withinGrace(e.period_end);
    case "cancelled":
      return byDeadline(e.period_end);
    case "expired":
      return withinGrace(e.updated_at);
  }
};

export interface CheckoutRequest {
  readonly sessionId: string;
  readonly purpose: "subscription" | "plan-change" | "short-address";
  readonly plan: string;
  readonly interval: PlanInterval;
  readonly seats: number;
  readonly amountCents: number;
  readonly orgId: string | null;
  readonly address: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/** Provider-agnostic processor boundary. The webhook remains the source of truth. */
export interface BillingProvider {
  createCheckout(
    request: CheckoutRequest,
  ): Promise<{ readonly providerSessionId: string; readonly url: string }>;
  changePlan(input: {
    readonly orgId: string;
    readonly plan: string;
    readonly interval: PlanInterval;
    readonly seats: number;
  }): Promise<void>;
  cancel(input: { readonly orgId: string; readonly atPeriodEnd: boolean }): Promise<void>;
}

/** Generic HTTPS processor adapter (`BILLING_CHECKOUT_URL` + `BILLING_API_KEY`). */
export const httpBillingProvider = (
  endpoint: string,
  apiKey: string,
  fetchFn: typeof fetch,
): BillingProvider => {
  const call = async (action: string, body: unknown) => {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ action, ...(body as object) }),
    });
    if (!response.ok) throw new Error(`billing provider ${action} failed: ${response.status}`);
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  };
  return {
    createCheckout: async (request) => {
      const r = await call("checkout.create", request);
      if (typeof r.id !== "string" || typeof r.url !== "string")
        throw new Error("billing provider returned no session");
      return { providerSessionId: r.id, url: r.url };
    },
    changePlan: async (input) => void (await call("subscription.change", input)),
    cancel: async (input) => void (await call("subscription.cancel", input)),
  };
};

const priceFor = (plan: PlanDefinition, interval: PlanInterval, seats: number): number =>
  (interval === "monthly" ? plan.monthlyCents : plan.annualCents) *
  (plan.perSeat ? Math.max(1, seats) : 1);

/**
 * A plan must be bought for an organization of its own kind, and only per-seat plans are priced
 * per seat: otherwise a flat plan could be checked out with many seats (and a domain org could
 * buy a personal plan), and the processor event would grant seats that were never priced.
 */
const planSeatsFor = (
  plan: PlanDefinition,
  orgKind: string | undefined,
  requestedSeats: number,
): number => {
  if (orgKind === undefined) return reject("not_found", "organization");
  if (plan.kind !== orgKind)
    return reject("bad_request", `the ${plan.id} plan is not available for a ${orgKind} account`);
  const seats = Math.max(1, Math.floor(requestedSeats));
  if (!plan.perSeat && seats > 1)
    return reject("bad_request", `the ${plan.id} plan is not priced per seat`);
  return seats;
};

export class ControlCommerce {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    readonly provider: BillingProvider | null,
    /** SESSION_KEY: a plain secret (version 1) or a `v2:<key>,v1:<key>` ring. */
    secret: string | SecretRing,
  ) {
    this.secrets = parseSecretRing(secret);
  }

  private readonly secrets: SecretRing;

  private ledger(
    orgId: string,
    kind: string,
    cents: number,
    reason: string,
    actorId: string | null,
    providerEventId: string | null = null,
  ): D1StatementLike {
    return q(
      this.db,
      "INSERT INTO billing_ledger (id, org_id, kind, amount_cents, reason, provider_event_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      this.clock.id("led"),
      orgId,
      kind,
      cents,
      reason,
      providerEventId,
      actorId,
      this.clock.now(),
    );
  }

  private async orgKind(orgId: string): Promise<string | undefined> {
    const row = await guardD1("organization", () =>
      q(primary(this.db), "SELECT kind FROM organizations WHERE id = ?", orgId).first<{
        kind: string;
      }>(),
    );
    return row?.kind;
  }

  private requireProvider(): BillingProvider {
    return this.provider ?? reject("unavailable", "billing processor not configured");
  }

  /**
   * HMAC over the session ID; the signed return URL lets the browser poll status, nothing more.
   * Made under the current SESSION_KEY version and tagged `v<n>.` unless that is version 1 (so
   * v1 signatures keep the pre-ring form); `version` picks another ring version to verify with.
   */
  async returnSignature(
    sessionId: string,
    version: number = this.secrets.current,
  ): Promise<string> {
    const mac = toHex(
      await hmacSha256(
        secretFor(this.secrets, version, "checkout-return"),
        `checkout-return:${sessionId}`,
      ),
    );
    return version === 1 ? mac : tagVersion(version, mac);
  }

  async createCheckout(input: {
    readonly purpose: "subscription" | "plan-change" | "short-address";
    readonly plan: string;
    readonly interval: PlanInterval;
    readonly seats: number;
    readonly orgId: string | null;
    readonly userId: string | null;
    readonly address?: string;
    readonly referralCode?: string;
    readonly returnUrl: string;
  }): Promise<{ readonly sessionId: string; readonly url: string }> {
    const plan = PLAN_CATALOG[input.plan] ?? reject("bad_request", "unknown plan");
    const address = input.address ? normalizeAddress(input.address) : null;
    if (input.purpose === "short-address") {
      if (plan.id !== "short-address")
        reject("bad_request", "short-address checkout requires the short-address plan");
      if (!input.address || !isShortAddress(input.address))
        reject("bad_request", "not a short address");
      const taken = await guardD1("address", () =>
        q(
          primary(this.db),
          "SELECT 1 AS t FROM address_routes WHERE address = ? UNION SELECT 1 FROM address_reservations WHERE address = ?",
          address,
          address,
        ).first(),
      );
      if (taken) reject("conflict", "address unavailable");
    } else if (!input.orgId) {
      reject("bad_request", "organization required");
    } else if (plan.id === "short-address") {
      reject("bad_request", "short addresses are purchased separately");
    }
    const seats =
      input.purpose === "short-address"
        ? 1
        : planSeatsFor(plan, await this.orgKind(input.orgId!), input.seats);
    const provider = this.requireProvider();
    const sessionId = this.clock.id("chk");
    const now = this.clock.now();
    const sig = await this.returnSignature(sessionId);
    const back = (state: string) =>
      `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}checkout=${encodeURIComponent(sessionId)}&sig=${sig}&state=${state}`;
    await q(
      this.db,
      "INSERT INTO checkout_sessions (id, org_id, user_id, purpose, plan, interval, seats, address, referral_code, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      sessionId,
      input.orgId,
      input.userId,
      input.purpose,
      plan.id,
      input.interval,
      seats,
      address,
      input.referralCode ?? null,
      now,
      now + CHECKOUT_TTL_MS,
    ).run();
    const created = await provider.createCheckout({
      sessionId,
      purpose: input.purpose,
      plan: plan.id,
      interval: input.interval,
      seats,
      amountCents: priceFor(plan, input.interval, seats),
      orgId: input.orgId,
      address,
      successUrl: back("success"),
      cancelUrl: back("cancel"),
    });
    await q(
      this.db,
      "UPDATE checkout_sessions SET provider_session_id = ? WHERE id = ?",
      created.providerSessionId,
      sessionId,
    ).run();
    return { sessionId, url: created.url };
  }

  /** Status for a signed return: completion is recorded only by the processor webhook. */
  async checkoutStatus(
    sessionId: string,
    signature: string,
  ): Promise<{ readonly status: string; readonly purpose: string }> {
    if (
      !timingSafeEqual(
        await this.returnSignature(sessionId, untagVersion(signature).version),
        signature,
      )
    )
      return reject("forbidden", "invalid checkout signature");
    const row = await q(
      primary(this.db),
      "SELECT status, purpose, expires_at FROM checkout_sessions WHERE id = ?",
      sessionId,
    ).first<{ status: string; purpose: string; expires_at: number }>();
    if (!row) return reject("not_found", "checkout");
    const status =
      row.status === "open" && row.expires_at < this.clock.now() ? "expired" : row.status;
    return { status, purpose: row.purpose };
  }

  /** Statements applied atomically with a signed `checkout.completed` webhook event. */
  completeCheckoutStatements(sessionId: string, providerEventId: string): Array<D1StatementLike> {
    return [
      q(
        this.db,
        "UPDATE checkout_sessions SET status = 'completed', completed_at = ?, provider_session_id = COALESCE(provider_session_id, ?) WHERE id = ? AND status = 'open'",
        this.clock.now(),
        providerEventId,
        sessionId,
      ),
    ];
  }

  /** A short address may be provisioned only with a completed, unexpired short-address checkout. */
  async shortAddressPaid(address: string, sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false;
    const row = await q(
      primary(this.db),
      "SELECT address, status, purpose FROM checkout_sessions WHERE id = ?",
      sessionId,
    ).first<{ address: string | null; status: string; purpose: string }>();
    return (
      row?.purpose === "short-address" &&
      row.status === "completed" &&
      row.address === normalizeAddress(address)
    );
  }

  async requestPlanChange(
    orgId: string,
    actorId: string,
    input: { readonly plan: string; readonly interval: PlanInterval; readonly seats: number },
  ): Promise<{ readonly requested: true }> {
    const plan = PLAN_CATALOG[input.plan] ?? reject("bad_request", "unknown plan");
    if (plan.id === "short-address")
      reject("bad_request", "short addresses are purchased separately");
    const seats = planSeatsFor(plan, await this.orgKind(orgId), input.seats);
    await this.requireProvider().changePlan({
      orgId,
      plan: plan.id,
      interval: input.interval,
      seats,
    });
    await this.db.batch([
      this.ledger(
        orgId,
        "plan-change-requested",
        0,
        `${plan.id}/${input.interval}/${seats}`,
        actorId,
      ),
    ]);
    return { requested: true };
  }

  async requestCancel(
    orgId: string,
    actorId: string,
    atPeriodEnd: boolean,
  ): Promise<{ readonly requested: true }> {
    await this.requireProvider().cancel({ orgId, atPeriodEnd });
    await this.db.batch([
      this.ledger(
        orgId,
        "cancel-requested",
        0,
        atPeriodEnd ? "at-period-end" : "immediate",
        actorId,
      ),
      q(
        this.db,
        "UPDATE entitlements SET cancel_at_period_end = ? WHERE org_id = ?",
        atPeriodEnd ? 1 : 0,
        orgId,
      ),
    ]);
    return { requested: true };
  }

  /** Operator goodwill credit or recorded refund (A02). */
  async grantCredit(
    orgId: string,
    actorId: string,
    cents: number,
    reason: "goodwill" | "refund",
  ): Promise<void> {
    if (!Number.isInteger(cents) || cents <= 0 || cents > 1_000_000)
      reject("bad_request", "invalid amount");
    await this.db.batch([
      this.ledger(orgId, reason === "refund" ? "refund" : "credit", cents, reason, actorId),
      q(
        this.db,
        "UPDATE entitlements SET credits_cents = credits_cents + ?, updated_at = ? WHERE org_id = ?",
        reason === "refund" ? 0 : cents,
        this.clock.now(),
        orgId,
      ),
    ]);
  }

  async ledgerFor(orgId: string): Promise<
    ReadonlyArray<{
      readonly kind: string;
      readonly amountCents: number;
      readonly reason: string;
      readonly createdAt: number;
    }>
  > {
    const rows = await q(
      primary(this.db),
      "SELECT kind, amount_cents, reason, created_at FROM billing_ledger WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT 200",
      orgId,
    ).all<{ kind: string; amount_cents: number; reason: string; created_at: number }>();
    return rows.results.map((r) => ({
      kind: r.kind,
      amountCents: Number(r.amount_cents),
      reason: r.reason,
      createdAt: Number(r.created_at),
    }));
  }

  // ---- referrals (A02) ----

  async referralCode(userId: string): Promise<string> {
    const existing = await q(
      primary(this.db),
      "SELECT code FROM referral_codes WHERE owner_user_id = ? AND disabled_at IS NULL",
      userId,
    ).first<{ code: string }>();
    if (existing) return existing.code;
    const code = base32Encode(randomBytes(5)).slice(0, 8);
    await q(
      this.db,
      "INSERT INTO referral_codes (code, owner_user_id, created_at) VALUES (?, ?, ?)",
      code,
      userId,
      this.clock.now(),
    ).run();
    return code;
  }

  /** Record a referral at signup. Self-referral and double redemption are refused silently. */
  async redeemReferral(userId: string, code: string): Promise<boolean> {
    const normalized = code.trim().toUpperCase();
    const c = await q(
      primary(this.db),
      "SELECT owner_user_id FROM referral_codes WHERE code = ? AND disabled_at IS NULL",
      normalized,
    ).first<{ owner_user_id: string }>();
    if (!c || c.owner_user_id === userId) return false;
    try {
      await q(
        this.db,
        "INSERT INTO referral_redemptions (user_id, code, redeemed_at) VALUES (?, ?, ?)",
        userId,
        normalized,
        this.clock.now(),
      ).run();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * On an org's first paid activation, credit both the referee and the referrer once. Returns
   * statements to commit atomically with the webhook event.
   */
  async referralCreditStatements(
    orgId: string,
    providerEventId: string,
  ): Promise<Array<D1StatementLike>> {
    const db = primary(this.db);
    const r = await q(
      db,
      `SELECT rr.user_id, rc.owner_user_id AS referrer FROM memberships m JOIN referral_redemptions rr ON rr.user_id = m.user_id
       JOIN referral_codes rc ON rc.code = rr.code WHERE m.org_id = ? AND m.role = 'owner' AND rr.credited_at IS NULL LIMIT 1`,
      orgId,
    ).first<{ user_id: string; referrer: string }>();
    if (!r) return [];
    const referrerOrg = await q(
      db,
      "SELECT o.id FROM organizations o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? AND o.kind = 'personal' LIMIT 1",
      r.referrer,
    ).first<{ id: string }>();
    const now = this.clock.now();
    // The redemption compare-and-set gates every credit: two concurrent activations (or a
    // replayed event) both read `credited_at IS NULL`, but only the batch whose CAS changes the
    // row writes the referee ledger row, and every other credit is keyed to that row existing.
    const refereeLedgerId = this.clock.id("led");
    const credited = "EXISTS (SELECT 1 FROM billing_ledger WHERE id = ?)";
    const ledgerIf = (ledgerOrgId: string, reason: string, id: string, afterCas: boolean) =>
      q(
        this.db,
        `INSERT INTO billing_ledger (id, org_id, kind, amount_cents, reason, provider_event_id, actor_id, created_at) SELECT ?, ?, 'referral-credit', ?, ?, ?, NULL, ? WHERE ${afterCas ? "changes() > 0" : credited}`,
        id,
        ledgerOrgId,
        REFERRAL_CREDIT_CENTS,
        reason,
        providerEventId,
        now,
        ...(afterCas ? [] : [refereeLedgerId]),
      );
    const creditIf = (creditOrgId: string) =>
      q(
        this.db,
        `UPDATE entitlements SET credits_cents = credits_cents + ? WHERE org_id = ? AND ${credited}`,
        REFERRAL_CREDIT_CENTS,
        creditOrgId,
        refereeLedgerId,
      );
    const out: Array<D1StatementLike> = [
      q(
        this.db,
        "UPDATE referral_redemptions SET credited_at = ? WHERE user_id = ? AND credited_at IS NULL",
        now,
        r.user_id,
      ),
      ledgerIf(orgId, "referee", refereeLedgerId, true),
      creditIf(orgId),
    ];
    if (referrerOrg) {
      out.push(ledgerIf(referrerOrg.id, "referrer", this.clock.id("led"), false));
      out.push(creditIf(referrerOrg.id));
    }
    return out;
  }

  /** Closure terms (A04) derived from the account's plan and current entitlement. */
  async closureTerms(userId: string): Promise<{
    readonly plan: string | null;
    readonly reserveAddressDays: number;
    readonly forwardingDays: number;
  }> {
    const db = primary(this.db);
    const row = await q(
      db,
      `SELECT e.* FROM organizations o JOIN memberships m ON m.org_id = o.id JOIN entitlements e ON e.org_id = o.id
       WHERE m.user_id = ? AND o.kind = 'personal' LIMIT 1`,
      userId,
    ).first<EntitlementRecord>();
    const now = this.clock.now();
    const paid =
      row !== null && row.status !== "trialing" && entitlementState(row, now) !== "lapsed";
    const plan = paid ? PLAN_CATALOG[row!.plan] : undefined;
    const terms = plan ? plan.closure : UNPAID_CLOSURE;
    const shortAddress =
      row?.short_address === 1 ? PLAN_CATALOG["short-address"]!.closure : undefined;
    return {
      plan: paid ? row!.plan : null,
      reserveAddressDays: Math.max(terms.reserveAddressDays, shortAddress?.reserveAddressDays ?? 0),
      forwardingDays: Math.max(terms.forwardingDays, shortAddress?.forwardingDays ?? 0),
    };
  }
}
