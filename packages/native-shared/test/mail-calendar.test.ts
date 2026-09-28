import { describe, expect, it } from "vitest";
import { ByeClient } from "../src/client.ts";
import {
  calendarPanelEnabled,
  coverAgenda,
  coverTimeText,
  coverWindow,
  firstCalendarId,
  findThreadInvitations,
  fromMessagePayload,
  invitationEvents,
  invitationTitle,
  RSVP_CHOICES,
} from "../src/mail-calendar.ts";

// C09 email/calendar integration shared by web and native: invitation actions, create-event-from-
// message and the calendar cover panel.

const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h, m).getTime();

const occ = (eventId: string, startMs: number, endMs: number, allDay = false, key = "k") => ({
  eventId,
  calendarId: "cal_a",
  key,
  startMs,
  endMs,
  allDay,
  data: { summary: eventId },
});

describe("invitation actions", () => {
  it("[C09] strips invitation prefixes and offers accept / tentative / decline", () => {
    expect(invitationTitle("Invitation: Standup")).toBe("Standup");
    expect(invitationTitle("Updated invitation:  Planning ")).toBe("Planning");
    expect(invitationTitle("Lunch?")).toBe("Lunch?");
    expect(RSVP_CHOICES.map(([p]) => p)).toEqual(["ACCEPTED", "TENTATIVE", "DECLINED"]);
  });

  it("[C09] takes the event ID from the hit's docId, never its calendar ref, once per event", () => {
    const events = invitationEvents([
      { docId: "event:evt_1", kind: "event", ref: "cal_a", snippet: "[Standup] daily" },
      { docId: "event:evt_1", kind: "event", ref: "cal_a", snippet: "dup" },
      { docId: "task:t1", kind: "task", ref: "2026-09-28", snippet: "Standup notes" },
      { kind: "event", ref: "cal_a", snippet: "no doc id" },
      { docId: "event:", kind: "event", ref: "cal_a", snippet: "empty" },
    ]);

    expect(events).toEqual([{ eventId: "evt_1", snippet: "[Standup] daily" }]);
  });
});

describe("create event from message", () => {
  const base = {
    calendarId: "cal_a",
    mailboxId: "mbx_1",
    threadId: "thr_1",
    deliveryId: "dlv_1",
    title: " Review ",
    start: "2026-09-28T10:00",
    end: "2026-09-28T11:00",
    timeZone: "Europe/London",
  };

  it("[C09] builds a wall-clock request that carries the message backlink", () => {
    const built = fromMessagePayload(base);
    expect(built).toEqual({
      ok: true,
      body: {
        calendarId: "cal_a",
        message: { mailboxId: "mbx_1", threadId: "thr_1", deliveryId: "dlv_1" },
        title: "Review",
        start: {
          kind: "timed",
          tzid: "Europe/London",
          local: { year: 2026, month: 9, day: 28, hour: 10, minute: 0, second: 0 },
        },
        end: {
          kind: "timed",
          tzid: "Europe/London",
          local: { year: 2026, month: 9, day: 28, hour: 11, minute: 0, second: 0 },
        },
      },
    });
    const { deliveryId: _omit, ...noDelivery } = base;
    const withoutDelivery = fromMessagePayload(noDelivery);
    expect(withoutDelivery.ok && withoutDelivery.body.message).toEqual({
      mailboxId: "mbx_1",
      threadId: "thr_1",
    });
  });

  it("[C09] rejects a missing title, bad times and an end before the start", () => {
    const bad = fromMessagePayload({ ...base, title: " ", start: "tomorrow", end: base.start });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual(["title: Add a title", "start: Use YYYY-MM-DDTHH:mm"]);
    const backwards = fromMessagePayload({ ...base, end: "2026-09-28T09:00" });
    expect(!backwards.ok && backwards.errors).toEqual(["end: Ends before it starts"]);
  });

  it("[C09] picks the first calendar whichever ID field the list route uses", () => {
    expect(firstCalendarId([{ calendarId: "a" }, { id: "b" }])).toBe("a");
    expect(firstCalendarId([{ id: "b" }])).toBe("b");
    expect(firstCalendarId([])).toBeNull();
  });
});

