import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import {
  calAllDay,
  calBuildReply,
  calParseDate,
  calTimed,
  type CalIcsEvent,
} from "@bye/calendar-engine";
import { CalendarFeedFetcher, LocationSearch } from "@bye/application";
import { CalendarCommand, CalendarReadQuery } from "@bye/contracts";
import {
  CALENDAR_ACCESS,
  calendarExecute,
  CalendarStoreError,
  calendarFeedFetcherLive,
  calendarLocationSearchLive,
  calendarRead,
  calendarResolvingFetch,
  CALENDAR_GEOCODER_ENDPOINT,
} from "@bye/platform-cloudflare";
import { makeTestCalendarStore } from "@bye/testing";

const dt = (s: string) => {
  const [d, t = "00:00"] = s.split("T");
  const [year, month, day] = d!.split("-").map(Number);
  const [hour, minute] = t.split(":").map(Number);
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: 0 };
};
const utc = (s: string) => Date.parse(`${s}Z`);
const GUEST = "usr_guest0000000000000000";

const setup = (start = utc("2026-09-25T12:00:00"), zone = "UTC") => {
  const ctx = makeTestCalendarStore({ defaultZone: zone }, start);
  const { calendarId } = ctx.store.createCalendar({
    commandId: ctx.cmd(),
    actor: ctx.owner,
    name: "Personal",
    color: "#f00",
  });
  return { ...ctx, calendarId };
};

describe("calendar time zone (P0 #8, C03)", () => {
  it("[C03] all-day reminders follow the account zone and are rescheduled when it changes", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calAllDay(calParseDate("20261001")),
        end: calAllDay(calParseDate("20261002")),
        data: { summary: "Holiday" },
      },
      alarms: [0],
    });
    // Provisioned zone is UTC: the reminder fires at UTC midnight.
    expect(store.kernel.job("reminder", eventId)!.dueAt).toBe(utc("2026-10-01T00:00:00"));
    store.setPreferences({
      commandId: cmd(),
      actor: owner,
      preferences: { timeZone: "America/New_York" },
    });
    // After the change it fires at local midnight (EDT = UTC-4), not UTC midnight.
    expect(store.kernel.job("reminder", eventId)!.dueAt).toBe(utc("2026-10-01T04:00:00"));
    expect(store.preferences().timeZone).toBe("America/New_York");
    expect(() =>
      store.setPreferences({
        commandId: cmd(),
        actor: owner,
        preferences: { timeZone: "Mars/Olympus" },
      }),
    ).toThrow(CalendarStoreError);
  });

  it("[C03] reminders across DST in America/New_York: nonexistent spring times shift forward, repeated fall times use the first", () => {
    const { store, cmd, owner, calendarId, clock } = setup(
      utc("2026-03-01T00:00:00"),
      "America/New_York",
    );
    const spring = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      // 02:30 does not exist on 8 March 2026 in New York: it resolves to 03:30 EDT (07:30Z).
      series: {
        start: calTimed(dt("2026-03-08T02:30"), "America/New_York"),
        end: calTimed(dt("2026-03-08T03:30"), "America/New_York"),
        data: { summary: "Spring" },
      },
      alarms: [30],
    });
    expect(store.kernel.job("reminder", spring.eventId)!.dueAt).toBe(utc("2026-03-08T07:00:00"));
    const fall = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      // 01:30 happens twice on 1 November 2026: the earlier (EDT, 05:30Z) instant is used.
      series: {
        start: calTimed(dt("2026-11-01T01:30"), "America/New_York"),
        end: calTimed(dt("2026-11-01T02:30"), "America/New_York"),
        data: { summary: "Fall" },
      },
      alarms: [15],
    });
    expect(store.kernel.job("reminder", fall.eventId)!.dueAt).toBe(utc("2026-11-01T05:15:00"));
    const daily = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      // A 09:00 daily meeting keeps its wall-clock time across the spring change.
      series: {
        start: calTimed(dt("2026-03-07T09:00"), "America/New_York"),
        end: calTimed(dt("2026-03-07T09:30"), "America/New_York"),
        rrule: "FREQ=DAILY;COUNT=3",
        data: { summary: "Standup" },
      },
      alarms: [10],
    });
    expect(store.kernel.job("reminder", daily.eventId)!.dueAt).toBe(utc("2026-03-07T13:50:00"));
    const fired = store.kernel.job("reminder", daily.eventId)!;
    clock.advance(fired.dueAt - clock.now() + 1);
    store.runDueJobs();
    // Next occurrence is 8 March 09:00 EDT = 13:00Z, reminder 12:50Z.
    expect(store.kernel.job("reminder", daily.eventId)!.dueAt).toBe(utc("2026-03-08T12:50:00"));
    const notify = store.kernel.pendingOutbox(100).find((e) => e.topic === "calendar.notify")!
      .payload as { title: string; startMs: number };
    expect(notify).toMatchObject({ title: "Standup", startMs: utc("2026-03-07T14:00:00") });
  });
});

