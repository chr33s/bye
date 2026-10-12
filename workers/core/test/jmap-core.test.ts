import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlobCollecting,
  ControlAuth,
  ControlDirectory,
  type D1Like,
  FULL_RIGHTS,
  type MailboxStore,
  revokeAllCredentials,
} from "@bye/platform-cloudflare";
import { BYE, CORE, MAIL, SUBMISSION, VACATION_RESPONSE } from "@bye/jmap";
import { handleFetch } from "../src/api.ts";
import { sharedMessageOf } from "../src/authorities.ts";
import { GC_DELAY_MS, sweepBlobGc } from "../src/blobgc.ts";
import {
  armDispatchHold,
  convergeGrants,
  dispatchHeldAt,
  dispatchHold,
  holdDispatch,
  liftDispatchHold,
  RESTORE_HOLD_REASON,
  restoreHolds,
  revertDispatchHold,
  syncMailboxGrants,
} from "../src/generations.ts";
import { pushStateChange } from "../src/jmap-push.ts";
import { reconcileRestoreHolds } from "../src/sendevents.ts";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { authConfig } from "../src/services.ts";
import {
  enablePersonalMail,
  executionContext,
  type Harness,
  inboundMessage,
  type JsonRecord,
  makeHarness,
  mockAs,
  rfc822,
} from "./harness.ts";

// The JMAP core end to end (spec.md §16 D1 T01–T10 over in-memory bindings): per-account
// migration and cutover (C3/C4), standard writes and typed history (C1), native policy (A1),
// drafts and submission (B1/B2), cross-account copy (B3), staged arrivals (B4), rights (A3) and
// push (T09).

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const OPS = "ops-token-0123456789abcdef0123456789abcdef";

const USING = [CORE, MAIL, SUBMISSION, VACATION_RESPONSE, BYE];

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly address: string;
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
    scopes: ["read", "draft", "send", "screen", "delete", "admin"],
  });

  return { ...account, address, cookie: `__Host-session=${session.token}`, token: token.token };
};

