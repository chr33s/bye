import { describe, expect, it } from "vitest";
import {
  type BillingProvider,
  ControlAuth,
  ControlBilling,
  ControlCommerce,
  ControlDirectory,
  ControlOrganizations,
  ControlSharedRegistry,
  ControlSupport,
  entitlementState,
  isShortAddress,
  SendingPolicy,
  signBillingPayload,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const SECRET = "whsec_test_0123456789abcdef0123456789";
const DAY = 86_400_000;
const code = (e: unknown) => (e instanceof Rejection ? e.code : String(e));

const fakeProvider = () => {
  const calls: Array<{ op: string; input: unknown }> = [];
  const provider: BillingProvider = {
    createCheckout: async (request) => {
      calls.push({ op: "checkout", input: request });
      return {
        providerSessionId: `ps_${request.sessionId}`,
        url: `https://pay.test/c/${request.sessionId}`,
      };
    },
    changePlan: async (input) => void calls.push({ op: "change", input }),
    cancel: async (input) => void calls.push({ op: "cancel", input }),
  };
  return { provider, calls };
};

const setup = async (withProvider = true) => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const { provider, calls } = fakeProvider();
  const commerce = new ControlCommerce(d1, clock, withProvider ? provider : null, "secret");
  const billing = new ControlBilling(d1, clock, commerce);
  const dir = new ControlDirectory(d1, clock);
  const auth = new ControlAuth(d1, clock, {
    rp: { rpId: "bye.test", origins: [], requireUserVerification: true },
    totpKeys: { current: 1, keys: { 1: new Uint8Array(32) } },
    recoveryPepper: "p",
  });
  const alice = await dir.provisionPersonalAccount({
    address: "alice@bye.test",
    displayName: "Alice",
  });
  const send = async (event: Record<string, unknown>) => {
    const body = JSON.stringify({ created: clock.now(), ...event });
    return billing.handleWebhook(body, await signBillingPayload(body, SECRET, clock.now()), SECRET);
  };
  return { d1, clock, commerce, billing, dir, auth, alice, calls, send };
};

