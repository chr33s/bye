import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  ControlAuth,
  ControlBilling,
  ControlCommerce,
  ControlDeviceAuth,
  ControlDirectory,
  ControlLifecycle,
  ControlOrganizations,
  type D1StatementLike,
  hotp,
  parseSecretRing,
  pkceChallenge,
  Rejection,
  SendingPolicy,
  signBillingPayload,
  TOTP_LOCKOUT_MS,
  TOTP_MAX_FAILURES,
  totpStep,
  UnknownKeyVersion,
  verifyBillingSignature,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

// Compare-and-set and atomic-reservation regressions for the control plane (§10, A02, A03, O02),
// plus the SESSION_KEY key ring. Concurrency is exercised with Promise.all: every adapter awaits
// between its read and its write, so racing calls interleave there exactly as Workers requests do.

const DAY = 86_400_000;
const SECRET = "whsec_test_0123456789abcdef0123456789";
const code = (e: unknown) => (e instanceof Rejection ? e.code : String(e));
const RP = { rpId: "bye.test", origins: ["https://app.bye.test"], requireUserVerification: true };

/** MemoryD1 that fails like D1 does when a statement binds more than 100 parameters. */
class CappedD1 extends MemoryD1 {
  maxBound = 0;
  override prepare(query: string): D1StatementLike {
    const inner = super.prepare(query);
    const wrap = (s: D1StatementLike): D1StatementLike =>
      ({
        bind: (...values) => {
          this.maxBound = Math.max(this.maxBound, values.length);
          if (values.length > 100) throw new Error("D1_ERROR: too many SQL variables");
          return wrap(s.bind(...values));
        },
        first: () => s.first(),
        all: () => s.all(),
        run: () => s.run(),
        execSync: () => (s as unknown as { execSync(): unknown }).execSync(),
      }) as D1StatementLike;
    return wrap(inner);
  }
  static cappedMigrated(): CappedD1 {
    const d1 = new CappedD1();
    const dir = join(import.meta.dirname, "../../../infra/migrations/d1");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      d1.db.exec(readFileSync(join(dir, file), "utf8"));
    return d1;
  }
}

const accounts = async (d1: MemoryD1, clock: TestClock, ...names: Array<string>) => {
  const dir = new ControlDirectory(d1, clock);
  const out = [];
  for (const n of names)
    out.push(await dir.provisionPersonalAccount({ address: `${n}@bye.test`, displayName: n }));
  return out;
};

describe("[§10] sending budget reservation", () => {
  it("chunks the suppression lookup under D1's 100-parameter limit", async () => {
    const d1 = CappedD1.cappedMigrated();
    const clock = new TestClock();
    const [alice] = await accounts(d1, clock, "alice");
    const policy = new SendingPolicy(d1, clock, {
      identityPerDay: 10_000,
      domainPerDay: 10_000,
      platformPerHour: 10_000,
      minVolume: 50,
      maxComplaintRate: 1,
      maxBounceRate: 1,
    });
    await policy.suppress("r7@x.test", "manual", "op");
    await policy.suppress("r149@x.test", "manual", "op");
    const recipients = Array.from({ length: 150 }, (_, i) => `r${i}@x.test`);
    const verdict = await policy.check({
      userId: alice!.userId,
      identity: "alice@bye.test",
      recipients,
    });
    expect(d1.maxBound).toBeLessThanOrEqual(100);
    expect(verdict).toMatchObject({ allowed: false, reason: "budget" }); // 148 > new-account 50
    expect([...verdict.suppressed].sort()).toEqual(["r149@x.test", "r7@x.test"]);
  });

  it("concurrent dispatches cannot all pass the same remaining budget", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const [alice] = await accounts(d1, clock, "alice");
    const policy = new SendingPolicy(d1, clock); // new account: 50/day
    const ten = Array.from({ length: 10 }, (_, i) => `r${i}@x.test`);
    const verdicts = await Promise.all(
      Array.from({ length: 8 }, () =>
        policy.reserve({ userId: alice!.userId, identity: "alice@bye.test", recipients: ten }),
      ),
    );
    const allowed = verdicts.filter((v) => v.allowed);
    expect(allowed.length).toBeLessThanOrEqual(5);
    expect(allowed.length).toBeGreaterThan(0);
    for (const v of allowed) expect(v).toMatchObject({ reserved: 10 });
    const used = await d1
      .prepare("SELECT SUM(sent) AS n FROM sending_counters WHERE scope = 'user' AND key = ?")
      .bind(alice!.userId)
      .first<{ n: number }>();
    // Refused reservations were compensated: only admitted sends remain counted.
    expect(Number(used?.n)).toBe(allowed.length * 10);
    // A released reservation frees its budget again.
    await policy.release({ userId: alice!.userId, identity: "alice@bye.test", recipients: 10 });
    const after = await d1
      .prepare("SELECT SUM(sent) AS n FROM sending_counters WHERE scope = 'user' AND key = ?")
      .bind(alice!.userId)
      .first<{ n: number }>();
    expect(Number(after?.n)).toBe((allowed.length - 1) * 10);
  });
});

