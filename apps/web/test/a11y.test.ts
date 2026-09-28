/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { build } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

// §13 accessibility: the production bundle (built exactly as build.ts does, but as an IIFE so it
// can run in jsdom) renders each screen against a stubbed API, and axe-core (pinned) must report
// no WCAG 2.x A/AA violations. Colour contrast needs layout, which jsdom lacks, so it is disabled.

const root = fileURLToPath(new URL("..", import.meta.url));

let bundle = "";

beforeAll(async () => {
  const out = await build({
    input: `${root}src/main.ts`,
    platform: "browser",
    write: false,
    output: { format: "iife", minify: true },
  });

  bundle = out.output[0].code;
}, 60_000);

type Stub = (method: string, path: string) => { status: number; body: unknown };

const me = { userId: "usr_1", mailboxIds: ["mbx_1"], calendarIds: ["cal_1"] };

const threads = [
  {
    threadId: "thr_1",
    subject: "Quarterly numbers",
    sender: "Bob <bob@example.net>",
    newForYou: true,
    revision: 1,
    bundleCount: 0,
    lastActivityAt: Date.UTC(2026, 8, 25),
    snippet: "See attached",
  },
  {
    threadId: "thr_2",
    subject: "Lunch",
    sender: "ana@example.net",
    newForYou: false,
    revision: 3,
    bundleCount: 2,
    lastActivityAt: Date.UTC(2026, 8, 24),
  },
];

const signedIn: Stub = (_method, path) => {
  if (path === "/v1/me") return { status: 200, body: me };

  if (path.includes("/views/"))
    return { status: 200, body: { items: threads, nextCursor: null, boundary: 10 } };

  return { status: 200, body: { items: [] } };
};

const render = async (hash: string, stub: Stub) => {
  const html = readFileSync(`${root}public/index.html`, "utf8").replace(
    /<script[^>]*src="https:[^"]*"[^>]*><\/script>/g,
    "",
  );

  const dom = new JSDOM(html, {
    url: `https://app.bye.test/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const window = dom.window as typeof dom.window &
    typeof globalThis & { eval(code: string): void; axe: typeof axe };

  Object.defineProperty(window, "fetch", {
    value: async (input: string, init?: RequestInit) => {
      const r = stub(init?.method ?? "GET", new URL(input, "https://app.bye.test").pathname);

      return new Response(
        JSON.stringify(
          r.status >= 400 ? { error: { code: "unauthenticated", message: "Sign in" } } : r.body,
        ),
        { status: r.status, headers: { "content-type": "application/json" } },
      );
    },
  });
  Object.defineProperty(window, "WebSocket", {
    value: class {
      addEventListener() {}
      close() {}
      send() {}
    },
  });
  window.eval(bundle);

  // Let the async route() settle.
  for (
    let i = 0;
    i < 20 && window.document.querySelector("main p")?.textContent === "Loading…";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  window.eval(axe.source);

  const result = await window.axe.run(window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });

  return {
    window,
    violations: result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  };
};

describe("a11y (axe-core 4.13.0, WCAG 2.1 A/AA)", () => {
  it("the harness detects a known violation (guards against a silently passing setup)", async () => {
    const { window } = await render("#/mail/imbox", () => ({ status: 401, body: null }));
    window.document.body.append(
      Object.assign(window.document.createElement("img"), { src: "x.png" }),
    );

    const result = await window.axe.run(window.document, {
      runOnly: { type: "rule", values: ["image-alt"] },
    });

    expect(result.violations.map((v) => v.id)).toEqual(["image-alt"]);
  });

  it("signed-out screen", async () => {
    const { window, violations } = await render("#/mail/imbox", () => ({
      status: 401,
      body: null,
    }));

    expect(window.document.querySelector("#auth-title")?.textContent).toBe("Sign in");
    expect(violations).toEqual([]);
  });

  it("imbox with new and previously seen threads", async () => {
    const { window, violations } = await render("#/mail/imbox", signedIn);
    expect(window.document.querySelector("#view-title")).not.toBeNull();
    expect(violations).toEqual([]);
  });

  it("[C09] imbox with the calendar cover panel", async () => {
    const start = new Date();
    start.setHours(23, 0, 0, 0);

    const { window, violations } = await render("#/mail/imbox", (method, path) => {
      if (path.endsWith("/preferences"))
        return { status: 200, body: { preferences: { calendarPanel: true } } };

      if (path.endsWith("/events"))
        return {
          status: 200,
          body: {
            schemaVersion: 1,
            occurrences: [
              {
                eventId: "evt_1",
                calendarId: "cal_a",
                key: "k1",
                startMs: start.getTime(),
                endMs: start.getTime() + 1_800_000,
                allDay: false,
                data: { summary: "Standup" },
              },
            ],
          },
        };

      return signedIn(method, path);
    });

    const panel = window.document.querySelector("aside.cover-panel");
    expect(panel?.textContent).toContain("Standup");
    expect(panel?.textContent).toContain("Open calendar");
    expect(violations).toEqual([]);
  });

  it("[C09] thread with an invitation and create-event-from-message", async () => {
    const { window, violations } = await render("#/thread/thr_1", (method, path) => {
      if (path === "/v1/mailboxes/mbx_1/threads/thr_1")
        return {
          status: 200,
          body: {
            thread: { threadId: "thr_1", subject: "Invitation: Standup", revision: 1 },
            deliveries: [
              {
                deliveryId: "dlv_1",
                from: { address: "ana@example.net" },
                date: Date.UTC(2026, 8, 25),
                renderUrl: "https://mail.bye.test/r/1",
                attachments: [],
                scan: { status: "clean" },
                routing: { hasCalendar: true, calendarMethod: "REQUEST" },
              },
            ],
          },
        };

      if (path.endsWith("/invitations"))
        return {
          status: 200,
          body: {
            schemaVersion: 1,
            invitations: [
              {
                eventId: "evt_1",
                calendarId: "cal_a",
                uid: "u1",
                summary: "Standup",
                recurring: true,
                occurrenceKey: "20261012T090000",
                start: { kind: "date", date: { year: 2026, month: 10, day: 12 } },
                end: { kind: "date", date: { year: 2026, month: 10, day: 13 } },
                cancelled: false,
                organizer: { address: "ana@example.net" },
                partstat: "DECLINED",
              },
            ],
          },
        };

      return signedIn(method, path);
    });

    const invitation = window.document.querySelector('[aria-label="Invitation"]');
    expect(invitation?.textContent).toContain("Standup (this occurrence)");
    expect(invitation?.textContent).toContain("Declined");
    expect([...(invitation?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Accept",
      "Maybe",
      "Decline",
    ]);
    expect(window.document.querySelector("details summary")?.textContent).toBe(
      "Create event from this message",
    );
    expect(violations).toEqual([]);
  });

  it("compose", async () => {
    const { violations } = await render("#/compose", signedIn);
    expect(violations).toEqual([]);
  });

  it("error state", async () => {
    const { violations } = await render("#/mail/imbox", () => ({ status: 500, body: null }));
    expect(violations).toEqual([]);
  });
});