describe("[A02] commerce: checkout, plan changes, referrals, short addresses", () => {
  it("checkout sessions are created through the provider; only the signed webhook completes them", async () => {
    const { commerce, alice, calls, send } = await setup();
    const c = await commerce.createCheckout({
      purpose: "subscription",
      plan: "personal",
      interval: "annual",
      seats: 1,
      orgId: alice.organizationId,
      userId: alice.userId,
      returnUrl: "https://app.bye.test/settings/billing",
    });
    expect(c.url).toContain("pay.test");
    const req = calls[0]!.input as { successUrl: string; amountCents: number };
    expect(req.amountCents).toBeGreaterThan(0);
    const sig = new URL(req.successUrl).searchParams.get("sig")!;
    expect(await commerce.checkoutStatus(c.sessionId, sig)).toEqual({
      status: "open",
      purpose: "subscription",
    });
    expect(code(await commerce.checkoutStatus(c.sessionId, "forged").catch((e) => e))).toBe(
      "forbidden",
    );
    await send({
      id: "evt_c1",
      orgId: alice.organizationId,
      type: "checkout.completed",
      sessionId: c.sessionId,
    });
    expect((await commerce.checkoutStatus(c.sessionId, sig)).status).toBe("completed");
  });

  it("short addresses require a completed short-address checkout", async () => {
    const { commerce, send } = await setup();
    expect(isShortAddress("ab@bye.test")).toBe(true);
    expect(isShortAddress("new@bye.test")).toBe(false);
    expect(
      code(
        await commerce
          .createCheckout({
            purpose: "short-address",
            plan: "personal",
            interval: "annual",
            seats: 1,
            orgId: null,
            userId: null,
            address: "ab@bye.test",
            returnUrl: "https://x",
          })
          .catch((e) => e),
      ),
    ).toBe("bad_request");
    const c = await commerce.createCheckout({
      purpose: "short-address",
      plan: "short-address",
      interval: "annual",
      seats: 1,
      orgId: null,
      userId: null,
      address: "ab@bye.test",
      returnUrl: "https://x",
    });
    expect(await commerce.shortAddressPaid("ab@bye.test", c.sessionId)).toBe(false);
    await send({ id: "evt_s1", orgId: "", type: "checkout.completed", sessionId: c.sessionId });
    expect(await commerce.shortAddressPaid("ab@bye.test", c.sessionId)).toBe(true);
    expect(await commerce.shortAddressPaid("cd@bye.test", c.sessionId)).toBe(false);
    expect(await commerce.shortAddressPaid("ab@bye.test", undefined)).toBe(false);
    // Taken addresses cannot be bought.
    expect(
      code(
        await commerce
          .createCheckout({
            purpose: "short-address",
            plan: "short-address",
            interval: "annual",
            seats: 1,
            orgId: null,
            userId: null,
            address: "alice@bye.test".replace("alice", "al"),
            returnUrl: "x",
          })
          .then(
            () => "ok",
            (e) => e,
          ),
      ),
    ).toBe("ok");
  });

  it("checkout and plan change bind the plan to the org's kind and price seats only per seat", async () => {
    const { commerce, alice, calls, d1, clock } = await setup();
    const orgs = new ControlOrganizations(d1, clock);
    const domainOrg = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });
    const checkout = (orgId: string, plan: string, seats: number) =>
      commerce
        .createCheckout({
          purpose: "subscription",
          plan,
          interval: "annual",
          seats,
          orgId,
          userId: alice.userId,
          returnUrl: "https://x",
        })
        .then(
          () => "ok",
          (e) => code(e),
        );
    const change = (orgId: string, plan: string, seats: number) =>
      commerce.requestPlanChange(orgId, alice.userId, { plan, interval: "annual", seats }).then(
        () => "ok",
        (e) => code(e),
      );
    // A domain org cannot buy the flat personal plan with 1000 seats (or at all).
    expect(await checkout(domainOrg, "personal", 1000)).toBe("bad_request");
    expect(await checkout(domainOrg, "family", 1)).toBe("bad_request");
    expect(await change(domainOrg, "personal", 1000)).toBe("bad_request");
    // A flat plan on its own kind is still refused extra seats.
    expect(await checkout(alice.organizationId, "personal", 1000)).toBe("bad_request");
    expect(await change(alice.organizationId, "personal", 5)).toBe("bad_request");
    expect(await checkout(alice.organizationId, "domain", 5)).toBe("bad_request");
    expect(await checkout(alice.organizationId, "short-address", 1)).toBe("bad_request");
    expect(await checkout("org_missing", "domain", 5)).toBe("not_found");
    expect(calls).toEqual([]);
    // The matching per-seat plan prices every seat.
    expect(await checkout(domainOrg, "domain", 7)).toBe("ok");
    expect(calls.at(-1)!.input).toMatchObject({ plan: "domain", seats: 7, amountCents: 7 * 12000 });
    expect(await change(domainOrg, "domain", 7)).toBe("ok");
    expect(calls.at(-1)!.input).toMatchObject({ plan: "domain", seats: 7 });
  });

  it("plan change and cancel go to the provider and are recorded; no provider → unavailable", async () => {
    const { commerce, alice, calls, d1 } = await setup();
    await commerce.requestPlanChange(alice.organizationId, alice.userId, {
      plan: "personal",
      interval: "monthly",
      seats: 1,
    });
    await commerce.requestCancel(alice.organizationId, alice.userId, true);
    expect(calls.map((c) => c.op)).toEqual(["change", "cancel"]);
    expect((await commerce.ledgerFor(alice.organizationId)).map((l) => l.kind).sort()).toEqual([
      "cancel-requested",
      "plan-change-requested",
    ]);
    expect(
      (
        await d1
          .prepare("SELECT cancel_at_period_end AS c FROM entitlements WHERE org_id = ?")
          .bind(alice.organizationId)
          .first<{ c: number }>()
      )?.c,
    ).toBe(1);
    const none = await setup(false);
    expect(
      code(
        await none.commerce
          .requestCancel(none.alice.organizationId, none.alice.userId, true)
          .catch((e) => e),
      ),
    ).toBe("unavailable");
  });

  it("referral credits both sides once on the referee's first paid activation", async () => {
    const { commerce, dir, alice, send, billing } = await setup();
    const refCode = await commerce.referralCode(alice.userId);
    expect(await commerce.referralCode(alice.userId)).toBe(refCode);
    const bob = await dir.provisionPersonalAccount({ address: "bob@bye.test", displayName: "Bob" });
    expect(await commerce.redeemReferral(alice.userId, refCode)).toBe(false); // self-referral
    expect(await commerce.redeemReferral(bob.userId, refCode.toLowerCase())).toBe(true);
    expect(await commerce.redeemReferral(bob.userId, refCode)).toBe(false); // once
    await send({
      id: "evt_a1",
      orgId: bob.organizationId,
      type: "subscription.activated",
      plan: "personal",
      interval: "annual",
      seats: 1,
      periodEnd: Date.now() + 400 * DAY,
    });
    await send({
      id: "evt_a2",
      orgId: bob.organizationId,
      type: "subscription.renewed",
      periodEnd: Date.now() + 800 * DAY,
    });
    expect((await billing.entitlement(bob.organizationId))?.credits_cents).toBe(1000);
    expect((await billing.entitlement(alice.organizationId))?.credits_cents).toBe(1000);
  });

  it("closure terms derive from the entitlement; refunds and goodwill credits are ledgered", async () => {
    const { commerce, alice, send, clock } = await setup();
    // Trial accounts get the unpaid terms.
    const trial = await commerce.closureTerms(alice.userId);
    expect(trial.plan).toBeNull();
    await send({
      id: "evt_p1",
      orgId: alice.organizationId,
      type: "subscription.activated",
      plan: "personal",
      interval: "annual",
      seats: 1,
      periodEnd: clock.now() + 365 * DAY,
    });
    const paid = await commerce.closureTerms(alice.userId);
    expect(paid.plan).toBe("personal");
    expect(paid.forwardingDays).toBeGreaterThan(trial.forwardingDays);
    await commerce.grantCredit(alice.organizationId, "op", 500, "goodwill");
    expect(
      code(await commerce.grantCredit(alice.organizationId, "op", -5, "goodwill").catch((e) => e)),
    ).toBe("bad_request");
    await send({ id: "evt_r1", orgId: alice.organizationId, type: "refund.issued", cents: 1200 });
    expect((await commerce.ledgerFor(alice.organizationId)).map((l) => l.kind)).toEqual(
      expect.arrayContaining(["credit", "refund"]),
    );
  });
});

