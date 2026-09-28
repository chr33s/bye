import { describe, expect, it } from "vitest";
import { EXIT, type FetchLike, makeCliApi, runCli } from "@bye/cli";
import { createTui, decodeKeys, parseWhen, sanitize } from "../src/tui.ts";

// Interactive acceptance for the TUI (X02, P1.3): keys in, frames and API requests out, against a
// fake instance behind the real CLI client. Every frame is checked for 80×24 and for terminal
// controls, since mail and calendar content is attacker-controlled.

const NOW = Date.parse("2026-09-28T08:00:00Z");
const ESC = "\u001b";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: any;
}

type Route = (call: Call) => unknown;

const thread1 = {
  threadId: "thr_1",
  subject: "Quarterly report",
  sender: "Alice <alice@example.com>",
  revision: 3,
  seenRevision: 1,
  attention: { replyLater: true, setAside: false, bubble: { _tag: "None" } },
};
const hostile = {
  threadId: "thr_2",
  subject: `${ESC}]0;pwned${"\u0007"}Invoice ${ESC}[31mdue\u202Efdp.exe`,
  sender: `Mallory \u009b31m<m@example.com>`,
  revision: 1,
  seenRevision: 1,
};
const deliveries = [
  {
    deliveryId: "dlv_1",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ address: "me@example.com" }],
    cc: [{ name: "Bob", address: "bob@example.com" }],
    subject: "Quarterly report",
    date: Date.parse("2026-09-27T09:30:00Z"),
    snippet: "Numbers attached",
    renderUrl: "https://mail.test/render/t1",
    attachments: [
      { partId: "p2", filename: "q3.pdf", contentType: "application/pdf", size: 20480 },
      { partId: "p3", filename: "q3.csv", contentType: "text/csv", size: 512 },
    ],
    scan: { status: "clean" },
  },
  {
    deliveryId: "dlv_2",
    from: { address: "me@example.com" },
    to: [{ name: "Alice", address: "alice@example.com" }],
    cc: [],
    subject: "Re: Quarterly report",
    date: Date.parse("2026-09-27T11:00:00Z"),
    snippet: "Thanks",
    renderUrl: "https://mail.test/render/t2",
  },
];
const DOCUMENTS: Record<string, string> = {
  "https://mail.test/render/t1": `<!doctype html><body><pre style="white-space:pre-wrap">Hi,\n\nLine two &amp; three\n${ESC}]52;c;cHduZWQ=${"\u0007"}Clipboard${ESC}[2J safe\n\nAlice</pre></body>`,
  "https://mail.test/render/t2": `<body><style>p{}</style><p>Thanks <b>Alice</b>!</p><p>See <a href="https://x.test/doc">the doc</a></p></body>`,
};
const standup = {
  eventId: "evt_1",
  calendarId: "calx",
  uid: "u1",
  key: "evt_1",
  start: {
    kind: "timed",
    tzid: "UTC",
    local: { year: 2026, month: 9, day: 28, hour: 9, minute: 0, second: 0 },
  },
  end: {
    kind: "timed",
    tzid: "UTC",
    local: { year: 2026, month: 9, day: 28, hour: 10, minute: 0, second: 0 },
  },
  startMs: Date.parse("2026-09-28T09:00:00Z"),
  endMs: Date.parse("2026-09-28T10:00:00Z"),
  allDay: false,
  recurring: false,
  isException: false,
  highlight: false,
  countdown: false,
  revision: 2,
  data: { summary: "Standup", location: "Room 1", description: `Agenda\n${ESC}[31mred${ESC}[0m` },
};
const oneOnOne = {
  ...standup,
  eventId: "evt_2",
  key: "evt_2:20260928T140000Z",
  recurring: true,
  revision: 4,
  start: { ...standup.start, local: { ...standup.start.local, hour: 14 } },
  end: { ...standup.end, local: { ...standup.end.local, hour: 15 } },
  startMs: Date.parse("2026-09-28T14:00:00Z"),
  endMs: Date.parse("2026-09-28T15:00:00Z"),
  data: { summary: "1:1 with Dana", status: "tentative" },
  invitation: {
    organizer: { address: "dana@example.com", name: "Dana" },
    partstat: "NEEDS-ACTION",
  },
};

