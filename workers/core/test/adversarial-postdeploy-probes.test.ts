import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { build } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProbes } from "../../../infra/probes/run.ts";
import { COMPATIBILITY } from "../../../infra/resources/workers.ts";

// Post-deploy probes (§15.10) against the real MailCore bundle in workerd: HTTP, queue → consumer,
// DO alarm, Workflow checkpoint — plus the guard that hides probe routes without the token.

const ROOT = join(import.meta.dirname, "../../..");
const TOKEN = "probe-token-0123456789abcdef";

describe("post-deploy probes against MailCore in workerd", () => {
  let mf: Miniflare;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bye-probes-"));
    const script = join(dir, "core.js");
    await build({
      input: join(ROOT, "workers/core/src/index.ts"),
      platform: "neutral",
      external: [/^cloudflare:/],
      resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
      output: { file: script, format: "esm" },
      logLevel: "silent",
    });
    mf = new Miniflare({
      modules: true,
      scriptPath: script,
      modulesRoot: dir,
      compatibilityDate: COMPATIBILITY.date,
      bindings: {
        APP_ORIGIN: "https://app.bye.test",
        MAIL_ORIGIN: "https://mail.bye-render.test",
        PROBE_TOKEN: TOKEN,
        SESSION_KEY: "k".repeat(32),
        PROXY_SIGNING_KEY: "p".repeat(32),
      },
      d1Databases: ["DIRECTORY"],
      kvNamespaces: ["CONFIG_CACHE"],
      queueProducers: { PROPAGATE: { queueName: "propagate" } },
      queueConsumers: { propagate: { maxBatchSize: 5, maxBatchTimeout: 0.1, maxRetries: 2 } },
      durableObjects: {
        PROBES: { className: "ProbeDO", useSQLite: true },
        CALENDARS: { className: "CalendarDO", useSQLite: true },
      },
      workflows: { PROBE_WORKFLOW: { name: "probe", className: "ProbeWorkflow" } },
    });
    await mf.ready;
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fetcher = async (url: string, init?: RequestInit) => {
    const r = await mf.dispatchFetch(url, init as never);
    return new Response(await r.text(), {
      status: r.status,
      headers: Object.fromEntries(r.headers),
    });
  };

  it("[A03] every probe passes on a healthy deploy (queue, alarm, workflow, HTTP)", async () => {
    const results = await runProbes("https://app.bye.test", TOKEN, fetcher, 30_000);
    expect(
      results.filter((r) => !r.ok),
      JSON.stringify(results),
    ).toEqual([]);
    expect(results.map((r) => r.name)).toEqual([
      "http.unauthenticated",
      "http.probe-guard",
      "queue.round-trip",
      "do.alarm",
      "workflow.checkpoint",
      "calendar.event",
    ]);
  }, 90_000);

  it("[A03] probe routes are invisible without the operator token", async () => {
    const results = await runProbes(
      "https://app.bye.test",
      "wrong-token-0123456789",
      fetcher,
      1_000,
    );
    // Every guarded probe is refused with a 404 (indistinguishable from a missing route), while
    // the unauthenticated HTTP probes still pass.
    expect(Object.fromEntries(results.map((r) => [r.name, [r.ok, r.detail]]))).toEqual({
      "http.unauthenticated": [true, "status 401"],
      "http.probe-guard": [true, "unauthenticated probe → 404"],
      "queue.round-trip": [false, "send 404"],
      "do.alarm": [false, "arm 404"],
      "workflow.checkpoint": [false, "create 404"],
      "calendar.event": [false, "failed at status 404"],
    });
    const wrong = await mf.dispatchFetch("https://app.bye.test/__probe/queue/p12345678", {
      headers: { "x-bye-probe-token": "wrong-token-0123456789" },
    });
    const missing = await mf.dispatchFetch("https://app.bye.test/__nothing/here");
    expect([
      wrong.status,
      ((await wrong.json()) as { error: { code: string } }).error.code,
    ]).toEqual([404, "not_found"]);
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  }, 30_000);
});
