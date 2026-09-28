import { describe, expect, it } from "vitest";
import { ALL_MEMBERS, SharedSpaceStore, type SharedMessageInput } from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const msg = (
  ref: string,
  sentAt: number,
  extra: Partial<SharedMessageInput> = {},
): SharedMessageInput => ({
  messageRef: ref,
  from: { name: "Customer", address: "customer@example.test" },
  to: [{ address: "sales@acme.test" }],
  cc: [],
  subject: "Quote",
  snippet: `body ${ref}`,
  contentKey: `t/mbx_a/body/${ref}.json`,
  sentAt,
  ...extra,
});

const setup = () => {
  const clock = new TestClock();
  const storage = new MemoryDurableStorage();
  const space = new SharedSpaceStore(storage, clock);
  space.init({ spaceId: "spc_1", kind: "team", organizationId: "org_1", ownerId: "usr_owner" });
  space.setMember("usr_owner", "usr_ann", "member");
  space.setMember("usr_owner", "usr_ben", "member");

  return { clock, storage, space };
};

const code = (f: () => void) => {
  try {
    f();

    return "ok";
  } catch (e) {
    return e instanceof Rejection ? e.code : String(e);
  }
};

describe("shared threads and grants", () => {
  it("[O04] shares selected history and future replies without forwarding; revoke blocks later reads", () => {
    const { space, clock } = setup();

    const threadId = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_1",
      subject: "Quote",
      messages: [msg("m1", 1)],
      grantees: ["usr_ben"],
      includeFuture: true,
    });

    expect(space.readThread("usr_ben", threadId).messages.map((m) => m.messageRef)).toEqual(["m1"]);

    clock.advance(1000);
    expect(space.appendReply("evt_r1", "mbx_a", "thr_1", msg("m2", 2))).toEqual({
      accepted: true,
      replayed: false,
    });
    expect(space.appendReply("evt_r1", "mbx_a", "thr_1", msg("m2", 2))).toEqual({
      accepted: true,
      replayed: true,
    });
    expect(space.readThread("usr_ben", threadId).messages).toHaveLength(2);
    expect(
      space.kernel
        .pendingOutbox(10)
        .filter((e) => e.topic === "notify")
        .map((e) => e.target)
        .sort(),
    ).toEqual(["usr_ann", "usr_ben"]);

    const grant = space.sql.one<{ id: string }>(
      "SELECT id FROM grants WHERE grantee = 'usr_ben'",
    )!.id;

    const cursor = space.kernel.currentSeq();
    space.revoke("usr_ann", grant);
    expect(space.kernel.changesSince(cursor, 10).changes.map((c) => c.kind)).toContain("revoked");
    expect(code(() => space.readThread("usr_ben", threadId))).toBe("forbidden");
    expect(space.authorizeContent("usr_ben", "t/mbx_a/body/m1.json")).toBe(false);
    expect(space.hydrate("usr_ben", [threadId])).toEqual([]);
    expect(space.authorizeContent("usr_ann", "t/mbx_a/body/m1.json")).toBe(true);
  });

  it("[O04] replies are not propagated when future replies were not included", () => {
    const { space } = setup();

    const id = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_2",
      subject: "S",
      messages: [msg("m1", 1)],
      grantees: ["usr_ben"],
      includeFuture: false,
    });

    expect(space.appendReply("evt_x", "mbx_a", "thr_2", msg("m2", 2)).accepted).toBe(false);
    expect(space.readThread("usr_ben", id).messages).toHaveLength(1);
  });

  it("[O04] membership suspension/removal blocks member-wide grants immediately", () => {
    const { space } = setup();

    const id = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_3",
      subject: "S",
      messages: [msg("m1", 1)],
      grantees: [ALL_MEMBERS],
      includeFuture: true,
    });

    expect(space.canReadThread("usr_ben", id)).toBe(true);
    const v = space.membershipVersion();
    space.setMember("usr_owner", "usr_ben", null);
    expect(space.membershipVersion()).toBe(v + 1);
    expect(space.canReadThread("usr_ben", id)).toBe(false);
    expect(code(() => space.setMember("usr_ann", "usr_owner", null))).toBe("forbidden");
    expect(code(() => space.setMember("usr_owner", "usr_owner", null))).toBe("conflict");
  });

  it("[O04] private comments stay inside the shared resource and never reach MIME sources", () => {
    const { space } = setup();

    const id = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_4",
      subject: "S",
      messages: [msg("m1", 1)],
      grantees: ["usr_ben"],
      includeFuture: true,
    });

    space.addComment("usr_ben", id, "internal: they are price sensitive");
    expect(space.comments("usr_ann", id).map((c) => c.body)).toEqual([
      "internal: they are price sensitive",
    ]);
    expect(JSON.stringify(space.mimeSource("usr_ann", id))).not.toContain("price sensitive");
    expect(code(() => space.comments("usr_eve", id))).toBe("forbidden");
    // Invalid input is a bad request (400), not a conflict.
    expect(code(() => space.addComment("usr_ann", id, "   "))).toBe("bad_request");
    expect(code(() => space.addComment("usr_eve", id, "x"))).toBe("forbidden");
  });

  it("[O04] hidden recipients never enter shared state even if a caller passes them", () => {
    const { space } = setup();

    const leaky = {
      ...msg("m1", 1),
      bcc: [{ address: "secret@example.test" }],
    } as SharedMessageInput;

    const id = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_5",
      subject: "S",
      messages: [leaky],
      grantees: [],
      includeFuture: true,
    });

    expect(JSON.stringify(space.readThread("usr_ann", id))).not.toContain("secret@");
  });

  it("[E14] shared collections aggregate timelines and apply per-thread permissions", () => {
    const { space } = setup();

    const t1 = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "t1",
      subject: "A",
      messages: [msg("a1", 10)],
      grantees: [ALL_MEMBERS],
      includeFuture: true,
    });

    const t2 = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "t2",
      subject: "B",
      messages: [msg("b1", 5)],
      grantees: [],
      includeFuture: true,
    });

    const col = space.createCollection("usr_ann", "Project X", true);
    space.addToCollection("usr_ann", col, t1);
    space.addToCollection("usr_ann", col, t2);
    expect(space.collectionTimeline("usr_ann", col).map((m) => m.messageRef)).toEqual(["b1", "a1"]);
    // Ben sees the collection but only the thread he can read.
    expect(space.collectionTimeline("usr_ben", col).map((m) => m.messageRef)).toEqual(["a1"]);
    expect(code(() => space.addToCollection("usr_ben", col, t2))).toBe("forbidden");
    expect(code(() => space.collectionTimeline("usr_eve", col))).toBe("forbidden");
  });
});

