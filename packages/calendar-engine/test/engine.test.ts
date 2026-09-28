import { describe, expect, it } from "vitest";
import {
  calAgenda,
  calAllDay,
  type CalEventData,
  calBuildCancel,
  calBuildReply,
  calBuildRequest,
  calCountdownDays,
  calDisplayTime,
  calExpand,
  calExpandSeries,
  calFoldLine,
  calFreeTime,
  calInterpretItip,
  calLayoutOverlaps,
  calNextReminder,
  calNightHoursBusy,
  calOrderKeyBetween,
  calParseCalendar,
  calParseDate,
  calParseDuration,
  calParseRRule,
  calSerializeCalendar,
  calSerializeRRule,
  calSplitSeries,
  calTimed,
  calWallClock,
  calWeekAnchor,
  calYearOverview,
  calZonedToInstant,
  calZonedToInstantDetailed,
  type CalIcsEvent,
  type CalSeries,
  type CalKnownInvitation,
} from "@bye/calendar-engine";

const dt = (s: string) => {
  const [d, t = "00:00:00"] = s.split("T");
  const [year, month, day] = d!.split("-").map(Number);
  const [hour, minute, second = 0] = t.split(":").map(Number);

  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second };
};

const utc = (s: string) => Date.parse(s.endsWith("Z") ? s : `${s}Z`);

const iso = (ms: number) => new Date(ms).toISOString();

describe("time zones", () => {
  it("[C03] resolves DST gap by shifting forward (America/New_York)", () => {
    const r = calZonedToInstantDetailed(dt("2026-03-08T02:30"), "America/New_York");
    expect(r.resolution).toBe("gap-shifted");
    expect(iso(r.instant)).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(calWallClock(r.instant, "America/New_York")).toMatchObject({ hour: 3, minute: 30 });
  });

  it("[C03] resolves DST fold to the earlier instant (America/New_York, Europe/London)", () => {
    const ny = calZonedToInstantDetailed(dt("2026-11-01T01:30"), "America/New_York");
    expect(ny.resolution).toBe("fold-earlier");
    expect(iso(ny.instant)).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, not EST
    const london = calZonedToInstantDetailed(dt("2026-10-25T01:30"), "Europe/London");
    expect(london.resolution).toBe("fold-earlier");
    expect(iso(london.instant)).toBe("2026-10-25T00:30:00.000Z"); // BST
  });

  it("[C03] handles half-hour DST shifts (Australia/Lord_Howe)", () => {
    // Lord Howe: +10:30 standard, +11:00 daylight; DST starts 2026-10-04 02:00 → 02:30.
    const gap = calZonedToInstantDetailed(dt("2026-10-04T02:15"), "Australia/Lord_Howe");
    expect(gap.resolution).toBe("gap-shifted");
    expect(calWallClock(gap.instant, "Australia/Lord_Howe")).toMatchObject({ hour: 2, minute: 45 });
    // DST ends 2026-04-05 02:00 → 01:30; 01:45 happens twice.
    const fold = calZonedToInstantDetailed(dt("2026-04-05T01:45"), "Australia/Lord_Howe");
    expect(fold.resolution).toBe("fold-earlier");
    expect(iso(fold.instant)).toBe("2026-04-04T14:45:00.000Z"); // +11:00
  });

  it("[C03] a daily 09:00 series keeps wall time across DST", () => {
    const occ = calExpand(
      {
        dtstart: calTimed(dt("2026-03-06T09:00"), "America/New_York"),
        rule: calParseRRule("FREQ=DAILY;COUNT=4"),
      },
      { from: 0, to: utc("2027-01-01T00:00:00") },
    );

    expect(occ.map((o) => calWallClock(o.startMs, "America/New_York").hour)).toEqual([9, 9, 9, 9]);
    expect(occ[2]!.startMs - occ[1]!.startMs).toBe(23 * 3600_000);
  });

  it("[C02] all-day events are dates, not midnight UTC, across zones", () => {
    const series: CalSeries = {
      uid: "bday",
      dtstart: calAllDay(calParseDate("2026-09-25")),
      dtend: calAllDay(calParseDate("2026-09-26")),
      data: { summary: "Birthday" },
    };

    for (const zone of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      const [o] = calExpandSeries(series, [], {
        from: utc("2026-09-01T00:00:00"),
        to: utc("2026-10-01T00:00:00"),
        viewerZone: zone,
      });

      expect(o!.allDay).toBe(true);
      expect(calWallClock(o!.startMs, zone)).toMatchObject({
        year: 2026,
        month: 9,
        day: 25,
        hour: 0,
      });
      const agenda = calAgenda([o!], zone, calParseDate("2026-09-24"), 3);
      expect(agenda.map((d) => d.date)).toEqual(["2026-09-25"]);
    }
  });
});

