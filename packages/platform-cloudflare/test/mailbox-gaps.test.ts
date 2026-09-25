import { describe, expect, it } from "vitest";
import { crc32Update, safeZipName, zipStream } from "@bye/platform-cloudflare";
import { deliveryFixture, makeTestMailbox, summaryFixture } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const setup = (mailboxId?: string) => {
  const m = makeTestMailbox(mailboxId);
  const deliver = (
    over: Parameters<typeof summaryFixture>[0] = {},
    extra: Parameters<typeof deliveryFixture>[2] = {},
  ) => {
    m.clock.advance(1000);
    return m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture(over), extra));
  };
  const allow = (sender: string) =>
    m.store.screener.screen([{ sender, decision: "allow", destination: "imbox" }]);
  const outbox = (topic?: string) =>
    m.store.kernel.pendingOutbox(1000).filter((e) => !topic || e.topic === topic);
  const payloads = (topic: string) =>
    outbox(topic).map((e) => e.payload as Record<string, unknown>);
  return { ...m, deliver, allow, outbox, payloads };
};

describe("screener bypass (P0 #1)", () => {
  it("a stranger guessing a Message-ID of a known thread still lands in the Screener", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ fromAddress: "alice@example.com", messageIdHeader: "known@x" });
    expect(t.disposition).toBe("active");
    const guess = m.deliver({
      fromAddress: "mallory@evil.test",
      inReplyTo: ["known@x"],
      references: ["known@x"],
    });
    expect(guess.disposition).toBe("screening");
    expect(guess.threadId).not.toBe(t.threadId);
  });

  it("a prior participant replying on the thread joins it without screening", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({
      fromAddress: "alice@example.com",
      messageIdHeader: "root@x",
      cc: [{ name: undefined, address: "carol@example.com" }],
    });
    // Before we take part, even a cc'd address is screened.
    expect(m.deliver({ fromAddress: "carol@example.com", inReplyTo: ["root@x"] }).disposition).toBe(
      "screening",
    );
    const draftId = m.store.drafts.createReplyDraft(
      t.threadId,
      "reply",
      m.store.views.getThread(t.threadId).deliveries,
    );
    const sent = m.store.sends.send(draftId, { expectedRevision: 1, undoMs: 0 });
    if (sent._tag !== "Queued") throw new Error(sent._tag);
    m.store.runDueJobs(m.clock.now() + 60_000);
    m.store.sends.claim(sent.sendJobIds[0]!);
    m.store.sends.accepted(sent.sendJobIds[0]!, { providerId: "p1" });
    const reply = m.deliver({
      fromAddress: "carol@example.com",
      inReplyTo: ["root@x"],
      references: ["root@x"],
    });
    expect(reply.disposition).toBe("active");
    expect(reply.threadId).toBe(t.threadId);
  });

  it("[C04] an iTIP REPLY confirmed by the calendar bypasses the Screener; a REQUEST never does", () => {
    const m = setup();
    const reply = summaryFixture({
      fromAddress: "guest@example.com",
      hasCalendar: true,
      calendarMethod: "REPLY",
    });
    const ingest = deliveryFixture(m.clock, reply, { calendarOrganizerReply: true });
    expect(m.store.ingest.needsOrganizerCheck(reply, ingest.ingestionId)).toBe(true);
    expect(m.store.ingest.commitDelivery(ingest).disposition).toBe("active");
    // The flag is ignored for REQUESTs, and unconfirmed replies wait in the Screener.
    const request = m.deliver(
      { fromAddress: "x@example.com", hasCalendar: true, calendarMethod: "REQUEST" },
      { calendarOrganizerReply: true },
    );
    expect(request.disposition).toBe("screening");
    expect(
      m.deliver({ fromAddress: "y@example.com", hasCalendar: true, calendarMethod: "REPLY" })
        .disposition,
    ).toBe("screening");
    // Blocked senders and unsafe mail are never let through.
    m.store.screener.screen([{ sender: "blocked@example.com", decision: "block" }]);
    expect(
      m.store.ingest.needsOrganizerCheck(
        summaryFixture({
          fromAddress: "blocked@example.com",
          hasCalendar: true,
          calendarMethod: "REPLY",
        }),
        "ing_new",
      ),
    ).toBe(false);
    expect(
      m.deliver(
        { fromAddress: "z@example.com", hasCalendar: true, calendarMethod: "REPLY" },
        { calendarOrganizerReply: true, safety: { _tag: "Spam", reason: "test" } },
      ).disposition,
    ).toBe("spam");
  });
});