const ROUTES: Record<string, Route> = {
  "GET /v1/mailboxes/mbx_1/views/imbox": () => ({ items: [thread1, hostile], nextCursor: null }),
  "GET /v1/mailboxes/mbx_1/views/screener": () => ({
    items: [{ threadId: "thr_3", subject: "Hello", sender: "Carol <carol@example.com>" }],
  }),
  "GET /v1/mailboxes/mbx_1/views/trash": () => ({ items: [] }),
  "GET /v1/mailboxes/mbx_1/threads/thr_1": () => ({ thread: thread1, deliveries }),
  "POST /v1/mailboxes/mbx_1/commands": (call) =>
    call.body._tag === "CreateReplyDraft" ? { draftId: "drf_1" } : { ok: true },
  "GET /v1/mailboxes/mbx_1/drafts/drf_1": () => ({
    draftId: "drf_1",
    revision: 1,
    content: {
      to: [{ name: "Alice", address: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Quarterly report",
      text: "",
      attachments: [],
      inReplyTo: "<m1@example.com>",
      references: ["<m1@example.com>"],
    },
  }),
  "PATCH /v1/drafts/drf_1": (call) => ({ _tag: "Saved", revision: call.body.expectedRevision + 1 }),
  "POST /v1/drafts": () => ({ draftId: "drf_2", revision: 1 }),
  "POST /v1/drafts/drf_1/send": () => ({
    _tag: "Queued",
    sendJobIds: ["sj_1"],
    dueAt: NOW + 10_000,
    deduplicated: false,
  }),
  "POST /v1/drafts/drf_2/send": (call) => ({
    _tag: "Queued",
    sendJobIds: ["sj_2"],
    dueAt: call.body.sendAt,
    deduplicated: false,
  }),
  "POST /v1/send-jobs/sj_1/cancel": () => ({ _tag: "Cancelled" }),
  "POST /v1/send-jobs/sj_2/cancel": () => ({ _tag: "TooLate", state: "accepted" }),
  "GET /v1/mailboxes/mbx_1/search": () => ({
    results: [
      {
        kind: "message",
        id: "msg_1",
        threadId: "thr_1",
        date: NOW,
        snippet: `Quarterly ${ESC}[31mreport`,
      },
      { kind: "contact", id: "ct_1", threadId: null, date: NOW, snippet: "Alice" },
    ],
    nextCursor: null,
    watermark: 10,
    lagging: true,
  }),
  "GET /v1/calendars/cal_1/agenda": () => ({
    days: [
      { date: "2026-09-28", occurrences: [standup, oneOnOne] },
      { date: "2026-09-29", occurrences: [] },
    ],
  }),
  "GET /v1/calendars/cal_1/day/2026-09-28": () => ({
    date: "2026-09-28",
    occurrences: [standup, oneOnOne],
  }),
  "GET /v1/calendars/cal_1/day/2026-09-29": () => ({ date: "2026-09-29", occurrences: [] }),
  "GET /v1/calendars/cal_1/calendars": () => ({ items: [{ id: "calx", name: "Personal" }] }),
  "POST /v1/calendars/cal_1/commands": () => ({ eventId: "evt_9", revision: 1 }),
};

const harness = (
  overrides: Record<string, (call: Call) => { status: number; body: unknown }> = {},
) => {
  const calls: Array<Call> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const call = {
      method: init.method,
      path: u.pathname,
      query: u.searchParams,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const override = overrides[key]?.(call);
    const route = ROUTES[key];
    const status = override?.status ?? (route ? 200 : 404);
    const body = override
      ? override.body
      : route
        ? route(call)
        : { error: { code: "not_found", message: key } };
    return {
      status,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
    };
  };
  let n = 0;
  const tui = createTui({
    api: makeCliApi(
      { apiUrl: "https://api.test", token: "tok", mailboxId: "mbx_1", calendarId: "cal_1" },
      fetchImpl,
    ),
    newCommandId: () => `cmd_${++n}`,
    fetchText: async (url) => {
      const doc = DOCUMENTS[url];
      if (doc === undefined) throw new Error("expired");
      return doc;
    },
    now: () => NOW,
    timeZone: "UTC",
  });
  /** The current frame, checked for size and terminal safety. */
  const frame = () => {
    const lines = tui.frame();
    expect(lines).toHaveLength(24);
    for (const line of lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(80);
      // oxlint-disable-next-line no-control-regex -- intentional control-char match
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202E\u2066-\u2069]/);
    }
    return lines.join("\n");
  };
  const keys = async (...pressed: Array<string>) => {
    for (const key of pressed) await tui.press(key);
    await tui.settled();
    return frame();
  };
  const commands = () =>
    calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command ?? c.body);
  return { tui, calls, frame, keys, commands, type: (text: string) => tui.type(text) };
};