describe("recurrence", () => {
  const w = { from: utc("2026-01-01T00:00:00"), to: utc("2027-12-31T00:00:00") };

  const dates = (rule: string, start = "2026-01-01T10:00", zone = "UTC", window = w) =>
    calExpand({ dtstart: calTimed(dt(start), zone), rule: calParseRRule(rule) }, window).map((o) =>
      iso(o.startMs).slice(0, 10),
    );

  it("[C03] parses and serializes rules", () => {
    const rule = "FREQ=MONTHLY;INTERVAL=2;COUNT=5;BYDAY=-1FR;BYSETPOS=1;WKST=SU";
    expect(calSerializeRRule(calParseRRule(rule))).toBe(rule);
    expect(() => calParseRRule("FREQ=HOURLY")).toThrow();
    expect(() => calParseRRule("FREQ=DAILY;COUNT=2;UNTIL=20260101")).toThrow();
  });

  it("[C03] repeats forever, until a date, or for a count", () => {
    expect(dates("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")).toEqual([
      "2026-01-01",
      "2026-01-05",
      "2026-01-07",
      "2026-01-12",
    ]);
    expect(dates("FREQ=DAILY;UNTIL=20260103T100000Z")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
    expect(dates("FREQ=DAILY;UNTIL=20260103")).toHaveLength(3);

    const forever = dates("FREQ=YEARLY", "2026-02-28T10:00", "UTC", {
      from: utc("2100-01-01T00:00:00"),
      to: utc("2102-01-01T00:00:00"),
    });

    expect(forever).toEqual(["2100-02-28", "2101-02-28"]);
  });

  it("[C03] handles monthly ordinals, negative month days, BYSETPOS and leap days", () => {
    expect(dates("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", "2026-01-13T10:00")).toEqual([
      "2026-01-13",
      "2026-02-10",
      "2026-03-10",
    ]);
    expect(dates("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "2026-01-31T10:00")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(
      dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2", "2026-01-30T10:00"),
    ).toEqual(["2026-01-30", "2026-02-27"]);
    expect(dates("FREQ=MONTHLY;COUNT=3", "2026-01-31T10:00")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
    ]);
    expect(
      dates("FREQ=YEARLY;COUNT=2", "2024-02-29T10:00", "UTC", {
        from: utc("2024-01-01T00:00:00"),
        to: utc("2030-01-01T00:00:00"),
      }),
    ).toEqual(["2024-02-29", "2028-02-29"]);
    expect(dates("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2", "2026-11-26T10:00")).toEqual([
      "2026-11-26",
      "2027-11-25",
    ]);
    // Without BYMONTH, YEARLY BYMONTHDAY expands in every month (RFC 5545 §3.3.10).
    expect(dates("FREQ=YEARLY;BYMONTHDAY=1;COUNT=4", "2026-03-01T10:00")).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    // …and BYDAY then limits: Friday the 13ths.
    expect(dates("FREQ=YEARLY;BYDAY=FR;BYMONTHDAY=13;COUNT=3", "2026-02-13T10:00")).toEqual([
      "2026-02-13",
      "2026-03-13",
      "2026-11-13",
    ]);
  });

  it("[C03] respects WKST for biweekly rules", () => {
    const mo = dates("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;COUNT=4;WKST=MO", "2026-08-04T10:00");
    const su = dates("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;COUNT=4;WKST=SU", "2026-08-04T10:00");
    expect(mo).toEqual(["2026-08-04", "2026-08-09", "2026-08-18", "2026-08-23"]);
    expect(su).toEqual(["2026-08-04", "2026-08-16", "2026-08-18", "2026-08-30"]);
  });

  it("[C02] applies EXDATE, RDATE and RECURRENCE-ID overrides, including moved occurrences", () => {
    const series: CalSeries = {
      uid: "standup",
      dtstart: calTimed(dt("2026-09-21T09:00"), "Europe/London"),
      dtend: calTimed(dt("2026-09-21T09:15"), "Europe/London"),
      rule: calParseRRule("FREQ=DAILY;COUNT=5"),
      exdates: [calTimed(dt("2026-09-22T09:00"), "Europe/London")],
      rdates: [calTimed(dt("2026-09-27T12:00"), "Europe/London")],
      data: { summary: "Standup" },
    };

    const occ = calExpandSeries(
      series,
      [
        {
          recurrenceKey: "20260923T090000",
          cancelled: false,
          start: calTimed(dt("2026-10-05T10:00"), "Europe/London"),
          data: { summary: "Moved" },
        },
        { recurrenceKey: "20260924T090000", cancelled: true },
      ],
      { from: utc("2026-09-20T00:00:00"), to: utc("2026-10-10T00:00:00") },
    );

    expect(occ.map((o) => [o.key, o.data.summary])).toEqual([
      ["20260921T090000", "Standup"],
      ["20260925T090000", "Standup"],
      ["20260927T120000", "Standup"],
      ["20260923T090000", "Moved"],
    ]);

    // A window that only contains the moved occurrence still finds it.
    const moved = calExpandSeries(
      series,
      [
        {
          recurrenceKey: "20260923T090000",
          cancelled: false,
          start: calTimed(dt("2027-03-01T10:00"), "Europe/London"),
        },
      ],
      {
        from: utc("2027-02-01T00:00:00"),
        to: utc("2027-04-01T00:00:00"),
      },
    );

    expect(moved.map((o) => o.key)).toEqual(["20260923T090000"]);
  });

  it("[C03] splits a series for 'this and future' preserving COUNT and mapping", () => {
    const series: CalSeries = {
      uid: "weekly",
      dtstart: calTimed(dt("2026-09-01T10:00"), "America/New_York"),
      dtend: calTimed(dt("2026-09-01T11:00"), "America/New_York"),
      rule: calParseRRule("FREQ=WEEKLY;COUNT=10"),
      data: { summary: "Sync" },
    };

    const split = calSplitSeries(
      series,
      [
        { recurrenceKey: "20260908T100000", cancelled: true },
        { recurrenceKey: "20260929T100000", cancelled: true },
      ],
      {
        key: "20260922T100000",
        start: calTimed(dt("2026-09-22T10:00"), "America/New_York"),
      },
      "weekly-2",
    );

    expect(split.head?.rule?.count).toBe(3);
    expect(split.tail.rule?.count).toBe(7);
    expect(split.headExceptions.map((e) => e.recurrenceKey)).toEqual(["20260908T100000"]);
    expect(split.tailExceptions.map((e) => e.recurrenceKey)).toEqual(["20260929T100000"]);
    expect(split.mapping).toEqual({
      originalUid: "weekly",
      newUid: "weekly-2",
      splitKey: "20260922T100000",
    });
    const window = { from: 0, to: utc("2027-06-01T00:00:00") };

    const total =
      calExpandSeries(split.head!, [], window).length +
      calExpandSeries(split.tail, [], window).length;

    expect(total).toBe(10);

    const untilSplit = calSplitSeries(
      { ...series, rule: calParseRRule("FREQ=WEEKLY") },
      [],
      { key: "20260915T100000", start: calTimed(dt("2026-09-15T10:00"), "America/New_York") },
      "w3",
    );

    expect(untilSplit.head?.rule?.until).toBe("20260915T135959Z");
    expect(calExpandSeries(untilSplit.head!, [], window)).toHaveLength(2);

    const atStart = calSplitSeries(
      series,
      [],
      { key: "20260901T100000", start: series.dtstart },
      "w4",
    );

    expect(atStart.head).toBeUndefined();
  });
});

describe("iCalendar", () => {
  const sample = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:abc@example.com",
    "DTSTAMP:20260901T120000Z",
    "SEQUENCE:2",
    "DTSTART;TZID=/example.org/tzdb/America/New_York:20260910T090000",
    "DURATION:PT1H30M",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;TZID=Eastern Standard Time:20260917T090000",
    "SUMMARY:Planning\\, Q4\\; budget",
    "DESCRIPTION:Line one\\nLine two with a very long text that must be folded because it exceeds seventy-five octets ✓",
    'ORGANIZER;CN="Org, Anizer":mailto:Boss@Example.com',
    "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@bye.test",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("[C05] parses tolerant input: vendor TZIDs, Windows zones, escaping, durations, alarms", () => {
    const cal = calParseCalendar(sample);
    expect(cal.method).toBe("REQUEST");
    const e = cal.events[0]!;
    expect(e.series.dtstart).toEqual(calTimed(dt("2026-09-10T09:00"), "America/New_York"));
    expect(e.series.dtend).toEqual(calTimed(dt("2026-09-10T10:30"), "America/New_York"));
    expect(e.series.exdates?.[0]).toEqual(calTimed(dt("2026-09-17T09:00"), "America/New_York"));
    expect(e.series.data.summary).toBe("Planning, Q4; budget");
    expect(e.organizer).toEqual({ address: "boss@example.com", name: "Org, Anizer" });
    expect(e.alarms).toEqual([15, 1440]);
    expect(calParseDuration("-P1W")).toBe(-7 * 86_400_000);
  });

  it("[A04] [C05] round-trips through serialization with folding", () => {
    const cal = calParseCalendar(sample);

    const out = calSerializeCalendar(cal.events, {
      now: utc("2026-09-25T00:00:00"),
      method: "PUBLISH",
    });

    for (const line of out.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const again = calParseCalendar(out);
    expect(again.events[0]!.series).toEqual(cal.events[0]!.series);
    expect(again.events[0]!.attendees).toEqual(cal.events[0]!.attendees);
    expect(again.events[0]!.alarms).toEqual([15, 1440]);
    expect(calFoldLine("x".repeat(200)).split("\r\n ").join("")).toBe("x".repeat(200));
  });

  it("[C05] bounds item counts and skips invalid events with warnings", () => {
    const many = [
      "BEGIN:VCALENDAR",
      ...Array.from(
        { length: 5 },
        (_, i) => `BEGIN:VEVENT\r\nUID:${i}\r\nDTSTART:2026010${i + 1}\r\nEND:VEVENT`,
      ),
      "BEGIN:VEVENT",
      "SUMMARY:no uid",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const bounded = calParseCalendar(many, { maxItems: 3 });
    expect(bounded.events).toHaveLength(3);
    expect(bounded.truncated).toBe(true);
    expect(calParseCalendar(many).warnings.length).toBeGreaterThan(0);
  });
});

describe("iTIP", () => {
  const base = (
    sequence: number,
    dtstamp: number,
    organizer = "boss@example.com",
  ): CalIcsEvent => ({
    uid: "inv-1",
    sequence,
    dtstamp,
    series: {
      uid: "inv-1",
      dtstart: calTimed(dt("2026-10-01T10:00"), "UTC"),
      dtend: calTimed(dt("2026-10-01T11:00"), "UTC"),
      data: { summary: "Review" },
    },
    organizer: { address: organizer },
    attendees: [
      { address: "me@bye.test", partstat: "NEEDS-ACTION" },
      { address: "other@example.com", partstat: "ACCEPTED" },
    ],
    alarms: [],
  });

  const knownAt = (sequence: number, dtstamp: number): CalKnownInvitation => ({
    organizer: "boss@example.com",
    weAreOrganizer: false,
    revision: { sequence, dtstamp },
    seriesRevision: { sequence, dtstamp },
    attendeeRevisions: {},
  });

  it("[C04] applies new requests, ignores older and duplicate revisions (out-of-order)", () => {
    const self = ["me@bye.test"];
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(0, 1),
        sender: "boss@example.com",
        self,
        known: undefined,
      }),
    ).toMatchObject({ _tag: "Apply", action: "create" });
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(2, 5),
        sender: "boss@example.com",
        self,
        known: knownAt(1, 3),
      }),
    ).toMatchObject({ _tag: "Apply", action: "update" });
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(1, 2),
        sender: "boss@example.com",
        self,
        known: knownAt(2, 5),
      })._tag,
    ).toBe("IgnoreStale");
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(2, 4),
        sender: "boss@example.com",
        self,
        known: knownAt(2, 5),
      })._tag,
    ).toBe("IgnoreStale");
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(2, 5),
        sender: "boss@example.com",
        self,
        known: knownAt(2, 5),
      })._tag,
    ).toBe("Duplicate");
    expect(
      calInterpretItip({
        method: "CANCEL",
        event: base(3, 6),
        sender: "boss@example.com",
        self,
        known: knownAt(2, 5),
      }),
    ).toMatchObject({ _tag: "Apply", action: "cancel" });
  });

  it("[C04] rejects unauthorized organizer changes and non-organizer senders", () => {
    const self = ["me@bye.test"];
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(5, 9, "mallory@evil.test"),
        sender: "mallory@evil.test",
        self,
        known: knownAt(1, 1),
      }),
    ).toMatchObject({ _tag: "Unauthorized" });
    expect(
      calInterpretItip({
        method: "CANCEL",
        event: base(5, 9),
        sender: "other@example.com",
        self,
        known: knownAt(1, 1),
      }),
    ).toMatchObject({ _tag: "Unauthorized" });
    expect(
      calInterpretItip({
        method: "REQUEST",
        event: base(5, 9, "me@bye.test"),
        sender: "me@bye.test",
        self,
        known: undefined,
      }),
    ).toMatchObject({ _tag: "Unauthorized" });
  });

  it("[C04] builds REQUEST/REPLY/CANCEL and validates replies against the attendee", () => {
    const e = base(1, 1);
    const req = calBuildRequest(e, 10);
    expect(req.ics).toContain("METHOD:REQUEST");
    expect(req.recipients).toEqual(["me@bye.test", "other@example.com"]);
    const reply = calBuildReply(e, "me@bye.test", "ACCEPTED", 20);
    expect(reply.recipients).toEqual(["boss@example.com"]);
    const parsed = calParseCalendar(reply.ics);
    expect(parsed.method).toBe("REPLY");
    expect(parsed.events[0]!.attendees).toEqual([
      {
        address: "me@bye.test",
        name: undefined,
        partstat: "ACCEPTED",
        role: undefined,
        rsvp: false,
      },
    ]);
    expect(calBuildCancel(e, 30).ics).toContain("STATUS:CANCELLED");

    const organizerKnown: CalKnownInvitation = {
      organizer: "me@bye.test",
      weAreOrganizer: true,
      revision: undefined,
      seriesRevision: undefined,
      attendeeRevisions: {},
    };

    const replyEvent = parsed.events[0]!;
    expect(
      calInterpretItip({
        method: "REPLY",
        event: replyEvent,
        sender: "me@bye.test",
        self: ["boss@example.com"],
        known: organizerKnown,
      }),
    ).toMatchObject({ _tag: "Apply", action: "reply" });
    expect(
      calInterpretItip({
        method: "REPLY",
        event: replyEvent,
        sender: "spoof@x.test",
        self: ["boss@example.com"],
        known: organizerKnown,
      })._tag,
    ).toBe("Unauthorized");
    expect(
      calInterpretItip({
        method: "REPLY",
        event: replyEvent,
        sender: "me@bye.test",
        self: [],
        known: {
          ...organizerKnown,
          attendeeRevisions: { "me@bye.test": { sequence: 1, dtstamp: 99_000 } },
        },
      })._tag,
    ).toBe("IgnoreStale");
  });
});

