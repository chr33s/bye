import { describe, expect, it } from "vitest";
import {
  addDays,
  buildRRule,
  eventPayload,
  type EventForm,
  monthGrid,
  nightHours,
  range,
  step,
  updatePayload,
  weekStart,
  ymd,
} from "../src/lib/calendar.ts";
import { ASSETS, servesFromShell, SHELL } from "../src/lib/sw-policy.ts";
import { JSDOM } from "jsdom";
import { ByeApiError } from "@bye/native-shared";
import { bestEffort, degrade } from "../src/core/degrade.ts";
import {
  composeBody,
  expandSnippets,
  parseRecipients,
  partRanges,
  restoreInlineImages,
  textToHtml,
  withSignature,
} from "../src/lib/compose.ts";
import { appendPage, emptyPaged, nextPageQuery } from "../src/lib/paging.ts";
import { matchRoute, WEB_ROUTES } from "../src/lib/router.ts";

const form = (overrides: Partial<EventForm> = {}): EventForm => ({
  calendarId: "c1",
  title: "Standup",
  allDay: false,
  start: "2026-10-01T09:00",
  end: "2026-10-01T09:15",
  timeZone: "Europe/London",
  frequency: "none",
  interval: 1,
  byDay: [],
  ends: { kind: "never" },
  location: "",
  description: "",
  attendees: "",
  reminders: "10",
  ...overrides,
});

describe("web router", () => {
  const route = (hash: string) => {
    const m = matchRoute(hash);
    return { name: m.name, ...m.params };
  };

  it("[X01] maps every hash through one route table, decoding segments and defaulting safely", () => {
    expect(route("")).toEqual({ name: "view" });
    expect(route("#/mail/feed")).toEqual({ name: "feed" });
    expect(route("#/mail/screener")).toEqual({ name: "view", view: "screener" });
    expect(route("#/thread/thr%2F1")).toEqual({ name: "thread", threadId: "thr/1" });
    expect(route("#/label/Work%20stuff")).toEqual({ name: "label", label: "Work stuff" });
    expect(route("#/spaces/spc_1/threads/sth_2")).toEqual({
      name: "spaces",
      spaceId: "spc_1",
      threadId: "sth_2",
    });
    expect(route("#/spaces/spc_1")).toEqual({ name: "spaces", spaceId: "spc_1" });
    expect(route("#/calendar/week/2026-10-01")).toEqual({
      name: "calendar",
      view: "week",
      date: "2026-10-01",
    });
    expect(route("#/calendar/event/evt_1?key=20261001T090000")).toEqual({
      name: "calendar-event",
      eventId: "evt_1",
    });
    expect(matchRoute("#/calendar/new?date=2026-10-01").query.get("date")).toBe("2026-10-01");
    expect(route("#/calendar/new")).toEqual({ name: "calendar-event" });
    expect(route("#/account/close")).toEqual({ name: "close" });
    expect(route("#/domains/dom_1")).toEqual({ name: "domain", domainId: "dom_1" });
    expect(route("#/nonsense/path")).toEqual({ name: "view" });
    expect(route("#/thread/%E0%A4%A")).toEqual({ name: "thread", threadId: "%E0%A4%A" });
  });

  it("[X01] fallbacks: a thread with no id is the Imbox, domains with no id is admin, unknown is the Imbox", () => {
    expect(route("#/thread")).toEqual({ name: "view" });
    expect(route("#/domains")).toEqual({ name: "admin" });
    expect(route("#/account/other")).toEqual({ name: "admin" });
    expect(route("#/mail")).toEqual({ name: "view" });
    expect(matchRoute("#/mail/imbox?x=1").path).toBe("/mail/imbox");
    // Every row resolves to itself: no row is shadowed by an earlier, less specific one.
    for (const [pattern, name] of WEB_ROUTES) {
      const sample = pattern.replace(/:(\w+)\??/g, "x");
      expect([pattern, matchRoute(`#/${sample}`).name]).toEqual([pattern, name]);
    }
  });
});

