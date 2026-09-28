import { describe, expect, it } from "vitest";
import {
  ENTITLEMENT_GRACE_MS,
  type EntitlementRecord,
  type EntitlementState,
  entitlementState,
} from "@bye/platform-cloudflare";

// commerce.ts entitlementState: every status branch and the grace boundaries.

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

const G = ENTITLEMENT_GRACE_MS;

const row = (over: Partial<EntitlementRecord>): EntitlementRecord => ({
  org_id: "org_1",
  plan: "personal",
  interval: "monthly",
  status: "active",
  seats: 1,
  trial_ends_at: null,
  period_end: null,
  credits_cents: 0,
  short_address: 0,
  updated_at: NOW,
  ...over,
});

describe("entitlementState", () => {
  const cases: ReadonlyArray<[string, EntitlementRecord | null, EntitlementState]> = [
    ["no row (grandfathered)", null, "entitled"],
    // trialing
    ["trialing, trial ends later", row({ status: "trialing", trial_ends_at: NOW + 1 }), "entitled"],
    ["trialing, trial ends now", row({ status: "trialing", trial_ends_at: NOW }), "grace"],
    [
      "trialing, lapsed just inside grace",
      row({ status: "trialing", trial_ends_at: NOW - G + 1 }),
      "grace",
    ],
    [
      "trialing, lapsed exactly grace ago",
      row({ status: "trialing", trial_ends_at: NOW - G }),
      "lapsed",
    ],
    ["trialing, null trial end", row({ status: "trialing", trial_ends_at: null }), "lapsed"],
    // active
    ["active, null period end", row({ status: "active", period_end: null }), "entitled"],
    ["active, period ends later", row({ status: "active", period_end: NOW + 1 }), "entitled"],
    ["active, period ended within grace", row({ status: "active", period_end: NOW - 1 }), "grace"],
    ["active, period ended beyond grace", row({ status: "active", period_end: NOW - G }), "lapsed"],
    // past_due: never entitled; grace runs from period end
    ["past_due, null period end", row({ status: "past_due", period_end: null }), "grace"],
    [
      "past_due, period end in the future",
      row({ status: "past_due", period_end: NOW + G }),
      "grace",
    ],
    ["past_due, just inside grace", row({ status: "past_due", period_end: NOW - G + 1 }), "grace"],
    ["past_due, at grace boundary", row({ status: "past_due", period_end: NOW - G }), "lapsed"],
    // cancelled: service runs to period end, then grace
    ["cancelled, period ends later", row({ status: "cancelled", period_end: NOW + 1 }), "entitled"],
    ["cancelled, within grace", row({ status: "cancelled", period_end: NOW - G + 1 }), "grace"],
    ["cancelled, beyond grace", row({ status: "cancelled", period_end: NOW - G }), "lapsed"],
    ["cancelled, null period end", row({ status: "cancelled", period_end: null }), "lapsed"],
    // expired: grace runs from the transition, ignoring period end
    [
      "expired, just now (period end ignored)",
      row({ status: "expired", updated_at: NOW, period_end: NOW + G }),
      "grace",
    ],
    ["expired, just inside grace", row({ status: "expired", updated_at: NOW - G + 1 }), "grace"],
    ["expired, at grace boundary", row({ status: "expired", updated_at: NOW - G }), "lapsed"],
  ];

  it.each(cases)("%s → %s", (_name, record, expected) => {
    expect(entitlementState(record, NOW)).toBe(expected);
  });

  it("honours a custom grace window", () => {
    const r = row({ status: "past_due", period_end: NOW - 10 });
    expect(entitlementState(r, NOW, 11)).toBe("grace");
    expect(entitlementState(r, NOW, 10)).toBe("lapsed");
    expect(entitlementState(r, NOW, 0)).toBe("lapsed");
  });
});
