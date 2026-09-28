import { parseMessage } from "@bye/mail-codec";
import { makeTestSearchShard } from "@bye/testing";

// §14.5 evidence harness: parser resource usage and lexical-search quality/latency on synthetic
// mail. Runs locally as a regression guard; the same numbers must be re-measured on a deployed
// Worker (EVIDENCE.md §14.5). Usage: BYE_BENCH_MESSAGES=5000 pnpm evidence:bench

export interface BenchResult {
  readonly messages: number;
  readonly parseP95Ms: number;
  readonly parseMaxHeapDeltaMb: number;
  readonly indexMsPerDoc: number;
  readonly searchP95Ms: number;
  readonly recallAt10: number;
}

const WORDS =
  "invoice meeting quarterly budget travel hotel flight contract review draft launch design roadmap hiring offer payroll".split(
    " ",
  );

const message = (i: number): Uint8Array => {
  const topic = WORDS[i % WORDS.length]!;
  const body = Array.from({ length: 200 }, (_, j) => WORDS[(i * 7 + j) % WORDS.length]).join(" ");
  const attachment = btoa("x".repeat(4096));

  return new TextEncoder().encode(
    [
      `From: sender${i % 50}@example.net`,
      `To: me@bye.test`,
      `Subject: ${topic} update ${i}`,
      `Message-ID: <bench-${i}@example.net>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `unique-token-${i} ${body}`,
      "--b",
      'Content-Type: application/octet-stream; name="a.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      attachment,
      "--b--",
      "",
    ].join("\r\n"),
  );
};

const p95 = (xs: Array<number>) =>
  xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

export const runBench = (n = 500): BenchResult => {
  const parseTimes: Array<number> = [];
  let maxHeap = 0;
  const shard = makeTestSearchShard();
  const heap0 = process.memoryUsage().heapUsed;
  let indexTotal = 0;

  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const parsed = parseMessage(message(i));
    parseTimes.push(performance.now() - t0);
    maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed - heap0);
    const t1 = performance.now();
    shard.upsert({
      docId: `delivery:${i}`,
      kind: "delivery",
      refId: `d${i}`,
      version: i + 1,
      threadId: `t${i}`,
      date: i,
      from: parsed.from[0]?.address ?? "",
      subject: parsed.subject,
      body: parsed.text ?? "",
      view: "imbox",
    });
    indexTotal += performance.now() - t1;
  }

  const searchTimes: Array<number> = [];
  let hits = 0;
  const queries = Math.min(100, n);

  for (let q = 0; q < queries; q++) {
    const i = Math.floor((q * n) / queries);
    const t0 = performance.now();
    const page = shard.candidates(`unique-token-${i}`, { limit: 10 });
    searchTimes.push(performance.now() - t0);

    if (page.candidates.some((c) => c.refId === `d${i}`)) hits++;
  }

  return {
    messages: n,
    parseP95Ms: p95(parseTimes),
    parseMaxHeapDeltaMb: maxHeap / 1024 / 1024,
    indexMsPerDoc: indexTotal / n,
    searchP95Ms: p95(searchTimes),
    recallAt10: hits / queries,
  };
};

/** Local regression thresholds (generous; deployed targets are in spec §12). */
export const BENCH_THRESHOLDS = {
  parseP95Ms: 25,
  indexMsPerDoc: 10,
  searchP95Ms: 25,
  recallAt10: 1,
} as const;