describe("calendar cover panel", () => {
  it("[C09] lists today's events (all-day first) and the next timed event not yet started", () => {
    const now = at(12);

    const agenda = coverAgenda(
      [
        occ("later-today", at(15), at(16)),
        occ("tomorrow", at(9, 0, 1), at(10, 0, 1)),
        occ("this-morning", at(9), at(10)),
        occ("holiday", at(0), at(0, 0, 1), true),
        occ("yesterday", at(9, 0, -1), at(10, 0, -1)),
        occ("overnight", at(22, 0, -1), at(2)),
        occ("later-today", at(15), at(16)),
      ],
      now,
    );

    expect(agenda.today.map((o) => o.eventId)).toEqual([
      "holiday",
      "overnight",
      "this-morning",
      "later-today",
    ]);
    expect(agenda.next?.eventId).toBe("later-today");
  });

  it("[C09] empty today still finds the next event; nothing ahead is null", () => {
    const now = at(18);
    expect(coverAgenda([occ("tomorrow", at(9, 0, 1), at(10, 0, 1))], now)).toMatchObject({
      today: [],
      next: { eventId: "tomorrow" },
    });
    expect(coverAgenda([occ("earlier", at(9), at(10))], now).next).toBeNull();
    expect(coverAgenda([], now)).toEqual({ today: [], next: null });
  });

  it("[C09] loads from local midnight today through the lookahead", () => {
    const { from, to } = coverWindow(at(12));
    expect(from).toBe(at(0));
    expect(to).toBe(at(0, 0, 8));
  });

  it("[C09] the panel is shown only when the calendarPanel preference is on", () => {
    expect(calendarPanelEnabled({ preferences: { calendarPanel: true } })).toBe(true);
    expect(calendarPanelEnabled({ preferences: { calendarPanel: false } })).toBe(false);
    expect(calendarPanelEnabled({ preferences: {} })).toBe(false);
    expect(calendarPanelEnabled({ calendarPanel: true })).toBe(true);
    expect(calendarPanelEnabled({ items: [] })).toBe(false);
    expect(calendarPanelEnabled(null)).toBe(false);
  });
});

describe("native C09 client calls", () => {
  it("[C09] RSVP, search, calendars and create-from-message hit the documented routes", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];

    const client = new ByeClient({
      origin: "https://app.bye.test",
      token: "tok",
      newId: () => "cmd_fixed",
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init.method,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });

        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.calendarSearch("space 1", "Standup", 5);
    await client.respondInvitation("space 1", "evt_1", "TENTATIVE");
    await client.calendars("space 1");

    const built = fromMessagePayload({
      calendarId: "cal_a",
      mailboxId: "mbx_1",
      threadId: "thr_1",
      title: "Review",
      start: "2026-09-28T10:00",
      end: "2026-09-28T11:00",
      timeZone: "UTC",
    });

    if (!built.ok) throw new Error("expected a valid form");
    await client.createEventFromMessage("space 1", built.body);
    expect(calls[0]).toMatchObject({
      url: "https://app.bye.test/v1/calendars/space%201/search?q=Standup&limit=5",
      method: "GET",
    });
    expect(calls[1]).toMatchObject({
      url: "https://app.bye.test/v1/calendars/space%201/commands",
      method: "POST",
      body: {
        schemaVersion: 1,
        command: {
          commandId: "cmd_fixed",
          type: "RespondInvitation",
          eventId: "evt_1",
          partstat: "TENTATIVE",
        },
      },
    });
    expect(calls[1]!.body).not.toHaveProperty("command.occurrenceKey");
    expect(calls[2]).toMatchObject({
      url: "https://app.bye.test/v1/calendars/space%201/calendars",
      method: "GET",
    });
    expect(calls[3]).toMatchObject({
      url: "https://app.bye.test/v1/calendars/space%201/from-message",
      method: "POST",
      body: {
        schemaVersion: 1,
        commandId: "cmd_fixed",
        calendarId: "cal_a",
        message: { mailboxId: "mbx_1", threadId: "thr_1" },
        title: "Review",
      },
    });
  });
});

