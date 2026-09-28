import type { CalOccurrence } from "./series.ts";
import {
  calAddDays,
  calDateInZone,
  calDateToDays,
  calDaysToDate,
  calFormatDate,
  type CalLocalDate,
  calOffsetAt,
  calStartOfDay,
  calWallClock,
  calWeekday,
} from "./tz.ts";

// View computations for day/week/agenda/year (C01), travel-aware display (C03),
// free time (C08), week anchors and ordering keys (C06).

export interface CalLayoutInput {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface CalLayoutItem {
  readonly id: string;
  readonly column: number;
  readonly columns: number;
}

/** Overlapping-event layout: greedy column assignment per overlap cluster. */
export const calLayoutOverlaps = (items: ReadonlyArray<CalLayoutInput>): Array<CalLayoutItem> => {
  const sorted = [...items].sort(
    (a, b) => a.startMs - b.startMs || b.endMs - a.endMs || a.id.localeCompare(b.id),
  );

  const out: Array<CalLayoutItem> = [];
  let cluster: Array<{ id: string; column: number }> = [];
  let columnsEnd: Array<number> = [];
  let clusterEnd = -Infinity;

  const flush = (): void => {
    const columns = columnsEnd.length;

    for (const c of cluster) out.push({ id: c.id, column: c.column, columns });
    cluster = [];
    columnsEnd = [];
  };

  for (const item of sorted) {
    const end = Math.max(item.endMs, item.startMs + 1);

    if (item.startMs >= clusterEnd) flush();
    let column = columnsEnd.findIndex((e) => e <= item.startMs);

    if (column < 0) {
      column = columnsEnd.length;
      columnsEnd.push(end);
    } else {
      columnsEnd[column] = end;
    }

    cluster.push({ id: item.id, column });
    clusterEnd = Math.max(clusterEnd, end);
  }

  flush();

  return out;
};

export interface CalAgendaDay {
  readonly date: string;
  readonly occurrences: ReadonlyArray<CalOccurrence>;
}

/** Group occurrences by local date in the viewer zone; multi-day events appear on each day. */
export const calAgenda = (
  occurrences: ReadonlyArray<CalOccurrence>,
  viewerZone: string,
  from: CalLocalDate,
  days: number,
): Array<CalAgendaDay> => {
  const out: Array<CalAgendaDay> = [];

  for (let i = 0; i < days; i++) {
    const date = calAddDays(from, i);
    const dayStart = calStartOfDay(date, viewerZone);
    const dayEnd = calStartOfDay(calAddDays(date, 1), viewerZone);
    const dayKey = calDateToDays(date);

    const list = occurrences.filter((o) => {
      if (o.allDay && o.start.kind === "date" && o.end.kind === "date") {
        return calDateToDays(o.start.date) <= dayKey && dayKey < calDateToDays(o.end.date);
      }

      return o.startMs < dayEnd && Math.max(o.endMs, o.startMs + 1) > dayStart;
    });

    if (list.length) out.push({ date: calFormatDate(date), occurrences: list });
  }

  return out;
};

/** Year overview: occurrence counts per local date (C01 year view). */
export const calYearOverview = (
  occurrences: ReadonlyArray<CalOccurrence>,
  viewerZone: string,
  year: number,
): CalDayCounts => {
  const counts: CalDayCounts = {};

  for (const o of occurrences) {
    const start =
      o.allDay && o.start.kind === "date" ? o.start.date : calDateInZone(o.startMs, viewerZone);

    const endExclusive =
      o.allDay && o.end.kind === "date"
        ? o.end.date
        : calAddDays(calDateInZone(Math.max(o.startMs, o.endMs - 1), viewerZone), 1);

    for (let d = calDateToDays(start); d < calDateToDays(endExclusive); d++) {
      const date = calDaysToDate(d);

      if (date.year !== year) continue;
      const key = calFormatDate(date);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  return counts;
};

export interface CalDayCounts {
  [dateKey: string]: number;
}

export interface CalWakingWindow {
  /** Minutes after local midnight. */
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Whether night hours (outside the waking window) contain timed events and so should not be collapsed. */
export const calNightHoursBusy = (
  occurrences: ReadonlyArray<CalOccurrence>,
  date: CalLocalDate,
  viewerZone: string,
  waking: CalWakingWindow,
): boolean => {
  const dayStart = calStartOfDay(date, viewerZone);
  const dayEnd = calStartOfDay(calAddDays(date, 1), viewerZone);
  const wakeStart = dayStart + waking.startMinute * 60_000;
  const wakeEnd = dayStart + waking.endMinute * 60_000;

  return occurrences.some(
    (o) =>
      !o.allDay &&
      o.startMs < dayEnd &&
      o.endMs > dayStart &&
      (o.startMs < wakeStart || o.endMs > wakeEnd),
  );
};

export interface CalFreeTimeOptions {
  readonly viewerZone: string;
  readonly waking: CalWakingWindow;
  /** Occurrences from calendars that are hidden are excluded by the caller or via this set. */
  readonly visibleCalendarIds?: ReadonlySet<string>;
  readonly allDayBlocks?: boolean;
  readonly minimumMinutes?: number;
}

export interface CalBusyInput extends CalOccurrence {
  readonly calendarId?: string;
}

/** Uninterrupted free intervals within the waking window of a local day (C08). */
export const calFreeTime = (
  occurrences: ReadonlyArray<CalBusyInput>,
  date: CalLocalDate,
  options: CalFreeTimeOptions,
): Array<{ readonly startMs: number; readonly endMs: number }> => {
  const dayStart = calStartOfDay(date, options.viewerZone);
  const windowStart = dayStart + options.waking.startMinute * 60_000;
  const windowEnd = dayStart + options.waking.endMinute * 60_000;
  const dayKey = calDateToDays(date);

  const busy = occurrences
    .filter((o) => !o.data.transparent && o.data.status !== "cancelled")
    .filter(
      (o) =>
        !options.visibleCalendarIds ||
        o.calendarId === undefined ||
        options.visibleCalendarIds.has(o.calendarId),
    )
    .flatMap((o) => {
      if (o.allDay) {
        if (!options.allDayBlocks || o.start.kind !== "date" || o.end.kind !== "date") return [];

        return calDateToDays(o.start.date) <= dayKey && dayKey < calDateToDays(o.end.date)
          ? [{ s: windowStart, e: windowEnd }]
          : [];
      }

      return [{ s: Math.max(o.startMs, windowStart), e: Math.min(o.endMs, windowEnd) }];
    })
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);

  const free: Array<{ startMs: number; endMs: number }> = [];
  let cursor = windowStart;

  for (const b of busy) {
    if (b.s > cursor) free.push({ startMs: cursor, endMs: b.s });
    cursor = Math.max(cursor, b.e);
  }

  if (cursor < windowEnd) free.push({ startMs: cursor, endMs: windowEnd });
  const min = (options.minimumMinutes ?? 0) * 60_000;

  return free.filter((f) => f.endMs - f.startMs >= Math.max(min, 1));
};

/** Local week anchor for week-associated tasks: the first day of the week under the user's preference (C06). */
export const calWeekAnchor = (date: CalLocalDate, firstWeekday: number): CalLocalDate => {
  return calAddDays(date, -((calWeekday(date) - firstWeekday + 7) % 7));
};

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const midpoint = (a: string, b: string | undefined): string => {
  if (b !== undefined) {
    let n = 0;

    while ((a[n] ?? "0") === b[n]) n++;

    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== undefined ? DIGITS.indexOf(b[0]!) : DIGITS.length;

  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;

  if (b !== undefined && b.length > 1) return b.slice(0, 1);

  return DIGITS[digitA]! + midpoint(a.slice(1), undefined);
};

/** Fractional ordering key strictly between `a` and `b` (either may be undefined); keys never end in "0". */
export const calOrderKeyBetween = (a: string | undefined, b: string | undefined): string => {
  if (a !== undefined && b !== undefined && a >= b) throw new Error("order keys must be ascending");

  return midpoint(a ?? "", b);
};

export interface CalDisplayTime {
  readonly text: string;
  /** Present when the event zone differs from the viewer zone (travel-aware display). */
  readonly originalText?: string;
}

const two = (n: number): string => String(n).padStart(2, "0");

export const calFormatClock = (hour: number, minute: number, hour12: boolean): string =>
  hour12
    ? `${((hour + 11) % 12) + 1}:${two(minute)} ${hour < 12 ? "AM" : "PM"}`
    : `${two(hour)}:${two(minute)}`;

/** Travel-aware time display: viewer-zone time plus the event's own zone when different (C03). */
export const calDisplayTime = (
  instant: number,
  eventZone: string,
  viewerZone: string,
  hour12: boolean,
): CalDisplayTime => {
  const v = calWallClock(instant, viewerZone);
  const text = calFormatClock(v.hour, v.minute, hour12);

  if (
    eventZone === viewerZone ||
    calOffsetAt(instant, eventZone) === calOffsetAt(instant, viewerZone)
  )
    return { text };
  const e = calWallClock(instant, eventZone);

  return { text, originalText: `${calFormatClock(e.hour, e.minute, hour12)} ${eventZone}` };
};

/** Whole days until a date (countdowns, C02/C08). */
export const calCountdownDays = (now: number, target: CalLocalDate, viewerZone: string): number =>
  calDateToDays(target) - calDateToDays(calDateInZone(now, viewerZone));
