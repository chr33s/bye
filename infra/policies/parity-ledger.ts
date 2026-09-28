// Parity evidence ledger (spec.md §2.4): renders infra/PARITY.md from the §2 ledger,
// the `[ID]` tags in test titles, and the hand-kept evidence in infra/parity-evidence.json.
// `node --experimental-strip-types infra/policies/parity-ledger.ts` rewrites the file;
// infra/tests/parity.test.ts fails when it is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PARITY_LEDGER, type ParityRow } from "../../packages/domain/src/parity.ts";
import { ROOT, sourceFiles } from "./fs.ts";

export const LEDGER_PATH = join(ROOT, "infra/PARITY.md");
const EVIDENCE_PATH = join(ROOT, "infra/parity-evidence.json");

/** IDs tagged in test/describe title strings only, not in comments. */
export const tagsIn = (source: string): Set<string> => {
  const tags = new Set<string>();
  for (const m of source.matchAll(
    /\b(?:it|test|describe)(?:\.\w+)*(?:\([^)]*\))?\(\s*(["'`])([^"'`]*)\1/g,
  )) {
    for (const t of (m[2] ?? "").matchAll(/\[([ECOPAX]\d\d)\]/g)) tags.add(t[1] as string);
  }
  return tags;
};

export const DIMENSIONS = [
  "Domain",
  "API",
  "Web",
  "Native",
  "CLI",
  "TUI",
  "Provider",
  "Recovery",
  "Security",
  "Accessibility",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Dimensions evidenced by tagged tests, and the test paths that count for each. */
const TESTED: ReadonlyArray<readonly [Dimension, (path: string) => boolean]> = [
  [
    "Domain",
    (p) =>
      /^packages\/(domain|application|platform-cloudflare|calendar-engine|mail-codec|contracts)\//.test(
        p,
      ),
  ],
  ["API", (p) => p.startsWith("workers/")],
  ["Web", (p) => p.startsWith("apps/web/")],
  ["Native", (p) => /^(packages\/native-shared|apps\/mobile|apps\/desktop)\//.test(p)],
  ["CLI", (p) => p.startsWith("apps/cli/") && !/tui/i.test(p)],
  ["TUI", (p) => p.startsWith("apps/cli/") && /tui/i.test(p)],
];

const EXTERNAL = new Set(["E17", "E18", "E19", "E22", "E23", "C04", "C10", "O01", "P02", "A02"]);
const TUI_SCOPE = new Set([
  "E01",
  "E04",
  "E07",
  "E08",
  "E09",
  "E17",
  "E18",
  "E20",
  "E21",
  "E24",
  "C01",
  "C02",
  "C04",
  "X02",
]);

/** Where a dimension applies to a row (spec.md §2.4); elsewhere the cell is `—`. */
const applies = (id: string, d: Dimension): boolean => {
  const area = id[0];
  switch (d) {
    case "Domain":
    case "API":
    case "Recovery":
    case "Security":
      return true;
    case "Web":
    case "Accessibility":
      return id !== "X02";
    case "Native":
      return area === "E" || area === "C" || id === "A03" || id === "X01";
    case "CLI":
      return area === "E" || area === "C" || id === "X02";
    case "TUI":
      return TUI_SCOPE.has(id);
    case "Provider":
      return EXTERNAL.has(id);
  }
};

interface RowEvidence {
  readonly owner?: string;
  /** Evidence per dimension: a repo path, an `evidence/<date>-<item>/` run, or `excluded: <reason>`. */
  readonly cells?: Partial<Record<Dimension, string>>;
}

const LEVELS = [
  "open",
  "repository-complete",
  "client-complete",
  "integration-qualified",
  "production-accepted",
] as const;

/**
 * The lowest level every applicable cell reaches (spec.md §2.4). A tagged test proves at most
 * repository-complete for Domain/API and client-complete for client dimensions; only recorded
 * `evidence/` runs reach integration-qualified or production-accepted (spec.md §2.4).
 */
const levelOf = (cells: ReadonlyMap<Dimension, string>): (typeof LEVELS)[number] => {
  const done = (d: Dimension, real = false) => {
    const c = cells.get(d)!;
    return (
      c === "—" || c.startsWith("excluded") || (c !== "open" && (!real || c.includes("evidence/")))
    );
  };
  if (!done("Domain") || !done("API")) return "open";
  if (!(["Web", "Native", "CLI", "TUI", "Accessibility"] as const).every((d) => done(d)))
    return "repository-complete";
  if (!done("Provider", true)) return "client-complete";
  if (!(["Recovery", "Security"] as const).every((d) => done(d, true)))
    return "integration-qualified";
  return "production-accepted";
};

const cell = (value: string): string =>
  value.includes("/") && !value.startsWith("excluded")
    ? `[✓](${value.startsWith("evidence/") ? value : `../${value}`})`
    : value;

export const renderLedger = (): string => {
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, RowEvidence>;
  const tagged = new Map<string, Map<Dimension, Array<string>>>();
  for (const file of sourceFiles(["packages", "workers", "apps"], { ext: /\.test\.tsx?$/ })) {
    const path = relative(ROOT, file);
    const dims = TESTED.filter(([, match]) => match(path)).map(([d]) => d);
    for (const id of tagsIn(readFileSync(file, "utf8"))) {
      const byDim = tagged.get(id) ?? new Map<Dimension, Array<string>>();
      for (const d of dims) byDim.set(d, [...(byDim.get(d) ?? []), path]);
      tagged.set(id, byDim);
    }
  }
  const rows = PARITY_LEDGER.map((r: ParityRow) => {
    const manual = evidence[r.id] ?? {};
    const cells = new Map<Dimension, string>();
    for (const d of DIMENSIONS) {
      const tests = tagged.get(r.id)?.get(d) ?? [];
      cells.set(
        d,
        manual.cells?.[d] ?? (!applies(r.id, d) ? "—" : tests.length > 0 ? tests[0]! : "open"),
      );
    }
    return `| ${r.id} | ${r.capability} | ${manual.owner ?? "unassigned"} | ${levelOf(cells)} | ${DIMENSIONS.map((d) => cell(cells.get(d)!)).join(" | ")} |`;
  });
  return [
    "# Parity evidence ledger",
    "",
    "<!-- Generated by infra/policies/parity-ledger.ts from the §2 ledger, tagged tests and infra/parity-evidence.json. Do not edit by hand. -->",
    "",
    "One row per `spec.md` §2 capability, one column per evidence dimension (§2.4).",
    "",
    "- `—`: not applicable. `open`: no evidence yet. `excluded: …`: deliberately out of advertised scope.",
    "- `✓` links the first tagged test, or the recorded `evidence/` run, for that cell.",
    "- **Level** is the lowest completion level (§2.4) reached across the row's applicable cells. Tagged tests alone never exceed client-complete; integration-qualified and production-accepted need `evidence/` runs.",
    "",
    "Record owners and hand-kept evidence in `infra/parity-evidence.json`, then run `pnpm parity:ledger`.",
    "",
    `| ID | Capability | Owner | Level | ${DIMENSIONS.join(" | ")} |`,
    `| --- | --- | --- | --- | ${DIMENSIONS.map(() => "---").join(" | ")} |`,
    ...rows,
    "",
  ].join("\n");
};

if (import.meta.main) writeFileSync(LEDGER_PATH, renderLedger());
