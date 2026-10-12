import { Predicate, type Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BYE, CORE, MAIL, SUBMISSION, VACATION_RESPONSE } from "@bye/jmap";
import { prepareEmail } from "@bye/mail-codec";
import { FULL_RIGHTS, type PreparedCall, type PreparedContent } from "@bye/platform-cloudflare";
import { deliveryFixture, makeTestMailbox, summaryFixture } from "@bye/testing";

// Account-level JMAP calls against a real store (spec.md §16 D1 T02–T05): the per-object
// validation, rights and error branches every write path must report precisely.

const USING = [CORE, MAIL, SUBMISSION, VACATION_RESPONSE, BYE];

const PRINCIPAL = "usr_owner";

const raw = (input: {
  readonly from?: string;
  readonly subject: string;
  readonly id: string;
  readonly extra?: ReadonlyArray<string>;
}) =>
  [
    `From: ${input.from ?? "Me <me@bye.test>"}`,
    "To: carol@example.net, Dan <dan@example.net>",
    "Reply-To: replies@example.net",
    "List-Unsubscribe: <https://example.net/u>, <mailto:u@example.net>",
    `Subject: ${input.subject}`,
    "Date: Mon, 12 Oct 2026 12:00:00 +0000",
    `Message-ID: <${input.id}>`,
    ...(input.extra ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body text for search",
    "",
  ].join("\r\n");

let blobs = 0;

const content = (text: string): PreparedContent => ({
  blobId: `b${++blobs}`,
  bucket: "originals",
  r2Key: `k/${blobs}`,
  type: "message/rfc822",
  email: prepareEmail(new TextEncoder().encode(text)),
});

const setup = (active = true) => {
  const t = makeTestMailbox();
  const account = t.store.jmap;

  if (active) {
    account.core.ensureDefaults();
    account.core.applyGrant(PRINCIPAL, "*", FULL_RIGHTS);
    account.core.putMeta("mode", "jmap");
  }

  const created: Array<readonly [string, string]> = [];

  const call = (
    name: string,
    args: Schema.JsonObject,
    prepared?: PreparedCall,
    principalId = PRINCIPAL,
  ): Schema.JsonObject & { readonly name: string } => {
    const input = {
      principalId,
      accountId: t.mailboxId,
      restoreGeneration: 0,
      name,
      args: Object.fromEntries([["accountId", t.mailboxId], ...Object.entries(args)]),
      using: USING,
      createdIds: created,
      callId: "c",
    };

    const out = account.call(prepared ? { ...input, prepared } : input);

    for (const [cid, id] of Object.entries(out.createdIds)) created.push([cid, id]);
    const first = out.responses[0]!;

    return Object.assign(Object.fromEntries(Object.entries(first.args)), { name: first.name });
  };

  const email = (
    text: string,
    mailboxIds: Schema.JsonObject = { inbox: true },
    keywords: Schema.JsonObject = {},
  ) => {
    const r = call(
      "Email/set",
      { create: { e: { mailboxIds, keywords } } },
      { emails: [["e", content(text)]], submissions: [] },
    );

    const id = (r["created"] as Schema.JsonObject | null)?.["e"];

    if (!Predicate.isObject(id)) throw new Error(JSON.stringify(r));

    return createdId(r, "e");
  };

  return { ...t, account, call, email };
};

/** The server-assigned ID of creation `cid` in a /set response. */
const createdId = (r: Schema.JsonObject, cid: string): string => {
  const created = r["created"];
  const entry = Predicate.isObject(created) ? (created as Schema.JsonObject)[cid] : undefined;
  const id = Predicate.isObject(entry) ? (entry as Schema.JsonObject)["id"] : undefined;

  if (!Predicate.isString(id)) throw new Error(`no created ${cid}: ${JSON.stringify(r)}`);

  return id;
};

const errorType = (r: Schema.JsonObject, map: string, key: string) =>
  ((r[map] as Schema.JsonObject | null)?.[key] as Schema.JsonObject | undefined)?.["type"];

describe("Mailbox/set validation", () => {
  it("reports each invalid creation and update precisely", () => {
    const { call } = setup();

    const r = call("Mailbox/set", {
      create: {
        noName: {},
        bad: { name: "x", color: "red" },
        badParent: { name: "x", parentId: "nope" },
        badRole: { name: "x", role: "nope" },
        takenRole: { name: "x", role: "inbox" },
        badOrder: { name: "x", sortOrder: -1 },
        ok: { name: "Parent", isSubscribed: false },
        child: { name: "Child", parentId: "#ok" },
      },
    });

    expect(errorType(r, "notCreated", "noName")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "bad")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "badParent")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "badRole")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "takenRole")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "badOrder")).toBe("invalidProperties");
    const parent = createdId(r, "ok");
    const child = createdId(r, "child");

    const u = call("Mailbox/set", {
      update: {
        nope: { name: "x" },
        [parent]: { "name/x": 1 },
        [child]: { parentId: child },
        archive: { role: "inbox" },
        trash: { sortOrder: "x" },
        drafts: { isSubscribed: "x" },
        sent: { name: "" },
        feed: { role: "nope" },
        junk: { totalEmails: 3 },
      },
      destroy: [parent],
    });

    for (const id of ["nope"]) expect(errorType(u, "notUpdated", id)).toBe("notFound");
    expect(errorType(u, "notUpdated", parent)).toBe("invalidPatch");

    for (const id of [child, "archive", "trash", "drafts", "sent", "feed", "junk"])
      expect(errorType(u, "notUpdated", id), id).toBe("invalidProperties");
    expect(errorType(u, "notDestroyed", parent)).toBe("mailboxHasChild");

    const moved = call("Mailbox/set", { update: { [child]: { parentId: null, role: "archive" } } });
    expect(errorType(moved, "notUpdated", child)).toBe("invalidProperties");
    expect(
      call("Mailbox/set", { update: { [child]: { parentId: null, sortOrder: 5 } } })["updated"],
    ).toEqual({ [child]: null });
    expect(call("Mailbox/get", { ids: [parent], properties: ["isSubscribed"] })["list"]).toEqual([
      { id: parent, isSubscribed: false },
    ]);
    expect(call("Mailbox/set", { ifInState: "garbage", create: {} })).toMatchObject({
      name: "error",
      type: "stateMismatch",
    });
  });

  it("deleting a workflow target disables routing to it and timers that pointed there", () => {
    const { call, account, email, clock } = setup();
    const id = email(raw({ subject: "t", id: "t@x" }));

    const armed = call("EmailAction/apply", {
      emails: { [id]: null },
      action: { type: "move", from: ["inbox"], to: "feed" },
      at: new Date(clock.now() + 60_000).toISOString(),
    });

    expect(armed["timerId"]).toEqual(expect.any(String));

    expect(call("Mailbox/set", { destroy: ["feed"] })["destroyed"]).toEqual(["feed"]);
    expect(account.core.workflowTargets().feed).toBeUndefined();

    const timer = account.core.sql.one<{ state: string; reason: string }>(
      "SELECT state, reason FROM jmap_timers",
    );

    expect(timer).toMatchObject({ state: "disabled", reason: expect.stringContaining("feed") });
  });
});

