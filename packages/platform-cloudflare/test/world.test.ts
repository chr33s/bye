import { describe, expect, it } from "vitest";
import {
  rssEscape,
  type PublishOperation,
  SUBSCRIBE_CONFIRM_COOLDOWN_MS,
  WorldStore,
} from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const setup = () => {
  const clock = new TestClock();
  const world = new WorldStore(new MemoryDurableStorage(), clock, "unsub-secret");
  world.init({
    authorId: "usr_alice",
    handle: "alice",
    title: "Alice <writes> & more",
    addresses: ["alice@bye.test"],
  });

  return { clock, world };
};

const op = (over: Partial<PublishOperation> = {}): PublishOperation => ({
  origin: "internal-send",
  authenticatedUserId: "usr_alice",
  fromAddress: "alice@bye.test",
  title: "Hello World",
  html: "<p>Hi <b>there</b></p>",
  text: "Hi there",
  media: [{ contentKey: "t/mbx_a/part/msg_1/2", name: "photo.jpg", contentType: "image/jpeg" }],
  publish: true,
  ...over,
});

describe("World publishing", () => {
  it("[P01] forged or inbound publish mail never publishes", () => {
    const { world } = setup();
    expect(() =>
      world.publishFromMail(op({ origin: "inbound-smtp", authenticatedUserId: undefined })),
    ).toThrow(Rejection);
    expect(() => world.publishFromMail(op({ authenticatedUserId: "usr_mallory" }))).toThrow(
      "author",
    );
    expect(() => world.publishFromMail(op({ fromAddress: "alice@evil.test" }))).toThrow("identity");
    expect(world.publicPosts()).toHaveLength(0);
  });

  it("[P01] publish copies media into the public namespace, edits need republish, unpublish purges", () => {
    const { world } = setup();
    const plan = world.publishFromMail(op());

    if (!("copies" in plan)) throw new Error("expected publish plan");
    expect(plan.copies).toEqual([
      { from: "t/mbx_a/part/msg_1/2", to: "site/alice/media/hello-world-r1-photo.jpg" },
    ]);
    // Copies land only in the public site namespace; private keys are never exposed.
    expect(plan.copies.every((c) => c.to.startsWith("site/alice/media/"))).toBe(true);
    expect(world.publicPost("hello-world")?.html).toContain("<b>there</b>");

    world.edit("usr_alice", plan.postId, {
      title: "Hello World",
      html: "<p>edited</p>",
      text: "edited",
      media: [],
    });
    expect(world.publicPost("hello-world")?.html).not.toContain("edited");
    expect(world.preview("usr_alice", plan.postId).html).toContain("edited");
    expect(() => world.preview("usr_bob", plan.postId)).toThrow("author");
    world.publish("usr_alice", plan.postId);
    expect(world.publicPost("hello-world")?.revision).toBe(2);

    // Cache purging is the site writer's job (it knows the public `/@handle/…` URLs); the plan
    // carries no purge paths of its own.
    const un = world.unpublish("usr_alice", plan.postId);
    expect(un).toEqual({ postId: plan.postId, revision: 2, copies: [] });
    expect(world.publicPost("hello-world")).toBeUndefined();
  });

  it("[P01] drafts stay private and slugs are unique; RSS escapes content", () => {
    const { world } = setup();
    world.publishFromMail(op({ publish: false }));
    expect(world.publicPosts()).toHaveLength(0);
    world.publishFromMail(op({ title: "Hello World", html: "<script>x</script> & ]]>" }));
    world.publishFromMail(op({ title: "Hello World" }));
    expect(
      world
        .publicPosts()
        .map((p) => p.slug)
        .sort(),
    ).toEqual(["hello-world-2", "hello-world-3"]);
    const rss = world.rss("https://world.bye.test");
    expect(rss).toContain("Alice &lt;writes&gt; &amp; more");
    expect(rss).not.toContain("<script>");
    expect(rss).toMatch(/<link>https:\/\/world\.bye\.test\/@alice\/hello-world[^<]*<\/link>/);
    expect(rssEscape("a\u0001b")).toBe("ab");
  });
});

