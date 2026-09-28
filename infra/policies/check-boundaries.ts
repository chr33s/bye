// Platform import boundaries (§7.1, §7.5). Run: pnpm check:boundaries
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { sourceFiles } from "./fs.ts";

export interface BoundaryIssue {
  readonly file: string;
  readonly message: string;
}

const IMPORT =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export interface ImportRef {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export const importsOf = (source: string): ReadonlyArray<ImportRef> => {
  const refs: Array<ImportRef> = [];

  for (const m of source.matchAll(IMPORT)) {
    const specifier = m[3] ?? m[4];

    if (specifier !== undefined) refs.push({ specifier, typeOnly: m[2] !== undefined });
  }

  return refs;
};

const FORBIDDEN_RUNTIME = [
  /^alchemy(\/|$)/,
  /^@effect\/platform-node/,
  /^@effect\/platform-bun/,
  /^node:/,
  /^bun(:|$)/,
];

/** Domain code: pure policy only (§7.1). */
const DOMAIN_FORBIDDEN_IMPORTS = [
  /^alchemy/,
  /^@effect\//,
  /^cloudflare:/,
  /^node:/,
  /^@cloudflare\//,
  /^effect\/unstable/,
];

const DOMAIN_FORBIDDEN_CALLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bDate\.now\s*\(/, "Date.now (inject a clock)"],
  [/\bnew Date\s*\(\s*\)/, "new Date() (inject a clock)"],
  [/\bprocess\.env\b/, "process.env"],
  [/\bMath\.random\s*\(/, "Math.random (inject randomness)"],
];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export const checkSource = (file: string, source: string): ReadonlyArray<BoundaryIssue> => {
  const issues: Array<BoundaryIssue> = [];
  const path = file.replaceAll("\\", "/");
  const inTesting = path.startsWith("packages/testing/");
  const isTest = /\/test\//.test(path) || path.endsWith(".test.ts");

  const runtime =
    (path.startsWith("workers/") || path.startsWith("packages/")) && !inTesting && !isTest;

  for (const ref of importsOf(source)) {
    if (runtime && FORBIDDEN_RUNTIME.some((r) => r.test(ref.specifier)) && !ref.typeOnly) {
      issues.push({ file, message: `runtime code must not import ${ref.specifier}` });
    }

    if (runtime && /(^|\/)(infra|alchemy\.run)(\/|\.ts|$)/.test(ref.specifier) && !ref.typeOnly) {
      issues.push({
        file,
        message: `runtime code may only type-import deployment modules (${ref.specifier})`,
      });
    }

    if (
      path.startsWith("packages/domain/src/") &&
      DOMAIN_FORBIDDEN_IMPORTS.some((r) => r.test(ref.specifier))
    ) {
      issues.push({ file, message: `domain must not import ${ref.specifier}` });
    }
  }

  if (path.startsWith("packages/domain/src/")) {
    const code = stripComments(source);

    for (const [pattern, label] of DOMAIN_FORBIDDEN_CALLS) {
      if (pattern.test(code)) issues.push({ file, message: `domain must not call ${label}` });
    }
  }

  if (runtime && /\bCLOUDFLARE_API_TOKEN\b/.test(source)) {
    issues.push({ file, message: "runtime code must not reference the management token" });
  }

  return issues;
};

export const checkRepository = (root: string): ReadonlyArray<BoundaryIssue> => {
  const files = sourceFiles(["packages", "workers", "apps"], { ext: /\.(ts|tsx|mts)$/, root });

  return files.flatMap((f) => checkSource(relative(root, f), readFileSync(f, "utf8")));
};

if (import.meta.main) {
  const issues = checkRepository(process.cwd());

  for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);

  if (issues.length > 0) process.exit(1);
  console.log("boundaries: runtime and domain import rules hold");
}