describe("TUI", () => {
  it("[X02] prefers the server's plain-text body over the rendered document", async () => {
    const h = harness({
      "GET /v1/mailboxes/mbx_1/deliveries/dlv_1/text": () => ({
        status: 200,
        body: { deliveryId: "dlv_1", text: "Plain body from the server", source: "text" },
      }),
    });
    await h.tui.start();
    const opened = await h.keys("enter");
    expect(opened).toContain("Plain body from the server");
  });

  it("[X02] reads complete thread bodies with message and attachment metadata", async () => {
    const h = harness();
    await h.tui.start();
    expect(h.frame()).toContain("Inbox · 2 threads");
    expect(h.frame()).toMatch(/> NL {3}Alice {2,}Quarterly report/);
    const opened = await h.keys("enter");
    expect(h.calls.some((c) => c.path === "/v1/mailboxes/mbx_1/threads/thr_1")).toBe(true);
    expect(opened).toContain("> [1/2] Quarterly report");
    expect(opened).toContain("From: Alice <alice@example.com>");
    expect(opened).toContain("Cc: Bob <bob@example.com>");
    expect(opened).toContain("Date: 2026-09-27 09:30");
    expect(opened).toContain("> [1] q3.pdf  application/pdf  20.0 KB  id p2");
    expect(opened).toContain("Line two & three");
    // The OSC 52 clipboard write and screen clear are stripped; the text around them stays.
    expect(opened).toContain("Clipboard safe");
    // Attachment navigation within the current message.
    await h.keys(".");
    expect(h.frame()).toContain("> [2] q3.csv  text/csv  512 B");
    expect(h.tui.state().status.text).toBe("Attachment 2/2: q3.csv (text/csv, 512 bytes)");
    // Next message: the second body is HTML converted to text, links kept.
    const second = await h.keys("]");
    expect(second).toContain("> [2/2] Re: Quarterly report");
    expect(second).toContain("Thanks Alice!");
    expect(second).toContain("See the doc <https://x.test/doc>");
    expect(second).not.toContain("p{}");
    await h.keys("[");
    expect(h.tui.state().thread?.message).toBe(0);
    await h.keys("q");
    expect(h.tui.state().screen).toBe("mail");
  });

  it("[X02] a body that can't be fetched falls back to the snippet with the reason", async () => {
    const h = harness({
      "GET /v1/mailboxes/mbx_1/threads/thr_1": () => ({
        status: 200,
        body: { thread: thread1, deliveries: [{ ...deliveries[0], renderUrl: "https://gone" }] },
      }),
    });
    await h.tui.start();
    const opened = await h.keys("enter");
    expect(opened).toContain("Numbers attached");
    expect(opened).toContain("(full message unavailable: expired)");
  });

  it("[X02] replies, sends with undo, and reopens the cancelled draft", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("enter", "r");
    expect(h.commands().at(-1)).toMatchObject({
      _tag: "CreateReplyDraft",
      threadId: "thr_1",
      mode: "reply",
    });
    let frame = h.frame();
    expect(frame).toContain("Compose · reply · draft saved");
    expect(frame).toContain("To      alice@example.com");
    expect(frame).toContain("Subject Re: Quarterly report");
    expect(frame).toContain("> Body:");
    await h.type("Thanks,\rlooks good.");
    expect(h.frame()).toContain("  looks good.|");
    await h.type("\u0013");
    expect(h.frame()).toContain(
      "Send? y, d +done, b +follow up, r +follow up if no reply, c +clear, n no",
    );
    frame = await h.keys("y");
    const patch = h.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/v1/drafts/drf_1");
    // Only the body changed; threading headers from the server's reply draft are kept.
    expect(patch.body).toMatchObject({
      mailboxId: "mbx_1",
      expectedRevision: 1,
      content: {
        text: "Thanks,\nlooks good.",
        to: [{ name: "Alice", address: "alice@example.com" }],
        inReplyTo: "<m1@example.com>",
        references: ["<m1@example.com>"],
      },
    });
    const send = h.calls.find((c) => c.path === "/v1/drafts/drf_1/send")!;
    expect(send.body).toMatchObject({ mailboxId: "mbx_1", revision: 2 });
    expect(send.body.sendAt).toBeUndefined();
    expect(send.body.afterSend).toBeUndefined();
    expect(frame).toContain("Sending. Press u to undo.  [u undo until 08:00]");
    expect(h.tui.state().screen).toBe("thread");
    frame = await h.keys("u");
    expect(h.calls.some((c) => c.path === "/v1/send-jobs/sj_1/cancel")).toBe(true);
    expect(frame).toContain("Send cancelled; the draft is open again");
    expect(h.tui.state().screen).toBe("compose");
    expect(h.tui.state().compose?.draftId).toBe("drf_1");
  });

  it("[E09] sends with bubble-if-no-reply, and B bubbles a thread up only if nobody replies", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("enter", "r");
    await h.type("Any news?");
    await h.type("\u0013");
    await h.keys("r");
    const send = h.calls.find((c) => c.path === "/v1/drafts/drf_1/send")!;
    expect(send.body.afterSend).toMatchObject({ _tag: "BubbleUp", condition: "if-no-reply" });
    await h.keys("escape", "B");
    expect(h.frame()).toContain("Follow up if no reply by?");
    await h.type("2h\r");
    expect(h.commands().at(-1)).toMatchObject({ _tag: "BubbleUp", condition: "if-no-reply" });
  });

  it("[X02] reply-all and forward create the matching server drafts", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("e", "escape", "f");
    expect(h.commands().map((c) => c.mode)).toEqual(["reply-all", "forward"]);
    // Forwards start in the recipients field.
    expect(h.tui.state().compose?.focus).toBe(0);
    expect(h.frame()).toContain("Compose · forward");
  });

  it("[X02] composes a new message and schedules it with Send Later; too-late cancel is reported", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("c");
    await h.type("bob@example.com\t\t\tLunch?\tTomorrow at noon?");
    expect(h.frame()).toContain("> Body:");
    await h.type("\u000c");
    expect(h.frame()).toContain("Send when?");
    await h.type("2h\r");
    const created = h.calls.find((c) => c.method === "POST" && c.path === "/v1/drafts")!;
    expect(created.body).toMatchObject({
      mailboxId: "mbx_1",
      content: {
        to: [{ address: "bob@example.com" }],
        cc: [],
        subject: "Lunch?",
        text: "Tomorrow at noon?",
      },
    });
    const send = h.calls.find((c) => c.path === "/v1/drafts/drf_2/send")!;
    expect(send.body).toMatchObject({ revision: 1, sendAt: NOW + 2 * 3_600_000 });
    expect(h.frame()).toContain("Scheduled for 2026-09-28 10:00. Press u to cancel.");
    const frame = await h.keys("u");
    expect(frame).toContain("error: Undo send failed: too late: the message is already accepted");
  });

  it("[X02] Send Later rejects times that aren't in the future without sending", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("c");
    await h.type("a@example.com\u000cyesterday\r");
    expect(h.frame()).toContain('error: Send later: "yesterday" isn\'t a future time');
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(h.tui.state().screen).toBe("compose");
  });

  it("[X02] screens senders and applies attention, Bubble Up, trash, spam and restore", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("4");
    expect(h.frame()).toContain("New Senders · 1 threads");
    await h.keys("y");
    expect(h.frame()).toContain("Approve carol@example.com into (i)mbox, (f)eed or (p)aper trail?");
    await h.keys("f", "n");
    expect(h.frame()).toContain("Screen out carol@example.com? (y)es / (n)o");
    await h.keys("y", "1");
    await h.keys("l", "a", "s", "b");
    await h.type("2h\r");
    await h.keys("b");
    await h.type("now\r");
    await h.keys("p", "x", "d", "!", "R");
    expect(h.commands()).toEqual([
      {
        commandId: "cmd_1",
        _tag: "Screen",
        decisions: [
          { sender: "carol@example.com", decision: "allow", destination: "feed", asSeen: false },
        ],
      },
      {
        commandId: "cmd_2",
        _tag: "Screen",
        decisions: [{ sender: "carol@example.com", decision: "block" }],
      },
      // Reply Later was on for this thread, so `l` turns it off; Set Aside was off.
      {
        commandId: "cmd_3",
        _tag: "SetAttention",
        flag: "replyLater",
        threadId: "thr_1",
        on: false,
      },
      { commandId: "cmd_4", _tag: "SetAttention", flag: "setAside", threadId: "thr_1", on: true },
      { commandId: "cmd_5", _tag: "MarkSeen", threadId: "thr_1", observedRevision: 3 },
      { commandId: "cmd_6", _tag: "BubbleUp", threadId: "thr_1", at: NOW + 7_200_000 },
      { commandId: "cmd_7", _tag: "PinBubble", threadId: "thr_1" },
      { commandId: "cmd_8", _tag: "PopBubble", threadId: "thr_1" },
      { commandId: "cmd_9", _tag: "ClearBubble", threadId: "thr_1" },
      { commandId: "cmd_10", _tag: "MoveToTrash", threadIds: ["thr_1"] },
      { commandId: "cmd_11", _tag: "MarkSpam", threadIds: ["thr_1"] },
      { commandId: "cmd_12", _tag: "Restore", threadIds: ["thr_1"] },
    ]);
    expect(h.frame()).toContain("Restored");
  });

  it("[X02] triage from an open thread returns to the list after trash", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("enter", "d");
    expect(h.commands().at(-1)).toMatchObject({ _tag: "MoveToTrash", threadIds: ["thr_1"] });
    expect(h.tui.state().screen).toBe("mail");
    expect(h.frame()).toContain("Moved to Trash");
  });

  it("[X02] searches mail and opens a result's thread", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("/");
    await h.type("report from:alice\r");
    const search = h.calls.find((c) => c.path === "/v1/mailboxes/mbx_1/search")!;
    expect(search.query.get("q")).toBe("report from:alice");
    const frame = h.frame();
    expect(frame).toContain('Search "report from:alice" · 2 results (index catching up');
    expect(frame).toContain("> message  2026-09-28  Quarterly report");
    await h.keys("j", "enter");
    expect(h.frame()).toContain("This result isn't a thread");
    await h.keys("k", "enter");
    expect(h.tui.state().screen).toBe("thread");
    await h.keys("q");
    expect(h.tui.state().search?.query).toBe("report from:alice");
    await h.keys("escape");
    expect(h.tui.state().search).toBeNull();
    expect(h.frame()).toContain("Inbox · 2 threads");
  });

  it("[X02] triage on a search hit reads the thread for its revision and flags", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("/");
    await h.type("report\r");
    await h.keys("s", "l");
    const [seen, replyLater] = h.commands();
    expect(seen).toMatchObject({ _tag: "MarkSeen", threadId: "thr_1", observedRevision: 3 });
    // thr_1 is already in Reply Later, so `l` removes it.
    expect(replyLater).toMatchObject({ _tag: "SetAttention", flag: "replyLater", on: false });
  });

  it("[X02] undo cancels every send job and reports a partial cancel", async () => {
    const h = harness({
      "POST /v1/drafts/drf_1/send": () => ({
        status: 200,
        body: { _tag: "Queued", sendJobIds: ["sj_2", "sj_1"], dueAt: NOW + 10_000 },
      }),
    });
    await h.tui.start();
    await h.keys("enter", "r");
    await h.type("ok\u0013");
    await h.keys("y");
    const frame = await h.keys("u");
    expect(h.calls.filter((c) => c.path.endsWith("/cancel")).map((c) => c.path)).toEqual([
      "/v1/send-jobs/sj_2/cancel",
      "/v1/send-jobs/sj_1/cancel",
    ]);
    expect(frame).toContain("Partly cancelled: 1 of 2 sends were already accepted");
    expect(h.tui.state().screen).toBe("compose");
  });

  it("[X02] calendar agenda and day views, event create/edit and invitation replies", async () => {
    const h = harness();
    await h.tui.start();
    let frame = await h.keys("C");
    const agenda = h.calls.at(-1)!;
    expect(agenda.path).toBe("/v1/calendars/cal_1/agenda");
    expect(Object.fromEntries(agenda.query)).toEqual({ from: "2026-09-28", days: "7", tz: "UTC" });
    expect(frame).toContain("Mon 2026-09-28");
    expect(frame).toContain(">   09:00–10:00  Standup  @ Room 1");
    expect(frame).toContain("    14:00–15:00  1:1 with Dana (tentative) [repeats]");
    expect(frame).toContain("(nothing scheduled)");

    // Only invitations can be answered: Standup is the owner's own event.
    frame = await h.keys("Y");
    expect(frame).toContain("This event isn't an invitation to you");
    expect(h.commands()).toEqual([]);
    // Invitation replies: recurring occurrences are answered for that occurrence.
    frame = await h.keys("j", "enter");
    expect(frame).toContain("Invited by: Dana");
    expect(frame).toContain("Your answer: Not answered");
    await h.keys("q", "Y");
    expect(h.frame()).toContain("Reply accept to (t)his occurrence or the whole (s)eries?");
    await h.keys("t", "T", "t", "D", "s");
    expect(h.commands().map((c) => [c.type, c.partstat, c.occurrenceKey])).toEqual([
      ["RespondInvitation", "ACCEPTED", "evt_2:20260928T140000Z"],
      ["RespondInvitation", "TENTATIVE", "evt_2:20260928T140000Z"],
      ["RespondInvitation", "DECLINED", undefined],
    ]);

    // Event details, sanitized.
    frame = await h.keys("k", "enter");
    expect(frame).toContain("When: 2026-09-28 09:00 – 2026-09-28 10:00");
    expect(frame).toContain("Where: Room 1");
    expect(frame).toContain("  red");
    await h.keys("q");

    // Day view and day navigation.
    frame = await h.keys("v");
    expect(frame).toContain("Day · Mon 2026-09-28");
    frame = await h.keys("l");
    expect(h.calls.at(-1)?.path).toBe("/v1/calendars/cal_1/day/2026-09-29");
    expect(frame).toContain("Tue 2026-09-29");

    // New event on the shown day.
    frame = await h.keys("c");
    expect(frame).toContain("Start  2026-09-29T09:00");
    await h.type("Review\u0013");
    expect(h.commands().at(-1)).toMatchObject({
      type: "CreateEvent",
      calendarId: "calx",
      data: { summary: "Review" },
      start: {
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 9, day: 29, hour: 9, minute: 0 },
      },
      end: { kind: "timed", local: { hour: 10 } },
    });
    expect(h.frame()).toContain("Event created");

    // Edit: only changed fields are sent, against the occurrence's revision.
    await h.keys("h", "e");
    await h.type(" (moved)\u0013");
    const edit = h.commands().at(-1)!;
    expect(edit).toEqual({
      commandId: expect.any(String),
      type: "UpdateEvent",
      eventId: "evt_1",
      expectedRevision: 2,
      scope: "series",
      changes: { data: { summary: "Standup (moved)" } },
    });
    // A recurring event asks which occurrences to change.
    await h.keys("j", "e", "tab", "tab", "tab");
    await h.type("Room 4\u0013");
    expect(h.frame()).toContain("Change (t)his occurrence, (f)uture ones, or the whole (s)eries?");
    await h.keys("t");
    expect(h.commands().at(-1)).toMatchObject({
      type: "UpdateEvent",
      eventId: "evt_2",
      expectedRevision: 4,
      scope: "this",
      occurrenceKey: "evt_2:20260928T140000Z",
      changes: { data: { location: "Room 4" } },
    });
    await h.keys("m");
    expect(h.tui.state().screen).toBe("mail");
  });

  it("[X02] reports structured API and network errors in the status line", async () => {
    const h = harness({
      "POST /v1/mailboxes/mbx_1/commands": () => ({
        status: 403,
        body: { error: { code: "forbidden", message: `missing scope ${ESC}[31mwrite` } },
      }),
    });
    await h.tui.start();
    expect(await h.keys("d")).toContain(
      "error: Trash failed — forbidden (HTTP 403): missing scope write",
    );
    const offline = createTui({
      api: makeCliApi(
        { apiUrl: "https://api.test", token: "tok", mailboxId: "mbx_1", calendarId: "cal_1" },
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
      ),
      newCommandId: () => "cmd_1",
    });
    await offline.start();
    expect(offline.frame().join("\n")).toContain(
      "error: Loading failed — unavailable (network): Error: connect ECONNREFUSED",
    );
  });

  it("[X02] works in 80×24 monochrome; colour only adds reverse video to the selection", async () => {
    const h = harness();
    await h.tui.start();
    const mono = h.tui.frame({ color: false });
    expect(mono.join("")).not.toContain(ESC);
    expect(mono[2]).toMatch(/^> /);
    const color = h.tui.frame({ color: true });
    const styled = color.filter((line) => line.includes(ESC));
    expect(styled).toHaveLength(1);
    expect(styled[0]!.startsWith(`${ESC}[7m> `)).toBe(true);
    expect(styled[0]!.endsWith(`${ESC}[27m`)).toBe(true);
    // Help is reachable and scrolls within the frame.
    const help = await h.keys("?");
    expect(help).toContain("Everywhere: ? help");
    await h.keys("j", "q");
    expect(h.tui.state().screen).toBe("mail");
    // Narrow terminals still fit.
    const narrow = createTui({
      api: makeCliApi(
        { apiUrl: "https://api.test", token: "t", mailboxId: "mbx_1", calendarId: "cal_1" },
        async () => ({ status: 200, text: async () => JSON.stringify({ items: [hostile] }) }),
      ),
      newCommandId: () => "cmd_1",
      size: () => ({ columns: 40, rows: 12 }),
    });
    await narrow.start();
    const lines = narrow.frame();
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(40);
  });

  it("[X02] quits with q from the list and ctrl-c anywhere", async () => {
    const h = harness();
    await h.tui.start();
    await h.keys("c");
    await h.type("q");
    expect(h.tui.done()).toBe(false);
    await h.type("\u0003");
    expect(h.tui.done()).toBe(true);
    const g = harness();
    await g.tui.start();
    await g.keys("q");
    expect(g.tui.done()).toBe(true);
  });
});