describe("Email reads and writes", () => {
  it("serves header forms, parsed fields and body structure", () => {
    const { call, email } = setup();

    const id = email(
      raw({ subject: "Forms", id: "forms@x", extra: ["X-Multi: one", "X-Multi: two"] }),
    );

    const g = call("Email/get", {
      ids: [id, "missing"],
      properties: [
        "sender",
        "replyTo",
        "headers",
        "bodyStructure",
        "header:To:asAddresses",
        "header:To:asGroupedAddresses",
        "header:Message-ID:asMessageIds",
        "header:Date:asDate",
        "header:List-Unsubscribe:asURLs",
        "header:Subject:asText",
        "header:X-Multi:all",
        "header:X-Missing",
        "header:X-Missing:asMessageIds",
        "header:X-Missing:asURLs",
      ],
    });

    const e = (g["list"] as Array<Schema.JsonObject>)[0]!;
    expect(g["notFound"]).toEqual(["missing"]);
    expect(e).toMatchObject({
      sender: null,
      replyTo: [{ name: null, email: "replies@example.net" }],
      "header:To:asAddresses": [
        { name: null, email: "carol@example.net" },
        { name: "Dan", email: "dan@example.net" },
      ],
      "header:Message-ID:asMessageIds": ["forms@x"],
      "header:Date:asDate": "2026-10-12T12:00:00Z",
      "header:List-Unsubscribe:asURLs": ["https://example.net/u", "mailto:u@example.net"],
      "header:Subject:asText": "Forms",
      "header:X-Multi:all": [" one", " two"],
      "header:X-Missing": null,
      "header:X-Missing:asMessageIds": null,
      "header:X-Missing:asURLs": null,
      bodyStructure: { partId: "1", type: "text/plain" },
    });
    expect(call("Email/get", { ids: [id], properties: ["nope"] })).toMatchObject({
      type: "invalidArguments",
    });
  });

  it("evaluates every filter condition and sort", () => {
    const { call, email } = setup();

    const a = email(
      raw({ subject: "Alpha report", id: "a@x" }),
      { inbox: true },
      { $flagged: true },
    );

    const b = email(
      raw({ subject: "Beta", id: "b@x", from: "zed@example.org" }),
      { archive: true },
      { $seen: true },
    );

    const q = (filter: Schema.JsonObject | null, extra: Schema.JsonObject = {}) =>
      call("Email/query", Object.fromEntries([["filter", filter], ...Object.entries(extra)]))[
        "ids"
      ];

    expect(q({ inMailboxOtherThan: ["inbox"] })).toEqual([b]);
    expect(q({ inMailboxOtherThan: [] })).toEqual(expect.arrayContaining([a, b]));
    expect(q({ hasKeyword: "$flagged" })).toEqual([a]);
    expect(q({ notKeyword: "$seen" })).toEqual([a]);
    expect(q({ allInThreadHaveKeyword: "$seen" })).toEqual([b]);
    expect(q({ someInThreadHaveKeyword: "$flagged" })).toEqual([a]);
    expect(q({ noneInThreadHaveKeyword: "$flagged" })).toEqual([b]);
    expect(q({ from: "zed" })).toEqual([b]);
    expect(q({ cc: "nobody" })).toEqual([]);
    expect(q({ bcc: "nobody" })).toEqual([]);
    expect(q({ subject: "alpha" })).toEqual([a]);
    expect(q({ header: ["Reply-To"] })).toEqual(expect.arrayContaining([a, b]));
    expect(q({ header: ["Reply-To", "nomatch"] })).toEqual([]);
    expect(q({ text: "!!!" })).toEqual(expect.arrayContaining([a, b]));
    expect(
      q({
        before: "2100-01-01T00:00:00Z",
        after: "2000-01-01T00:00:00Z",
        minSize: 1,
        maxSize: 100000,
      }),
    ).toHaveLength(2);
    expect(q({ hasAttachment: false })).toHaveLength(2);
    expect(q({ operator: "OR", conditions: [] })).toEqual([]);
    expect(q({ operator: "AND", conditions: [] })).toHaveLength(2);

    for (const property of ["sentAt", "size", "subject", "from", "to"])
      expect(q(null, { sort: [{ property, isAscending: false }] })).toHaveLength(2);
    expect(
      q(null, {
        sort: [{ property: "hasKeyword", keyword: "$flagged", isAscending: false }],
        collapseThreads: true,
      }),
    ).toEqual([a, b]);
    expect(
      call("Email/query", { anchor: b, anchorOffset: -1, calculateTotal: true }),
    ).toMatchObject({ total: 2, position: 0 });
    expect(call("Email/query", { anchor: "nope" })).toMatchObject({ type: "anchorNotFound" });
    expect(call("Email/query", { position: -1, limit: 1, calculateTotal: true })).toMatchObject({
      position: 1,
      total: 2,
    });
    expect(call("Email/query", { limit: 5000 })).toMatchObject({ limit: 500 });
  });

  it("rejects invalid creations and updates per object", () => {
    const { call, email } = setup();
    const id = email(raw({ subject: "x", id: "x@x" }));

    const prepared: PreparedCall = {
      emails: [
        ["k", content(raw({ subject: "k", id: "k@x" }))],
        ["m", content(raw({ subject: "m", id: "m@x" }))],
        ["n", content(raw({ subject: "n", id: "n@x" }))],
      ],
      submissions: [],
    };

    const r = call(
      "Email/set",
      {
        create: {
          k: { mailboxIds: { inbox: true }, keywords: { "bad keyword": true } },
          m: { mailboxIds: {} },
          n: { mailboxIds: { nope: true } },
          unprepared: { mailboxIds: { inbox: true } },
        },
        update: { [id]: { "keywords/a/b": true }, nope: { "keywords/$seen": true } },
        destroy: ["nope"],
      },
      prepared,
    );

    expect(errorType(r, "notCreated", "k")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "m")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "n")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "unprepared")).toBe("invalidProperties");
    expect(errorType(r, "notUpdated", id)).toBe("invalidPatch");
    expect(errorType(r, "notUpdated", "nope")).toBe("notFound");
    expect(errorType(r, "notDestroyed", "nope")).toBe("notFound");
    expect(call("Email/set", { ifInState: "garbage", destroy: [] })).toMatchObject({
      type: "stateMismatch",
    });
    expect(call("Email/set", { bogus: 1 })).toMatchObject({ type: "invalidArguments" });
  });

  it("enforces per-Mailbox rights for a member", () => {
    const { call, email, account } = setup();
    const id = email(raw({ subject: "x", id: "x@x" }), { feed: true });
    account.core.applyGrant("usr_member", "feed", {
      ...FULL_RIGHTS,
      mayRemoveItems: false,
      maySetSeen: false,
    });

    const r = call(
      "Email/set",
      { update: { [id]: { "keywords/$seen": true } } },
      undefined,
      "usr_member",
    );

    expect(errorType(r, "notUpdated", id)).toBe("forbidden");

    const d = call("Email/set", { destroy: [id] }, undefined, "usr_member");
    expect(errorType(d, "notDestroyed", id)).toBe("forbidden");

    const m = call("Mailbox/set", { create: { x: { name: "x" } } }, undefined, "usr_member");
    expect(errorType(m, "notCreated", "x")).toBe("forbidden");
    expect(call("Mailbox/get", { ids: null }, undefined, "usr_nobody")).toMatchObject({
      type: "accountNotFound",
    });
  });
});

