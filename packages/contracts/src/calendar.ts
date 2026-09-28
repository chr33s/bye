import { Schema } from "effect";
import { AuthorityValue } from "./wire.ts";

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

/** An attendee's mail address (each is a recipient of the owner's outbound iTIP). */
const AttendeeAddress = Schema.String.check(
  Schema.isMaxLength(320),
  Schema.isPattern(/^(?:mailto:)?[^\s@<>()",;:]+@[^\s@<>()",;:]+$/i),
);

const Person = Schema.Struct({ address: AttendeeAddress, name: Schema.optional(SingleLine) });

/** Invitees per event: the same ceiling as recipients per message (`MAX_MESSAGE_RECIPIENTS`). */
export const MAX_CALENDAR_ATTENDEES = 100;

const Attendees = Schema.Array(Person).check(Schema.isMaxLength(MAX_CALENDAR_ATTENDEES));

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
    attendees: Schema.optional(Attendees),
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
      attendees: Schema.optional(Attendees),
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

export const CalPartstatSchema = Schema.Literals([
  "NEEDS-ACTION",
  "ACCEPTED",
  "TENTATIVE",
  "DECLINED",
  "DELEGATED",
]);

/** The owner's side of an invitation (C04): who organizes it and the answer that applies. */
export const InvitationStateWire = Schema.Struct({
  organizer: Schema.Struct({ address: Schema.String, name: Schema.optional(Schema.String) }),
  partstat: CalPartstatSchema,
});

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
  /** Present only for the owner, on events someone else organizes. Added in v1.2. */
  invitation: Schema.optional(InvitationStateWire),
});

export type OccurrenceWire = typeof OccurrenceWire.Type;

/** An invitation a delivered message carried (C09): what a thread's RSVP actions answer. */
export const MessageInvitationWire = Schema.Struct({
  ...InvitationStateWire.fields,
  eventId: Schema.String,
  calendarId: Schema.String,
  uid: Schema.String,
  summary: Schema.String,
  recurring: Schema.Boolean,
  /** Set when the message concerns one occurrence; pass it to RespondInvitation. */
  occurrenceKey: Schema.NullOr(Schema.String),
  start: CalTimeSchema,
  end: CalTimeSchema,
  cancelled: Schema.Boolean,
});

export type MessageInvitationWire = typeof MessageInvitationWire.Type;

export const MessageInvitationsResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  invitations: Schema.Array(MessageInvitationWire),
});

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
  Schema.Struct({
    type: Schema.Literal("Invitations"),
    mailboxId: Schema.String,
    deliveryId: Schema.String,
  }),
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

// ---- HTTP request bodies and responses of the calendar API (C01–C10) ----

/** `PATCH /v1/calendars/:id/preferences`: one SetPreferences command's fields. */
export const CalendarPreferencesRequest = Schema.Struct({
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  preferences: Schema.optional(Schema.Unknown),
});

export type CalendarPreferencesRequest = typeof CalendarPreferencesRequest.Type;

/** `POST /v1/calendars/:id/import`: one ImportIcs command's fields. */
export const CalendarImportRequest = Schema.Struct({
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  calendarId: Schema.String,
  ics: Schema.String,
});

export type CalendarImportRequest = typeof CalendarImportRequest.Type;

/** A calendar the principal can read in one calendar space, with their role there (C05). */
export const CalendarListItemWire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  kind: Schema.String,
  visible: Schema.Boolean,
  revision: Schema.Number,
  role: Schema.Literals(["owner", "write", "read"]),
});

export type CalendarListItemWire = typeof CalendarListItemWire.Type;

export const CalendarListResponse = Schema.Struct({ items: Schema.Array(CalendarListItemWire) });

export type CalendarListResponse = typeof CalendarListResponse.Type;

/** Discovery (C05): calendars across owned spaces and spaces that shared calendars. */
export const VisibleCalendarsResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      spaceId: Schema.String,
      owned: Schema.Boolean,
      ...CalendarListItemWire.fields,
    }),
  ),
});

export type VisibleCalendarsResponse = typeof VisibleCalendarsResponse.Type;

export const CalendarSearchHitWire = Schema.Struct({
  docId: Schema.String,
  kind: Schema.Literals(["event", "task", "journal", "time", "day", "habit"]),
  ref: Schema.String,
  snippet: Schema.String,
});

export const CalendarSearchItemsResponse = Schema.Struct({
  items: Schema.Array(CalendarSearchHitWire),
});

export type CalendarSearchItemsResponse = typeof CalendarSearchItemsResponse.Type;

