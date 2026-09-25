// §7.4 Concurrency: "Bound parsing, indexing, provider calls, and fanout explicitly. No unbounded
// Effect.all or stream parallelism over messages, recipients, or attachments."
// Flags `Promise.all(<data>.map(...))`-style fan-out and `concurrency: "unbounded"` in server code.
// A fixed literal tuple (`Promise.all([a(), b()])`) is bounded by construction. Deliberate cases
// carry a `// bounded: <why>` comment on the line or the line above; legacy sites awaiting a fix
// are listed in concurrency-allowlist.json (new sites always fail).
//
// Usage: node --experimental-strip-types infra/policies/check-concurrency.ts
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, sourceFiles } from "./fs.ts";

export const SERVER_ROOTS = [
  "workers",
  "packages/platform-cloudflare/src",
  "packages/application/src",
];

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scan one source text; exported for tests. */
export const scanSource = (file: string, source: string): ReadonlyArray<Finding> => {
  const lines = source.split("\n");
  const out: Array<Finding> = [];
  lines.forEach((text, i) => {
    const bounded = /\/\/\s*bounded:/.test(text) || /\/\/\s*bounded:/.test(lines[i - 1] ?? "");
    if (bounded) return;
    const unboundedEffect = /concurrency:\s*"unbounded"/.test(text);
    // A call split after `Promise.all(` keeps its argument on the next line.
    const call = /Promise\.all(Settled)?\(\s*$/.test(text) ? `${text} ${lines[i + 1] ?? ""}` : text;
    // Chunked fan-out (`xs.slice(i, i + N)`) is bounded by the chunk size.
    const chunked = /\.slice\(\s*\w+\s*,\s*\w+\s*\+\s*[\w.]+\s*\)/.test(call);
    const promiseAll =
      /Promise\.all(Settled)?\(/.test(text) &&
      !/Promise\.all(Settled)?\(\s*\[/.test(call) &&
      !chunked;
    if (unboundedEffect || promiseAll) out.push({ file, line: i + 1, text: text.trim() });
  });
  return out;
};

export const scanRepo = (): ReadonlyArray<Finding> =>
  sourceFiles(SERVER_ROOTS, { ext: /\.ts$/, skip: ["test"] }).flatMap((f) =>
    scanSource(relative(ROOT, f), readFileSync(f, "utf8")),
  );

export const loadAllowlist = (): ReadonlyArray<{
  readonly file: string;
  readonly text: string;
  readonly owner: string;
}> =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "concurrency-allowlist.json"), "utf8"),
  ) as ReadonlyArray<{ file: string; text: string; owner: string }>;

export const unapproved = (
  findings: ReadonlyArray<Finding>,
  allow = loadAllowlist(),
): ReadonlyArray<Finding> =>
  findings.filter((f) => !allow.some((a) => a.file === f.file && f.text.includes(a.text)));

if (import.meta.main) {
  const bad = unapproved(scanRepo());
  for (const f of bad)
    console.error(`concurrency: ${f.file}:${f.line} unbounded fan-out: ${f.text}`);
  if (bad.length) {
    console.error(
      "bound it (Effect.forEach({ concurrency: n }) / chunking) or add `// bounded: <reason>`",
    );
    process.exit(1);
  }
  console.log("concurrency: no unbounded fan-out in server code");
}