describe("search reindex and hydration (P0 #3, #13)", () => {
  it("trashing reindexes; hydration drops trashed hits unless in:trash", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ fromAddress: "alice@example.com", subject: "invoice" });
    const d = m.store.views.getThread(t.threadId).deliveries[0]!;
    const cands = [{ kind: "delivery", refId: d.deliveryId }];
    expect(m.store.search.searchHits(cands, "invoice")).toHaveLength(1);
    m.store.kernel.markPublished(m.outbox().map((e) => e.eventId));
    m.store.triage.moveToTrash([t.threadId]);
    expect(m.payloads("index").some((p) => p.id === d.deliveryId)).toBe(true);
    expect(m.store.search.searchHits(cands, "invoice")).toHaveLength(0);
    expect(m.store.search.searchHits(cands, "invoice in:trash")).toHaveLength(1);
  });

  it("hydration re-checks from:, label: and has:attachment filters against current state", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ fromAddress: "alice@example.com" });
    const d = m.store.views.getThread(t.threadId).deliveries[0]!;
    const cands = [{ kind: "delivery", refId: d.deliveryId }];
    expect(m.store.search.searchHits(cands, "from:bob@example.com")).toHaveLength(0);
    expect(m.store.search.searchHits(cands, "from:alice@example.com")).toHaveLength(1);
    expect(m.store.search.searchHits(cands, "label:work")).toHaveLength(0);
    m.store.organize.assignLabelByName(t.threadId, "work");
    expect(m.store.search.searchHits(cands, "label:work")).toHaveLength(1);
    expect(m.store.search.searchHits(cands, "has:attachment")).toHaveLength(0);
  });

  it("the watermark lags until the indexer acknowledges each emitted document", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ fromAddress: "alice@example.com" });
    const d = m.store.views.getThread(t.threadId).deliveries[0]!;
    const w = m.store.search.indexWatermark();
    expect(w.lagging).toBe(true);
    m.store.search.ackIndexed(`delivery:${d.deliveryId}`, m.store.kernel.currentSeq());
    const after = m.store.search.indexWatermark();
    expect(after).toMatchObject({ lagging: false, pending: 0 });
    expect(after.watermark).toBe(m.store.kernel.currentSeq());
  });

  it("unacknowledged index events are replayed on reconcile", () => {
    const m = setup();
    m.allow("alice@example.com");
    m.deliver({ fromAddress: "alice@example.com" });
    m.store.search.replayPendingIndex(); // first pass records the boundary
    m.store.kernel.markPublished(m.outbox().map((e) => e.eventId));
    expect(m.store.search.replayPendingIndex()).toBeGreaterThan(0);
    expect(m.outbox("index").length).toBeGreaterThan(0);
  });

  it("shards roll over at the health threshold with stable placement", () => {
    const m = setup();
    const [first] = m.store.search.searchShards();
    expect(m.store.search.searchPlacement("delivery:a", 1)).toBe(first!.name);
    m.clock.advance(10_000);
    const { opened } = m.store.search.recordShardHealth(first!.name, 7_000_000_000, true);
    expect(opened).toBe(`search:${m.mailboxId}:${m.clock.now()}`);
    expect(m.store.search.searchShards().map((s) => s.sealed)).toEqual([true, false]);
    // Old docs stay where they were; new docs dated after the rollover go to the new shard.
    expect(m.store.search.searchPlacement("delivery:a", 1)).toBe(first!.name);
    expect(m.store.search.searchPlacement("delivery:b", m.clock.now() + 1)).toBe(opened);
  });
});