const http = async (
  h: Harness,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: BodyInit,
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

const jmap = (h: Harness, a: Account, calls: ReadonlyArray<Call>) =>
  http(
    h,
    { ...bearer(a), "content-type": "application/json" },
    "POST",
    "/jmap/api",
    JSON.stringify({ using: USING, methodCalls: calls }),
  );

/** Responses by call ID; several responses for one call (implicit Email/set) are an array. */
const run = async (h: Harness, a: Account, calls: ReadonlyArray<Call>) => {
  const r = await jmap(h, a, calls);

  expect(r.status, r.text).toBe(200);

  if (process.env["JMAP_DEBUG"])
    console.log(JSON.stringify(r.body.methodResponses, null, 1).slice(0, 3000));
  const out = new Map<string, Array<ReturnType<typeof JSON.parse>>>();

  for (const [name, args, id] of r.body.methodResponses as Array<[string, JsonRecord, string]>)
    out.set(id, [...(out.get(id) ?? []), { name, ...args }]);

  return (id: string, index = 0) => out.get(id)?.[index];
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

const migrate = (h: Harness, mailboxId: string, action: string) =>
  http(
    h,
    { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
    "POST",
    "/v1/ops/jmap/migrate",
    JSON.stringify({ mailboxId, confirm: mailboxId, action }),
  );

const store = (h: Harness, a: Account) =>
  mockAs<{ store: MailboxStore }>(h.namespaces.MAILBOXES.instance(a.mailboxId)).store;

const allow = (h: Harness, a: Account, domain: string, destination = "imbox") =>
  command(h, a, {
    _tag: "SetPolicy",
    kind: "domain",
    subject: domain,
    policy: { decision: "allowed", destination, labels: [], bundle: false, notify: false },
  });

const message = (
  from: string,
  to: string,
  subject: string,
  id: string,
  extra: Partial<{ inReplyTo: string; body: string }> = {},
) =>
  rfc822(
    extra.inReplyTo
      ? {
          from,
          to,
          subject,
          body: extra.body ?? `body of ${subject}`,
          messageId: id,
          inReplyTo: extra.inReplyTo,
        }
      : { from, to, subject, body: extra.body ?? `body of ${subject}`, messageId: id },
  );

const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

describe("JMAP core", () => {
  let h: Harness;
  let ana: Account;
  let bob: Account;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 12, 12));
    h = makeHarness();
    (h.env as { OPS_TOKEN: string }).OPS_TOKEN = OPS;
    enablePersonalMail(h);
    ana = await signup(h, "ana@bye.test");
    bob = await signup(h, "bob@bye.test");
  });
  afterEach(() => vi.useRealTimers());

  /** Legacy mail before cutover: two messages in one thread (read + labeled), one feed message. */
  const legacyFixture = async () => {
    await allow(h, ana, "example.net");
    await allow(h, ana, "news.example", "feed");
    await deliver(
      h,
      message("carol@example.net", ana.address, "Lunch", "m1@example.net"),
      "carol@example.net",
      ana.address,
    );
    vi.setSystemTime(Date.UTC(2026, 9, 12, 13));
    await deliver(
      h,
      message("carol@example.net", ana.address, "Re: Lunch", "m2@example.net", {
        inReplyTo: "m1@example.net",
      }),
      "carol@example.net",
      ana.address,
    );
    await deliver(
      h,
      message("digest@news.example", ana.address, "Weekly digest", "n1@news.example"),
      "digest@news.example",
      ana.address,
    );

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
    await command(h, ana, {
      _tag: "CreateDraft",
      content: {
        to: [{ address: "dan@example.net" }],
        cc: [],
        bcc: [],
        subject: "Plans",
        text: "draft text",
        attachments: [],
      },
    });

    return thread;
  };

  const activate = async () => {
    const started = await migrate(h, ana.mailboxId, "start");

    expect(started.body).toMatchObject({ mode: "verifying", verified: true, problems: [] });
    const done = await migrate(h, ana.mailboxId, "activate");

    expect(done.body).toMatchObject({ mode: "jmap" });
  };

  describe("migration and cutover (C3, C4, T10)", () => {
    it("fences legacy writers, buffers arrivals, verifies, and activates with the fixed mapping", async () => {
      await legacyFixture();

      // A projection read before cutover: these IDs must survive activation.
      const before = await run(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "inbox" } }, "q"],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["threadId", "keywords", "mailboxIds"],
          },
          "g",
        ],
      ]);

      // Step one checkpoint: the account is fenced; legacy commands get a retry response.
      const step = await migrate(h, ana.mailboxId, "step");
      expect(step.body.mode).toBe("backfilling");
      const refused = await command(h, ana, { _tag: "MarkUnseen", threadId: "x" });
      expect(refused.status).toBe(409);
      expect(refused.body.error.details).toMatchObject({ retryable: true });

      // An arrival while fenced is acknowledged and buffered, not lost.
      await deliver(
        h,
        message("carol@example.net", ana.address, "During fence", "f1@example.net"),
        "carol@example.net",
        ana.address,
      );
      expect((await migrate(h, ana.mailboxId, "status")).body.buffered).toBe(1);

      await activate();

      const after = await run(h, ana, [
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            ids: before("q").ids,
            properties: ["threadId", "keywords", "mailboxIds"],
          },
          "g",
        ],
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "inbox" } }, "inbox"],
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "feed" } }, "feed"],
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "drafts" } }, "drafts"],
        ["DraftSession/get", { accountId: ana.mailboxId }, "ds"],
        ["Mailbox/query", { accountId: ana.mailboxId, filter: { name: "travel" } }, "label"],
      ]);

      // Fixed mapping: Email and Thread IDs unchanged, read state and label memberships kept.
      expect(after("g").list.map((e: JsonRecord) => e["threadId"])).toEqual(
        before("g").list.map((e: JsonRecord) => e["threadId"]),
      );
      expect(after("g").list.map((e: JsonRecord) => e["keywords"])).toEqual([
        { $seen: true },
        { $seen: true },
      ]);
      expect(Object.keys(after("g").list[0].mailboxIds)).toEqual(
        expect.arrayContaining(["inbox", after("label").ids[0]]),
      );
      expect(after("feed").ids).toHaveLength(1);
      // The buffered arrival was replayed through the new core.
      expect(after("inbox").ids).toHaveLength(3);
      // The open draft became an immutable $draft Email with a DraftSession.
      expect(after("drafts").ids).toHaveLength(1);
      expect(after("ds").list[0].headEmailId).toBe(after("drafts").ids[0]);

      // C4: thread-model reads and writes now answer upgrade-required.
      const legacy = await http(
        h,
        { cookie: ana.cookie },
        "GET",
        `/v1/mailboxes/${ana.mailboxId}/views/imbox`,
      );

      expect(legacy.status).toBe(409);
      expect(legacy.body.error.details).toMatchObject({ upgradeRequired: true });
      // Settings-level commands keep working.
      expect((await allow(h, ana, "other.example")).status).toBe(200);

      const session = await http(h, bearer(ana), "GET", "/.well-known/jmap");
      expect(session.body.accounts[ana.mailboxId]).toMatchObject({ isReadOnly: false });
      expect(session.body.accounts[ana.mailboxId].accountCapabilities[BYE]).toMatchObject({
        profile: "core",
      });
      expect(session.body.primaryAccounts[SUBMISSION]).toBe(ana.mailboxId);
    });

    it("projection state tokens never match the core after cutover (writer epoch)", async () => {
      await legacyFixture();

      const before = await run(h, ana, [
        ["Mailbox/get", { accountId: ana.mailboxId, ids: [] }, "m"],
      ]);

      await activate();

      const after = await run(h, ana, [
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: before("m").state }, "c"],
      ]);

      expect(after("c")).toMatchObject({ name: "error", type: "cannotCalculateChanges" });
    });

    it("abort before activation resumes the legacy authority and replays buffered work there", async () => {
      await legacyFixture();
      await migrate(h, ana.mailboxId, "step");
      await deliver(
        h,
        message("carol@example.net", ana.address, "Buffered", "b1@example.net"),
        "carol@example.net",
        ana.address,
      );

      const aborted = await migrate(h, ana.mailboxId, "abort");
      expect(aborted.body.mode).toBe("legacy");

      const view = await http(
        h,
        { cookie: ana.cookie },
        "GET",
        `/v1/mailboxes/${ana.mailboxId}/views/imbox`,
      );

      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body.items)).toContain("Buffered");
      expect(
        (await command(h, ana, { _tag: "MarkUnseen", threadId: view.body.items[0].threadId }))
          .status,
      ).toBe(200);
    });

    it("resumes from checkpoints: repeated steps converge on the same verified state", async () => {
      await legacyFixture();

      for (let i = 0; i < 6; i++) await migrate(h, ana.mailboxId, "step");
      const status = (await migrate(h, ana.mailboxId, "start")).body;

      expect(status).toMatchObject({ mode: "verifying", verified: true });
      const s = store(h, ana);
      expect(Number(s.ctx.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM jmap_emails")?.n)).toBe(
        4,
      );
    });
  });

  describe("standard mail on the core (T02, T03, T08)", () => {
    beforeEach(async () => {
      await legacyFixture();
      await activate();
    });

    it("Mailbox/set creates, renames, protects roles, and cascades only when asked", async () => {
      const r = await run(h, ana, [
        ["Mailbox/get", { accountId: ana.mailboxId, ids: [] }, "s"],
        ["Mailbox/set", { accountId: ana.mailboxId, create: { p: { name: "Projects" } } }, "c"],
        [
          "Mailbox/set",
          { accountId: ana.mailboxId, update: { "#p": { name: "Work", isSubscribed: false } } },
          "u",
        ],
        ["Mailbox/set", { accountId: ana.mailboxId, destroy: ["inbox", "nope"] }, "d"],
        ["Mailbox/set", { accountId: ana.mailboxId, create: { dup: { name: "work" } } }, "dup"],
      ]);

      const id = r("c").created.p.id;
      expect(r("u").updated).toEqual({ [id]: null });
      expect(r("d").notDestroyed).toMatchObject({
        inbox: { type: "forbidden" },
        nope: { type: "notFound" },
      });
      expect(r("dup").notCreated.dup.type).toBe("invalidProperties");

      // Put one Email only in Work and one in Work + Inbox, then destroy Work.
      const q = await run(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "inbox" } }, "q"],
      ]);

      const [a, b] = q("q").ids;

      const moved = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            update: { [a]: { [`mailboxIds/${id}`]: true }, [b]: { mailboxIds: { [id]: true } } },
          },
          "m",
        ],
        ["Mailbox/set", { accountId: ana.mailboxId, destroy: [id] }, "refuse"],
        [
          "Mailbox/set",
          { accountId: ana.mailboxId, destroy: [id], onDestroyRemoveEmails: true },
          "cascade",
        ],
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: [a, b], properties: ["mailboxIds"] },
          "after",
        ],
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: r("s").state }, "changes"],
        [
          "Mailbox/get",
          { accountId: ana.mailboxId, ids: ["inbox"], properties: ["myRights", "role"] },
          "inbox",
        ],
      ]);

      expect(moved("refuse").notDestroyed[id].type).toBe("mailboxHasEmail");
      expect(moved("cascade").destroyed).toEqual([id]);
      expect(moved("after").list).toHaveLength(1);
      expect(moved("after").notFound).toEqual([b]);
      // Created and destroyed inside the interval: coalesced away (C1).
      expect([...moved("changes").created, ...moved("changes").destroyed]).not.toContain(id);
      expect(moved("changes").updated).toContain("inbox");
      expect(moved("inbox").list[0].myRights).toMatchObject({ mayDelete: false, mayRename: true });
    });

    it("Email/set changes keywords and memberships with exact typed history and paged changes", async () => {
      const r0 = await run(h, ana, [
        [
          "Email/query",
          {
            accountId: ana.mailboxId,
            filter: { inMailbox: "inbox" },
            sort: [{ property: "receivedAt", isAscending: true }],
          },
          "q",
        ],
        ["Email/get", { accountId: ana.mailboxId, ids: [], properties: ["id"] }, "s"],
        ["Thread/get", { accountId: ana.mailboxId, ids: [] }, "ts"],
      ]);

      const [first, second] = r0("q").ids;

      const r1 = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            update: {
              [first]: { "keywords/$flagged": true },
              [second]: { "keywords/$seen": null },
            },
          },
          "u",
        ],
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            update: { [first]: { mailboxIds: {} }, [second]: { subject: "x" } },
          },
          "bad",
        ],
        ["Mailbox/get", { accountId: ana.mailboxId, ids: ["inbox"] }, "mb"],
        [
          "Email/changes",
          { accountId: ana.mailboxId, sinceState: r0("s").state, maxChanges: 1 },
          "p1",
        ],
        ["Thread/changes", { accountId: ana.mailboxId, sinceState: r0("ts").state }, "tc"],
      ]);

      expect(Object.keys(r1("u").updated).sort(byId)).toEqual([first, second].sort(byId));
      expect(r1("bad").notUpdated[first].type).toBe("invalidProperties");
      expect(r1("bad").notUpdated[second].type).toBe("invalidProperties");
      expect(r1("mb").list[0]).toMatchObject({ unreadEmails: 1 });
      // Keyword edits never bump Threads (C1).
      expect(r1("tc")).toMatchObject({ created: [], updated: [], destroyed: [] });

      // maxChanges 1: an intermediate token continues the same target before later revisions.
      expect(r1("p1")).toMatchObject({ hasMoreChanges: true });

      const p2 = await run(h, ana, [
        [
          "Email/changes",
          { accountId: ana.mailboxId, sinceState: r1("p1").newState, maxChanges: 1 },
          "p2",
        ],
      ]);

      expect(p2("p2").hasMoreChanges).toBe(false);
      expect([...r1("p1").updated, ...p2("p2").updated].sort(byId)).toEqual(
        [first, second].sort(byId),
      );
    });

    it("coalesces a create-then-destroy inside the interval to nothing", async () => {
      const s = await run(h, ana, [
        ["Email/get", { accountId: ana.mailboxId, ids: [], properties: ["id"] }, "s"],
      ]);

      const c = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                keywords: { $draft: true },
                from: [{ email: ana.address }],
                subject: "temp",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t", type: "text/plain" }],
              },
            },
          },
          "c",
        ],
      ]);

      const id = c("c").created.d.id;

      const d = await run(h, ana, [
        ["Email/set", { accountId: ana.mailboxId, destroy: [id] }, "x"],
        ["Email/changes", { accountId: ana.mailboxId, sinceState: s("s").state }, "ch"],
      ]);

      expect(d("ch")).toMatchObject({ created: [], updated: [], destroyed: [] });
    });

    it("creates drafts with attachments, serves body values, part blobs, header forms and search", async () => {
      const up = await http(
        h,
        { ...bearer(ana), "content-type": "text/plain" },
        "POST",
        `/jmap/upload/${ana.mailboxId}`,
        "attached notes",
      );

      expect(up.status).toBe(201);

      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                keywords: { $draft: true, $seen: true },
                from: [{ name: "Ana", email: ana.address }],
                to: [{ email: "carol@example.net" }],
                bcc: [{ email: "dan@example.net" }],
                subject: "Quarterly zanzibar plan",
                bodyValues: { t: { value: "Hello Carol, the plan is attached." } },
                textBody: [{ partId: "t", type: "text/plain" }],
                attachments: [{ blobId: up.body.blobId, type: "text/plain", name: "notes.txt" }],
                "header:X-Bye-Test:asText": "yes",
              },
            },
          },
          "c",
        ],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            ids: ["#d"],
            properties: [
              "subject",
              "bcc",
              "textBody",
              "attachments",
              "bodyValues",
              "header:X-Bye-Test:asText",
              "hasAttachment",
              "keywords",
            ],
            fetchTextBodyValues: true,
          },
          "g",
        ],
        ["Email/query", { accountId: ana.mailboxId, filter: { text: "zanzibar" } }, "fts"],
        ["Email/query", { accountId: ana.mailboxId, filter: { body: "attached" } }, "body"],
        ["Email/query", { accountId: ana.mailboxId, filter: { to: "carol@example" } }, "to"],
        [
          "Email/query",
          {
            accountId: ana.mailboxId,
            filter: { operator: "NOT", conditions: [{ hasKeyword: "$draft" }] },
            sort: [{ property: "subject" }],
          },
          "sorted",
        ],
      ]);

      const e = r("g").list[0];
      expect(e).toMatchObject({
        subject: "Quarterly zanzibar plan",
        bcc: [{ email: "dan@example.net" }],
        hasAttachment: true,
        keywords: { $draft: true, $seen: true },
        "header:X-Bye-Test:asText": "yes",
      });
      expect(e.bodyValues[e.textBody[0].partId].value).toContain("Hello Carol");
      expect(r("fts").ids).toEqual([e.id]);
      expect(r("body").ids).toEqual([e.id]);
      expect(r("to").ids).toEqual([e.id]);
      expect(r("sorted").ids).not.toContain(e.id);

      const part = await http(
        h,
        bearer(ana),
        "GET",
        `/jmap/download/${ana.mailboxId}/${e.attachments[0].blobId}/notes.txt`,
      );

      expect(part.status).toBe(200);
      expect(part.text).toBe("attached notes");
    });

    it("highlights search snippets and builds nested bodyStructure messages", async () => {
      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              n: {
                mailboxIds: { drafts: true },
                from: [{ email: ana.address }],
                subject: "Nested <structure> zanzibar",
                bodyValues: {
                  t: { value: "plain zanzibar text" },
                  h: { value: "<p>html</p>" },
                  a: { value: "note" },
                },
                bodyStructure: {
                  type: "multipart/mixed",
                  subParts: [
                    {
                      type: "multipart/alternative",
                      subParts: [
                        { partId: "t", type: "text/plain" },
                        { partId: "h", type: "text/html" },
                      ],
                    },
                    {
                      partId: "a",
                      type: "text/plain",
                      disposition: "attachment",
                      name: "note.txt",
                    },
                  ],
                },
              },
            },
          },
          "c",
        ],
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: ["#n"], properties: ["bodyStructure", "attachments"] },
          "g",
        ],
        [
          "SearchSnippet/get",
          { accountId: ana.mailboxId, filter: { text: "zanzibar" }, emailIds: ["#n"] },
          "s",
        ],
      ]);

      expect(r("g").list[0].bodyStructure).toMatchObject({
        type: "multipart/mixed",
        subParts: [
          {
            type: "multipart/alternative",
            subParts: [{ type: "text/plain" }, { type: "text/html" }],
          },
          { type: "text/plain", disposition: "attachment", name: "note.txt" },
        ],
      });
      expect(r("s").list[0]).toMatchObject({
        subject: "Nested &lt;structure&gt; <mark>zanzibar</mark>",
        preview: expect.stringContaining("<mark>zanzibar</mark>"),
      });
    });

    it("imports and parses uploaded messages", async () => {
      const raw = message("erin@example.org", ana.address, "Imported note", "imp1@example.org");

      const up = await http(
        h,
        { ...bearer(ana), "content-type": "message/rfc822" },
        "POST",
        `/jmap/upload/${ana.mailboxId}`,
        raw,
      );

      const r = await run(h, ana, [
        ["Email/parse", { accountId: ana.mailboxId, blobIds: [up.body.blobId, "Unope"] }, "p"],
        [
          "Email/import",
          {
            accountId: ana.mailboxId,
            emails: {
              i: {
                blobId: up.body.blobId,
                mailboxIds: { archive: true },
                keywords: { $seen: true },
                receivedAt: "2026-01-02T03:04:05Z",
              },
            },
          },
          "i",
        ],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            ids: ["#i"],
            properties: ["subject", "receivedAt", "mailboxIds", "blobId"],
          },
          "g",
        ],
      ]);

      expect(r("p").parsed[up.body.blobId]).toMatchObject({
        subject: "Imported note",
        from: [{ email: "erin@example.org" }],
      });
      expect(r("p").notFound).toEqual(["Unope"]);
      expect(r("g").list[0]).toMatchObject({
        subject: "Imported note",
        receivedAt: "2026-01-02T03:04:05Z",
        mailboxIds: { archive: true },
        blobId: up.body.blobId,
      });
    });

    it("publishes new arrivals through staging with thread joins and placement (B4, A2)", async () => {
      await deliver(
        h,
        message("carol@example.net", ana.address, "Re: Lunch", "m3@example.net", {
          inReplyTo: "m2@example.net",
        }),
        "carol@example.net",
        ana.address,
      );
      await deliver(
        h,
        message("stranger@unknown.example", ana.address, "Hello", "s1@unknown.example"),
        "stranger@unknown.example",
        ana.address,
      );

      const r = await run(h, ana, [
        [
          "Email/query",
          {
            accountId: ana.mailboxId,
            filter: { inMailbox: "inbox" },
            sort: [{ property: "receivedAt", isAscending: true }],
          },
          "inbox",
        ],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "inbox", name: "Email/query", path: "/ids" },
            properties: ["threadId", "subject"],
          },
          "g",
        ],
        [
          "Email/query",
          { accountId: ana.mailboxId, filter: { inMailbox: "screener" } },
          "screener",
        ],
      ]);

      const subjects = r("g").list.map((e: JsonRecord) => e["subject"]);
      expect(subjects).toEqual(["Lunch", "Re: Lunch", "Re: Lunch"]);
      expect(new Set(r("g").list.map((e: JsonRecord) => e["threadId"])).size).toBe(1);
      expect(r("screener").ids).toHaveLength(1);
    });
  });

  describe("native policy, drafts and submission (A1, B1, B2, T04, T05)", () => {
    beforeEach(async () => {
      await legacyFixture();
      await activate();
      store(h, ana).ctx.sql.tx(() =>
        store(h, ana).identities.addIdentity({ address: ana.address, kind: "hosted" }),
      );
    });

    const ids = async (mailbox: string) =>
      (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: mailbox } }, "q"],
        ])
      )("q").ids as Array<string>;

    it("a JMAP arrival keeps the legacy delivery effects; sending approves its recipients", async () => {
      const mbx = store(h, ana);

      mbx.ctx.sql.tx(() => {
        mbx.automation.setAway({
          enabled: true,
          startAt: null,
          endAt: null,
          subject: "Away",
          text: "Back soon",
          cooldownMs: 0,
        });
        mbx.ctx.sql.run(
          "INSERT INTO forwarding_destinations (address, token, verified, created_at) VALUES ('fwd@example.org', 't', 1, 0)",
        );
        mbx.ctx.sql.run(
          "INSERT INTO forwarding_rules (rule_id, match_sender, destination, keep_copy) VALUES ('fr_1', NULL, 'fwd@example.org', 0)",
        );
      });
      await command(h, ana, {
        _tag: "SetPolicy",
        kind: "domain",
        subject: "example.net",
        policy: {
          decision: "allowed",
          destination: "imbox",
          labels: [],
          bundle: false,
          notify: true,
        },
      });

      const notifies = h.queues.NOTIFY.sends.length;
      const topics = () => h.queues.PROPAGATE.sends.map((m) => m.body);
      const propagated = topics().length;
      await deliver(
        h,
        message("carol@example.net", ana.address, "After cutover", "ac1@example.net"),
        "carol@example.net",
        ana.address,
      );

      const [emailId] = (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { text: "After cutover" } }, "q"],
        ])
      )("q").ids;

      expect(emailId).toEqual(expect.any(String));
      // New-mail notification and shared-space propagation name the JMAP Email.
      expect(h.queues.NOTIFY.sends.slice(notifies).map((m) => m.body)).toEqual(
        expect.arrayContaining([expect.objectContaining({ resource: emailId })]),
      );
      expect(topics().slice(propagated)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "shared.delivery",
            payload: expect.objectContaining({ deliveryId: emailId }),
          }),
        ]),
      );

      // The away reply went out; the forward was queued as a forwarding job (no local copy kept →
      // Trash). This harness approves no forwarding transport, so it isn't sent here.
      expect(h.sent.map((m) => m.to)).toContain("carol@example.net");
      expect(
        mbx.ctx.sql.all<{ recipients: string }>(
          "SELECT recipients FROM send_jobs WHERE traffic_class = 'forwarding'",
        ),
      ).toEqual([{ recipients: JSON.stringify(["fwd@example.org"]) }]);

      const placed = await run(h, ana, [
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: [emailId], properties: ["mailboxIds"] },
          "g",
        ],
      ]);

      expect(Object.keys(placed("g").list[0].mailboxIds)).toEqual(["trash"]);
      // The frozen legacy ledger gained nothing from the auto-reply.
      expect(
        mbx.ctx.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM deliveries WHERE direction = 'out'",
        )?.n,
      ).toBe(0);

      // Sending through JMAP approves the recipient, as a legacy send does.
      const identityId = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0].id;

      await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                keywords: { $draft: true },
                from: [{ email: ana.address }],
                to: [{ email: "newfriend@example.com" }],
                subject: "Hello",
                bodyValues: { t: { value: "hi" } },
                textBody: [{ partId: "t", type: "text/plain" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId, emailId: "#d" } } },
          "s",
        ],
      ]);
      await h.drain();

      expect(mbx.ledger.policy("address", "newfriend@example.com")).toMatchObject({
        decision: "allowed",
      });
    });

    it("archive, trash, label and restore follow A1 exactly, per email and version", async () => {
      const [feed] = await ids("feed");
      const inbox = await ids("inbox");

      const label = (
        await run(h, ana, [
          ["Mailbox/query", { accountId: ana.mailboxId, filter: { name: "travel" } }, "l"],
        ])
      )("l").ids[0];

      const version = (id: string) =>
        store(h, ana).ctx.sql.one<{ v: number }>(
          "SELECT placement_version AS v FROM jmap_emails WHERE email_id = ?",
          id,
        )!.v;

      const r = await run(h, ana, [
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: version(feed!) },
            action: { type: "archive" },
          },
          "archive",
        ],
        [
          "EmailAction/apply",
          { accountId: ana.mailboxId, emails: { [inbox[0]!]: null }, action: { type: "trash" } },
          "trash",
        ],
        [
          "EmailAction/apply",
          { accountId: ana.mailboxId, emails: { [inbox[1]!]: 999 }, action: { type: "archive" } },
          "stale",
        ],
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: [feed!, inbox[0]!], properties: ["mailboxIds"] },
          "g",
        ],
      ]);

      expect(r("archive").results[feed!]).toEqual({ ok: true });
      expect(r("stale").results[inbox[1]!]).toEqual({ ok: false, reason: "changedSinceSelection" });
      // Feed-only mail archives to Archive; trash keeps the user label (A1, T04).
      expect(r("g").list[0].mailboxIds).toEqual({ archive: true });
      expect(r("g").list[1].mailboxIds).toEqual({ trash: true, [label]: true });

      const more = await run(h, ana, [
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "label", mailboxId: "archive", add: false },
          },
          "notLabel",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [inbox[0]!]: null },
            action: { type: "restore", to: "inbox" },
          },
          "restore",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [inbox[0]!]: null },
            action: { type: "seen", value: false },
          },
          "unread",
        ],
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: [inbox[0]!], properties: ["mailboxIds", "keywords"] },
          "g",
        ],
      ]);

      expect(more("notLabel").results[feed!].reason).toBe("notALabel");
      expect(more("g").list[0]).toEqual({
        id: inbox[0],
        mailboxIds: { inbox: true, [label]: true },
        keywords: {},
      });
    });

    it("refuses removing a last membership, and intent IDs replay instead of acting twice", async () => {
      const r0 = await run(h, ana, [
        ["Mailbox/set", { accountId: ana.mailboxId, create: { l: { name: "Solo" } } }, "m"],
      ]);

      const solo = r0("m").created.l.id;
      const [feed] = await ids("feed");

      const r = await run(h, ana, [
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "move", from: ["feed"], to: solo },
          },
          "move",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "label", mailboxId: solo, add: false },
          },
          "last",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "flag", value: true },
            intentId: "intent-1",
          },
          "i1",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "flag", value: true },
            intentId: "intent-1",
          },
          "i2",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: { [feed!]: null },
            action: { type: "flag", value: false },
            intentId: "intent-1",
          },
          "i3",
        ],
      ]);

      expect(r("move").results[feed!]).toEqual({ ok: true });
      expect(r("last").results[feed!]).toEqual({ ok: false, reason: "lastMembership" });
      expect(r("i1").replayed).toBe(false);
      expect(r("i2").replayed).toBe(true);
      expect(r("i3")).toMatchObject({ name: "error", type: "invalidArguments" });
    });

    it("advances a DraftSession by compare-and-swap, keeps losers as conflicts, then cleans up", async () => {
      const draft = (subject: string) => ({
        mailboxIds: { drafts: true },
        keywords: { $draft: true },
        from: [{ email: ana.address }],
        subject,
        bodyValues: { t: { value: subject } },
        textBody: [{ partId: "t", type: "text/plain" }],
      });

      const r = await run(h, ana, [
        ["Email/set", { accountId: ana.mailboxId, create: { v1: draft("v1") } }, "e1"],
        [
          "DraftSession/set",
          { accountId: ana.mailboxId, create: { s: { headEmailId: "#v1" } } },
          "s",
        ],
        [
          "Email/set",
          { accountId: ana.mailboxId, create: { v2: draft("v2"), v3: draft("v3") } },
          "e2",
        ],
        [
          "DraftSession/set",
          { accountId: ana.mailboxId, update: { "#s": { headEmailId: "#v2", ifVersion: 1 } } },
          "win",
        ],
        [
          "DraftSession/set",
          { accountId: ana.mailboxId, update: { "#s": { headEmailId: "#v3", ifVersion: 1 } } },
          "lose",
        ],
        ["DraftSession/get", { accountId: ana.mailboxId, ids: ["#s"] }, "g"],
        [
          "Email/get",
          { accountId: ana.mailboxId, ids: ["#v1", "#v2", "#v3"], properties: ["id"] },
          "emails",
        ],
      ]);

      const sid = r("s").created.s.id;
      expect(r("win").updated[sid]).toEqual({ version: 2 });
      expect(r("lose").notUpdated[sid].type).toBe("invalidPatch");
      expect(r("g").list[0]).toMatchObject({
        headEmailId: r("e2").created.v2.id,
        version: 2,
        conflicts: [r("e2").created.v3.id],
        pendingCleanup: [],
      });
      // The superseded unchanged head was destroyed after the head advanced (B1 step 3).
      expect(r("emails").notFound).toEqual([r("e1").created.v1.id]);
    });

    it("submits pinned, Bcc-free bytes, reports relay acceptance as queued, and keeps outcomes distinct", async () => {
      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      expect(identity).toMatchObject({ email: ana.address, mayDelete: false });

      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                keywords: { $draft: true, $seen: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                bcc: [{ email: "dan@example.net" }],
                subject: "Sending now",
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
            accountId: ana.mailboxId,
            create: { s: { identityId: identity.id, emailId: "#d", byeIntentId: "send-1" } },
            onSuccessUpdateEmail: {
              "#s": { "mailboxIds/drafts": null, "mailboxIds/sent": true, "keywords/$draft": null },
            },
          },
          "sub",
        ],
      ]);

      const submissionId = r("sub").created.s.id;
      // The implicit Email/set is its own response to the same call (RFC 8621 §7.5).
      expect(r("sub", 1)).toMatchObject({
        name: "Email/set",
        updated: { [r("e").created.d.id]: null },
      });

      // onSuccess* only follows submissions this call changed: naming an earlier one is inert.
      const stray = await run(h, ana, [
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, onSuccessDestroyEmail: [submissionId] },
          "stray",
        ],
        ["Email/get", { accountId: ana.mailboxId, ids: [r("e").created.d.id] }, "still"],
      ]);

      expect(stray("stray", 1)?.destroyed ?? []).toEqual([]);
      expect(stray("still").list).toHaveLength(1);

      await h.drain();
      // Bcc recipients come from the envelope; the bytes sent carry no Bcc header (B2).
      expect(h.sent.map((m) => m.to)).toEqual(
        expect.arrayContaining(["carol@example.net", "dan@example.net"]),
      );

      for (const m of h.sent) expect(String(m.raw)).not.toMatch(/^bcc:/im);

      // Destroying the Email after submission never releases what the submission pinned.
      const after = await run(h, ana, [
        ["Email/set", { accountId: ana.mailboxId, destroy: [r("e").created.d.id] }, "x"],
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: [submissionId] }, "g"],
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            create: {
              again: {
                identityId: identity.id,
                emailId: r("e").created.d.id,
                byeIntentId: "send-1",
              },
            },
          },
          "replay",
        ],
      ]);

      const status = after("g").list[0];
      expect(status.undoStatus).toBe("final");
      expect(
        Object.values(status.deliveryStatus).map((d) => (d as JsonRecord)["delivered"]),
      ).toEqual(["queued", "queued"]);
      // A lost-response retry with the same intent gets the stored result, even though its draft
      // has since been destroyed: no second send, and the client learns the first succeeded (B1).
      expect(after("replay").created.again.id).toBe(submissionId);

      const reused = await run(h, ana, [
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            create: {
              other: { identityId: identity.id, emailId: "eml_other", byeIntentId: "send-1" },
            },
          },
          "x",
        ],
      ]);

      expect(reused("x").notCreated.other.description).toMatch(/different payload/);

      const pins = store(h, ana).ctx.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jmap_blob_pins WHERE owner = ?",
        `submission:${submissionId}`,
      );

      expect(Number(pins?.n)).toBe(1);
    });

    it("imports an attached message as its own Email, not the outer one", async () => {
      const raw = [
        "From: carol@example.net",
        `To: ${ana.address}`,
        "Subject: Outer",
        "Message-ID: <outer@example.net>",
        "Date: Mon, 12 Oct 2026 12:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "outer body",
        "--b",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="inner.eml"',
        "",
        "From: dan@example.org",
        `To: ${ana.address}`,
        "Subject: Inner",
        "Message-ID: <inner@example.org>",
        "Date: Mon, 12 Oct 2026 11:00:00 +0000",
        "Content-Type: text/plain",
        "",
        "inner body",
        "--b--",
        "",
      ].join("\r\n");

      await deliver(h, raw, "carol@example.net", ana.address);
      const sql = store(h, ana).ctx.sql;
      sql.run("UPDATE jmap_emails SET scan_status = 'clean' WHERE subject = 'Outer'");

      const outer = await run(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { subject: "Outer" } }, "q"],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["attachments"],
          },
          "g",
        ],
      ]);

      const part = (outer("g").list[0].attachments as Array<JsonRecord>).find(
        (a) => a["type"] === "message/rfc822",
      )!;

      const imported = await run(h, ana, [
        [
          "Email/import",
          {
            accountId: ana.mailboxId,
            emails: { i: { blobId: part["blobId"], mailboxIds: { archive: true }, keywords: {} } },
          },
          "imp",
        ],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            ids: ["#i"],
            properties: ["subject", "blobId", "bodyValues"],
            fetchTextBodyValues: true,
          },
          "g",
        ],
      ]);

      const email = imported("g").list[0];

      expect(email.subject).toBe("Inner");
      expect(email.blobId).not.toBe(part["blobId"]);
      expect(Object.values(email.bodyValues).map((v) => (v as JsonRecord)["value"])).toEqual([
        expect.stringContaining("inner body"),
      ]);
    });

    it("cancels a delayed send before the attempt boundary, never after", async () => {
      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const draft = {
        mailboxIds: { drafts: true },
        keywords: { $draft: true },
        from: [{ email: ana.address }],
        to: [{ email: "carol@example.net" }],
        subject: "Later",
        bodyValues: { t: { value: "later" } },
        textBody: [{ partId: "t", type: "text/plain" }],
      };

      const r = await run(h, ana, [
        ["Email/set", { accountId: ana.mailboxId, create: { d: draft } }, "e"],
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            create: {
              s: {
                identityId: identity.id,
                emailId: "#d",
                envelope: {
                  mailFrom: { email: ana.address, parameters: { HOLDFOR: "3600" } },
                  rcptTo: [{ email: "carol@example.net" }],
                },
              },
            },
          },
          "sub",
        ],
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: ["#s"] }, "before"],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, update: { "#s": { undoStatus: "canceled" } } },
          "cancel",
        ],
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: ["#s"] }, "after"],
        [
          "EmailSubmission/query",
          { accountId: ana.mailboxId, filter: { undoStatus: "canceled" } },
          "q",
        ],
      ]);

      expect(r("before").list[0].undoStatus).toBe("pending");

      // A HOLDFOR submission retried later with its intent ID is the same submission (B1).
      const held = {
        identityId: identity.id,
        emailId: r("e").created.d.id,
        byeIntentId: "held-1",
        envelope: {
          mailFrom: { email: ana.address, parameters: { HOLDFOR: "600" } },
          rcptTo: [{ email: "carol@example.net" }],
        },
      };

      const first = await run(h, ana, [
        ["EmailSubmission/set", { accountId: ana.mailboxId, create: { h: held } }, "h"],
      ]);

      vi.setSystemTime(Date.now() + 5_000);

      const retry = await run(h, ana, [
        ["EmailSubmission/set", { accountId: ana.mailboxId, create: { h: held } }, "h"],
      ]);

      expect(retry("h").created.h.id).toBe(first("h").created.h.id);
      expect(r("cancel").updated).toEqual({ [r("sub").created.s.id]: null });
      expect(r("after").list[0].undoStatus).toBe("canceled");
      expect(r("q").ids).toEqual([r("sub").created.s.id]);

      // An immediate send that the dispatcher already claimed can't be unsent.
      const now = await run(h, ana, [
        ["Email/set", { accountId: ana.mailboxId, create: { d: draft } }, "e"],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId: identity.id, emailId: "#d" } } },
          "sub",
        ],
      ]);

      await h.drain();

      const late = await run(h, ana, [
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            update: { [now("sub").created.s.id]: { undoStatus: "canceled" } },
          },
          "cancel",
        ],
      ]);

      expect(late("cancel").notUpdated[now("sub").created.s.id].type).toBe("cannotUnsend");
    });

    it("rejects submissions whose From or envelope isn't the identity's", async () => {
      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                from: [{ email: "mallory@evil.example" }],
                to: [{ email: "x@example.net" }],
                subject: "spoof",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId: identity.id, emailId: "#d" } } },
          "sub",
        ],
      ]);

      expect(r("sub").notCreated.s.type).toBe("forbiddenFrom");
    });

    it("VacationResponse maps onto the away settings", async () => {
      const r = await run(h, ana, [
        [
          "VacationResponse/set",
          {
            accountId: ana.mailboxId,
            update: {
              singleton: {
                isEnabled: true,
                subject: "Away",
                textBody: "Back Monday",
                toDate: "2026-10-20T00:00:00Z",
              },
            },
          },
          "s",
        ],
        ["VacationResponse/get", { accountId: ana.mailboxId }, "g"],
      ]);

      expect(r("g").list[0]).toMatchObject({
        id: "singleton",
        isEnabled: true,
        textBody: "Back Monday",
        toDate: "2026-10-20T00:00:00Z",
      });
      expect(store(h, ana).automation.away()).toMatchObject({ enabled: true, text: "Back Monday" });
    });
  });

  describe("accounts, rights, copy, push and staging (A3, B3, B4, T06, T07, T09)", () => {
    const share = async (owner: Account, member: Account) => {
      await h.env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT org_id, ?, 'member', 'active', ?, ? FROM mailboxes WHERE id = ?`,
      )
        .bind(member.userId, Date.now(), Date.now(), owner.mailboxId)
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
        .bind(owner.mailboxId, member.userId, Date.now())
        .run();
    };

    const syncGrants = (a: Account) =>
      http(
        h,
        { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        "POST",
        "/v1/ops/jmap/grants",
        JSON.stringify({ mailboxId: a.mailboxId }),
      );

    beforeEach(async () => {
      await legacyFixture();
      await activate();
    });

    it("grants commit in the account; revocation removes discovery and access", async () => {
      await share(ana, bob);
      // Directory intent alone isn't enough: the account must commit the effective grant (A3).
      expect(
        (await jmap(h, bob, [["Mailbox/get", { accountId: ana.mailboxId, ids: ["inbox"] }, "m"]]))
          .body.methodResponses[0][1].type,
      ).toBe("accountNotFound");
      expect((await syncGrants(ana)).body).toMatchObject({ committed: true });

      const seen = await run(h, bob, [
        ["Mailbox/get", { accountId: ana.mailboxId, ids: ["inbox"] }, "m"],
      ]);

      expect(seen("m").list[0].totalEmails).toBeGreaterThan(0);

      const ownerState = (
        await run(h, ana, [["Mailbox/get", { accountId: ana.mailboxId, ids: ["inbox"] }, "m"]])
      )("m").state;

      await h.env.DIRECTORY.prepare(
        "DELETE FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?",
      )
        .bind(ana.mailboxId, bob.userId)
        .run();
      await syncGrants(ana);

      const gone = await run(h, bob, [
        ["Mailbox/get", { accountId: ana.mailboxId, ids: ["inbox"] }, "m"],
      ]);

      expect(gone("m")).toMatchObject({ name: "error", type: "accountNotFound" });

      // Another principal's grant change never invalidates the owner's states: visibility is
      // bound to the principal's own grants (A3), so the owner keeps syncing incrementally.
      const owner = await run(h, ana, [
        ["Mailbox/changes", { accountId: ana.mailboxId, sinceState: ownerState }, "c"],
      ]);

      expect(owner("c")).toMatchObject({ name: "Mailbox/changes", oldState: ownerState });
    });

    it("copies across accounts in phases; the destination commits before the source is destroyed", async () => {
      await share(bob, ana);
      // Bob's account migrates too, with Ana as a member.
      await migrate(h, bob.mailboxId, "start");
      await migrate(h, bob.mailboxId, "activate");

      const [feed] = (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "feed" } }, "q"],
        ])
      )("q").ids;

      const r = await run(h, ana, [
        [
          "Email/copy",
          {
            fromAccountId: ana.mailboxId,
            accountId: bob.mailboxId,
            create: { c: { id: feed, mailboxIds: { archive: true } } },
            onSuccessDestroyOriginal: true,
          },
          "copy",
        ],
      ]);

      expect(r("copy").created.c.id).toBeDefined();
      expect(r("copy", 1)).toMatchObject({ name: "Email/set", destroyed: [feed] });

      const dest = await run(h, bob, [
        [
          "Email/get",
          {
            accountId: bob.mailboxId,
            ids: [r("copy").created.c.id],
            properties: ["subject", "mailboxIds", "keywords", "blobId", "bodyValues"],
            fetchTextBodyValues: true,
          },
          "g",
        ],
      ]);

      const copied = dest("g").list[0];

      expect(copied).toMatchObject({
        subject: "Weekly digest",
        mailboxIds: { archive: true },
      });

      // The copied message's bytes resolve from its own blob (ORIGINALS), not the source's.
      expect(Object.values(copied.bodyValues).map((v) => (v as JsonRecord)["value"])).toEqual([
        expect.stringContaining("Weekly digest"),
      ]);

      const download = await http(
        h,
        bearer(bob),
        "GET",
        `/jmap/download/${bob.mailboxId}/${copied.blobId}/copy.eml?accept=message/rfc822`,
      );

      expect(download.status).toBe(200);
    });

    it("parks arrivals whose original can't be prepared and replays them on request (B4)", async () => {
      const mbx = mockAs<{ commitDelivery: (input: JsonRecord) => Promise<JsonRecord> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      );

      const input = {
        ingestionId: "ing-missing",
        recipient: ana.address,
        messageKey: `t/${ana.mailboxId}/orig/missing.eml`,
        rawSize: 10,
        summary: {
          from: { name: undefined, address: "carol@example.net" },
          to: [{ name: undefined, address: ana.address }],
          cc: [],
          replyTo: [],
          subject: "Lost",
          date: Date.now(),
          messageIdHeader: "lost@example.net",
          inReplyTo: [],
          references: [],
          listId: undefined,
          listUnsubscribe: undefined,
          automated: false,
          snippet: "",
          attachments: [],
          hasCalendar: false,
          calendarMethod: undefined,
        },
        safety: { _tag: "Clean" },
        receivedAt: Date.now(),
      };

      // Acknowledged once staged, even though preparation fails (no bytes yet).
      expect(await mbx.commitDelivery(input)).toMatchObject({ ok: true });
      const s = store(h, ana);

      // The failed attempt re-arms the alarm for a bounded retry; it doesn't wait for other work.
      const wake = s.nextWakeAt(Date.now());

      expect(wake).not.toBeNull();
      expect(wake!).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

      // An alarm never re-prepares an arrival inside its backoff (one still in flight looks the
      // same: just touched), only once the backoff has passed.
      expect(s.jmap.ingest.due(Date.now(), 10)).toEqual([]);
      expect(s.jmap.ingest.due(Date.now() + 61_000, 10)).toEqual([`ing-missing:${ana.address}`]);

      for (let i = 0; i < 3; i++) {
        const id = s.jmap.ingest.pending(10)[0];

        if (id && s.jmap.ingest.preparing(id)) s.jmap.ingest.failed(id, "original not found");
      }

      const parked = await http(
        h,
        { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        "POST",
        "/v1/ops/jmap/parked",
        JSON.stringify({ mailboxId: ana.mailboxId }),
      );

      expect(parked.body.items).toEqual([
        { arrivalId: `ing-missing:${ana.address}`, reason: "original not found" },
      ]);

      await h.env.ORIGINALS.put(
        input.messageKey,
        message("carol@example.net", ana.address, "Lost", "lost@example.net"),
      );

      const replay = await http(
        h,
        { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        "POST",
        "/v1/ops/jmap/replay",
        JSON.stringify({ mailboxId: ana.mailboxId, arrivalId: `ing-missing:${ana.address}` }),
      );

      expect(replay.body).toMatchObject({ state: "published" });
    });

    it("streams core StateChange events and validates push callbacks (T09, SSRF)", async () => {
      const stream = await http(
        h,
        bearer(ana),
        "GET",
        "/jmap/eventsource?types=Email&closeafter=state&ping=0",
      );

      expect(stream.text).toContain('"Email"');

      const fetched: Array<string> = [];

      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        fetched.push(String(input instanceof Request ? input.url : input));

        return new Response(null, { status: 201 });
      });

      try {
        const r = await run(h, ana, [
          [
            "PushSubscription/set",
            {
              create: {
                bad: { deviceClientId: "d1", url: "https://127.0.0.1/push" },
                local: { deviceClientId: "d1", url: "https://push.internal/x" },
                ok: { deviceClientId: "d1", url: "https://push.example.com/cb" },
              },
            },
            "p",
          ],
        ]);

        expect(r("p").notCreated.bad.type).toBe("invalidProperties");
        expect(r("p").notCreated.local.type).toBe("invalidProperties");
        expect(r("p").created.ok.id).toMatch(/^psb_/);
        await h.settle();
        expect(fetched).toContain("https://push.example.com/cb");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("dispatch recovery registry and housekeeping (C2, B2, B3)", () => {
    beforeEach(async () => {
      await legacyFixture();
      await activate();
      store(h, ana).ctx.sql.tx(() =>
        store(h, ana).identities.addIdentity({ address: ana.address, kind: "hosted" }),
      );
    });

    const submit = async () => {
      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                subject: "Held",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId: identity.id, emailId: "#d" } } },
          "s",
        ],
      ]);

      const submissionId = r("s").created.s.id as string;

      const job = store(h, ana).ctx.sql.one<{ send_job_id: string }>(
        "SELECT send_job_id FROM jmap_submissions WHERE submission_id = ?",
        submissionId,
      )!.send_job_id;

      return { submissionId, job };
    };

    it("journals every attempt outside the snapshot and admits none while held", async () => {
      await h.env.DIRECTORY.prepare(
        "INSERT INTO dispatch_holds (mailbox_id, reason, created_at) VALUES (?, 'test', 0)",
      )
        .bind(ana.mailboxId)
        .run();
      const { job } = await submit();
      await h.drain();

      expect(store(h, ana).sends.job(job)?.state).toBe("ready");
      expect(h.sent).toHaveLength(0);

      await h.env.DIRECTORY.prepare("DELETE FROM dispatch_holds WHERE mailbox_id = ?")
        .bind(ana.mailboxId)
        .run();
      store(h, ana).ctx.sql.tx(() =>
        store(h, ana).kernel.outbox("dispatch", ana.mailboxId, { sendJobId: job }),
      );
      await mockAs<{ alarm: () => Promise<void> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).alarm();
      await h.drain();

      expect(store(h, ana).sends.job(job)?.state).toBe("accepted");

      const attempts = await h.env.DIRECTORY.prepare(
        "SELECT COUNT(*) AS n FROM send_attempts WHERE send_job_id = ?",
      )
        .bind(job)
        .first<{ n: number }>();

      expect(Number(attempts?.n)).toBe(1);
    });

    it("reconciles restored jobs: attempted without acceptance is ambiguous, accepted evidence wins", async () => {
      const held = await submit();
      const accepted = await submit();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO dispatch_holds (mailbox_id, reason, created_at) VALUES (?, 'restore', 0)",
      )
        .bind(ana.mailboxId)
        .run();

      const mbx = mockAs<{
        reconcileRestoredSends: (e: ReadonlyArray<JsonRecord>) => {
          accepted: number;
          ambiguous: number;
          unknown: ReadonlyArray<JsonRecord>;
        };
      }>(h.namespaces.MAILBOXES.instance(ana.mailboxId));

      const out = mbx.reconcileRestoredSends([
        { sendJobId: held.job, attempted: true, providerId: null },
        { sendJobId: accepted.job, attempted: true, providerId: "prov-1" },
        { sendJobId: "missing", attempted: true, providerId: null },
      ]);

      // The ambiguous job is reported so the caller registers it with the provider reconciler.
      expect(out).toEqual({
        accepted: 1,
        ambiguous: 1,
        unknown: [{ sendJobId: held.job, trafficClass: "personal" }],
      });
      expect(store(h, ana).sends.job(held.job)?.state).toBe("unknown");
      expect(store(h, ana).sends.job(accepted.job)?.state).toBe("accepted");

      const r = await run(h, ana, [
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: [held.submissionId] }, "g"],
      ]);

      expect(
        Object.values(r("g").list[0].deliveryStatus).map((d) => (d as JsonRecord)["delivered"]),
      ).toEqual(["unknown"]);
    });

    it("hands expired, unreferenced uploads to the delayed blob GC and keeps referenced bytes", async () => {
      const keep = await http(
        h,
        { ...bearer(ana), "content-type": "message/rfc822" },
        "POST",
        `/jmap/upload/${ana.mailboxId}`,
        message("x@example.org", ana.address, "Keep", "keep@x"),
      );

      const drop = await http(
        h,
        { ...bearer(ana), "content-type": "text/plain" },
        "POST",
        `/jmap/upload/${ana.mailboxId}`,
        "transient",
      );

      await run(h, ana, [
        [
          "Email/import",
          {
            accountId: ana.mailboxId,
            emails: { i: { blobId: keep.body.blobId, mailboxIds: { archive: true } } },
          },
          "i",
        ],
      ]);

      const key = store(h, ana).ctx.sql.one<{ r2_key: string }>(
        "SELECT r2_key FROM jmap_blobs WHERE blob_id = ?",
        drop.body.blobId,
      )!.r2_key;

      expect(await h.env.PARTS.get(key)).not.toBeNull();

      vi.setSystemTime(Date.now() + 2 * 24 * 3600 * 1000);
      await mockAs<{ alarm: () => Promise<void> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).alarm();
      await h.drain();

      // Unregistered at once; the bytes go only after the GC delay and a fresh reference check.
      expect(await h.env.PARTS.get(key)).not.toBeNull();
      await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS + 1);
      expect(await h.env.PARTS.get(key)).toBeNull();
      expect(
        (await http(h, bearer(ana), "GET", `/jmap/download/${ana.mailboxId}/${drop.body.blobId}/x`))
          .status,
      ).toBe(404);
      expect(
        (await http(h, bearer(ana), "GET", `/jmap/download/${ana.mailboxId}/${keep.body.blobId}/x`))
          .status,
      ).toBe(200);
    });
  });

  describe("frozen legacy state after cutover (C3)", () => {
    it("cron applies retention on the core, never to the frozen legacy rows or their scans", async () => {
      const thread = await legacyFixture();
      await command(h, ana, { _tag: "MoveToTrash", threadIds: [thread.threadId] });
      await activate();

      const instance = h.namespaces.MAILBOXES.instance(ana.mailboxId);
      const sql = store(h, ana).ctx.sql;

      const legacyCount = () =>
        Number(sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries")?.n);

      const before = legacyCount();
      const keys = sql.all<{ r2_key: string }>("SELECT r2_key FROM jmap_blobs");

      // One migrated Email whose scan verdict never arrived, and one legacy row likewise.
      const pending = sql.one<{ email_id: string }>("SELECT email_id FROM jmap_emails LIMIT 1")!;
      sql.run(
        "UPDATE jmap_emails SET scan_status = 'pending' WHERE email_id = ?",
        pending.email_id,
      );
      sql.run("UPDATE deliveries SET scan_status = 'pending'");
      const sent = h.queues.PROPAGATE.sends.length;

      const trashed = sql.all<{ email_id: string }>(
        "SELECT email_id FROM jmap_memberships WHERE mailbox_id = 'trash'",
      );

      expect(trashed.length).toBeGreaterThan(0);

      // Well past Trash retention: the core purges the migrated Emails in Trash; the frozen
      // legacy rows stay put.
      const out = await instance.reconcile(Date.now() + 400 * 86_400_000);

      expect(out.purged).toBe(trashed.length);
      expect(legacyCount()).toBe(before);

      for (const { email_id } of trashed)
        expect(sql.one("SELECT 1 AS x FROM jmap_emails WHERE email_id = ?", email_id)).toBe(
          undefined,
        );

      // Scans are replayed for the core's Emails only, never for the frozen legacy rows.
      const scans = h.queues.PROPAGATE.sends
        .slice(sent)
        .map((m) => (m.body as JsonRecord)["payload"] as JsonRecord)
        .filter((p) => p["topic"] === "scan-message")
        .map((p) => p["deliveryId"]);

      expect(scans).toEqual([pending.email_id]);

      // Blob GC asks the authority: a remaining Email's object counts as referenced; the purged
      // Emails' objects were released by the same reconcile, frozen legacy rows notwithstanding.
      const kept = new Set(
        sql
          .all<{ r2_key: string }>(
            "SELECT b.r2_key FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id",
          )
          .map((r) => r.r2_key),
      );

      expect(kept.size).toBeGreaterThan(0);

      for (const { r2_key } of keys)
        expect(await instance.messageKeyReferenced(r2_key)).toBe(kept.has(r2_key));
    });

    it("an aborted attempt's audit findings don't block a retry once the cause is fixed", async () => {
      await legacyFixture();

      const { message_key: key } = store(h, ana).ctx.sql.one<{ message_key: string }>(
        "SELECT message_key FROM deliveries WHERE direction = 'in' LIMIT 1",
      )!;

      const original = await (await h.env.ORIGINALS.get(key))!.arrayBuffer();
      await h.env.ORIGINALS.delete(key);

      const first = await migrate(h, ana.mailboxId, "start");

      expect(first.body.verified).toBe(false);
      expect(first.body.problems).toContain("original message bytes missing for some deliveries");
      expect((await migrate(h, ana.mailboxId, "abort")).body.mode).toBe("legacy");

      await h.env.ORIGINALS.put(key, original);
      await activate();
    });

    it("legacy jobs due while fenced wait without re-arming the alarm or taking batch slots", async () => {
      await legacyFixture();
      const s = store(h, ana);
      const now = Date.now();

      s.ctx.sql.tx(() => {
        for (let i = 0; i < 120; i++) s.kernel.schedule("retention-sweep", `due-${i}`, now - 1, {});
      });
      expect((await migrate(h, ana.mailboxId, "step")).body.mode).toBe("backfilling");

      // Nothing runnable is due: the deferred jobs don't make the alarm fire immediately.
      const wake = s.nextWakeAt(now);

      expect(wake === null || wake > now).toBe(true);
      expect(s.runDueJobs(now)).toMatchObject({ ran: 0, stale: 0 });
      expect(
        s.ctx.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = 'retention-sweep' AND state = 'pending'",
        )?.n,
      ).toBe(120);
    });

    it("a scan verdict buffered while fenced applies to the migrated Email", async () => {
      await legacyFixture();
      const sql = store(h, ana).ctx.sql;

      const { delivery_id: deliveryId } = sql.one<{ delivery_id: string }>(
        "SELECT delivery_id FROM deliveries WHERE direction = 'in' ORDER BY received_at LIMIT 1",
      )!;

      // An attachment scan still outstanding at the fence.
      sql.run("UPDATE deliveries SET scan_status = 'pending' WHERE delivery_id = ?", deliveryId);
      expect((await migrate(h, ana.mailboxId, "step")).body.mode).toBe("backfilling");
      await h.namespaces.MAILBOXES.instance(ana.mailboxId).recordDeliveryScan(
        deliveryId,
        "infected",
      );
      await activate();

      const email = sql.one<{ email_id: string; scan_status: string; quarantined: number }>(
        "SELECT email_id, scan_status, quarantined FROM jmap_emails WHERE email_id = ? OR legacy_delivery_id = ?",
        deliveryId,
        deliveryId,
      )!;

      expect(email).toMatchObject({ scan_status: "infected", quarantined: 1 });
    });

    it("legacy identity commands surface as Identity changes under the real IDs", async () => {
      await legacyFixture();
      await activate();

      const state = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).state;

      // Straight to the authority: the HTTP route's passkey step-up isn't what's under test.
      await mockAs<{ execute: (c: JsonRecord) => Promise<JsonRecord> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).execute({
        _tag: "AddIdentity",
        commandId: "cmd_identity_after_cutover1",
        address: ana.address,
        kind: "hosted",
      });

      const r = await run(h, ana, [
        ["Identity/changes", { accountId: ana.mailboxId, sinceState: state }, "c"],
        ["Identity/get", { accountId: ana.mailboxId }, "g"],
      ]);

      const ids = r("g").list.map((i: JsonRecord) => i["id"]);

      expect(ids).toHaveLength(1);
      expect(r("c").created).toEqual(ids);
      expect(r("c").updated).not.toContain("*");
    });
  });

  describe("cutover regressions", () => {
    const alarm = () =>
      mockAs<{ alarm: () => Promise<void> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).alarm();

    const hosted = () => {
      const s = store(h, ana);
      s.ctx.sql.tx(() => s.identities.addIdentity({ address: ana.address, kind: "hosted" }));
    };

    const query = async (mailboxId: string) =>
      (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: mailboxId } }, "q"],
          [
            "Email/get",
            {
              accountId: ana.mailboxId,
              "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
              properties: ["id", "subject", "keywords", "threadId"],
            },
            "g",
          ],
        ])
      )("g").list as Array<JsonRecord>;

    it("a Send Later accepted after the cutover lands in Sent and approves its recipients", async () => {
      await legacyFixture();
      hosted();
      const s = store(h, ana);

      const { draftId } = s.ctx.sql.tx(() =>
        s.drafts.createDraft({
          content: {
            to: [{ name: undefined, address: "erin@example.org" }],
            cc: [],
            bcc: [],
            subject: "Later",
            text: "see you then",
            attachments: [],
          },
        }),
      );

      const at = Date.now() + 3600_000;
      s.ctx.sql.tx(() => s.sends.send(draftId, { expectedRevision: 1, sendAt: at }));
      await activate();

      vi.setSystemTime(at + 1000);
      await alarm();
      await h.drain();

      const sent = await query("sent");

      expect(sent.map((e) => e["subject"])).toContain("Later");
      expect(sent.find((e) => e["subject"] === "Later")?.["keywords"]).toEqual({ $seen: true });
      expect(s.ledger.policy("address", "erin@example.org")).toMatchObject({
        decision: "allowed",
      });
    });

    it("shared-space selection reads a migrated account's thread from the core", async () => {
      await legacyFixture();
      await activate();
      const [email] = await query("inbox");

      const emailId = email!["id"] as string;

      const selected = await sharedMessageOf(h.env, ana.mailboxId, email!["threadId"] as string, [
        emailId,
      ]);

      expect(selected?.messages.map((m) => m.messageRef)).toEqual([emailId]);
      expect(await sharedMessageOf(h.env, ana.mailboxId, "thr_missing", ["x"])).toBeNull();
    });

    it("a scheduled emptyTrash empties what is in Trash when it runs", async () => {
      await legacyFixture();
      await activate();

      const inbox = await run(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "inbox" } }, "q"],
      ]);

      const [first] = inbox("q").ids as Array<string>;

      const r = await run(h, ana, [
        [
          "EmailAction/apply",
          { accountId: ana.mailboxId, emails: { [first!]: null }, action: { type: "trash" } },
          "t",
        ],
        [
          "EmailAction/apply",
          {
            accountId: ana.mailboxId,
            emails: {},
            action: { type: "emptyTrash" },
            at: new Date(Date.now() + 3600_000).toISOString(),
          },
          "e",
        ],
      ]);

      expect(r("e").timerId).toBeDefined();
      expect(await query("trash")).toHaveLength(1);

      vi.setSystemTime(Date.now() + 2 * 3600_000);
      await alarm();

      expect(await query("trash")).toHaveLength(0);
    });

    it("a destroyed Email's bytes go to the delayed blob GC", async () => {
      await legacyFixture();
      await activate();
      const sql = store(h, ana).ctx.sql;

      const [id] = (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "feed" } }, "q"],
        ])
      )("q").ids as Array<string>;

      const { blob_id: blobId, r2_key: key } = sql.one<{ blob_id: string; r2_key: string }>(
        "SELECT b.blob_id, b.r2_key FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id WHERE e.email_id = ?",
        id,
      )!;

      await run(h, ana, [["Email/set", { accountId: ana.mailboxId, destroy: [id!] }, "d"]]);
      vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
      await alarm();
      await h.drain();

      expect(sql.one("SELECT 1 AS x FROM jmap_blobs WHERE blob_id = ?", blobId)).toBeUndefined();
      expect(await h.env.ORIGINALS.get(key)).not.toBeNull();
      await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS + 1);
      expect(await h.env.ORIGINALS.get(key)).toBeNull();
    });

    it("a reply skips the Screener only from an exact participant of a thread we sent into", async () => {
      await legacyFixture();
      await activate();

      await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              s: {
                mailboxIds: { sent: true },
                keywords: { $seen: true },
                from: [{ email: ana.address }],
                to: [{ email: "ceo@corp.example" }],
                subject: "Proposal",
                messageId: ["p1@bye.test"],
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
      ]);

      // "o@corp.example" is a substring of "ceo@corp.example", never a participant.
      await deliver(
        h,
        message("o@corp.example", ana.address, "Re: Proposal", "r1@corp.example", {
          inReplyTo: "p1@bye.test",
        }),
        "o@corp.example",
        ana.address,
      );
      await deliver(
        h,
        message("ceo@corp.example", ana.address, "Re: Proposal", "r2@corp.example", {
          inReplyTo: "p1@bye.test",
        }),
        "ceo@corp.example",
        ana.address,
      );

      const fromOf = async (box: string) =>
        (
          await run(h, ana, [
            ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: box } }, "q"],
            [
              "Email/get",
              {
                accountId: ana.mailboxId,
                "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
                properties: ["from"],
              },
              "g",
            ],
          ])
        )("g").list.map((e: JsonRecord) => (e["from"] as Array<JsonRecord>)[0]!["email"]);

      expect(await fromOf("screener")).toContain("o@corp.example");
      expect(await fromOf("inbox")).toContain("ceo@corp.example");
    });

    it("submissions are visible to, and cancellable by, their creator only", async () => {
      await legacyFixture();
      await activate();
      hosted();
      await h.env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT org_id, ?, 'member', 'active', ?, ? FROM mailboxes WHERE id = ?`,
      )
        .bind(bob.userId, Date.now(), Date.now(), ana.mailboxId)
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
        .bind(ana.mailboxId, bob.userId, Date.now())
        .run();
      store(h, ana).jmap.core.applyGrant(bob.userId, "*", FULL_RIGHTS);

      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const created = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                bcc: [{ email: "secret@example.net" }],
                subject: "Bcc",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            create: {
              s: {
                identityId: identity.id,
                emailId: "#d",
                envelope: {
                  mailFrom: { email: ana.address, parameters: { HOLDFOR: "3600" } },
                  rcptTo: [{ email: "carol@example.net" }, { email: "secret@example.net" }],
                },
              },
            },
          },
          "s",
        ],
      ]);

      const id = created("s").created.s.id as string;

      const before = (
        await run(h, ana, [["EmailSubmission/get", { accountId: ana.mailboxId, ids: [] }, "g"]])
      )("g").state;

      const other = await run(h, bob, [
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: [id] }, "g"],
        ["EmailSubmission/query", { accountId: ana.mailboxId }, "q"],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, update: { [id]: { undoStatus: "canceled" } } },
          "u",
        ],
      ]);

      expect(other("g").notFound).toEqual([id]);
      expect(other("q").ids).toEqual([]);
      expect(other("u").notUpdated[id].type).toBe("notFound");

      // A legacy CancelSend (still allowed after activation) is an EmailSubmission change.
      const job = store(h, ana).ctx.sql.one<{ send_job_id: string }>(
        "SELECT send_job_id FROM jmap_submissions WHERE submission_id = ?",
        id,
      )!.send_job_id;

      await mockAs<{ execute: (c: JsonRecord) => Promise<JsonRecord> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).execute({ _tag: "CancelSend", commandId: "cmd_cancel_after_cutover01", sendJobId: job });

      const changes = await run(h, ana, [
        ["EmailSubmission/changes", { accountId: ana.mailboxId, sinceState: before }, "c"],
        ["EmailSubmission/get", { accountId: ana.mailboxId, ids: [id] }, "g"],
      ]);

      expect(changes("c").updated).toContain(id);
      expect(changes("g").list[0].undoStatus).toBe("canceled");
    });

    it("pushes per-principal states to any number of grant holders; revoke-all removes subscriptions", async () => {
      const users = Array.from({ length: 120 }, (_, i) => `usr_push_${i}`);

      await h.env.DIRECTORY.prepare(
        `INSERT INTO jmap_push_subscriptions (id, user_id, session_id, device_client_id, url, keys_json, verification_code, verified_at, expires_at, types, created_at)
         VALUES ('psb_1', ?, 'ses_1', 'dev', 'https://push.example.org/x', NULL, 'code', 1, ?, NULL, 1)`,
      )
        .bind(users[110], Date.now() + 3600_000)
        .run();

      const posted: Array<JsonRecord> = [];

      const fetcher = (async (_url: string, init: RequestInit) => {
        posted.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));

        return new Response(null, { status: 201 });
      }) as typeof fetch;

      const sent = await pushStateChange(
        h.env,
        new Map(users.map((u) => [u, { Email: `state-${u}` }])),
        ana.mailboxId,
        fetcher,
      );

      expect(sent).toBe(1);
      expect(posted[0]).toEqual({
        "@type": "StateChange",
        changed: { [ana.mailboxId]: { Email: `state-${users[110]}` } },
      });

      const db: D1Like = h.env.DIRECTORY;
      await db.batch(revokeAllCredentials(db, kernelClock, users[110]!, "test"));
      expect(
        await h.env.DIRECTORY.prepare("SELECT 1 AS x FROM jmap_push_subscriptions").first(),
      ).toBeNull();
    });

    it("a sender's own screened messages never vouch for its next reply", async () => {
      await legacyFixture();
      await activate();

      await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              s: {
                mailboxIds: { sent: true },
                keywords: { $seen: true },
                from: [{ email: ana.address }],
                to: [{ email: "alice@corp.example" }],
                subject: "Plan",
                messageId: ["s1@bye.test"],
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
      ]);

      for (const id of ["m1@evil.example", "m2@evil.example"])
        await deliver(
          h,
          message("mallory@evil.example", ana.address, "Re: Plan", id, {
            inReplyTo: "s1@bye.test",
          }),
          "mallory@evil.example",
          ana.address,
        );

      const r = await run(h, ana, [
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "screener" } }, "s"],
        ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "inbox" } }, "i"],
        [
          "Email/get",
          {
            accountId: ana.mailboxId,
            "#ids": { resultOf: "i", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "g",
        ],
      ]);

      expect(r("s").ids).toHaveLength(2);
      expect(r("g").list.map((e: JsonRecord) => e["subject"])).not.toContain("Re: Plan");
    });

    it("imported old mail counts retention and recycling from when it entered the account", async () => {
      await legacyFixture();
      await activate();
      const s = store(h, ana);
      s.ctx.sql.tx(() => s.ctx.putSetting("pref:recycling", { days: 30 }));

      const upload = async (subject: string, id: string) =>
        (
          await http(
            h,
            { ...bearer(ana), "content-type": "message/rfc822" },
            "POST",
            `/jmap/upload/${ana.mailboxId}`,
            message("old@example.org", ana.address, subject, id),
          )
        ).body.blobId as string;

      const r = await run(h, ana, [
        [
          "Email/import",
          {
            accountId: ana.mailboxId,
            emails: {
              a: {
                blobId: await upload("Archive 2023", "a1@example.org"),
                mailboxIds: { inbox: true },
                receivedAt: "2023-01-02T03:04:05Z",
              },
              t: {
                blobId: await upload("Old trash", "t1@example.org"),
                mailboxIds: { trash: true },
                receivedAt: "2023-01-02T03:04:05Z",
              },
            },
          },
          "i",
        ],
      ]);

      const ids = [r("i").created.a.id, r("i").created.t.id] as Array<string>;
      await h.namespaces.MAILBOXES.instance(ana.mailboxId).reconcile(Date.now());

      for (const id of ids)
        expect(
          s.ctx.sql.one("SELECT 1 AS x FROM jmap_emails WHERE email_id = ?", id),
        ).toBeDefined();
    });

    it("forwarding waits on, and refuses, a migrated Email's scan verdict", async () => {
      await legacyFixture();
      await activate();
      const sql = store(h, ana).ctx.sql;
      const instance = h.namespaces.MAILBOXES.instance(ana.mailboxId);

      const { email_id: id, r2_key: key } = sql.one<{ email_id: string; r2_key: string }>(
        "SELECT e.email_id, b.r2_key FROM jmap_emails e JOIN jmap_blobs b ON b.blob_id = e.blob_id LIMIT 1",
      )!;

      sql.run("UPDATE jmap_emails SET scan_status = 'pending' WHERE email_id = ?", id);
      expect(await instance.scanStatusForMessageKey(key)).toBe("pending");
      sql.run("UPDATE jmap_emails SET quarantined = 1 WHERE email_id = ?", id);
      expect(await instance.scanStatusForMessageKey(key)).toBe("infected");
    });

    it("a migrated account exports its current mail, not the frozen legacy rows", async () => {
      await legacyFixture();
      await activate();
      await deliver(
        h,
        message("carol@example.net", ana.address, "After cutover", "ac1@example.net"),
        "carol@example.net",
        ana.address,
      );

      const page = await h.namespaces.MAILBOXES.instance(ana.mailboxId).exportManifestPage(
        null,
        100,
      );

      const emails = store(h, ana)
        .ctx.sql.all<{ email_id: string }>("SELECT email_id FROM jmap_emails")
        .map((r) => r.email_id);

      expect(page.deliveries.map((d) => d.deliveryId).sort()).toEqual([...emails].sort());
      expect(page.nextCursor).toBeNull();
    });

    it("submission and draft changes are per principal; a partial view refreshes instead", async () => {
      await legacyFixture();
      await activate();
      hosted();
      store(h, ana).jmap.core.applyGrant(bob.userId, "*", FULL_RIGHTS);
      await h.env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT org_id, ?, 'member', 'active', ?, ? FROM mailboxes WHERE id = ?`,
      )
        .bind(bob.userId, Date.now(), Date.now(), ana.mailboxId)
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
        .bind(ana.mailboxId, bob.userId, Date.now())
        .run();

      const states = async (a: Account) =>
        await run(h, a, [
          ["EmailSubmission/get", { accountId: ana.mailboxId, ids: [] }, "s"],
          ["DraftSession/get", { accountId: ana.mailboxId, ids: [] }, "d"],
        ]);

      const before = await states(bob);

      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                subject: "Mine",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId: identity.id, emailId: "#d" } } },
          "s",
        ],
        [
          "DraftSession/set",
          { accountId: ana.mailboxId, create: { n: { headEmailId: "#d" } } },
          "n",
        ],
      ]);

      const after = await states(bob);

      expect(after("s").state).toBe(before("s").state);
      expect(after("d").state).toBe(before("d").state);

      const changes = await run(h, bob, [
        [
          "EmailSubmission/changes",
          { accountId: ana.mailboxId, sinceState: before("s").state },
          "c",
        ],
      ]);

      expect(changes("c")).toMatchObject({ created: [], updated: [], destroyed: [] });

      // A principal that can read only some Mailboxes refreshes Email state from /get and /query.
      store(h, ana).jmap.core.applyGrant(bob.userId, "*", null);
      store(h, ana).jmap.core.applyGrant(bob.userId, "inbox", FULL_RIGHTS);

      const partial = await run(h, bob, [
        ["Email/get", { accountId: ana.mailboxId, ids: [] }, "g"],
      ]);

      const refused = await run(h, bob, [
        ["Email/changes", { accountId: ana.mailboxId, sinceState: partial("g").state }, "c"],
      ]);

      expect(refused("c")).toMatchObject({ name: "error", type: "cannotCalculateChanges" });
    });

    const shareWithBob = async () => {
      await h.env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT org_id, ?, 'member', 'active', ?, ? FROM mailboxes WHERE id = ?`,
      )
        .bind(bob.userId, Date.now(), Date.now(), ana.mailboxId)
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
        .bind(ana.mailboxId, bob.userId, Date.now())
        .run();
    };

    const unshareBob = () =>
      h.env.DIRECTORY.prepare("DELETE FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?")
        .bind(ana.mailboxId, bob.userId)
        .run();

    it("a member removed mid-migration gets no grant at activation", async () => {
      await legacyFixture();
      await shareWithBob();
      expect((await migrate(h, ana.mailboxId, "step")).body.mode).toBe("backfilling");
      await unshareBob();

      const synced = await http(
        h,
        { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        "POST",
        "/v1/ops/jmap/grants",
        JSON.stringify({ mailboxId: ana.mailboxId }),
      );

      expect(synced.body).toMatchObject({ committed: true, outcome: "recorded" });
      await activate();
      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(false);
      expect(store(h, ana).jmap.core.hasAnyGrant(ana.userId)).toBe(true);
    });

    it("an older directory read never overrides a newer one; a newer request keeps its mark", async () => {
      await legacyFixture();
      await activate();

      const instance = mockAs<{
        jmapSyncGrants: (e: ReadonlyArray<JsonRecord>, readAt: number) => { outcome: string };
      }>(h.namespaces.MAILBOXES.instance(ana.mailboxId));

      const owner = { principalId: ana.userId, canSend: true };

      expect(instance.jmapSyncGrants([owner], Date.now() + 2000).outcome).toBe("committed");
      expect(
        instance.jmapSyncGrants(
          [owner, { principalId: bob.userId, canSend: true }],
          Date.now() + 1000,
        ).outcome,
      ).toBe("stale");
      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(false);

      await h.env.DIRECTORY.prepare(
        "INSERT INTO jmap_grant_sync (mailbox_id, requested_at, next_at) VALUES (?, ?, 0)",
      )
        .bind(ana.mailboxId, Date.now() + 3600_000)
        .run();

      // The request is newer than this sync's read: its mark stays for the cron.
      await syncMailboxGrants(h.env, ana.mailboxId);
      expect(
        await h.env.DIRECTORY.prepare("SELECT 1 AS x FROM jmap_grant_sync").first(),
      ).not.toBeNull();
    });

    it("a reconciliation never lifts a hold a newer restore re-armed", async () => {
      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 1000);
      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 2000);
      await liftDispatchHold(h.env, ana.mailboxId, 1000);

      expect(await dispatchHeldAt(h.env, ana.mailboxId)).toBe(2000);
      await liftDispatchHold(h.env, ana.mailboxId, 2000);
      expect(await dispatchHeldAt(h.env, ana.mailboxId)).toBeNull();
    });

    it("recycling takes whole unprotected threads and keeps flagged or noted ones", async () => {
      await legacyFixture();
      await activate();
      const s = store(h, ana);
      s.ctx.sql.tx(() => s.ctx.putSetting("pref:recycling", { days: 30 }));

      const [digest] = (
        await run(h, ana, [
          ["Email/query", { accountId: ana.mailboxId, filter: { inMailbox: "feed" } }, "q"],
        ])
      )("q").ids as Array<string>;

      const legacyThread = s.ctx.sql.one<{ thread_id: string }>(
        "SELECT d.thread_id FROM jmap_emails e JOIN deliveries d ON d.delivery_id = e.legacy_delivery_id WHERE e.email_id = ?",
        digest,
      )!.thread_id;

      const exists = () =>
        s.ctx.sql.one("SELECT 1 AS x FROM jmap_emails WHERE email_id = ?", digest) !== undefined;

      const later = Date.now() + 60 * 24 * 3600_000;
      const instance = h.namespaces.MAILBOXES.instance(ana.mailboxId);

      // A note on its legacy thread protects it, as in legacy recycling.
      s.ctx.sql.run(
        "INSERT INTO notes (note_id, kind, thread_id, body, file_keys, revision, updated_at) VALUES ('nte_1', 'thread', ?, 'keep', '[]', 1, 0)",
        legacyThread,
      );
      await instance.reconcile(later);
      expect(exists()).toBe(true);

      s.ctx.sql.run("DELETE FROM notes WHERE note_id = 'nte_1'");
      s.ctx.sql.run("INSERT INTO jmap_keywords (email_id, keyword) VALUES (?, '$flagged')", digest);
      await instance.reconcile(later);
      expect(exists()).toBe(true);

      s.ctx.sql.run(
        "DELETE FROM jmap_keywords WHERE email_id = ? AND keyword = '$flagged'",
        digest,
      );
      await instance.reconcile(later);
      expect(exists()).toBe(false);

      // The labeled Lunch thread stays whole.
      expect(await query("inbox")).toHaveLength(2);
    });

    it("a submission from before creators were recorded moves its managers' state", async () => {
      await legacyFixture();
      await activate();
      hosted();
      const sql = store(h, ana).ctx.sql;

      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const created = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                subject: "Old",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            create: {
              s: {
                identityId: identity.id,
                emailId: "#d",
                envelope: {
                  mailFrom: { email: ana.address, parameters: { HOLDFOR: "3600" } },
                  rcptTo: [{ email: "carol@example.net" }],
                },
              },
            },
          },
          "s",
        ],
      ]);

      const id = created("s").created.s.id as string;
      sql.run("UPDATE jmap_submissions SET principal_id = NULL WHERE submission_id = ?", id);

      const before = (
        await run(h, ana, [["EmailSubmission/get", { accountId: ana.mailboxId, ids: [id] }, "g"]])
      )("g");

      expect(before.list).toHaveLength(1);

      const job = sql.one<{ send_job_id: string }>(
        "SELECT send_job_id FROM jmap_submissions WHERE submission_id = ?",
        id,
      )!.send_job_id;

      await mockAs<{ execute: (c: JsonRecord) => Promise<JsonRecord> }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      ).execute({ _tag: "CancelSend", commandId: "cmd_cancel_legacy_submission1", sendJobId: job });

      const after = await run(h, ana, [
        ["EmailSubmission/changes", { accountId: ana.mailboxId, sinceState: before.state }, "c"],
      ]);

      expect(after("c").updated).toContain(id);
      expect(() => store(h, ana).jmap.core.state("EmailSubmission")).toThrow();
    });

    it("grant changes that didn't propagate converge from the cron", async () => {
      await legacyFixture();
      await activate();
      await h.env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT org_id, ?, 'member', 'active', ?, ? FROM mailboxes WHERE id = ?`,
      )
        .bind(bob.userId, Date.now(), Date.now(), ana.mailboxId)
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
        .bind(ana.mailboxId, bob.userId, Date.now())
        .run();
      await h.env.DIRECTORY.prepare(
        "INSERT INTO jmap_grant_sync (mailbox_id, requested_at, next_at) VALUES (?, 0, 0)",
      )
        .bind(ana.mailboxId)
        .run();

      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(false);
      expect(await convergeGrants(h.env)).toEqual({ converged: 1, failed: 0 });
      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(true);
      expect(
        await h.env.DIRECTORY.prepare("SELECT 1 AS x FROM jmap_grant_sync").first(),
      ).toBeNull();
    });

    it("a repeated dispatch hold restarts its clock", async () => {
      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 1000);
      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 9_000_000);

      expect(await restoreHolds(h.env, 9_000_000 + 60_000, 10 * 60_000)).toEqual([]);
    });

    it("aborting a migration releases only the bytes the migration wrote", async () => {
      await legacyFixture();
      const sent = h.queues.PROPAGATE.sends.length;

      expect((await migrate(h, ana.mailboxId, "start")).body.mode).toBe("verifying");
      expect((await migrate(h, ana.mailboxId, "abort")).body.mode).toBe("legacy");
      await h.settle();

      const released = h.queues.PROPAGATE.sends
        .slice(sent)
        .map((m) => m.body as JsonRecord)
        .filter((b) => b["topic"] === "blob-gc")
        .map((b) => (b["payload"] as { readonly key: string }).key);

      expect(released.length).toBeGreaterThan(0);
      expect(released.every((k) => k.includes("/jmap/"))).toBe(true);
      expect(
        store(h, ana).ctx.sql.one("SELECT 1 AS x FROM jmap_blobs WHERE r2_key NOT LIKE '%/jmap/%'"),
      ).toBeUndefined();
    });

    it("a restore hold whose reconciliation failed is retried, registering ambiguous sends", async () => {
      await legacyFixture();
      await activate();
      hosted();
      const s = store(h, ana);

      const { draftId } = s.ctx.sql.tx(() =>
        s.drafts.createDraft({
          content: {
            to: [{ name: undefined, address: "erin@example.org" }],
            cc: [],
            bcc: [],
            subject: "Held",
            text: "x",
            attachments: [],
          },
        }),
      );

      const job = (
        s.ctx.sql.tx(() =>
          s.sends.send(draftId, { expectedRevision: 1, sendAt: Date.now() + 3600_000 }),
        ) as { sendJobIds: ReadonlyArray<string> }
      ).sendJobIds[0]!;

      await h.env.DIRECTORY.batch([
        h.env.DIRECTORY.prepare(
          "INSERT INTO dispatch_holds (mailbox_id, reason, created_at) VALUES (?, ?, 0)",
        ).bind(ana.mailboxId, RESTORE_HOLD_REASON),
        h.env.DIRECTORY.prepare(
          "INSERT INTO send_attempts (mailbox_id, send_job_id, attempt, recorded_at) VALUES (?, ?, 1, 0)",
        ).bind(ana.mailboxId, job),
      ]);

      expect(await reconcileRestoreHolds(h.env)).toEqual({ reconciled: 1, failed: 0 });
      expect(s.sends.job(job)?.state).toBe("unknown");
      expect(
        await h.env.DIRECTORY.prepare("SELECT 1 AS x FROM dispatch_holds WHERE mailbox_id = ?")
          .bind(ana.mailboxId)
          .first(),
      ).toBeNull();
      expect(
        await h.env.DIRECTORY.prepare("SELECT 1 AS x FROM send_unknowns WHERE send_job_id = ?")
          .bind(job)
          .first(),
      ).not.toBeNull();
    });

    it("a restore that fails before arming puts back the earlier restore's hold", async () => {
      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 1000);
      await armDispatchHold(h.env, ana.mailboxId, 1000, "epoch-1");
      const prior = await dispatchHold(h.env, ana.mailboxId);

      const heldAt = await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 2000);
      await revertDispatchHold(h.env, ana.mailboxId, heldAt, prior);

      expect(await dispatchHold(h.env, ana.mailboxId)).toEqual({
        reason: RESTORE_HOLD_REASON,
        createdAt: 1000,
        armedEpoch: "epoch-1",
      });
    });

    it("the restore-hold sweep waits until the object restarted from its armed epoch", async () => {
      const instance = mockAs<{ sessionEpoch: () => string }>(
        h.namespaces.MAILBOXES.instance(ana.mailboxId),
      );

      await holdDispatch(h.env, ana.mailboxId, RESTORE_HOLD_REASON, 0);
      await armDispatchHold(h.env, ana.mailboxId, 0, instance.sessionEpoch());

      expect(await reconcileRestoreHolds(h.env)).toEqual({ reconciled: 0, failed: 0 });
      expect(await dispatchHeldAt(h.env, ana.mailboxId)).toBe(0);

      await armDispatchHold(h.env, ana.mailboxId, 0, "before-restart");
      expect(await reconcileRestoreHolds(h.env)).toEqual({ reconciled: 1, failed: 0 });
      expect(await dispatchHeldAt(h.env, ana.mailboxId)).toBeNull();
    });

    it("recycling never splits a thread across batches", async () => {
      await legacyFixture();
      await activate();
      const s = store(h, ana);
      const core = s.jmap.core;
      const inbox = core.roleMailbox("inbox")!;

      // Every thread becomes recyclable: only Inbox, nothing flagged or noted.
      s.ctx.sql.run("DELETE FROM jmap_memberships");
      s.ctx.sql.run(
        "INSERT INTO jmap_memberships (email_id, mailbox_id, added_at) SELECT email_id, ?, 0 FROM jmap_emails",
        inbox,
      );
      s.ctx.sql.run("DELETE FROM jmap_keywords");
      s.ctx.sql.run("UPDATE jmap_emails SET legacy_delivery_id = NULL");
      s.ctx.sql.run("DELETE FROM jmap_meta WHERE key = 'retentionFrom'");

      const sizes = () =>
        new Map(
          s.ctx.sql
            .all<{ thread_id: string; n: number }>(
              "SELECT thread_id, COUNT(*) AS n FROM jmap_emails GROUP BY thread_id",
            )
            .map((r) => [r.thread_id, Number(r.n)]),
        );

      const before = sizes();

      expect([...before.values()].some((n) => n > 1)).toBe(true);

      for (let i = 0; i < 20 && sizes().size > 0; i++) {
        core.sweepRetention(Date.now() + 60 * 24 * 3600_000, 30, 1);

        for (const [thread, n] of sizes()) expect(n, thread).toBe(before.get(thread));
      }

      expect(sizes().size).toBe(0);
    });

    it("moving mail into Trash needs the delete scope", async () => {
      await legacyFixture();
      await activate();

      const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));

      const token = async (scopes: ReadonlyArray<string>) => ({
        ...ana,
        token: (
          await auth.createApiToken(ana.userId, {
            kind: "agent",
            label: scopes.join(" "),
            scopes: scopes as never,
          })
        ).token,
      });

      const accountId = ana.mailboxId;
      const trash = store(h, ana).jmap.core.roleMailbox("trash")!;
      const [mail] = (await query("feed")).map((e) => e["id"] as string);

      const screen = await token(["read", "screen"]);

      const refused = await run(h, screen, [
        ["Email/set", { accountId, update: { [mail!]: { [`mailboxIds/${trash}`]: true } } }, "u"],
        [
          "EmailAction/apply",
          {
            accountId,
            emails: { [mail!]: null },
            action: { type: "move", from: ["feed"], to: trash },
          },
          "m",
        ],
      ]);

      expect(refused("u")).toMatchObject({ notUpdated: { [mail!]: { type: "forbidden" } } });
      expect(JSON.stringify(refused("m"))).toContain("forbidden");

      const allowed = await run(h, await token(["read", "screen", "delete"]), [
        ["Email/set", { accountId, update: { [mail!]: { [`mailboxIds/${trash}`]: true } } }, "u"],
      ]);

      expect(allowed("u")).toMatchObject({ updated: { [mail!]: null } });
    });

    it("an aborted migration's grants don't survive into the retry", async () => {
      await legacyFixture();
      await shareWithBob();
      expect((await migrate(h, ana.mailboxId, "start")).body.mode).toBe("verifying");
      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(true);

      expect((await migrate(h, ana.mailboxId, "abort")).body.mode).toBe("legacy");
      expect(store(h, ana).ctx.sql.one("SELECT 1 AS x FROM jmap_grants")).toBeUndefined();

      await unshareBob();
      await activate();
      expect(store(h, ana).jmap.core.hasAnyGrant(bob.userId)).toBe(false);
      expect(store(h, ana).jmap.core.hasAnyGrant(ana.userId)).toBe(true);
    });

    it("onSuccessDestroyEmail follows a submission destroyed in the same call", async () => {
      await legacyFixture();
      await activate();
      hosted();

      const identity = (await run(h, ana, [["Identity/get", { accountId: ana.mailboxId }, "i"]]))(
        "i",
      ).list[0];

      const r = await run(h, ana, [
        [
          "Email/set",
          {
            accountId: ana.mailboxId,
            create: {
              d: {
                mailboxIds: { drafts: true },
                keywords: { $draft: true },
                from: [{ email: ana.address }],
                to: [{ email: "carol@example.net" }],
                subject: "Sent then tidied",
                bodyValues: { t: { value: "x" } },
                textBody: [{ partId: "t" }],
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          { accountId: ana.mailboxId, create: { s: { identityId: identity.id, emailId: "#d" } } },
          "sub",
        ],
      ]);

      const emailId = r("e").created.d.id;
      const submissionId = r("sub").created.s.id;
      await h.drain();

      const out = await run(h, ana, [
        [
          "EmailSubmission/set",
          {
            accountId: ana.mailboxId,
            destroy: [submissionId],
            onSuccessDestroyEmail: [submissionId],
          },
          "x",
        ],
        ["Email/get", { accountId: ana.mailboxId, ids: [emailId] }, "g"],
      ]);

      expect(out("x").destroyed).toEqual([submissionId]);
      expect(out("x", 1)).toMatchObject({ name: "Email/set", destroyed: [emailId] });
      expect(out("g").notFound).toEqual([emailId]);
    });

    it("content stored again while blob GC deletes it is refused until the delete finished", async () => {
      await legacyFixture();
      await activate();
      const core = store(h, ana).jmap.core;
      const r2Key = `t/${ana.mailboxId}/jmap/up/${"a".repeat(64)}`;

      const blob = {
        blobId: `U${"a".repeat(40)}`,
        bucket: "parts" as const,
        r2Key,
        size: 1,
        type: "text/plain",
        expiresAt: null,
      };

      expect(core.claimGc(r2Key)).toBe(true);
      expect(() => core.registerBlob(blob)).toThrow(BlobCollecting);

      core.releaseGc(r2Key);
      core.registerBlob(blob);
      // Now referenced: the next sweep can't claim it.
      expect(core.claimGc(r2Key)).toBe(false);
    });
  });

  describe("credential scopes (A3)", () => {
    it("needs the legacy command's scope for each JMAP write; draft-only credentials destroy only drafts", async () => {
      await legacyFixture();
      await activate();

      const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));

      const narrow = {
        ...ana,
        token: (
          await auth.createApiToken(ana.userId, {
            kind: "agent",
            label: "narrow",
            scopes: ["read", "draft"],
          })
        ).token,
      };

      const accountId = ana.mailboxId;

      const all = await run(h, ana, [
        ["Email/query", { accountId }, "q"],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["keywords"],
          },
          "g",
        ],
      ]);

      const emails = all("g")!.list as Array<{ id: string; keywords: Record<string, boolean> }>;
      const draft = emails.find((e) => e.keywords["$draft"])!.id;
      const mail = emails.find((e) => !e.keywords["$draft"])!.id;
      // Scopes are checked before any lookup, so no real identity is needed.
      const identityId = "idn_placeholder";

      const refused = await run(h, narrow, [
        ["EmailSubmission/set", { accountId, create: { s: { identityId, emailId: draft } } }, "s"],
        ["Email/set", { accountId, update: { [mail]: { "keywords/$flagged": true } } }, "u"],
        ["EmailAction/apply", { accountId, emails: {}, action: { type: "emptyTrash" } }, "e"],
        ["Identity/set", { accountId, update: { [identityId]: { name: "x" } } }, "a"],
      ]);

      for (const id of ["s", "u", "e", "a"])
        expect(refused(id), id).toMatchObject({ name: "error", type: "forbidden" });

      const destroyed = await run(h, narrow, [
        ["Email/set", { accountId, destroy: [mail, draft] }, "d"],
      ]);

      expect(destroyed("d")).toMatchObject({
        destroyed: [draft],
        notDestroyed: { [mail]: { type: "forbidden" } },
      });
    });
  });
});