describe("[A01/A02] entitlement enforcement in principal construction", () => {
  it("a lapsed account keeps read-only scopes; paying restores full scopes", async () => {
    const { auth, alice, clock, send } = await setup();
    const { token } = await auth.issueSession(alice.userId, "laptop");
    const full = await auth.principal(await auth.authenticate(token));
    expect(full.scopes).toContain("send");
    clock.advance(15 * DAY + 15 * DAY); // trial + grace
    const { token: t2 } = await auth.issueSession(alice.userId, "laptop");
    const lapsed = await auth.principal(await auth.authenticate(t2));
    expect(lapsed.scopes).toEqual(["read"]);
    await send({
      id: "evt_pay",
      orgId: alice.organizationId,
      type: "subscription.activated",
      plan: "personal",
      interval: "annual",
      seats: 1,
      periodEnd: clock.now() + 365 * DAY,
    });
    expect((await auth.principal(await auth.authenticate(t2))).scopes).toContain("send");
  });

  it("entitlementState: trial, grace, lapsed", () => {
    const now = Date.UTC(2026, 0, 1);
    const base = {
      org_id: "o",
      plan: "personal",
      interval: "annual" as const,
      seats: 1,
      credits_cents: 0,
      short_address: 0,
      updated_at: now,
    };
    expect(
      entitlementState(
        { ...base, status: "trialing", trial_ends_at: now + DAY, period_end: null },
        now,
      ),
    ).toBe("entitled");
    expect(
      entitlementState(
        { ...base, status: "past_due", trial_ends_at: null, period_end: now - DAY },
        now,
      ),
    ).toBe("grace");
    expect(
      entitlementState(
        { ...base, status: "active", trial_ends_at: null, period_end: now - 30 * DAY },
        now,
      ),
    ).toBe("lapsed");
    expect(entitlementState(null, now)).toBe("entitled");
  });
});

