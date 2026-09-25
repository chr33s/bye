import { describe, expect, it } from "vitest";
import {
  calAllDay,
  calBuildRequest,
  calEventComponent,
  calExpand,
  calExpandSeries,
  type CalIcsEvent,
  calInstant,
  calInterpretItip,
  calNextReminder,
  calParseCalendar,
  calParseDate,
  calParseDateTime,
  calParseDuration,
  calParseDurationParts,
  calParseRRule,
  calRecurrenceKey,
  calReminderRecheckAt,
  type CalSeries,
  calSerializeCalendar,
  calSerializeComponent,
  calTimed,
  calTimeProblem,
} from "../src/index.ts";

const utc = (s: string) => Date.parse(`${s}Z`);
const ny = (s: string) => calTimed(calParseDateTime(s), "America/New_York");
const DAY = 86_400_000;

const wrap = (body: string, method?: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method ? [`METHOD:${method}`] : []),
    "BEGIN:VEVENT",
    body.trim(),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

describe("RECURRENCE-ID keys follow the series zone", () => {
  const series = ny("2026-10-26T09:00:00");

  it("normalizes a UTC RECURRENCE-ID to the series wall clock, across the DST change", () => {
    // 2 Nov 2026 09:00 EST = 14:00Z (after the fall change); 30 Oct 09:00 EDT = 13:00Z.
    expect(calRecurrenceKey(calTimed(calParseDateTime("2026-11-02T14:00:00"), "UTC"), series)).toBe(
      "20261102T090000",
    );
    expect(calRecurrenceKey(calTimed(calParseDateTime("2026-10-30T13:00:00"), "UTC"), series)).toBe(
      "20261030T090000",
    );
  });

  it("normalizes a foreign-TZID RECURRENCE-ID and keeps same-zone ones unchanged", () => {
    const berlin = calTimed(calParseDateTime("2026-10-28T14:00:00"), "Europe/Berlin");
    expect(calRecurrenceKey(berlin, series)).toBe("20261028T090000");
    expect(calRecurrenceKey(ny("2026-10-28T09:00:00"), series)).toBe("20261028T090000");
    // Without a known series the value is keyed as given (previous behaviour).
    expect(calRecurrenceKey(berlin)).toBe("20261028T140000");
  });

  it("keys all-day series by date, and date RECURRENCE-IDs of timed series at the series time", () => {
    const allDay = calAllDay(calParseDate("20261026"));
    expect(calRecurrenceKey(ny("2026-10-28T00:00:00"), allDay)).toBe("20261028");
    expect(calRecurrenceKey(calAllDay(calParseDate("20261028")), series)).toBe("20261028T090000");
  });

  it("calInterpretItip keys a UTC per-occurrence CANCEL against the stored series", () => {
    const e = calParseCalendar(
      wrap(
        `UID:s1\r\nSEQUENCE:2\r\nRECURRENCE-ID:20261102T140000Z\r\nDTSTART:20261102T140000Z\r\nORGANIZER:mailto:boss@example.com`,
        "CANCEL",
      ),
    ).events[0]!;
    const decision = calInterpretItip({
      method: "CANCEL",
      event: e,
      sender: "boss@example.com",
      self: ["me@bye.test"],
      known: undefined,
      seriesStart: series,
    });
    expect(decision).toEqual({ _tag: "Apply", action: "cancel", recurrenceKey: "20261102T090000" });
  });
});

