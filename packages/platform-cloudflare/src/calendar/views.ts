import {
  calAddDays,
  calAgenda,
  calDateInZone,
  calFormatDate,
  type CalLocalDate,
  calNightHoursBusy,
  calStartOfDay,
  calYearOverview,
} from "@bye/calendar-engine";
import { Predicate } from "effect";
import type { Kernel } from "../durable/kernel.ts";
import { CalendarInterop } from "./interop.ts";
import {
  CALENDAR_DEFAULT_PREFERENCES,
  type CalendarDayContext,
  type CalendarOccurrenceView,
  type CalendarSearchHit,
  type CalendarTimeEntry,
  type CalendarWeekTask,
} from "./types.ts";

// Read models (C01, C05–C08, C10): agenda, day, month and year views, search, the widget
// snapshot and the change feed. Everything is narrowed to what the actor can read; owner-private
// parts (day context, preferences, planner) appear only for the owner.

const ftsQuery = (input: string): string | undefined => {
  const terms: Array<string> = [];
  const negatives: Array<string> = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;

  for (let m = re.exec(input); m; m = re.exec(input)) {
    const negative = (m[1] ?? m[3]) === "-";
    const text = (m[2] ?? m[4] ?? "").replace(/"/g, "").trim();

    if (!text) continue;
    (negative ? negatives : terms).push(`"${text}"`);
  }

  if (terms.length === 0) return undefined;

  return [terms.join(" "), ...negatives.map((n) => `NOT ${n}`)].join(" ");
};

/** Change-event resources that concern a single event calendar (the rest are owner-private). */
const CALENDAR_SCOPED = new Set(["calendar", "event"]);

export abstract class CalendarViews extends CalendarInterop {
  /** Search events, week tasks, journal, tracked time, habits, and day labels. Private kinds are owner-only. */
  search(actor: string, query: string, limit = 25): Array<CalendarSearchHit> {
    const match = ftsQuery(query);

    if (!match) return [];
    const owner = this.isOwner(actor);
    const readable = new Set(this.listCalendars(actor).map((c) => c.id));

    const rows = this.sql.all<{
      doc_id: string;
      kind: CalendarSearchHit["kind"];
      ref: string;
      snippet: string;
    }>(
      "SELECT doc_id, kind, ref, snippet(cal_search, 3, '[', ']', '…', 12) AS snippet FROM cal_search WHERE cal_search MATCH ? ORDER BY rank LIMIT ?",
      match,
      Math.min(Math.max(limit, 1), 100) * 3,
    );

    return rows
      .filter((r) =>
        r.kind === "event"
          ? readable.has(r.ref) && !!this.eventRow(r.doc_id.slice("event:".length))
          : owner,
      )
      .slice(0, limit)
      .map((r) => ({ docId: r.doc_id, kind: r.kind, ref: r.ref, snippet: r.snippet }));
  }

  /** Agenda (C01): occurrences grouped by local day, multi-day events on each day. */
  agenda(
    actor: string,
    from: CalLocalDate,
    days: number,
    viewerZone?: string,
    calendarIds?: ReadonlyArray<string>,
  ): Array<{ date: string; occurrences: ReadonlyArray<CalendarOccurrenceView> }> {
    const zone = viewerZone ?? this.zone;
    const span = Math.min(Math.max(days, 1), 92);

    const occurrences = this.listOccurrences({
      actor,
      from: calStartOfDay(from, zone),
      to: calStartOfDay(calAddDays(from, span), zone),
      viewerZone: zone,
      visibleOnly: true,
      calendarIds,
    });

    return calAgenda(occurrences, zone, from, span).map((d) => ({
      date: d.date,
      occurrences: d.occurrences as ReadonlyArray<CalendarOccurrenceView>,
    }));
  }

  /** Year overview (C01): occurrence counts per local date. */
  yearOverview(actor: string, year: number, viewerZone?: string): Record<string, number> {
    const zone = viewerZone ?? this.zone;
    const start = calStartOfDay({ year, month: 1, day: 1 }, zone);
    const end = calStartOfDay({ year: year + 1, month: 1, day: 1 }, zone);
    const counts = new Map<string, number>();
    // Expansion windows are bounded (§9); a year is covered in two halves.
    const mid = calStartOfDay({ year, month: 7, day: 1 }, zone);

    for (const [a, b] of [
      [start, mid],
      [mid, end],
    ] as const) {
      const part = calYearOverview(
        this.listOccurrences({ actor, from: a, to: b, viewerZone: zone, visibleOnly: true }),
        zone,
        year,
      );

      for (const [k, v] of Object.entries(part)) counts.set(k, (counts.get(k) ?? 0) + v);
    }

    return Object.fromEntries(counts);
  }

  /**
   * Day view model (C01/C08): timed + all-day occurrences, night-hours state, and private day context
   * for the owner. Occurrences are expanded ONCE (two days, as the day context needs) and reused.
   */
  day(actor: string, date: CalLocalDate, viewerZone?: string): CalendarDayView {
    const zone = viewerZone ?? this.zone;
    const from = calStartOfDay(date, zone);
    const to = calStartOfDay(calAddDays(date, 1), zone);
    const owner = this.isOwner(actor);

    const twoDays = this.listOccurrences({
      actor,
      from,
      to: from + 2 * 86_400_000,
      viewerZone: zone,
      visibleOnly: true,
    });

    // Same overlap rule as occurrence expansion (a zero-length occurrence still occupies its instant).
    const occurrences = twoDays.filter(
      (o) => o.startMs < to && Math.max(o.endMs, o.startMs + 1) > from,
    );

    const prefs = owner ? this.preferences() : { ...CALENDAR_DEFAULT_PREFERENCES, timeZone: zone };
    const nightHoursBusy = calNightHoursBusy(occurrences, date, zone, prefs.waking);

    return {
      date: calFormatDate(date),
      zone,
      occurrences,
      nightHoursBusy,
      // Night hours collapse only when the preference is on and nothing is scheduled there.
      nightHoursCollapsed: prefs.nightHoursCollapsed && !nightHoursBusy,
      waking: prefs.waking,
      context: owner
        ? this.dayContext(date, zone, { occurrences: twoDays, preferences: prefs })
        : undefined,
    };
  }

  /** Month grid (C01 month/date picker): counts per day plus the first weekday preference. */
  month(actor: string, year: number, month: number, viewerZone?: string): CalendarMonthView {
    const zone = viewerZone ?? this.zone;
    const first = { year, month, day: 1 };

    const next =
      month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };

    const occurrences = this.listOccurrences({
      actor,
      from: calStartOfDay(first, zone),
      to: calStartOfDay(next, zone),
      viewerZone: zone,
      visibleOnly: true,
    });

    const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;

    return {
      year,
      month,
      firstWeekday: this.isOwner(actor)
        ? this.preferences().firstWeekday
        : CALENDAR_DEFAULT_PREFERENCES.firstWeekday,
      counts: Object.fromEntries(
        Object.entries(calYearOverview(occurrences, zone, year)).filter(([k]) =>
          k.startsWith(prefix),
        ),
      ),
    };
  }

  /** Home-screen widget (C10): the owner's next events, running timer and open week tasks. */
  widgetSnapshot(viewerZone?: string): CalendarWidgetSnapshot {
    const zone = viewerZone ?? this.zone;
    const now = this.clock.now();
    const today = calDateInZone(now, zone);

    return {
      upcoming: this.listOccurrences({
        actor: this.config.ownerId,
        from: now,
        to: now + 86_400_000,
        viewerZone: zone,
        visibleOnly: true,
      })
        .filter((o) => o.data.status !== "cancelled")
        .slice(0, 5),
      activeTimer: this.activeTimer(),
      weekTasks: this.listWeekTasks(today, this.preferences().firstWeekday).filter(
        (t) => !t.completedAt,
      ),
      today: calFormatDate(today),
    };
  }

  /**
   * Change feed (§8). The owner sees every change. Anyone else sees only calendar and event changes
   * for calendars they can read now — never the owner's private planner, grants, feeds or
   * preferences. The cursor always advances to the latest sequence scanned.
   */
  changes(actor: string, cursor: number, limit = 500): ReturnType<Kernel["changesSince"]> {
    const page = this.kernel.changesSince(cursor, limit);

    if (this.isOwner(actor)) return page;
    const readable = new Set(this.listCalendars(actor).map((c) => c.id));

    return {
      ...page,
      changes: page.changes.filter((c) => {
        const calendarId = (c.payload as { calendarId?: unknown } | null)?.calendarId;

        return (
          CALENDAR_SCOPED.has(c.resource) &&
          Predicate.isString(calendarId) &&
          readable.has(calendarId)
        );
      }),
    };
  }
}

/** One day for a viewer: occurrences plus the waking-hours context. */
export interface CalendarDayView {
  date: string;
  zone: string;
  occurrences: Array<CalendarOccurrenceView>;
  nightHoursBusy: boolean;
  nightHoursCollapsed: boolean;
  waking: { startMinute: number; endMinute: number };
  context: CalendarDayContext | undefined;
}

/** Per-day occurrence counts of one month. */
export interface CalendarMonthView {
  year: number;
  month: number;
  firstWeekday: number;
  counts: Record<string, number>;
}

/** What the home-screen widget shows. */
export interface CalendarWidgetSnapshot {
  upcoming: Array<CalendarOccurrenceView>;
  activeTimer: CalendarTimeEntry | undefined;
  weekTasks: Array<CalendarWeekTask>;
  today: string;
}