describe("views and planning", () => {
  it("[C01] lays out overlapping events in columns and aggregates the year", () => {
    const layout = calLayoutOverlaps([
      { id: "a", startMs: 0, endMs: 60 },
      { id: "b", startMs: 30, endMs: 90 },
      { id: "c", startMs: 60, endMs: 120 },
      { id: "d", startMs: 200, endMs: 300 },
    ]);

    expect(layout).toEqual([
      { id: "a", column: 0, columns: 2 },
      { id: "b", column: 1, columns: 2 },
      { id: "c", column: 0, columns: 2 },
      { id: "d", column: 0, columns: 1 },
    ]);

    const occ = calExpandSeries(
      {
        uid: "trip",
        dtstart: calAllDay(calParseDate("2026-12-30")),
        dtend: calAllDay(calParseDate("2027-01-02")),
        data: { summary: "Trip" },
      },
      [],
      { from: utc("2026-12-01T00:00:00"), to: utc("2027-02-01T00:00:00") },
    );

    expect(calYearOverview(occ, "UTC", 2026)).toEqual({ "2026-12-30": 1, "2026-12-31": 1 });
  });

  it("[C01] detects busy night hours so they are not collapsed", () => {
    const late = calExpandSeries(
      {
        uid: "late",
        dtstart: calTimed(dt("2026-09-25T23:00"), "UTC"),
        dtend: calTimed(dt("2026-09-25T23:30"), "UTC"),
        data: { summary: "Late" },
      },
      [],
      { from: utc("2026-09-25T00:00:00"), to: utc("2026-09-26T00:00:00") },
    );

    expect(
      calNightHoursBusy(late, calParseDate("2026-09-25"), "UTC", {
        startMinute: 7 * 60,
        endMinute: 22 * 60,
      }),
    ).toBe(true);
    expect(
      calNightHoursBusy(late, calParseDate("2026-09-25"), "UTC", {
        startMinute: 7 * 60,
        endMinute: 24 * 60,
      }),
    ).toBe(false);
  });

  it("[C08] computes uninterrupted free time respecting transparency, all-day and hidden calendars", () => {
    const mk = (id: string, s: string, e: string, extra: Partial<CalEventData> = {}) => ({
      ...calExpandSeries(
        {
          uid: id,
          dtstart: calTimed(dt(s), "UTC"),
          dtend: calTimed(dt(e), "UTC"),
          data: { summary: id, ...extra },
        },
        [],
        { from: 0, to: utc("2030-01-01T00:00:00") },
      )[0]!,
      calendarId: id === "hidden" ? "cal_hidden" : "cal_main",
    });

    const occ = [
      mk("a", "2026-09-25T10:00", "2026-09-25T11:00"),
      mk("b", "2026-09-25T10:30", "2026-09-25T12:00"),
      mk("free", "2026-09-25T13:00", "2026-09-25T14:00", { transparent: true }),
      mk("hidden", "2026-09-25T15:00", "2026-09-25T16:00"),
    ];

    const free = calFreeTime(occ, calParseDate("2026-09-25"), {
      viewerZone: "UTC",
      waking: { startMinute: 9 * 60, endMinute: 17 * 60 },
      visibleCalendarIds: new Set(["cal_main"]),
      minimumMinutes: 30,
    });

    expect(free.map((f) => [iso(f.startMs).slice(11, 16), iso(f.endMs).slice(11, 16)])).toEqual([
      ["09:00", "10:00"],
      ["12:00", "17:00"],
    ]);
  });

  it("[C06] anchors weeks by the user's first weekday and orders keys", () => {
    const fri = calParseDate("2026-09-25");
    expect(calWeekAnchor(fri, 1)).toEqual(calParseDate("2026-09-21"));
    expect(calWeekAnchor(fri, 0)).toEqual(calParseDate("2026-09-20"));
    expect(calWeekAnchor(fri, 6)).toEqual(calParseDate("2026-09-19"));
    expect(calWeekAnchor(calParseDate("2026-09-20"), 1)).toEqual(calParseDate("2026-09-14"));
    let keys = [calOrderKeyBetween(undefined, undefined)];

    for (let i = 0; i < 50; i++) keys.push(calOrderKeyBetween(keys.at(-1), undefined));

    for (let i = 0; i < 50; i++) keys.splice(1, 0, calOrderKeyBetween(keys[0], keys[1]));
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("[C03] travel-aware display and 12/24-hour formatting; [C08] countdowns", () => {
    const at = calZonedToInstant(dt("2026-09-25T09:00"), "America/New_York");
    expect(calDisplayTime(at, "America/New_York", "Europe/London", false)).toEqual({
      text: "14:00",
      originalText: "09:00 America/New_York",
    });
    expect(calDisplayTime(at, "America/New_York", "America/New_York", true)).toEqual({
      text: "9:00 AM",
    });
    expect(calCountdownDays(at, calParseDate("2026-12-25"), "UTC")).toBe(91);
  });

  it("[C02] computes the next reminder across multiple offsets and generations", () => {
    const series: CalSeries = {
      uid: "r",
      dtstart: calTimed(dt("2026-09-26T10:00"), "UTC"),
      dtend: calTimed(dt("2026-09-26T11:00"), "UTC"),
      rule: calParseRRule("FREQ=DAILY;COUNT=2"),
      data: { summary: "R" },
    };

    const now = utc("2026-09-25T12:00:00");
    const first = calNextReminder("evt", 1, series, [], [15, 1440], now)!;
    // The 1-day reminder for the first occurrence is already past; the 15-minute one is next.
    expect(iso(first.dueAt)).toBe("2026-09-26T09:45:00.000Z");
    expect(first.offsetMinutes).toBe(15);
    const second = calNextReminder("evt", 1, series, [], [15, 1440], first.dueAt)!;
    expect(iso(second.dueAt)).toBe("2026-09-26T10:00:00.000Z");
    expect(second.occurrenceKey).toBe("20260927T100000");
  });
});