describe("calendar read models (C01, C06–C08)", () => {
  it("[C01] agenda, day, month and year views with night-hours state and remembered navigation", () => {
    const { store, cmd, owner, calendarId } = setup();
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-10-01T09:00"), "UTC"),
        end: calTimed(dt("2026-10-01T10:00"), "UTC"),
        data: { summary: "A" },
      },
    });
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-10-01T23:00"), "UTC"),
        end: calTimed(dt("2026-10-01T23:30"), "UTC"),
        data: { summary: "Late" },
      },
    });
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calAllDay(calParseDate("20261002")),
        end: calAllDay(calParseDate("20261004")),
        data: { summary: "Trip" },
      },
    });

    const agenda = calendarRead(store, owner, {
      type: "Agenda",
      from: calParseDate("20261001"),
      days: 7,
    }) as Array<{ date: string; occurrences: Array<{ data: { summary: string } }> }>;
    expect(agenda.map((d) => [d.date, d.occurrences.map((o) => o.data.summary)])).toEqual([
      ["2026-10-01", ["A", "Late"]],
      ["2026-10-02", ["Trip"]],
      ["2026-10-03", ["Trip"]],
    ]);
    store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("20261001"),
      body: "offsite notes",
      expectedRevision: 0,
    });
    const day = calendarRead(store, owner, { type: "Day", date: calParseDate("20261001") }) as {
      nightHoursBusy: boolean;
      nightHoursCollapsed: boolean;
      occurrences: Array<unknown>;
      context: unknown;
    };
    expect(day.occurrences).toHaveLength(2);
    expect(day.nightHoursBusy).toBe(true);
    expect(day.nightHoursCollapsed).toBe(false);
    // Private day context: the owner's journal plus free time inside waking hours (07:00–22:00)
    // around the 09:00–10:00 event; the 23:00 event is outside waking hours.
    expect(day.context).toMatchObject({
      date: "2026-10-01",
      label: undefined,
      journal: { body: "offsite notes", revision: 1 },
      freeTime: [
        { startMs: utc("2026-10-01T07:00:00"), endMs: utc("2026-10-01T09:00:00") },
        { startMs: utc("2026-10-01T10:00:00"), endMs: utc("2026-10-01T22:00:00") },
      ],
      highlights: [],
    });
    const quiet = calendarRead(store, owner, { type: "Day", date: calParseDate("20261005") }) as {
      nightHoursCollapsed: boolean;
    };
    expect(quiet.nightHoursCollapsed).toBe(true);
    expect(calendarRead(store, owner, { type: "Month", year: 2026, month: 10 })).toMatchObject({
      year: 2026,
      month: 10,
      firstWeekday: 1,
      counts: { "2026-10-01": 2, "2026-10-02": 1, "2026-10-03": 1 },
    });
    expect(
      (
        calendarRead(store, owner, { type: "Year", year: 2026 }) as {
          counts: Record<string, number>;
        }
      ).counts["2026-10-01"],
    ).toBe(2);

    store.setPreferences({
      commandId: cmd(),
      actor: owner,
      preferences: { lastView: "month", lastDate: "2026-10-01", nightHoursCollapsed: false },
    });
    expect(calendarRead(store, owner, { type: "Preferences" })).toMatchObject({
      lastView: "month",
      lastDate: "2026-10-01",
      nightHoursCollapsed: false,
    });
    expect(() =>
      store.setPreferences({
        commandId: cmd(),
        actor: owner,
        preferences: { lastDate: "tomorrow" },
      }),
    ).toThrow(CalendarStoreError);
  });

  it("[C06][C07][C08] week tasks, habits, timer, time entries, day context and change feed are readable; private kinds stay owner-only", () => {
    const { store, cmd, owner, calendarId } = setup();
    store.addWeekTask({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("20261001"),
      firstWeekday: 1,
      title: "Taxes",
    });
    const { habitId } = store.createHabit({
      commandId: cmd(),
      actor: owner,
      name: "Run",
      weekdays: [1, 3],
    });
    store.setHabitCompletion({
      commandId: cmd(),
      actor: owner,
      habitId,
      date: calParseDate("20260928"),
      completed: true,
    });
    const { entryId } = store.startTimer({ commandId: cmd(), actor: owner, label: "Writing" });
    store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("20260925"),
      body: "Good day",
      expectedRevision: 0,
    });
    store.setDayDecoration({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("20260925"),
      label: "Launch",
    });

    expect(
      (
        calendarRead(store, owner, { type: "WeekTasks", date: calParseDate("20261001") }) as Array<{
          title: string;
        }>
      ).map((t) => t.title),
    ).toEqual(["Taxes"]);
    expect(
      calendarRead(store, owner, {
        type: "Habits",
        from: calParseDate("20260921"),
        to: calParseDate("20260930"),
      }),
    ).toEqual([{ id: habitId, name: "Run", weekdays: [1, 3], completed: ["2026-09-28"] }]);
    expect(calendarRead(store, owner, { type: "Timer" })).toMatchObject({
      active: { id: entryId, label: "Writing" },
    });
    expect(
      (
        calendarRead(store, owner, {
          type: "TimeEntries",
          from: 0,
          to: Date.now() + 1e12,
        }) as Array<unknown>
      ).length,
    ).toBe(1);
    expect(
      calendarRead(store, owner, { type: "DayContext", date: calParseDate("20260925") }),
    ).toMatchObject({ label: "Launch", journal: { body: "Good day", revision: 1 } });
    const changes = calendarRead(store, owner, { type: "Changes", cursor: 0 }) as {
      changes: Array<unknown>;
      cursor: number;
    };
    expect(changes.changes.length).toBeGreaterThan(3);
    store.archiveHabit({ commandId: cmd(), actor: owner, habitId });
    expect(
      calendarRead(store, owner, {
        type: "Habits",
        from: calParseDate("20260921"),
        to: calParseDate("20260930"),
      }),
    ).toEqual([]);

    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "read",
    });
    for (const q of [
      { type: "WeekTasks", date: calParseDate("20261001") },
      { type: "Habits", from: calParseDate("20260921"), to: calParseDate("20260930") },
      { type: "Timer" },
      { type: "DayContext", date: calParseDate("20260925") },
      { type: "FeedTokens" },
    ] as const) {
      expect(() => calendarRead(store, GUEST, q), q.type).toThrow(/owner-only/);
    }
    // The grantee still sees the shared event calendar and its day view, without private context.
    expect(
      (calendarRead(store, GUEST, { type: "Calendars" }) as Array<{ id: string }>).map((c) => c.id),
    ).toEqual([calendarId]);
    expect(
      (
        calendarRead(store, GUEST, { type: "Day", date: calParseDate("20260925") }) as {
          context: unknown;
        }
      ).context,
    ).toBeUndefined();
  });

  it("[C08] day photos must reference an uploaded calendar-scoped key", () => {
    const { store, cmd, owner } = setup();
    expect(() =>
      store.setDayDecoration({
        commandId: cmd(),
        actor: owner,
        date: calParseDate("20260925"),
        photoKey: "t/other-tenant/orig/x.eml",
      }),
    ).toThrow(/photoKey/);
    store.setDayDecoration({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("20260925"),
      photoKey: "cal/cal_space1/photo/0123456789abcdef0123",
    });
    expect(store.dayContext(calParseDate("20260925")).photoKey).toBe(
      "cal/cal_space1/photo/0123456789abcdef0123",
    );
  });
});

