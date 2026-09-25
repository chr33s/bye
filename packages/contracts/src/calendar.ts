import { Schema } from "effect";

// Versioned calendar HTTP contracts (§8 `/v1/calendars/:id/events`, C01–C10).
// JSON on the wire; the calendar engine's in-memory types are not exposed directly.

export const CalLocalDateSchema = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
  day: Schema.Int,
});

export const CalLocalDateTimeSchema = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
  day: Schema.Int,
  hour: Schema.Int,
  minute: Schema.Int,
  second: Schema.Int,
});

export const CalTimeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("timed"),
    local: CalLocalDateTimeSchema,
    tzid: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("date"), date: CalLocalDateSchema }),
]);
export type CalTimeWire = typeof CalTimeSchema.Type;

export const CalEventDataSchema = Schema.Struct({
  summary: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  transparent: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["confirmed", "tentative", "cancelled"])),
});

/**
 * Values that reach iCalendar output (invitations, feeds, exports). CR/LF there would end the content
 * line and inject properties, so single-line fields reject every control character but HTAB, and
 * multi-line text rejects all but HTAB/CR/LF (escaped on output). The ICS writer strips them too.
 */
const SingleLine = Schema.String.pipe(
  // eslint-disable-next-line no-control-regex
  Schema.check(Schema.isPattern(/^[^\u0000-\u0008\u000A-\u001F\u007F]*$/)),
);
const MultiLine = Schema.String.pipe(
  // eslint-disable-next-line no-control-regex
  Schema.check(Schema.isPattern(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/)),
);

/** Event data accepted from clients (the read-side `CalEventDataSchema` stays permissive). */
const EventDataInput = Schema.Struct({
  summary: SingleLine,
  description: Schema.optional(MultiLine),
  location: Schema.optional(SingleLine),
  url: Schema.optional(SingleLine),
  transparent: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["confirmed", "tentative", "cancelled"])),
});

const PartialEventData = Schema.Struct({
  summary: Schema.optional(SingleLine),
  description: Schema.optional(MultiLine),
  location: Schema.optional(SingleLine),
  url: Schema.optional(SingleLine),
  transparent: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["confirmed", "tentative", "cancelled"])),
});

/** Private R2 key of an uploaded day photo (C08): `cal/<space>/photo/<random>`. The one pattern. */
export const CALENDAR_PHOTO_KEY = /^cal\/[A-Za-z0-9_-]{1,64}\/photo\/[A-Za-z0-9_-]{16,64}$/;

const Person = Schema.Struct({ address: SingleLine, name: Schema.optional(SingleLine) });
const MessageRef = Schema.Struct({
  mailboxId: Schema.String,
  threadId: Schema.String,
  deliveryId: Schema.optional(Schema.String),
});
const EditScope = Schema.Literals(["series", "this", "future"]);
const Weekday = Schema.Int;

const cmd = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), commandId: Schema.String, ...fields });

