import { calInstant, type CalTime, calTimeKey } from "./time.ts";
import {
  calAddDays,
  calAtTime,
  calDateOf,
  calDateToDays,
  calDaysInMonth,
  calDaysToDate,
  type CalLocalDate,
  calWeekday,
  calZonedToInstant,
} from "./tz.ts";

// RFC 5545 recurrence rules with bounded window expansion (§9). Infinite rules are never
// pre-generated; callers always pass a window and an occurrence cap.

export type CalFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface CalByDay {
  /** 0 = SU … 6 = SA */
  readonly weekday: number;
  readonly ordinal?: number;
}

export interface CalRRule {
  readonly freq: CalFreq;
  readonly interval: number;
  readonly count?: number;
  /** Raw RFC 5545 UNTIL value: YYYYMMDD, YYYYMMDDTHHMMSSZ (UTC) or YYYYMMDDTHHMMSS (series zone). */
  readonly until?: string;
  readonly byDay?: ReadonlyArray<CalByDay>;
  readonly byMonthDay?: ReadonlyArray<number>;
  readonly byMonth?: ReadonlyArray<number>;
  readonly bySetPos?: ReadonlyArray<number>;
  readonly wkst: number;
}

export class CalRRuleError extends Error {
  readonly _tag = "CalRRuleError";
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const FREQS: ReadonlyArray<CalFreq> = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const SUPPORTED = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);

const intList = (value: string, min: number, max: number, allowNegative: boolean): Array<number> =>
  value.split(",").map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > max || (!allowNegative && n < min)) {
      throw new CalRRuleError(`invalid list value ${v}`);
    }
    return n;
  });

export const calParseRRule = (input: string): CalRRule => {
  const text = input.trim().replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const segment of text.split(";")) {
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq < 0) throw new CalRRuleError(`malformed rule part ${segment}`);
    const key = segment.slice(0, eq).toUpperCase();
    if (!SUPPORTED.has(key)) throw new CalRRuleError(`unsupported rule part ${key}`);
    parts.set(key, segment.slice(eq + 1).toUpperCase());
  }
  const freq = parts.get("FREQ") as CalFreq | undefined;
  if (!freq || !FREQS.includes(freq))
    throw new CalRRuleError(`unsupported FREQ ${freq ?? "(missing)"}`);
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) throw new CalRRuleError("invalid INTERVAL");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1))
    throw new CalRRuleError("invalid COUNT");
  const until = parts.get("UNTIL");
  if (until !== undefined && !/^\d{8}(T\d{6}Z?)?$/.test(until))
    throw new CalRRuleError("invalid UNTIL");
  if (count !== undefined && until !== undefined)
    throw new CalRRuleError("COUNT and UNTIL are mutually exclusive");
  const byDay = parts
    .get("BYDAY")
    ?.split(",")
    .map((v): CalByDay => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(v);
      if (!m) throw new CalRRuleError(`invalid BYDAY ${v}`);
      const weekday = WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]);
      if (m[1] === undefined) return { weekday };
      const ordinal = Number(m[1]);
      if (ordinal === 0 || Math.abs(ordinal) > 53)
        throw new CalRRuleError(`invalid BYDAY ordinal ${v}`);
      return { weekday, ordinal };
    });
  const wkstRaw = parts.get("WKST") ?? "MO";
  const wkst = WEEKDAYS.indexOf(wkstRaw as (typeof WEEKDAYS)[number]);
  if (wkst < 0) throw new CalRRuleError("invalid WKST");
  const rule: CalRRule = {
    freq,
    interval,
    wkst,
    ...(count !== undefined ? { count } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(byDay ? { byDay } : {}),
    ...(parts.has("BYMONTHDAY")
      ? { byMonthDay: intList(parts.get("BYMONTHDAY")!, 1, 31, true) }
      : {}),
    ...(parts.has("BYMONTH") ? { byMonth: intList(parts.get("BYMONTH")!, 1, 12, false) } : {}),
    ...(parts.has("BYSETPOS") ? { bySetPos: intList(parts.get("BYSETPOS")!, 1, 366, true) } : {}),
  };
  return rule;
};

