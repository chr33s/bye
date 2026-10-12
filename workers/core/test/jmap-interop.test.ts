import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JamClient } from "jmap-jam";
import { Client as LinagoraClient } from "jmap-client-ts";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { authConfig } from "../src/services.ts";
import { executionContext, type Harness, inboundMessage, makeHarness, rfc822 } from "./harness.ts";

// Interoperability with independently implemented JMAP clients (spec.md §16 D1 T10, D2
// client/auth profile): jmap-jam 0.13.8 (htunnicliff) and jmap-client-ts 1.0.0 (OpenPaaS/
// Linagora), unmodified, talking to the real Worker handlers in process over a revocable bearer
// token. This is in-process evidence, not a deployed run; the release profile records both.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const OPS = "ops-token-0123456789abcdef0123456789abcdef";

describe("independent JMAP clients", () => {
  let h: Harness;
  let token: string;
  let mailboxId: string;
  let cookie: string;

  /** Route the clients' global fetch into the Worker (same origin as the session advertises). */
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    handleFetch(
      new Request(input instanceof Request ? input : String(input), init),
      h.env,
      executionContext,
    );

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 12, 12));
    h = makeHarness();
    (h.env as { OPS_TOKEN: string }).OPS_TOKEN = OPS;

    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });

    mailboxId = account.mailboxId;
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    cookie = `__Host-session=${(await auth.issueSession(account.userId, "t", true)).token}`;
    token = (
      await auth.createApiToken(account.userId, {
        kind: "agent",
        label: "interop",
        scopes: ["read", "draft", "send", "screen", "delete", "admin"],
      })
    ).token;

    await serve(`${h.env.APP_ORIGIN}/v1/mailboxes/${mailboxId}/commands`, {
      method: "POST",
      headers: { cookie, origin: h.env.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd_00000000000000000001",
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

    for (const [subject, id] of [
      ["Lunch", "l1@example.net"],
      ["Plans", "p1@example.net"],
    ] as const) {
      // Distinct received times, so receivedAt ordering is deterministic.
      vi.setSystemTime(Date.now() + 60_000);
      await handleInbound(
        inboundMessage(
          "carol@example.net",
          "ana@bye.test",
          rfc822({
            from: "carol@example.net",
            to: "ana@bye.test",
            subject,
            body: `${subject} body`,
            messageId: id,
          }),
        ),
        h.env,
      );
      await h.drain();
    }

    const migrate = (action: string) =>
      serve(`${h.env.APP_ORIGIN}/v1/ops/jmap/migrate`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        body: JSON.stringify({ mailboxId, confirm: mailboxId, action }),
      });

    expect((await (await migrate("start")).json()) as object).toMatchObject({ verified: true });
    expect((await (await migrate("activate")).json()) as object).toMatchObject({ mode: "jmap" });
    vi.stubGlobal("fetch", serve);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("jmap-jam 0.13.8: session, references, writes, changes, upload, import and download", async () => {
    const jam = new JamClient({
      sessionUrl: `${h.env.APP_ORIGIN}/.well-known/jmap`,
      bearerToken: token,
    });

    const accountId = await jam.getPrimaryAccount();
    expect(accountId).toBe(mailboxId);

    const [mailboxes] = await jam.api.Mailbox.get({ accountId });
    const inbox = mailboxes.list.find((m) => m.role === "inbox")!;
    expect(inbox.totalEmails).toBe(2);

    const [results] = await jam.requestMany((t) => {
      const query = t.Email.query({
        accountId,
        filter: { inMailbox: inbox.id },
        sort: [{ property: "receivedAt", isAscending: true }],
      });

      return {
        query,
        emails: t.Email.get({
          accountId,
          ids: query.$ref("/ids"),
          properties: ["id", "subject", "threadId", "keywords"],
        }),
      };
    });

    expect(results.emails.list.map((e) => e.subject)).toEqual(["Lunch", "Plans"]);
    const first = results.emails.list[0]!;

    const [changes0] = await jam.api.Email.changes({ accountId, sinceState: results.emails.state });
    expect(changes0.created).toEqual([]);

    const [set] = await jam.api.Email.set({
      accountId,
      update: { [first.id]: { "keywords/$seen": true } },
    });

    expect(set.updated).toHaveProperty(first.id);

    const [changes1] = await jam.api.Email.changes({ accountId, sinceState: results.emails.state });
    expect(changes1.updated).toEqual([first.id]);

    const uploaded = await jam.uploadBlob(
      accountId,
      rfc822({
        from: "erin@example.org",
        to: "ana@bye.test",
        subject: "Imported",
        body: "via jam",
        messageId: "i1@example.org",
      }),
    );

    const [imported] = await jam.api.Email.import({
      accountId,
      emails: { i: { blobId: uploaded.blobId, mailboxIds: { [inbox.id]: true }, keywords: {} } },
    });

    expect(imported.created?.["i"]?.id).toEqual(expect.any(String));

    const download = await jam.downloadBlob({
      accountId,
      blobId: uploaded.blobId,
      mimeType: "message/rfc822",
      fileName: "i.eml",
    });

    expect(await download.text()).toContain("Subject: Imported");
  });

  it("jmap-client-ts 1.0.0: session, Mailbox/Email get, query, set and changes", async () => {
    const client = new LinagoraClient({
      sessionUrl: `${h.env.APP_ORIGIN}/.well-known/jmap`,
      accessToken: token,
      transport: {
        get: async (url, headers) => {
          const r = await serve(url, { method: "GET", headers });

          if (r.status !== 200) throw new Error(`GET ${url} ${r.status}`);

          return r.json();
        },
        post: async (url, content, headers) => {
          const r = await serve(url, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(content),
          });

          if (r.status !== 200) throw new Error(`POST ${url} ${r.status}`);

          return r.json();
        },
      },
    });

    await client.fetchSession();
    const accountId = client.getFirstAccountId();
    expect(accountId).toBe(mailboxId);

    const mailboxes = await client.mailbox_get({ accountId, ids: null });
    const inbox = mailboxes.list.find((m) => m.role === "inbox")!;
    const query = await client.email_query({ accountId, filter: { inMailbox: inbox.id } });
    expect(query.ids).toHaveLength(2);

    const emails = await client.email_get({
      accountId,
      ids: query.ids,
      properties: ["subject", "mailboxIds", "keywords"],
    });

    expect(emails.list.map((e) => e.subject).sort()).toEqual(["Lunch", "Plans"]);

    const created = await client.mailbox_set({ accountId, create: { m: { name: "Interop" } } });
    const mailbox = created.created?.["m"]?.id;
    expect(mailbox).toEqual(expect.any(String));

    const moved = await client.email_set({
      accountId,
      update: { [query.ids[0]!]: { [`mailboxIds/${mailbox}`]: true } },
    });

    expect(moved.updated).toHaveProperty(query.ids[0]!);

    const changes = await client.mailbox_changes({ accountId, sinceState: mailboxes.state });
    expect(changes.created).toContain(mailbox);
    // Adding a membership elsewhere leaves the Inbox's counts unchanged (C1 dependencies).
    expect(changes.updated).not.toContain(inbox.id);

    const emailChanges = await client.email_changes({ accountId, sinceState: emails.state });
    expect(emailChanges.updated).toEqual([query.ids[0]]);
  });
});