export const CalendarEventCreated = Schema.Struct({ eventId: Schema.String, uid: Schema.String });

export type CalendarEventCreated = typeof CalendarEventCreated.Type;

const WakingWindow = Schema.Struct({ startMinute: Schema.Number, endMinute: Schema.Number });

export const CalendarPreferencesWire = Schema.Struct({
  firstWeekday: Schema.Number,
  hour12: Schema.Boolean,
  timeZone: Schema.String,
  lastView: Schema.Literals(["day", "week", "agenda", "year", "month"]),
  lastDate: Schema.optional(Schema.String),
  nightHoursCollapsed: Schema.Boolean,
  waking: WakingWindow,
});

export type CalendarPreferencesWire = typeof CalendarPreferencesWire.Type;

export const CalendarAgendaResponse = Schema.Struct({
  days: Schema.Array(
    Schema.Struct({ date: Schema.String, occurrences: Schema.Array(OccurrenceWire) }),
  ),
});

export type CalendarAgendaResponse = typeof CalendarAgendaResponse.Type;

/** The owner's private context for a day (C08); `photoUrl` is a short-lived signed read link. */
export const CalendarDayContextWire = Schema.Struct({
  date: Schema.String,
  label: Schema.optional(Schema.String),
  photoKey: Schema.optional(Schema.String),
  photoUrl: Schema.optional(Schema.String),
  journal: Schema.optional(Schema.Struct({ body: Schema.String, revision: Schema.Number })),
  freeTime: Schema.Array(Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })),
  highlights: Schema.Array(OccurrenceWire),
});

export type CalendarDayContextWire = typeof CalendarDayContextWire.Type;

/** One day for a viewer (C01): occurrences, night-hours state, and the owner's day context. */
export const CalendarDayViewWire = Schema.Struct({
  date: Schema.String,
  zone: Schema.String,
  occurrences: Schema.Array(OccurrenceWire),
  nightHoursBusy: Schema.Boolean,
  nightHoursCollapsed: Schema.Boolean,
  waking: WakingWindow,
  context: Schema.optional(CalendarDayContextWire),
});

export type CalendarDayViewWire = typeof CalendarDayViewWire.Type;

const DayCounts = Schema.Record(Schema.String, Schema.Number);

export const CalendarMonthViewWire = Schema.Struct({
  year: Schema.Number,
  month: Schema.Number,
  firstWeekday: Schema.Number,
  counts: DayCounts,
});

export type CalendarMonthViewWire = typeof CalendarMonthViewWire.Type;

export const CalendarYearViewWire = Schema.Struct({ year: Schema.Number, counts: DayCounts });

export type CalendarYearViewWire = typeof CalendarYearViewWire.Type;

export const CalendarWeekTaskWire = Schema.Struct({
  id: Schema.String,
  anchor: Schema.String,
  title: Schema.String,
  orderKey: Schema.String,
  completedAt: Schema.optional(Schema.Number),
  eventId: Schema.optional(Schema.String),
  revision: Schema.Number,
});

export type CalendarWeekTaskWire = typeof CalendarWeekTaskWire.Type;

export const CalendarWeekTasksResponse = Schema.Struct({
  items: Schema.Array(CalendarWeekTaskWire),
});

export type CalendarWeekTasksResponse = typeof CalendarWeekTasksResponse.Type;

export const CalendarHabitsResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      weekdays: Schema.Array(Schema.Number),
      completed: Schema.Array(Schema.String),
    }),
  ),
});

export type CalendarHabitsResponse = typeof CalendarHabitsResponse.Type;

export const CalendarTimeEntryWire = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  startedAt: Schema.Number,
  stoppedAt: Schema.optional(Schema.Number),
  source: Schema.Literals(["timer", "manual"]),
});

export type CalendarTimeEntryWire = typeof CalendarTimeEntryWire.Type;

export const CalendarTimerResponse = Schema.Struct({
  active: Schema.NullOr(CalendarTimeEntryWire),
});

export type CalendarTimerResponse = typeof CalendarTimerResponse.Type;

export const CalendarTimeEntriesResponse = Schema.Struct({
  items: Schema.Array(CalendarTimeEntryWire),
});

export type CalendarTimeEntriesResponse = typeof CalendarTimeEntriesResponse.Type;

/** What the home-screen widget shows (C10). */
export const CalendarWidgetResponse = Schema.Struct({
  upcoming: Schema.Array(OccurrenceWire),
  activeTimer: Schema.optional(CalendarTimeEntryWire),
  weekTasks: Schema.Array(CalendarWeekTaskWire),
  today: Schema.String,
});

