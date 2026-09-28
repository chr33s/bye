import { calFormatUtcStamp } from "./ics.ts";
import { calCountBefore, calExpand, type CalRRule } from "./rrule.ts";
import {
  type CalDuration,
  calDurationBetween,
  calEndFor,
  calInstant,
  type CalTime,
} from "./time.ts";
import { calAddDays, calDateToDays, calFormatDate, calStartOfDay } from "./tz.ts";

// Event series, occurrence exceptions (RECURRENCE-ID), and deliberate "this and future" splits (§9).

export type CalEventStatus = "confirmed" | "tentative" | "cancelled";

export interface CalEventData {
  readonly summary: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly url?: string | undefined;
  /** TRANSP:TRANSPARENT events do not block free time. */
  readonly transparent?: boolean | undefined;
  readonly status?: CalEventStatus | undefined;
}

export interface CalSeries {
  readonly uid: string;
  readonly dtstart: CalTime;
  readonly dtend: CalTime;
  readonly rule?: CalRRule | undefined;
  readonly rdates?: ReadonlyArray<CalTime> | undefined;
  readonly exdates?: ReadonlyArray<CalTime> | undefined;
  /**
   * Set when the series was defined by an ICS DURATION with days/weeks: every occurrence then
   * applies it in wall-clock time. Absent (all v1 data): the `dtend - dtstart` length is reused.
   */
  readonly duration?: CalDuration | undefined;
  readonly data: CalEventData;
}

export interface CalException {
  /** Original occurrence key (RECURRENCE-ID) in the series zone. */
  readonly recurrenceKey: string;
  readonly cancelled: boolean;
  readonly start?: CalTime | undefined;
  readonly end?: CalTime | undefined;
  readonly data?: Partial<CalEventData> | undefined;
}

export interface CalOccurrence {
  readonly uid: string;
  readonly key: string;
  readonly start: CalTime;
  readonly end: CalTime;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
  readonly data: CalEventData;
  readonly isException: boolean;
  readonly recurring: boolean;
}

export interface CalWindow {
  readonly from: number;
  readonly to: number;
  readonly viewerZone?: string;
}

/** The series' per-occurrence duration: its nominal DURATION when set, else `dtend - dtstart`. */
export const calSeriesDuration = (series: CalSeries): CalDuration =>
  series.duration ?? calDurationBetween(series.dtstart, series.dtend);

/** End of an occurrence starting at `start`, keeping the series' duration. */
const endFor = (series: CalSeries, start: CalTime): CalTime =>
  calEndFor(start, calSeriesDuration(series));

const spanMs = (
  start: CalTime,
  end: CalTime,
  viewerZone: string,
): { startMs: number; endMs: number } =>
  start.kind === "date" && end.kind === "date"
    ? { startMs: calStartOfDay(start.date, viewerZone), endMs: calStartOfDay(end.date, viewerZone) }
    : { startMs: calInstant(start, viewerZone), endMs: calInstant(end, viewerZone) };

/** Expand a series plus its exceptions into concrete occurrences overlapping the window. */
export const calExpandSeries = (
  series: CalSeries,
  exceptions: ReadonlyArray<CalException>,
  window: CalWindow,
  maxOccurrences = 2000,
): Array<CalOccurrence> => {
  const viewerZone = window.viewerZone ?? "UTC";
  const byKey = new Map(exceptions.map((e) => [e.recurrenceKey, e]));
  const recurring = !!series.rule || (series.rdates?.length ?? 0) > 0;
  const base = spanMs(series.dtstart, series.dtend, viewerZone);
  const durationMs = Math.max(0, base.endMs - base.startMs);

  const starts = calExpand(
    {
      dtstart: series.dtstart,
      rule: series.rule,
      rdates: series.rdates ?? [],
      exdates: series.exdates ?? [],
    },
    {
      from: window.from - 7 * 86_400_000,
      to: window.to + 7 * 86_400_000,
      durationMs,
      viewerZone,
      maxOccurrences: maxOccurrences + 100,
    },
  );

  const out: Array<CalOccurrence> = [];
  const seen = new Set<string>();

  const emit = (
    key: string,
    start: CalTime,
    end: CalTime,
    data: CalEventData,
    isException: boolean,
  ): void => {
    const { startMs, endMs } = spanMs(start, end, viewerZone);

    if (!(startMs < window.to && Math.max(endMs, startMs + 1) > window.from)) return;
    seen.add(key);
    out.push({
      uid: series.uid,
      key,
      start,
      end,
      startMs,
      endMs,
      allDay: start.kind === "date",
      data,
      isException,
      recurring,
    });
  };

  for (const s of starts) {
    const exception = byKey.get(s.key);

    if (exception?.cancelled) {
      seen.add(s.key);
      continue;
    }

    if (exception) {
      const start = exception.start ?? s.start;
      const end = exception.end ?? endFor(series, start);
      emit(s.key, start, end, { ...series.data, ...exception.data }, true);
    } else {
      emit(s.key, s.start, endFor(series, s.start), series.data, false);
    }
  }

  // Overrides moved into the window from an original time outside the expansion range.
  for (const e of exceptions) {
    if (e.cancelled || seen.has(e.recurrenceKey) || !e.start) continue;
    const end = e.end ?? endFor(series, e.start);
    emit(e.recurrenceKey, e.start, end, { ...series.data, ...e.data }, true);
  }

  return out
    .sort((a, b) => a.startMs - b.startMs || a.uid.localeCompare(b.uid))
    .slice(0, maxOccurrences);
};

