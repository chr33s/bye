import type {
  CalAttendee,
  CalEventData,
  CalException,
  CalItipDecision,
  CalOccurrence,
  CalPartstat,
  CalPerson,
  CalSeries,
  CalTime,
  CalWakingWindow,
} from "@bye/calendar-engine";
import { Rejection } from "../durable/rpc.ts";

// Types and constants shared by the CalendarDO authority's modules (§3.2, §9).

/** Calendar refusals use the platform-wide `Rejection`; the old class name stays as an alias. */
export { Rejection as CalendarStoreError } from "../durable/rpc.ts";
export type CalendarStoreErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "read_only"
  | "bad_request";

/** A calendar rejection to `throw`. A conflict carries the current revision for the client. */
export const calendarError = (
  code: CalendarStoreErrorCode,
  message: string,
  currentRevision?: number,
): Rejection =>
  new Rejection({
    code,
    message,
    ...(currentRevision !== undefined ? { details: { currentRevision } } : {}),
  });

export interface CalendarStoreConfig {
  /** User ID of the owning account. */
  readonly ownerId: string;
  /** Addresses of the owner, first is the default organizer identity. */
  readonly selfAddresses: ReadonlyArray<string>;
  readonly defaultZone: string;
}

export type CalendarKind = "local" | "subscription" | "invitations";
export type CalendarRole = "owner" | "write" | "read";

export interface CalendarRecord {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly kind: CalendarKind;
  readonly visible: boolean;
  readonly revision: number;
}

export interface CalendarMessageRef {
  readonly mailboxId: string;
  readonly threadId: string;
  readonly deliveryId?: string | undefined;
}

export interface CalendarEventRecord {
  readonly id: string;
  readonly calendarId: string;
  readonly uid: string;
  readonly series: CalSeries;
  readonly exceptions: ReadonlyArray<CalException>;
  readonly organizer: CalPerson | undefined;
  readonly weAreOrganizer: boolean;
  readonly attendees: ReadonlyArray<CalAttendee>;
  readonly alarms: ReadonlyArray<number>;
  readonly sequence: number;
  readonly revision: number;
  readonly generation: number;
  readonly highlight: boolean;
  readonly countdown: boolean;
  /** Owner-only annotation, never exported, shared, or sent. */
  readonly privateNote: string | undefined;
  readonly sourceRef: CalendarMessageRef | undefined;
}

/** An event as written: revision and generation are assigned by the store. */
export type CalendarEventWrite = Omit<CalendarEventRecord, "revision" | "generation">;

export interface CalendarOccurrenceView extends CalOccurrence {
  readonly eventId: string;
  readonly calendarId: string;
  readonly highlight: boolean;
  readonly countdown: boolean;
  /** Event revision for optimistic UpdateEvent (expectedRevision). */
  readonly revision: number;
  /** Set when someone else organizes this event and the owner is invited (C04). */
  readonly invitation?: CalendarInvitationState | undefined;
}

/** The owner's side of an invitation, for one occurrence or the whole series. */
export interface CalendarInvitationState {
  readonly organizer: CalPerson;
  /** The answer that applies here: an occurrence's own answer, else the series answer. */
  readonly partstat: CalPartstat;
}

/** An invitation carried by one delivered message (C09): what a thread's RSVP buttons act on. */
export interface CalendarMessageInvitation extends CalendarInvitationState {
  readonly eventId: string;
  readonly calendarId: string;
  readonly uid: string;
  readonly summary: string;
  readonly recurring: boolean;
  /** Set when the message is about one occurrence; RespondInvitation then answers only it. */
  readonly occurrenceKey: string | null;
  readonly start: CalTime;
  readonly end: CalTime;
  readonly cancelled: boolean;
}

export interface CalendarSeriesInput {
  readonly start: CalTime;
  readonly end: CalTime;
  readonly rrule?: string | undefined;
  readonly rdates?: ReadonlyArray<CalTime> | undefined;
  readonly exdates?: ReadonlyArray<CalTime> | undefined;
  readonly data: CalEventData;
}

export interface CalendarEventChanges {
  readonly start?: CalTime | undefined;
  readonly end?: CalTime | undefined;
  readonly rrule?: string | null | undefined;
  readonly data?: Partial<CalEventData> | undefined;
  readonly alarms?: ReadonlyArray<number> | undefined;
  readonly attendees?: ReadonlyArray<CalPerson> | undefined;
  readonly highlight?: boolean | undefined;
  readonly countdown?: boolean | undefined;
  readonly privateNote?: string | null | undefined;
}

export type CalendarEditScope = "series" | "this" | "future";

export interface CalendarPreferences {
  readonly firstWeekday: number;
  readonly hour12: boolean;
  readonly timeZone: string;
  readonly lastView: "day" | "week" | "agenda" | "year" | "month";
  readonly lastDate: string | undefined;
  readonly nightHoursCollapsed: boolean;
  readonly waking: CalWakingWindow;
}

export const CALENDAR_DEFAULT_PREFERENCES: Omit<CalendarPreferences, "timeZone"> = {
  firstWeekday: 1,
  hour12: false,
  lastView: "day",
  lastDate: undefined,
  nightHoursCollapsed: true,
  waking: { startMinute: 7 * 60, endMinute: 22 * 60 },
};

export interface CalendarWeekTask {
  readonly id: string;
  readonly anchor: string;
  readonly title: string;
  readonly orderKey: string;
  readonly completedAt: number | undefined;
  readonly eventId: string | undefined;
  readonly revision: number;
}

export interface CalendarTimeEntry {
  readonly id: string;
  readonly label: string;
  readonly startedAt: number;
  readonly stoppedAt: number | undefined;
  readonly source: "timer" | "manual";
}

export type CalendarInvitationResult =
  | { readonly _tag: "Invalid"; readonly reason: string }
  | (CalItipDecision & { readonly eventId?: string | undefined });

export interface CalendarSearchHit {
  readonly docId: string;
  readonly kind: "event" | "task" | "journal" | "time" | "day" | "habit";
  readonly ref: string;
  readonly snippet: string;
}

export interface CalendarDayContext {
  readonly date: string;
  readonly label: string | undefined;
  readonly photoKey: string | undefined;
  readonly journal: { readonly body: string; readonly revision: number } | undefined;
  readonly freeTime: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>;
  readonly highlights: ReadonlyArray<CalendarOccurrenceView>;
}

export const REMINDER_JOB = "reminder";
export const SUBSCRIPTION_JOB = "subscription";
/** Occurrence expansion windows are bounded (§9). */
export const MAX_WINDOW_MS = 400 * 86_400_000;

export interface EventRow {
  id: string;
  calendar_id: string;
  uid: string;
  series: string;
  organizer: string | null;
  we_are_organizer: number;
  attendees: string;
  alarms: string;
  sequence: number;
  dtstamp: number | null;
  revision: number;
  generation: number;
  highlight: number;
  countdown: number;
  private_note: string | null;
  source_ref: string | null;
  deleted: number;
}
