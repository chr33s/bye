import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { build } from "rolldown";

// Local stand-in for the deployed SigMirror Worker, used by smoke.sh: the real mirror handler
// (workers/sigmirror/src/mirror.ts) running in workerd with a persisted R2 bucket, listening on the
// container network so the job and scanner containers can reach it.

const root = join(import.meta.dirname, "../../..");
const port = Number(process.env.SIGMIRROR_PORT ?? "18091");
const dir = mkdtempSync(join(tmpdir(), "bye-sigmirror-"));
const entry = join(dir, "entry.ts");
await import("node:fs/promises").then((fs) =>
  fs.writeFile(
    entry,
    `import { handleMirror } from ${JSON.stringify(join(root, "workers/sigmirror/src/mirror.ts"))};\nexport default { fetch: (r, e) => handleMirror(r, e) };\n`,
  ),
);
await build({
  input: entry,
  platform: "neutral",
  output: { file: join(dir, "worker.js"), format: "esm" },
  logLevel: "silent",
});

const mf = new Miniflare({
  compatibilityDate: "2026-07-30",
  modules: true,
  scriptPath: join(dir, "worker.js"),
  modulesRoot: dir,
  host: "0.0.0.0",
  port,
  r2Buckets: ["SIGNATURES"],
  r2Persist: process.env.SIGMIRROR_R2_DIR ?? join(dir, "r2"),
  bindings: { WRITE_TOKEN: process.env.WRITE_TOKEN ?? "" },
});
const url = await mf.ready;
console.log(`sigmirror listening on ${url.href}`);
const stop = async () => {
  await mf.dispose();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