describe("[A03] security settings", () => {
  it("status, TOTP disable, and the only credential cannot be removed", async () => {
    const { auth, alice, d1, clock } = await setup();
    expect(await auth.securityStatus(alice.userId)).toEqual({
      passkeys: 0,
      totp: "none",
      recoveryCodesRemaining: 0,
    });
    await auth.enrollTotp(alice.userId);
    expect((await auth.securityStatus(alice.userId)).totp).toBe("pending");
    await auth.generateRecoveryCodes(alice.userId, 4);
    expect((await auth.securityStatus(alice.userId)).recoveryCodesRemaining).toBe(4);
    expect(await auth.disableTotp(alice.userId)).toBe(true);
    expect(await auth.disableTotp(alice.userId)).toBe(false);
    await d1
      .prepare(
        "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, sign_count, label, created_at) VALUES ('cred1', ?, '{}', 0, 'Laptop', ?)",
      )
      .bind(alice.userId, clock.now())
      .run();
    expect((await auth.listPasskeys(alice.userId)).map((p) => p.label)).toEqual(["Laptop"]);
    // Recovery codes are the only non-passkey sign-in path; once they're used up the last passkey stays.
    await d1
      .prepare("UPDATE recovery_codes SET used_at = 1 WHERE user_id = ?")
      .bind(alice.userId)
      .run();
    expect(code(await auth.removePasskey(alice.userId, "cred1").catch((e) => e))).toBe("conflict");
    expect(code(await auth.removePasskey(alice.userId, "nope").catch((e) => e))).toBe("not_found");
    await d1
      .prepare(
        "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, sign_count, label, created_at) VALUES ('cred2', ?, '{}', 0, 'Phone', ?)",
      )
      .bind(alice.userId, clock.now())
      .run();
    await auth.removePasskey(alice.userId, "cred1");
    expect((await auth.listPasskeys(alice.userId)).map((p) => p.id)).toEqual(["cred2"]);
  });

  it("confirmed TOTP is not a sign-in fallback; an unused recovery code is", async () => {
    const { auth, alice, d1, clock } = await setup();
    await d1
      .prepare(
        "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, sign_count, label, created_at) VALUES ('only', ?, '{}', 0, 'Laptop', ?)",
      )
      .bind(alice.userId, clock.now())
      .run();
    await auth.enrollTotp(alice.userId);
    await d1
      .prepare("UPDATE totp_secrets SET confirmed_at = 1 WHERE user_id = ?")
      .bind(alice.userId)
      .run();
    expect(code(await auth.removePasskey(alice.userId, "only").catch((e) => e))).toBe("conflict");
    await auth.generateRecoveryCodes(alice.userId, 2);
    await auth.removePasskey(alice.userId, "only");
    expect(await auth.listPasskeys(alice.userId)).toEqual([]);
  });

  it("session rotation carries the original step-up time rather than resetting it", async () => {
    const { auth, alice, clock } = await setup();
    const { token, session } = await auth.issueSession(alice.userId, "laptop", true);
    const steppedUpAt = session.step_up_at;
    expect(steppedUpAt).toBe(clock.now());
    // Advance so a rotation that re-stamped step_up_at with "now" would be detected.
    clock.advance(60_000);
    const rotated = await auth.rotateSession(token);
    expect(rotated.session.step_up_at).toBe(steppedUpAt);
    const cred = await auth.authenticate(rotated.token);
    expect(cred.kind).toBe("session");
    expect(cred.kind === "session" ? cred.session.step_up_at : undefined).toBe(steppedUpAt);
  });
});

describe("[§10] support access: user-granted, time-boxed, read-only, audited", () => {
  it("operator sessions exist only under an active grant and end with it", async () => {
    const { d1, clock, auth, alice } = await setup();
    const support = new ControlSupport(d1, clock);
    expect(code(await support.grant(alice.userId, "help", 100).catch((e) => e))).toBe(
      "bad_request",
    );
    const g = await support.grant(alice.userId, "Missing mail", 2);
    expect(code(await support.openSession("op_1", "sup_missing").catch((e) => e))).toBe(
      "forbidden",
    );
    const s = await support.openSession("op_1", g.id);
    const cred = await auth.authenticate(s.token);
    const p = await auth.principal(cred);
    expect(p.kind).toBe("agent");
    expect(p.scopes).toEqual(["read"]);
    expect(p.userId).toBe(alice.userId);
    await support.revoke(alice.userId, g.id);
    expect(code(await auth.authenticate(s.token).catch((e) => e))).toBe("unauthenticated");
    const audit = await d1
      .prepare(
        "SELECT action FROM audit_log WHERE actor_id = ? AND action LIKE 'support.%' ORDER BY created_at",
      )
      .bind(alice.userId)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "support.grant",
        "support.session.open",
        "support.access",
        "support.revoke",
      ]),
    );
    // Expiry ends access too.
    const g2 = await support.grant(alice.userId, "again", 1);
    const s2 = await support.openSession("op_1", g2.id);
    clock.advance(2 * 3600_000);
    expect(code(await auth.authenticate(s2.token).catch((e) => e))).toBe("unauthenticated");
  });
});

