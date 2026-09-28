import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isMirrorFile, planSync, type RemoteFile, seedNames } from "./sync.ts";

// Mirror job (one run, then exit). Seeds cvdupdate from our mirror so only deltas are fetched from
// database.clamav.net, runs `cvd update`, and uploads changed files through the SigMirror write API
// (reached via an intercepted internal hostname; no R2 credentials in the container). Logs counts,
// never file contents.

const MIRROR_URL = process.env.MIRROR_URL ?? "";

const WRITE_TOKEN = process.env.WRITE_TOKEN ?? "";

const ROOT = process.env.CVD_ROOT ?? "/tmp/cvd";

const DB = join(ROOT, "database");

const CONFIG = join(ROOT, "config.json");

const CVD = process.env.CVD_BIN ?? "/opt/cvd/bin/cvd";

/** Overall bound for one `cvd update`; partial progress is still uploaded and retried next run. */
const CVD_TIMEOUT_MS = Number(process.env.CVD_TIMEOUT_MS ?? 20 * 60_000);

const log = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>> = {},
) => console.log(JSON.stringify({ level: "info", op: "sigmirror.job", event, ...fields }));

const api = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${WRITE_TOKEN}`);

  return fetch(`${MIRROR_URL}/w/${path}`, { ...init, headers });
};

const run = (args: ReadonlyArray<string>, timeoutMs = CVD_TIMEOUT_MS) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(CVD, args, { stdio: ["ignore", "inherit", "inherit"] });

    const timer = setTimeout(() => {
      log("timeout", { command: args[0], ms: timeoutMs });
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("exit", (code) => (clearTimeout(timer), resolve(code ?? 1)));
  });

const md5 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const main = async () => {
  if (!MIRROR_URL || WRITE_TOKEN.length < 32)
    throw new Error("MIRROR_URL and WRITE_TOKEN are required");
  await mkdir(DB, { recursive: true });
  await mkdir(join(ROOT, "logs"), { recursive: true });

  const manifestResponse = await api("_manifest");

  if (!manifestResponse.ok) throw new Error(`manifest: HTTP ${manifestResponse.status}`);
  const remote = ((await manifestResponse.json()) as { files: Record<string, RemoteFile> }).files;

  // Persisted cvdupdate state keeps Retry-After / If-Modified-Since across runs (ClamAV rate limits).
  const state = await api("_state");

  if (state.ok) await writeFile(join(ROOT, "state.json"), Buffer.from(await state.arrayBuffer()));

  for (const name of seedNames(remote)) {
    const res = await api(name);

    if (!res.ok || !res.body) throw new Error(`seed ${name}: HTTP ${res.status}`);
    await writeFile(join(DB, name), Readable.fromWeb(res.body as never));
  }

  log("seeded", { files: seedNames(remote).length, state: state.ok });

  if (
    (await run([
      "config",
      "set",
      "--config",
      CONFIG,
      "--dbdir",
      DB,
      "--logdir",
      join(ROOT, "logs"),
    ])) !== 0
  )
    throw new Error("cvd config failed");
  const updateCode = await run(["update", "--config", CONFIG]);
  // cvdupdate returns the number of errors; partial progress is still uploaded.
  log("updated", { errors: updateCode });

  const local = await Promise.all(
    (await readdir(DB)).filter(isMirrorFile).map(async (name) => ({
      name,
      size: (await stat(join(DB, name))).size,
      md5: await md5(join(DB, name)),
    })),
  );

  // A failed or partial update keeps every remote CDIFF: pruning waits for the next clean run.
  const plan = planSync(local, remote, { succeeded: updateCode === 0 });

  for (const name of plan.upload) {
    const path = join(DB, name);
    const size = (await stat(path)).size;

    const res = await api(name, {
      method: "PUT",
      headers: { "content-length": String(size) },
      body: Readable.toWeb(createReadStream(path)) as never,
      duplex: "half",
    } as RequestInit);

    if (res.status !== 201) throw new Error(`upload ${name}: HTTP ${res.status}`);
  }

  for (const name of plan.prune) await api(name, { method: "DELETE" });
  const stateBytes = await readFile(join(ROOT, "state.json")).catch(() => null);

  if (stateBytes)
    await api("_state", {
      method: "PUT",
      headers: { "content-length": String(stateBytes.byteLength) },
      body: stateBytes,
    });
  log("synced", {
    uploaded: plan.upload.length,
    unchanged: plan.unchanged,
    pruned: plan.prune.length,
  });
  process.exitCode = updateCode === 0 ? 0 : 2;
};

main().catch((error: Error | string) => {
  console.error(
    JSON.stringify({
      level: "error",
      op: "sigmirror.job",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