describe("redelivery (P0 #4, E22)", () => {
  it("redelivery carries a real MessageSummary that the target commits as an authorized transfer", () => {
    const src = setup("mbx_src00000000000000000000");
    src.allow("alice@example.com");
    const t = src.deliver({ fromAddress: "alice@example.com", subject: "Quarterly report" });
    const d = src.store.views.getThread(t.threadId).deliveries[0]!;
    src.store.kernel.markPublished(src.outbox().map((e) => e.eventId));
    src.store.transfers.redeliver({
      deliveryId: d.deliveryId,
      targetMailboxId: "mbx_dst00000000000000000000",
      mode: "copy",
      summary: src.store.ingest.deliverySummary(d.deliveryId),
    });
    const [p] = src.payloads("mailbox.redeliver");
    const summary = p!.summary as ReturnType<typeof src.store.ingest.deliverySummary>;
    expect(summary).toMatchObject({
      subject: "Quarterly report",
      from: { address: "alice@example.com" },
    });

    const dst = setup("mbx_dst00000000000000000000");
    const r = dst.store.ingest.commitDelivery({
      ingestionId: `xfer:${String(p!.transferId)}`,
      recipient: "",
      messageKey: String(p!.messageKey),
      rawSize: Number(p!.rawSize),
      summary,
      safety: { _tag: "Clean" },
      receivedAt: dst.clock.now(),
      authorizedTransfer: true,
    });
    expect(r).toMatchObject({ disposition: "active", decidedBy: "transfer" });
    expect(dst.store.views.getThread(r.threadId).thread.subject).toBe("Quarterly report");
  });

  it("move removes only the moved delivery from a multi-message thread", () => {
    const m = setup();
    m.allow("alice@example.com");
    const t = m.deliver({ fromAddress: "alice@example.com", messageIdHeader: "a1@x" });
    m.deliver({ fromAddress: "alice@example.com", inReplyTo: ["a1@x"], references: ["a1@x"] });
    const [first, second] = m.store.views.getThread(t.threadId).deliveries;
    m.store.transfers.redeliver({
      deliveryId: first!.deliveryId,
      targetMailboxId: "mbx_other",
      mode: "move",
      summary: m.store.ingest.deliverySummary(first!.deliveryId),
    });
    const after = m.store.views.getThread(t.threadId);
    expect(after.deliveries.map((x) => x.deliveryId)).toEqual([second!.deliveryId]);
    expect(after.thread.disposition).toBe("active");
  });

  it("rule-based redelivery copies matching clean mail to the target mailbox", () => {
    const m = setup();
    m.allow("billing@vendor.test");
    m.store.organize.putRule({
      conditions: { from: "billing@vendor.test" },
      actions: { redeliverTo: "mbx_finance" },
    });
    m.deliver({ fromAddress: "billing@vendor.test" });
    const transfers = m.outbox("mailbox.redeliver").filter((e) => e.target === "mbx_finance");
    expect(transfers).toHaveLength(1);
    expect(
      (transfers[0]!.payload as { summary: { from: { address: string } } }).summary.from.address,
    ).toBe("billing@vendor.test");
    // Spam never triggers the rule.
    m.deliver({ fromAddress: "billing@vendor.test" }, { safety: { _tag: "Spam", reason: "test" } });
    expect(m.outbox("mailbox.redeliver").filter((e) => e.target === "mbx_finance")).toHaveLength(1);
  });
});

describe("views and seen state (P0 #5)", () => {
  it("MarkAllSeen on a label marks only that label's threads up to the boundary", () => {
    const m = setup();
    m.allow("a@example.com");
    m.allow("b@example.com");
    const a = m.deliver({ fromAddress: "a@example.com" });
    const b = m.deliver({ fromAddress: "b@example.com" });
    m.store.organize.assignLabelByName(a.threadId, "news");
    const boundary = m.store.kernel.currentSeq();
    const late = m.deliver({ fromAddress: "a@example.com", subject: "later" });
    m.store.organize.assignLabelByName(late.threadId, "news");
    expect(m.store.views.markAllSeen("label", boundary, "news").marked).toBe(1);
    const nfy = m.store.views.imbox().newForYou.map((t) => t.threadId);
    expect(nfy).toContain(b.threadId);
    expect(nfy).toContain(late.threadId);
    expect(nfy).not.toContain(a.threadId);
    expect(() => m.store.views.markAllSeen("label", boundary)).toThrow(Rejection);
  });

  it("thread detail includes merge history", () => {
    const m = setup();
    m.allow("a@example.com");
    const x = m.deliver({ fromAddress: "a@example.com", subject: "one" });
    const y = m.deliver({ fromAddress: "a@example.com", subject: "two" });
    m.store.triage.mergeThreads(x.threadId, [y.threadId]);
    expect(m.store.views.getThread(x.threadId).mergeHistory).toEqual([
      expect.objectContaining({ sources: [y.threadId], undone: false }),
    ]);
  });
});

describe("export manifest paging (P0 #11)", () => {
  it("pages through every delivery without a silent cap", () => {
    const m = setup();
    for (let i = 0; i < 230; i++) m.deliver({ fromAddress: `s${i}@example.com` });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = m.store.retention.exportManifestPage(cursor, 100);
      for (const d of page.deliveries) seen.add(d.deliveryId);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen.size).toBe(230);
    expect(pages).toBe(3);
  });
});