describe("[§10] sending policy", () => {
  it("ramps new accounts, honours suppressions and suspensions", async () => {
    const { d1, clock, alice } = await setup();
    const policy = new SendingPolicy(d1, clock);
    const ok = await policy.check({
      userId: alice.userId,
      identity: "alice@bye.test",
      recipients: ["a@x.test", "b@x.test"],
    });
    expect(ok).toMatchObject({ allowed: true, remaining: 48 });
    await policy.record({ userId: alice.userId, identity: "alice@bye.test", recipients: 49 });
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test", "b@x.test"],
      }),
    ).toMatchObject({ allowed: false, reason: "budget", scope: "user" });
    clock.advance(2 * DAY);
    await policy.suppress("a@x.test", "manual", "test");
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test", "b@x.test"],
      }),
    ).toMatchObject({ allowed: true, suppressed: ["a@x.test"] });
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test"],
      }),
    ).toMatchObject({ allowed: false, reason: "all-suppressed" });
    expect(code(await policy.suspend("domain", "bye.test", " ", "op").catch((e) => e))).toBe(
      "bad_request",
    );
    await policy.suspend("domain", "bye.test", "phishing report", "op");
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["b@x.test"],
      }),
    ).toMatchObject({ allowed: false, reason: "suspended", scope: "domain" });
    expect(await policy.lift("domain", "bye.test", "op")).toBe(true);
    expect(
      (
        await policy.check({
          userId: alice.userId,
          identity: "alice@bye.test",
          recipients: ["b@x.test"],
        })
      ).allowed,
    ).toBe(true);
  });

  it("complaint rates auto-suspend pending review; a false positive lifts it", async () => {
    const { d1, clock, alice } = await setup();
    const policy = new SendingPolicy(d1, clock);
    await policy.record({ userId: alice.userId, identity: "alice@bye.test", recipients: 100 });
    let suspended = false;
    for (let i = 0; i < 3 && !suspended; i++)
      suspended = (
        await policy.recordOutcome({
          userId: alice.userId,
          identity: "alice@bye.test",
          recipient: `r${i}@x.test`,
          outcome: "complaint",
        })
      ).suspended;
    expect(suspended).toBe(true);
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["z@x.test"],
      }),
    ).toMatchObject({ allowed: false, reason: "suspended", scope: "user" });
    const [signal] = await policy.openSignals();
    expect(signal?.signal).toBe("complaint-rate");
    await policy.reviewSignal(signal!.id, "op", "false-positive");
    expect(await policy.openSignals()).toEqual([]);
    clock.advance(2 * DAY); // outside the new-account daily budget window
    expect(
      (
        await policy.check({
          userId: alice.userId,
          identity: "alice@bye.test",
          recipients: ["z@x.test"],
        })
      ).allowed,
    ).toBe(true);
    // Complained recipients stay suppressed.
    expect(
      (
        await policy.check({
          userId: alice.userId,
          identity: "alice@bye.test",
          recipients: ["r0@x.test", "z@x.test"],
        })
      ).suppressed,
    ).toEqual(["r0@x.test"]);
  });

  it("one-round-trip check keeps the per-scope windows, order and remaining budget", async () => {
    const { d1, clock, alice } = await setup();
    const policy = new SendingPolicy(d1, clock, {
      identityPerDay: 1000,
      domainPerDay: 20_000,
      platformPerHour: 10,
      minVolume: 50,
      maxComplaintRate: 0.003,
      maxBounceRate: 0.08,
    });
    clock.advance(40 * DAY); // established account: 2000/day user budget
    // Nine sends two hours ago count toward the daily scopes but not the platform's hourly window.
    await policy.record({ userId: alice.userId, identity: "alice@bye.test", recipients: 9 });
    clock.advance(2 * 3600_000);
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test", "b@x.test"],
      }),
    ).toMatchObject({ allowed: true, remaining: 8 });
    await policy.record({ userId: alice.userId, identity: "alice@bye.test", recipients: 9 });
    // The hour now holds 9: two more exceeds the platform's hourly 10.
    const over = await policy.check({
      userId: alice.userId,
      identity: "alice@bye.test",
      recipients: ["a@x.test", "b@x.test"],
    });
    expect(over).toMatchObject({ allowed: false, reason: "budget", scope: "platform" });
    expect(over.allowed === false && over.retryAfterMs! > 0 && over.retryAfterMs! <= 3600_000).toBe(
      true,
    );
    // Suspensions are checked first, in scope order (platform before domain).
    await policy.suspend("domain", "bye.test", "abuse", "op");
    await policy.suspend("platform", "*", "incident", "op");
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test"],
      }),
    ).toMatchObject({ allowed: false, reason: "suspended", scope: "platform" });
    // Lifting audits exactly once; a second lift changes nothing.
    expect(await policy.lift("platform", "*", "op")).toBe(true);
    expect(await policy.lift("platform", "*", "op")).toBe(false);
    const lifts = await d1
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sending.lift'")
      .first<{ n: number }>();
    expect(lifts?.n).toBe(1);
  });
});