export const calSerializeRRule = (rule: CalRRule): string => {
  const out = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) out.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) out.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) out.push(`UNTIL=${rule.until}`);
  if (rule.byDay?.length)
    out.push(
      `BYDAY=${rule.byDay.map((d) => `${d.ordinal ?? ""}${WEEKDAYS[d.weekday]}`).join(",")}`,
    );
  if (rule.byMonthDay?.length) out.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth?.length) out.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.bySetPos?.length) out.push(`BYSETPOS=${rule.bySetPos.join(",")}`);
  if (rule.wkst !== 1) out.push(`WKST=${WEEKDAYS[rule.wkst]}`);
  return out.join(";");
};

// ---- candidate generation per period ----

const nthDays = (
  all: ReadonlyArray<CalLocalDate>,
  ordinal: number | undefined,
): Array<CalLocalDate> => {
  if (ordinal === undefined) return [...all];
  const picked = ordinal > 0 ? all[ordinal - 1] : all[all.length + ordinal];
  return picked ? [picked] : [];
};

const daysOfMonth = (year: number, month: number): Array<CalLocalDate> =>
  Array.from({ length: calDaysInMonth(year, month) }, (_, i) => ({ year, month, day: i + 1 }));

const monthCandidates = (
  rule: CalRRule,
  year: number,
  month: number,
  dtDay: number,
): Array<CalLocalDate> => {
  const dim = calDaysInMonth(year, month);
  const all = daysOfMonth(year, month);
  let byMonthDay: Array<CalLocalDate> | undefined;
  if (rule.byMonthDay?.length) {
    byMonthDay = rule.byMonthDay
      .map((v) => (v > 0 ? v : dim + 1 + v))
      .filter((d) => d >= 1 && d <= dim)
      .map((day) => ({ year, month, day }));
  }
  let byDay: Array<CalLocalDate> | undefined;
  if (rule.byDay?.length) {
    byDay = rule.byDay.flatMap((spec) =>
      nthDays(
        all.filter((d) => calWeekday(d) === spec.weekday),
        spec.ordinal,
      ),
    );
  }
  if (byMonthDay && byDay) {
    const keys = new Set(byDay.map((d) => d.day));
    return byMonthDay.filter((d) => keys.has(d.day));
  }
  if (byMonthDay) return byMonthDay;
  if (byDay) return byDay;
  return dtDay <= dim ? [{ year, month, day: dtDay }] : [];
};

const weekStartOf = (d: CalLocalDate, wkst: number): CalLocalDate =>
  calAddDays(d, -((calWeekday(d) - wkst + 7) % 7));

const addMonths = (year: number, month: number, n: number): { year: number; month: number } => {
  const index = year * 12 + (month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

const periodCandidates = (rule: CalRRule, dt: CalLocalDate, n: number): Array<CalLocalDate> => {
  const step = n * rule.interval;
  let out: Array<CalLocalDate>;
  switch (rule.freq) {
    case "DAILY": {
      const day = calAddDays(dt, step);
      const ok =
        (!rule.byMonth || rule.byMonth.includes(day.month)) &&
        (!rule.byMonthDay ||
          rule.byMonthDay.some(
            (v) => (v > 0 ? v : calDaysInMonth(day.year, day.month) + 1 + v) === day.day,
          )) &&
        (!rule.byDay || rule.byDay.some((s) => s.weekday === calWeekday(day)));
      out = ok ? [day] : [];
      break;
    }
    case "WEEKLY": {
      const start = calAddDays(weekStartOf(dt, rule.wkst), 7 * step);
      const weekdays = rule.byDay?.map((s) => s.weekday) ?? [calWeekday(dt)];
      out = Array.from({ length: 7 }, (_, i) => calAddDays(start, i)).filter(
        (d) =>
          weekdays.includes(calWeekday(d)) && (!rule.byMonth || rule.byMonth.includes(d.month)),
      );
      break;
    }
    case "MONTHLY": {
      const { year, month } = addMonths(dt.year, dt.month, step);
      out =
        !rule.byMonth || rule.byMonth.includes(month)
          ? monthCandidates(rule, year, month, dt.day)
          : [];
      break;
    }
    case "YEARLY": {
      const year = dt.year + step;
      if (!rule.byMonth && rule.byDay?.length && !rule.byMonthDay) {
        const all: Array<CalLocalDate> = [];
        for (let m = 1; m <= 12; m++) all.push(...daysOfMonth(year, m));
        out = rule.byDay.flatMap((spec) =>
          nthDays(
            all.filter((d) => calWeekday(d) === spec.weekday),
            spec.ordinal,
          ),
        );
      } else {
        // RFC 5545: without BYMONTH, a YEARLY BYMONTHDAY expands in every month of the year
        // (BYDAY then limits); only a plain YEARLY rule stays on DTSTART's month.
        const months =
          rule.byMonth ??
          (rule.byMonthDay?.length ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [dt.month]);
        out = months.flatMap((m) =>
          rule.byMonthDay?.length || rule.byDay?.length
            ? monthCandidates(rule, year, m, dt.day)
            : dt.day <= calDaysInMonth(year, m)
              ? [{ year, month: m, day: dt.day }]
              : [],
        );
      }
      break;
    }
  }
  const sorted = [...new Map(out.map((d) => [calDateToDays(d), d])).entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, d]) => d);
  if (!rule.bySetPos?.length) return sorted;
  return [
    ...new Set(
      rule.bySetPos
        .map((p) => sorted[p > 0 ? p - 1 : sorted.length + p])
        .filter((d): d is CalLocalDate => !!d),
    ),
  ].sort((a, b) => calDateToDays(a) - calDateToDays(b));
};

