import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { build } from "rolldown";

// Bundles the CLI into one publishable file, dist/bye.js: workspace packages (@bye/domain,
// @bye/native-shared, type-only @bye/contracts) are inlined, so the published package has no
// `workspace:*` dependencies and never runs .ts from node_modules. `effect` stays an external,
// exactly pinned dependency.

const root = new URL(".", import.meta.url).pathname;

const out = `${root}dist/bye.js`;

const node = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

await rm(`${root}dist`, { recursive: true, force: true });

await build({
  input: `${root}src/main.ts`,
  platform: "node",
  external: (id) => node.has(id) || id === "effect" || id.startsWith("effect/"),
  output: { file: out, format: "esm", minify: false, sourcemap: false },
  logLevel: "warn",
});

// One portable shebang (the source's `-S node --experimental-strip-types` is for running .ts).
const code = (await readFile(out, "utf8")).replace(/^(#!.*\n)+/, "");

await writeFile(out, `#!/usr/bin/env node\n${code}`);

await chmod(out, 0o755);

console.log("built apps/cli/dist/bye.js");