describe("World subscriptions", () => {
  it("[P02] double opt-in; unsubscribe racing confirmation wins", async () => {
    const { world } = setup();
    const { confirmToken } = await world.subscribe("Reader@Example.test");
    expect(world.subscriberStatus("reader@example.test")).toBe("pending");
    await world.unsubscribe(
      "reader@example.test",
      await world.unsubscribeToken("reader@example.test"),
    );
    expect(await world.confirm(confirmToken!)).toBe(false);
    expect(world.subscriberStatus("reader@example.test")).toBe("unsubscribed");

    const again = await world.subscribe("reader@example.test");
    expect(await world.confirm(again.confirmToken!)).toBe(true);
    expect(await world.confirm(again.confirmToken!)).toBe(false);
    expect(await world.unsubscribe("reader@example.test", "forged")).toBe(false);
    expect(world.subscriberStatus("reader@example.test")).toBe("confirmed");
  });

  it("[P02] unsubscribe links survive a SESSION_KEY rotation: signed with current, verified with the ring", async () => {
    const storage = new MemoryDurableStorage();
    const clock = new TestClock();
    const before = new WorldStore(storage, clock, "unsub-secret");
    before.init({
      authorId: "usr_alice",
      handle: "alice",
      title: "A",
      addresses: ["alice@bye.test"],
    });

    for (const a of ["old@example.test", "new@example.test", "gone@example.test"])
      await before.confirm((await before.subscribe(a)).confirmToken!);
    const oldToken = await before.unsubscribeToken("old@example.test");
    const goneToken = await before.unsubscribeToken("gone@example.test");

    const rotated = new WorldStore(storage, clock, "v2:rotated-secret,v1:unsub-secret");
    const newToken = await rotated.unsubscribeToken("new@example.test");
    expect(newToken).not.toBe(await before.unsubscribeToken("new@example.test"));
    expect(await rotated.unsubscribe("old@example.test", oldToken)).toBe(true);
    expect(await rotated.unsubscribe("new@example.test", newToken)).toBe(true);
    expect(rotated.subscriberStatus("old@example.test")).toBe("unsubscribed");

    // Once v1 leaves the ring, links signed under it stop verifying.
    const retired = new WorldStore(storage, clock, "v2:rotated-secret");
    expect(await retired.unsubscribe("gone@example.test", goneToken)).toBe(false);
    expect(retired.subscriberStatus("gone@example.test")).toBe("confirmed");
  });

  it("[P02] CSV import creates invitations, not opt-ins, and never re-invites unsubscribed addresses", async () => {
    const { world } = setup();
    const gone = await world.subscribe("gone@example.test");
    await world.confirm(gone.confirmToken!);
    await world.unsubscribe("gone@example.test", await world.unsubscribeToken("gone@example.test"));

    const { invitations, skipped } = await world.importCsv(
      "usr_alice",
      "email,name\nnew@example.test,New\nNEW@example.test,Dup\nbad-address\ngone@example.test\n",
    );

    expect(invitations.map((i) => i.address)).toEqual(["new@example.test"]);
    expect(skipped).toEqual(["NEW@example.test", "bad-address", "gone@example.test"]);
    expect(world.subscriberStatus("new@example.test")).toBe("pending");
    expect(world.exportSubscribers("usr_alice")).toBe("email,confirmed_at\n");
    await expect(world.importCsv("usr_bob", "x@example.test")).rejects.toThrow("author");
  });

  it("[P02] one confirmation mail per pending address per 24h; uninitialized worlds refuse", async () => {
    const { world, clock } = setup();
    const first = await world.subscribe("victim@example.test");
    expect(first.confirmToken).toBeDefined();

    for (let i = 0; i < 5; i++)
      expect((await world.subscribe("victim@example.test")).confirmToken).toBeUndefined();
    // The first link is still the valid one.
    clock.advance(SUBSCRIBE_CONFIRM_COOLDOWN_MS - 1);
    expect((await world.subscribe("victim@example.test")).confirmToken).toBeUndefined();
    clock.advance(1);
    const later = await world.subscribe("victim@example.test");
    expect(later.confirmToken).toBeDefined();
    expect(await world.confirm(later.confirmToken!)).toBe(true);
    // A World that was never set up creates no subscriber state.
    const bare = new WorldStore(new MemoryDurableStorage(), new TestClock(), "s");
    await expect(bare.subscribe("victim@example.test")).rejects.toThrow("world not initialized");
  });

  it("[P02] CSV import commits in chunks and applies the same rules to every row", async () => {
    const { world } = setup();
    const addresses = Array.from({ length: 250 }, (_, i) => `r${i}@example.test`);
    await world.subscribe("r7@example.test"); // already invited: inside the cooldown
    const { invitations, skipped } = await world.importCsv("usr_alice", addresses.join("\n"));
    expect(invitations).toHaveLength(249);
    expect(skipped).toEqual(["r7@example.test"]);
    expect(new Set(invitations.map((i) => i.token)).size).toBe(249);
    expect(await world.confirm(invitations[200]!.token)).toBe(true);
    expect(world.subscriberStatus(invitations[200]!.address)).toBe("confirmed");
  });

  const subscribe = async (world: WorldStore, a: string) => {
    const { confirmToken } = await world.subscribe(a);
    expect(await world.confirm(confirmToken!)).toBe(true);
  };

  const cfg = { provider: "resend", account: "acct", configVersion: "v1#qual" };

  const approve = (world: WorldStore, postId: string) =>
    world.newsletter.approve({
      ...cfg,
      postId,
      revision: 1,
      sender: "@alice <world@bye.test>",
      subject: "Hello World",
      fingerprint: "fp",
      scheduledAt: null,
    });

  it("[P02] a publication snapshots the eligible audience once; later subscriptions never expand it", async () => {
    const { world } = setup();

    for (const a of ["a@example.test", "b@example.test", "c@example.test"])
      await subscribe(world, a);
    const plan = world.publishFromMail(op());
    const p = approve(world, plan.postId);
    expect(p.recipients).toBe(3);
    expect(approve(world, plan.postId).id).toBe(p.id);
    await subscribe(world, "late@example.test");
    expect(world.newsletter.publication(p.id)?.recipients).toBe(3);
    // Removals narrow the snapshot; additions stay out of the provider sync while it is open.
    await world.unsubscribe("b@example.test", await world.unsubscribeToken("b@example.test"));
    expect(world.newsletter.snapshotEligible(p.id)).toMatchObject({ snapshot: 3, eligible: 2 });
    const due = world.newsletter.dueSync(50);
    expect(due.map((d) => [d.address, d.subscribed])).toEqual([
      ["b@example.test", false],
      ["a@example.test", true],
      ["c@example.test", true],
    ]);

    // The late subscriber is not part of this publication's freshness.
    for (const d of due)
      world.newsletter.settleSync(d.address, d.revision, {
        _tag: "Accepted",
        providerRef: d.address,
      });
    expect(world.newsletter.freshness(p.id)).toEqual({ pending: 0, held: 0 });
    expect(world.newsletter.syncState().pending).toBe(1);
  });

  it("[P02] consent is creator-scoped with history; stale or provider positives never reactivate an unsubscribe", async () => {
    const { world, clock } = setup();
    await subscribe(world, "r@example.test");
    clock.advance(10);
    await world.unsubscribe("r@example.test", await world.unsubscribeToken("r@example.test"));
    // A provider "subscribed" observation is not consent.
    expect(
      world.newsletter.applyEvent({
        eventId: "e1",
        kind: "contact-subscribed",
        rawType: "contact.updated",
        address: "r@example.test",
        occurredAt: clock.now() + 5,
      }),
    ).toBe("ignored");
    expect(world.subscriberStatus("r@example.test")).toBe("unsubscribed");
    // Duplicate events are no-ops.
    expect(
      world.newsletter.applyEvent({
        eventId: "e1",
        kind: "contact-subscribed",
        rawType: "contact.updated",
        address: "r@example.test",
        occurredAt: clock.now(),
      }),
    ).toBe("duplicate");
    // Only new recorded consent re-subscribes.
    clock.advance(10);
    await subscribe(world, "r@example.test");
    expect(world.subscriberStatus("r@example.test")).toBe("confirmed");
    expect(
      world.newsletter.consentHistory("r@example.test").map((h) => [h.change, h.applied]),
    ).toEqual([
      ["Confirm", true],
      ["Unsubscribe", true],
      ["ProviderSubscribed", false],
      ["Confirm", true],
    ]);
  });

  it("[P02] bounces/complaints are restrictions apart from consent, and re-consent never clears them", async () => {
    const { world } = setup();
    await subscribe(world, "c@example.test");
    const plan = world.publishFromMail(op());
    const p = approve(world, plan.postId);
    world.newsletter.setPublication(p.id, { state: "submitted", providerRef: "bc_1" });
    expect(
      world.newsletter.applyEvent({
        eventId: "e2",
        kind: "complaint",
        rawType: "email.complained",
        address: "c@example.test",
        broadcastRef: "bc_1",
        occurredAt: 1,
      }),
    ).toBe("applied");
    expect(world.subscriberStatus("c@example.test")).toBe("suppressed");
    expect(world.newsletter.consent("c@example.test")?.status).toBe("confirmed");
    expect((await world.subscribe("c@example.test")).confirmToken).toBeUndefined();
    expect(world.newsletter.eligible("c@example.test")).toBe(false);
    // A late delivery never overwrites the complaint; events for unknown broadcasts are retained, not applied.
    world.newsletter.applyEvent({
      eventId: "e3",
      kind: "delivered",
      rawType: "email.delivered",
      address: "c@example.test",
      broadcastRef: "bc_1",
      occurredAt: 0,
    });
    expect(world.newsletter.status(p.id).outcomes).toEqual({ complaint: 1 });
    expect(
      world.newsletter.applyEvent({
        eventId: "e4",
        kind: "delivered",
        rawType: "email.delivered",
        address: "c@example.test",
        broadcastRef: "bc_other",
        occurredAt: 0,
      }),
    ).toBe("unmapped");
    // An account-wide provider unsubscribe is a provider-scope restriction, not a list unsubscribe.
    await subscribe(world, "g@example.test");
    world.newsletter.applyEvent({
      eventId: "e5",
      kind: "contact-unsubscribed",
      rawType: "contact.updated",
      address: "g@example.test",
      scope: "provider",
      occurredAt: 2,
    });
    expect(world.newsletter.restrictions("g@example.test")).toEqual([
      { kind: "provider-unsubscribe", scope: "provider", reason: "provider contact.updated" },
    ]);
  });

  it("[P02] operations are claimed before the call; an expired lease is unknown and held without idempotency", () => {
    const { world, clock } = setup();
    const L = world.newsletter;
    expect(L.claimOp("op1", "send", null, null)._tag).toBe("Proceed");
    // Serialized: a live lease is never re-attempted.
    expect(L.claimOp("op1", "send", null, null)._tag).toBe("Skip");
    clock.advance(6 * 60_000);
    const again = L.claimOp("op1", "send", null, null);
    expect(again._tag).toBe("Reconcile");
    expect(L.operation("op1")?.state).toBe("unknown");
    expect(L.reconcileOp("op1", "inconclusive").state).toBe("held");
    expect(L.claimOp("op1", "send", null, null)._tag).toBe("Skip");
    // With provider idempotency inside its window, the same request may be retried.
    const idem = { scope: "account", windowMs: 24 * 3600_000 };
    expect(L.claimOp("op2", "send", null, idem)._tag).toBe("Proceed");
    L.settleOp("op2", { _tag: "Unknown", detail: "timeout" }, idem);
    clock.advance(10 * 60_000);
    expect(L.claimOp("op2", "send", null, idem)._tag).toBe("Proceed");
    L.settleOp("op2", { _tag: "Accepted", providerRef: "bc_9" }, idem);
    expect(L.claimOp("op2", "send", null, idem)._tag).toBe("Skip");
    // Past the window, the same unknown outcome is held instead.
    expect(L.claimOp("op3", "send", null, idem)._tag).toBe("Proceed");
    L.settleOp("op3", { _tag: "Unknown", detail: "timeout" }, idem);
    clock.advance(25 * 3600_000);
    expect(L.claimOp("op3", "send", null, idem)._tag).toBe("Reconcile");
  });

  it("[P02] cancellation is local and complete before submission, requested after it", async () => {
    const { world } = setup();
    await subscribe(world, "a@example.test");
    const plan = world.publishFromMail(op());
    const p = approve(world, plan.postId);
    expect(world.cancelNewsletter("usr_alice", plan.postId, 1).cancel).toEqual({
      _tag: "Confirmed",
      coverage: "complete",
    });
    expect(() => world.cancelNewsletter("usr_bob", plan.postId, 1)).toThrow("author");
    const plan2 = world.publishFromMail(op({ title: "Second" }));
    const p2 = approve(world, plan2.postId);
    world.newsletter.setPublication(p2.id, { state: "submitted", providerRef: "bc_2" });
    expect(world.newsletter.requestCancel(p2.id).cancel).toEqual({ _tag: "Requested" });
    // Provider-observed cancel during sending is partial coverage; states never regress.
    world.newsletter.observe(p2.id, "sending");
    expect(world.newsletter.observe(p2.id, "cancelled").cancel).toEqual({
      _tag: "Confirmed",
      coverage: "partial",
    });
    expect(world.newsletter.observe(p2.id, "queued").observed).toBe("cancelled");
    expect(world.newsletter.publication(p.id)?.state).toBe("cancelled");
  });

  it("[P01] the author lists drafts and published posts; public media keys live under the site path", () => {
    const { world } = setup();

    const plan = world.publishFromMail({
      ...op(),
      media: [
        {
          contentKey: "t/usr_alice/world-media/m1",
          name: "Cover Photo.PNG",
          contentType: "image/png",
        },
      ],
    });

    expect("copies" in plan && plan.copies[0]?.to).toMatch(
      /^site\/alice\/media\/[a-z0-9-]+-r1-cover-photo\.png$/,
    );

    const draft = world.createDraft("usr_alice", {
      title: "Later",
      html: "<p>x</p>",
      text: "x",
      media: [],
    });

    expect(world.listPosts("usr_alice").map((p) => [p.id, p.status])).toEqual([
      [draft.postId, "draft"],
      [plan.postId, "published"],
    ]);
    expect(() => world.listPosts("usr_bob")).toThrow("author");
  });

  const rejectionCode = (f: () => void) => {
    try {
      f();

      return "ok";
    } catch (e) {
      return e instanceof Rejection ? e.code : String(e);
    }
  };

  /** Drive an op to `held`: unknown outcome without idempotency, then inconclusive reconciliation. */
  const holdOp = (world: WorldStore, clock: TestClock, opId: string) => {
    const L = world.newsletter;
    expect(L.claimOp(opId, "send", null, null)._tag).toBe("Proceed");
    L.settleOp(opId, { _tag: "Unknown", detail: "timeout" }, null);
    clock.advance(6 * 60_000);
    expect(L.claimOp(opId, "send", null, null)._tag).toBe("Reconcile");
    expect(L.reconcileOp(opId, "inconclusive").state).toBe("held");
  };

  it("[P02] an operator resolving a held op as accepted records the evidence and never re-sends", () => {
    const { world, clock } = setup();
    const L = world.newsletter;
    holdOp(world, clock, "op_a");
    const attempts = L.operation("op_a")!.attempts;
    expect(L.resolveHeldOp("op_a", "accepted", "seen in provider dashboard", "bc_7")).toMatchObject(
      {
        state: "accepted",
        providerRef: "bc_7",
        detail: "operator: seen in provider dashboard",
      },
    );
    clock.advance(60 * 60_000);
    expect(L.claimOp("op_a", "send", null, null)._tag).toBe("Skip");
    expect(L.operation("op_a")!.attempts).toBe(attempts);
    // A settled op cannot be resolved again (e.g. flipped to not-accepted and re-sent).
    expect(rejectionCode(() => L.resolveHeldOp("op_a", "not-accepted", "oops"))).toBe("conflict");
    expect(rejectionCode(() => L.resolveHeldOp("op_missing", "accepted", "x"))).toBe("not_found");
  });

  it("[P02] an operator resolving a held op as not accepted allows exactly one retry", () => {
    const { world, clock } = setup();
    const L = world.newsletter;
    holdOp(world, clock, "op_b");
    expect(L.resolveHeldOp("op_b", "not-accepted", "absent at provider")).toMatchObject({
      state: "pending",
      providerRef: null,
      detail: "operator: absent at provider",
    });
    expect(L.heldOps()).toEqual([]);
    expect(L.claimOp("op_b", "send", null, null)._tag).toBe("Proceed");
    // The retry holds a lease: a concurrent claim cannot send a second time.
    expect(L.claimOp("op_b", "send", null, null)._tag).toBe("Skip");
    L.settleOp("op_b", { _tag: "Accepted", providerRef: "bc_8" }, null);
    expect(L.claimOp("op_b", "send", null, null)._tag).toBe("Skip");
    expect(rejectionCode(() => L.resolveHeldOp("op_b", "accepted", "x"))).toBe("conflict");
  });

  it("[P02] resuming a held publication derives its state from recorded create/send outcomes", async () => {
    const { world, clock } = setup();
    const L = world.newsletter;
    await subscribe(world, "a@example.test");
    const p = approve(world, world.publishFromMail(op()).postId);
    expect(rejectionCode(() => L.resumeHeld(p.id))).toBe("conflict"); // not held
    L.setPublication(p.id, { state: "held" });
    // Create accepted, send outcome unresolved: resume is refused.
    expect(L.claimOp(`${p.id}:create`, "create", p.id, null)._tag).toBe("Proceed");
    L.settleOp(`${p.id}:create`, { _tag: "Accepted", providerRef: "draft_1" }, null);
    holdOp(world, clock, `${p.id}:send`);
    expect(rejectionCode(() => L.resumeHeld(p.id))).toBe("conflict");
    // Operator confirms the send reached the provider: resume jumps to submitted, never re-sends.
    L.resolveHeldOp(`${p.id}:send`, "accepted", "broadcast visible", "bc_1");
    expect(L.resumeHeld(p.id)).toMatchObject({
      state: "submitted",
      providerRef: "draft_1",
      detail: "resumed by operator",
    });
    expect(L.claimOp(`${p.id}:send`, "send", p.id, null)._tag).toBe("Skip");

    // Second publication: send proven absent -> resume returns to drafted so the send runs once.
    const p2 = approve(world, world.publishFromMail(op({ title: "Second" })).postId);
    L.setPublication(p2.id, { state: "held" });
    expect(L.claimOp(`${p2.id}:create`, "create", p2.id, null)._tag).toBe("Proceed");
    L.settleOp(`${p2.id}:create`, { _tag: "Accepted", providerRef: "draft_2" }, null);
    holdOp(world, clock, `${p2.id}:send`);
    L.resolveHeldOp(`${p2.id}:send`, "not-accepted", "absent");
    expect(L.resumeHeld(p2.id)).toMatchObject({ state: "drafted", providerRef: "draft_2" });
    expect(L.claimOp(`${p2.id}:send`, "send", p2.id, null)._tag).toBe("Proceed");

    // Third: nothing reached the provider -> back to approved.
    const p3 = approve(world, world.publishFromMail(op({ title: "Third" })).postId);
    L.setPublication(p3.id, { state: "held" });
    expect(L.resumeHeld(p3.id).state).toBe("approved");
  });

  it("[P02] audience drift lists synced provider contacts outside the approved snapshot", async () => {
    const { world } = setup();
    const L = world.newsletter;
    await subscribe(world, "a@example.test");
    const p = approve(world, world.publishFromMail(op()).postId);
    await subscribe(world, "late@example.test");

    const syncAll = () => {
      for (const d of L.dueSync(50))
        L.settleSync(d.address, d.revision, { _tag: "Accepted", providerRef: d.address });
    };

    // While the publication is open the late addition is held back, so there is no drift.
    syncAll();
    expect(L.audienceDrift(p.id)).toEqual([]);
    // Once it is no longer open, the addition syncs and shows up as drift against its snapshot.
    L.setPublication(p.id, { state: "sent" });
    syncAll();
    expect(L.audienceDrift(p.id)).toEqual(["late@example.test"]);
  });

  it("[P02] a creator's audience mapping is never silently replaced", () => {
    const { world } = setup();
    const L = world.newsletter;
    const mapping = { ...cfg, audienceId: "aud_1" };
    expect(L.audience()).toBeUndefined();
    L.mapAudience(mapping);
    L.mapAudience({ ...mapping, configVersion: "v2", scopeId: "topic_1" }); // same audience: update
    expect(L.audience()).toEqual({ ...mapping, configVersion: "v2", scopeId: "topic_1" });

    for (const other of [
      { ...mapping, audienceId: "aud_2" },
      { ...mapping, account: "acct_2" },
      { ...mapping, provider: "other" },
    ])
      expect(rejectionCode(() => L.mapAudience(other))).toBe("conflict");
    expect(L.audience()?.audienceId).toBe("aud_1");
  });
});

