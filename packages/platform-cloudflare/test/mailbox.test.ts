import { describe, expect, it } from "vitest";
import { applyMailboxCommand } from "@bye/platform-cloudflare";
import { cmd, deliveryFixture, makeTestMailbox, summaryFixture } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const setup = () => {
  const m = makeTestMailbox();
  const deliver = (
    over: Parameters<typeof summaryFixture>[0] = {},
    extra: Parameters<typeof deliveryFixture>[2] = {},
  ) => {
    m.clock.advance(1000);
    return m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture(over), extra));
  };
  const allow = (sender: string, destination: "imbox" | "feed" | "paper-trail" = "imbox") =>
    m.store.screener.screen([{ sender, decision: "allow", destination }]);
  return { ...m, deliver, allow };
};

describe("screening and routing", () => {
  it("[E01] unknown senders wait in the Screener, outside normal views", () => {
    const m = setup();
    const r = m.deliver({ fromAddress: "stranger@example.com" });
    expect(r.disposition).toBe("screening");
    expect(m.store.views.listView({ view: "imbox" }).items).toHaveLength(0);
    expect(m.store.views.listView({ view: "screener" }).items.map((t) => t.threadId)).toEqual([
      r.threadId,
    ]);
    expect(m.store.screener.screenerSenders()).toEqual([
      expect.objectContaining({ sender: "stranger@example.com", threads: 1 }),
    ]);
  });

  it("[E01] approve-as-seen and approve-and-reply in one action; bulk decisions", () => {
    const m = setup();
    const a = m.deliver({ fromAddress: "a@example.com" });
    m.deliver({ fromAddress: "b@example.com" });
    const c = m.deliver({ fromAddress: "c@example.com" });
    const out = m.store.screener.screen([
      { sender: "a@example.com", decision: "allow", asSeen: true },
      { sender: "b@example.com", decision: "block" },
      { sender: "c@example.com", decision: "allow", reply: true },
    ]);
    expect(out.moved).toBe(3);
    expect(out.draftIds).toHaveLength(1);
    const imbox = m.store.views.imbox();
    expect(imbox.previouslySeen.map((t) => t.threadId)).toEqual([a.threadId]);
    expect(imbox.newForYou.map((t) => t.threadId)).toEqual([c.threadId]);
    expect(m.store.views.listView({ view: "screened-out" }).items).toHaveLength(1);
    expect(m.store.drafts.draft(out.draftIds[0]!)!.content.to[0]!.address).toBe("c@example.com");
  });

  it("[E01] clearing the Screener never approves senders; reading in Screener does not approve", () => {
    const m = setup();
    const r = m.deliver({ fromAddress: "x@example.com" });
    m.store.views.markSeen(r.threadId, 1);
    expect(m.store.views.getThread(r.threadId).thread.disposition).toBe("screening");
    const boundary = m.store.views.listView({ view: "screener" }).boundary;
    const late = m.deliver({ fromAddress: "late@example.com" });
    expect(m.store.screener.clearScreener(boundary).cleared).toBe(1);
    expect(m.store.ledger.policy("address", "x@example.com")).toBeUndefined();
    // Arrival after the snapshot boundary is not swept into the old action.
    expect(m.store.views.getThread(late.threadId).thread.disposition).toBe("screening");
    expect(m.deliver({ fromAddress: "x@example.com" }).disposition).toBe("screening");
  });

  it("[E01] approval racing arrival: mail committed after approval goes straight to the Imbox", () => {
    const m = setup();
    m.deliver({ fromAddress: "race@example.com" });
    m.allow("race@example.com");
    expect(m.deliver({ fromAddress: "race@example.com" }).disposition).toBe("active");
    expect(m.store.views.listView({ view: "screener" }).items).toHaveLength(0);
  });

  it("[E02] exact rules override domain defaults; decisions are inspectable and reversible", () => {
    const m = setup();
    m.store.screener.setPolicy("domain", "corp.example", {
      decision: "allowed",
      destination: "paper-trail",
      labels: ["corp"],
      bundle: false,
      notify: false,
    });
    m.store.screener.setPolicy("address", "boss@corp.example", {
      decision: "blocked",
      destination: "imbox",
      labels: [],
      bundle: false,
      notify: false,
    });
    expect(m.deliver({ fromAddress: "billing@corp.example" })).toMatchObject({
      disposition: "active",
      destination: "paper-trail",
      decidedBy: "domain-allow",
    });
    expect(m.deliver({ fromAddress: "boss@corp.example" })).toMatchObject({
      disposition: "screened-out",
      decidedBy: "exact-block",
    });
    const history = m.store.ledger.policyHistory("boss@corp.example");
    expect(history).toHaveLength(1);
    m.store.screener.revertPolicy(history[0]!.historyId);
    expect(m.store.ledger.policy("address", "boss@corp.example")).toBeUndefined();
    expect(m.deliver({ fromAddress: "boss@corp.example" }).decidedBy).toBe("domain-allow");
    expect(m.store.ledger.listPolicies().length).toBe(1);
  });

  it("[E02] domain allow versus exact block, and approved-sender spoof goes to spam", () => {
    const m = setup();
    m.allow("friend@example.com");
    const spoof = m.deliver(
      { fromAddress: "friend@example.com" },
      { safety: { _tag: "Spoofed", reason: "dmarc fail" } },
    );
    expect(spoof).toMatchObject({ disposition: "spam", decidedBy: "safety" });
    expect(m.store.views.getThread(spoof.threadId).thread.quarantined).toBe(true);
  });

  it("[E03] Speakeasy bypasses screening only; rotation invalidates the old code; never bypasses safety", () => {
    const m = setup();
    const code = m.store.screener.rotateSpeakeasy();
    expect(m.deliver({ fromAddress: "new@example.com", subject: `Hi ${code}` }).decidedBy).toBe(
      "speakeasy",
    );
    expect(
      m.deliver(
        { fromAddress: "evil@example.com", subject: `Hi ${code}` },
        { safety: { _tag: "Malware", reason: "eicar" } },
      ).disposition,
    ).toBe("spam");
    const next = m.store.screener.rotateSpeakeasy();
    expect(next).not.toBe(code);
    expect(m.deliver({ fromAddress: "new2@example.com", subject: `Hi ${code}` }).disposition).toBe(
      "screening",
    );
  });

  it("[E04] replies become new without archiving; mark-seen respects the observed revision", () => {
    const m = setup();
    m.allow("alice@example.com");
    const first = m.deliver({ messageIdHeader: "root@example.com" });
    expect(m.store.views.markSeen(first.threadId, 1).newForYou).toBe(false);
    const reply = m.deliver({
      subject: "Re: Hello",
      inReplyTo: ["root@example.com"],
      references: ["root@example.com"],
    });
    expect(reply.threadId).toBe(first.threadId);
    expect(m.store.views.imbox().newForYou.map((t) => t.threadId)).toEqual([first.threadId]);
    // Device observed revision 2; a concurrent third message stays new.
    m.deliver({ subject: "Re: Hello", inReplyTo: ["root@example.com"] });
    expect(m.store.views.markSeen(first.threadId, 2).newForYou).toBe(true);
    expect(m.store.views.getThread(first.threadId).thread.messageCount).toBe(3);
  });

  it("[E04] mark-all-seen captures a snapshot; two devices converge", () => {
    const m = setup();
    m.allow("alice@example.com");
    m.allow("bob@example.com");
    m.deliver({ fromAddress: "alice@example.com" });
    const boundary = m.store.views.listView({ view: "imbox" }).boundary;
    const late = m.deliver({ fromAddress: "bob@example.com" });
    expect(m.store.views.markAllSeen("imbox", boundary).marked).toBe(2 - 1);
    expect(m.store.views.imbox().newForYou.map((t) => t.threadId)).toEqual([late.threadId]);
    // A second device replaying with a stale boundary cannot mark the newer thread.
    expect(m.store.views.markAllSeen("imbox", boundary).marked).toBe(0);
  });

  it("[E05] Feed is chronological with new-since-last-visit markers and remembered position", () => {
    const m = setup();
    m.allow("news@example.com", "feed");
    m.deliver({ fromAddress: "news@example.com", subject: "Issue 1" });
    m.store.views.visitView("feed");
    m.clock.advance(5000);
    m.store.views.visitView("feed");
    m.deliver({ fromAddress: "news@example.com", subject: "Issue 2" });
    const items = m.store.views.listView({ view: "feed" }).items;
    expect(items.map((t) => [t.subject, t.newSinceVisit])).toEqual([
      ["Issue 2", true],
      ["Issue 1", false],
    ]);
    m.store.views.setViewPosition("feed", items[1]!.threadId);
    expect(m.store.views.viewPosition("feed")).toBe(items[1]!.threadId);
  });

  it("[E06] Paper Trail receives receipts via sender rules and bundles collapse per sender", () => {
    const m = setup();
    m.store.screener.screen([
      {
        sender: "receipts@shop.example",
        decision: "allow",
        destination: "paper-trail",
        bundle: true,
      },
    ]);
    m.deliver({ fromAddress: "receipts@shop.example", subject: "Order 1" });
    m.deliver({ fromAddress: "receipts@shop.example", subject: "Order 2" });
    const page = m.store.views.listView({ view: "paper-trail" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      bundleKey: "receipts@shop.example",
      bundleCount: 2,
      subject: "Order 2",
    });
    expect(m.store.views.bundle("receipts@shop.example")).toHaveLength(2);
    m.store.views.visitView("paper-trail", "pos-1");
    expect(m.store.views.viewPosition("paper-trail")).toBe("pos-1");
  });
});