export type CalendarWidgetResponse = typeof CalendarWidgetResponse.Type;

/** Change feed (§8): the owner sees every change, others only calendars they can read. */
export const CalendarChangesResponse = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      resource: Schema.String,
      kind: Schema.String,
      payload: Schema.Unknown,
      createdAt: Schema.Number,
    }),
  ),
  cursor: Schema.Number,
  /** When true, the client must refresh a snapshot instead of replaying. */
  expired: Schema.Boolean,
});

export type CalendarChangesResponse = typeof CalendarChangesResponse.Type;

/** Private feed tokens (C05), listed by hash; the raw token is never stored. */
export const CalendarFeedTokensResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      tokenHash: Schema.String,
      label: Schema.String,
      calendarIds: Schema.Array(Schema.String),
      createdAt: Schema.Number,
      revokedAt: Schema.optional(Schema.Number),
    }),
  ),
});

export type CalendarFeedTokensResponse = typeof CalendarFeedTokensResponse.Type;

/** A new private feed: the raw token and its URL, returned exactly once. */
export const CalendarFeedTokenCreated = Schema.Struct({ token: Schema.String, url: Schema.String });

export type CalendarFeedTokenCreated = typeof CalendarFeedTokenCreated.Type;

export const CalendarImportResult = Schema.Struct({
  imported: Schema.Number,
  updated: Schema.Number,
  warnings: Schema.Array(Schema.String),
});

export type CalendarImportResult = typeof CalendarImportResult.Type;

export const LocationSuggestionsResponse = Schema.Struct({
  items: Schema.Array(LocationSuggestion),
});

export type LocationSuggestionsResponse = typeof LocationSuggestionsResponse.Type;

/**
 * What a `CalendarCommand` answers, by command. A command with no result answers `{ ok: true }`.
 * Members are ordered most specific first: a result matches the first member whose keys it has.
 */
export const CalendarCommandResult = Schema.Union([
  /** UpdateEvent (`splitEventId` when a "this and future" edit split the series). */
  Schema.Struct({
    eventId: Schema.String,
    revision: Schema.Number,
    splitEventId: Schema.optional(Schema.String),
  }),
  /** CreateEvent. */
  CalendarEventCreated,
  /** ConvertWeekTask. */
  Schema.Struct({ eventId: Schema.String }),
  /** AddWeekTask. */
  Schema.Struct({ taskId: Schema.String, anchor: Schema.String }),
  /** MoveWeekTask. */
  Schema.Struct({ anchor: Schema.String }),
  /** ReorderWeekTask. */
  Schema.Struct({ orderKey: Schema.String }),
  /** CreateCalendar, AddSubscription. */
  Schema.Struct({ calendarId: Schema.String }),
  /** UpdateCalendar, RespondInvitation, WriteJournal. */
  Schema.Struct({ revision: Schema.Number }),
  /** DeleteCalendar, DeleteEvent. */
  Schema.Struct({ deleted: Schema.Boolean }),
  /** CreateHabit. */
  Schema.Struct({ habitId: Schema.String }),
  /** StartTimer (`stoppedEntryId` when it stopped a running timer), AddTimeEntry. */
  Schema.Struct({ entryId: Schema.String, stoppedEntryId: Schema.optional(Schema.String) }),
  /** StopTimer. */
  Schema.Struct({ _tag: Schema.Literal("Stopped"), entry: CalendarTimeEntryWire }),
  Schema.Struct({
    _tag: Schema.Literal("AlreadyStopped"),
    entry: Schema.optional(CalendarTimeEntryWire),
  }),
  /** SetDayDecoration (`released`: a photo no day shows any more). */
  Schema.Struct({ applied: Schema.Boolean, released: Schema.optional(Schema.String) }),
  /** ImportIcs. */
  CalendarImportResult,
  /** SetPreferences. */
  CalendarPreferencesWire,
  /** GrantCalendar, RevokeCalendar, CompleteWeekTask, DeleteWeekTask, SetHabitCompletion, ArchiveHabit, RevokeFeedToken. */
  Schema.Struct({ ok: Schema.Literal(true) }),
]);

export type CalendarCommandResult = typeof CalendarCommandResult.Type;

/**
 * A generic command's result as the calendar authority answered it: a `CalendarCommandResult`, or
 * `{ ok: true }` for a command with none. Passed through unvalidated (see `AuthorityValue`): the
 * command has committed by then, and idempotent replays answer receipts stored by earlier releases.
 */
export const CalendarCommandOutcome = AuthorityValue;

export type CalendarCommandOutcome = typeof CalendarCommandOutcome.Type;
