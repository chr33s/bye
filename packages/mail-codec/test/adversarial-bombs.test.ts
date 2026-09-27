import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_LIMITS, parseMessage, readMbox } from "@bye/mail-codec";

// §13 archive/MIME bombs: every hostile shape must terminate quickly, stay within the decoded-byte
// budget, flag `truncated`, and never throw.

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s.replace(/\r?\n/g, "\r\n"));
const limitHits = (p: ReturnType<typeof parseMessage>) =>
  p.warnings.flatMap((w) => (w._tag === "LimitExceeded" ? [w.limit] : []));
const timed = <A>(f: () => A): { value: A; ms: number } => {
  const t = performance.now();
  const value = f();
  return { value, ms: performance.now() - t };
};

describe("MIME bombs", () => {
  it("nested message/rfc822 is kept as one opaque attachment, never recursed", () => {
    let msg = "From: a@x.test\nSubject: core\n\nhello\n";
    for (let i = 0; i < 200; i++) {
      msg = `From: a@x.test\nSubject: n${i}\nContent-Type: multipart/mixed; boundary=b${i}\n\n--b${i}\nContent-Type: message/rfc822\n\n${msg}\n--b${i}--\n`;
    }
    const { value: p, ms } = timed(() => parseMessage(bytes(msg)));
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]!.contentType).toBe("message/rfc822");
    expect(ms).toBeLessThan(2000);
  });

  it("deeply nested multipart stops at maxDepth", () => {
    let body = "--z\nContent-Type: text/plain\n\ncore\n--z--\n";
    let boundary = "z";
    for (let i = 0; i < 200; i++) {
      const b = `b${i}`;
      body = `--${b}\nContent-Type: multipart/mixed; boundary=${boundary}\n\n${body}\n--${b}--\n`;
      boundary = b;
    }
    const { value: p, ms } = timed(() =>
      parseMessage(
        bytes(`From: a@x.test\nContent-Type: multipart/mixed; boundary=${boundary}\n\n${body}`),
      ),
    );
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxDepth");
    expect(ms).toBeLessThan(2000);
  });

  it("part explosion stops at maxParts", () => {
    const parts = Array.from(
      { length: 5000 },
      (_, i) =>
        `--b\nContent-Type: text/plain\nContent-Disposition: attachment; filename=f${i}.txt\n\nx\n`,
    ).join("");
    const p = parseMessage(
      bytes(`From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n${parts}--b--\n`),
    );
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxParts");
    expect(p.parts.length).toBe(DEFAULT_PARSE_LIMITS.maxParts);
    expect(p.warnings).toContainEqual({ _tag: "LimitExceeded", limit: "maxParts" });
  });

  it("nested multipart/signed keeps one opaque copy instead of one per level", () => {
    const payload = "x".repeat(64 * 1024);
    let entity = `Content-Type: text/plain\n\n${payload}`;
    for (let i = 0; i < 10; i++) {
      // Alternate signed and mixed so the amplification cannot hide behind an intermediate level.
      const kind = i % 3 === 2 ? "mixed" : "signed";
      const sig =
        kind === "signed" ? `--s${i}\nContent-Type: application/pgp-signature\n\nsig\n` : "";
      entity = `Content-Type: multipart/${kind}; boundary=s${i}\n\n--s${i}\n${entity}\n${sig}--s${i}--\n`;
    }
    const p = parseMessage(bytes(`From: a@x.test\n${entity}`));
    const opaque = p.parts.filter((x) => x.partId.endsWith(".signed"));
    expect(opaque).toHaveLength(1);
    expect(p.truncated).toBe(false);
    const total = p.parts.reduce((s, x) => s + x.size, 0);
    expect(total).toBeLessThan(3 * payload.length);
  });

  it("an opaque signed copy is refused before allocation when it would exceed the budget", () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, maxDecodedBytes: 32 * 1024 };
    const payload = "x".repeat(64 * 1024);
    const p = parseMessage(
      bytes(
        `From: a@x.test\nContent-Type: multipart/signed; boundary=s\n\n--s\nContent-Type: text/plain\n\n${payload}\n--s\nContent-Type: application/pgp-signature\n\nsig\n--s--\n`,
      ),
      limits,
    );
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxDecodedBytes");
    expect(p.parts).toHaveLength(0);
  });

  it("base64 expansion across many parts is capped by maxDecodedBytes", () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, maxDecodedBytes: 256 * 1024 };
    const chunk = Buffer.alloc(64 * 1024, 0)
      .toString("base64")
      .replace(/.{76}/g, "$&\n");
    const parts = Array.from(
      { length: 20 },
      (_, i) =>
        `--b\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename=z${i}\n\n${chunk}\n`,
    ).join("");
    const p = parseMessage(
      bytes(`From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n${parts}--b--\n`),
      limits,
    );
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxDecodedBytes");
    expect(p.parts.reduce((s, x) => s + x.size, 0)).toBeLessThanOrEqual(limits.maxDecodedBytes);
  });

  it("header bomb is cut at maxHeaderBytes", () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, maxHeaderBytes: 4096 };
    const headers = Array.from({ length: 2000 }, (_, i) => `X-H${i}: ${"v".repeat(40)}`).join("\n");
    const p = parseMessage(bytes(`From: a@x.test\n${headers}\n\nbody\n`), limits);
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxHeaderBytes");
  });

  it("oversize input is cut at maxBytes without reading past it", () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, maxBytes: 1024 };
    const p = parseMessage(bytes(`From: a@x.test\n\n${"a".repeat(100_000)}`), limits);
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxBytes");
    expect((p.text ?? "").length).toBeLessThanOrEqual(1024);
  });

  it("pathological boundaries (prefix collisions, unterminated) terminate", () => {
    const body = Array.from({ length: 3000 }, () => "--bb\n--b-\n--b x\n").join("");
    const { value: p, ms } = timed(() =>
      parseMessage(bytes(`From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n${body}`)),
    );
    expect(ms).toBeLessThan(2000);
    // "--b-" / "--b x" are not delimiters of boundary "b", so each "--b " line opens a part until
    // the part budget runs out; the malformed (never-closed) boundary is reported, not thrown.
    expect(p.truncated).toBe(true);
    expect(limitHits(p)).toContain("maxParts");
    expect(p.parts.length).toBeLessThanOrEqual(DEFAULT_PARSE_LIMITS.maxParts);
    expect(p.warnings).toContainEqual({ _tag: "MalformedBoundary", partId: "" });
  });

  it("mbox with thousands of empty entries parses linearly", () => {
    const mbox = (n: number) =>
      enc.encode(Array.from({ length: n }, (_, i) => `From x@y ${i}\n\n`).join(""));
    // Best of three to damp GC/JIT noise; the small size is warmed up by the first runs.
    const best = (input: Uint8Array) => {
      let min = Infinity;
      let count = 0;
      for (let i = 0; i < 3; i++) {
        const { value, ms } = timed(() => readMbox(input));
        count = value.length;
        min = Math.min(min, ms);
      }
      return { count, ms: Math.max(min, 0.5) };
    };
    const small = best(mbox(10_000));
    const large = best(mbox(80_000));
    expect(small.count).toBe(10_000);
    expect(large.count).toBe(80_000);
    // 8× the input: linear ≈ 8×, quadratic ≈ 64×. Allow generous headroom for timer noise.
    expect(large.ms / small.ms).toBeLessThan(24);
    expect(large.ms).toBeLessThan(3000);
  });
});
