import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { BYE, CORE, MAIL } from "@bye/jmap";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { advanceRestoreGeneration } from "../src/generations.ts";
import { handleInbound } from "../src/inbound.ts";
import { authConfig } from "../src/services.ts";
import {
  executionContext,
  type Harness,
  inboundMessage,
  type JsonRecord,
  makeHarness,
  rfc822,
} from "./harness.ts";

// JMAP read-only vertical slice over in-memory bindings (spec.md §16.5, D1 T01–T03/T06):
// session discovery, the API over a real MailboxDO projection, and gated blob download.

// Workers-only global used by ingress; mirrors mail-routes.test.ts.
(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly cookie: string;
  readonly token: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );

  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);

  const token = await auth.createApiToken(account.userId, {
    kind: "agent",
    label: "jmap",
    // Every scope: these tests exercise the read-only profile, not credential scopes.
    scopes: ["read", "draft", "send", "screen", "delete", "admin"],
  });

  return { ...account, cookie: `__Host-session=${session.token}`, token: token.token };
};

const http = async (
  h: Harness,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: string,
) => {
  const init: RequestInit = { method, headers: new Headers(headers) };

  if (body !== undefined) init.body = body;

  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, init),
    h.env,
    executionContext,
  );

  const text = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    text,
    body:
      (response.headers.get("content-type") ?? "").includes("json") && text
        ? JSON.parse(text)
        : null,
  };
};

const bearer = (a: Account) => ({ authorization: `Bearer ${a.token}` });

type Call = readonly [string, JsonRecord, string];

const jmap = async (h: Harness, a: Account, calls: ReadonlyArray<Call>, using = [CORE, MAIL]) => {
  const r = await http(
    h,
    { ...bearer(a), "content-type": "application/json" },
    "POST",
    "/jmap/api",
    JSON.stringify({ using, methodCalls: calls }),
  );

  return r;
};

/** The response args of each call, keyed by call ID (`name` is the response name). */
const byCall = (r: Awaited<ReturnType<typeof jmap>>) => {
  const out = new Map<string, ReturnType<typeof JSON.parse>>();

  for (const [name, args, id] of r.body.methodResponses) out.set(id, { name, ...args });

  return (id: string) => out.get(id);
};

let n = 0;

const command = (h: Harness, a: Account, body: JsonRecord) =>
  http(
    h,
    { cookie: a.cookie, origin: h.env.APP_ORIGIN, "content-type": "application/json" },
    "POST",
    `/v1/mailboxes/${a.mailboxId}/commands`,
    JSON.stringify({ commandId: `cmd_${(++n).toString(36).padStart(20, "0")}`, ...body }),
  );

const deliver = async (h: Harness, raw: string, from: string, to: string) => {
  await handleInbound(inboundMessage(from, to, raw), h.env);
  await h.drain();
};

