import { describe, expect, it } from "vitest";
import {
  authorizeSearchResults,
  parseSearchQuery,
  searchShardHealth,
  searchShardName,
  type SearchDocument,
} from "@bye/platform-cloudflare";
import {
  deliveryFixture,
  makeTestMailbox,
  makeTestSearchShard,
  summaryFixture,
} from "@bye/testing";

const doc = (id: string, over: Partial<SearchDocument> = {}): SearchDocument => ({
  docId: `delivery:${id}`,
  kind: "delivery",
  refId: id,
  version: 1,
  threadId: `thr_${id}`,
  date: Date.UTC(2026, 0, Number(id.replace(/\D/g, "") || 1)),
  from: "alice@example.com",
  to: ["me@bye.test"],
  subject: "",
  body: "",
  view: "imbox",
  ...over,
});

const ids = (shard: ReturnType<typeof makeTestSearchShard>, q: string) =>
  shard.candidates(q).candidates.map((c) => c.refId);

describe("[E21] search", () => {
  it("parses a typed AST: phrases, exclusions, filters, explicit trash", () => {
    expect(
      parseSearchQuery(
        'from:Alice@Example.com "quarterly report" -draft has:attachment in:trash before:2026-02-01 label:"Big Deal" budget',
      ),
    ).toEqual({
      clauses: [
        { _tag: "Phrase", value: "quarterly report", negated: false },
        { _tag: "Term", value: "draft", negated: true },
        { _tag: "Term", value: "budget", negated: false },
      ],
      from: ["alice@example.com"],
      to: [],
      labels: ["Big Deal"],
      kinds: [],
      view: undefined,
      hasAttachment: true,
      before: Date.UTC(2026, 1, 1),
      after: undefined,
      scope: "trash",
    });
  });

  it("matches exact terms, phrases, and exclusions; FTS syntax in input is literal", () => {
    const s = makeTestSearchShard();
    s.upsert(doc("1", { subject: "Quarterly report", body: "the budget is attached" }));
    s.upsert(doc("2", { subject: "Report draft", body: "quarterly numbers pending" }));
    s.upsert(doc("3", { subject: "Lunch", body: "report OR NOT NEAR(" }));
    expect(ids(s, '"quarterly report"')).toEqual(["1"]);
    expect(ids(s, "report -draft")).toEqual(["3", "1"]);
    expect(ids(s, "quarterly")).toEqual(["2", "1"]);
    expect(ids(s, 'NEAR( "OR')).toEqual(["3"]);
    expect(() => s.candidates('"unterminated * ^ :')).not.toThrow();
  });

  it("finds exact addresses, sender/recipient filters and punctuation", () => {
    const s = makeTestSearchShard();
    s.upsert(
      doc("1", { from: "bob@corp.example", to: ["team@bye.test"], body: "ticket #4521 c++ build" }),
    );
    s.upsert(doc("2", { from: "alice@example.com", body: "no match" }));
    expect(ids(s, "bob@corp.example")).toEqual(["1"]);
    expect(ids(s, "from:corp.example")).toEqual(["1"]);
    expect(ids(s, "to:team@bye.test")).toEqual(["1"]);
    expect(ids(s, "#4521")).toEqual(["1"]);
    expect(ids(s, "c++")).toEqual(["1"]);
  });

  it("handles Unicode, diacritics and CJK", () => {
    const s = makeTestSearchShard();
    s.upsert(doc("1", { subject: "Café résumé", body: "Straße" }));
    s.upsert(doc("2", { subject: "会議の議事録", body: "東京で打ち合わせ" }));
    s.upsert(doc("3", { subject: "회의록", body: "서울" }));
    expect(ids(s, "cafe")).toEqual(["1"]);
    expect(ids(s, "résumé")).toEqual(["1"]);
    expect(ids(s, "議事録")).toEqual(["2"]);
    expect(ids(s, "東京")).toEqual(["2"]);
    expect(ids(s, "회의록")).toEqual(["3"]);
  });

  it("excludes Trash unless explicitly requested; filters by attachment, date, label and kind", () => {
    const s = makeTestSearchShard();
    s.upsert(doc("1", { body: "invoice", view: "trash" }));
    s.upsert(doc("2", { body: "invoice", attachments: ["invoice.pdf"], labels: ["tax"] }));
    s.upsert(doc("3", { docId: "note:n3", kind: "note", body: "invoice reminder" }));
    expect(ids(s, "invoice")).toEqual(["3", "2"]);
    expect(ids(s, "invoice in:trash")).toEqual(["1"]);
    expect(ids(s, "invoice has:attachment")).toEqual(["2"]);
    expect(ids(s, "invoice.pdf")).toEqual(["2"]);
    expect(ids(s, "label:tax")).toEqual(["2"]);
    expect(ids(s, "invoice kind:note")).toEqual(["3"]);
    expect(ids(s, "invoice after:2026-01-03")).toEqual(["3"]);
  });

  it("late index events and tombstones make replays safe", () => {
    const s = makeTestSearchShard();
    s.upsert(doc("1", { version: 2, body: "new text" }));
    expect(s.upsert(doc("1", { version: 1, body: "old text" }))).toBe("stale");
    expect(ids(s, "old")).toEqual([]);
    s.remove("delivery:1", 3);
    expect(s.upsert(doc("1", { version: 2, body: "new text" }))).toBe("stale");
    expect(ids(s, "new")).toEqual([]);
    expect(s.upsert(doc("1", { version: 4, body: "restored text" }))).toBe("indexed");
    expect(ids(s, "restored")).toEqual(["1"]);
  });

  it("chunks long bodies below row limits and paginates with stable date order", () => {
    const s = makeTestSearchShard();
    s.upsert(doc("1", { body: `${"lorem ".repeat(10_000)} needle` }));

    for (let i = 2; i <= 6; i++) s.upsert(doc(String(i), { body: "needle" }));
    expect(
      s.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM search_fts WHERE doc_id = 'delivery:1'")!
        .n,
    ).toBeGreaterThan(1);
    const p1 = s.candidates("needle", { limit: 4 });
    const p2 = s.candidates("needle", { limit: 4, cursor: p1.nextCursor! });
    expect([...p1.candidates, ...p2.candidates].map((c) => c.refId)).toEqual([
      "6",
      "5",
      "4",
      "3",
      "2",
      "1",
    ]);
  });

  it("revoked or stale results are never revealed: candidates are rehydrated and reauthorized", async () => {
    const a = makeTestSearchShard();
    const b = makeTestSearchShard();
    a.upsert(doc("1", { body: "secret plan" }));
    b.upsert(doc("2", { body: "secret plan", docId: "shared:2" }));
    a.setWatermark(10);
    b.setWatermark(7);
    const revoked = new Set(["shared:2"]);

    const out = await authorizeSearchResults(
      [a.candidates("secret"), b.candidates("secret")],
      async (cands) => cands.map((c) => (revoked.has(c.docId) ? undefined : { id: c.refId })),
      10,
    );

    expect(out.results).toEqual([{ id: "1" }]);
    expect(out.watermark).toBe(7);
  });

  it("shard sizing: alert at 50%, roll over at 70%, period buckets", () => {
    expect(searchShardHealth(6e9, 10e9)).toMatchObject({ alert: true, rollover: false });
    expect(searchShardHealth(7.5e9, 10e9).rollover).toBe(true);
    expect(searchShardName("mbx_1", Date.UTC(2026, 5, 1))).toBe(
      searchShardName("mbx_1", Date.UTC(2026, 0, 1)),
    );
  });

  it("in:<view> keeps exactly the threads the view shows (same SQL filter)", () => {
    const m = makeTestMailbox();
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    m.clock.advance(1000);

    const t = m.store.ingest.commitDelivery(
      deliveryFixture(m.clock, summaryFixture({ subject: "invoice" })),
    );

    const d = m.store.views.getThread(t.threadId).deliveries[0]!;

    const views = [
      "imbox",
      "reply-later",
      "set-aside",
      "bubble-up",
      "everything",
      "screener",
    ] as const;

    const agree = () => {
      for (const view of views) {
        const shown = m.store.views.listView({ view }).items.some((x) => x.threadId === t.threadId);
        expect([
          view,
          m.store.search.searchHits(
            [{ kind: "delivery", refId: d.deliveryId }],
            `invoice in:${view}`,
          ).length > 0,
        ]).toEqual([view, shown]);
      }
    };

    agree();
    // Seen and moved to Reply Later: it leaves the Imbox, so `in:imbox` must drop it too.
    m.store.views.markSeen(t.threadId, m.store.views.getThread(t.threadId).thread.revision);
    m.store.triage.setAttention(t.threadId, "replyLater", true);
    expect(
      m.store.search.searchHits([{ kind: "delivery", refId: d.deliveryId }], "invoice in:imbox"),
    ).toHaveLength(0);
    agree();
    m.store.triage.setAttention(t.threadId, "replyLater", false);
    m.store.triage.bubbleUp(t.threadId, m.clock.now() + 60_000);
    agree();
  });

  it("recent searches are remembered in the mailbox", () => {
    const m = makeTestMailbox();
    m.store.automation.recordSearch("from:bob");
    m.store.automation.recordSearch("invoice");
    m.store.automation.recordSearch("from:bob");
    expect(m.store.automation.recentSearches()).toEqual(["from:bob", "invoice"]);
  });
});