describe("iCalendar output cannot be injected into", () => {
  const evil = "x\r\nATTENDEE:mailto:attacker@evil.test\r\nBEGIN:VALARM";
  const event: CalIcsEvent = {
    uid: `u1${evil}`,
    sequence: 0,
    dtstamp: 0,
    series: {
      uid: "u1",
      dtstart: ny("2026-10-01T09:00:00"),
      dtend: ny("2026-10-01T10:00:00"),
      data: { summary: `S\rLOCATION:bad`, url: `https://a.test/${evil}`, location: evil },
    },
    organizer: { address: "boss@example.com", name: `Boss"${evil}` },
    attendees: [
      { address: `ann@example.com${evil}`, name: `Ann;${evil}`, partstat: "NEEDS-ACTION" },
    ],
    alarms: [],
  };

  it("strips CR/LF and control characters from raw values and parameters", () => {
    const ics = calSerializeCalendar([event], { now: 0, method: "REQUEST" });
    const unfolded = ics.replace(/\r\n[ \t]/g, "");
    const lines = unfolded.split("\r\n");
    // No line starts a property the caller did not write.
    expect(lines.filter((l) => l.startsWith("ATTENDEE"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("BEGIN:VALARM"))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("LOCATION"))).toHaveLength(1);
    // oxlint-disable-next-line no-control-regex
    expect(unfolded).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    const parsed = calParseCalendar(ics);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]!.attendees).toHaveLength(1);
    expect(parsed.events[0]!.series.data.summary).toBe("S\nLOCATION:bad");
  });

  it("escapes a lone CR in TEXT values and strips DQUOTE from parameters", () => {
    const line = calSerializeComponent(calEventComponent(event, 0))
      .replace(/\r\n[ \t]/g, "")
      .split("\r\n")
      .find((l) => l.startsWith("ORGANIZER"))!;
    expect(line).toMatch(/^ORGANIZER;CN="Bossx/);
    expect(line.match(/"/g)).toHaveLength(2);
  });
});

describe("DURATION days are nominal (RFC 5545 §3.3.6)", () => {
  it("P1D across the fall DST change ends at the same wall-clock time (25h)", () => {
    const [e] = calParseCalendar(
      wrap("UID:d1\r\nDTSTART;TZID=America/New_York:20261031T100000\r\nDURATION:P1D"),
    ).events;
    expect(e!.series.dtend).toEqual(ny("2026-11-01T10:00:00"));
    expect(calInstant(e!.series.dtend) - calInstant(e!.series.dtstart)).toBe(25 * 3_600_000);
  });

  it("P1DT1H across the spring change is a nominal day plus an exact hour; PT24H stays exact", () => {
    const [a, b] = calParseCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:d2",
        "DTSTART;TZID=America/New_York:20260307T100000",
        "DURATION:P1DT1H",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:d3",
        "DTSTART;TZID=America/New_York:20260307T100000",
        "DURATION:PT24H",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    ).events;
    expect(a!.series.dtend).toEqual(ny("2026-03-08T11:00:00"));
    expect(b!.series.dtend).toEqual(ny("2026-03-08T11:00:00"));
    expect(calInstant(a!.series.dtend) - calInstant(a!.series.dtstart)).toBe(24 * 3_600_000);
  });

  it("all-day DURATION counts days; alarm triggers keep exact durations", () => {
    const [e] = calParseCalendar(
      wrap("UID:d4\r\nDTSTART;VALUE=DATE:20261031\r\nDURATION:P2D"),
    ).events;
    expect(e!.series.dtend).toEqual(calAllDay(calParseDate("20261102")));
    expect(calParseDurationParts("-P1W2DT3H")).toEqual({ days: -9, ms: -3 * 3_600_000 });
    expect(calParseDuration("-PT15M")).toBe(-15 * 60_000);
  });
});

describe("EXDATE;VALUE=DATE on a timed series", () => {
  it("excludes the occurrence on that date (series zone), keeping the others", () => {
    const [e] = calParseCalendar(
      wrap(
        [
          "UID:x1",
          "DTSTART;TZID=America/New_York:20261030T213000",
          "DTEND;TZID=America/New_York:20261030T223000",
          "RRULE:FREQ=DAILY;COUNT=4",
          // 31 Oct in New York; 21:30 EDT is already 1 Nov in UTC, so this must use the series date.
          "EXDATE;VALUE=DATE:20261031",
        ].join("\r\n"),
      ),
    ).events;
    const keys = calExpandSeries(e!.series, [], {
      from: utc("2026-10-01T00:00:00"),
      to: utc("2026-12-01T00:00:00"),
    }).map((o) => o.key);
    expect(keys).toEqual(["20261030T213000", "20261101T213000", "20261102T213000"]);
  });

  it("a timed EXDATE on an all-day series excludes that date", () => {
    const starts = calExpand(
      {
        dtstart: calAllDay(calParseDate("20261001")),
        rule: calParseRRule("FREQ=DAILY;COUNT=3"),
        exdates: [ny("2026-10-02T00:00:00")],
      },
      { from: utc("2026-09-01T00:00:00"), to: utc("2026-11-01T00:00:00") },
    ).map((o) => o.key);
    expect(starts).toEqual(["20261001", "20261003"]);
  });
});

