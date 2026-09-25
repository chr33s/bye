import { describe, expect, it } from "vitest";
import {
  ControlBilling,
  ControlDirectory,
  ControlLifecycle,
  ControlOrganizations,
  signBillingPayload,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

const DAY = 86_400_000;
const SECRET = "whsec_test_0123456789abcdef0123456789";

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const dir = new ControlDirectory(d1, clock);
  const billing = new ControlBilling(d1, clock);
  const account = await dir.provisionPersonalAccount({
    address: "alice@bye.test",
    displayName: "Alice",
  });
  const orgs = new ControlOrganizations(d1, clock);
  const orgId = (await orgs.membership(account.organizationId, account.userId))
    ? account.organizationId
    : "";
  const send = async (event: Record<string, unknown>) => {
    const body = JSON.stringify({ orgId, created: clock.now(), ...event });
    return billing.handleWebhook(body, await signBillingPayload(body, SECRET, clock.now()), SECRET);
  };
  return { d1, clock, dir, billing, account, orgId, send };
};

describe("billing and entitlements", () => {
  it("[A02] trial → paid → seat change → cancel at period end → expiry", async () => {
    const { billing, orgId, clock, send } = await setup();
    // Provisioning starts a 14-day trial; a later processor trial.started event does not extend it.
    expect((await billing.entitlement(orgId))?.status).toBe("trialing");
    expect(await billing.isEntitled(orgId)).toBe(true);
    await send({
      id: "evt_1",
      type: "trial.started",
      plan: "personal",
      trialEndsAt: clock.now() + 60 * 86400_000,
    });
    clock.advance(15 * 86400_000);
    expect(await billing.isEntitled(orgId)).toBe(false);
    await send({
      id: "evt_2",
      type: "subscription.activated",
      plan: "personal",
      interval: "annual",
      seats: 1,
      periodEnd: clock.now() + 365 * 86400_000,
    });
    expect((await billing.entitlement(orgId))?.status).toBe("active");
    await send({ id: "evt_3", type: "subscription.seats_changed", seats: 4 });
    expect((await billing.entitlement(orgId))?.seats).toBe(4);
    await send({ id: "evt_4", type: "subscription.cancelled", atPeriodEnd: true });
    expect(await billing.isEntitled(orgId)).toBe(true);
    clock.advance(366 * 86400_000);
    expect(await billing.isEntitled(orgId)).toBe(false);
  });

  it("[A02] duplicate events are idempotent and credits accumulate once", async () => {
    const { billing, orgId, send } = await setup();
    expect(
      await send({ id: "evt_c", type: "credit.granted", cents: 500, reason: "refund" }),
    ).toEqual({ applied: true, duplicate: false });
    expect(
      await send({ id: "evt_c", type: "credit.granted", cents: 500, reason: "refund" }),
    ).toEqual({ applied: false, duplicate: true });
    expect((await billing.entitlement(orgId))?.credits_cents).toBe(500);
  });

  it("[A02] forged, stale-timestamp and unsigned webhooks are rejected; browser success grants nothing", async () => {
    const { billing, orgId, clock } = await setup();
    const body = JSON.stringify({
      id: "evt_f",
      orgId,
      created: clock.now(),
      type: "subscription.activated",
      plan: "p",
      interval: "monthly",
      seats: 1,
      periodEnd: clock.now() + 1e9,
    });
    await expect(
      billing.handleWebhook(body, await signBillingPayload(body, "wrong", clock.now()), SECRET),
    ).rejects.toThrow("signature");
    await expect(billing.handleWebhook(body, null, SECRET)).rejects.toThrow("signature");
    await expect(
      billing.handleWebhook(
        body,
        await signBillingPayload(body, SECRET, clock.now() - 10 * 60_000),
        SECRET,
      ),
    ).rejects.toThrow("signature");
    expect((await billing.entitlement(orgId))?.status).toBe("trialing");
  });

  it("[A02] out-of-order status events do not regress newer state", async () => {
    const { billing, orgId, clock, send } = await setup();
    const t0 = clock.now();
    clock.advance(1000);
    await send({
      id: "evt_new",
      type: "subscription.activated",
      plan: "p",
      interval: "monthly",
      seats: 1,
      periodEnd: clock.now() + 1e9,
    });
    await send({ id: "evt_old", created: t0, type: "subscription.expired" });
    expect((await billing.entitlement(orgId))?.status).toBe("active");
  });

  it("[A04] closure is distinct from cancellation; reservation and verified forwarding survive the mailbox", async () => {
    const { d1, clock, dir, account } = await setup();
    const lifecycle = new ControlLifecycle(d1, clock, "secret");
    const { reserved } = await lifecycle.closeAccount(account.userId, {
      reserveAddressDays: 365,
      forwardingDays: 180,
    });
    expect(reserved).toEqual(["alice@bye.test"]);
    expect(await dir.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "Rejected",
      reason: "closed",
    });
    await expect(
      dir.provisionPersonalAccount({ address: "alice@bye.test", displayName: "Squatter" }),
    ).rejects.toThrow();
    await expect(dir.addAlias(account.mailboxId, "alice@bye.test")).rejects.toThrow();

    const { verificationToken } = await lifecycle.requestForwarding(
      account.userId,
      "alice@bye.test",
      "alice@elsewhere.test",
    );
    expect(await dir.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "Rejected",
      reason: "closed",
    });
    await expect(lifecycle.confirmForwarding("alice@bye.test", "wrong")).rejects.toThrow();
    await lifecycle.confirmForwarding("alice@bye.test", verificationToken);
    expect(await dir.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "Forward",
      to: "alice@elsewhere.test",
      reason: "closure-forwarding",
    });
    clock.advance(181 * 86400_000);
    expect(await dir.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "Rejected",
      reason: "closed",
    });
  });

  it("[A02] paid short-address reservations are independent records", async () => {
    const { d1, clock, account } = await setup();
    const lifecycle = new ControlLifecycle(d1, clock, "s");
    await lifecycle.reservePaidAddress(account.userId, "ab@bye.test", null);
    await expect(lifecycle.reservePaidAddress("usr_other", "ab@bye.test", null)).rejects.toThrow(
      "reserved",
    );
  });
});