describe("native action failures (A1)", () => {
  it("names every refusal and acts on the rest", () => {
    const { call, email } = setup();
    const draft = email(raw({ subject: "d", id: "d@x" }), { drafts: true }, { $draft: true });
    const inbox = email(raw({ subject: "i", id: "i@x" }));

    const apply = (action: Schema.JsonObject, ids: ReadonlyArray<string>) =>
      call("EmailAction/apply", { emails: Object.fromEntries(ids.map((i) => [i, null])), action })[
        "results"
      ] as Schema.JsonObject;

    expect(apply({ type: "archive" }, [draft])[draft]).toEqual({
      ok: false,
      reason: "notArchivable",
    });
    expect(apply({ type: "move", from: [], to: "nope" }, [inbox])[inbox]).toEqual({
      ok: false,
      reason: "missingDestination",
    });
    expect(apply({ type: "restore", to: "nope" }, [inbox])[inbox]).toEqual({
      ok: false,
      reason: "missingDestination",
    });
    expect(apply({ type: "acceptScreener", to: "nope" }, [inbox])[inbox]).toEqual({
      ok: false,
      reason: "missingDestination",
    });
    expect(apply({ type: "spam" }, [inbox, "nope"])).toEqual({
      [inbox]: { ok: true },
      nope: { ok: false, reason: "notFound" },
    });
    expect(apply({ type: "acceptScreener", to: "inbox" }, [inbox])[inbox]).toEqual({ ok: true });
    expect(apply({ type: "emptyTrash" }, [])).toEqual({});
    expect(apply({ type: "trash" }, [inbox])[inbox]).toEqual({ ok: true });
    expect(apply({ type: "emptyTrash" }, [])).toEqual({ [inbox]: { ok: true } });
    expect(apply({ type: "destroy" }, [draft])[draft]).toEqual({ ok: true });
    expect(call("EmailAction/apply", { emails: {}, action: { type: "nope" } })).toMatchObject({
      type: "invalidArguments",
    });
    expect(
      call("EmailAction/apply", { emails: {}, action: { type: "archive" }, at: "nope" }),
    ).toMatchObject({ type: "invalidArguments" });
  });
});