describe("extensions / shared addresses", () => {
  it("[O03] common history, member send-as, and automatic workflow enrollment", () => {
    const { space } = setup();
    space.configureExtension("usr_owner", {
      address: "Support@acme.test",
      displayName: "Support",
      sendAs: true,
      workflowBoard: "wfb_support",
      workflowStage: "new",
    });
    expect(
      code(() =>
        space.configureExtension("usr_ann", {
          address: "x@acme.test",
          displayName: "X",
          sendAs: true,
        }),
      ),
    ).toBe("forbidden");

    const r = space.receiveExtensionMail("evt_1", {
      address: "support@acme.test",
      sourceMailboxId: "mbx_ext",
      sourceThreadId: "thr_9",
      subject: "Help",
      message: msg("h1", 1),
    });

    expect(r.enroll).toEqual({ board: "wfb_support", stage: "new" });
    expect(space.readThread("usr_ben", r.threadId).messages).toHaveLength(1);
    expect(space.canSendAs("usr_ann", "support@acme.test")).toBe(true);
    expect(space.canSendAs("usr_eve", "support@acme.test")).toBe(false);
    space.setMember("usr_owner", "usr_ann", null);
    expect(space.canSendAs("usr_ann", "support@acme.test")).toBe(false);
  });
});

describe("public thread links", () => {
  it("[O05] bearer link exposes the thread (and future replies if chosen), expires and revokes", async () => {
    const { space, clock } = setup();

    const id = space.shareThread({
      actorId: "usr_ann",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_p",
      subject: "Launch",
      messages: [msg("p1", 1)],
      grantees: [],
      includeFuture: true,
    });

    space.addComment("usr_ann", id, "private comment");
    const preview = space.previewPublicLink("usr_ann", id);

    const withFuture = await space.createPublicLink("usr_ann", id, {
      includeFuture: true,
      expiresAt: clock.now() + 60_000,
    });

    const snapshot = await space.createPublicLink("usr_ann", id, { includeFuture: false });
    await expect(
      space.createPublicLink("usr_eve", id, { includeFuture: true }),
    ).rejects.toBeInstanceOf(Rejection);

    clock.advance(10);
    space.appendReply("evt_p2", "mbx_a", "thr_p", msg("p2", 2));
    const view = await space.resolvePublicLink(withFuture.token);
    expect(view.messages.map((m) => m.snippet)).toEqual(["body p1", "body p2"]);
    expect(JSON.stringify(view)).not.toContain("private comment");
    expect(JSON.stringify(preview)).not.toContain("private comment");
    expect((await space.resolvePublicLink(snapshot.token)).messages).toHaveLength(1);

    await expect(space.resolvePublicLink("guess")).rejects.toMatchObject({ code: "not_found" });
    space.revokePublicLink("usr_ann", snapshot.linkId);
    await expect(space.resolvePublicLink(snapshot.token)).rejects.toMatchObject({ code: "gone" });
    clock.advance(60_000);
    await expect(space.resolvePublicLink(withFuture.token)).rejects.toMatchObject({ code: "gone" });
    // Token plaintext is never stored.
    expect(JSON.stringify(space.sql.all("SELECT * FROM public_links"))).not.toContain(
      withFuture.token,
    );
  });
});