describe("processor-time ordering and forwarding expiry", () => {
  const SECRET = "whsec_test_0123456789abcdef0123456789";

  it("[A02] out-of-order guard compares processor times, not our receipt time", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const billing = new ControlBilling(d1, clock);
    const account = await new ControlDirectory(d1, clock).provisionPersonalAccount({
      address: "alice@bye.test",
      displayName: "Alice",
    });
    const orgId = account.organizationId;
    const send = async (event: Record<string, unknown>) => {
      const body = JSON.stringify({ orgId, ...event });
      return billing.handleWebhook(
        body,
        await signBillingPayload(body, SECRET, clock.now()),
        SECRET,
      );
    };
    const t0 = clock.now();
    // Activation (processor time t0) arrives late: we write it an hour after it happened.
    clock.advance(3600_000);
    await send({
      id: "evt_a",
      created: t0,
      type: "subscription.activated",
      plan: "personal",
      interval: "annual",
      seats: 1,
      periodEnd: t0 + 365 * 86400_000,
    });
    // A genuine later cancellation (t0 + 30 min) is older than our receipt time but newer at the processor.
    const cancelled = await send({
      id: "evt_c",
      created: t0 + 1800_000,
      type: "subscription.cancelled",
      atPeriodEnd: false,
    });
    expect(cancelled.applied).toBe(true);
    expect((await billing.entitlement(orgId))?.status).toBe("expired");
    // A truly older event is still ignored.
    const stale = await send({
      id: "evt_old",
      created: t0 - 1,
      type: "subscription.renewed",
      periodEnd: t0 + 400 * 86400_000,
    });
    expect(stale.applied).toBe(false);
    expect((await billing.entitlement(orgId))?.status).toBe("expired");
  });

  it("[A04] forwarding can't be (re)configured after the forwarding entitlement has expired", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const account = await new ControlDirectory(d1, clock).provisionPersonalAccount({
      address: "alice@bye.test",
      displayName: "Alice",
    });
    const lifecycle = new ControlLifecycle(d1, clock, "secret");
    await lifecycle.closeAccount(account.userId, { reserveAddressDays: 365, forwardingDays: 30 });
    const { verificationToken } = await lifecycle.requestForwarding(
      account.userId,
      "alice@bye.test",
      "me@example.net",
    );
    // 32 random bytes, base64url without padding; it verifies the destination while entitled.
    expect(verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await lifecycle.confirmForwarding("alice@bye.test", verificationToken);
    clock.advance(31 * 86400_000);
    await expect(
      lifecycle.requestForwarding(account.userId, "alice@bye.test", "me@example.net"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("[A04] a verification token issued inside the window can't activate forwarding after it ends", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const dir = new ControlDirectory(d1, clock);
    const account = await dir.provisionPersonalAccount({
      address: "alice@bye.test",
      displayName: "Alice",
    });
    const lifecycle = new ControlLifecycle(d1, clock, "secret");
    await lifecycle.closeAccount(account.userId, { reserveAddressDays: 365, forwardingDays: 30 });
    const { verificationToken } = await lifecycle.requestForwarding(
      account.userId,
      "alice@bye.test",
      "me@example.net",
    );
    clock.advance(30 * 86400_000);
    await expect(
      lifecycle.confirmForwarding("alice@bye.test", verificationToken),
    ).rejects.toMatchObject({ code: "forbidden" });
    const row = await d1
      .prepare("SELECT forwarding_verified_at FROM address_reservations WHERE address = ?")
      .bind("alice@bye.test")
      .first<{ forwarding_verified_at: number | null }>();
    expect(row?.forwarding_verified_at).toBeNull();
  });

  it("[A04] closing an account revokes every credential kind: sessions, API tokens, device sessions and support grants", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const account = await new ControlDirectory(d1, clock).provisionPersonalAccount({
      address: "alice@bye.test",
      displayName: "Alice",
    });
    const now = clock.now();
    await d1
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at) VALUES ('ses_1', ?, 'h1', 'd', ?, ?, ?)",
      )
      .bind(account.userId, now, now, now + DAY)
      .run();
    await d1
      .prepare(
        "INSERT INTO api_tokens (id, user_id, token_hash, kind, label, scopes, created_at) VALUES ('tok_1', ?, 'h2', 'cli', '', '[]', ?)",
      )
      .bind(account.userId, now)
      .run();
    await d1
      .prepare(
        "INSERT INTO device_sessions (id, user_id, client_id, device_name, created_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES ('dvs_1', ?, 'bye-desktop', 'Mac', ?, ?, ?, ?)",
      )
      .bind(account.userId, now, now, now + DAY, now + DAY)
      .run();
    await d1
      .prepare(
        "INSERT INTO device_access_tokens (token_hash, session_id, expires_at) VALUES ('h3', 'dvs_1', ?)",
      )
      .bind(now + DAY)
      .run();
    await d1
      .prepare(
        "INSERT INTO support_grants (id, user_id, reason, granted_at, expires_at) VALUES ('sup_1', ?, 'r', ?, ?)",
      )
      .bind(account.userId, now, now + DAY)
      .run();
    await new ControlLifecycle(d1, clock, "s").closeAccount(account.userId, {
      reserveAddressDays: 30,
      forwardingDays: 0,
    });
    const live = async (sql: string) => (await d1.prepare(sql).first<{ n: number }>())?.n;
    expect(await live("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL")).toBe(0);
    expect(await live("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL")).toBe(0);
    expect(await live("SELECT COUNT(*) AS n FROM device_sessions WHERE revoked_at IS NULL")).toBe(
      0,
    );
    expect(await live("SELECT COUNT(*) AS n FROM device_access_tokens")).toBe(0);
    expect(await live("SELECT COUNT(*) AS n FROM support_grants WHERE revoked_at IS NULL")).toBe(0);
  });
});
