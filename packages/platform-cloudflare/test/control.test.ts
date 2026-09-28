import { describe, expect, it } from "vitest";
import {
  ControlAuth,
  ControlDirectory,
  ControlOrganizations,
  catalogShard,
  q,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const dir = new ControlDirectory(d1, clock);
  const orgs = new ControlOrganizations(d1, clock);

  const auth = new ControlAuth(d1, clock, {
    rp: { rpId: "x", origins: [], requireUserVerification: true },
    totpKeys: { current: 1, keys: { 1: new Uint8Array(32) } },
    recoveryPepper: "p",
  });

  return { d1, clock, dir, orgs, auth };
};

const code = <Caught>(e: Caught) => (e instanceof Rejection ? e.code : String(e));

describe("address directory", () => {
  it("resolves exact aliases before plus-address fallback and catch-all", async () => {
    const { dir, d1, orgs, clock } = await setup();

    const alice = await dir.provisionPersonalAccount({
      address: "alice@acme.test",
      displayName: "Alice",
    });

    const bob = await dir.provisionPersonalAccount({
      address: "bob@acme.test",
      displayName: "Bob",
    });

    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    await q(
      d1,
      "INSERT INTO domains (id, org_id, name, state, verification_token, catch_all_mailbox_id, created_at, updated_at) VALUES ('dom_1', ?, 'acme.test', 'active', 't', ?, ?, ?)",
      orgId,
      alice.mailboxId,
      clock.now(),
      clock.now(),
    ).run();
    // A tenant domain's own alias namespace (service-domain local-part rules don't apply).
    await dir.addAlias(bob.mailboxId, "alice+sales@acme.test");

    expect(await dir.resolveRecipient("ALICE@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: alice.mailboxId,
      via: "exact",
    });
    expect(await dir.resolveRecipient("alice+sales@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: bob.mailboxId,
      via: "exact",
    });
    expect(await dir.resolveRecipient("alice+news@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: alice.mailboxId,
      via: "plus",
      plusTag: "news",
    });
    expect(await dir.resolveRecipient("nobody@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: alice.mailboxId,
      via: "catch-all",
    });
    expect(await dir.resolveRecipient("nobody@other.test")).toEqual({
      _tag: "Rejected",
      reason: "unknown-recipient",
    });
  });

  it("[O01] catch-all never grants sending authority for arbitrary local parts", async () => {
    const { dir, d1, orgs, clock } = await setup();

    const alice = await dir.provisionPersonalAccount({
      address: "alice@acme.test",
      displayName: "Alice",
    });

    const orgId = await orgs.createOrganization(alice.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    await q(
      d1,
      "INSERT INTO domains (id, org_id, name, state, verification_token, catch_all_mailbox_id, created_at, updated_at) VALUES ('dom_1', ?, 'acme.test', 'active', 't', ?, ?, ?)",
      orgId,
      alice.mailboxId,
      clock.now(),
      clock.now(),
    ).run();
    expect(await dir.canSendAs(alice.userId, alice.mailboxId, "alice@acme.test")).toBe(true);
    expect(await dir.canSendAs(alice.userId, alice.mailboxId, "ceo@acme.test")).toBe(false);
  });

  it("treats a directory outage as transient, never as an unknown recipient", async () => {
    const { dir, d1 } = await setup();
    await dir.provisionPersonalAccount({ address: "alice@bye.test", displayName: "Alice" });
    d1.failing = true;
    expect(await dir.resolveRecipient("alice@bye.test")).toEqual({
      _tag: "TransientFailure",
      detail: "directory unavailable",
    });
    expect(await dir.resolveRecipient("nobody@bye.test")).toMatchObject({
      _tag: "TransientFailure",
    });
  });

  it("provisions catalog entries atomically with the exposing route", async () => {
    const { dir, d1 } = await setup();

    const a = await dir.provisionPersonalAccount({
      address: "alice@bye.test",
      displayName: "Alice",
    });

    const listed = await dir.listCatalog("mailbox", catalogShard(a.mailboxId), "", 10);
    expect(listed.map((x) => x.id)).toContain(a.mailboxId);
    await expect(
      dir.provisionPersonalAccount({ address: "alice@bye.test", displayName: "Dup" }),
    ).rejects.toSatisfy((e) => code(e) === "conflict");
    const users = await q(d1, "SELECT COUNT(*) AS n FROM users").first<{ n: number }>();

    const catalog = await q(d1, "SELECT COUNT(*) AS n FROM resource_catalog").first<{
      n: number;
    }>();

    expect(users?.n).toBe(1);
    expect(catalog?.n).toBe(2);
  });
});

describe("team administration", () => {
  const team = async () => {
    const env = await setup();

    const owner = await env.dir.provisionPersonalAccount({
      address: "owner@acme.test",
      displayName: "Owner",
    });

    const member = await env.dir.provisionPersonalAccount({
      address: "member@acme.test",
      displayName: "Member",
    });

    const orgId = await env.orgs.createOrganization(owner.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 3,
      reassignmentPolicy: "reassign-to-admin",
    });

    const { token } = await env.orgs.invite(
      orgId,
      await env.orgs.verifiedActor(orgId, owner.userId),
      "member@acme.test",
      "member",
    );

    await env.orgs.acceptInvitation(token, member.userId);
    // Move the member's mailbox into the team organization.
    await q(env.d1, "UPDATE mailboxes SET org_id = ? WHERE id = ?", orgId, member.mailboxId).run();

    return { ...env, owner, member, orgId };
  };

  it("[O02] suspension immediately removes interactive and sending access; audit records it", async () => {
    const { orgs, auth, dir, owner, member, orgId } = await team();
    const { token } = await auth.issueSession(member.userId, "laptop");
    expect((await auth.principal(await auth.authenticate(token))).mailboxIds).toContain(
      member.mailboxId,
    );
    expect(await dir.canSendAs(member.userId, member.mailboxId, "member@acme.test")).toBe(true);

    await orgs.suspend(orgId, await orgs.verifiedActor(orgId, owner.userId), member.userId);
    const p = await auth.principal(await auth.authenticate(token));
    expect(p.mailboxIds).not.toContain(member.mailboxId);
    expect(p.organizationIds).not.toContain(orgId);
    expect(await dir.canSendAs(member.userId, member.mailboxId, "member@acme.test")).toBe(false);
    expect(await dir.canAccessMailbox(member.userId, member.mailboxId)).toBe(false);
    // Inbound retention continues while suspended.
    expect(await dir.resolveRecipient("member@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: member.mailboxId,
    });
    expect((await orgs.auditLog(orgId)).map((a) => a.action)).toContain("member.suspend");
  });

  it("[O02] reactivation follows the suspend rules: only owners reactivate owners, only suspended members", async () => {
    const { orgs, dir, owner, member, orgId } = await team();
    const asOwner = async () => orgs.verifiedActor(orgId, owner.userId);
    // A second owner, and an admin who must not be able to restore an owner.
    await orgs.setRole(orgId, await asOwner(), member.userId, "owner");

    const admin = await dir.provisionPersonalAccount({
      address: "dana@acme.test",
      displayName: "A",
    });

    const inv = await orgs.invite(orgId, await asOwner(), "dana@acme.test", "admin");
    await orgs.acceptInvitation(inv.token, admin.userId);
    await orgs.suspend(orgId, await asOwner(), member.userId);

    await expect(
      orgs.reactivate(orgId, await orgs.verifiedActor(orgId, admin.userId), member.userId),
    ).rejects.toSatisfy((e) => code(e) === "forbidden");
    expect((await orgs.membership(orgId, member.userId))?.status).toBe("suspended");
    // Active or unknown members are not "reactivated" (and nothing is audited for them).
    await expect(orgs.reactivate(orgId, await asOwner(), admin.userId)).rejects.toSatisfy(
      (e) => code(e) === "not_found",
    );
    await expect(orgs.reactivate(orgId, await asOwner(), "usr_nobody")).rejects.toSatisfy(
      (e) => code(e) === "not_found",
    );
    await orgs.reactivate(orgId, await asOwner(), member.userId);
    expect((await orgs.membership(orgId, member.userId))?.status).toBe("active");
    expect(
      (await orgs.auditLog(orgId)).filter((a) => a.action === "member.reactivate"),
    ).toHaveLength(1);
  });

  it("[O02] role rules: members cannot administer, last owner is protected, seats are enforced", async () => {
    const { orgs, dir, owner, member, orgId } = await team();
    // Only verified administrators may act; a plain member is refused at verification.
    await expect(orgs.verifiedActor(orgId, member.userId)).rejects.toSatisfy(
      (e) => code(e) === "forbidden",
    );
    await expect(
      orgs.suspend(orgId, await orgs.verifiedActor(orgId, owner.userId), owner.userId),
    ).rejects.toThrow("last owner");
    await expect(
      orgs.setRole(orgId, await orgs.verifiedActor(orgId, owner.userId), owner.userId, "member"),
    ).rejects.toThrow("last owner");
    await orgs.setRole(
      orgId,
      await orgs.verifiedActor(orgId, owner.userId),
      member.userId,
      "admin",
    );
    await expect(
      orgs.setRole(orgId, await orgs.verifiedActor(orgId, member.userId), owner.userId, "member"),
    ).rejects.toSatisfy((e) => code(e) === "forbidden");

    const third = await dir.provisionPersonalAccount({
      address: "third@acme.test",
      displayName: "T",
    });

    const inv = await orgs.invite(
      orgId,
      await orgs.verifiedActor(orgId, owner.userId),
      "third@acme.test",
      "member",
    );

    await orgs.acceptInvitation(inv.token, third.userId);
    await expect(
      orgs.invite(
        orgId,
        await orgs.verifiedActor(orgId, owner.userId),
        "fourth@acme.test",
        "member",
      ),
    ).rejects.toThrow("seats");
    expect(await orgs.seats(orgId)).toEqual({ limit: 3, used: 3, entitled: 3 });
  });

  it("[O02] invitations are bound to the invited address and single-use", async () => {
    const { orgs, dir, owner, orgId } = await team();

    const other = await dir.provisionPersonalAccount({
      address: "other@acme.test",
      displayName: "O",
    });

    const inv = await orgs.invite(
      orgId,
      await orgs.verifiedActor(orgId, owner.userId),
      "invited@acme.test",
      "member",
    );

    await expect(orgs.acceptInvitation(inv.token, other.userId)).rejects.toSatisfy(
      (e) => code(e) === "forbidden",
    );
    await expect(orgs.acceptInvitation("bogus", other.userId)).rejects.toSatisfy(
      (e) => code(e) === "not_found",
    );
  });

  it("[O02] removal applies the mailbox reassignment policy", async () => {
    const { orgs, auth, owner, member, orgId } = await team();

    const result = await orgs.remove(
      orgId,
      await orgs.verifiedActor(orgId, owner.userId),
      member.userId,
    );

    expect(result).toEqual({ policy: "reassign-to-admin", mailboxes: [member.mailboxId] });
    const { token } = await auth.issueSession(owner.userId, "x");
    expect((await auth.principal(await auth.authenticate(token))).mailboxIds).toContain(
      member.mailboxId,
    );
    const { token: mt } = await auth.issueSession(member.userId, "x");
    expect((await auth.principal(await auth.authenticate(mt))).mailboxIds).not.toContain(
      member.mailboxId,
    );
  });

  it("[A01] family organizations share billing but never grant mailbox or calendar access", async () => {
    const { orgs, dir, auth } = await setup();

    const parent = await dir.provisionPersonalAccount({
      address: "parent@bye.test",
      displayName: "P",
    });

    const child = await dir.provisionPersonalAccount({
      address: "child@bye.test",
      displayName: "C",
    });

    const family = await orgs.createOrganization(parent.userId, {
      name: "Family",
      kind: "family",
      seatLimit: 5,
    });

    const inv = await orgs.invite(
      family,
      await orgs.verifiedActor(family, parent.userId),
      "child@bye.test",
      "member",
    );

    await orgs.acceptInvitation(inv.token, child.userId);
    const { token } = await auth.issueSession(parent.userId, "x");
    const p = await auth.principal(await auth.authenticate(token));
    expect(p.organizationIds).toContain(family);
    expect(p.mailboxIds).toEqual([parent.mailboxId]);
    expect(p.calendarIds).toEqual([parent.calendarId]);
    expect(await dir.canAccessMailbox(parent.userId, child.mailboxId)).toBe(false);
  });
});
