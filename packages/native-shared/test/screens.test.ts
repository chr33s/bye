import { describe, expect, it } from "vitest";
import { ByeClient, countNewForYou, widgetSnapshot } from "../src/client.ts";
import { parseRoute } from "../src/routes.ts";

describe("native screen routes", () => {
  it("[X01] planning, settings and new-event routes resolve like the PWA hashes", () => {
    expect(parseRoute("#/calendar/planning")).toEqual({ screen: "planning" });
    expect(parseRoute("#/settings")).toEqual({ screen: "settings" });
    expect(parseRoute("#/devices")).toEqual({ screen: "settings" });
    expect(parseRoute("#/calendar/new?date=2026-10-01")).toEqual({
      screen: "event",
      date: "2026-10-01",
    });
    const fallback = parseRoute("#/calendar/new?date=tomorrow");
    expect(fallback.screen === "event" && /^\d{4}-\d{2}-\d{2}$/.test(fallback.date)).toBe(true);
    expect(parseRoute("#/calendar")).toEqual({ screen: "calendar" });
  });
});

describe("widget snapshot", () => {
  it("[C07] picks the next future event and carries the active timer", () => {
    const now = 1_000;

    const snap = widgetSnapshot(
      {
        upcoming: [
          { startMs: 500, data: { summary: "Past" } },
          { startMs: 3_000, data: { summary: "Later" } },
          { startMs: 2_000, data: { summary: "Next" } },
        ],
        activeTimer: { label: "Writing", startedAt: 900 },
      },
      4,
      now,
    );

    expect(snap).toEqual({
      nextEvent: { title: "Next", startMs: 2_000 },
      timer: { label: "Writing", startedAtMs: 900 },
      unseen: 4,
    });
    expect(widgetSnapshot(null, 0, now)).toEqual({ nextEvent: null, timer: null, unseen: 0 });

    // The unseen count is the Imbox's new-for-you threads, not a constant.
    const imbox = {
      items: [{ newForYou: true }, { newForYou: false }, { newForYou: true }],
    } as never;

    expect(widgetSnapshot(null, countNewForYou(imbox), now).unseen).toBe(2);
    expect(countNewForYou(null)).toBe(0);
  });
});

describe("native client", () => {
  it("[E05][A03] triage and device calls hit the documented routes with idempotent commands", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let rejectNext = true;

    const client = new ByeClient({
      origin: "https://app.bye.test",
      // The first request meets an expired access token: the client refreshes and retries it.
      auth: { token: async () => "tok", onUnauthorized: async () => "tok2" },
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        const status = rejectNext ? 401 : 200;
        rejectNext = false;

        return new Response(JSON.stringify({ items: [], revoked: true }), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.trash("mbx_1", ["thr_1"]);
    await client.revokeDevice("dev/1");
    await client.calendarCommand("cal_1", { type: "StopTimer" });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({
      url: "https://app.bye.test/v1/mailboxes/mbx_1/commands",
      method: "POST",
      body: { _tag: "MoveToTrash", threadIds: ["thr_1"] },
    });
    // Idempotent: the retried request replays the same body, so the server can dedupe it.
    const trashId = (calls[0]!.body as { commandId?: string }).commandId;
    expect(trashId).toBeTruthy();
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toMatchObject({
      url: "https://app.bye.test/v1/devices/dev%2F1",
      method: "DELETE",
    });
    expect(calls[3]).toMatchObject({
      url: "https://app.bye.test/v1/calendars/cal_1/commands",
      body: { schemaVersion: 1, command: { type: "StopTimer" } },
    });
    const calendarId = (calls[3]!.body as { command: { commandId?: string } }).command.commandId;
    expect(calendarId).toBeTruthy();
    expect(calendarId).not.toBe(trashId);
  });
});
