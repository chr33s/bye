import { describe, expect, it } from "vitest";
import {
  calApplySeriesChanges,
  calEndFor,
  calExpandSeries,
  calParseCalendar,
  calSplitSeries,
  calTimed,
} from "@bye/calendar-engine";

const ny = (s: string) => {
  const [d, t] = s.split("T");
  const [year, month, day] = d!.split("-").map(Number);
  const [hour, minute, second] = t!.split(":").map(Number);
  return calTimed(
    { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! },
    "America/New_York",
  );
};

const ics = (lines: string): string =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dur\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

const window = { from: Date.parse("2026-10-30T00:00:00Z"), to: Date.parse("2026-11-08T00:00:00Z") };

describe("nominal DURATION across DST", () => {
  it("calEndFor applies nominal days in wall-clock time", () => {
    const end = calEndFor(ny("2026-10-31T12:00:00"), { kind: "nominal", days: 1, ms: 0 });
    expect(end).toEqual(ny("2026-11-01T12:00:00"));
    const later = calEndFor(ny("2026-11-01T12:00:00"), { kind: "nominal", days: 1, ms: 3_600_000 });
    expect(later).toEqual(ny("2026-11-02T13:00:00"));
  });

  it("a recurring P1D series ends every occurrence at the same wall-clock time next day", () => {
    const [e] = calParseCalendar(
      ics(
        "DTSTART;TZID=America/New_York:20261031T120000\r\nDURATION:P1D\r\nRRULE:FREQ=DAILY;COUNT=4",
      ),
    ).events;
    const occ = calExpandSeries(e!.series, [], window);
    expect(occ.map((o) => o.end)).toEqual([
      ny("2026-11-01T12:00:00"),
      ny("2026-11-02T12:00:00"),
      ny("2026-11-03T12:00:00"),
      ny("2026-11-04T12:00:00"),
    ]);
  });

  it("DTEND series and hour durations keep exact elapsed length (v1 behaviour)", () => {
    const [e] = calParseCalendar(
      ics(
        "DTSTART;TZID=America/New_York:20261031T120000\r\nDTEND;TZID=America/New_York:20261101T120000\r\nRRULE:FREQ=DAILY;COUNT=3",
      ),
    ).events;
    expect(e!.series.duration).toBeUndefined();
    const occ = calExpandSeries(e!.series, [], window);
    expect(occ[1]!.end).toEqual(ny("2026-11-02T13:00:00"));
  });

  it("survives a split and is replaced by an explicit new end", () => {
    const [e] = calParseCalendar(
      ics(
        "DTSTART;TZID=America/New_York:20261031T120000\r\nDURATION:P1D\r\nRRULE:FREQ=DAILY;COUNT=4",
      ),
    ).events;
    const split = calSplitSeries(
      e!.series,
      [],
      { key: "20261102T120000", start: ny("2026-11-02T12:00:00") },
      "dur2",
    );
    expect(split.tail.duration).toEqual({ kind: "nominal", days: 1, ms: 0 });
    expect(split.tail.dtend).toEqual(ny("2026-11-03T12:00:00"));
    const moved = calApplySeriesChanges(e!.series, { start: ny("2026-11-01T12:00:00") });
    expect(moved.duration).toBeDefined();
    const resized = calApplySeriesChanges(e!.series, { end: ny("2026-10-31T13:00:00") });
    expect(resized.duration).toBeUndefined();
  });
});