describe("TUI input and content safety", () => {
  it("[X02] decodes terminal keys, pastes and escape sequences", () => {
    expect(decodeKeys("jk\r\u001b[A\u001b[B\u001b[Z\u0013\u007f\u001b")).toEqual([
      "j",
      "k",
      "enter",
      "up",
      "down",
      "shift-tab",
      "ctrl-s",
      "backspace",
      "escape",
    ]);
    // Bracketed-paste markers and C1 controls are dropped; CRLF is one line break.
    expect(decodeKeys("\u001b[200~a\r\nb\u009b\u001b[201~")).toEqual(["a", "enter", "b"]);
  });

  it("[X02] strips escape sequences, C0/C1 controls and bidi overrides", () => {
    expect(sanitize(`a${ESC}]0;title\u0007b${ESC}[2Jc\u009b1md\u202Ee\u2066f\r\ng`)).toBe(
      "abcdef g",
    );
    expect(sanitize(`${ESC}P+q${ESC}\\x`)).toBe("x");
  });

  it("[X02] parses Bubble Up and Send Later times", () => {
    expect(parseWhen("2h", NOW)).toBe(NOW + 7_200_000);
    expect(parseWhen("in 3d", NOW)).toBe(NOW + 3 * 86_400_000);
    expect(parseWhen("+30m", NOW)).toBe(NOW + 1_800_000);
    expect(parseWhen("now", NOW)).toBe("now");
    expect(parseWhen("2026-10-01T09:00:00Z", NOW)).toBe(Date.parse("2026-10-01T09:00:00Z"));
    expect(parseWhen("soonish", NOW)).toBeNull();
    // A bare date is 08:00 local that day, not UTC midnight (the evening before, west of UTC).
    expect(parseWhen("2026-10-01", NOW)).toBe(new Date(2026, 9, 1, 8).getTime());
  });
});

