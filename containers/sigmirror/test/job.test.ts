import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Runs the real job (src/job.ts) once against a stand-in mirror write API and a fake `cvd` binary,
// recording which requests it makes. Covers the prune guard end to end: a failed update never
// deletes from the mirror.

const TOKEN = "t".repeat(32);

const JOB = join(import.meta.dirname, "../src/job.ts");

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

const files = new Map([
  ["main.cvd", "main"],
  ["daily.cvd", "daily"],
  ["daily-100.cdiff", "d100"],
]);

const dirs: Array<string> = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const runJob = async (update: { code: number; writes?: Record<string, string> }) => {
  const requests: Array<string> = [];

  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\/w\//, ""));
    requests.push(`${req.method} ${name}`);
    req.resume();

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();

    if (req.method === "GET" && name === "_manifest") {
      const manifest = Object.fromEntries(
        [...files].map(([n, body]) => [n, { size: body.length, etag: md5(body) }]),
      );

      return res.end(JSON.stringify({ files: manifest }));
    }

    if (req.method === "GET" && name === "_state") return res.writeHead(404).end();

    if (req.method === "GET" && files.has(name)) return res.end(files.get(name));

    if (req.method === "PUT") return req.on("end", () => res.writeHead(201).end());

    if (req.method === "DELETE") return res.writeHead(204).end();

    return res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = mkdtempSync(join(tmpdir(), "bye-sigmirror-job-"));
  dirs.push(root);
  const cvd = join(root, "fake-cvd.sh");

  const writes = Object.entries(update.writes ?? {})
    .map(([n, body]) => `printf %s '${body}' > "$CVD_ROOT/database/${n}"`)
    .join("\n");

  writeFileSync(
    cvd,
    `#!/bin/sh\nif [ "$1" = update ]; then\n${writes}\nexit ${update.code}\nfi\nexit 0\n`,
  );
  chmodSync(cvd, 0o755);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", JOB], {
        env: {
          ...process.env,
          MIRROR_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          WRITE_TOKEN: TOKEN,
          CVD_ROOT: root,
          CVD_BIN: cvd,
        },
        stdio: ["ignore", "ignore", "ignore"],
      });

      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });

    return { exitCode, requests };
  } finally {
    await new Promise((r) => server.close(r));
  }
};

describe("signature mirror job", () => {
  it("[E20] a failed update uploads partial progress but prunes nothing", async () => {
    const { exitCode, requests } = await runJob({ code: 1, writes: { "daily-101.cdiff": "d101" } });
    expect(exitCode).toBe(2);
    expect(requests).toContain("PUT daily-101.cdiff");
    expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
  });

  it("[E20] a clean update prunes only the CDIFFs cvdupdate retired", async () => {
    const { exitCode, requests } = await runJob({ code: 0, writes: { "daily-101.cdiff": "d101" } });
    expect(exitCode).toBe(0);
    // Seeded databases are unchanged, so only the new CDIFF is uploaded.
    expect(requests.filter((r) => r.startsWith("PUT") && r !== "PUT _state")).toEqual([
      "PUT daily-101.cdiff",
    ]);
    expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual(["DELETE daily-100.cdiff"]);
  });
});