describe("objects", () => {
  it("Identity, VacationResponse and Conversation validate and merge", () => {
    const { call, identityId } = setup();

    const i = call("Identity/set", {
      create: { x: { email: "x@x" } },
      update: {
        [identityId]: { name: "Me", textSignature: "--", htmlSignature: "", replyTo: null },
        nope: { name: "x" },
      },
      destroy: [identityId],
    });

    expect(i["updated"]).toEqual({ [identityId]: null });
    expect(errorType(i, "notCreated", "x")).toBe("forbidden");
    expect(errorType(i, "notUpdated", "nope")).toBe("notFound");
    expect(errorType(i, "notDestroyed", identityId)).toBe("forbidden");
    expect(
      errorType(
        call("Identity/set", { update: { [identityId]: { htmlSignature: "<b>" } } }),
        "notUpdated",
        identityId,
      ),
    ).toBe("invalidProperties");
    expect(
      errorType(
        call("Identity/set", { update: { [identityId]: { name: 5 } } }),
        "notUpdated",
        identityId,
      ),
    ).toBe("invalidProperties");

    const v = call("VacationResponse/set", {
      update: {
        singleton: { fromDate: "2026-10-20T00:00:00Z", toDate: "2026-10-10T00:00:00Z" },
        other: {},
      },
    });

    expect(errorType(v, "notUpdated", "singleton")).toBe("invalidProperties");
    expect(errorType(v, "notUpdated", "other")).toBe("notFound");

    const patches: ReadonlyArray<Schema.JsonObject> = [
      { isEnabled: "x" },
      { fromDate: "nope" },
      { htmlBody: "<b>" },
      { nope: 1 },
    ];

    for (const patch of patches)
      expect(
        errorType(
          call("VacationResponse/set", { update: { singleton: patch } }),
          "notUpdated",
          "singleton",
        ),
      ).toBe("invalidProperties");
    expect(
      call("VacationResponse/set", {
        update: { singleton: { subject: null, textBody: null, htmlBody: null, fromDate: null } },
      })["updated"],
    ).toEqual({ singleton: null });

    const c = call("Conversation/set", {
      create: {
        a: { title: "A", threadIds: ["t1"] },
        b: { threadIds: ["t2"] },
        bad: { threadIds: "x" },
      },
    });

    expect(errorType(c, "notCreated", "bad")).toBe("invalidProperties");
    const a = createdId(c, "a");
    const b = createdId(c, "b");

    const merged = call("Conversation/set", {
      update: { [b]: { mergeInto: a }, nope: { title: "x" } },
    });

    expect(merged["updated"]).toEqual({ [b]: null });
    expect(errorType(merged, "notUpdated", "nope")).toBe("notFound");
    expect(
      errorType(call("Conversation/set", { update: { [b]: { title: "x" } } }), "notUpdated", b),
    ).toBe("invalidPatch");
    expect(
      errorType(call("Conversation/set", { update: { [a]: { mergeInto: a } } }), "notUpdated", a),
    ).toBe("invalidProperties");
    expect(
      errorType(call("Conversation/set", { update: { [a]: { bad: 1 } } }), "notUpdated", a),
    ).toBe("invalidProperties");
    expect(
      call("Conversation/set", { update: { [a]: { title: null, threadIds: ["t1", "t3"] } } })[
        "updated"
      ],
    ).toEqual({ [a]: null });
    expect(call("Conversation/get", { ids: [a, b] })["list"]).toEqual([
      { id: a, title: null, threadIds: ["t1", "t3"], redirectTo: null },
      { id: b, title: null, threadIds: ["t2"], redirectTo: a },
    ]);
    expect(call("Conversation/set", { destroy: [b, "nope"] })).toMatchObject({
      destroyed: [b],
      notDestroyed: { nope: { type: "notFound" } },
    });
    expect(call("Conversation/get", { ids: ["nope"] })["notFound"]).toEqual(["nope"]);
  });

  it("DraftSession resolves conflicts, rejects bad patches and is principal-scoped", () => {
    const { call, email } = setup();
    const v1 = email(raw({ subject: "v1", id: "v1@x" }), { drafts: true }, { $draft: true });
    const v2 = email(raw({ subject: "v2", id: "v2@x" }), { drafts: true }, { $draft: true });

    const s = call("DraftSession/set", {
      create: { s: { headEmailId: v1 }, bad: { headEmailId: "nope" } },
    });

    expect(errorType(s, "notCreated", "bad")).toBe("invalidProperties");
    const sid = createdId(s, "s");

    // The head was edited independently: superseding it makes it a conflict, not cleanup.
    call("Email/set", { update: { [v1]: { "keywords/$flagged": true } } });
    expect(
      call("DraftSession/set", { update: { [sid]: { headEmailId: v2, ifVersion: 1 } } })["updated"],
    ).toEqual({ [sid]: { version: 2 } });
    const g = (call("DraftSession/get", { ids: [sid] })["list"] as Array<Schema.JsonObject>)[0];
    expect(g).toMatchObject({ headEmailId: v2, conflicts: [v1], pendingCleanup: [] });

    expect(call("DraftSession/set", { update: { [sid]: { conflicts: [] } } })["updated"]).toEqual({
      [sid]: null,
    });
    expect(
      errorType(
        call("DraftSession/set", { update: { [sid]: { conflicts: "x" } } }),
        "notUpdated",
        sid,
      ),
    ).toBe("invalidProperties");
    expect(
      errorType(
        call("DraftSession/set", { update: { [sid]: { headEmailId: v2 } } }),
        "notUpdated",
        sid,
      ),
    ).toBe("invalidProperties");
    expect(
      errorType(
        call("DraftSession/set", { update: { [sid]: { headEmailId: "nope", ifVersion: 2 } } }),
        "notUpdated",
        sid,
      ),
    ).toBe("invalidProperties");
    expect(call("DraftSession/get", { ids: null }, undefined, "usr_other")).toMatchObject({
      type: "accountNotFound",
    });
    expect(call("DraftSession/set", { destroy: [sid, "nope"] })).toMatchObject({
      destroyed: [sid],
      notDestroyed: { nope: { type: "notFound" } },
    });
  });

  it("EmailSubmission validates identity, envelope and intents; queries and destroys", () => {
    const { call, email, identityId, store } = setup();
    store.ctx.sql.run("UPDATE identities SET verified = 1");
    const id = email(raw({ subject: "s", id: "s@x" }), { drafts: true }, { $draft: true });

    const foreign = email(raw({ subject: "f", id: "f@x", from: "other@example.net" }), {
      drafts: true,
    });

    const pin = { blobId: "S1", r2Key: "k/s1", size: 10 };

    const prepared = (cids: ReadonlyArray<string>): PreparedCall => ({
      emails: [],
      submissions: cids.map((c) => [c, pin] as const),
    });

    const env = (
      rcpt: ReadonlyArray<string>,
      params: Schema.JsonObject | null = null,
      from = "me@bye.test",
    ) => ({
      mailFrom: { email: from, parameters: params },
      rcptTo: rcpt.map((email) => ({ email })),
    });

    const r = call(
      "EmailSubmission/set",
      {
        create: {
          unknownIdentity: { identityId: "nope", emailId: id },
          unknownEmail: { identityId, emailId: "nope" },
          foreignFrom: { identityId, emailId: foreign },
          mailFrom: { identityId, emailId: id, envelope: env(["a@x.test"], null, "x@x.test") },
          none: { identityId, emailId: id, envelope: env([]) },
          many: {
            identityId,
            emailId: id,
            envelope: env(Array.from({ length: 51 }, (_, i) => `r${i}@x.test`)),
          },
          invalid: { identityId, emailId: id, envelope: env(["not-an-address"]) },
          badEnvelope: { identityId, emailId: id, envelope: { nope: true } },
          badRelease: {
            identityId,
            emailId: id,
            envelope: env(["a@x.test"], { HOLDUNTIL: "1999-01-01T00:00:00Z" }),
          },
          extra: { identityId, emailId: id, bogus: 1 },
          unprepared: { identityId, emailId: id },
          later: {
            identityId,
            emailId: id,
            envelope: env(["a@x.test"], { HOLDUNTIL: "2026-10-01T00:00:00Z" }),
            byeIntentId: "i1",
          },
        },
      },
      prepared([
        "unknownIdentity",
        "unknownEmail",
        "foreignFrom",
        "mailFrom",
        "none",
        "many",
        "invalid",
        "badEnvelope",
        "badRelease",
        "extra",
        "later",
      ]),
    );

    expect(errorType(r, "notCreated", "unknownIdentity")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "unknownEmail")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "foreignFrom")).toBe("forbiddenFrom");
    expect(errorType(r, "notCreated", "mailFrom")).toBe("forbiddenMailFrom");
    expect(errorType(r, "notCreated", "none")).toBe("noRecipients");
    expect(errorType(r, "notCreated", "many")).toBe("tooManyRecipients");
    expect(errorType(r, "notCreated", "invalid")).toBe("invalidRecipients");
    expect(errorType(r, "notCreated", "badEnvelope")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "badRelease")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "extra")).toBe("invalidProperties");
    expect(errorType(r, "notCreated", "unprepared")).toBe("invalidEmail");
    const later = createdId(r, "later");

    // The same intent and payload replays the stored result; a different payload conflicts.
    const replay = call(
      "EmailSubmission/set",
      {
        create: {
          again: {
            identityId,
            emailId: id,
            envelope: env(["a@x.test"], { HOLDUNTIL: "2026-10-01T00:00:00Z" }),
            byeIntentId: "i1",
          },
        },
      },
      prepared(["again"]),
    );

    expect(((replay["created"] as Schema.JsonObject)["again"] as Schema.JsonObject)["id"]).toBe(
      later,
    );

    const clash = call(
      "EmailSubmission/set",
      {
        create: {
          clash: { identityId, emailId: id, envelope: env(["b@x.test"]), byeIntentId: "i1" },
        },
      },
      prepared(["clash"]),
    );

    expect(errorType(clash, "notCreated", "clash")).toBe("invalidProperties");

    expect(
      errorType(call("EmailSubmission/set", { destroy: [later] }), "notDestroyed", later),
    ).toBe("forbidden");
    expect(
      errorType(
        call("EmailSubmission/set", { update: { [later]: { identityId: "x" } } }),
        "notUpdated",
        later,
      ),
    ).toBe("invalidProperties");
    expect(
      errorType(
        call("EmailSubmission/set", { update: { nope: { undoStatus: "canceled" } } }),
        "notUpdated",
        "nope",
      ),
    ).toBe("notFound");
    expect(
      call("EmailSubmission/set", { update: { [later]: { undoStatus: "canceled" } } })["updated"],
    ).toEqual({ [later]: null });
    expect(call("EmailSubmission/set", { destroy: [later, "nope"] })).toMatchObject({
      destroyed: [later],
      notDestroyed: { nope: { type: "notFound" } },
    });

    expect(
      call("EmailSubmission/query", {
        filter: {
          identityIds: [identityId],
          emailIds: [id],
          threadIds: ["x"],
          undoStatus: "final",
          before: "2100-01-01T00:00:00Z",
          after: "2000-01-01T00:00:00Z",
        },
        sort: [
          { property: "sentAt", isAscending: false },
          { property: "emailId" },
          { property: "threadId" },
        ],
      }),
    ).toMatchObject({ ids: [] });
    expect(call("EmailSubmission/query", { anchor: "nope" })).toMatchObject({
      type: "anchorNotFound",
    });
    expect(call("EmailSubmission/query", { sort: [{ property: "nope" }] })).toMatchObject({
      type: "unsupportedSort",
    });
    expect(call("EmailSubmission/query", { filter: { nope: 1 } })).toMatchObject({
      type: "unsupportedFilter",
    });
    expect(call("EmailSubmission/query", { position: -5, calculateTotal: true })).toMatchObject({
      ids: [],
      total: 0,
    });
    expect(call("Conversation/set", { create: { x: {} } }, undefined)).toMatchObject({
      name: "Conversation/set",
    });
  });
});

