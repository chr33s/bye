import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "rolldown";

// Release gate (§7.5, §15.10): bundle each Worker for workerd and prove the output imports only
// `cloudflare:*` modules — no Alchemy management code, Node/Bun runtimes, or a second Effect copy —
// and embeds no obvious secret material.

const FORBIDDEN = [
  /["']alchemy/,
  /["']node:/,
  /["']@effect\/platform-(node|bun)/,
  /CLOUDFLARE_API_TOKEN/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const MAX_BYTES = 3 * 1024 * 1024;

export const checkWorkerBundle = async (
  entry: string,
): Promise<{
  bytes: number;
  imports: ReadonlyArray<string>;
  violations: ReadonlyArray<string>;
}> => {
  const dir = mkdtempSync(join(tmpdir(), "bye-bundle-"));
  try {
    const file = join(dir, "worker.js");
    await build({
      input: entry,
      platform: "neutral",
      external: [/^cloudflare:/],
      resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
      output: { file, format: "esm", minify: true },
      logLevel: "silent",
    });
    const code = readFileSync(file, "utf8");
    const staticImports = [
      ...code.matchAll(
        /(?:^|[;}\n])\s*(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"'\n]+)["']/g,
      ),
    ].map((m) => m[1]!);
    const dynamicImports = [...code.matchAll(/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g)].map(
      (m) => m[1]!,
    );
    const imports = [...new Set([...staticImports, ...dynamicImports])];
    const violations = [
      ...imports.filter((i) => !i.startsWith("cloudflare:")).map((i) => `unexpected import ${i}`),
      ...FORBIDDEN.filter((re) => re.test(code)).map((re) => `forbidden content ${re}`),
      ...(code.length > MAX_BYTES ? [`bundle exceeds ${MAX_BYTES} bytes`] : []),
    ];
    return { bytes: code.length, imports, violations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  let failed = false;
  for (const worker of ["core", "public", "sigmirror"]) {
    const result = await checkWorkerBundle(`workers/${worker}/src/index.ts`);
    console.log(
      `bundle ${worker}: ${(result.bytes / 1024).toFixed(0)} KiB, imports ${result.imports.join(", ") || "(none)"}`,
    );
    for (const v of result.violations) console.error(`  ${v}`);
    failed ||= result.violations.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