describe("World erasure", () => {
  it("[§12] erase wipes the author's world and releases the handle", async () => {
    const { world } = setup();
    world.publishFromMail(op());
    const { confirmToken } = await world.subscribe("a@example.test");
    await world.confirm(confirmToken!);
    expect(world.erase("usr_alice")).toBe(true);
    expect(world.ownerId()).toBeNull();
    expect(world.subscriberStatus("a@example.test")).toBeUndefined();
    expect(() => world.listPosts("usr_alice")).toThrow(Rejection);
    // Released handle can be claimed by a new author, who starts empty.
    world.init({ authorId: "usr_carol", handle: "alice", title: "C", addresses: ["c@bye.test"] });
    expect(world.listPosts("usr_carol")).toEqual([]);
  });

  it("[§12] erase refuses a non-owner, so a replayed tombstone never wipes a re-claimed handle", () => {
    const { world } = setup();
    const plan = world.publishFromMail(op());
    expect(world.erase("usr_bob")).toBe(false);
    // Legacy tombstone without an author only erases an unowned handle.
    expect(world.erase(null)).toBe(false);
    expect(world.ownerId()).toBe("usr_alice");
    expect(world.listPosts("usr_alice").map((p) => p.id)).toEqual([plan.postId]);
    expect(world.erase("usr_alice")).toBe(true);
    world.init({ authorId: "usr_carol", handle: "alice", title: "C", addresses: ["c@bye.test"] });
    const carol = world.createDraft("usr_carol", { title: "Mine", html: "", text: "", media: [] });
    expect(world.erase("usr_alice")).toBe(false);
    expect(world.listPosts("usr_carol").map((p) => p.id)).toEqual([carol.postId]);
    // Once unowned, a legacy (null) tombstone may erase.
    expect(world.erase("usr_carol")).toBe(true);
    expect(world.erase(null)).toBe(true);
  });
});