describe("calendar sharing and feeds (C05)", () => {
  it("[C05] grants and revocations are published for the directory index; deleting a calendar revokes its grants", () => {
    const { store, cmd, owner, calendarId } = setup();
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "write",
    });
    store.revokeCalendar({ commandId: cmd(), actor: owner, calendarId, grantee: GUEST });
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "read",
    });
    store.deleteCalendar({ commandId: cmd(), actor: owner, calendarId });
    const grants = store.kernel
      .pendingOutbox(100)
      .filter((e) => e.topic === "calendar.grant")
      .map((e) => [e.target, (e.payload as { role: string | null }).role]);
    expect(grants).toEqual([
      [GUEST, "write"],
      [GUEST, null],
      [GUEST, "read"],
      [GUEST, null],
    ]);
  });

  it("[C05] feed tokens are listed by hash for revocation and never expose the raw token", () => {
    const { store, cmd, owner, calendarId, clock } = setup();
    store.createFeedToken({
      commandId: cmd(),
      actor: owner,
      tokenHash: "a".repeat(64),
      calendarIds: [calendarId],
      label: "Phone",
    });
    const [token] = calendarRead(store, owner, { type: "FeedTokens" }) as Array<{
      tokenHash: string;
      label: string;
      revokedAt?: number;
    }>;
    expect(token).toMatchObject({ tokenHash: "a".repeat(64), label: "Phone" });
    clock.advance(60_000);
    store.revokeFeedToken({ commandId: cmd(), actor: owner, tokenHash: token!.tokenHash });
    expect(
      (calendarRead(store, owner, { type: "FeedTokens" }) as Array<{ revokedAt?: number }>)[0]!
        .revokedAt,
    ).toBe(clock.now());
    expect(store.feedIcs("a".repeat(64))).toBeUndefined();
  });

  it("[C05] subscription fetches refuse hosts that resolve to private or metadata addresses (DNS rebinding)", async () => {
    const doh = (answers: Record<string, Array<string>>) =>
      (async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const name = url.searchParams.get("name")!;
        const type = url.searchParams.get("type");
        const data = (answers[name] ?? []).filter((ip) =>
          type === "AAAA" ? ip.includes(":") : !ip.includes(":"),
        );
        return Response.json({
          Answer: data.map((d) => ({ type: d.includes(":") ? 28 : 1, data: d })),
        });
      }) as typeof fetch;
    const requested: Array<string> = [];
    const origin = (async (input: Parameters<typeof fetch>[0]) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
        headers: { "content-type": "text/calendar" },
      });
    }) as typeof fetch;
    const guarded = calendarResolvingFetch(
      origin,
      doh({
        "evil.example": ["169.254.169.254"],
        "mixed.example": ["93.184.216.34", "10.0.0.5"],
        "good.example": ["93.184.216.34"],
      }),
    );
    const run = (url: string) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const fetcher = yield* CalendarFeedFetcher;
          return yield* fetcher.fetch({
            url,
            etag: undefined,
            lastModified: undefined,
            maxBytes: 1024,
          });
        }).pipe(Effect.provide(calendarFeedFetcherLive(guarded))),
      );
    for (const host of ["evil.example", "mixed.example", "unresolvable.example"]) {
      const exit = await run(`https://${host}/cal.ics`);
      expect(Exit.isFailure(exit), host).toBe(true);
      expect(JSON.stringify(exit), host).toContain("blocked");
    }
    expect(requested).toEqual([]);
    const ok = await run("https://good.example/cal.ics");
    expect(Exit.isSuccess(ok)).toBe(true);
    expect(requested).toEqual(["https://good.example/cal.ics"]);
  });
});