describe("attention piles", () => {
  it("[E07] Reply Later queue persists and orders Focus & Reply", () => {
    const m = setup();
    m.allow("alice@example.com");
    const a = m.deliver({ subject: "A" });
    const b = m.deliver({ subject: "B" });
    m.store.triage.setAttention(b.threadId, "replyLater", true);
    m.clock.advance(10);
    m.store.triage.setAttention(a.threadId, "replyLater", true);
    expect(m.store.views.focusQueue().map((f) => f.thread.subject)).toEqual(["B", "A"]);
    expect(m.store.views.focusQueue()[0]!.latest?.subject).toBe("B");
  });

  it("[E08] Set Aside is a reference pile, not archive or delete; send-and-mark-done completes it", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "sa@example.com" });
    m.store.views.markSeen(t.threadId, 1);
    m.store.triage.setAttention(t.threadId, "setAside", true);
    expect(m.store.views.listView({ view: "set-aside" }).items).toHaveLength(1);
    expect(m.store.views.getThread(t.threadId).thread.disposition).toBe("active");
    const draftId = m.store.drafts.createReplyDraft(
      t.threadId,
      "reply",
      m.store.views.getThread(t.threadId).deliveries,
    );
    const sent = m.store.sends.send(draftId, {
      expectedRevision: 1,
      afterSend: { _tag: "MarkDone" },
      undoMs: 0,
    });
    if (sent._tag !== "Queued") throw new Error("expected queued");
    m.store.runDueJobs(m.clock.now());
    m.store.sends.claim(sent.sendJobIds[0]!);
    m.store.sends.accepted(sent.sendJobIds[0]!, { providerId: "p1" });
    expect(m.store.views.listView({ view: "set-aside" }).items).toHaveLength(0);
  });

  it("[E09] Bubble Up schedules, pops, pins; a new reply surfaces promptly and stale generations do nothing", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "bub@example.com" });
    m.store.views.markSeen(t.threadId, 1);
    const at = m.clock.now() + 3600_000;
    const { generation } = m.store.triage.bubbleUp(t.threadId, at);
    expect(m.store.views.listView({ view: "bubble-up" }).items).toHaveLength(1);
    expect(m.store.views.imbox().previouslySeen).toHaveLength(0);
    // New reply: returns to New For You as one row and invalidates the bubble job.
    m.deliver({ subject: "Re: Hello", inReplyTo: ["bub@example.com"] });
    expect(m.store.views.imbox().newForYou.map((x) => x.threadId)).toEqual([t.threadId]);
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
    m.clock.advance(7200_000);
    expect(m.store.runDueJobs(m.clock.now())).toEqual({ ran: 0, stale: 0, failed: [] });
    expect(generation).toBeGreaterThan(0);
    // Timer path.
    m.store.views.markSeen(t.threadId, 99);
    m.store.triage.bubbleUp(t.threadId, m.clock.now() + 1000);
    m.clock.advance(2000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(1);
    expect(m.store.views.getThread(t.threadId).thread.newForYou).toBe(true);
    // Pin and pop.
    m.store.triage.pinBubble(t.threadId);
    expect(m.store.views.imbox().bubbledUp.map((x) => x.threadId)).toEqual([t.threadId]);
    m.store.triage.popBubble(t.threadId);
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
  });

  it("[E09] send-and-bubble schedules a bubble after acceptance; cancelled bubble cannot resurrect", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "snp@example.com" });
    const draftId = m.store.drafts.createReplyDraft(
      t.threadId,
      "reply",
      m.store.views.getThread(t.threadId).deliveries,
    );
    const at = m.clock.now() + 86_400_000;
    const sent = m.store.sends.send(draftId, {
      expectedRevision: 1,
      afterSend: { _tag: "BubbleUp", at },
      undoMs: 0,
    });
    if (sent._tag !== "Queued") throw new Error();
    m.store.runDueJobs(m.clock.now());
    m.store.sends.claim(sent.sendJobIds[0]!);
    m.store.sends.accepted(sent.sendJobIds[0]!, { providerId: "p" });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble).toMatchObject({
      _tag: "Scheduled",
      at,
    });
    m.store.triage.clearBubble(t.threadId);
    m.clock.advance(90_000_000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
  });

  const sendReply = (
    m: ReturnType<typeof setup>,
    threadId: string,
    afterSend: Parameters<typeof m.store.sends.send>[1]["afterSend"],
  ) => {
    const draftId = m.store.drafts.createReplyDraft(
      threadId,
      "reply",
      m.store.views.getThread(threadId).deliveries,
    );
    const sent = m.store.sends.send(draftId, {
      expectedRevision: 1,
      ...(afterSend ? { afterSend } : {}),
      undoMs: 0,
    });
    if (sent._tag !== "Queued") throw new Error("expected queued");
    m.store.runDueJobs(m.clock.now());
    m.store.sends.claim(sent.sendJobIds[0]!);
    return sent.sendJobIds[0]!;
  };

  it("[E09] if-no-reply bubble ignores automated and own mail, yields to a real reply", () => {
    const m = setup();
    m.allow("alice@example.com");
    m.allow("mailer-daemon@example.com");
    m.allow("me@bye.test");
    const t = m.deliver({ messageIdHeader: "nr@example.com" });
    const at = m.clock.now() + 86_400_000;
    const job = sendReply(m, t.threadId, { _tag: "BubbleUp", at, condition: "if-no-reply" });
    // Nothing happens before the provider accepts the message.
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
    m.store.sends.accepted(job, { providerId: "p" });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble).toMatchObject({
      _tag: "Scheduled",
      at,
      condition: "if-no-reply",
    });
    // An away reply, a bounce and the user's own copy from another client do not count.
    m.deliver({ inReplyTo: ["nr@example.com"], automated: true, subject: "Out of office" });
    m.deliver({
      fromAddress: "mailer-daemon@example.com",
      inReplyTo: ["nr@example.com"],
      automated: true,
    });
    m.deliver({ fromAddress: "me@bye.test", inReplyTo: ["nr@example.com"] });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("Scheduled");
    // A real reply from a recipient suppresses the bubble; the timer then does nothing.
    m.deliver({ inReplyTo: ["nr@example.com"], subject: "Re: Hello" });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
    expect(m.store.views.getThread(t.threadId).thread.newForYou).toBe(true);
    m.clock.advance(90_000_000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
  });

  it("[E09] if-no-reply bubble resurfaces on time when nobody answers", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "nr2@example.com" });
    m.store.views.markSeen(t.threadId, 99);
    m.store.triage.bubbleUp(t.threadId, m.clock.now() + 1000, "if-no-reply");
    m.deliver({ inReplyTo: ["nr2@example.com"], automated: true });
    m.store.views.markSeen(t.threadId, 99);
    m.clock.advance(2000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(1);
    expect(m.store.views.getThread(t.threadId).thread.newForYou).toBe(true);
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
  });

  it("[E09] send-and-pop resolves the bubble on acceptance without resurfacing the thread", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "pop@example.com" });
    m.store.views.markSeen(t.threadId, 99);
    m.store.triage.pinBubble(t.threadId);
    const job = sendReply(m, t.threadId, { _tag: "ClearBubble" });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("Pinned");
    m.store.sends.accepted(job, { providerId: "p" });
    const thread = m.store.views.getThread(t.threadId).thread;
    expect(thread.attention.bubble._tag).toBe("None");
    expect(thread.newForYou).toBe(false);
    expect(m.store.views.listView({ view: "bubble-up" }).items).toHaveLength(0);
  });

  it("[E09] send jobs queued before bubble conditions existed keep an unconditional bubble", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ messageIdHeader: "n1@example.com" });
    const at = m.clock.now() + 86_400_000;
    // N−1 wire shape: no `condition` field.
    const job = sendReply(m, t.threadId, { _tag: "BubbleUp", at });
    m.store.sends.accepted(job, { providerId: "p" });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble).toMatchObject({
      _tag: "Scheduled",
      condition: "always",
    });
    // Unconditional bubbles keep the §4.2 rule: any new reply surfaces the thread and cancels it.
    m.deliver({ inReplyTo: ["n1@example.com"], automated: true });
    expect(m.store.views.getThread(t.threadId).thread.attention.bubble._tag).toBe("None");
  });

  it("[E10] Read Together batches keep their order while new mail arrives", () => {
    const m = setup();
    m.allow("alice@example.com");
    m.allow("bob@example.com");
    const a = m.deliver({ fromAddress: "alice@example.com", messageIdHeader: "rt-a@x" });
    const b = m.deliver({ fromAddress: "bob@example.com" });
    const batch = m.store.views.createBatch("new-for-you");
    expect(batch.threadIds).toEqual([b.threadId, a.threadId]);
    m.deliver({ fromAddress: "alice@example.com", inReplyTo: ["rt-a@x"] });
    m.deliver({ fromAddress: "carol@example.com" });
    expect(m.store.views.batch(batch.batchId).map((x) => x.thread.threadId)).toEqual([
      b.threadId,
      a.threadId,
    ]);
    expect(m.store.views.batch(batch.batchId)[1]!.deliveries).toHaveLength(2);
  });
});

