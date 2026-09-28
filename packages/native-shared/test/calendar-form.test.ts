import { describe, expect, it } from "vitest";
import { buildRRule, type EventForm, eventPayload } from "../src/calendar-form.ts";

// A timed UNTIL is a UTC instant (RFC 5545 §3.3.10); it must cover the whole until-day in the
// event's own zone, or evening occurrences west of UTC on the last day are dropped.

const untilOf = (rrule: string | undefined) => /UNTIL=([^;]+)/.exec(rrule ?? "")?.[1];

const utcOf = (stamp: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)!;

  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
};

const daily = (
  timeZone: string | undefined,
  until: { year: number; month: number; day: number },
) => {
  const zone: ZoneOption = {};

  if (timeZone) zone.timeZone = timeZone;

  return buildRRule({
    frequency: "DAILY",
    interval: 1,
    byDay: [],
    ends: { kind: "until", until },
    allDay: false,
    ...zone,
  });
};

describe("buildRRule UNTIL", () => {
  it("[C02] ends at local end-of-day west of UTC so the last 18:00 occurrence survives", () => {
    const until = untilOf(daily("America/Los_Angeles", { year: 2026, month: 12, day: 31 }));
    // 23:59:59 PST (UTC-8) on 31 Dec is 07:59:59Z on 1 Jan.
    expect(until).toBe("20270101T075959Z");
    // The last occurrence: 18:00 PST on 31 Dec = 02:00Z on 1 Jan, which the old T235959Z cut off.
    const lastOccurrence = Date.UTC(2027, 0, 1, 2, 0, 0);
    expect(utcOf(until!)).toBeGreaterThanOrEqual(lastOccurrence);
    expect(utcOf(until!)).toBeLessThan(Date.UTC(2027, 0, 1, 8, 0, 0));
  });

  it("[C02] follows daylight time on the until-day", () => {
    // PDT (UTC-7) in July.
    expect(untilOf(daily("America/Los_Angeles", { year: 2026, month: 7, day: 1 }))).toBe(
      "20260702T065959Z",
    );
  });

  it("[C02] ends before UTC midnight east of UTC, excluding the next local day", () => {
    // 23:59:59 JST (UTC+9) on 31 Dec is 14:59:59Z; 09:00 JST on 1 Jan (00:00Z) is excluded.
    expect(untilOf(daily("Asia/Tokyo", { year: 2026, month: 12, day: 31 }))).toBe(
      "20261231T145959Z",
    );
  });

  it("[C02] keeps UTC end-of-day without a zone and a plain date for all-day", () => {
    expect(untilOf(daily(undefined, { year: 2026, month: 12, day: 31 }))).toBe("20261231T235959Z");
    expect(untilOf(daily("UTC", { year: 2026, month: 12, day: 31 }))).toBe("20261231T235959Z");
    expect(
      buildRRule({
        frequency: "DAILY",
        interval: 1,
        byDay: [],
        ends: { kind: "until", until: { year: 2026, month: 12, day: 31 } },
        allDay: true,
        timeZone: "America/Los_Angeles",
      }),
    ).toBe("FREQ=DAILY;UNTIL=20261231");
  });

  it("[C02] the editor payload uses the form's zone for UNTIL", () => {
    const form: EventForm = {
      calendarId: "c1",
      title: "Standup",
      allDay: false,
      start: "2026-12-01T18:00",
      end: "2026-12-01T18:30",
      timeZone: "America/Los_Angeles",
      frequency: "DAILY",
      interval: 1,
      byDay: [],
      ends: { kind: "until", until: { year: 2026, month: 12, day: 31 } },
      location: "",
      description: "",
      attendees: "",
      reminders: "",
    };

    const built = eventPayload(form);
    expect(built.ok && built.command.rrule).toBe("FREQ=DAILY;UNTIL=20270101T075959Z");
  });
});

interface ZoneOption {
  timeZone?: string;
}
