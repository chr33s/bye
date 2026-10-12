import { Client as LinagoraClient } from "jmap-client-ts";
import { JamClient } from "jmap-jam";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Predicate } from "effect";
import { type JsonRecord, mockAs } from "./harness.ts";
import { APP, OPS_TOKEN, startWorkerd, type WorkerdEnv } from "./workerd-env.ts";

// spec.md §16 D2 evidence from a local deployment: the production bundles in real workerd with
// SQLite Durable Objects behind their RPC boundary, D1 with every migration applied, R2 and
// queue consumers. It runs the per-account cutover, real email ingestion, the two independent
// clients over HTTP, EventSource, revocation, and request latencies; the measured numbers are
// printed as one JSON line (`JMAP_EVIDENCE`). Local evidence only: not a Cloudflare deployment.
// Size: BYE_WORKERD_JMAP_MESSAGES (default 60).

const MESSAGES = Number(process.env.BYE_WORKERD_JMAP_MESSAGES ?? 60);

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
  "https://github.com/chr33s/bye/blob/main/spec.md#jmap-capability",
];

const p = (xs: ReadonlyArray<number>, q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;

const round = (n: number) => Math.round(n * 100) / 100;

describe("JMAP on a local workerd deployment", () => {
  let env: WorkerdEnv;
  const evidence: { [key: string]: number | string | boolean | ReadonlyArray<string> } = {};

  // Miniflare's Response is undici's; the clients only use the fetch API surface they share.
  const fetchWorker = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    mockAs<Promise<Response>>(
      env.mf.dispatchFetch(
        input instanceof Request ? input.url : String(input),
        mockAs(input instanceof Request ? { method: input.method, headers: input.headers } : init),
      ),
    );

  const api = async (
    calls: ReadonlyArray<readonly [string, object, string]>,
    token = env.token,
  ) => {
    const r = await fetchWorker(`${APP}/jmap/api`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    });

    return {
      status: r.status,
      body: (await r.json()) as {
        methodResponses: Array<[string, JsonRecord, string]>;
      },
    };
  };

  const deliver = async (i: number) => {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      "From: carol@example.net",
      "To: ana@bye.test",
      `Subject: ${i % 4 === 0 ? "" : "Re: "}Report ${Math.floor(i / 4)}`,
      "Date: Mon, 12 Oct 2026 12:00:00 +0000",
      `Message-ID: <wd-${i}@example.net>`,
      ...(i % 4 === 0 ? [] : [`In-Reply-To: <wd-${i - 1}@example.net>`]),
      "Content-Type: text/plain; charset=utf-8",
      "",
      `token-${i} quarterly figures attached below`,
      "",
    ].join("\r\n");

    const r = await env.mf.dispatchFetch(
      `${APP}/cdn-cgi/handler/email?from=carol@example.net&to=ana@bye.test`,
      { method: "POST", body: raw },
    );

    expect(r.status).toBe(200);
  };

  const count = async () => {
    const r = await api([
      ["Email/query", { accountId: env.mailboxId, calculateTotal: true, limit: 1 }, "q"],
    ]);

    return Number(r.body.methodResponses[0]?.[1]["total"] ?? 0);
  };

  const until = async (check: () => Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;

    while (!(await check())) {
      if (Date.now() > end) throw new Error("condition not reached");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    env = await startWorkerd({ trafficClasses: "transactional,personal" });
  }, 180_000);

  afterAll(async () => {
    console.log(`JMAP_EVIDENCE ${JSON.stringify(evidence)}`);
    vi.unstubAllGlobals();
    await env?.dispose();
  });

  it("applies every D1 migration in order, including the JMAP registry tables", async () => {
    const d1 = await env.mf.getD1Database("DIRECTORY", "core");

    for (const table of [
      "authority_generations",
      "jmap_push_subscriptions",
      "send_attempts",
      "dispatch_holds",
    ])
      expect(
        await d1
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .bind(table)
          .first(),
        table,
      ).not.toBeNull();
    evidence["d1Migrations"] = env.migrations.length;
    evidence["d1LastMigration"] = env.migrations.at(-1) ?? "";
  });

  it("cuts an account over while mail is arriving, then serves it from the JMAP core", async () => {
    const headers = { cookie: env.cookie, origin: APP, "content-type": "application/json" };

    await env.mf.dispatchFetch(`${APP}/v1/mailboxes/${env.mailboxId}/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commandId: "cmd_workerd_jmap_policy01",
        _tag: "SetPolicy",
        kind: "domain",
        subject: "example.net",
        policy: {
          decision: "allowed",
          destination: "imbox",
          labels: [],
          bundle: false,
          notify: false,
        },
      }),
    });

    for (let i = 0; i < 4; i++) await deliver(i);

    await until(async () => {
      const v = await env.mf.dispatchFetch(`${APP}/v1/mailboxes/${env.mailboxId}/views/imbox`, {
        headers: { cookie: env.cookie },
      });

      return ((await v.json()) as { items?: Array<unknown> }).items?.length === 1;
    });

    const ops = (action: string) =>
      env.mf.dispatchFetch(`${APP}/v1/ops/jmap/migrate`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ mailboxId: env.mailboxId, confirm: env.mailboxId, action }),
      });

    const t0 = Date.now();
    expect(((await (await ops("step")).json()) as { mode: string }).mode).toBe("backfilling");
    // Mail that arrives while fenced is buffered, not lost.
    await deliver(4);

    const started = (await (await ops("start")).json()) as {
      mode: string;
      verified: boolean;
      buffered: number;
    };

    expect(started).toMatchObject({ mode: "verifying", verified: true });
    const activated = (await (await ops("activate")).json()) as { mode: string };
    expect(activated.mode).toBe("jmap");
    evidence["cutoverWriteInterruptionMs"] = Date.now() - t0;

    await until(async () => (await count()) === 5);

    const session = await fetchWorker(`${APP}/.well-known/jmap`, {
      headers: { authorization: `Bearer ${env.token}` },
    });

    const s = (await session.json()) as { accounts: Record<string, { isReadOnly: boolean }> };
    expect(s.accounts[env.mailboxId]?.isReadOnly).toBe(false);
  }, 120_000);

  it("ingests real mail through the queues into staged JMAP publication", async () => {
    const before = await count();
    const t0 = Date.now();

    for (let i = 5; i < 5 + MESSAGES; i++) await deliver(i);
    await until(async () => (await count()) === before + MESSAGES, 300_000);
    const ms = Date.now() - t0;

    evidence["ingestMessages"] = MESSAGES;
    evidence["ingestMsPerMessage"] = round(ms / MESSAGES);
  }, 600_000);

  it("interoperates with jmap-jam 0.13.8 and jmap-client-ts 1.0.0 over HTTP", async () => {
    vi.stubGlobal("fetch", fetchWorker);
    const jam = new JamClient({ sessionUrl: `${APP}/.well-known/jmap`, bearerToken: env.token });
    const accountId = await jam.getPrimaryAccount();

    const [r] = await jam.requestMany((t) => {
      const q = t.Email.query({ accountId, filter: { text: "token-7" } });

      return {
        q,
        g: t.Email.get({
          accountId,
          ids: q.$ref("/ids"),
          properties: ["id", "subject", "threadId"],
        }),
      };
    });

    expect(r.g.list).toHaveLength(1);
    const [threads] = await jam.api.Thread.get({ accountId, ids: [r.g.list[0]!.threadId] });
    expect(threads.list[0]!.emailIds.length).toBeGreaterThanOrEqual(2);
    vi.unstubAllGlobals();

    const linagora = new LinagoraClient({
      sessionUrl: `${APP}/.well-known/jmap`,
      accessToken: env.token,
      transport: {
        get: async (url, headers) => (await fetchWorker(url, { method: "GET", headers })).json(),
        post: async (url, content, headers) =>
          (
            await fetchWorker(url, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(content),
            })
          ).json(),
      },
    });

    await linagora.fetchSession();
    const mailboxes = await linagora.mailbox_get({ accountId, ids: null });
    const created = await linagora.mailbox_set({ accountId, create: { m: { name: "Workerd" } } });
    expect(created.created?.["m"]?.id).toEqual(expect.any(String));
    const changes = await linagora.mailbox_changes({ accountId, sinceState: mailboxes.state });
    expect(changes.created).toEqual([created.created?.["m"]?.id]);
    evidence["interopClients"] = ["jmap-jam@0.13.8", "jmap-client-ts@1.0.0"];
  }, 120_000);

  it("measures request latency on the deployed core", async () => {
    const timed = async (calls: ReadonlyArray<readonly [string, object, string]>) => {
      const t0 = performance.now();
      const r = await api(calls);
      expect(r.status).toBe(200);
      expect(r.body.methodResponses.every(([name]) => name !== "error")).toBe(true);

      return performance.now() - t0;
    };

    const runs = 20;

    const series = async (calls: ReadonlyArray<readonly [string, object, string]>) => {
      const xs: Array<number> = [];

      for (let i = 0; i < runs; i++) xs.push(await timed(calls));

      return { p50: round(p(xs, 0.5)), p95: round(p(xs, 0.95)) };
    };

    const accountId = env.mailboxId;
    const mailboxGet = await series([["Mailbox/get", { accountId, ids: null }, "m"]]);

    const listPage = await series([
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: "inbox" },
          collapseThreads: true,
          limit: 50,
          calculateTotal: true,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["subject", "from", "receivedAt", "keywords", "preview"],
        },
        "g",
      ],
    ]);

    const search = await series([
      ["Email/query", { accountId, filter: { text: "quarterly figures" }, limit: 20 }, "q"],
    ]);

    const state = (await api([["Email/get", { accountId, ids: [], properties: ["id"] }, "s"]])).body
      .methodResponses[0]?.[1]["state"];

    const changes = await series([["Email/changes", { accountId, sinceState: state }, "c"]]);

    Object.assign(evidence, {
      emailsInAccount: await count(),
      mailboxGetP50Ms: mailboxGet.p50,
      mailboxGetP95Ms: mailboxGet.p95,
      listPageP50Ms: listPage.p50,
      listPageP95Ms: listPage.p95,
      searchP50Ms: search.p50,
      searchP95Ms: search.p95,
      changesP50Ms: changes.p50,
      changesP95Ms: changes.p95,
    });
  }, 300_000);

  it("submits through the real dispatch queue: attempt journaled, relay acceptance reported as queued", async () => {
    const add = await env.mf.dispatchFetch(`${APP}/v1/mailboxes/${env.mailboxId}/commands`, {
      method: "POST",
      headers: { cookie: env.cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd_workerd_jmap_ident001",
        _tag: "AddIdentity",
        address: "ana@bye.test",
        kind: "hosted",
      }),
    });

    expect(add.status, await add.clone().text()).toBe(200);
    const accountId = env.mailboxId;
    const identities = await api([["Identity/get", { accountId }, "i"]]);

    const identityList = identities.body.methodResponses[0]?.[1]["list"];

    const first = Array.isArray(identityList) ? (identityList[0] as JsonRecord)["id"] : undefined;
    const identityId = Predicate.isString(first) ? first : "";

    const t0 = performance.now();

    const sent = await api([
      [
        "Email/set",
        {
          accountId,
          create: {
            d: {
              mailboxIds: { drafts: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: "ana@bye.test" }],
              to: [{ email: "carol@example.net" }],
              bcc: [{ email: "dan@example.net" }],
              subject: "From workerd",
              bodyValues: { t: { value: "hello" } },
              textBody: [{ partId: "t", type: "text/plain" }],
            },
          },
        },
        "e",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: { s: { identityId, emailId: "#d" } },
          onSuccessUpdateEmail: {
            "#s": { "mailboxIds/drafts": null, "mailboxIds/sent": true, "keywords/$draft": null },
          },
        },
        "s",
      ],
    ]);

    const submission = sent.body.methodResponses.find(
      ([name]) => name === "EmailSubmission/set",
    )?.[1];

    const submissionId = (submission?.["created"] as Record<string, { id: string }> | null)?.["s"]
      ?.id;

    expect(submissionId, JSON.stringify(sent.body)).toEqual(expect.any(String));

    let status: JsonRecord = {};

    await until(async () => {
      const g = await api([["EmailSubmission/get", { accountId, ids: [submissionId] }, "g"]]);
      const list = g.body.methodResponses[0]?.[1]["list"];
      status = Array.isArray(list) ? ((list as ReadonlyArray<JsonRecord>)[0] ?? {}) : {};

      return status["undoStatus"] === "final";
    });

    evidence["submissionToAcceptanceMs"] = round(performance.now() - t0);

    const delivered = Object.values(
      status["deliveryStatus"] as Record<string, { delivered: string }>,
    ).map((d) => d.delivered);

    expect(delivered.length).toBe(2);
    expect(delivered.every((d) => d === "queued")).toBe(true);

    const d1 = await env.mf.getD1Database("DIRECTORY", "core");

    const attempts = await d1
      .prepare("SELECT COUNT(*) AS n FROM send_attempts WHERE mailbox_id = ?")
      .bind(accountId)
      .first<{ n: number }>();

    expect(Number(attempts?.n)).toBeGreaterThanOrEqual(1);
    evidence["submissionDelivered"] = delivered.join(",");
  }, 120_000);

  it("restore drill: a restore that can't be armed releases its dispatch hold (C2)", async () => {
    const r = await env.mf.dispatchFetch(`${APP}/v1/ops/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mailbox",
        id: env.mailboxId,
        confirm: env.mailboxId,
        at: Date.now() - 60_000,
      }),
    });

    const body = await r.text();
    const d1 = await env.mf.getD1Database("DIRECTORY", "core");

    const hold = await d1
      .prepare("SELECT 1 AS x FROM dispatch_holds WHERE mailbox_id = ?")
      .bind(env.mailboxId)
      .first();

    const generation = await d1
      .prepare("SELECT restore_generation FROM authority_generations WHERE authority_id = ?")
      .bind(env.mailboxId)
      .first<{ restore_generation: number }>();

    evidence["restoreDrill"] =
      r.status === 202 ? "restored" : `not armed (${r.status}): ${body.slice(0, 120)}`;

    if (r.status !== 202) expect(hold).toBeNull();
    expect(Number(generation?.restore_generation)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("streams StateChange events and closes them when the credential is revoked", async () => {
    const tokens = await env.mf.dispatchFetch(`${APP}/v1/tokens`, {
      headers: { cookie: env.cookie },
    });

    const list = ((await tokens.json()) as { items: Array<{ id: string; label: string }> }).items;
    const tokenId = list.find((t) => t.label === "jmap")!.id;

    const stream = await env.mf.dispatchFetch(
      `${APP}/jmap/eventsource?types=*&closeafter=no&ping=0`,
      {
        headers: { authorization: `Bearer ${env.token}` },
      },
    );

    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: state");

    const t0 = performance.now();

    const revoked = await env.mf.dispatchFetch(`${APP}/v1/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { cookie: env.cookie, origin: APP },
    });

    expect(revoked.status).toBe(200);
    expect((await api([["Core/echo", {}, "e"]])).status).toBe(401);
    evidence["revocationToRejectMs"] = round(performance.now() - t0);

    for (;;) {
      const next = await reader.read();

      if (next.done) break;
    }

    evidence["revocationToStreamCloseMs"] = round(performance.now() - t0);
  }, 60_000);
});
