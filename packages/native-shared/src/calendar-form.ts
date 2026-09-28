import type { CalendarCommandInput } from "./client.ts";

// Calendar editor and navigation logic shared by the web and native clients (C01–C03): wall-clock
// times with an IANA zone, all-day dates, recurrence rules and reminders. Pure functions so the
// editor's payload can be tested without a DOM.

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type CalTime =
  | {
      readonly kind: "timed";
      readonly tzid: string;
      readonly local: LocalDate & {
        readonly hour: number;
        readonly minute: number;
        readonly second: number;
      };
    }
  | { readonly kind: "date"; readonly date: LocalDate };

export const parseLocalDate = (value: string): LocalDate | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));

  return check.getUTCMonth() === d.month - 1 && check.getUTCDate() === d.day ? d : null;
};

export const ymd = (d: LocalDate): string =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

export const toLocalDate = (date: Date): LocalDate => ({
  year: date.getFullYear(),
  month: date.getMonth() + 1,
  day: date.getDate(),
});

export const addDays = (d: LocalDate, days: number): LocalDate => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));

  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};

/** Weekday of a local date, 0 = Sunday. */
export const weekday = (d: LocalDate): number =>
  new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();

/** Start of the week containing `d` for a first-weekday preference (0 = Sunday … 6 = Saturday). */
export const weekStart = (d: LocalDate, firstWeekday: number): LocalDate =>
  addDays(d, -((weekday(d) - firstWeekday + 7) % 7));

/** Month grid: whole weeks covering the month, starting on `firstWeekday`. */
export const monthGrid = (
  year: number,
  month: number,
  firstWeekday: number,
): ReadonlyArray<ReadonlyArray<LocalDate>> => {
  const first = { year, month, day: 1 };
  let cursor = weekStart(first, firstWeekday);
  const weeks: Array<Array<LocalDate>> = [];

  do {
    const week: Array<LocalDate> = [];

    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }

    weeks.push(week);
  } while (cursor.month === month && cursor.year === year);

  return weeks;
};

export type Frequency = "none" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Ends =
  | { readonly kind: "never" }
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "until"; readonly until: LocalDate };

export interface EventForm {
  readonly calendarId: string;
  readonly title: string;
  readonly allDay: boolean;
  /** `YYYY-MM-DD` for all-day, `YYYY-MM-DDTHH:mm` otherwise (wall clock in `timeZone`). */
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  readonly frequency: Frequency;
  readonly interval: number;
  /** Weekly repeat days as RFC 5545 codes (MO, TU, …). */
  readonly byDay: ReadonlyArray<string>;
  readonly ends: Ends;
  readonly location: string;
  readonly description: string;
  readonly attendees: string;
  /** Minutes before start, comma-separated (multiple reminders, C02). */
  readonly reminders: string;
}

export type FormError = { readonly field: keyof EventForm; readonly message: string };

const parseTime = (value: string, allDay: boolean, tzid: string): CalTime | null => {
  if (allDay) {
    const date = parseLocalDate(value);

    return date ? { kind: "date", date } : null;
  }

  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  const date = m ? parseLocalDate(m[1]!) : null;

  if (!m || !date) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);

  if (hour > 23 || minute > 59) return null;

  return { kind: "timed", tzid, local: { ...date, hour, minute, second: 0 } };
};

const sortKey = (t: CalTime): string =>
  t.kind === "date"
    ? `${ymd(t.date)}T00:00`
    : `${ymd(t.local)}T${String(t.local.hour).padStart(2, "0")}:${String(t.local.minute).padStart(2, "0")}`;

export const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** UTC offset (ms) of `tzid` at the instant `utcMs`; unknown zones fall back to UTC. */
const zoneOffsetMs = (tzid: string, utcMs: number): number => {
  let parts: Array<Intl.DateTimeFormatPart>;

  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
  } catch {
    return 0;
  }

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );

  return asUtc - Math.floor(utcMs / 1000) * 1000;
};

/** UTC `YYYYMMDDTHHMMSSZ` for the last second of `day` as a wall clock in `tzid`. */
const endOfDayUtc = (day: LocalDate, tzid: string): string => {
  const wall = Date.UTC(day.year, day.month - 1, day.day, 23, 59, 59);
  // Two passes settle the offset when the end of day sits near a DST transition.
  let utc = wall - zoneOffsetMs(tzid, wall);
  utc = wall - zoneOffsetMs(tzid, utc);

  return new Date(utc)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
};

/**
 * RFC 5545 RRULE for the editor. A timed `UNTIL` must be UTC, so it is the end of the until-day
 * in the event's own zone (`timeZone`, UTC when absent) — a hardcoded `T235959Z` would drop the
 * last day's occurrence for evening events west of UTC.
 */