export const CalendarCommand = Schema.Union([
  cmd("CreateCalendar", { name: Schema.String, color: Schema.String }),
  cmd("UpdateCalendar", {
    calendarId: Schema.String,
    expectedRevision: Schema.Int,
    name: Schema.optional(Schema.String),
    color: Schema.optional(Schema.String),
    visible: Schema.optional(Schema.Boolean),
  }),
  cmd("DeleteCalendar", { calendarId: Schema.String }),
  cmd("GrantCalendar", {
    calendarId: Schema.String,
    grantee: Schema.String,
    role: Schema.Literals(["read", "write"]),
  }),
  cmd("RevokeCalendar", { calendarId: Schema.String, grantee: Schema.String }),
  cmd("CreateEvent", {
    calendarId: Schema.String,
    start: CalTimeSchema,
    end: CalTimeSchema,
    rrule: Schema.optional(Schema.String),
    rdates: Schema.optional(Schema.Array(CalTimeSchema)),
    exdates: Schema.optional(Schema.Array(CalTimeSchema)),
    data: EventDataInput,
    attendees: Schema.optional(Schema.Array(Person)),
    alarms: Schema.optional(Schema.Array(Schema.Int)),
    highlight: Schema.optional(Schema.Boolean),
    countdown: Schema.optional(Schema.Boolean),
    privateNote: Schema.optional(Schema.String),
  }),
  cmd("UpdateEvent", {
    eventId: Schema.String,
    expectedRevision: Schema.Int,
    scope: EditScope,
    occurrenceKey: Schema.optional(Schema.String),
    changes: Schema.Struct({
      start: Schema.optional(CalTimeSchema),
      end: Schema.optional(CalTimeSchema),
      rrule: Schema.optional(Schema.NullOr(Schema.String)),
      data: Schema.optional(PartialEventData),
      alarms: Schema.optional(Schema.Array(Schema.Int)),
      attendees: Schema.optional(Schema.Array(Person)),
      highlight: Schema.optional(Schema.Boolean),
      countdown: Schema.optional(Schema.Boolean),
      privateNote: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  cmd("DeleteEvent", {
    eventId: Schema.String,
    scope: EditScope,
    occurrenceKey: Schema.optional(Schema.String),
  }),
  cmd("RespondInvitation", {
    eventId: Schema.String,
    partstat: Schema.Literals(["ACCEPTED", "TENTATIVE", "DECLINED"]),
    occurrenceKey: Schema.optional(Schema.String),
  }),
  cmd("AddWeekTask", { date: CalLocalDateSchema, firstWeekday: Weekday, title: Schema.String }),
  cmd("ReorderWeekTask", {
    taskId: Schema.String,
    afterId: Schema.optional(Schema.String),
    beforeId: Schema.optional(Schema.String),
  }),
  cmd("MoveWeekTask", { taskId: Schema.String, date: CalLocalDateSchema, firstWeekday: Weekday }),
  cmd("CompleteWeekTask", { taskId: Schema.String, completed: Schema.Boolean }),
  cmd("DeleteWeekTask", { taskId: Schema.String }),
  cmd("ConvertWeekTask", {
    taskId: Schema.String,
    calendarId: Schema.String,
    start: CalTimeSchema,
    end: CalTimeSchema,
  }),
  cmd("CreateHabit", { name: Schema.String, weekdays: Schema.Array(Weekday) }),
  cmd("SetHabitCompletion", {
    habitId: Schema.String,
    date: CalLocalDateSchema,
    completed: Schema.Boolean,
  }),
  cmd("StartTimer", { label: Schema.String }),
  cmd("StopTimer", { entryId: Schema.optional(Schema.String) }),
  cmd("AddTimeEntry", { label: Schema.String, startedAt: Schema.Number, stoppedAt: Schema.Number }),
  cmd("SetDayDecoration", {
    date: CalLocalDateSchema,
    label: Schema.optional(Schema.NullOr(Schema.String)),
    photoKey: Schema.optional(Schema.NullOr(Schema.String)),
    /** Compare-and-set: apply only while the day's current photo is this key (a replaced photo is left alone). */
    expectedPhotoKey: Schema.optional(Schema.String),
  }),
  cmd("WriteJournal", {
    date: CalLocalDateSchema,
    body: Schema.String,
    expectedRevision: Schema.Int,
  }),
  cmd("SetPreferences", {
    preferences: Schema.Struct({
      firstWeekday: Schema.optional(Weekday),
      hour12: Schema.optional(Schema.Boolean),
      timeZone: Schema.optional(Schema.String),
      lastView: Schema.optional(Schema.Literals(["day", "week", "agenda", "year", "month"])),
      lastDate: Schema.optional(Schema.String),
      nightHoursCollapsed: Schema.optional(Schema.Boolean),
      waking: Schema.optional(Schema.Struct({ startMinute: Schema.Int, endMinute: Schema.Int })),
    }),
  }),
  cmd("AddSubscription", {
    name: Schema.String,
    color: Schema.String,
    url: Schema.String,
    itemLimit: Schema.optional(Schema.Int),
  }),
  cmd("RevokeFeedToken", { tokenHash: Schema.String }),
  cmd("ArchiveHabit", { habitId: Schema.String }),
  cmd("ImportIcs", { calendarId: Schema.String, ics: Schema.String }),
]);
export type CalendarCommand = typeof CalendarCommand.Type;

export const CalendarCommandEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  command: CalendarCommand,
});
export type CalendarCommandEnvelope = typeof CalendarCommandEnvelope.Type;
export const decodeCalendarCommandEnvelope = Schema.decodeUnknownEffect(CalendarCommandEnvelope);

/** Separate endpoints: these need cross-resource checks or return secrets exactly once. */
export const CreateEventFromMessageRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  commandId: Schema.String,
  calendarId: Schema.String,
  message: MessageRef,
  title: Schema.String,
  start: CalTimeSchema,
  end: CalTimeSchema,
});
export type CreateEventFromMessageRequest = typeof CreateEventFromMessageRequest.Type;