describe("[A02] billing webhooks", () => {
  const setup = async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const commerce = new ControlCommerce(d1, clock, null, "secret");
    const billing = new ControlBilling(d1, clock, commerce);
    const [alice, bob] = await accounts(d1, clock, "alice", "bob");
    return { d1, clock, commerce, billing, alice: alice!, bob: bob! };
  };

  it("an empty or short signing secret verifies nothing", async () => {
    const body = "{}";
    for (const secret of ["", "short-secret"]) {
      // (WebCrypto cannot sign with an empty key; any signature must fail for it.)
      const sig = await signBillingPayload(body, secret || "x", Date.now());
      expect(await verifyBillingSignature(body, sig, secret, Date.now())).toBe(false);
    }
    const sig = await signBillingPayload(body, SECRET, Date.now());
    expect(await verifyBillingSignature(body, sig, SECRET, Date.now())).toBe(true);
  });

  it("concurrent credits both land; concurrent status events keep the newest", async () => {
    const { billing, alice, clock } = await setup();
    const org = alice.organizationId;
    const t = clock.now();
    await Promise.all([
      billing.apply({
        id: "c1",
        created: t,
        orgId: org,
        type: "credit.granted",
        cents: 300,
        reason: "goodwill",
      }),
      billing.apply({
        id: "c2",
        created: t,
        orgId: org,
        type: "credit.granted",
        cents: 200,
        reason: "goodwill",
      }),
    ]);
    expect((await billing.entitlement(org))?.credits_cents).toBe(500);
    await Promise.all([
      billing.apply({ id: "s_new", created: t + 10, orgId: org, type: "subscription.expired" }),
      billing.apply({
        id: "s_old",
        created: t + 5,
        orgId: org,
        type: "subscription.renewed",
        periodEnd: t + 400 * DAY,
      }),
    ]);
    const e = await billing.entitlement(org);
    expect(e?.status).toBe("expired");
    expect(e?.processor_event_at).toBe(t + 10);
    // Status events touch only their own columns: credits survive.
    expect(e?.credits_cents).toBe(500);
  });

  it("a referral is credited once even when two activations race", async () => {
    const { billing, commerce, alice, bob, clock } = await setup();
    const ref = await commerce.referralCode(alice.userId);
    expect(await commerce.redeemReferral(bob.userId, ref)).toBe(true);
    const activation = (id: string) =>
      billing.apply({
        id,
        created: clock.now(),
        orgId: bob.organizationId,
        type: "subscription.activated",
        plan: "personal",
        interval: "annual",
        seats: 1,
        periodEnd: clock.now() + 400 * DAY,
      });
    await Promise.all([activation("a1"), activation("a2")]);
    expect((await billing.entitlement(bob.organizationId))?.credits_cents).toBe(1000);
    expect((await billing.entitlement(alice.organizationId))?.credits_cents).toBe(1000);
  });
});