describe("thread invitations", () => {
  const invitation = {
    eventId: "evt_1",
    calendarId: "cal_a",
    uid: "u1",
    summary: "Standup",
    recurring: true,
    occurrenceKey: "20261012T090000",
    start: { kind: "date" as const, date: { year: 2026, month: 10, day: 12 } },
    end: { kind: "date" as const, date: { year: 2026, month: 10, day: 13 } },
    cancelled: false,
    organizer: { address: "boss@example.com" },
    partstat: "TENTATIVE" as const,
  };

  it("[C09] uses the message lookup: occurrence, current answer and cancellation", async () => {
    const calls: Array<string> = [];

    const found = await findThreadInvitations(
      {
        messageInvitations: async (cal, mbx, dlv) => {
          calls.push(`${cal}/${mbx}/${dlv}`);

          return {
            invitations: [
              invitation,
              { ...invitation, eventId: "evt_2", occurrenceKey: null, cancelled: true },
            ],
          };
        },
        calendarSearch: async () => {
          throw new Error("not used");
        },
      },
      "cal_1",
      "mbx_1",
      "dlv_1",
      "Invitation: Standup",
    );

    expect(calls).toEqual(["cal_1/mbx_1/dlv_1"]);
    expect(found).toEqual([
      {
        eventId: "evt_1",
        occurrenceKey: "20261012T090000",
        label: "Standup (this occurrence)",
        answer: "Maybe",
        cancelled: false,
      },
      {
        eventId: "evt_2",
        occurrenceKey: null,
        label: "Standup (every occurrence)",
        answer: "Maybe",
        cancelled: true,
      },
    ]);
  });

  it("[C09] falls back to a title search on instances without the lookup route", async () => {
    const found = await findThreadInvitations(
      {
        messageInvitations: async () => {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
        calendarSearch: async (_cal, q) => {
          expect(q).toBe("Standup");

          return {
            items: [{ docId: "event:evt_9", kind: "event", ref: "cal_a", snippet: "Standup" }],
          };
        },
      },
      "cal_1",
      "mbx_1",
      "dlv_1",
      "Invitation: Standup",
    );

    expect(found).toEqual([
      { eventId: "evt_9", occurrenceKey: null, label: "Standup", answer: null, cancelled: false },
    ]);

    // A message the instance holds no link for (older mail) also falls back.
    const unlinked = await findThreadInvitations(
      {
        messageInvitations: async () => ({ invitations: [] }),
        calendarSearch: async () => ({
          items: [{ docId: "event:evt_8", kind: "event", ref: "cal_a", snippet: "Standup" }],
        }),
      },
      "cal_1",
      "mbx_1",
      "dlv_1",
      "Invitation: Standup",
    );

    expect(unlinked.map((e) => e.eventId)).toEqual(["evt_8"]);
    // Other failures are not masked by the fallback.
    await expect(
      findThreadInvitations(
        {
          messageInvitations: async () => {
            throw Object.assign(new Error("down"), { status: 503 });
          },
          calendarSearch: async () => ({ items: [] }),
        },
        "cal_1",
        "mbx_1",
        "dlv_1",
        "x",
      ),
    ).rejects.toThrow("down");
  });
});

describe("cover panel times", () => {
  it("[C09] labels all-day, today's and later occurrences", () => {
    const now = at(8);
    expect(coverTimeText({ allDay: true, startMs: at(0) }, now, "en-US")).toBe("All day");
    expect(coverTimeText({ allDay: false, startMs: at(9, 30) }, now, "en-US")).toBe("9:30 AM");
    expect(coverTimeText({ allDay: false, startMs: at(14, 0, 1) }, now, "en-US")).toBe(
      "Tue, Sep 29 2:00 PM",
    );
  });
});