describe("thread controls and organization", () => {
  it("[E11] unfollow, local rename, and reversible manual merge preserve originals", () => {
    const m = setup();
    m.allow("alice@example.com");
    const a = m.deliver({ subject: "Plan", messageIdHeader: "p1@x" });
    const b = m.deliver({ subject: "Other" });
    m.store.triage.renameThread(a.threadId, "Launch plan");
    expect(m.store.views.getThread(a.threadId).thread).toMatchObject({
      subject: "Launch plan",
      originalSubject: "Plan",
    });
    const { mergeId } = m.store.triage.mergeThreads(a.threadId, [b.threadId]);
    const merged = m.store.views.getThread(a.threadId);
    expect(merged.deliveries).toHaveLength(2);
    expect(merged.deliveries.map((d) => d.originalThreadId)).toContain(b.threadId);
    expect(m.store.views.getThread(b.threadId).thread.threadId).toBe(a.threadId);
    expect(m.store.views.mergeHistory(a.threadId)).toHaveLength(1);
    m.store.triage.unmergeThreads(mergeId);
    expect(m.store.views.getThread(b.threadId).deliveries.map((d) => d.subject)).toEqual(["Other"]);
    expect(m.store.views.getThread(a.threadId).deliveries).toHaveLength(1);
    m.store.views.markSeen(a.threadId, 99);
    m.store.triage.setAttention(a.threadId, "unfollowed", true);
    m.deliver({ subject: "Re: Plan", inReplyTo: ["p1@x"] });
    expect(m.store.views.getThread(a.threadId).thread.newForYou).toBe(false);
    expect(m.store.views.getThread(a.threadId).thread.messageCount).toBe(2);
  });

  it("[E12] labels, deterministic rules on sender/recipient/list metadata, and bundling", () => {
    const m = setup();
    m.allow("alerts@ci.example");
    m.store.screener.setPolicy("domain", "lists.example", {
      decision: "allowed",
      destination: "imbox",
      labels: [],
      bundle: false,
      notify: false,
    });
    m.store.organize.putRule({
      conditions: { fromDomain: "ci.example" },
      actions: { labels: ["ci", "ops"], destination: "feed" },
    });
    m.store.organize.putRule({
      conditions: { listId: "dev.lists.example" },
      actions: { labels: ["dev"], bundle: true },
    });
    const ci = m.deliver({ fromAddress: "alerts@ci.example" });
    expect(ci.destination).toBe("feed");
    expect(m.store.views.getThread(ci.threadId).thread.labels).toEqual(["ci", "ops"]);
    const list = m.deliver({ fromAddress: "bot@lists.example", listId: "<dev.lists.example>" });
    expect(m.store.views.getThread(list.threadId).thread.labels).toEqual(["dev"]);
    expect(m.store.views.getThread(list.threadId).thread.bundleKey).toBe("bot@lists.example");
    m.store.organize.setThreadLabels(list.threadId, ["urgent"], ["dev"]);
    expect(
      m.store.views.listView({ view: "label", label: "urgent" }).items.map((t) => t.threadId),
    ).toEqual([list.threadId]);
    expect(m.store.organize.listLabels().find((l) => l.name === "ci")?.threads).toBe(1);
    expect(() => m.store.organize.putRule({ conditions: {}, actions: {} })).toThrow(Rejection);
  });

  it("[E13] workflow boards with stages, ordered cards, completion, and extension enrollment", () => {
    const m = setup();
    m.allow("client@example.com");
    const { boardId, stageIds } = m.store.organize.createBoard(
      "Hiring",
      ["New", "Interview", "Offer"],
      "jobs@bye.test",
    );
    const t = m.deliver({
      fromAddress: "client@example.com",
      to: [{ name: undefined, address: "jobs@bye.test" }],
    });
    const board = m.store.organize.board(boardId);
    expect(board.stages[0]!.cards.map((c) => c.threadId)).toEqual([t.threadId]);
    const cardId = board.stages[0]!.cards[0]!.cardId;
    m.store.organize.moveCard(cardId, stageIds[2]!, 0);
    m.store.organize.completeCard(cardId, true);
    expect(m.store.organize.board(boardId).stages[2]!.cards[0]).toMatchObject({
      cardId,
      completed: true,
    });
  });

  it("[E14] personal collections aggregate thread timelines without copies", () => {
    const m = setup();
    m.allow("alice@example.com");
    const a = m.deliver({ subject: "Venue" });
    const b = m.deliver({ subject: "Catering" });
    const col = m.store.organize.createCollection("Wedding");
    m.store.organize.setCollectionItems(col, [a.threadId, b.threadId], []);
    expect(m.store.organize.collectionTimeline(col).map((x) => x.subject)).toEqual([
      "Venue",
      "Catering",
    ]);
    expect(m.store.views.listView({ view: "everything" }).items).toHaveLength(2);
  });

  it("[E15] private notes with optimistic revisions, stickies, and a searchable clips library", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({});
    const saved = m.store.organize.putNote({
      kind: "thread",
      threadId: t.threadId,
      body: "call back",
      fileKeys: ["t/x/upload/u1"],
    });
    if (saved._tag !== "Saved") throw new Error();
    const stale = m.store.organize.putNote({
      noteId: saved.noteId,
      kind: "thread",
      threadId: t.threadId,
      body: "other device",
      expectedRevision: 0,
    });
    expect(stale._tag).toBe("Conflict");
    m.store.organize.putNote({ kind: "sticky", body: "pay rent" });
    expect(m.store.organize.notes({ kind: "sticky" })).toHaveLength(1);
    const deliveryId = m.store.views.getThread(t.threadId).deliveries[0]!.deliveryId;
    m.store.organize.createClip(t.threadId, deliveryId, "The code is 100% ready");
    expect(m.store.organize.clips("100%")).toHaveLength(1);
    expect(m.store.organize.clips("nope")).toHaveLength(0);
  });

  it("[E16] contacts, groups, notes, sender history, recent recipient suggestions, import/export", () => {
    const m = setup();
    m.allow("alice@example.com");
    m.deliver({});
    const id = m.store.organize.putContact({
      name: "Alice Liddell",
      emails: ["Alice@Example.com"],
      notes: "met at conf",
      groups: ["friends"],
    });
    expect(m.store.organize.contact(id)).toMatchObject({
      emails: ["alice@example.com"],
      groups: ["friends"],
    });
    expect(m.store.organize.searchContacts("conf")).toHaveLength(1);
    expect(m.store.organize.groupMembers("friends")).toEqual(["alice@example.com"]);
    expect(m.store.organize.senderHistory("alice@example.com")).toHaveLength(1);
    expect(m.store.organize.senderHistory("example.com")).toHaveLength(1);
    m.store.organize.recordRecipients([{ address: "bob@example.com", name: "Bob" }]);
    expect(m.store.organize.suggestRecipients("b")[0]?.address).toBe("bob@example.com");
    expect(m.store.organize.suggestRecipients("ali")[0]?.address).toBe("alice@example.com");
    m.store.organize.importContacts([
      { name: "Alice L.", emails: ["alice@example.com"] },
      { name: "Carol", emails: ["carol@example.com"] },
    ]);
    expect(m.store.organize.exportContacts().map((c) => c.name)).toEqual(["Alice L.", "Carol"]);
  });
});