// ---- expansion ----

export interface CalRecurrenceSet {
  readonly dtstart: CalTime;
  readonly rule?: CalRRule;
  readonly rdates?: ReadonlyArray<CalTime>;
  readonly exdates?: ReadonlyArray<CalTime>;
}

export interface CalOccurrenceStart {
  /** RECURRENCE-ID key in the series zone. */
  readonly key: string;
  readonly start: CalTime;
  readonly startMs: number;
}

export interface CalExpandOptions {
  readonly from: number;
  readonly to: number;
  /** Occurrence duration, so occurrences that started before `from` but overlap it are included. */
  readonly durationMs?: number;
  readonly viewerZone?: string;
  readonly maxOccurrences?: number;
  /** Hard bound on iterated periods to keep expansion bounded for pathological rules. */
  readonly maxPeriods?: number;
}

const withDate = (dtstart: CalTime, date: CalLocalDate): CalTime =>
  dtstart.kind === "timed"
    ? {
        kind: "timed",
        tzid: dtstart.tzid,
        local: calAtTime(date, dtstart.local.hour, dtstart.local.minute, dtstart.local.second),
      }
    : { kind: "date", date };

const untilPredicate = (until: string | undefined, dtstart: CalTime): ((t: CalTime) => boolean) => {
  if (!until) return () => true;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(until)!;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (m[4] === undefined) {
    const limit = calDateToDays(date);
    return (t) => calDateToDays(t.kind === "timed" ? t.local : t.date) <= limit;
  }
  const local = calAtTime(date, Number(m[4]), Number(m[5]), Number(m[6]));
  const limitMs =
    m[7] === "Z"
      ? Date.UTC(date.year, date.month - 1, date.day, local.hour, local.minute, local.second)
      : calZonedToInstant(local, dtstart.kind === "timed" ? dtstart.tzid : "UTC");
  return (t) => calInstant(t) <= limitMs;
};

const firstUsefulPeriod = (
  rule: CalRRule,
  dt: CalLocalDate,
  fromMs: number,
  dtMs: number,
  durationMs: number,
): number => {
  if (rule.count !== undefined) return 0; // COUNT must be counted from DTSTART.
  const target = fromMs - durationMs - 2 * 86_400_000;
  if (target <= dtMs) return 0;
  const days = Math.floor((target - dtMs) / 86_400_000);
  const periodDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[rule.freq] * rule.interval;
  if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    const approxDate = calDaysToDate(calDateToDays(dt) + days);
    const months = (approxDate.year - dt.year) * 12 + (approxDate.month - dt.month);
    const periods =
      rule.freq === "MONTHLY"
        ? Math.floor(months / rule.interval)
        : Math.floor(months / 12 / rule.interval);
    return Math.max(0, periods - 1);
  }
  return Math.max(0, Math.floor(days / periodDays) - 1);
};