export const buildRRule = (
  form: Pick<EventForm, "frequency" | "interval" | "byDay" | "ends" | "allDay"> &
    Partial<Pick<EventForm, "timeZone">>,
): string | undefined => {
  if (form.frequency === "none") return undefined;
  const parts = [`FREQ=${form.frequency}`];

  if (form.interval > 1) parts.push(`INTERVAL=${Math.floor(form.interval)}`);

  if (form.frequency === "WEEKLY" && form.byDay.length)
    parts.push(
      `BYDAY=${[...new Set(form.byDay)].filter((d) => (DAY_CODES as ReadonlyArray<string>).includes(d)).join(",")}`,
    );

  if (form.ends.kind === "count") parts.push(`COUNT=${Math.max(1, Math.floor(form.ends.count))}`);

  if (form.ends.kind === "until")
    parts.push(
      `UNTIL=${
        form.allDay
          ? ymd(form.ends.until).replace(/-/g, "")
          : endOfDayUtc(form.ends.until, form.timeZone || "UTC")
      }`,
    );

  return parts.join(";");
};

type CreateEventCommand = Extract<CalendarCommandInput, { type: "CreateEvent" }>;

type UpdateEventCommand = Extract<CalendarCommandInput, { type: "UpdateEvent" }>;

/** Validate the editor and produce a `CreateEvent` command body (without commandId). */
export const eventPayload = (
  form: EventForm,
):
  | { readonly ok: true; readonly command: CreateEventCommand }
  | { readonly ok: false; readonly errors: ReadonlyArray<FormError> } => {
  const errors: Array<FormError> = [];

  if (!form.title.trim()) errors.push({ field: "title", message: "Add a title" });
  const start = parseTime(form.start, form.allDay, form.timeZone);
  const end = parseTime(form.end, form.allDay, form.timeZone);
  const formatHint = form.allDay ? "Use YYYY-MM-DD" : "Use YYYY-MM-DDTHH:mm";

  if (!start) errors.push({ field: "start", message: formatHint });

  if (!end) errors.push({ field: "end", message: formatHint });

  if (start && end && sortKey(end) < sortKey(start))
    errors.push({ field: "end", message: "Ends before it starts" });
  const alarms: Array<number> = [];

  for (const token of form.reminders
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const n = Number(token);

    if (!Number.isInteger(n) || n < 0 || n > 40_320)
      errors.push({ field: "reminders", message: `"${token}" is not minutes (0–40320)` });
    else alarms.push(n);
  }

  const attendees: Array<{ address: string }> = [];

  for (const token of form.attendees.split(/[,;\s]+/).filter(Boolean)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) attendees.push({ address: token.toLowerCase() });
    else errors.push({ field: "attendees", message: `"${token}" is not an address` });
  }

  if (form.frequency !== "none" && form.ends.kind === "count" && !(form.ends.count >= 1))
    errors.push({ field: "ends", message: "Repeat at least once" });

  if (errors.length || !start || !end) return { ok: false, errors };
  const rrule = buildRRule(form);

  const recurrence: RecurrenceFields = {};

  if (rrule) recurrence.rrule = rrule;

  const details: DetailFields = {};

  if (form.location.trim()) details.location = form.location.trim();

  if (form.description.trim()) details.description = form.description.trim();

  const optional: OptionalFields<(typeof attendees)[number]> = {};

  if (attendees.length)
    optional.attendees = [...new Map(attendees.map((a) => [a.address, a])).values()];

  if (alarms.length) optional.alarms = [...new Set(alarms)].sort((a, b) => a - b);

  return {
    ok: true,
    command: {
      type: "CreateEvent",
      calendarId: form.calendarId,
      start,
      end,
      ...recurrence,
      data: {
        summary: form.title.trim(),
        ...details,
      },
      ...optional,
    },
  };
};

/** `UpdateEvent` payload for an edit with an explicit scope (this / future / series). */
export const updatePayload = (
  eventId: string,
  expectedRevision: number,
  scope: "this" | "future" | "series",
  occurrenceKey: string | undefined,
  form: EventForm,
):
  | { readonly ok: true; readonly command: UpdateEventCommand }
  | { readonly ok: false; readonly errors: ReadonlyArray<FormError> } => {
  const built = eventPayload(form);

  if (!built.ok) return built;
  const c = built.command;
  const occurrence: OccurrenceFields = {};

  if (occurrenceKey) occurrence.occurrenceKey = occurrenceKey;

  const series: SeriesFields = {};

  if (scope !== "this") series.rrule = c.rrule ?? null;

  return {
    ok: true,
    command: {
      type: "UpdateEvent",
      eventId,
      expectedRevision,
      scope,
      // For the whole series, the occurrence tells the server which occurrence the form's times
      // were edited from, so the series moves by the same amount (its first date is kept).
      ...occurrence,
      changes: {
        start: c.start,
        end: c.end,
        ...series,
        data: c.data,
        alarms: c.alarms ?? [],
        attendees: c.attendees ?? [],
      },
    },
  };
};

/** Minutes of the day covered by collapsed night hours outside the waking window. */
export const nightHours = (
  waking: { readonly startMinute: number; readonly endMinute: number } | undefined,
) => {
  const w = waking ?? { startMinute: 7 * 60, endMinute: 22 * 60 };

  return { before: w.startMinute, after: 24 * 60 - w.endMinute, waking: w };
};

interface RecurrenceFields {
  rrule?: string;
}

interface DetailFields {
  location?: string;
  description?: string;
}

interface OptionalFields<Attendee> {
  attendees?: Array<Attendee>;
  alarms?: Array<number>;
}

interface OccurrenceFields {
  occurrenceKey?: string;
}

interface SeriesFields {
  rrule?: string | null;
}
