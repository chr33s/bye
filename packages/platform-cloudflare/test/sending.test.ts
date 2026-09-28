import { describe, expect, it } from "vitest";
import { ControlDirectory, SendingPolicy } from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

// sending.ts: suppression removal and the suspension probe.

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();

  const alice = await new ControlDirectory(d1, clock).provisionPersonalAccount({
    address: "alice@bye.test",
    displayName: "Alice",
  });

  return { d1, clock, alice, policy: new SendingPolicy(d1, clock) };
};

describe("SendingPolicy.unsuppress", () => {
  it("removes a suppression (address normalized) so the recipient is deliverable again", async () => {
    const { policy, alice } = await setup();
    const send = { userId: alice.userId, identity: "alice@bye.test", recipients: ["a@x.test"] };
    await policy.suppress("a@x.test", "unsubscribe", "list");
    expect(await policy.check(send)).toMatchObject({ allowed: false, reason: "all-suppressed" });
    expect(await policy.unsuppress("  A@X.TEST ")).toBe(true);
    expect(await policy.check(send)).toMatchObject({ allowed: true, suppressed: [] });
  });

  it("reports false when nothing was suppressed, and only removes the named address", async () => {
    const { policy, alice } = await setup();
    expect(await policy.unsuppress("nobody@x.test")).toBe(false);
    await policy.suppress("a@x.test", "manual", "op");
    await policy.suppress("b@x.test", "manual", "op");
    expect(await policy.unsuppress("a@x.test")).toBe(true);
    expect(await policy.unsuppress("a@x.test")).toBe(false);
    expect(
      await policy.check({
        userId: alice.userId,
        identity: "alice@bye.test",
        recipients: ["a@x.test", "b@x.test"],
      }),
    ).toMatchObject({ allowed: true, suppressed: ["b@x.test"] });
  });
});

describe("SendingPolicy.isSuspended", () => {
  it("is true only for the exact active (scope, key) and false again once lifted", async () => {
    const { policy } = await setup();
    expect(await policy.isSuspended("domain", "bye.test")).toBe(false);
    await policy.suspend("domain", "bye.test", "phishing report", "op");
    expect(await policy.isSuspended("domain", "bye.test")).toBe(true);
    expect(await policy.isSuspended("domain", "other.test")).toBe(false);
    expect(await policy.isSuspended("identity", "bye.test")).toBe(false);
    expect(await policy.lift("domain", "bye.test", "op")).toBe(true);
    expect(await policy.isSuspended("domain", "bye.test")).toBe(false);
    // Re-suspending a lifted scope reactivates it.
    await policy.suspend("domain", "bye.test", "again", "op");
    expect(await policy.isSuspended("domain", "bye.test")).toBe(true);
  });
});
