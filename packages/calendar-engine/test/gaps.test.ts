import { describe, expect, it } from "vitest";
import {
  calAllDay,
  calApplySeriesChanges,
  calCountBefore,
  calExpand,
  calParseRRule,
  calParseTimeValue,
  calReminderIsCurrent,
  calResolveTzid,
  calTimed,
  CalRRuleError,
  type CalSeries,
} from "@bye/calendar-engine";

const dt = (s: string) => {
  const [d, t = "00:00:00"] = s.split("T");
  const [year, month, day] = d!.split("-").map(Number);
  const [hour, minute, second = 0] = t.split(":").map(Number);
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second };
};
const utc = (s: string) => Date.parse(s.endsWith("Z") ? s : `${s}Z`);
const iso = (ms: number) => new Date(ms).toISOString();

const expandIso = (
  rule: string,
  start: string,
  zone: string,
  window: { from: number; to: number },
  extra: { maxOccurrences?: number; maxPeriods?: number } = {},
) =>
  calExpand(
    { dtstart: calTimed(dt(start), zone), rule: calParseRRule(rule) },
    { ...window, ...extra },
  ).map((o) => iso(o.startMs));

describe("UNTIL with a zoned DTSTART across DST", () => {
  const w = { from: utc("2026-01-01T00:00:00"), to: utc("2027-01-01T00:00:00") };

  it("[C03] a floating UNTIL is read in the series zone (spring forward)", () => {
    // 09:00 EST = 14:00Z before 2026-03-08, 09:00 EDT = 13:00Z after.
    const out = expandIso(
      "FREQ=DAILY;UNTIL=20260310T090000",
      "2026-03-06T09:00",
      "America/New_York",
      w,
    );
    expect(out).toEqual([
      "2026-03-06T14:00:00.000Z",
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-10T13:00:00.000Z",
    ]);
    // One second earlier (local) drops the last occurrence.
    expect(
      expandIso("FREQ=DAILY;UNTIL=20260310T085959", "2026-03-06T09:00", "America/New_York", w),
    ).toHaveLength(4);
  });

  it("[C03] a UTC UNTIL is compared as an instant on the post-DST offset", () => {
    const run = (until: string) =>
      expandIso(`FREQ=DAILY;UNTIL=${until}`, "2026-03-06T09:00", "America/New_York", w);
    expect(run("20260310T130000Z")).toHaveLength(5);
    // 12:59:59Z would have covered a pre-DST 09:00 (14:00Z) day but not post-DST 13:00Z.
    expect(run("20260310T125959Z")).toHaveLength(4);
  });

  it("[C03] a UTC UNTIL across fall back uses the standard-time offset", () => {
    const run = (until: string) =>
      expandIso(`FREQ=DAILY;UNTIL=${until}`, "2026-10-30T09:00", "America/New_York", w);
    // 2026-11-02 09:00 EST = 14:00Z.
    expect(run("20261102T140000Z").at(-1)).toBe("2026-11-02T14:00:00.000Z");
    expect(run("20261102T140000Z")).toHaveLength(4);
    expect(run("20261102T135959Z")).toHaveLength(3);
  });

  it("[C03] a date-only UNTIL includes the whole local day for zones west of UTC", () => {
    // 18:00 PDT on 03-10 is 01:00Z on 03-11; the local date still matches UNTIL.
    const out = expandIso(
      "FREQ=DAILY;UNTIL=20260310",
      "2026-03-06T18:00",
      "America/Los_Angeles",
      w,
    );
    expect(out.at(-1)).toBe("2026-03-11T01:00:00.000Z");
    expect(out).toHaveLength(5);
  });
});