describe("space change feed", () => {
  it("[§8] a space's change feed is member-only and advances with changes", () => {
    const space = new SharedSpaceStore(new MemoryDurableStorage(), new TestClock());
    space.init({ spaceId: "spc_1", kind: "team", organizationId: "org_1", ownerId: "usr_owner" });
    const before = space.changes("usr_owner", 0);
    space.setMember("usr_owner", "usr_ann", "member");
    const after = space.changes("usr_owner", before.cursor);
    expect(after.changes.map((c) => c.kind)).toEqual(["added"]);
    expect(after.cursor).toBeGreaterThan(before.cursor);
    expect(() => space.changes("usr_stranger", 0)).toThrow(Rejection);
  });
});

describe("membership removal", () => {
  it("[O02] removing a member revokes their direct grants; re-adding them doesn't resurrect access", () => {
    const space = new SharedSpaceStore(new MemoryDurableStorage(), new TestClock());
    space.init({ spaceId: "spc_1", kind: "team", organizationId: "org_1", ownerId: "usr_owner" });
    space.setMember("usr_owner", "usr_ben", "member");

    const threadId = space.shareThread({
      actorId: "usr_owner",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_1",
      subject: "Plan",
      messages: [],
      grantees: ["usr_ben"],
      includeFuture: false,
    });

    expect(space.listThreads("usr_ben").map((t) => t.id)).toEqual([threadId]);
    space.setMember("usr_owner", "usr_ben", null);
    space.setMember("usr_owner", "usr_ben", "member");
    expect(space.listThreads("usr_ben")).toEqual([]);
  });

  it("[§12] eraseMember revokes membership, grants and links without the owner check; idempotent", async () => {
    const { space } = setup();

    const threadId = space.shareThread({
      actorId: "usr_owner",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_1",
      subject: "Plan",
      messages: [msg("m1", 1)],
      grantees: ["usr_ben", "usr_ann"],
      includeFuture: true,
    });

    const link = await space.createPublicLink("usr_ben", threadId, { includeFuture: true });
    expect(space.eraseMember("usr_ben")).toEqual({ removed: true, grantsRevoked: 1 });
    expect(space.listMembers("usr_owner").map((m) => m.userId)).toEqual(["usr_ann", "usr_owner"]);
    expect(space.listThreads("usr_ben")).toEqual([]);
    await expect(space.resolvePublicLink(link.token)).rejects.toThrow();
    // Content the erased member could see stays with the space; other grantees keep access.
    expect(space.listThreads("usr_ann").map((t) => t.id)).toEqual([threadId]);
    expect(space.listThreads("usr_owner").map((t) => t.id)).toEqual([threadId]);
    expect(space.eraseMember("usr_ben")).toEqual({ removed: false, grantsRevoked: 0 });
    // Re-adding does not resurrect the erased grants.
    space.setMember("usr_owner", "usr_ben", "member");
    expect(space.listThreads("usr_ben")).toEqual([]);
  });

  it("[O02] the last owner can be neither removed nor demoted", () => {
    const space = new SharedSpaceStore(new MemoryDurableStorage(), new TestClock());
    space.init({ spaceId: "spc_1", kind: "team", organizationId: "org_1", ownerId: "usr_owner" });
    expect(() => space.setMember("usr_owner", "usr_owner", "member")).toThrow(/last owner/);
    expect(() => space.setMember("usr_owner", "usr_owner", null)).toThrow(/last owner/);
    // With a second owner, demotion is fine.
    space.setMember("usr_owner", "usr_co", "owner");
    space.setMember("usr_owner", "usr_owner", "member");
    expect(() => space.setMember("usr_co", "usr_co", "member")).toThrow(/last owner/);
  });

  it("[O05] a public link stops working once its creator loses access to the thread", async () => {
    const space = new SharedSpaceStore(new MemoryDurableStorage(), new TestClock());
    space.init({ spaceId: "spc_1", kind: "team", organizationId: "org_1", ownerId: "usr_owner" });
    space.setMember("usr_owner", "usr_m", "member");

    const threadId = space.shareThread({
      actorId: "usr_owner",
      sourceMailboxId: "mbx_a",
      sourceThreadId: "thr_1",
      subject: "Plan",
      messages: [],
      grantees: ["usr_m"],
      includeFuture: true,
    });

    const link = await space.createPublicLink("usr_m", threadId, { includeFuture: true });
    expect((await space.resolvePublicLink(link.token)).subject).toBe("Plan");
    space.setMember("usr_owner", "usr_m", null);
    await expect(space.resolvePublicLink(link.token)).rejects.toThrow();
  });
});
