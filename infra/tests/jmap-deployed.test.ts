import { writeFileSync } from "node:fs";
import { Client as LinagoraClient } from "jmap-client-ts";
import { JamClient } from "jmap-jam";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Predicate } from "effect";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { d1Rows, type DeployedStage, injectMail, restD1 } from "../evidence/jmap-deployed.ts";

// spec.md §16 D2 evidence on a deployed Cloudflare stage (synthetic data only): per-account
// cutover under arriving mail, ingestion through the deployed queues and containers, the two
// independent clients over the public origin, request latency, submission through the deployed
// dispatch queue, a real Durable Object point-in-time restore drill (C2) and revocation.
// Prints one `JMAP_DEPLOYED_EVIDENCE` JSON line (also written to BYE_JMAP_DEPLOYED_OUT). Runs only through `pnpm evidence:jmap:deployed`.
// Env: BYE_JMAP_DEPLOYED_ORIGIN, BYE_JMAP_DEPLOYED_OPS_TOKEN, BYE_JMAP_DEPLOYED_{DATABASE,
// ORIGINALS,INGEST_QUEUE}, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, BYE_JMAP_DEPLOYED_MESSAGES.

const env = (name: string) => {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is required`);

  return value;
};

const APP = env("BYE_JMAP_DEPLOYED_ORIGIN");

const OPS = env("BYE_JMAP_DEPLOYED_OPS_TOKEN");

const MESSAGES = Number(process.env["BYE_JMAP_DEPLOYED_MESSAGES"] ?? 200);

const stage: DeployedStage = {
  accountId: env("CLOUDFLARE_ACCOUNT_ID"),
  apiToken: env("CLOUDFLARE_API_TOKEN"),
  database: env("BYE_JMAP_DEPLOYED_DATABASE"),
  originals: env("BYE_JMAP_DEPLOYED_ORIGINALS"),
  ingestQueue: env("BYE_JMAP_DEPLOYED_INGEST_QUEUE"),
};

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
  "https://github.com/chr33s/bye/blob/main/spec.md#jmap-capability",
];

type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue | undefined };

type Json = { readonly [key: string]: JsonValue | undefined };

type OpsBody = { readonly [key: string]: string | number };

const p = (xs: ReadonlyArray<number>, q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;

const round = (n: number) => Math.round(n * 100) / 100;

const clock = {
  now: () => Date.now(),
  id: (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (check: () => Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await sleep(250);
  }
};

describe("JMAP on a deployed Cloudflare stage", () => {
  const evidence: { [key: string]: number | string | boolean | ReadonlyArray<string> } = {};
  const run = clock.id("run").slice(4, 12);
  const address = `ev${run}@bye.test`;
  let mailboxId = "";
  let cookie = "";
  let token = "";
  /** A default agent credential (read + draft): JMAP must enforce the legacy command scopes. */
  let narrow = "";

  const api = async (calls: ReadonlyArray<readonly [string, object, string]>, bearer = token) => {
    const r = await fetch(`${APP}/jmap/api`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    });

    return {
      status: r.status,
      body: (r.status === 200 ? await r.json() : { methodResponses: [] }) as {
        methodResponses: Array<[string, Json, string]>;
      },
    };
  };

  const result = async (call: readonly [string, object, string]) =>
    (await api([call])).body.methodResponses[0]?.[1] ?? {};

  const count = async () =>
    Number(
      (
        await result(["Email/query", { accountId: mailboxId, calculateTotal: true, limit: 1 }, "q"])
      )["total"] ?? 0,
    );

  const deliver = (i: number) =>
    injectMail(stage, {
      mailboxId,
      recipient: address,
      envelopeFrom: "carol@example.net",
      raw: [
        "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
        "From: carol@example.net",
        `To: ${address}`,
        `Subject: ${i % 4 === 0 ? "" : "Re: "}Report ${Math.floor(i / 4)}`,
        "Date: Mon, 12 Oct 2026 12:00:00 +0000",
        `Message-ID: <dep-${run}-${i}@example.net>`,
        ...(i % 4 === 0 ? [] : [`In-Reply-To: <dep-${run}-${i - 1}@example.net>`]),
        "Content-Type: text/plain; charset=utf-8",
        "",
        `token-${i} quarterly figures attached below`,
        "",
      ].join("\r\n"),
    });

  const ops = async (path: string, body: OpsBody) => {
    const r = await fetch(`${APP}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return { status: r.status, body: (await r.json()) as Json };
  };

  beforeAll(async () => {
    const d1 = restD1(stage);

    const account = await new ControlDirectory(d1 as never, clock).provisionPersonalAccount({
      address,
      displayName: "Evidence",
    });

    mailboxId = account.mailboxId;

    const auth = new ControlAuth(d1 as never, clock, {
      rp: { rpId: new URL(APP).hostname, origins: [APP], requireUserVerification: true },
      totpKeys: { current: 1, keys: { 1: new Uint8Array(32) } },
      recoveryPepper: "unused-by-session-and-token-issuance",
    });

    cookie = `__Host-session=${(await auth.issueSession(account.userId, "evidence", true)).token}`;

    token = (
      await auth.createApiToken(account.userId, {
        kind: "agent",
        label: "jmap",
        scopes: ["read", "draft", "send", "screen", "delete", "admin"],
      })
    ).token;

    narrow = (
      await auth.createApiToken(account.userId, {
        kind: "agent",
        label: "narrow",
        scopes: ["read", "draft"],
      })
    ).token;
  }, 120_000);

  afterAll(() => {
    const out = process.env["BYE_JMAP_DEPLOYED_OUT"];

    if (out) writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`JMAP_DEPLOYED_EVIDENCE ${JSON.stringify(evidence)}`);
  });

  it("cuts an account over while mail is arriving, then serves it from the JMAP core", async () => {
    const policy = await fetch(`${APP}/v1/mailboxes/${mailboxId}/commands`, {
      method: "POST",
      headers: { cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `cmd_${run}deployedpolicy01`,
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

    expect(policy.status, await policy.clone().text()).toBe(200);

    // Adding an identity needs a recent passkey step-up: do it while the session is fresh.
    const add = await fetch(`${APP}/v1/mailboxes/${mailboxId}/commands`, {
      method: "POST",
      headers: { cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `cmd_${run}deployedident01`,
        _tag: "AddIdentity",
        address,
        kind: "hosted",
      }),
    });

    expect(add.status, await add.clone().text()).toBe(200);

    for (let i = 0; i < 4; i++) await deliver(i);

    await until(async () => {
      const v = await fetch(`${APP}/v1/mailboxes/${mailboxId}/views/imbox`, {
        headers: { cookie },
      });

      return ((await v.json()) as { items?: Array<unknown> }).items?.length === 1;
    });

    const migrate = (action: string) =>
      ops("/v1/ops/jmap/migrate", { mailboxId, confirm: mailboxId, action });

    const t0 = Date.now();
    expect((await migrate("step")).body["mode"]).toBe("backfilling");
    await deliver(4);
    expect((await migrate("start")).body).toMatchObject({ mode: "verifying", verified: true });
    expect((await migrate("activate")).body["mode"]).toBe("jmap");
    evidence["cutoverWriteInterruptionMs"] = Date.now() - t0;

    await until(async () => (await count()) === 5);

    const session = await fetch(`${APP}/.well-known/jmap`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(session.status).toBe(200);
  }, 300_000);

  it("ingests mail through the deployed queues and containers into JMAP publication", async () => {
    const before = await count();
    const t0 = Date.now();

    for (let i = 5; i < 5 + MESSAGES; i++) await deliver(i);
    const enqueuedMs = Date.now() - t0;
    await until(async () => (await count()) === before + MESSAGES, 900_000);
    const ms = Date.now() - t0;

    evidence["ingestMessages"] = MESSAGES;
    evidence["ingestEnqueueMs"] = enqueuedMs;
    evidence["ingestMsPerMessage"] = round(ms / MESSAGES);
  }, 1_200_000);

  it("interoperates with jmap-jam 0.13.8 and jmap-client-ts 1.0.0 over the public origin", async () => {
    const jam = new JamClient({ sessionUrl: `${APP}/.well-known/jmap`, bearerToken: token });
    const accountId = await jam.getPrimaryAccount();

    const [r] = await jam.requestMany((t) => {
      const q = t.Email.query({ accountId, filter: { text: "token-7" } });

      return {
        q,
        g: t.Email.get({ accountId, ids: q.$ref("/ids"), properties: ["id", "threadId"] }),
      };
    });

    expect(r.g.list).toHaveLength(1);
    const [threads] = await jam.api.Thread.get({ accountId, ids: [r.g.list[0]!.threadId] });
    expect(threads.list[0]!.emailIds.length).toBeGreaterThanOrEqual(2);

    const linagora = new LinagoraClient({
      sessionUrl: `${APP}/.well-known/jmap`,
      accessToken: token,
      transport: {
        get: async (url, headers) => (await fetch(url, { method: "GET", headers })).json(),
        post: async (url, content, headers) =>
          (
            await fetch(url, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(content),
            })
          ).json(),
      },
    });

    await linagora.fetchSession();
    const mailboxes = await linagora.mailbox_get({ accountId, ids: null });
    const created = await linagora.mailbox_set({ accountId, create: { m: { name: "Deployed" } } });
    expect(created.created?.["m"]?.id).toEqual(expect.any(String));
    const changes = await linagora.mailbox_changes({ accountId, sinceState: mailboxes.state });
    expect(changes.created).toEqual([created.created?.["m"]?.id]);
    evidence["interopClients"] = ["jmap-jam@0.13.8", "jmap-client-ts@1.0.0"];
  }, 120_000);

  it("measures request latency at the deployed origin", async () => {
    const series = async (calls: ReadonlyArray<readonly [string, object, string]>) => {
      const xs: Array<number> = [];

      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        const r = await api(calls);
        xs.push(performance.now() - t0);
        expect(r.status).toBe(200);
        expect(r.body.methodResponses.every(([name]) => name !== "error")).toBe(true);
      }

      return { p50: round(p(xs, 0.5)), p95: round(p(xs, 0.95)) };
    };

    const accountId = mailboxId;
    const echo = await series([["Core/echo", {}, "e"]]);
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

    const state = (await result(["Email/get", { accountId, ids: [], properties: ["id"] }, "s"]))[
      "state"
    ];

    const changes = await series([["Email/changes", { accountId, sinceState: state }, "c"]]);

    Object.assign(evidence, {
      emailsInAccount: await count(),
      echoP50Ms: echo.p50,
      echoP95Ms: echo.p95,
      mailboxGetP50Ms: mailboxGet.p50,
      mailboxGetP95Ms: mailboxGet.p95,
      listPageP50Ms: listPage.p50,
      listPageP95Ms: listPage.p95,
      searchP50Ms: search.p50,
      searchP95Ms: search.p95,
      changesP50Ms: changes.p50,
      changesP95Ms: changes.p95,
    });
  }, 600_000);

  it("submits through the deployed dispatch queue with the attempt journaled outside the snapshot", async () => {
    const accountId = mailboxId;
    const identities = await result(["Identity/get", { accountId }, "i"]);
    const list = identities["list"];
    const first = Array.isArray(list) ? (list[0] as Json)["id"] : undefined;
    const identityId = Predicate.isString(first) ? first : "";
    const t0 = performance.now();

    // RFC 2606 example.net recipients: nothing deliverable leaves the stage.
    const sent = await api([
      [
        "Email/set",
        {
          accountId,
          create: {
            d: {
              mailboxIds: { drafts: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: address }],
              to: [{ email: "carol@example.net" }],
              bcc: [{ email: "dan@example.net" }],
              subject: "From the deployed stage",
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

    const submission = sent.body.methodResponses.find(([n]) => n === "EmailSubmission/set")?.[1];
    const created = submission?.["created"] as Record<string, { id: string }> | null | undefined;
    const submissionId = created?.["s"]?.id;
    expect(submissionId, JSON.stringify(sent.body)).toEqual(expect.any(String));
    let status: Json = {};

    await until(async () => {
      const g = await result(["EmailSubmission/get", { accountId, ids: [submissionId] }, "g"]);
      const items = g["list"];
      status = Array.isArray(items) ? ((items[0] as Json | undefined) ?? {}) : {};

      return status["undoStatus"] === "final";
    });

    evidence["submissionToFinalMs"] = round(performance.now() - t0);

    evidence["submissionDelivered"] = Object.values(
      status["deliveryStatus"] as Record<string, { delivered: string; smtpReply: string }>,
    )
      .map((d) => `${d.delivered}:${d.smtpReply}`)
      .join(" | ");

    await until(
      async () =>
        Number(
          (
            await d1Rows(stage, "SELECT COUNT(*) AS n FROM send_attempts WHERE mailbox_id = ?", [
              mailboxId,
            ])
          )[0]?.["n"],
        ) >= 1,
    );

    evidence["sendAttemptsJournaled"] = true;
  }, 300_000);

  it("enforces the legacy command scopes on JMAP writes", async () => {
    const accountId = mailboxId;
    const ids = (await result(["Email/query", { accountId, limit: 1 }, "q"]))["ids"];
    const emailId = Array.isArray(ids) ? String(ids[0]) : "";

    const refused = await api(
      [
        ["EmailSubmission/set", { accountId, create: { s: { identityId: "x", emailId } } }, "s"],
        ["Email/set", { accountId, update: { [emailId]: { "keywords/$flagged": true } } }, "u"],
        ["EmailAction/apply", { accountId, emails: {}, action: { type: "emptyTrash" } }, "e"],
      ],
      narrow,
    );

    expect(refused.status).toBe(200);
    expect(refused.body.methodResponses.map(([n, a]) => [n, a["type"]])).toEqual([
      ["error", "forbidden"],
      ["error", "forbidden"],
      ["error", "forbidden"],
    ]);

    // A draft credential may destroy drafts only: received mail is refused per object.
    const destroy = await api([["Email/set", { accountId, destroy: [emailId] }, "d"]], narrow);
    const notDestroyed = destroy.body.methodResponses[0]?.[1]["notDestroyed"] as Json | undefined;

    expect(notDestroyed?.[emailId]).toMatchObject({ type: "forbidden" });
    evidence["scopesEnforced"] = true;
  }, 60_000);

  it("serves concurrent clients and fans one change out to concurrent EventSource streams", async () => {
    const accountId = mailboxId;
    const clients = Number(process.env["BYE_JMAP_DEPLOYED_CONCURRENCY"] ?? 50);

    const page: ReadonlyArray<readonly [string, object, string]> = [
      ["Email/query", { accountId, collapseThreads: true, limit: 50, calculateTotal: true }, "q"],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["subject", "from", "receivedAt", "keywords", "preview"],
        },
        "g",
      ],
    ];

    const timings: Array<number> = [];
    let failures = 0;
    const t0 = performance.now();

    await Promise.all(
      Array.from({ length: clients }, async () => {
        for (let i = 0; i < 5; i++) {
          const s = performance.now();
          const r = await api(page);
          timings.push(performance.now() - s);

          if (r.status !== 200 || r.body.methodResponses.some(([n]) => n === "error")) failures++;
        }
      }),
    );

    Object.assign(evidence, {
      concurrentClients: clients,
      concurrentRequests: timings.length,
      concurrentFailures: failures,
      concurrentListPageP50Ms: round(p(timings, 0.5)),
      concurrentListPageP95Ms: round(p(timings, 0.95)),
      concurrentThroughputRps: round(timings.length / ((performance.now() - t0) / 1000)),
    });

    expect(failures).toBe(0);

    const streams = await Promise.all(
      Array.from({ length: clients }, async () => {
        const r = await fetch(`${APP}/jmap/eventsource?types=Email&closeafter=no&ping=0`, {
          headers: { authorization: `Bearer ${token}` },
        });

        const reader = r.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: state");

        return reader;
      }),
    );

    const target = (await result(["Email/query", { accountId, limit: 1 }, "q"]))["ids"];
    const id = Array.isArray(target) ? target[0] : undefined;
    const t1 = performance.now();

    await result([
      "Email/set",
      { accountId, update: { [String(id)]: { "keywords/$flagged": true } } },
      "s",
    ]);

    const arrivals = await Promise.all(
      streams.map(async (reader) => {
        for (;;) {
          const next = await reader.read();

          if (next.done) return Number.NaN;

          if (new TextDecoder().decode(next.value).includes("event: state"))
            return performance.now() - t1;
        }
      }),
    );

    await Promise.all(streams.map((reader) => reader.cancel()));

    Object.assign(evidence, {
      concurrentStreams: streams.length,
      streamFanOutP50Ms: round(p(arrivals, 0.5)),
      streamFanOutMaxMs: round(Math.max(...arrivals)),
    });

    expect(arrivals.every((ms) => Number.isFinite(ms))).toBe(true);
  }, 300_000);

  it("restore drill: a Durable Object point-in-time restore with C2 hold, generation and reconciliation", async () => {
    const accountId = mailboxId;
    // Let the restore point settle after the preceding writes, then write after it.
    await sleep(5_000);
    const at = Date.now();
    await sleep(5_000);

    const stateBefore = (
      await result(["Mailbox/get", { accountId, ids: [], properties: ["id"] }, "s"])
    )["state"];

    const after = await result([
      "Mailbox/set",
      { accountId, create: { m: { name: "After restore point" } } },
      "m",
    ]);

    const afterId = (after["created"] as Record<string, { id: string }>)["m"]!.id;

    const generation = async () =>
      Number(
        (
          await d1Rows(
            stage,
            "SELECT restore_generation AS g FROM authority_generations WHERE authority_id = ?",
            [mailboxId],
          )
        )[0]?.["g"] ?? 0,
      );

    const generationBefore = await generation();
    const t0 = performance.now();

    const r = await ops("/v1/ops/restore", {
      kind: "mailbox",
      id: mailboxId,
      confirm: mailboxId,
      at,
    });

    evidence["restoreMs"] = round(performance.now() - t0);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body["dispatchHeld"]).toBe(false);
    evidence["restoreSendsReconciled"] = JSON.stringify(r.body["sendsReconciled"]);

    // The post-restore-point write is gone, and the old state token can't be bridged.
    const mailboxes = await result(["Mailbox/get", { accountId, ids: [afterId] }, "g"]);
    expect(mailboxes["notFound"]).toEqual([afterId]);
    const changes = await api([["Mailbox/changes", { accountId, sinceState: stateBefore }, "c"]]);
    expect(changes.body.methodResponses[0]?.[1]["type"]).toBe("cannotCalculateChanges");
    expect(await generation()).toBe(generationBefore + 1);

    const holds = await d1Rows(stage, "SELECT 1 AS x FROM dispatch_holds WHERE mailbox_id = ?", [
      mailboxId,
    ]);

    expect(holds).toEqual([]);
    evidence["restoreDrill"] = "restored";
    evidence["restoreGeneration"] = generationBefore + 1;
  }, 300_000);

  it("streams StateChange events and closes them when the credential is revoked", async () => {
    const tokens = await fetch(`${APP}/v1/tokens`, { headers: { cookie } });
    const list = ((await tokens.json()) as { items: Array<{ id: string; label: string }> }).items;
    const tokenId = list.find((t) => t.label === "jmap")!.id;

    const stream = await fetch(`${APP}/jmap/eventsource?types=*&closeafter=no&ping=0`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: state");
    const t0 = performance.now();

    const revoked = await fetch(`${APP}/v1/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { cookie, origin: APP },
    });

    expect(revoked.status).toBe(200);
    await until(async () => (await api([["Core/echo", {}, "e"]])).status === 401, 60_000);
    evidence["revocationToRejectMs"] = round(performance.now() - t0);

    for (;;) {
      const next = await reader.read();

      if (next.done) break;
    }

    evidence["revocationToStreamCloseMs"] = round(performance.now() - t0);
  }, 120_000);
});