describe("[A03] credential compare-and-set", () => {
  const setup = async (recoveryPepper = "pepper") => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const keys = { current: 1, keys: { 1: crypto.getRandomValues(new Uint8Array(32)) } };
    const auth = new ControlAuth(d1, clock, { rp: RP, totpKeys: keys, recoveryPepper });
    const [alice] = await accounts(d1, clock, "alice");
    return { d1, clock, auth, keys, alice: alice! };
  };

  it("two concurrent rotations of one session issue exactly one successor", async () => {
    const { auth, alice, d1 } = await setup();
    const s = await auth.issueSession(alice.userId, "laptop");
    const results = await Promise.allSettled([
      auth.rotateSession(s.token),
      auth.rotateSession(s.token),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const live = await d1
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL")
      .bind(alice.userId)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
  });

  it("TOTP step-up locks the user after repeated failures, across sessions, then unlocks", async () => {
    const { auth, alice, clock, d1 } = await setup();
    const { secret } = await auth.enrollTotp(alice.userId);
    const current = () => hotp(base32Decode(secret), totpStep(clock.now()));
    await auth.confirmTotp(alice.userId, await current());
    clock.advance(30_000);
    const a = await auth.issueSession(alice.userId, "a");
    const b = await auth.issueSession(alice.userId, "b");
    const wrong = async (sessionId: string) => {
      const good = await current();
      return auth.stepUpWithTotp(sessionId, good === "000000" ? "111111" : "000000");
    };
    for (let i = 1; i < TOTP_MAX_FAILURES; i++)
      await expect(wrong(i % 2 ? a.session.id : b.session.id)).rejects.toSatisfy(
        (e) => code(e) === "unauthenticated",
      );
    await expect(wrong(a.session.id)).rejects.toSatisfy((e) => code(e) === "rate_limited");
    // Locked for every session, even with the right code.
    await expect(auth.stepUpWithTotp(b.session.id, await current())).rejects.toSatisfy(
      (e) => code(e) === "rate_limited",
    );
    const audits = await d1
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'totp.%' ORDER BY created_at")
      .all<{ action: string }>();
    expect(audits.results.map((r) => r.action)).toContain("totp.lockout");
    clock.advance(TOTP_LOCKOUT_MS + 30_000);
    await auth.stepUpWithTotp(b.session.id, await current());
  });

  it("rotateTotpKeys re-seals in pages", async () => {
    const { d1, clock, keys } = await setup();
    const users = await accounts(d1, clock, "u1", "u2", "u3", "u4", "u5");
    const v1 = new ControlAuth(d1, clock, { rp: RP, totpKeys: keys, recoveryPepper: "p" });
    for (const u of users) await v1.enrollTotp(u!.userId);
    const v2 = new ControlAuth(d1, clock, {
      rp: RP,
      totpKeys: {
        current: 2,
        keys: { ...keys.keys, 2: crypto.getRandomValues(new Uint8Array(32)) },
      },
      recoveryPepper: "p",
    });
    expect(await v2.rotateTotpKeys(2, 1)).toBe(2); // bounded: one page
    expect(await v2.rotateTotpKeys(2)).toBe(3);
    expect(await v2.rotateTotpKeys(2)).toBe(0);
    const left = await d1
      .prepare("SELECT COUNT(*) AS n FROM totp_secrets WHERE key_version != 2")
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("recovery codes keep working across a SESSION_KEY rotation and record their pepper version", async () => {
    const { d1, clock, auth, keys, alice } = await setup("old-pepper");
    const [c1, c2] = await auth.generateRecoveryCodes(alice.userId);
    const ring = (recoveryPepper: string) =>
      new ControlAuth(d1, clock, { rp: RP, totpKeys: keys, recoveryPepper });
    const rotated = ring("v2:new-pepper,v1:old-pepper");
    await rotated.recoverWithCode("alice@bye.test", c1!, "phone");
    // New codes are made under v2.
    const fresh = await rotated.generateRecoveryCodes(alice.userId);
    const versions = await d1
      .prepare("SELECT DISTINCT pepper_version AS v FROM recovery_codes WHERE user_id = ?")
      .bind(alice.userId)
      .all<{ v: number }>();
    expect(versions.results.map((r) => r.v)).toEqual([2]);
    await ring("v2:new-pepper").recoverWithCode("alice@bye.test", fresh[0]!, "tablet");
    // A code whose pepper has left the ring is a tagged configuration error, not "bad code".
    const other = await setup("old-pepper");
    const [code1] = await other.auth.generateRecoveryCodes(other.alice.userId);
    const retired = new ControlAuth(other.d1, other.clock, {
      rp: RP,
      totpKeys: other.keys,
      recoveryPepper: "v2:new-pepper",
    });
    await expect(retired.recoverWithCode("alice@bye.test", code1!, "x")).rejects.toBeInstanceOf(
      UnknownKeyVersion,
    );
    void c2;
  });
});

describe("[A03] device refresh rotation", () => {
  it("two concurrent refreshes with one credential issue at most one new pair", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const [ana] = await accounts(d1, clock, "ana");
    const devices = new ControlDeviceAuth(d1, clock);
    const verifier = "v".repeat(43);
    const params = {
      responseType: "code" as const,
      clientId: "bye-desktop",
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      codeChallenge: await pkceChallenge(verifier),
      codeChallengeMethod: "S256" as const,
      state: "s".repeat(32),
      deviceName: "laptop",
    };
    const tokens = await devices.exchangeCode({
      code: await devices.issueCode(ana!.userId, params),
      codeVerifier: verifier,
      redirectUri: params.redirectUri,
      clientId: "bye-desktop",
    });
    const refresh = () =>
      devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" });
    const results = await Promise.allSettled([refresh(), refresh()]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
    const rows = await d1
      .prepare("SELECT COUNT(*) AS n FROM device_refresh_tokens")
      .first<{ n: number }>();
    expect(rows?.n).toBeLessThanOrEqual(2);
  });
});

describe("[O02] organization invariants hold in SQL", () => {
  const setup = async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const orgs = new ControlOrganizations(d1, clock);
    const [owner, second, carol, dave] = await accounts(
      d1,
      clock,
      "owner",
      "second",
      "carol",
      "dave",
    );
    const orgId = await orgs.createOrganization(owner!.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 3,
    });
    const join = async (u: { userId: string }, address: string, role: "admin" | "member") => {
      const { token } = await orgs.invite(
        orgId,
        { userId: owner!.userId, role: "owner" },
        address,
        role,
      );
      return orgs.acceptInvitation(token, u.userId);
    };
    return { d1, orgs, orgId, owner: owner!, second: second!, carol: carol!, dave: dave!, join };
  };

  it("two owners demoting each other at once cannot leave the org ownerless", async () => {
    const { d1, orgs, orgId, owner, second, join } = await setup();
    await join(second, "second@bye.test", "admin");
    const actor = { userId: owner.userId, role: "owner" as const };
    await orgs.setRole(orgId, actor, second.userId, "owner");
    const results = await Promise.allSettled([
      orgs.setRole(orgId, actor, owner.userId, "admin"),
      orgs.setRole(orgId, { userId: second.userId, role: "owner" }, second.userId, "admin"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'",
      )
      .bind(orgId)
      .first<{ n: number }>();
    expect(owners?.n).toBe(1);
    // Suspending / removing the last owner is refused by the same SQL guard.
    const last = results[0]!.status === "fulfilled" ? second : owner;
    await expect(
      orgs.suspend(orgId, { userId: last.userId, role: "owner" }, last.userId),
    ).rejects.toSatisfy((e) => code(e) === "conflict");
  });

  it("the last seat goes to exactly one of two racing acceptances", async () => {
    const { orgs, orgId, owner, carol, dave, second, join } = await setup();
    await join(second, "second@bye.test", "member");
    const actor = { userId: owner.userId, role: "owner" as const };
    const a = await orgs.invite(orgId, actor, "carol@bye.test", "member");
    const b = await orgs.invite(orgId, actor, "dave@bye.test", "member");
    const results = await Promise.allSettled([
      orgs.acceptInvitation(a.token, carol.userId),
      orgs.acceptInvitation(b.token, dave.userId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await orgs.seats(orgId)).used).toBe(3);
  });

  it("an invitation never reactivates a suspended member", async () => {
    const { orgs, orgId, owner, carol, join } = await setup();
    await join(carol, "carol@bye.test", "member");
    const actor = { userId: owner.userId, role: "owner" as const };
    await orgs.suspend(orgId, actor, carol.userId);
    const again = await orgs.invite(orgId, actor, "carol@bye.test", "admin");
    await expect(orgs.acceptInvitation(again.token, carol.userId)).rejects.toSatisfy(
      (e) => code(e) === "forbidden",
    );
    expect(await orgs.membership(orgId, carol.userId)).toEqual({
      role: "member",
      status: "suspended",
    });
  });
});

describe("[A03] abandoned signups", () => {
  it("releases passkey-less accounts after the window and frees the address; keeps real accounts", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const dir = new ControlDirectory(d1, clock);
    const [abandoned, active] = await accounts(d1, clock, "squat", "real");
    await d1
      .prepare(
        "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, sign_count, created_at) VALUES ('cred', ?, '{}', 0, ?)",
      )
      .bind(active!.userId, clock.now())
      .run();
    // Too young to release.
    expect(await dir.releaseAbandonedSignups(clock.now() - DAY)).toBe(0);
    clock.advance(DAY + 1);
    expect(await dir.releaseAbandonedSignups(clock.now() - DAY)).toBe(1);
    const user = await d1
      .prepare("SELECT status, primary_address FROM users WHERE id = ?")
      .bind(abandoned!.userId)
      .first<{ status: string; primary_address: string }>();
    expect(user?.status).toBe("closed");
    expect(user?.primary_address).not.toBe("squat@bye.test");
    expect(
      await d1
        .prepare("SELECT 1 AS r FROM address_routes WHERE address = 'squat@bye.test'")
        .first(),
    ).toBeNull();
    // The address can be claimed again; the real account is untouched.
    const again = await dir.provisionPersonalAccount({
      address: "squat@bye.test",
      displayName: "",
    });
    expect(again.userId).not.toBe(abandoned!.userId);
    expect(
      (
        await d1
          .prepare("SELECT status FROM users WHERE id = ?")
          .bind(active!.userId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("active");
    expect(await dir.releaseAbandonedSignups(clock.now() - DAY)).toBe(0);
  });
});

describe("[§10] SESSION_KEY key ring", () => {
  it("parses rings and treats a plain secret as version 1", () => {
    expect(parseSecretRing("plain-secret")).toEqual({ current: 1, secrets: { 1: "plain-secret" } });
    expect(parseSecretRing("v3:c,v2:b")).toEqual({ current: 3, secrets: { 3: "c", 2: "b" } });
  });

  it("forwarding verification and checkout-return signatures survive a rotation", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const [alice] = await accounts(d1, clock, "alice");
    await d1
      .prepare(
        "INSERT INTO address_reservations (address, user_id, reason, reserved_until, forwarding_until, created_at) VALUES ('old@bye.test', ?, 'closure-hold', ?, ?, ?)",
      )
      .bind(alice!.userId, clock.now() + 30 * DAY, clock.now() + 30 * DAY, clock.now())
      .run();
    const before = new ControlLifecycle(d1, clock, "old-key");
    const { verificationToken } = await before.requestForwarding(
      alice!.userId,
      "old@bye.test",
      "me@elsewhere.test",
    );
    await new ControlLifecycle(d1, clock, "v2:new-key,v1:old-key").confirmForwarding(
      "old@bye.test",
      verificationToken,
    );
    const oldCommerce = new ControlCommerce(d1, clock, null, "old-key");
    const newCommerce = new ControlCommerce(d1, clock, null, "v2:new-key,v1:old-key");
    const legacy = await oldCommerce.returnSignature("chk_1");
    expect(await newCommerce.returnSignature("chk_1", 1)).toBe(legacy);
    expect(await newCommerce.returnSignature("chk_1")).toMatch(/^v2\./);
    await expect(
      new ControlCommerce(d1, clock, null, "v2:new-key").returnSignature("chk_1", 1),
    ).rejects.toBeInstanceOf(UnknownKeyVersion);
  });
});