export const CreateFeedTokenRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  commandId: Schema.String,
  calendarIds: Schema.Array(Schema.String),
  label: Schema.String,
});
export type CreateFeedTokenRequest = typeof CreateFeedTokenRequest.Type;

export const OccurrencesQuery = Schema.Struct({
  from: Schema.Number,
  to: Schema.Number,
  viewerZone: Schema.optional(Schema.String),
  calendarIds: Schema.optional(Schema.Array(Schema.String)),
  visibleOnly: Schema.optional(Schema.Boolean),
});
export type OccurrencesQuery = typeof OccurrencesQuery.Type;
export const decodeOccurrencesQuery = Schema.decodeUnknownEffect(OccurrencesQuery);

export const OccurrenceWire = Schema.Struct({
  eventId: Schema.String,
  calendarId: Schema.String,
  uid: Schema.String,
  key: Schema.String,
  start: CalTimeSchema,
  end: CalTimeSchema,
  startMs: Schema.Number,
  endMs: Schema.Number,
  allDay: Schema.Boolean,
  recurring: Schema.Boolean,
  isException: Schema.Boolean,
  highlight: Schema.Boolean,
  countdown: Schema.Boolean,
  /** Added in v1.1; optional so older records still decode. */
  revision: Schema.optional(Schema.Number),
  data: CalEventDataSchema,
  /** Overlap layout for day/week grids (timed occurrences only). */
  column: Schema.optional(Schema.Int),
  columns: Schema.optional(Schema.Int),
});
export type OccurrenceWire = typeof OccurrenceWire.Type;

export const OccurrencesResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  occurrences: Schema.Array(OccurrenceWire),
});

export const CalendarSearchResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hits: Schema.Array(
    Schema.Struct({
      docId: Schema.String,
      kind: Schema.Literals(["event", "task", "journal", "time", "day", "habit"]),
      ref: Schema.String,
      snippet: Schema.String,
    }),
  ),
});

export const LocationSuggestion = Schema.Struct({
  label: Schema.String,
  address: Schema.optional(Schema.String),
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  providerId: Schema.optional(Schema.String),
});
export type LocationSuggestion = typeof LocationSuggestion.Type;

/** Queue payload asking a consumer to refresh an external subscription (outbox topic `calendar.subscription.refresh`). */
export const CalendarRefreshMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("calendar-refresh"),
  eventId: Schema.String,
  calendarSpaceId: Schema.String,
  calendarId: Schema.String,
});
export type CalendarRefreshMessage = typeof CalendarRefreshMessage.Type;