describe("expansion bounds", () => {
  const w = { from: utc("2026-01-01T00:00:00"), to: utc("2030-01-01T00:00:00") };

  it("[C03] maxOccurrences caps the result", () => {
    expect(expandIso("FREQ=DAILY", "2026-01-01T10:00", "UTC", w, { maxOccurrences: 3 })).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-03T10:00:00.000Z",
    ]);
  });

  it("[C03] maxPeriods caps iterated periods even for an unbounded rule", () => {
    // Period 0 is DTSTART's own day; periods 1..4 add four more.
    expect(expandIso("FREQ=DAILY", "2026-01-01T10:00", "UTC", w, { maxPeriods: 5 })).toHaveLength(
      5,
    );
    expect(
      expandIso("FREQ=MONTHLY;BYMONTHDAY=1", "2026-01-01T10:00", "UTC", w, { maxPeriods: 3 }),
    ).toEqual(["2026-01-01T10:00:00.000Z", "2026-02-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z"]);
  });

  it("[C03] a never-matching rule (Feb 30) terminates with only DTSTART", () => {
    const huge = { from: utc("2026-01-01T00:00:00"), to: utc("9999-01-01T00:00:00") };
    for (const rule of [
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=5",
      "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30",
      "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    ]) {
      const started = performance.now();
      expect(expandIso(rule, "2026-01-01T10:00", "UTC", huge)).toEqual([
        "2026-01-01T10:00:00.000Z",
      ]);
      expect(performance.now() - started).toBeLessThan(5000);
    }
    // In a bounded window, the empty-period probe stops well before maxPeriods.
    expect(
      expandIso("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "2026-01-01T10:00", "UTC", w, {
        maxPeriods: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual(["2026-01-01T10:00:00.000Z"]);
  });
});

describe("rule parser rejects out-of-range values", () => {
  it.each([
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;INTERVAL=-1",
    "FREQ=DAILY;INTERVAL=1.5",
    "FREQ=DAILY;COUNT=0",
    "FREQ=MONTHLY;BYMONTHDAY=32",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=MONTHLY;BYMONTHDAY=-32",
    "FREQ=MONTHLY;BYMONTHDAY=1,,2",
    "FREQ=YEARLY;BYMONTH=13",
    "FREQ=YEARLY;BYMONTH=0",
    "FREQ=YEARLY;BYMONTH=-1",
    "FREQ=YEARLY;BYDAY=54MO",
    "FREQ=YEARLY;BYDAY=-54MO",
    "FREQ=YEARLY;BYDAY=0MO",
    "FREQ=YEARLY;BYDAY=100MO",
    "FREQ=MONTHLY;BYSETPOS=0",
    "FREQ=MONTHLY;BYSETPOS=367",
    "FREQ=DAILY;WKST=XX",
    "FREQ=DAILY;UNTIL=2026-01-01",
  ])("rejects %s", (rule) => {
    expect(() => calParseRRule(rule)).toThrow(CalRRuleError);
  });

  it("accepts boundary values", () => {
    expect(calParseRRule("FREQ=YEARLY;BYDAY=53MO,-53FR").byDay).toEqual([
      { weekday: 1, ordinal: 53 },
      { weekday: 5, ordinal: -53 },
    ]);
    expect(calParseRRule("FREQ=MONTHLY;BYMONTHDAY=31,-31").byMonthDay).toEqual([31, -31]);
  });
});

describe("calCountBefore", () => {
  const dtstart = calTimed(dt("2026-01-01T10:00"), "UTC");

  it("counts rule occurrences strictly before the instant", () => {
    const set = { dtstart, rule: calParseRRule("FREQ=DAILY") };
    expect(calCountBefore(set, utc("2026-01-05T10:00:00"))).toBe(4);
    expect(calCountBefore(set, utc("2026-01-05T10:00:01"))).toBe(5);
    expect(calCountBefore(set, utc("2026-01-01T10:00:00"))).toBe(0);
  });

  it("ignores RDATE/EXDATE and respects COUNT", () => {
    const set = {
      dtstart,
      rule: calParseRRule("FREQ=DAILY;COUNT=3"),
      rdates: [calTimed(dt("2025-12-01T10:00"), "UTC")],
      exdates: [calTimed(dt("2026-01-02T10:00"), "UTC")],
    };
    expect(calCountBefore(set, utc("2026-02-01T00:00:00"))).toBe(3);
  });

  it("terminates for a never-matching rule", () => {
    const set = { dtstart, rule: calParseRRule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30") };
    expect(calCountBefore(set, utc("2100-01-01T00:00:00"))).toBe(1);
  });
});

describe("calReminderIsCurrent", () => {
  it("accepts only the matching generation", () => {
    expect(calReminderIsCurrent({ generation: 3 }, 3)).toBe(true);
    expect(calReminderIsCurrent({ generation: 2 }, 3)).toBe(false);
    expect(calReminderIsCurrent({ generation: 4 }, 3)).toBe(false);
  });
});

describe("calApplySeriesChanges", () => {
  const timed: CalSeries = {
    uid: "s",
    dtstart: calTimed(dt("2026-03-01T09:00"), "Europe/Berlin"),
    dtend: calTimed(dt("2026-03-01T10:30"), "Europe/Berlin"),
    rule: calParseRRule("FREQ=WEEKLY"),
    data: { summary: "Standup", location: "Room 1" },
  };

  it("moving the start keeps the duration", () => {
    const next = calApplySeriesChanges(timed, {
      start: calTimed(dt("2026-03-02T14:00"), "Europe/Berlin"),
    });
    expect(next.dtend).toEqual(calTimed(dt("2026-03-02T15:30"), "Europe/Berlin"));
    expect(next.rule).toBe(timed.rule);
  });

  it("an explicit end wins", () => {
    const end = calTimed(dt("2026-03-02T18:00"), "Europe/Berlin");
    const next = calApplySeriesChanges(timed, {
      start: calTimed(dt("2026-03-02T14:00"), "Europe/Berlin"),
      end,
    });
    expect(next.dtend).toEqual(end);
  });

  it("null removes the rule, undefined keeps it, a new rule replaces it", () => {
    expect(calApplySeriesChanges(timed, { rule: null }).rule).toBeUndefined();
    expect(calApplySeriesChanges(timed, { rule: undefined }).rule).toBe(timed.rule);
    const daily = calParseRRule("FREQ=DAILY");
    expect(calApplySeriesChanges(timed, { rule: daily }).rule).toBe(daily);
  });

  it("merges data and leaves timing alone when only data changes", () => {
    const next = calApplySeriesChanges(timed, { data: { summary: "Sync" } });
    expect(next.data).toEqual({ summary: "Sync", location: "Room 1" });
    expect(next.dtstart).toBe(timed.dtstart);
    expect(next.dtend).toBe(timed.dtend);
    expect(timed.data.summary).toBe("Standup");
  });

  it("all-day series: moving keeps day span; a timed start keeps the old all-day end", () => {
    const allDay: CalSeries = {
      uid: "a",
      dtstart: calAllDay({ year: 2026, month: 3, day: 1 }),
      dtend: calAllDay({ year: 2026, month: 3, day: 3 }),
      data: { summary: "Trip" },
    };
    expect(
      calApplySeriesChanges(allDay, { start: calAllDay({ year: 2026, month: 3, day: 10 }) }).dtend,
    ).toEqual(calAllDay({ year: 2026, month: 3, day: 12 }));
    const mixed = calApplySeriesChanges(allDay, {
      start: calTimed(dt("2026-03-10T09:00"), "UTC"),
    });
    expect(mixed.dtend).toBe(allDay.dtend);
  });
});

describe("calParseTimeValue / calResolveTzid", () => {
  const ctx = () => ({ defaultZone: "Europe/London", warnings: [] as Array<string> });

  it("parses UTC, DATE, and floating values", () => {
    expect(calParseTimeValue("20260310T090000Z", {}, ctx())).toEqual(
      calTimed(dt("2026-03-10T09:00"), "UTC"),
    );
    expect(calParseTimeValue("20260310", {}, ctx())).toEqual(
      calAllDay({ year: 2026, month: 3, day: 10 }),
    );
    expect(calParseTimeValue("20260310T090000", { VALUE: "DATE" }, ctx())).toEqual(
      calAllDay({ year: 2026, month: 3, day: 10 }),
    );
    // Floating time uses the default zone without a warning.
    const c = ctx();
    expect(calParseTimeValue("20260310T090000", {}, c)).toEqual(
      calTimed(dt("2026-03-10T09:00"), "Europe/London"),
    );
    expect(c.warnings).toEqual([]);
  });

  it("clamps leap seconds and rejects malformed values", () => {
    expect(calParseTimeValue("20261231T235960Z", {}, ctx())).toEqual(
      calTimed(dt("2026-12-31T23:59:59"), "UTC"),
    );
    expect(() => calParseTimeValue("2026-03-10", {}, ctx())).toThrow();
    expect(() => calParseTimeValue("20260310T0900", {}, ctx())).toThrow();
  });

  it("resolves TZID params, and warns and falls back on unknown zones", () => {
    expect(calParseTimeValue("20260310T090000", { TZID: "Pacific Standard Time" }, ctx())).toEqual(
      calTimed(dt("2026-03-10T09:00"), "America/Los_Angeles"),
    );
    const c = ctx();
    expect(calParseTimeValue("20260310T090000", { TZID: "Mars/Olympus" }, c)).toEqual(
      calTimed(dt("2026-03-10T09:00"), "Europe/London"),
    );
    expect(c.warnings).toEqual(["unknown TZID Mars/Olympus; using Europe/London"]);
    // A Z suffix wins over TZID.
    expect(calParseTimeValue("20260310T090000Z", { TZID: "Asia/Tokyo" }, ctx())).toEqual(
      calTimed(dt("2026-03-10T09:00"), "UTC"),
    );
  });

  it("resolves IANA, quoted, Windows and vendor-prefixed TZIDs", () => {
    expect(calResolveTzid("America/New_York")).toBe("America/New_York");
    expect(calResolveTzid(' "Europe/Paris" ')).toBe("Europe/Paris");
    expect(calResolveTzid("UTC")).toBe("UTC");
    expect(calResolveTzid("Tokyo Standard Time")).toBe("Asia/Tokyo");
    expect(calResolveTzid("/mozilla.org/20050126_1/America/New_York")).toBe("America/New_York");
    expect(calResolveTzid("/softwarestudio.org/Olson_20011030_5/Europe/Berlin")).toBe(
      "Europe/Berlin",
    );
    expect(calResolveTzid("Mars/Olympus")).toBeUndefined();
    expect(calResolveTzid("")).toBeUndefined();
  });
});