describe("series split mapping for invitations (§9)", () => {
  it("[C04] replies addressed to the original UID reach the split tail; isOrganizerOf follows links", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId, uid } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-10-05T10:00"), "UTC"),
        end: calTimed(dt("2026-10-05T11:00"), "UTC"),
        rrule: "FREQ=DAILY;COUNT=10",
        data: { summary: "Sync" },
      },
      attendees: [{ address: "ann@example.com" }],
    });
    const rev = store.getEvent(owner, eventId).revision;
    const split = store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: rev,
      scope: "future",
      occurrenceKey: "20261010T100000",
      changes: { data: { summary: "Sync v2" } },
    });
    const tailId = split.splitEventId!;
    expect(store.isOrganizerOf(uid)).toBe(true);
    expect(store.isOrganizerOf(store.getEvent(owner, tailId).uid)).toBe(true);
    expect(store.isOrganizerOf("unknown@example.com")).toBe(false);

    // Ann replies to the series under the ORIGINAL UID: both head and tail record her answer.
    const head = store.getEvent(owner, eventId);
    const asIcs: CalIcsEvent = {
      uid,
      sequence: head.sequence,
      dtstamp: utc("2026-09-26T00:00:00"),
      series: head.series,
      organizer: head.organizer,
      attendees: head.attendees,
      alarms: [],
    };
    const result = store.receiveInvitation({
      ingestionId: "ing_split_reply",
      ics: calBuildReply(asIcs, "ann@example.com", "ACCEPTED", utc("2026-09-26T00:00:00")).ics,
      sender: "ann@example.com",
    });
    expect(result[0]).toMatchObject({ _tag: "Apply", action: "reply" });
    expect(store.getEvent(owner, eventId).attendees[0]!.partstat).toBe("ACCEPTED");
    expect(store.getEvent(owner, tailId).attendees[0]!.partstat).toBe("ACCEPTED");
  });
});