/** Read models served by the CalendarDO (C01, C05–C08, C10). Private kinds are owner-only in the authority. */
const ReadZone = { viewerZone: Schema.optional(Schema.String) };
export const CalendarReadQuery = Schema.Union([
  Schema.Struct({ type: Schema.Literal("Calendars") }),
  Schema.Struct({ type: Schema.Literal("Preferences") }),
  Schema.Struct({
    type: Schema.Literal("Agenda"),
    from: CalLocalDateSchema,
    days: Schema.Int,
    calendarIds: Schema.optional(Schema.Array(Schema.String)),
    ...ReadZone,
  }),
  Schema.Struct({ type: Schema.Literal("Day"), date: CalLocalDateSchema, ...ReadZone }),
  Schema.Struct({
    type: Schema.Literal("Month"),
    year: Schema.Int,
    month: Schema.Int,
    ...ReadZone,
  }),
  Schema.Struct({ type: Schema.Literal("Year"), year: Schema.Int, ...ReadZone }),
  Schema.Struct({
    type: Schema.Literal("WeekTasks"),
    date: CalLocalDateSchema,
    firstWeekday: Schema.optional(Weekday),
  }),
  Schema.Struct({
    type: Schema.Literal("Habits"),
    from: CalLocalDateSchema,
    to: CalLocalDateSchema,
  }),
  Schema.Struct({ type: Schema.Literal("Timer") }),
  Schema.Struct({ type: Schema.Literal("TimeEntries"), from: Schema.Number, to: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("DayContext"), date: CalLocalDateSchema, ...ReadZone }),
  Schema.Struct({ type: Schema.Literal("Widget"), ...ReadZone }),
  Schema.Struct({ type: Schema.Literal("FeedTokens") }),
  Schema.Struct({ type: Schema.Literal("Changes"), cursor: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("Export"),
    calendarIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("Occurrences"), ...OccurrencesQuery.fields }),
  Schema.Struct({ type: Schema.Literal("Search"), query: Schema.String, limit: Schema.Int }),
]);
export type CalendarReadQuery = typeof CalendarReadQuery.Type;
export const decodeCalendarReadQuery = Schema.decodeUnknownEffect(CalendarReadQuery);

/**
 * Authority-internal messages: sent by trusted Worker code over the CalendarDO RPC, never decoded
 * from an HTTP body. They need a cross-resource check (a mailbox for create-from-message), carry a
 * server-computed secret hash (feed tokens), or run with no principal (feeds, subscriptions,
 * inbound invitations) — so they are not part of the public `CalendarCommand` union.
 */
export type CalendarInternalCommand =
  | {
      readonly type: "CreateEventFromMessage";
      readonly commandId: string;
      readonly calendarId: string;
      readonly message: {
        readonly mailboxId: string;
        readonly threadId: string;
        readonly deliveryId?: string | undefined;
      };
      readonly title: string;
      readonly start: CalTimeWire;
      readonly end: CalTimeWire;
    }
  | {
      readonly type: "CreateFeedToken";
      readonly commandId: string;
      readonly tokenHash: string;
      readonly calendarIds: ReadonlyArray<string>;
      readonly label: string;
    }
  | {
      readonly type: "ApplySubscriptionFetch";
      readonly commandId: string;
      readonly calendarId: string;
      readonly status: "ok" | "not-modified" | "error";
      readonly body?: string | undefined;
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
      readonly error?: string | undefined;
    }
  | {
      readonly type: "ReceiveInvitation";
      /** The ingestion (delivery) ID: redelivery of the same message is idempotent. */
      readonly commandId: string;
      readonly ics: string;
      readonly sender: string;
      readonly sourceRef?:
        | {
            readonly mailboxId: string;
            readonly threadId: string;
            readonly deliveryId?: string | undefined;
          }
        | undefined;
    };

export type CalendarInternalQuery =
  | { readonly type: "Feed"; readonly tokenHash: string }
  | { readonly type: "Subscription"; readonly calendarId: string };

/** Everything the CalendarDO `execute`/`read` RPC accepts. */
export type CalendarAuthorityCommand = CalendarCommand | CalendarInternalCommand;
export type CalendarAuthorityQuery = CalendarReadQuery | CalendarInternalQuery;

/**
 * Calendar deep links for device surfaces (C10): widgets, notifications, timers and share targets
 * open these. Clients map them to routes; the server emits them in notifications.
 */
export const CALENDAR_DEEP_LINKS = {
  event: (eventId: string, occurrenceKey?: string) =>
    `bye://calendar/event/${encodeURIComponent(eventId)}${occurrenceKey ? `?occurrence=${encodeURIComponent(occurrenceKey)}` : ""}`,
  day: (date: string) => `bye://calendar/day/${date}`,
  timer: () => "bye://calendar/timer",
  weekTasks: (date: string) => `bye://calendar/week/${date}`,
} as const;