describe("retention, delivery semantics, operations", () => {
  it("[E24] Trash/Spam restore, empty actions, and retention sweeps with tombstones", () => {
    const m = setup();
    m.allow("alice@example.com");
    const a = m.deliver({ subject: "A" });
    const b = m.deliver({ subject: "B" });
    m.store.triage.moveToTrash([a.threadId]);
    m.store.triage.markSpam([b.threadId]);
    expect(m.store.views.listView({ view: "trash" }).items).toHaveLength(1);
    m.store.triage.restore([b.threadId]);
    expect(m.store.views.listView({ view: "spam" }).items).toHaveLength(0);
    m.clock.advance(31 * 24 * 3600 * 1000);
    expect(m.store.retention.sweepRetention(m.clock.now()).deleted).toBe(1);
    expect(m.store.kernel.pendingOutbox(100).some((e) => e.topic === "blob-gc")).toBe(true);
    expect(
      m.store.kernel
        .pendingOutbox(100)
        .some((e) => e.topic === "index" && (e.payload as { op: string }).op === "delete"),
    ).toBe(true);
    m.store.triage.moveToTrash([b.threadId]);
    expect(m.store.retention.emptyDisposition("trash").deleted).toBe(1);
    m.store.automation.setPreference("theme", "dark");
    m.store.automation.setPreference("shortcuts", false);
    expect(m.store.automation.preferences()).toMatchObject({
      theme: "dark",
      shortcuts: false,
      remoteImages: "proxy",
    });
    expect(() => m.store.automation.setPreference("theme", "neon")).toThrow(Rejection);
  });

  it("[E24] configurable recycling spares labeled, pinned, and noted mail", () => {
    const m = setup();
    m.allow("alice@example.com");
    const keep = m.deliver({ subject: "keep" });
    m.deliver({ subject: "recycle" });
    m.store.organize.setThreadLabels(keep.threadId, ["tax"], []);
    m.store.automation.setPreference("recycling", { days: 30 });
    m.clock.advance(40 * 24 * 3600 * 1000);
    expect(m.store.retention.sweepRetention(m.clock.now()).deleted).toBe(1);
    expect(m.store.views.listView({ view: "everything" }).items.map((t) => t.subject)).toEqual([
      "keep",
    ]);
  });

  it("deduplicates replayed ingestion per (ingestion, recipient) but never by Message-ID", () => {
    const m = setup();
    m.allow("alice@example.com");
    const input = deliveryFixture(m.clock, summaryFixture({ messageIdHeader: "same@x" }));
    const first = m.store.ingest.commitDelivery(input);
    const replay = m.store.ingest.commitDelivery(input);
    expect(replay).toMatchObject({ replayed: true, deliveryId: first.deliveryId });
    const independent = m.store.ingest.commitDelivery(
      deliveryFixture(m.clock, summaryFixture({ messageIdHeader: "same@x" })),
    );
    expect(independent.deliveryId).not.toBe(first.deliveryId);
    const second = m.store.ingest.commitDelivery({ ...input, recipient: "alias@bye.test" });
    expect(second.replayed).toBe(false);
  });

  it("invitations from screened senders do not reach the calendar until approval", () => {
    const m = setup();
    m.deliver({ fromAddress: "org@example.com", hasCalendar: true, calendarMethod: "REQUEST" });
    const invites = () =>
      m.store.kernel.pendingOutbox(100).filter((e) => e.topic === "calendar.invitation");
    expect(invites()).toHaveLength(0);
    m.allow("org@example.com");
    expect(invites()).toHaveLength(1);
  });

  it("changes feed is a monotonic cursor; expired cursors are reported", () => {
    const m = setup();
    m.allow("alice@example.com");
    const start = m.store.changes(0).cursor;
    m.deliver({});
    const page = m.store.changes(start);
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.cursor).toBeGreaterThan(start);
    for (let i = 0; i < 20; i++) m.deliver({});
    m.store.kernel.compactChanges(5);
    expect(m.store.changes(page.cursor).expired).toBe(true);
  });

  it("lost alarm registration is recovered: nextWakeAt reports due work and pending outbox", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({});
    m.store.kernel.markPublished(m.store.kernel.pendingOutbox(100).map((e) => e.eventId));
    const at = m.clock.now() + 5000;
    m.store.triage.bubbleUp(t.threadId, at);
    // The alarm was never set; the independent reconciler asks the authority when to wake.
    expect(m.store.nextWakeAt(m.clock.now())).toBe(at);
    m.deliver({});
    expect(m.store.nextWakeAt(m.clock.now())).toBe(m.clock.now());
  });

  it("view pagination keeps a snapshot boundary; new arrivals don't shift later pages", () => {
    const m = setup();
    m.allow("alice@example.com");
    for (let i = 0; i < 5; i++) m.deliver({ subject: `S${i}` });
    const p1 = m.store.views.listView({ view: "imbox", limit: 2 });
    m.deliver({ subject: "late" });
    const p2 = m.store.views.listView({ view: "imbox", limit: 2, cursor: p1.nextCursor! });
    const p3 = m.store.views.listView({ view: "imbox", limit: 2, cursor: p2.nextCursor! });
    expect([...p1.items, ...p2.items, ...p3.items].map((t) => t.subject)).toEqual([
      "S4",
      "S3",
      "S2",
      "S1",
      "S0",
    ]);
    expect(p3.nextCursor).toBeNull();
  });

  it("commands are idempotent by command ID across replays", () => {
    const m = setup();
    const id = cmd();
    const a = applyMailboxCommand(m.store, { _tag: "CreateLabel", commandId: id, name: "x" });
    const b = applyMailboxCommand(m.store, { _tag: "CreateLabel", commandId: id, name: "x" });
    expect(b).toEqual(a);
    expect(m.store.organize.listLabels().map((l) => l.name)).toEqual(["x"]);
    // The same command ID with a different payload is a conflict, not a silent replay.
    const changed = () =>
      applyMailboxCommand(m.store, {
        _tag: "CreateLabel",
        commandId: id,
        name: "renamed on replay",
      });
    expect(changed).toThrow(/different payload/);
    expect(changed).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(m.store.organize.listLabels().map((l) => l.name)).toEqual(["x"]);
    // Reusing a command ID for a different command is a client error (conflict), not a replay.
    const reuse = () =>
      applyMailboxCommand(m.store, { _tag: "CreateCollection", commandId: id, name: "y" });
    expect(reuse).toThrow(/already used for CreateLabel/);
    expect(reuse).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(m.store.organize.listCollections()).toHaveLength(0);
  });
});