describe("migration edges (C3)", () => {
  it("maps merged-thread deliveries conservatively and blocks activation on missing originals", () => {
    const { account, store, clock } = setup(false);
    const m = account.migration;

    const first = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ subject: "One" })),
    );

    store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ subject: "Two", fromAddress: "bob@example.com" })),
    );
    store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ subject: "Three", fromAddress: "zed@example.com" })),
    );

    expect(m.nextDeliveries()).toEqual([]);
    expect(m.beginBackfill(0).mode).toBe("legacy");
    expect(m.fence({ inputChecksum: "x", grants: [{ principalId: PRINCIPAL }] }).mode).toBe(
      "fencing",
    );
    expect(m.beginBackfill(2)).toMatchObject({
      mode: "fencing",
      problems: [expect.stringContaining("in flight")],
    });
    expect(m.beginBackfill(0).mode).toBe("backfilling");

    const batch = m.nextDeliveries(10);
    expect(batch).toHaveLength(3);
    m.applyDeliveries(
      batch.map((d, i) => ({
        deliveryId: d.deliveryId,
        content: i === 2 ? null : content(raw({ subject: `s${i}`, id: `s${i}@x` })),
      })),
    );
    m.applyDeliveries([]);
    expect(m.nextDrafts()).toEqual([]);
    const verified = m.finishBackfill();

    expect(verified).toMatchObject({
      mode: "verifying",
      verified: false,
      problems: expect.arrayContaining([
        expect.stringContaining("not mapped"),
        expect.stringContaining("missing"),
      ]),
    });
    expect(m.activate().mode).toBe("verifying");
    expect(account.core.emailRow(first.deliveryId)).toBeDefined();
    expect(m.abort("test").mode).toBe("legacy");
    expect(account.core.emailRow(first.deliveryId)).toBeUndefined();
    expect(m.abort("again").mode).toBe("legacy");
    m.buffer("arrival", "e1", "{}");
    m.buffer("arrival", "e1", "{}");
    expect(m.buffered(10)).toHaveLength(1);
    m.markApplied(m.buffered(10)[0]!.seq);
    expect(m.status().buffered).toBe(0);
  });

  it("drafts that can't be rendered are audited as unsupported", () => {
    const { account } = setup(false);
    const m = account.migration;
    m.fence({ inputChecksum: "", grants: [{ principalId: PRINCIPAL }] });
    m.beginBackfill(0);
    m.applyDeliveries([]);
    m.applyDraft("drf_x", null, PRINCIPAL);
    m.applyDraft("drf_y", content(raw({ subject: "draft", id: "dr@x" })), PRINCIPAL);
    expect(m.finishBackfill().problems).toEqual(
      expect.arrayContaining([expect.stringContaining("unsupported")]),
    );
  });
});

