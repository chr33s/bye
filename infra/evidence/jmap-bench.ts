import { Predicate } from "effect";
import { prepareEmail } from "@bye/mail-codec";
import { FULL_RIGHTS } from "@bye/platform-cloudflare";
import { makeTestMailbox } from "@bye/testing";

// spec.md §16 D2 local evidence: the JMAP core's publication, query, count, search and
// /changes costs on synthetic mail over the same SQLite (node:sqlite with Cloudflare's limits).
// These are local harness numbers. They inform the account envelope; they are not deployment
// measurements and never fill a D2 field on their own.
// Usage: BYE_JMAP_BENCH_MESSAGES=5000 pnpm evidence:jmap

export interface JmapBenchResult {
  readonly messages: number;
  readonly prepareP95Ms: number;
  readonly publishMsPerEmail: number;
  readonly mailboxGetMs: number;
  readonly queryP95Ms: number;
  readonly textQueryP95Ms: number;
  readonly textRecall: number;
  readonly changesFullScanMs: number;
  readonly changesPages: number;
  readonly sqliteBytesPerEmail: number;
}

const WORDS =
  "invoice meeting quarterly budget travel hotel flight contract review draft launch design roadmap hiring offer payroll".split(
    " ",
  );

const message = (i: number): Uint8Array => {
  const topic = WORDS[i % WORDS.length]!;
  const body = Array.from({ length: 300 }, (_, j) => WORDS[(i * 7 + j) % WORDS.length]).join(" ");

  const thread =
    i % 5 === 0
      ? []
      : [`In-Reply-To: <bench-${i - 1}@example.net>`, `References: <bench-${i - 1}@example.net>`];

  return new TextEncoder().encode(
    [
      `From: sender${i % 50}@example.net`,
      "To: me@bye.test",
      `Subject: ${i % 5 === 0 ? "" : "Re: "}${topic} ${Math.floor(i / 5)}`,
      `Message-ID: <bench-${i}@example.net>`,
      ...thread,
      "Date: Mon, 12 Oct 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `unique-token-${i} ${body}`,
      "",
    ].join("\r\n"),
  );
};

const p95 = (xs: Array<number>) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

export const runJmapBench = (n = 1000): JmapBenchResult => {
  const t = makeTestMailbox();
  const core = t.store.jmap.core;
  const viewer = { principalId: "usr_bench" };
  core.ensureDefaults();
  core.applyGrant(viewer.principalId, "*", FULL_RIGHTS);
  core.putMeta("mode", "jmap");
  const base = core.history.typeRevision("Email");
  const prepareTimes: Array<number> = [];
  let publishTotal = 0;
  const mailboxes = ["inbox", "feed", "paper-trail", "archive"];

  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const email = prepareEmail(message(i));
    prepareTimes.push(performance.now() - t0);
    const t1 = performance.now();
    core.createEmail(
      viewer,
      { blobId: `b${i}`, bucket: "originals", r2Key: `k/${i}`, type: "message/rfc822", email },
      [mailboxes[i % mailboxes.length]!],
      i % 3 === 0 ? ["$seen"] : [],
      t.clock.now() + i,
    );
    publishTotal += performance.now() - t1;
  }

  const t2 = performance.now();
  core.mailboxes(viewer);
  const mailboxGetMs = performance.now() - t2;
  const queryTimes: Array<number> = [];
  const textTimes: Array<number> = [];
  let found = 0;
  const queries = Math.min(100, n);

  for (let q = 0; q < queries; q++) {
    const t0 = performance.now();

    core.query(viewer, {
      _tag: "EmailQuery",
      filter: { _tag: "Condition", condition: { inMailbox: "inbox" } },
      sort: [{ property: "receivedAt", isAscending: false }],
      collapseThreads: q % 2 === 0,
      position: (q * 7) % Math.max(1, Math.floor(n / 8)),
      anchor: null,
      anchorOffset: 0,
      limit: 50,
      calculateTotal: true,
    });
    queryTimes.push(performance.now() - t0);
    const i = Math.floor((q * n) / queries);
    const t1 = performance.now();

    const r = core.query(viewer, {
      _tag: "EmailQuery",
      filter: { _tag: "Condition", condition: { text: `unique-token-${i}` } },
      sort: [{ property: "receivedAt", isAscending: false }],
      collapseThreads: false,
      position: 0,
      anchor: null,
      anchorOffset: 0,
      limit: 10,
      calculateTotal: false,
    });

    textTimes.push(performance.now() - t1);

    if (Predicate.isTagged(r, "EmailQuery") && r.ids.length === 1) found++;
  }

  const t3 = performance.now();
  let pages = 0;

  for (let cursor: string | null = null, first = true; first || cursor !== null; first = false) {
    const page = core.history.changes("Email", base, null, cursor, 500);
    pages++;
    cursor = Predicate.isTagged(page, "Changes") ? page.nextCursor : null;
  }

  const changesFullScanMs = performance.now() - t3;

  const size = (q: string) =>
    Number(Object.values(t.storage.db.prepare(q).get() as Record<string, number>)[0] ?? 0);

  return {
    messages: n,
    prepareP95Ms: p95(prepareTimes),
    publishMsPerEmail: publishTotal / n,
    mailboxGetMs,
    queryP95Ms: p95(queryTimes),
    textQueryP95Ms: p95(textTimes),
    textRecall: found / queries,
    changesFullScanMs,
    changesPages: pages,
    sqliteBytesPerEmail: (size("PRAGMA page_count") * size("PRAGMA page_size")) / n,
  };
};

/** Local regression thresholds (generous guards against regressions, not release targets). */
export const JMAP_BENCH_THRESHOLDS = {
  prepareP95Ms: 25,
  publishMsPerEmail: 20,
  queryP95Ms: 200,
  textQueryP95Ms: 100,
  textRecall: 1,
} as const;
