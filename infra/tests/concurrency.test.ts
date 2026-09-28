import { describe, expect, it } from "vitest";
import { scanSource, unapproved } from "../policies/check-concurrency.ts";

describe("§7.4 bounded concurrency lint", () => {
  it("flags data-driven fan-out and unbounded Effect concurrency, allows fixed tuples and justified sites", () => {
    const src = [
      "await Promise.all(items.map(send));",
      "await Promise.all([a(), b()]);",
      "// bounded: at most 3 providers",
      "await Promise.all(providers.map(p));",
      'yield* Effect.forEach(xs, f, { concurrency: "unbounded" });',
      "yield* Effect.forEach(xs, f, { concurrency: 4 });",
    ].join("\n");

    expect(scanSource("x.ts", src).map((f) => f.line)).toEqual([1, 5]);
  });

  // The repository itself is scanned by `pnpm check:concurrency` (CI verify), not here.
  it("the allowlist excuses only a listed site in the listed file", () => {
    const allow = [{ file: "a.ts", text: "Promise.all(xs.map(", owner: "t" }];
    const finding = (file: string, text: string) => ({ file, line: 1, text });
    expect(
      unapproved(
        [
          finding("a.ts", "await Promise.all(xs.map(f));"),
          finding("b.ts", "await Promise.all(xs.map(f));"),
          finding("a.ts", "await Promise.all(ys.map(f));"),
        ],
        allow,
      ).map((f) => `${f.file} ${f.text}`),
    ).toEqual(["b.ts await Promise.all(xs.map(f));", "a.ts await Promise.all(ys.map(f));"]);
  });
  it("[§7.4] chunked fan-out (slice(i, i + N)) is treated as bounded", () => {
    expect(
      scanSource("x.ts", "out.push(...(await Promise.all(xs.slice(i, i + LIMIT).map(f))));"),
    ).toEqual([]);
    expect(scanSource("x.ts", "await Promise.all(xs.map(f));")).toHaveLength(1);
  });
  it("[§7.4] reads a call's argument from the next line when split after `Promise.all(`", () => {
    expect(scanSource("x.ts", "await Promise.all(\n  xs.slice(i, i + LIMIT).map(f),\n);")).toEqual(
      [],
    );
    expect(scanSource("x.ts", "await Promise.all(\n  [a(), b()],\n);")).toEqual([]);
    expect(scanSource("x.ts", "await Promise.all(\n  xs.map(f),\n);")).toHaveLength(1);
  });
});
