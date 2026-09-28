// Calendar cover panel (C09): optional, collapsible, today's agenda and the next event, a link into
// the calendar, and a persisted "hide" — with loading, empty and error states.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jsdom = new JSDOM(
  '<!doctype html><body><main id="main"></main><p id="status" role="status"></p></body>',
  { url: "https://bye.example.test/" },
);

Object.assign(globalThis, {
  window: jsdom.window,
  document: jsdom.window.document,
  location: jsdom.window.location,
  history: jsdom.window.history,
  HTMLElement: jsdom.window.HTMLElement,
  Node: jsdom.window.Node,
  Event: jsdom.window.Event,
  localStorage: jsdom.window.localStorage,
});

const { coverPanel, coverPanelEnabled } = await import("../src/views/cover-panel.ts");

const { state } = await import("../src/core/state.ts");

type Reply = { status?: number; body: unknown };

let calls: Array<{ method: string; path: string; body: unknown }> = [];

let reply: (method: string, path: string) => Reply | Promise<Reply>;

beforeEach(() => {
  calls = [];
  state.mailboxId = "mbx_1";
  state.calendarId = "space_1";
  localStorage.clear();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({
      method: init.method ?? "GET",
      path: `${u.pathname}${u.search}`,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = await reply(init.method ?? "GET", u.pathname);

    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Wait for the panel's async load to finish (the body drops aria-busy when it is done). */
const loaded = async (panel: HTMLElement) => {
  for (let i = 0; i < 50 && panel.querySelector(".cover-body[aria-busy]"); i++) await settle();
};

const NOW = new Date(2026, 8, 28, 12, 0).getTime();

const at = (h: number, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h).getTime();

const occ = (eventId: string, startMs: number, allDay = false) => ({
  eventId,
  calendarId: "cal_a",
  key: `${eventId}-k`,
  startMs,
  endMs: startMs + 3_600_000,
  allDay,
  data: { summary: `${eventId} title` },
});

describe("calendar cover panel (web)", () => {
  it("[C09] is off unless the calendarPanel preference is on, and needs a calendar", async () => {
    reply = () => ({ body: { preferences: { calendarPanel: true } } });
    expect(await coverPanelEnabled(new AbortController().signal)).toBe(true);
    expect(calls[0]!.path).toBe("/v1/mailboxes/mbx_1/preferences");
    reply = () => ({ body: { preferences: { calendarPanel: false } } });
    expect(await coverPanelEnabled(new AbortController().signal)).toBe(false);
    // A failed preference read degrades to "no panel" rather than breaking the Imbox.
    reply = () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } });
    expect(await coverPanelEnabled(new AbortController().signal)).toBe(false);
    state.calendarId = null;
    calls = [];
    expect(await coverPanelEnabled(new AbortController().signal)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("[C09] shows a labelled loading state, then today's agenda, the next event and a calendar link", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reply = async () => {
      await gate;

      return {
        body: {
          schemaVersion: 1,
          occurrences: [occ("later", at(15)), occ("holiday", at(0), true), occ("morning", at(9))],
        },
      };
    };

    const panel = coverPanel(() => NOW);
    document.body.append(panel);
    const title = panel.querySelector("summary")!;
    expect(panel.tagName).toBe("ASIDE");
    expect(panel.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.textContent).toBe("Today's calendar");
    expect(panel.querySelector("details")!.open).toBe(true);
    expect(panel.querySelector(".cover-body")!.getAttribute("aria-busy")).toBe("true");
    expect(panel.querySelector('[role="status"]')!.textContent).toBe("Loading your calendar…");

    release();
    await loaded(panel);
    expect(panel.querySelector(".cover-body")!.hasAttribute("aria-busy")).toBe(false);

    const today = [...panel.querySelectorAll('ul[aria-label="Today\'s events"] li')].map(
      (li) => li.textContent,
    );

    expect(today).toHaveLength(3);
    expect(today[0]).toContain("All day");
    expect(today[0]).toContain("holiday title");
    expect(today[1]).toContain("morning title");

    const links = [...panel.querySelectorAll("a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);

    expect(links).toContainEqual(["Open calendar", "#/calendar/day/2026-09-28"]);

    const next = [...panel.querySelectorAll("h2")].find(
      (h) => h.textContent === "Next",
    )!.nextElementSibling!;

    expect(next.textContent).toContain("later title");
    expect(next.querySelector("a")!.getAttribute("href")).toBe(
      "#/calendar/event/later?key=later-k&cal=cal_a",
    );
    const window = calls.find((c) => c.path.startsWith("/v1/calendars/space_1/events"))!;
    const q = new URLSearchParams(window.path.split("?")[1]);
    expect(Date.parse(q.get("from")!)).toBe(at(0));
    expect(Date.parse(q.get("to")!)).toBe(at(0, 8));
    panel.remove();
  });

  it("[C09] empty day and nothing ahead get plain-language empty states", async () => {
    reply = () => ({ body: { schemaVersion: 1, occurrences: [] } });
    const panel = coverPanel(() => NOW);
    await loaded(panel);
    expect(panel.textContent).toContain("Nothing on your calendar today.");
    expect(panel.textContent).toContain("Nothing else coming up this week.");
    expect(panel.querySelector("ul")).toBeNull();
  });

  it("[C09] a failed load shows an alert with a retry that recovers", async () => {
    let fail = true;
    reply = () =>
      fail
        ? { status: 503, body: { error: { code: "unavailable", message: "Calendar is down" } } }
        : { body: { schemaVersion: 1, occurrences: [occ("later", at(15))] } };
    const panel = coverPanel(() => NOW);
    await loaded(panel);
    const alert = panel.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Calendar unavailable: Calendar is down");
    fail = false;
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click();
    await loaded(panel);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.textContent).toContain("later title");
  });

  it("[C09] collapsing is remembered in this browser; hiding saves the preference and removes the panel", async () => {
    reply = (method) =>
      method === "POST" ? { body: { ok: true } } : { body: { schemaVersion: 1, occurrences: [] } };
    const panel = coverPanel(() => NOW);
    document.body.append(panel);
    await loaded(panel);
    const details = panel.querySelector("details")!;
    details.open = false;
    details.dispatchEvent(new jsdom.window.Event("toggle"));
    expect(localStorage.getItem("bye:coverPanelCollapsed")).toBe("1");
    expect(coverPanel(() => NOW).querySelector("details")!.open).toBe(false);

    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Hide panel")!.click();

    for (let i = 0; i < 50 && panel.isConnected; i++) await settle();
    const command = calls.find((c) => c.method === "POST")!;
    expect(command.path).toBe("/v1/mailboxes/mbx_1/commands");
    expect(command.body).toMatchObject({
      _tag: "SetPreference",
      key: "calendarPanel",
      value: false,
    });
    expect(panel.isConnected).toBe(false);
    expect(document.getElementById("status")!.textContent).toContain("turn it back on in Settings");
  });
});