describe("ingest staging (B4)", () => {
  it("stages once, retries to a bound, parks and replays", () => {
    const { account, clock } = setup();
    const ingest = account.ingest;

    const input = {
      ...deliveryFixture(clock, summaryFixture({ subject: "Hi" })),
      safety: { _tag: "Clean" as const },
    };

    const staged = ingest.stage(input);

    expect(ingest.stage(input).arrivalId).toBe(staged.arrivalId);
    expect(ingest.pending(10)).toEqual([staged.arrivalId]);

    for (let i = 0; i < 3; i++) {
      ingest.preparing(staged.arrivalId);
      ingest.failed(staged.arrivalId, "boom");
    }

    expect(ingest.parked()).toEqual([{ arrivalId: staged.arrivalId, reason: "boom" }]);
    expect(ingest.preparing(staged.arrivalId)).toBe(false);
    expect(ingest.replay(staged.arrivalId)).toBe(true);
    expect(ingest.replay(staged.arrivalId)).toBe(false);
    const truncated = { ...content(raw({ subject: "t", id: "t@x" })) };

    const out = ingest.publish(staged.arrivalId, {
      ...truncated,
      email: { ...truncated.email, truncated: true },
    });

    expect(out).toEqual({ emailId: null, state: "parked" });
    ingest.replay(staged.arrivalId);
    const published = ingest.publish(staged.arrivalId, content(raw({ subject: "Hi", id: "hi@x" })));
    expect(published.state).toBe("published");
    expect(ingest.publish(staged.arrivalId, content(raw({ subject: "Hi", id: "hi@x" })))).toEqual(
      published,
    );
    expect(ingest.failed(staged.arrivalId, "late")).toBe("published");
    expect(ingest.publish("nope", content(raw({ subject: "x", id: "x@x" })))).toEqual({
      emailId: null,
      state: "parked",
    });

    ingest.recordScan(published.emailId!, "infected");
    expect(account.core.memberships(published.emailId!)).toEqual(["junk"]);
    ingest.recordScan("nope", "clean");
  });
});

describe("projection profile (not migrated)", () => {
  it("refuses core-only reads and every write", () => {
    const { call } = setup(false);

    expect(call("Identity/get", {})).toMatchObject({ type: "accountNotSupportedByMethod" });
    expect(call("EmailSubmission/query", {})).toMatchObject({
      type: "accountNotSupportedByMethod",
    });
    expect(call("Email/query", { filter: { text: "x" } })).toMatchObject({
      type: "unsupportedFilter",
    });
    expect(call("Email/query", { sort: [{ property: "subject" }] })).toMatchObject({
      type: "unsupportedSort",
    });
    expect(call("Email/set", { destroy: [] })).toMatchObject({ type: "accountReadOnly" });
    expect(call("Mailbox/changes", { sinceState: "x" })).toMatchObject({
      type: "cannotCalculateChanges",
    });
  });
});