describe("CLI commands behind the TUI", () => {
  it("[X02] reply drafts, draft save merge, bubble pop, day view, invitations and edits", async () => {
    const calls: Array<Call> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = new URL(url);
      const call = {
        method: init.method,
        path: u.pathname,
        query: u.searchParams,
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      };
      calls.push(call);
      const route = ROUTES[`${call.method} ${call.path}`];
      return { status: 200, text: async () => JSON.stringify(route ? route(call) : {}) };
    };
    const err: Array<string> = [];
    const run = (argv: Array<string>) =>
      runCli(
        argv,
        makeCliApi(
          { apiUrl: "https://api.test", token: "t", mailboxId: "mbx_1", calendarId: "cal_1" },
          fetchImpl,
        ),
        { stdout: () => {}, stderr: (t) => err.push(t), newCommandId: () => "cmd_1" },
      );
    expect(await run(["draft", "reply", "thr_1", "--mode", "reply-all"])).toBe(EXIT.ok);
    expect(await run(["draft", "reply", "thr_1", "--mode", "sideways"])).toBe(EXIT.usage);
    expect(await run(["draft", "save", "drf_1", "--subject", "New", "--cc", "c@example.com"])).toBe(
      EXIT.ok,
    );
    expect(await run(["mail", "bubble", "thr_1", "--pop"])).toBe(EXIT.ok);
    expect(await run(["cal", "day", "2026-09-28", "--tz", "UTC"])).toBe(EXIT.ok);
    expect(await run(["cal", "day", "tomorrow"])).toBe(EXIT.usage);
    expect(await run(["cal", "respond", "evt_1", "decline"])).toBe(EXIT.ok);
    expect(await run(["cal", "respond", "evt_1", "maybe"])).toBe(EXIT.usage);
    expect(await run(["cal", "edit", "evt_1", "--title", "x"])).toBe(EXIT.usage);
    expect(
      await run([
        "cal",
        "edit",
        "evt_1",
        "--revision",
        "2",
        "--end",
        "2026-09-28T11:00",
        "--tz",
        "UTC",
      ]),
    ).toBe(EXIT.ok);
    const writes = calls.filter((c) => c.method !== "GET").map((c) => c.body.command ?? c.body);
    expect(writes[0]).toMatchObject({ _tag: "CreateReplyDraft", mode: "reply-all" });
    // draft save keeps what it wasn't asked to change.
    expect(writes[1]).toMatchObject({
      expectedRevision: 1,
      content: {
        subject: "New",
        cc: [{ address: "c@example.com" }],
        to: [{ name: "Alice", address: "alice@example.com" }],
        inReplyTo: "<m1@example.com>",
      },
    });
    expect(writes[2]).toMatchObject({ _tag: "PopBubble", threadId: "thr_1" });
    expect(writes[3]).toMatchObject({ type: "RespondInvitation", partstat: "DECLINED" });
    expect(writes[4]).toMatchObject({
      type: "UpdateEvent",
      scope: "series",
      changes: { end: { kind: "timed", tzid: "UTC", local: { hour: 11 } } },
    });
    expect(calls.some((c) => c.path === "/v1/calendars/cal_1/day/2026-09-28")).toBe(true);
    expect(err.join("\n")).toContain('Expected: "accept" | "tentative" | "decline"');
    // E09: conditional bubbles and after-send actions.
    calls.length = 0;
    expect(
      await run(["mail", "follow-up", "thr_1", "--at", "2026-10-01T09:00:00Z", "--if-no-reply"]),
    ).toBe(EXIT.ok);
    expect(
      await run(["draft", "send", "drf_1", "--revision", "2", "--after", "clear", "--yes"]),
    ).toBe(EXIT.ok);
    expect(
      await run(["draft", "send", "drf_1", "--revision", "2", "--after", "later", "--yes"]),
    ).toBe(EXIT.usage);
    const e09 = calls.filter((c) => c.method !== "GET").map((c) => c.body.command ?? c.body);
    expect(e09[0]).toMatchObject({ _tag: "BubbleUp", condition: "if-no-reply" });
    expect(e09[1]).toMatchObject({ afterSend: { _tag: "ClearBubble" } });
    expect(e09).toHaveLength(2);
  });
});