/** Expand a recurrence set into occurrence starts overlapping [from, to). Always bounded. */
export const calExpand = (
  set: CalRecurrenceSet,
  options: CalExpandOptions,
): Array<CalOccurrenceStart> => {
  const viewerZone = options.viewerZone ?? "UTC";
  const durationMs = options.durationMs ?? 0;
  const maxOccurrences = options.maxOccurrences ?? 5000;
  const maxPeriods = options.maxPeriods ?? 20_000;
  const overlaps = (ms: number): boolean =>
    ms < options.to && ms + Math.max(durationMs, 1) > options.from;
  const exKeys = new Set((set.exdates ?? []).map(calTimeKey));
  const exInstants = new Set(
    (set.exdates ?? []).filter((t) => t.kind === "timed").map((t) => calInstant(t, viewerZone)),
  );
  // Mixed kinds (RFC 5545 allows either form): a date EXDATE (VALUE=DATE) on a timed series
  // excludes every occurrence on that date in the series zone; a timed EXDATE on an all-day series
  // excludes the occurrence on its (wall-clock) date.
  const dateExDays = new Set<number>();
  const timedExDays = new Set<number>();
  for (const t of set.exdates ?? []) {
    if (t.kind === "date") dateExDays.add(calDateToDays(t.date));
    else timedExDays.add(calDateToDays(t.local));
  }
  const excluded = (t: CalTime, ms: number): boolean =>
    exKeys.has(calTimeKey(t)) ||
    (t.kind === "timed"
      ? exInstants.has(ms) || dateExDays.has(calDateToDays(t.local))
      : timedExDays.has(calDateToDays(t.date)));

  const results = new Map<string, CalOccurrenceStart>();
  const push = (start: CalTime): void => {
    const startMs = calInstant(start, viewerZone);
    if (excluded(start, startMs) || !overlaps(startMs)) return;
    const key = calTimeKey(start);
    if (!results.has(key)) results.set(key, { key, start, startMs });
  };

  const dtMs = calInstant(set.dtstart, viewerZone);
  const rule = set.rule;
  if (!rule) {
    push(set.dtstart);
  } else {
    const dtDate = set.dtstart.kind === "timed" ? calDateOf(set.dtstart.local) : set.dtstart.date;
    const dtDays = calDateToDays(dtDate);
    const withinUntil = untilPredicate(rule.until, set.dtstart);
    let emitted = 0;
    // DTSTART is always the first instance (RFC 5545 §3.8.5.3), even when it does not match the rule.
    if (withinUntil(set.dtstart)) {
      emitted++;
      push(set.dtstart);
    }
    const startPeriod = firstUsefulPeriod(rule, dtDate, options.from, dtMs, durationMs);
    let done = false;
    for (let n = startPeriod; n < startPeriod + maxPeriods && !done; n++) {
      const candidates = periodCandidates(rule, dtDate, n);
      for (const date of candidates) {
        if (calDateToDays(date) <= dtDays) continue;
        const start = withDate(set.dtstart, date);
        if (!withinUntil(start)) {
          done = true;
          break;
        }
        const startMs = calInstant(start, viewerZone);
        if (rule.count !== undefined && emitted >= rule.count) {
          done = true;
          break;
        }
        emitted++;
        if (startMs >= options.to) {
          done = true;
          break;
        }
        push(start);
        if (results.size >= maxOccurrences) {
          done = true;
          break;
        }
      }
      // An empty far-future period cannot end expansion by itself; bound by the window instead.
      if (!done && candidates.length === 0) {
        const probe = periodProbe(rule, dtDate, n);
        if (calInstant(withDate(set.dtstart, probe), viewerZone) >= options.to + 366 * 86_400_000)
          done = true;
      }
    }
  }
  for (const rdate of set.rdates ?? []) push(rdate);
  return [...results.values()].sort((a, b) => a.startMs - b.startMs).slice(0, maxOccurrences);
};

const periodProbe = (rule: CalRRule, dt: CalLocalDate, n: number): CalLocalDate => {
  const step = n * rule.interval;
  switch (rule.freq) {
    case "DAILY":
      return calAddDays(dt, step);
    case "WEEKLY":
      return calAddDays(dt, step * 7);
    case "MONTHLY": {
      const { year, month } = addMonths(dt.year, dt.month, step);
      return { year, month, day: 1 };
    }
    case "YEARLY":
      return { year: dt.year + step, month: 1, day: 1 };
  }
};

/** Number of rule occurrences strictly before `beforeMs` (used for COUNT-preserving series splits). */
export const calCountBefore = (set: CalRecurrenceSet, beforeMs: number): number =>
  calExpand(
    { ...set, rdates: [], exdates: [] },
    { from: Number.MIN_SAFE_INTEGER / 2, to: beforeMs, maxOccurrences: 100_000 },
  ).length;
