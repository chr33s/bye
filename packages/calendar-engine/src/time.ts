import {
  calAddDays,
  calCompareDates,
  calDateOf,
  calDateToDays,
  calDaysInMonth,
  calFormatDate,
  calFormatDateTime,
  calIsValidTimeZone,
  type CalLocalDate,
  type CalLocalDateTime,
  calParseDate,
  calStartOfDay,
  calWallClock,
  calZonedToInstant,
} from "./tz.ts";

/** A calendar time value: a timed wall-clock in an IANA zone, or a floating all-day date. */
export type CalTime =
  | { readonly kind: "timed"; readonly local: CalLocalDateTime; readonly tzid: string }
  | { readonly kind: "date"; readonly date: CalLocalDate };

export const calTimed = (local: CalLocalDateTime, tzid: string): CalTime => ({
  kind: "timed",
  local,
  tzid,
});
export const calAllDay = (date: CalLocalDate): CalTime => ({ kind: "date", date });

/**
 * Derived instant. All-day dates have no inherent instant; `viewerZone` decides where the
 * date starts for display/free-time purposes only — the stored value remains a date.
 */
export const calInstant = (t: CalTime, viewerZone = "UTC"): number =>
  t.kind === "timed" ? calZonedToInstant(t.local, t.tzid) : calStartOfDay(t.date, viewerZone);

const inRange = (n: unknown, min: number, max: number): boolean =>
  Number.isInteger(n) && (n as number) >= min && (n as number) <= max;

const dateProblem = (d: CalLocalDate | undefined): string | undefined => {
  if (!d || !inRange(d.year, 1, 9999)) return "year out of range";
  if (!inRange(d.month, 1, 12)) return "month out of range";
  if (!inRange(d.day, 1, calDaysInMonth(d.year, d.month))) return "day out of range";
  return undefined;
};

/**
 * Why a time value is unusable — an unknown zone or an out-of-range field that `Date` would
 * silently roll over — or `undefined` when it is valid. Guards every value from outside the engine.
 */
export const calTimeProblem = (t: CalTime): string | undefined => {
  if (t.kind === "date") return dateProblem(t.date);
  if (t.kind !== "timed") return "unknown time kind";
  if (typeof t.tzid !== "string" || t.tzid.length === 0 || !calIsValidTimeZone(t.tzid))
    return `unknown time zone ${String(t.tzid)}`;
  const l = t.local;
  const d = dateProblem(l);
  if (d) return d;
  if (!inRange(l.hour, 0, 23) || !inRange(l.minute, 0, 59) || !inRange(l.second, 0, 59))
    return "time of day out of range";
  return undefined;
};

/** Stable occurrence key (RECURRENCE-ID value in the series' own zone). */
export const calTimeKey = (t: CalTime): string =>
  t.kind === "timed"
    ? calFormatDateTime(t.local).replace(/[-:]/g, "")
    : calFormatDate(t.date).replace(/-/g, "");

/**
 * Occurrence key for a RECURRENCE-ID addressed to a series. RFC 5545 lets a RECURRENCE-ID use any
 * zone (UTC, another TZID); series keys are wall clocks in the series' own zone (all-day: dates),
 * so the RECURRENCE-ID is normalized to the series' form before keying. Without a known series,
 * the RECURRENCE-ID is keyed as given.
 */
export const calRecurrenceKey = (recurrenceId: CalTime, seriesStart?: CalTime): string => {
  if (!seriesStart) return calTimeKey(recurrenceId);
  if (seriesStart.kind === "date")
    return calTimeKey(
      recurrenceId.kind === "date"
        ? recurrenceId
        : { kind: "date", date: calDateOf(recurrenceId.local) },
    );
  if (recurrenceId.kind === "date")
    return calTimeKey({
      kind: "timed",
      tzid: seriesStart.tzid,
      local: {
        ...recurrenceId.date,
        hour: seriesStart.local.hour,
        minute: seriesStart.local.minute,
        second: seriesStart.local.second,
      },
    });
  if (recurrenceId.tzid === seriesStart.tzid) return calTimeKey(recurrenceId);
  return calTimeKey({
    kind: "timed",
    tzid: seriesStart.tzid,
    local: calWallClock(calInstant(recurrenceId), seriesStart.tzid),
  });
};

export const calCompareTimes = (a: CalTime, b: CalTime): number => {
  if (a.kind === "date" && b.kind === "date") return calCompareDates(a.date, b.date);
  return calInstant(a) - calInstant(b);
};

/** Duration between start and end: milliseconds for timed, days for all-day. */
export type CalDuration =
  | { readonly kind: "ms"; readonly ms: number }
  | { readonly kind: "days"; readonly days: number };

export const calDurationBetween = (start: CalTime, end: CalTime): CalDuration => {
  if (start.kind === "date" && end.kind === "date")
    return { kind: "days", days: Math.max(1, calDateToDays(end.date) - calDateToDays(start.date)) };
  return { kind: "ms", ms: Math.max(0, calInstant(end) - calInstant(start)) };
};

/**
 * The end of an occurrence that starts at `start` and lasts `duration` — THE one "end from start
 * plus duration" rule (§9). All-day: whole days, at least one (a timed duration rounds to days).
 * Timed: exact elapsed time in the start's zone, matching RFC 5545 DURATION semantics for
 * hours/minutes (a 1h meeting across a DST change stays 1h).
 */
export const calEndFor = (start: CalTime, duration: CalDuration): CalTime => {
  if (start.kind === "date") {
    const days =
      duration.kind === "days" ? duration.days : Math.max(1, Math.round(duration.ms / 86_400_000));
    return { kind: "date", date: calAddDays(start.date, days) };
  }
  const ms = duration.kind === "ms" ? duration.ms : duration.days * 86_400_000;
  return {
    kind: "timed",
    tzid: start.tzid,
    local: calWallClock(calInstant(start) + ms, start.tzid),
  };
};

/**
 * Inverse of `calTimeKey` for a series: the original start of the occurrence with that key, in the
 * series' own form (all-day date, or wall clock in the series zone). Throws on a malformed key.
 */
export const calTimeFromKey = (dtstart: CalTime, key: string): CalTime => {
  if (dtstart.kind === "date") {
    if (!/^\d{8}$/.test(key)) throw new Error("invalid occurrence key");
    return { kind: "date", date: calParseDate(key) };
  }
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})$/.exec(key);
  if (!m) throw new Error("invalid occurrence key");
  const d = calParseDate(m[1]!);
  return {
    kind: "timed",
    tzid: dtstart.tzid,
    local: { ...d, hour: Number(m[2]), minute: Number(m[3]), second: Number(m[4]) },
  };
};