describe("reminders beyond the lookahead horizon", () => {
  const now = utc("2026-09-25T12:00:00");
  const farSeries: CalSeries = {
    uid: "far",
    dtstart: ny("2028-06-01T09:00:00"),
    dtend: ny("2028-06-01T10:00:00"),
    data: { summary: "Far" },
  };

  it("finds nothing inside 400 days but asks for a recheck at the horizon", () => {
    expect(calNextReminder("e", 1, farSeries, [], [10], now)).toBeUndefined();
    expect(calReminderRecheckAt(farSeries, [], [10], now)).toBe(now + 400 * DAY);
    // Rechecking from the horizon finds it.
    const job = calNextReminder("e", 1, farSeries, [], [10], now + 400 * DAY);
    expect(job?.dueAt).toBe(utc("2028-06-01T12:50:00"));
  });

  it("recheck covers infinite rules and moved overrides, and nothing past a finished series", () => {
    const ended: CalSeries = {
      ...farSeries,
      dtstart: ny("2026-01-01T09:00:00"),
      dtend: ny("2026-01-01T10:00:00"),
      rule: calParseRRule("FREQ=WEEKLY;COUNT=3"),
    };
    expect(calReminderRecheckAt(ended, [], [10], now)).toBeUndefined();
    expect(calReminderRecheckAt(ended, [], [], now)).toBeUndefined();
    const moved = [
      { recurrenceKey: "20260108T090000", cancelled: false, start: ny("2028-01-08T09:00:00") },
    ];
    expect(calReminderRecheckAt(ended, moved, [10], now)).toBe(now + 400 * DAY);
    const yearly: CalSeries = {
      ...ended,
      rule: calParseRRule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"),
    };
    expect(calReminderRecheckAt(yearly, [], [10], utc("2028-03-01T00:00:00"))).toBe(
      utc("2028-03-01T00:00:00") + 400 * DAY,
    );
  });
});

describe("calTimeProblem", () => {
  it("accepts valid values and names the problem otherwise", () => {
    expect(calTimeProblem(ny("2026-10-01T09:00:00"))).toBeUndefined();
    expect(calTimeProblem(calAllDay(calParseDate("20240229")))).toBeUndefined();
    expect(
      calTimeProblem({
        kind: "timed",
        tzid: "Mars/Olympus",
        local: calParseDateTime("2026-10-01T09:00:00"),
      }),
    ).toMatch(/time zone/);
    expect(
      calTimeProblem({ kind: "timed", tzid: "\n", local: calParseDateTime("2026-10-01T09:00:00") }),
    ).toMatch(/time zone/);
    expect(calTimeProblem({ kind: "date", date: { year: 2026, month: 13, day: 1 } })).toMatch(
      /month/,
    );
    expect(calTimeProblem({ kind: "date", date: { year: 2025, month: 2, day: 29 } })).toMatch(
      /day/,
    );
    expect(
      calTimeProblem({
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 1, day: 1, hour: 24, minute: 0, second: 0 },
      }),
    ).toMatch(/time of day/);
    expect(
      calTimeProblem({
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 1, day: 1, hour: 1.5, minute: 0, second: 0 },
      }),
    ).toMatch(/time of day/);
  });
});

// A REQUEST built from hostile names still parses back to exactly one event.
describe("iTIP REQUEST round-trip", () => {
  it("parses back to exactly one event", () => {
    const ics = calBuildRequest(
      {
        uid: "r1",
        sequence: 0,
        dtstamp: 0,
        series: {
          uid: "r1",
          dtstart: ny("2026-10-01T09:00:00"),
          dtend: ny("2026-10-01T10:00:00"),
          data: { summary: "Hi" },
        },
        organizer: { address: "me@bye.test", name: "Me\r\nX-EVIL:1" },
        attendees: [{ address: "ann@example.com", partstat: "NEEDS-ACTION" }],
        alarms: [],
      },
      0,
    ).ics;
    expect(ics).not.toMatch(/\r\nX-EVIL/);
    expect(calParseCalendar(ics).events).toHaveLength(1);
  });
});