describe("calendar editor", () => {
  it("[C03] builds weekly recurrence with interval, days and count", () => {
    expect(
      buildRRule({
        frequency: "WEEKLY",
        interval: 2,
        byDay: ["MO", "WE", "MO", "XX"],
        ends: { kind: "count", count: 5 },
        allDay: false,
      }),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5");
    expect(
      buildRRule({
        frequency: "none",
        interval: 1,
        byDay: [],
        ends: { kind: "never" },
        allDay: false,
      }),
    ).toBeUndefined();
    expect(
      buildRRule({
        frequency: "DAILY",
        interval: 1,
        byDay: [],
        ends: { kind: "until", until: { year: 2026, month: 12, day: 31 } },
        allDay: true,
      }),
    ).toBe("FREQ=DAILY;UNTIL=20261231");
  });

  it("[C02] turns a valid form into a CreateEvent command with wall-clock time, attendees and reminders", () => {
    const built = eventPayload(
      form({
        attendees: "A@x.com, b@y.org a@x.com",
        reminders: "30, 10, 10",
        location: " Room 1 ",
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toMatchObject({
      type: "CreateEvent",
      calendarId: "c1",
      start: {
        kind: "timed",
        tzid: "Europe/London",
        local: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 },
      },
      data: { summary: "Standup", location: "Room 1" },
      attendees: [{ address: "a@x.com" }, { address: "b@y.org" }],
      alarms: [10, 30],
    });
  });

  it("[C02] rejects end-before-start, bad times, bad reminders and bad attendees", () => {
    const built = eventPayload(
      form({ title: " ", end: "2026-10-01T08:00", reminders: "soon", attendees: "not-an-address" }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.map((e) => e.field).sort()).toEqual([
      "attendees",
      "end",
      "reminders",
      "title",
    ]);
    expect(eventPayload(form({ start: "2026-13-01T25:00" })).ok).toBe(false);
  });

  it("[C03] all-day events are dates, not midnight instants; edits carry an explicit scope", () => {
    const allDay = eventPayload(form({ allDay: true, start: "2026-10-01", end: "2026-10-02" }));
    expect(allDay.ok && allDay.command.start).toEqual({
      kind: "date",
      date: { year: 2026, month: 10, day: 1 },
    });
    const edit = updatePayload("evt_1", 3, "this", "20261001T090000", form({ frequency: "DAILY" }));
    expect(edit.ok && edit.command).toMatchObject({
      type: "UpdateEvent",
      eventId: "evt_1",
      expectedRevision: 3,
      scope: "this",
      occurrenceKey: "20261001T090000",
    });
    expect(edit.ok && "rrule" in (edit.command.changes as object)).toBe(false);
    const series = updatePayload(
      "evt_1",
      3,
      "series",
      "20261001T090000",
      form({ frequency: "DAILY" }),
    );
    expect(series.ok && series.command).toMatchObject({
      scope: "series",
      changes: { rrule: "FREQ=DAILY" },
    });
    expect(series.ok && "occurrenceKey" in series.command).toBe(false);
  });

  it("[C01] week starts honour the first-weekday preference and month grids are whole weeks", () => {
    const thu = { year: 2026, month: 10, day: 1 };
    expect(weekStart(thu, 1)).toEqual({ year: 2026, month: 9, day: 28 });
    expect(weekStart(thu, 0)).toEqual({ year: 2026, month: 9, day: 27 });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    const grid = monthGrid(2026, 10, 1);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    expect(grid[0]![0]).toEqual({ year: 2026, month: 9, day: 28 });
    expect(nightHours(undefined)).toEqual({
      before: 420,
      after: 120,
      waking: { startMinute: 420, endMinute: 1320 },
    });
  });
});

describe("composer helpers", () => {
  it("[E17] sanitizes rich text and derives a plain-text alternative", () => {
    const body = composeBody(
      '<p>Hello <b>there</b><script>alert(1)</script><img src="https://t.example/p.gif"></p>',
    );
    expect(body.html).not.toContain("<script");
    expect(body.html).not.toContain("t.example");
    expect(body.text).toContain("Hello there");
  });

  it("[E17] a reopened draft keeps its inline images: cid refs survive sanitizing and are shown from local copies", () => {
    const saved = composeBody(
      '<p>Logo <img src="cid:up_logo" alt="logo"> and <img src="cid:up_gone" alt="gone"></p>',
    ).html;
    expect(saved).toContain('src="cid:up_logo"');
    const doc = new JSDOM(`<body>${saved}</body>`).window.document;
    restoreInlineImages(doc, { up_logo: new Blob(["png"]) }, () => "blob:local/1");
    const [logo, gone] = [...doc.querySelectorAll("img")];
    expect(logo?.getAttribute("src")).toBe("blob:local/1");
    expect(logo?.getAttribute("data-cid")).toBe("up_logo");
    expect(gone?.hasAttribute("src")).toBe(false);
    expect(gone?.getAttribute("data-cid")).toBe("up_gone");
  });

  it("[E17] parses recipients, expands groups, dedupes and flags invalid entries", () => {
    const r = parseRecipients(
      "Ana <ana@bye.test>; bob@bye.test, @group:Team, ana@BYE.test, nope, @group:Missing",
      {
        Team: [{ address: "carol@bye.test" }, { address: "bob@bye.test" }],
      },
    );
    expect(r.recipients).toEqual([
      { name: "Ana", address: "ana@bye.test" },
      { address: "bob@bye.test" },
      { address: "carol@bye.test" },
    ]);
    expect(r.invalid).toEqual(["nope", "@group:Missing"]);
  });

  it("[E17] signatures and snippets are idempotent and unknown snippets are kept", () => {
    const once = withSignature("Hi", "Ana");
    expect(withSignature(once, "Ana")).toBe(once);
    expect(expandSnippets("Thanks ;;sig and ;;nope", { sig: "— Ana" })).toBe(
      "Thanks — Ana and ;;nope",
    );
  });

  it("[E20] multipart upload ranges cover the file exactly", () => {
    expect(partRanges(0, 5)).toEqual([]);
    expect(partRanges(11, 5)).toEqual([
      { part: 1, start: 0, end: 5 },
      { part: 2, start: 5, end: 10 },
      { part: 3, start: 10, end: 11 },
    ]);
  });
});

describe("paging", () => {
  it("[E04] appends pages without duplicating rows that changed between pages", () => {
    let paged = emptyPaged<{ id: string; v: number }>();
    expect(nextPageQuery(paged)).toBe("limit=50");
    paged = appendPage(
      paged,
      {
        items: [
          { id: "a", v: 1 },
          { id: "b", v: 1 },
        ],
        nextCursor: "c1",
      },
      (x) => x.id,
    );
    expect(nextPageQuery(paged, 20)).toBe("limit=20&cursor=c1");
    paged = appendPage(
      paged,
      {
        items: [
          { id: "b", v: 2 },
          { id: "c", v: 1 },
        ],
        nextCursor: null,
      },
      (x) => x.id,
    );
    expect(paged.items).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "c", v: 1 },
    ]);
    expect(nextPageQuery(paged)).toBeNull();
  });
});

describe("world editor text", () => {
  it("always escapes: a '<' in prose never switches to raw HTML", () => {
    expect(textToHtml("a < b & <script>x</script>")).toBe(
      "<p>a &lt; b &amp; &lt;script&gt;x&lt;/script&gt;</p>",
    );
    expect(textToHtml("one\n\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });
});

describe("named degradations", () => {
  it("degrade falls back for panel failures but never masks sign-out or aborts", async () => {
    await expect(
      Promise.reject(new ByeApiError(503, "unavailable", "down")).catch(degrade([])),
    ).resolves.toEqual([]);
    await expect(
      Promise.reject(new ByeApiError(403, "forbidden", "no")).catch(degrade(null)),
    ).resolves.toBeNull();
    await expect(
      Promise.reject(new ByeApiError(401, "unauthorized", "signed out")).catch(degrade([])),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      Promise.reject(new DOMException("aborted", "AbortError")).catch(degrade([])),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(Promise.reject(new Error("x")).catch(bestEffort)).resolves.toBeUndefined();
  });
});

describe("calendar navigation", () => {
  const d = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return { year: year!, month: month!, day: day! };
  };
  const walk = (view: Parameters<typeof step>[0], from: string, dir: 1 | -1, times: number) => {
    const out: Array<string> = [];
    let at = d(from);
    for (let i = 0; i < times; i++) out.push(ymd((at = step(view, at, dir))));
    return out;
  };

  it("[C01] week and agenda pages step by whole weeks across DST changes and year ends", () => {
    // 2026-03-08 (US) and 2026-03-29 (EU) are DST transitions; calendar dates must not drift.
    expect(walk("week", "2026-03-01", 1, 5)).toEqual([
      "2026-03-08",
      "2026-03-15",
      "2026-03-22",
      "2026-03-29",
      "2026-04-05",
    ]);
    expect(walk("week", "2026-11-05", -1, 1)).toEqual(["2026-10-29"]);
    expect(walk("agenda", "2026-12-25", 1, 1)).toEqual(["2027-01-08"]);
    expect(walk("day", "2026-10-25", 1, 2)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(walk("day", "2028-03-01", -1, 1)).toEqual(["2028-02-29"]);
  });

  it("[C01] month pages land on the 1st, so month-end anchors never skip a short month", () => {
    expect(walk("month", "2026-01-31", 1, 3)).toEqual(["2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(walk("month", "2026-11-30", 1, 3)).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(walk("month", "2026-02-28", -1, 3)).toEqual(["2026-01-01", "2025-12-01", "2025-11-01"]);
    expect(walk("year", "2026-07-04", -1, 1)).toEqual(["2025-01-01"]);
  });

  it("[C01] the loaded range covers every day the view shows", () => {
    expect(range("day", d("2026-10-01"), 1)).toEqual({ from: d("2026-10-01"), days: 1 });
    // 2026-10-01 is a Thursday: Monday-first weeks open on 09-28, Sunday-first on 09-27.
    expect(range("week", d("2026-10-01"), 1)).toEqual({ from: d("2026-09-28"), days: 7 });
    expect(range("week", d("2026-10-01"), 0)).toEqual({ from: d("2026-09-27"), days: 7 });
    for (const [year, month] of [
      [2026, 2],
      [2026, 3],
      [2026, 8],
      [2027, 1],
    ] as const) {
      for (const firstWeekday of [0, 1, 6]) {
        const { from, days } = range("month", { year, month, day: 15 }, firstWeekday);
        const shown = monthGrid(year, month, firstWeekday).flat().map(ymd);
        const loaded = Array.from({ length: days }, (_, i) => ymd(addDays(from, i)));
        expect(loaded.slice(0, shown.length)).toEqual(shown);
      }
    }
  });
});

describe("service worker caching policy", () => {
  const origin = "https://app.bye.test";

  it("[X01] never answers API routes, writes or other origins", () => {
    expect(servesFromShell("GET", `${origin}/v1/me`, origin)).toBe(false);
    expect(
      servesFromShell("GET", `${origin}/v1/mailboxes/mbx_1/views/imbox?cursor=a`, origin),
    ).toBe(false);
    expect(servesFromShell("POST", `${origin}/index.html`, origin)).toBe(false);
    expect(servesFromShell("GET", "https://render.bye.test/app.js", origin)).toBe(false);
  });

  it("[X01] never answers authenticated Worker routes outside /v1/", () => {
    for (const path of [
      "/auth/logout",
      "/oauth/authorize?client_id=bye-desktop",
      "/render/tok_1",
      "/img?u=https%3A%2F%2Fexample.net%2Fa.png",
      "/feeds/cal_1.ics",
      "/webhooks/billing",
      "/.well-known/apple-app-site-association",
    ])
      expect(servesFromShell("GET", `${origin}${path}`, origin)).toBe(false);
    expect(SHELL).toMatch(/^bye-shell-/);
  });

  it("[X01] serves the static shell (network first, cache fallback)", () => {
    for (const asset of ASSETS)
      expect(servesFromShell("GET", `${origin}${asset}`, origin)).toBe(true);
    expect(ASSETS.some((a) => a.startsWith("/v1"))).toBe(false);
    expect(ASSETS).toContain("/index.html");
  });
});
