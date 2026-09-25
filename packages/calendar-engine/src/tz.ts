// Time-zone math over Intl (§9). Timed events keep their original wall-clock + IANA zone;
// instants are derived. All-day values are dates, never midnight UTC.
//
// Disambiguation (RFC 5545 §3.3.5, equivalent to Temporal "compatible"):
// - DST gap (nonexistent wall time): interpret with the offset in effect *before* the gap,
//   which shifts the wall time forward by the gap length (02:30 → 03:30 in New York).
// - DST fold (repeated wall time): choose the earlier instant, i.e. the first occurrence,
//   which uses the pre-transition (larger) offset.

export interface CalLocalDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

export interface CalLocalDateTime extends CalLocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
};

export const calIsValidTimeZone = (timeZone: string): boolean => {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** Wall-clock components of an instant in a zone. */
export const calWallClock = (instant: number, timeZone: string): CalLocalDateTime => {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const era = parts.find((p) => p.type === "era")?.value;
  const rawYear = get("year");
  return {
    year: era === "BC" || era === "B" ? 1 - rawYear : rawYear,
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
};

export const calLocalAsUtc = (local: CalLocalDateTime): number => {
  const d = new Date(0);
  d.setUTCFullYear(local.year, local.month - 1, local.day);
  d.setUTCHours(local.hour, local.minute, local.second, 0);
  return d.getTime();
};

/** UTC offset in milliseconds (local − UTC) at an instant. */
export const calOffsetAt = (instant: number, timeZone: string): number => {
  const floored = Math.floor(instant / 1000) * 1000;
  return calLocalAsUtc(calWallClock(floored, timeZone)) - floored;
};

const sameWall = (a: CalLocalDateTime, b: CalLocalDateTime): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second;

export type CalResolution = "exact" | "gap-shifted" | "fold-earlier";

/** Convert a wall-clock time in a zone to an instant, with documented gap/fold handling. */
export const calZonedToInstantDetailed = (
  local: CalLocalDateTime,
  timeZone: string,
): { readonly instant: number; readonly resolution: CalResolution } => {
  const asUtc = calLocalAsUtc(local);
  const before = calOffsetAt(asUtc - DAY_MS, timeZone);
  const after = calOffsetAt(asUtc + DAY_MS, timeZone);
  const candidates = [...new Set([asUtc - before, asUtc - after])].sort((a, b) => a - b);
  const valid = candidates.filter((c) => sameWall(calWallClock(c, timeZone), local));
  if (valid.length === 0) {
    // Also try the offset exactly at asUtc in case of transitions > 1 day apart from the probe points.
    const direct = asUtc - calOffsetAt(asUtc, timeZone);
    if (sameWall(calWallClock(direct, timeZone), local))
      return { instant: direct, resolution: "exact" };
    return { instant: asUtc - before, resolution: "gap-shifted" };
  }
  if (valid.length > 1) return { instant: valid[0]!, resolution: "fold-earlier" };
  return { instant: valid[0]!, resolution: "exact" };
};

export const calZonedToInstant = (local: CalLocalDateTime, timeZone: string): number =>
  calZonedToInstantDetailed(local, timeZone).instant;

// ---- date arithmetic on plain dates (proleptic Gregorian, zone-free) ----

export const calDateToDays = (d: CalLocalDate): number =>
  Math.floor(calLocalAsUtc({ ...d, hour: 0, minute: 0, second: 0 }) / DAY_MS);

export const calDaysToDate = (days: number): CalLocalDate => {
  const d = new Date(days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

export const calAddDays = (d: CalLocalDate, n: number): CalLocalDate =>
  calDaysToDate(calDateToDays(d) + n);

/** 0 = Sunday … 6 = Saturday. */
export const calWeekday = (d: CalLocalDate): number => {
  const days = calDateToDays(d);
  return (((days + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
};

export const calDaysInMonth = (year: number, month: number): number => {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
};

export const calIsLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export const calCompareDates = (a: CalLocalDate, b: CalLocalDate): number =>
  calDateToDays(a) - calDateToDays(b);

export const calCompareDateTimes = (a: CalLocalDateTime, b: CalLocalDateTime): number =>
  calLocalAsUtc(a) - calLocalAsUtc(b);

export const calDateOf = (d: CalLocalDateTime): CalLocalDate => ({
  year: d.year,
  month: d.month,
  day: d.day,
});

export const calAtTime = (d: CalLocalDate, hour = 0, minute = 0, second = 0): CalLocalDateTime => ({
  ...d,
  hour,
  minute,
  second,
});

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** ISO date "2026-09-25". */
export const calFormatDate = (d: CalLocalDate): string =>
  `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;

export const calParseDate = (s: string): CalLocalDate => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid date: ${s}`);
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > calDaysInMonth(d.year, d.month))
    throw new Error(`invalid date: ${s}`);
  return d;
};

/** ISO local date-time "2026-09-25T09:00:00". */
export const calFormatDateTime = (d: CalLocalDateTime): string =>
  `${calFormatDate(d)}T${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)}`;

export const calParseDateTime = (s: string): CalLocalDateTime => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})?$/.exec(s.trim());
  if (!m) throw new Error(`invalid date-time: ${s}`);
  const d = calParseDate(`${m[1]}-${m[2]}-${m[3]}`);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 60) throw new Error(`invalid date-time: ${s}`);
  return { ...d, hour, minute, second: Math.min(second, 59) };
};

/** Local date of an instant as seen in a zone. */
export const calDateInZone = (instant: number, timeZone: string): CalLocalDate =>
  calDateOf(calWallClock(instant, timeZone));

/** Instant at which a local date starts in a zone (handles days that start at 01:00 due to DST). */
export const calStartOfDay = (d: CalLocalDate, timeZone: string): number =>
  calZonedToInstant(calAtTime(d), timeZone);
