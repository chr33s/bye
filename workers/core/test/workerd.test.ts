import { Predicate } from "effect";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type JsonValue, mockAs } from "./harness.ts";
import { APP, startWorkerd, type WorkerdEnv } from "./workerd-env.ts";

// Runtime validation in real workerd (via Miniflare): the production bundles, SQLite-backed
// Durable Objects with their RPC boundary, D1 with the real migrations, R2, Queues with consumers,
// Workflows, the send_email binding, and the PublicGateway named entrypoint. This closes the gap
// between the Node harness (which does not emulate RPC or isolates) and a deployed Worker.

describe("MailCore in workerd", () => {
  let mf: Miniflare;
  let cookie: string;
  let mailboxId: string;
  let calendarId: string;
  let userId: string;

  let env: WorkerdEnv;

  beforeAll(async () => {
    env = await startWorkerd();
    ({ mf, cookie, mailboxId, calendarId, userId } = env);
  }, 120_000);

  afterAll(async () => {
    await env?.dispose();
  });

  const call = async (method: string, path: string, body?: JsonValue) => {
    const headers =
      method !== "GET" ? { cookie, origin: APP, "content-type": "application/json" } : { cookie };

    const response = await mf.dispatchFetch(
      `${APP}${path}`,
      body !== undefined ? { method, headers, body: JSON.stringify(body) } : { method, headers },
    );

    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const eventually = async <A>(
    fn: () => Promise<A>,
    ok: (a: A) => boolean,
    ms = 10_000,
  ): Promise<A> => {
    const end = Date.now() + ms;

    for (;;) {
      const value = await fn();

      if (ok(value) || Date.now() > end) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it("[E01] real email handler → R2 → queue → SQLite DO commit → Screener view", async () => {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      "From: stranger@example.net",
      "To: ana@bye.test",
      "Subject: Hello from workerd",
      "Date: Fri, 25 Sep 2026 12:00:00 +0000",
      "Message-ID: <workerd-1@example.net>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "zanzibar body text",
      "",
    ].join("\r\n");

    const trigger = await mf.dispatchFetch(
      `${APP}/cdn-cgi/handler/email?from=stranger@example.net&to=ana@bye.test`,
      { method: "POST", body: raw },
    );

    expect(trigger.status, await trigger.clone().text()).toBe(200);

    const screener = await eventually(
      () => call("GET", `/v1/mailboxes/${mailboxId}/views/screener`),
      (r) => r.body?.items?.length === 1,
    );

    expect(screener.body.items[0].subject).toBe("Hello from workerd");

    const approve = await call("POST", `/v1/mailboxes/${mailboxId}/commands`, {
      _tag: "Screen",
      commandId: "cmd_workerd_000000000001",
      decisions: [{ sender: "stranger@example.net", decision: "allow", destination: "imbox" }],
    });

    expect(approve.status).toBe(200);
    expect((await call("GET", `/v1/mailboxes/${mailboxId}/views/imbox`)).body.items).toHaveLength(
      1,
    );

    // Search indexing flows through the index queue and a separate SearchShardDO.
    const search = await eventually(
      () => call("GET", `/v1/mailboxes/${mailboxId}/search?q=zanzibar`),
      (r) => r.body?.results?.length === 1,
    );

    expect(search.body.results[0].kind).toBe("delivery");
  }, 60_000);

  it("[C01] calendar commands and occurrence queries run in the CalendarDO with overlap layout", async () => {
    const stub: { provision(c: JsonValue): Promise<void> } = mockAs(
      (await mf.getDurableObjectNamespace("CALENDARS", "core")).getByName(calendarId),
    );

    await stub.provision({
      ownerId: userId,
      selfAddresses: ["ana@bye.test"],
      defaultZone: "Europe/London",
    });

    const created = await call("POST", `/v1/calendars/${calendarId}/commands`, {
      schemaVersion: 1,
      command: {
        type: "CreateCalendar",
        commandId: "cmd_cal_create_0000000001",
        name: "Work",
        color: "#1f3a5f",
      },
    });

    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const workCalendar = Predicate.isString(created.body) ? created.body : created.body.calendarId;

    const at = (h: number, m: number) => ({
      kind: "timed",
      tzid: "Europe/London",
      local: { year: 2026, month: 10, day: 1, hour: h, minute: m, second: 0 },
    });

    for (const [i, [s0, e0]] of [
      [9, 10],
      [9, 11],
    ].entries()) {
      const r = await call("POST", `/v1/calendars/${calendarId}/commands`, {
        schemaVersion: 1,
        command: {
          type: "CreateEvent",
          commandId: `cmd_cal_event_00000000${i}`,
          calendarId: workCalendar,
          data: { summary: `Meeting ${i}` },
          start: at(s0!, 0),
          end: at(e0!, 0),
        },
      });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }

    const events = await call(
      "GET",
      `/v1/calendars/${calendarId}/events?from=2026-09-30T00:00:00Z&to=2026-10-03T00:00:00Z`,
    );

    expect(events.status).toBe(200);

    const occ = events.body.occurrences as Array<{
      startMs: number;
      columns?: number;
      column?: number;
    }>;

    expect(occ).toHaveLength(2);
    // 09:00 BST on 1 Oct = 08:00Z, and the two overlapping events get side-by-side columns.
    expect(new Date(occ[0]!.startMs).toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(occ.map((o) => o.columns)).toEqual([2, 2]);
  }, 60_000);

  it("[E18] draft → undo window → alarm → dispatch queue → approved provider, with Bcc kept off the wire headers", async () => {
    const identity = await call("POST", `/v1/mailboxes/${mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: "cmd_workerd_identity_0001",
      address: "ana@bye.test",
      kind: "hosted",
    });

    expect(identity.status, JSON.stringify(identity.body)).toBe(200);

    const draft = await call("POST", "/v1/drafts", {
      mailboxId,
      commandId: "cmd_workerd_draft_00000001",
      content: {
        to: [{ address: "bob@example.net" }],
        cc: [],
        bcc: [{ address: "hidden@example.net" }],
        subject: "From workerd",
        text: "Hello",
        attachments: [],
      },
    });

    expect(draft.status, JSON.stringify(draft.body)).toBe(201);

    const send = await call("POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId,
      commandId: "cmd_workerd_send_000000001",
      revision: draft.body.revision,
      sendAt: Date.now() + 500,
    });

    expect(send.status, JSON.stringify(send.body)).toBe(202);

    // With the personal class off for the stage, the job is rejected explicitly (no silent fallback).
    const mailbox: {
      sendJob(id: string): Promise<{ state: string; failure: { detail: string } | null } | null>;
    } = mockAs((await mf.getDurableObjectNamespace("MAILBOXES", "core")).getByName(mailboxId));

    const job = await eventually(
      () => mailbox.sendJob(send.body.sendJobIds[0]),
      (j) => j?.state === "rejected" || j?.state === "accepted",
      20_000,
    );

    expect(job?.state).toBe("rejected");
    expect(job?.failure?.detail).toContain("personal is not enabled in this stage");
    const r2 = await mf.getR2Bucket("ORIGINALS", "core");
    const outbound = (await r2.list({ prefix: `t/${mailboxId}/out/` })).objects;
    expect(outbound).toHaveLength(1);
    const mime = await (await r2.get(outbound[0]!.key))!.text();
    expect(mime).toMatch(/^To: bob@example.net/im);
    expect(mime).not.toContain("hidden@example.net");
  }, 60_000);

  it("[P01] publishing writes public copies that the public Worker serves; share RPC reaches MailCore", async () => {
    const post = await call("POST", "/v1/world/posts", {
      from: "ana@bye.test",
      title: "From workerd",
      html: "<p>published</p><script>x()</script>",
      text: "published",
    });

    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const page = await mf.dispatchFetch("https://bye.test/@ana");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("From workerd");
    const feed = await mf.dispatchFetch("https://bye.test/@ana/feed.xml");
    expect(await feed.text()).toContain("https://bye.test/@ana/from-workerd");
    // Unknown share link resolves through the PublicGateway entrypoint and 404s.
    expect((await mf.dispatchFetch("https://bye.test/s/spc_1/abcdefghijklmnop1234")).status).toBe(
      404,
    );
  }, 60_000);

  it("[E09] the scheduled handler runs catalog and ingress reconciliation", async () => {
    // Corrupt Ana's catalog wake hint, then fire the 5-minute cron at a time whose rotation covers
    // her mailbox's shard: reconciliation must reach the real DO and rewrite the hint from its state.
    const d1 = await mf.getD1Database("DIRECTORY", "core");

    const row = await d1
      .prepare("SELECT shard FROM resource_catalog WHERE kind = 'mailbox' AND id = ?")
      .bind(mailboxId)
      .first<{ shard: number }>();

    expect(row).not.toBeNull();
    const bogus = 1;
    await d1
      .prepare("UPDATE resource_catalog SET next_wake_hint = ? WHERE kind = 'mailbox' AND id = ?")
      .bind(bogus, mailboxId)
      .run();
    // shardsForRun: run = floor(t / 5min), shards [4·run mod 64, +4) — pick the run starting at hers.
    const time = Math.floor(row!.shard / 4) * 5 * 60_000;

    const res = await mf.dispatchFetch(
      `${APP}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*&time=${time}`,
    );

    expect(res.status, await res.clone().text()).toBe(200);

    const after = await d1
      .prepare("SELECT next_wake_hint FROM resource_catalog WHERE kind = 'mailbox' AND id = ?")
      .bind(mailboxId)
      .first<{ next_wake_hint: number | null }>();

    expect(after!.next_wake_hint).not.toBe(bogus);
  });
});
