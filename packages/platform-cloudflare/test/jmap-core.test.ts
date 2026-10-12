import { Option, Predicate, Result } from "effect";
import { describe, expect, it } from "vitest";
import { prepareEmail } from "@bye/mail-codec";
import {
  FULL_RIGHTS,
  HISTORY_RETENTION_MS,
  type JmapCore,
  type PreparedContent,
  TIMER_JOB,
} from "@bye/platform-cloudflare";
import { makeTestMailbox } from "@bye/testing";

// The JMAP core over a real SQLite store (spec.md §16 C1 history, A2 threading and timers, A3
// rights, Mail §2 counts), without the Worker around it.

const OWNER = { principalId: "usr_owner" };

const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

const timerOf = (r: ReturnType<JmapCore["native"]>): string =>
  Predicate.isTagged(r, "Native") ? (r.timerId ?? "") : "";

const raw = (input: {
  readonly subject: string;
  readonly id: string;
  readonly refs?: ReadonlyArray<string>;
  readonly inReplyTo?: string;
  readonly body?: string;
}) =>
  [
    "From: carol@example.net",
    "To: me@bye.test",
    `Subject: ${input.subject}`,
    "Date: Mon, 12 Oct 2026 12:00:00 +0000",
    `Message-ID: <${input.id}>`,
    ...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
    ...(input.refs?.length ? [`References: ${input.refs.map((r) => `<${r}>`).join(" ")}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body ?? "hello",
    "",
  ].join("\r\n");

const content = (text: string, blobId: string): PreparedContent => ({
  blobId,
  bucket: "originals",
  r2Key: `k/${blobId}`,
  type: "message/rfc822",
  email: prepareEmail(new TextEncoder().encode(text)),
});

const setup = () => {
  const t = makeTestMailbox();
  const core = t.store.jmap.core;
  core.ensureDefaults();
  core.applyGrant(OWNER.principalId, "*", FULL_RIGHTS);
  core.putMeta("mode", "jmap");
  let n = 0;

  const add = (
    text: string,
    mailboxIds: ReadonlyArray<string> = ["inbox"],
    keywords: ReadonlyArray<string> = [],
  ) => {
    const r = core.createEmail(
      OWNER,
      content(text, `b${++n}`),
      mailboxIds,
      keywords,
      t.clock.now(),
    );

    if (Result.isFailure(r)) throw new Error(r.failure.type);

    const id = r.success["id"];
    const threadId = r.success["threadId"];

    if (!Predicate.isString(id) || !Predicate.isString(threadId)) throw new Error("bad create");

    return { id, threadId };
  };

  return { ...t, core, add };
};

const changes = (
  core: JmapCore,
  type: "Email" | "Mailbox" | "Thread",
  base: number,
  target: number | null,
  cursor: string | null,
  limit: number,
) => core.history.changes(type, base, target, cursor, limit);

describe("typed history (C1)", () => {
  it("pages net changes within a fixed target and never skips IDs", () => {
    const { core, add } = setup();
    const base = core.history.typeRevision("Email");
    const a = add(raw({ subject: "a", id: "a@x" }));
    const b = add(raw({ subject: "b", id: "b@x" }));
    const c = add(raw({ subject: "c", id: "c@x" }));
    const target = core.history.typeRevision("Email");

    const page1 = changes(core, "Email", base, null, null, 2);
    expect(page1).toMatchObject({ _tag: "Changes", nextCursor: expect.any(String) });

    // A later change doesn't leak into the continuation of the same target.
    const d = add(raw({ subject: "d", id: "d@x" }));

    const page2 = changes(
      core,
      "Email",
      base,
      target,
      Predicate.isTagged(page1, "Changes") ? page1.nextCursor : null,
      2,
    );

    const seen = [page1, page2].flatMap((p) => (Predicate.isTagged(p, "Changes") ? p.created : []));
    expect([...seen].sort(byId)).toEqual([a.id, b.id, c.id].sort(byId));
    expect(seen).not.toContain(d.id);
    expect(page2).toMatchObject({ nextCursor: null, state: { revision: String(target) } });
  });

  it("raises a floor on compaction so an old base is refused, not answered partially", () => {
    const { core, add, clock } = setup();
    const base = core.history.typeRevision("Email");
    add(raw({ subject: "old", id: "old@x" }));
    const mid = core.history.typeRevision("Email");

    clock.advance(HISTORY_RETENTION_MS + 1000);
    add(raw({ subject: "new", id: "new@x" }));
    expect(core.history.compact(clock.now())).toBeGreaterThan(0);

    expect(changes(core, "Email", base, null, null, 10)).toMatchObject({
      _tag: "Refused",
      type: "cannotCalculateChanges",
    });
    expect(changes(core, "Email", mid, null, null, 10)).toMatchObject({
      _tag: "Changes",
      created: [expect.any(String)],
    });
  });

  it("keyword edits touch Email and counts, never Thread; membership edits move counts", () => {
    const { core, add } = setup();
    const e = add(raw({ subject: "x", id: "x@x" }));
    const thread = core.history.typeRevision("Thread");
    const mailbox = core.history.typeRevision("Mailbox");

    core.history.tx(() => core.applyState(e.id, { keywords: ["$flagged"] }));
    expect(core.history.typeRevision("Thread")).toBe(thread);
    expect(core.history.typeRevision("Mailbox")).toBe(mailbox);

    core.history.tx(() => core.applyState(e.id, { keywords: ["$flagged", "$seen"] }));
    expect(core.history.typeRevision("Mailbox")).toBeGreaterThan(mailbox);
    expect(core.history.typeRevision("Thread")).toBe(thread);
  });
});

describe("threading (A2)", () => {
  it("prefers the rightmost known reference with a compatible subject; never reassigns old mail", () => {
    const { add } = setup();
    const root = add(raw({ subject: "Plan", id: "r@x" }));
    const other = add(raw({ subject: "Other", id: "o@x" }));
    const reply = add(raw({ subject: "Re: Plan", id: "p@x", refs: ["o@x", "r@x"] }));

    expect(reply.threadId).toBe(root.threadId);

    // Subject incompatible with the referenced message: a new Thread, not a splice.
    const hijack = add(raw({ subject: "Totally different", id: "h@x", inReplyTo: "r@x" }));
    expect(hijack.threadId).not.toBe(root.threadId);

    // A bridge reply referencing both threads joins exactly one and moves nothing else.
    const bridge = add(raw({ subject: "Re: Other", id: "bridge@x", refs: ["r@x", "o@x"] }));
    expect(bridge.threadId).toBe(other.threadId);
    expect(reply.threadId).toBe(root.threadId);
  });
});

describe("timers (A2 precedence)", () => {
  it("a later placement edit or destruction wins; read/star timers coexist with moves", () => {
    const { core, add, store, clock } = setup();
    const moved = add(raw({ subject: "m", id: "m@x" }));
    const kept = add(raw({ subject: "k", id: "k@x" }));
    const gone = add(raw({ subject: "g", id: "g@x" }));

    const arm = (action: Parameters<JmapCore["native"]>[1]["action"]) =>
      core.native(OWNER, {
        _tag: "Native",
        emails: [
          [moved.id, null],
          [kept.id, null],
          [gone.id, null],
        ],
        action,
        intentId: null,
        dueAt: clock.now() + 60_000,
      });

    const archive = arm({ _tag: "Archive" });
    const star = arm({ _tag: "Flag", flagged: true });
    expect(archive).toMatchObject({ _tag: "Native", timerId: expect.any(String) });
    expect(store.kernel.job(TIMER_JOB, timerOf(archive))).toBeDefined();

    // After arming: one Email is moved by the user, one destroyed.
    core.history.tx(() => core.applyState(moved.id, { mailboxIds: ["feed"] }));
    core.history.tx(() => core.destroyEmail(gone.id));

    const out = core.runTimer(timerOf(archive));
    expect(out).toEqual({ ran: [kept.id], skipped: [moved.id, gone.id] });
    expect(core.memberships(moved.id)).toEqual(["feed"]);
    expect(core.memberships(kept.id)).toEqual(["archive"]);

    // The star timer still applies to the moved Email: keyword actions don't depend on placement.
    const stars = core.runTimer(timerOf(star));
    expect(stars.ran).toEqual(expect.arrayContaining([moved.id, kept.id]));
    expect(core.keywords(moved.id)).toContain("$flagged");
    // Re-running a finished timer does nothing (re-arming is explicit).
    expect(core.runTimer(timerOf(star))).toEqual({
      ran: [],
      skipped: [],
    });
  });
});

describe("rights and counts (A3, Mail §2)", () => {
  it("a principal granted one Mailbox sees only its Emails and may not add elsewhere", () => {
    const { core, add } = setup();
    const visible = add(raw({ subject: "v", id: "v@x" }), ["feed"]);
    add(raw({ subject: "h", id: "h@x" }), ["inbox"]);

    const member = { principalId: "usr_member" };
    core.applyGrant(member.principalId, "feed", {
      ...FULL_RIGHTS,
      mayAddItems: false,
      mayDelete: false,
    });

    expect(core.mailboxes(member).map((m) => m.id)).toEqual(["feed"]);
    expect(core.emailGet(member, [visible.id, "nope"], ["id"]).list).toHaveLength(1);
    expect(core.threads(member, [visible.threadId])).toHaveLength(1);

    const query = core.query(member, {
      _tag: "EmailQuery",
      filter: null,
      sort: [{ property: "receivedAt", isAscending: false }],
      collapseThreads: false,
      position: 0,
      anchor: null,
      anchorOffset: 0,
      limit: 10,
      calculateTotal: true,
    });

    expect(query).toMatchObject({ ids: [visible.id], total: 1 });

    const blocked = core.createEmail(
      member,
      content(raw({ subject: "n", id: "n@x" }), "bn"),
      ["feed"],
      [],
      0,
    );

    expect(Result.isFailure(blocked) && blocked.failure.type).toBe("forbidden");
  });

  it("stays within Cloudflare's 100 bound parameters for many grants and long filter lists", () => {
    const { core, add } = setup();

    const added = Array.from({ length: 95 }, (_, i) =>
      add(raw({ subject: `m${i}`, id: `m${i}@x` }), ["feed"]),
    );

    const member = { principalId: "usr_member" };
    core.applyGrant(member.principalId, "feed", FULL_RIGHTS);

    for (let i = 0; i < 20; i++) core.applyGrant(member.principalId, `mbx_extra${i}`, FULL_RIGHTS);

    // A 90-id chunk plus the readable-mailbox list in one statement.
    expect(
      core.emailGet(
        member,
        added.map((e) => e.id),
        ["id"],
      ).list,
    ).toHaveLength(95);
    expect(
      core.threads(
        member,
        added.map((e) => e.threadId),
      ),
    ).toHaveLength(95);

    const query = core.query(OWNER, {
      _tag: "EmailQuery",
      filter: {
        _tag: "Condition",
        condition: {
          inMailboxOtherThan: ["inbox", ...Array.from({ length: 150 }, (_, i) => `mbx_n${i}`)],
        },
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      collapseThreads: false,
      position: 0,
      anchor: null,
      anchorOffset: 0,
      limit: 10,
      calculateTotal: true,
    });

    expect(query).toMatchObject({ total: 95 });
  });

  it("re-registering a content-addressed upload extends its expiry; referenced blobs stay permanent", () => {
    const { core, storage } = setup();

    const expiry = (id: string) =>
      (
        storage.db.prepare("SELECT expires_at AS e FROM jmap_blobs WHERE blob_id = ?").get(id) as {
          e: number | null;
        }
      ).e;

    const blob = {
      blobId: "Babc",
      bucket: "parts",
      r2Key: "k/abc",
      size: 3,
      type: "text/plain",
    } as const;

    core.registerBlob({ ...blob, expiresAt: 1_000 });
    core.registerBlob({ ...blob, expiresAt: 5_000 });
    expect(expiry("Babc")).toBe(5_000);
    core.registerBlob({ ...blob, expiresAt: 2_000 });
    expect(expiry("Babc")).toBe(5_000);
    core.registerBlob({ ...blob, expiresAt: null });
    core.registerBlob({ ...blob, expiresAt: 9_000 });
    expect(expiry("Babc")).toBeNull();
  });

  it("a multi-word text search matches words found in different chunks of one Email", () => {
    const { core, add } = setup();
    const filler = Array.from({ length: 900 }, (_, i) => `filler${i % 50}`).join(" ");
    const hit = add(raw({ subject: "Invoice", id: "far@x", body: `${filler} march` }));
    add(raw({ subject: "Other", id: "other@x", body: "march only" }));

    const search = (text: string) =>
      core.query(OWNER, {
        _tag: "EmailQuery",
        filter: { _tag: "Condition", condition: { text } },
        sort: [{ property: "receivedAt", isAscending: false }],
        collapseThreads: false,
        position: 0,
        anchor: null,
        anchorOffset: 0,
        limit: 10,
        calculateTotal: true,
      });

    // "invoice" is in the subject (chunk 0); "march" is past the first 4,000 body characters.
    expect(search("invoice march")).toMatchObject({ ids: [hit.id] });
    expect(search("invoice nowhere")).toMatchObject({ ids: [] });
  });

  it("a Mailbox/set update refused for one property changes nothing", () => {
    const { core } = setup();
    const before = core.history.typeRevision("Mailbox");

    const r = core.mailboxSet(OWNER, {
      _tag: "Set",
      type: "Mailbox",
      ifInState: null,
      create: [],
      update: [["feed", { name: "Renamed", isSubscribed: "yes" }]],
      destroy: [],
      options: {},
      createdIds: [],
    });

    expect(r).toMatchObject({ notUpdated: [["feed", { type: "invalidProperties" }]] });
    expect(core.mailboxes(OWNER).find((m) => m.id === "feed")?.name).not.toBe("Renamed");
    expect(core.history.typeRevision("Mailbox")).toBe(before);
  });

  it("unread threads follow the recommended Trash rule", () => {
    const { core, add } = setup();
    const a = add(raw({ subject: "T", id: "t1@x" }));
    const b = add(raw({ subject: "Re: T", id: "t2@x", inReplyTo: "t1@x" }), ["inbox"], ["$seen"]);
    expect(a.threadId).toBe(b.threadId);

    core.history.tx(() => core.applyState(a.id, { mailboxIds: ["trash"] }));
    const byId = new Map(core.mailboxes(OWNER).map((m) => [m.id, m]));

    // The only unread Email is in Trash: Inbox's thread isn't unread, Trash's is.
    expect(byId.get("inbox")).toMatchObject({
      totalEmails: 1,
      unreadEmails: 0,
      totalThreads: 1,
      unreadThreads: 0,
    });
    expect(byId.get("trash")).toMatchObject({ totalEmails: 1, unreadEmails: 1, unreadThreads: 1 });
  });

  it("revoking a grant advances the ACL generation (visibility binds every state token)", () => {
    const { core } = setup();
    const before = core.aclGeneration();
    core.applyGrant("usr_x", "*", null);

    expect(core.aclGeneration()).toBe(before + 1);
    expect(Option.isNone(Option.fromNullishOr(core.grants("usr_x").get("*")))).toBe(true);
  });
});