describe("[O03/O04] shared registry", () => {
  it("records spaces, shared threads (future replies) and extension mailboxes", async () => {
    const { d1, clock, alice } = await setup();
    const orgs = new ControlOrganizations(d1, clock);
    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 3,
    });
    const reg = new ControlSharedRegistry(d1, clock);
    await reg.registerSpace("spc_1", orgId, "team", alice.userId);
    await reg.registerSpace("spc_1", orgId, "team", alice.userId);
    expect(await reg.spaceOrg("spc_1")).toEqual({ orgId, kind: "team" });
    expect((await reg.spacesForOrgs([orgId])).map((s) => s.id)).toEqual(["spc_1"]);
    expect(await reg.spacesForOrgs([])).toEqual([]);
    await reg.registerSharedThread({
      mailboxId: "mbx_1",
      threadId: "thr_1",
      spaceId: "spc_1",
      sharedThreadId: "sth_1",
      includeFuture: true,
    });
    await reg.registerSharedThread({
      mailboxId: "mbx_1",
      threadId: "thr_1",
      spaceId: "spc_1",
      sharedThreadId: "sth_1",
      includeFuture: false,
    });
    // Include-future is sticky (a pre-filter; the space authority keeps the authoritative flag).
    expect(await reg.sharedThreadsFor("mbx_1", "thr_1")).toEqual([
      { spaceId: "spc_1", sharedThreadId: "sth_1", includeFuture: true },
    ]);
    const ext = await orgs.createExtensionMailbox(
      orgId,
      await orgs.verifiedActor(orgId, alice.userId),
      [alice.userId],
    );
    await reg.registerExtension(ext, `ext_${ext}`, "Support@acme.test");
    expect(await reg.extensionFor(ext)).toEqual({
      spaceId: `ext_${ext}`,
      address: "support@acme.test",
    });
    expect(await reg.extensionFor("mbx_1")).toBeNull();
  });

  it("org creation starts a trial entitlement sized to the seat limit; seat limits are bounded", async () => {
    const { d1, clock, alice, dir } = await setup();
    const orgs = new ControlOrganizations(d1, clock);
    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Fam",
      kind: "family",
      seatLimit: 3,
    });
    expect(await orgs.seats(orgId)).toEqual({ limit: 3, used: 1, entitled: 3 });
    expect(
      code(
        await orgs
          .setSeatLimit(orgId, await orgs.verifiedActor(orgId, alice.userId), 5)
          .catch((e) => e),
      ),
    ).toBe("conflict");
    expect(
      code(
        await orgs
          .setSeatLimit(orgId, await orgs.verifiedActor(orgId, alice.userId), 0)
          .catch((e) => e),
      ),
    ).toBe("bad_request");
    expect(
      (await orgs.setSeatLimit(orgId, await orgs.verifiedActor(orgId, alice.userId), 2)).limit,
    ).toBe(2);
    const bob = await dir.provisionPersonalAccount({ address: "bob@bye.test", displayName: "Bob" });
    expect(code(await orgs.verifiedActor(orgId, bob.userId).catch((e) => e))).toBe("forbidden");
    expect((await orgs.organization(orgId, alice.userId)).role).toBe("owner");
  });
});
