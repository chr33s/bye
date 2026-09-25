// State backup/restore drill (§15.6, §13 "state backend/key recovery"). Runs the real state
// Worker (infra/state/worker.ts) in workerd via Miniflare with SQLite DO storage and R2, drives it
// with alchemy's own HttpStateStore client, then: snapshot → destroy all state → restore from the
// snapshot → verify every resource/output reads back identically. Also proves the writer lease.
//
// Usage: node --experimental-strip-types infra/drills/state-drill.ts   (exit 0 = drill passed)
// Against a deployed backend the same steps run through infra/drills/state-drill-remote.md.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { Miniflare } from "miniflare";
import { build } from "rolldown";
import { COMPATIBILITY } from "../resources/workers.ts";

export interface DrillReport {
  readonly written: number;
  readonly snapshotKey: string;
  readonly restored: number;
  readonly mismatches: ReadonlyArray<string>;
  readonly lockContended: boolean;
}

const TOKEN = "drill-state-token-0123456789abcdef";
const ADMIN = "drill-admin-token-0123456789abcdef";
const KEY = `v1:${"ab".repeat(32)}`;

export const runStateDrill = async (): Promise<DrillReport> => {
  const dir = mkdtempSync(join(tmpdir(), "bye-state-drill-"));
  const script = join(dir, "state.js");
  await build({
    input: join(import.meta.dirname, "../state/worker.ts"),
    platform: "neutral",
    external: [/^cloudflare:/],
    output: { file: script, format: "esm" },
    logLevel: "silent",
  });
  const mf = new Miniflare({
    modules: true,
    scriptPath: script,
    modulesRoot: dir,
    compatibilityDate: COMPATIBILITY.date,
    bindings: { STATE_TOKEN: TOKEN, STATE_ENCRYPTION_KEY: KEY, STATE_ADMIN_TOKEN: ADMIN },
    durableObjects: { STATE: { className: "StateStoreObject", useSQLite: true } },
    r2Buckets: ["BACKUPS"],
  });
  try {
    await mf.ready;
    const origin = "https://state.drill";
    // Bridge Node's fetch shapes to Miniflare's own (undici) Request/Response types.
    const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const response = await mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        ...(body === undefined ? {} : { body }),
      });
      return new Response(
        response.status === 204 || response.status === 304 ? null : await response.text(),
        { status: response.status, headers: Object.fromEntries(response.headers) },
      );
    };
    const client = makeHttpStateStore({ url: origin, authToken: TOKEN, id: "drill" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, serve as typeof fetch),
    );
    const store = await Effect.runPromise(client);
    const fixtures: Array<{ stack: string; stage: string; fqn: string; value: unknown }> = [];
    for (const stack of ["MailboxPlatform", "ByeFoundation"]) {
      for (const stage of ["staging", "prod"]) {
        for (let i = 0; i < 5; i++)
          fixtures.push({
            stack,
            stage,
            fqn: `Ns/Resource${i}`,
            value: { status: "created", attr: { id: `${stack}-${stage}-${i}` }, props: { i } },
          });
      }
    }
    for (const f of fixtures)
      await Effect.runPromise(
        store.set({ stack: f.stack, stage: f.stage, fqn: f.fqn, value: f.value as never }),
      );

    const admin = (path: string, body?: unknown) =>
      serve(`${origin}/state/admin/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-bye-admin-token": ADMIN,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const snapshotKey = ((await (await admin("snapshot")).json()) as { key: string }).key;

    // Disaster: every stack deleted.
    for (const stack of ["MailboxPlatform", "ByeFoundation"]) {
      await serve(`${origin}/state/stacks/${stack}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    }
    const restored = (
      (await (await admin("restore", { key: snapshotKey })).json()) as { restored: number }
    ).restored;

    const mismatches: Array<string> = [];
    for (const f of fixtures) {
      const got = await Effect.runPromise(
        store.get({ stack: f.stack, stage: f.stage, fqn: f.fqn }),
      );
      if (JSON.stringify(got) !== JSON.stringify(f.value))
        mismatches.push(`${f.stack}/${f.stage}/${f.fqn}`);
    }

    const lock = (holder: string) =>
      serve(`${origin}/state/locks/MailboxPlatform/prod`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ holder, ttlMs: 60_000 }),
      });
    const first = await lock("ci-run-1");
    const second = await lock("ci-run-2");
    return {
      written: fixtures.length,
      snapshotKey,
      restored,
      mismatches,
      lockContended: first.status === 200 && second.status === 409,
    };
  } finally {
    await mf.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const report = await runStateDrill();
  console.log(JSON.stringify(report, null, 2));
  process.exit(
    report.mismatches.length === 0 && report.restored >= report.written && report.lockContended
      ? 0
      : 1,
  );
}