describe("JMAP read-only slice", () => {
  let h: Harness;
  let ana: Account;
  let bob: Account;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 12, 12));
    h = makeHarness();
    ana = await signup(h, "ana@bye.test");
    bob = await signup(h, "bob@bye.test");
  });
  afterEach(() => vi.useRealTimers());

  const allowAndDeliver = async () => {
    await command(h, ana, {
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
    });
    await deliver(
      h,
      rfc822({
        from: "carol@example.net",
        to: "ana@bye.test",
        subject: "Lunch",
        body: "noon?",
        messageId: "m1@example.net",
      }),
      "carol@example.net",
      "ana@bye.test",
    );
    vi.setSystemTime(Date.UTC(2026, 9, 12, 13));
    await deliver(
      h,
      rfc822({
        from: "carol@example.net",
        to: "ana@bye.test",
        subject: "Re: Lunch",
        body: "or one?",
        messageId: "m2@example.net",
        inReplyTo: "m1@example.net",
      }),
      "carol@example.net",
      "ana@bye.test",
    );
  };

  it("serves an authenticated session that lists only the principal's accounts, labeled partial", async () => {
    expect((await http(h, {}, "GET", "/.well-known/jmap")).status).toBe(401);
    const s = await http(h, bearer(ana), "GET", "/.well-known/jmap");

    expect(s.status).toBe(200);
    expect(Object.keys(s.body.accounts)).toEqual([ana.mailboxId]);
    expect(s.body.accounts[ana.mailboxId]).toMatchObject({
      name: "ana@bye.test",
      isPersonal: true,
      isReadOnly: true,
    });
    expect(s.body.primaryAccounts[MAIL]).toBe(ana.mailboxId);
    expect(s.body.capabilities[BYE]).toEqual({ version: 1, partial: true });
    expect(s.body.accounts[ana.mailboxId].accountCapabilities[BYE]).toEqual({
      profile: "read-only-partial",
      partial: true,
    });
    expect(s.body.apiUrl).toBe(`${h.env.APP_ORIGIN}/jmap/api`);
    expect(s.body.username).toBe("ana@bye.test");
  });

  it("answers request-level problems as problem+json", async () => {
    const bad = await http(h, bearer(ana), "POST", "/jmap/api", "{");

    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/problem+json");
    expect(bad.body.type).toBe("urn:ietf:params:jmap:error:notJSON");
    expect((await jmap(h, ana, [["Core/echo", {}, "a"]], [CORE, "urn:x:unknown"])).body.type).toBe(
      "urn:ietf:params:jmap:error:unknownCapability",
    );
  });

  it("projects Mailboxes, Emails and Threads from the legacy authority", async () => {
    await allowAndDeliver();

    const r = await jmap(h, ana, [
      ["Mailbox/get", { accountId: ana.mailboxId }, "mb"],
      [
        "Email/query",
        { accountId: ana.mailboxId, filter: { inMailbox: "inbox" }, calculateTotal: true },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: ana.mailboxId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [
            "threadId",
            "mailboxIds",
            "keywords",
            "subject",
            "from",
            "messageId",
            "inReplyTo",
            "receivedAt",
            "preview",
            "blobId",
          ],
        },
        "g",
      ],
      [
        "Thread/get",
        {
          accountId: ana.mailboxId,
          "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" },
        },
        "t",
      ],
    ]);

    expect(r.status).toBe(200);
    const out = byCall(r);
    const inbox = out("mb").list.find((m: JsonRecord) => m["id"] === "inbox");

    expect(inbox).toMatchObject({
      role: "inbox",
      totalEmails: 2,
      unreadEmails: 2,
      totalThreads: 1,
      unreadThreads: 1,
      myRights: { mayReadItems: true, mayAddItems: false, mayDelete: false },
    });
    expect(out("mb").list.map((m: JsonRecord) => m["role"])).toEqual(
      expect.arrayContaining(["inbox", "archive", "drafts", "sent", "junk", "trash"]),
    );
    expect(out("q")).toMatchObject({ total: 2, position: 0, canCalculateChanges: false });

    // Newest first by default.
    const [newest, oldest] = out("g").list;
    expect(newest).toMatchObject({
      subject: "Re: Lunch",
      mailboxIds: { inbox: true },
      keywords: {},
      from: [{ email: "carol@example.net" }],
      messageId: ["m2@example.net"],
      inReplyTo: ["m1@example.net"],
      receivedAt: "2026-10-12T13:00:00Z",
    });
    expect(oldest.subject).toBe("Lunch");
    expect(newest.threadId).toBe(oldest.threadId);
    expect(out("t").list).toEqual([{ id: newest.threadId, emailIds: [oldest.id, newest.id] }]);

    // The raw message downloads through the advertised template.
    const raw = await http(
      h,
      bearer(ana),
      "GET",
      `/jmap/download/${ana.mailboxId}/${newest.blobId}/m.eml?type=message/rfc822`,
    );

    expect(raw.status).toBe(200);
    expect(raw.text).toContain("Message-ID: <m2@example.net>");
    expect(raw.headers.get("content-disposition")).toContain("attachment");
  });

  it("follows legacy reads, labels and Trash into memberships and keywords", async () => {
    await allowAndDeliver();

    const view = await http(
      h,
      { cookie: ana.cookie },
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/views/imbox`,
    );

    const thread = view.body.items[0];

    await command(h, ana, {
      _tag: "MarkSeen",
      threadId: thread.threadId,
      observedRevision: thread.revision,
    });
    await command(h, ana, {
      _tag: "SetThreadLabels",
      threadId: thread.threadId,
      add: ["Travel"],
      remove: [],
    });

    const read = byCall(
      await jmap(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { hasKeyword: "$seen" } }, "seen"],
        ["Mailbox/query", { accountId: ana.mailboxId, filter: { name: "travel" } }, "lq"],
      ]),
    );

    expect(read("seen").ids).toHaveLength(2);
    expect(read("lq").ids).toHaveLength(1);
    const labelId = read("lq").ids[0];

    await command(h, ana, { _tag: "MoveToTrash", threadIds: [thread.threadId] });

    const trashed = byCall(
      await jmap(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "trash" } }, "q"],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["mailboxIds"],
          },
          "g",
        ],
        [
          "Email/query",
          {
            accountId: ana.mailboxId,
            filter: { operator: "NOT", conditions: [{ inMailbox: "trash" }] },
          },
          "not",
        ],
      ]),
    );

    // A1: Trash replaces placement but keeps the label membership.
    expect(trashed("g").list.map((e: JsonRecord) => e["mailboxIds"])).toEqual([
      { trash: true, [labelId]: true },
      { trash: true, [labelId]: true },
    ]);
    expect(trashed("not").ids).toEqual([]);
  });

  it("authorizes per account: another principal's account is accountNotFound and its blobs 404", async () => {
    await allowAndDeliver();

    const ids = byCall(await jmap(h, ana, [["Email/query", { accountId: ana.mailboxId }, "q"]]))(
      "q",
    ).ids;

    const out = byCall(
      await jmap(h, bob, [
        ["Email/get", { accountId: ana.mailboxId, ids }, "a"],
        ["Mailbox/get", { accountId: bob.mailboxId, ids: ["inbox"] }, "b"],
      ]),
    );

    expect(out("a")).toMatchObject({ name: "error", type: "accountNotFound" });
    expect(out("b").list[0].totalEmails).toBe(0);
    expect(
      (await http(h, bearer(bob), "GET", `/jmap/download/${ana.mailboxId}/raw-${ids[0]}/m.eml`))
        .status,
    ).toBe(404);
  });

  it("refuses writes on the read-only profile and falls back to cannotCalculateChanges", async () => {
    const first = byCall(await jmap(h, ana, [["Email/query", { accountId: ana.mailboxId }, "q"]]));

    const mb = byCall(
      await jmap(h, ana, [["Mailbox/get", { accountId: ana.mailboxId, ids: [] }, "m"]]),
    );

    const same = byCall(
      await jmap(h, ana, [
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: mb("m").state }, "c"],
        ["Email/set", { accountId: ana.mailboxId, destroy: ["x"] }, "s"],
        [
          "Email/queryChanges",
          { accountId: ana.mailboxId, sinceQueryState: first("q").queryState },
          "qc",
        ],
        ["Email/parse", { accountId: ana.mailboxId, blobIds: ["raw-nope"] }, "p"],
      ]),
    );

    expect(same("c")).toMatchObject({
      name: "Mailbox/changes",
      created: [],
      hasMoreChanges: false,
    });
    expect(same("s")).toMatchObject({ name: "error", type: "accountReadOnly" });
    expect(same("qc")).toMatchObject({ name: "error", type: "cannotCalculateChanges" });
    expect(same("p")).toMatchObject({ name: "Email/parse", notFound: ["raw-nope"] });

    await allowAndDeliver();

    const later = byCall(
      await jmap(h, ana, [
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: mb("m").state }, "c"],
      ]),
    );

    expect(later("c")).toMatchObject({ name: "error", type: "cannotCalculateChanges" });
  });

  it("a restore generation invalidates every earlier state token (C2)", async () => {
    const before = byCall(
      await jmap(h, ana, [["Mailbox/get", { accountId: ana.mailboxId, ids: [] }, "m"]]),
    );

    await advanceRestoreGeneration(h.env, "mailbox", ana.mailboxId);

    const after = byCall(
      await jmap(h, ana, [
        ["Mailbox/get", { accountId: ana.mailboxId, ids: [] }, "m"],
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: before("m").state }, "c"],
      ]),
    );

    expect(after("m").state).not.toBe(before("m").state);
    expect(after("c")).toMatchObject({ name: "error", type: "cannotCalculateChanges" });
  });

  it("withholds quarantined originals and previews", async () => {
    await allowAndDeliver();

    const out = byCall(
      await jmap(h, ana, [
        ["Email/query", { accountId: ana.mailboxId }, "q"],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["blobId", "threadId"],
          },
          "g",
        ],
      ]),
    );

    const email = out("g").list[0];

    await h.env.MAILBOXES.getByName(ana.mailboxId).recordDeliveryScan(
      email.id,
      "infected",
      "EICAR",
    );

    const after = byCall(
      await jmap(h, ana, [
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: [email.id], properties: ["preview", "mailboxIds"] },
          "g",
        ],
      ]),
    );

    expect(after("g").list[0]).toMatchObject({ preview: "", mailboxIds: { junk: true } });

    const raw = await http(
      h,
      bearer(ana),
      "GET",
      `/jmap/download/${ana.mailboxId}/${email.blobId}/m.eml`,
    );

    expect(raw.status).toBe(403);
  });

  it("streams StateChange events and refuses uploads to a read-only account", async () => {
    const stream = await http(
      h,
      bearer(ana),
      "GET",
      "/jmap/eventsource?types=*&closeafter=state&ping=0",
    );

    expect(stream.status).toBe(200);
    expect(stream.text).toContain("event: state");
    expect(stream.text).toContain(ana.mailboxId);

    const upload = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/jmap/upload/${ana.mailboxId}`, {
        method: "POST",
        headers: { ...bearer(ana), "content-type": "text/plain" },
        body: "hello",
      }),
      h.env,
      executionContext,
    );

    expect([403]).toContain(upload.status);
  });
});