describe("location autocomplete adapter (C10)", () => {
  it("[C10] maps geocoder results and returns nothing without a configured key", async () => {
    let called = "";
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      called = input instanceof Request ? input.url : String(input);
      return Response.json({
        features: [
          {
            properties: {
              name: "Blue Bottle",
              full_address: "1 Main St",
              mapbox_id: "mb1",
              coordinates: { latitude: 37.7, longitude: -122.4 },
            },
          },
        ],
      });
    }) as typeof fetch;
    const search = (key: string | undefined) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* LocationSearch).search({
            text: "blue bottle",
            near: { latitude: 37, longitude: -122 },
            limit: 5,
          });
        }).pipe(Effect.provide(calendarLocationSearchLive(key, fetchFn))),
      );
    expect(await search("k_test")).toEqual([
      {
        label: "Blue Bottle",
        address: "1 Main St",
        latitude: 37.7,
        longitude: -122.4,
        providerId: "mb1",
      },
    ]);
    expect(called.startsWith(CALENDAR_GEOCODER_ENDPOINT)).toBe(true);
    expect(new URL(called).searchParams.get("proximity")).toBe("-122,37");
    called = "";
    expect(await search(undefined)).toEqual([]);
    expect(called).toBe("");
  });
});

describe("calendar access table (§3.2)", () => {
  const typesOf = (union: {
    readonly members: ReadonlyArray<{
      readonly fields: { readonly type: { readonly literal: unknown } };
    }>;
  }) => union.members.map((m) => String(m.fields.type.literal));
  const INTERNAL = [
    "CreateEventFromMessage",
    "CreateFeedToken",
    "ApplySubscriptionFetch",
    "ReceiveInvitation",
    "Feed",
    "Subscription",
  ];

  it("has exactly one policy per public command and read, plus the internal messages", () => {
    const expected = [
      ...typesOf(CalendarCommand),
      ...typesOf(CalendarReadQuery),
      ...INTERNAL,
    ].sort();
    expect(Object.keys(CALENDAR_ACCESS).sort()).toEqual(expected);
    expect(CALENDAR_ACCESS).not.toHaveProperty("IsOrganizerOf");
    expect(CALENDAR_ACCESS.Changes).toBe("readable");
    for (const t of INTERNAL.filter(
      (t) => t !== "CreateEventFromMessage" && t !== "CreateFeedToken",
    ))
      expect(CALENDAR_ACCESS[t as keyof typeof CALENDAR_ACCESS]).toBe("system");
  });

  it("refuses principal-free messages from a principal, and principal messages without one", () => {
    const { store, owner } = setup();
    expect(() => calendarRead(store, owner, { type: "Feed", tokenHash: "x" })).toThrow(/internal/);
    expect(() =>
      calendarExecute(store, owner, {
        type: "ReceiveInvitation",
        commandId: "ing_x",
        ics: "",
        sender: "a@b.c",
      }),
    ).toThrow(/internal/);
    expect(() => calendarRead(store, null, { type: "Calendars" })).toThrow(/principal/);
    expect(() => calendarRead(store, GUEST, { type: "Preferences" })).toThrow(/owner-only/);
    expect(calendarRead(store, GUEST, { type: "Calendars" })).toEqual([]);
  });
});