export interface CalSplitResult {
  /** Series ending before the split; `undefined` when splitting at the first occurrence. */
  readonly head: CalSeries | undefined;
  readonly headExceptions: ReadonlyArray<CalException>;
  readonly tail: CalSeries;
  readonly tailExceptions: ReadonlyArray<CalException>;
  readonly mapping: {
    readonly originalUid: string;
    readonly newUid: string;
    readonly splitKey: string;
  };
}

/**
 * Split a series at an occurrence for "edit this and future". The head keeps the original UID
 * and ends just before the split; the tail gets `newUid` and keeps the remaining COUNT. The
 * mapping is persisted so later invitation updates addressed to either UID can be routed.
 */
export const calSplitSeries = (
  series: CalSeries,
  exceptions: ReadonlyArray<CalException>,
  split: { readonly key: string; readonly start: CalTime },
  newUid: string,
): CalSplitResult => {
  const splitMs = calInstant(split.start);
  const beforeCount = calCountBefore({ dtstart: series.dtstart, rule: series.rule }, splitMs);
  const isBefore = (t: CalTime): boolean => calInstant(t) < splitMs;
  const keyBefore = (k: string): boolean => k < split.key;
  const mapping = { originalUid: series.uid, newUid, splitKey: split.key };
  const tailStart = split.start;
  const tailEnd = endFor(series, tailStart);

  let tailRule: CalRRule | undefined;

  if (series.rule) {
    tailRule =
      series.rule.count === undefined
        ? { ...series.rule }
        : { ...series.rule, count: Math.max(1, series.rule.count - beforeCount) };
  }

  const tail: CalSeries = {
    ...series,
    uid: newUid,
    dtstart: tailStart,
    dtend: tailEnd,
    rule: tailRule,
    rdates: (series.rdates ?? []).filter((t) => !isBefore(t)),
    exdates: (series.exdates ?? []).filter((t) => !isBefore(t)),
  };

  const tailExceptions = exceptions.filter((e) => !keyBefore(e.recurrenceKey));

  if (beforeCount === 0)
    return { head: undefined, headExceptions: [], tail, tailExceptions, mapping };

  const headUntil =
    series.dtstart.kind === "date" && split.start.kind === "date"
      ? calFormatDate(calAddDays(split.start.date, -1)).replace(/-/g, "")
      : calFormatUtcStamp(splitMs - 1000);

  const headRule: CalRRule | undefined = series.rule
    ? (() => {
        const { count: _count, until: _until, ...rest } = series.rule;

        return series.rule.count !== undefined
          ? { ...rest, count: beforeCount }
          : { ...rest, until: headUntil };
      })()
    : undefined;

  const head: CalSeries = {
    ...series,
    rule: headRule,
    rdates: (series.rdates ?? []).filter(isBefore),
    exdates: (series.exdates ?? []).filter(isBefore),
  };

  return {
    head,
    headExceptions: exceptions.filter((e) => keyBefore(e.recurrenceKey)),
    tail,
    tailExceptions,
    mapping,
  };
};

export const calDaySpan = (start: CalTime, end: CalTime): number =>
  start.kind === "date" && end.kind === "date"
    ? calDateToDays(end.date) - calDateToDays(start.date)
    : 0;

/** Changes to a series' timing, rule and shared data (the organizer-owned part of an event). */
export interface CalSeriesChanges {
  readonly start?: CalTime | undefined;
  readonly end?: CalTime | undefined;
  /** `null` removes the rule; `undefined` keeps it. */
  readonly rule?: CalRRule | null | undefined;
  readonly data?: Partial<CalEventData> | undefined;
}

/**
 * Apply changes to a series. Moving the start without a new end keeps the duration (`calEndFor`).
 * One exception: a timed start on an all-day series keeps the old all-day end, so the mixed kinds
 * are rejected by validation instead of silently inventing a timed end.
 */
export const calApplySeriesChanges = (series: CalSeries, changes: CalSeriesChanges): CalSeries => {
  const start = changes.start ?? series.dtstart;

  const end =
    changes.end ??
    (changes.start && !(changes.start.kind === "timed" && series.dtend.kind === "date")
      ? endFor(series, changes.start)
      : series.dtend);

  // An explicit new end replaces a DURATION-defined length; otherwise it is kept.
  const { duration, ...rest } = series;

  const updated: CalSeries = {
    ...rest,
    dtstart: start,
    dtend: end,
    rule: changes.rule === null ? undefined : (changes.rule ?? series.rule),
    data: { ...series.data, ...changes.data },
  };

  return duration && !changes.end ? { ...updated, duration } : updated;
};