describe("sending gaps (P0 #6, #14, E17, E19)", () => {
  const draftTo = (m: ReturnType<typeof setup>, content: Record<string, unknown>) =>
    m.store.drafts.createDraft({
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "body",
        attachments: [],
        ...content,
      } as never,
    });

  it("forwarding verification is sent as a transactional system job", () => {
    const m = setup();
    const { sendJobId } = m.store.automation.addForwardingDestination("me@elsewhere.test");
    const job = m.store.sends.job(sendJobId)!;
    expect(job.trafficClass).toBe("transactional");
    expect(job.recipients).toEqual(["me@elsewhere.test"]);
  });

  it("stale ready send jobs have their dispatch re-emitted; fresh ones do not", () => {
    const m = setup();
    const { draftId } = draftTo(m, { to: [{ name: undefined, address: "bob@example.com" }] });
    const r = m.store.sends.send(draftId, { expectedRevision: 1, undoMs: 0 });
    if (r._tag !== "Queued") throw new Error(r._tag);
    m.store.runDueJobs(m.clock.now() + 60_000);
    m.store.kernel.markPublished(m.outbox().map((e) => e.eventId));
    expect(m.store.sends.replayStaleDispatches(m.clock.now(), 10 * 60_000)).toEqual([]);
    m.clock.advance(11 * 60_000);
    expect(m.store.sends.replayStaleDispatches(m.clock.now(), 10 * 60_000)).toEqual(r.sendJobIds);
    expect(m.payloads("dispatch").map((p) => p.sendJobId)).toEqual(r.sendJobIds);
  });

  it("recipient groups expand into To when the send is frozen", () => {
    const m = setup();
    m.store.organize.putContact({ name: "Ann", emails: ["ann@example.com"], groups: ["team"] });
    m.store.organize.putContact({ name: "Ben", emails: ["ben@example.com"], groups: ["team"] });
    const { draftId } = draftTo(m, {
      to: [{ name: undefined, address: "ann@example.com" }],
      groups: ["team"],
    });
    const r = m.store.sends.send(draftId, { expectedRevision: 1, undoMs: 0 });
    if (r._tag !== "Queued") throw new Error(r._tag);
    const job = m.store.sends.job(r.sendJobIds[0]!)!;
    expect([...job.recipients].sort()).toEqual(["ann@example.com", "ben@example.com"]);
    const { draftId: bad } = draftTo(m, { groups: ["nobody"] });
    expect(() => m.store.sends.send(bad, { expectedRevision: 1 })).toThrow(Rejection);
  });

  it("external send-as needs the mailed challenge code; wrong codes never verify", () => {
    const m = setup();
    const id = m.store.identities.addIdentity({ address: "me@gmail.test", kind: "external" });
    const token = (
      m.storage.sql
        .exec("SELECT challenge_token FROM identities WHERE identity_id = ?", id)
        .toArray()[0] as { challenge_token: string }
    ).challenge_token;
    expect(m.store.identities.verifyIdentity(id, "wrong-code")).toEqual({ verified: false });
    expect(m.store.identities.identities().find((i) => i.identityId === id)!.verified).toBe(false);
    expect(m.store.identities.verifyIdentity(id, token)).toEqual({ verified: true });
    expect(m.store.identities.identities().find((i) => i.identityId === id)!.verified).toBe(true);
  });
});

describe("streaming zip", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const one = (b: Uint8Array) =>
    new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(b), c.close()) });

  it("produces a valid stored archive with CRCs and a central directory", async () => {
    const entries = [
      { name: "a.txt", modified: Date.UTC(2026, 0, 1), open: async () => one(bytes("hello")) },
      { name: "b.txt", modified: Date.UTC(2026, 0, 1), open: async () => one(bytes("world!")) },
    ];
    const out = new Uint8Array(await new Response(zipStream(entries)).arrayBuffer());
    const view = new DataView(out.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const eocd = out.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(cdOffset + 16, true)).toBe(crc32Update(0, bytes("hello")));
    expect(view.getUint32(cdOffset + 20, true)).toBe(5);
  });

  it("sanitizes and de-duplicates entry names", () => {
    const used = new Set<string>();
    expect(safeZipName("../../etc/passwd", used)).toBe("__.._etc_passwd");
    expect(safeZipName("report.pdf", used)).toBe("report.pdf");
    expect(safeZipName("REPORT.pdf", used)).toBe("REPORT (2).pdf");
  });
});

describe("external storage in the quota", () => {
  it("[§12] storage outside the mailbox authority counts against the upload quota", () => {
    const m = makeTestMailbox();
    m.store.uploads.setQuota(1000);
    expect(m.store.uploads.quota()).toEqual({ limitBytes: 1000, usedBytes: 0 });
    m.store.uploads.setExternalUsage(900);
    expect(m.store.uploads.quota().usedBytes).toBe(900);
    expect(() =>
      m.store.uploads.reserveUpload({
        filename: "a",
        contentType: "text/plain",
        declaredSize: 200,
      }),
    ).toThrow(/quota/);
    m.store.uploads.setExternalUsage(-5);
    expect(m.store.uploads.quota().usedBytes).toBe(0);
    expect(
      m.store.uploads.reserveUpload({ filename: "b", contentType: "text/plain", declaredSize: 200 })
        .uploadId,
    ).toBeTruthy();
  });
});
