// Calendar API (C01–C10). The day-photo upload (a raw image body), the ICS export (a file), and
// the bearer-token surfaces (private feeds, signed day-photo reads) stay native routes
// (../routes/calendar.ts).
import {
  CalendarAgendaResponse,
  CalendarChangesResponse,
  CalendarCommandOutcome,
  CalendarDayContextWire,
  CalendarDayViewWire,
  CalendarEventCreated,
  CalendarFeedTokenCreated,
  CalendarFeedTokensResponse,
  CalendarHabitsResponse,
  CalendarImportRequest,
  CalendarImportResult,
  CalendarListResponse,
  CalendarMonthViewWire,
  CalendarPreferencesRequest,
  CalendarPreferencesWire,
  CalendarSearchItemsResponse,
  CalendarTimeEntriesResponse,
  CalendarTimerResponse,
  CalendarWeekTasksResponse,
  CalendarWidgetResponse,
  CalendarYearViewWire,
  CreateEventFromMessageRequest,
  CreateFeedTokenRequest,
  LocationSuggestionsResponse,
  MessageInvitationsResponse,
  OccurrencesResponse,
  VisibleCalendarsResponse,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Ok, RequestServices, SchemaErrors } from "../httpapi.ts";

const space = { id: Schema.String };

const spaceDay = { id: Schema.String, date: Schema.String };

const optional = Schema.optional(Schema.String);

/** The viewer's IANA zone for zone-dependent views (`?tz=`). */
const zone = { tz: optional };

export class CalendarApi extends HttpApiGroup.make("calendar")
  .add(
    // ---- discovery: owned calendar spaces plus calendars shared with this account (C05) ----
    HttpApiEndpoint.get("listVisibleCalendars", "/v1/calendars", {
      success: VisibleCalendarsResponse,
    }),

    HttpApiEndpoint.get("listOccurrences", "/v1/calendars/:id/events", {
      params: space,
      query: {
        from: optional,
        to: optional,
        calendarIds: optional,
        visibleOnly: optional,
        ...zone,
      },
      success: OccurrencesResponse,
    }),
    HttpApiEndpoint.post("createEvent", "/v1/calendars/:id/events", {
      params: space,
      // A `CalendarCommandEnvelope`, decoded by the use case after its calendar-scope check, so a
      // credential without the scope is refused before it learns anything about the schema.
      payload: Schema.Json,
      success: CalendarCommandOutcome,
    }),
    HttpApiEndpoint.post("executeCommand", "/v1/calendars/:id/commands", {
      params: space,
      // A `CalendarCommandEnvelope`, decoded by the use case after its calendar-scope check, so a
      // credential without the scope is refused before it learns anything about the schema.
      payload: Schema.Json,
      success: CalendarCommandOutcome,
    }),
    HttpApiEndpoint.get("search", "/v1/calendars/:id/search", {
      params: space,
      query: { q: optional, limit: optional },
      success: CalendarSearchItemsResponse,
    }),
    /**
     * Invitations a delivered message carried (C09), with the owner's current answer and the
     * occurrence key to answer a single occurrence. The caller must also be able to read the message.
     */
    HttpApiEndpoint.get("messageInvitations", "/v1/calendars/:id/invitations", {
      params: space,
      query: { mailboxId: optional, deliveryId: optional },
      success: MessageInvitationsResponse,
    }),
    HttpApiEndpoint.post("createEventFromMessage", "/v1/calendars/:id/from-message", {
      params: space,
      payload: CreateEventFromMessageRequest,
      success: CalendarEventCreated.pipe(HttpApiSchema.status(201)),
    }),

    // ---- views and navigation (C01) ----
    HttpApiEndpoint.get("listCalendars", "/v1/calendars/:id/calendars", {
      params: space,
      success: CalendarListResponse,
    }),
    HttpApiEndpoint.get("preferences", "/v1/calendars/:id/preferences", {
      params: space,
      success: CalendarPreferencesWire,
    }),
    HttpApiEndpoint.patch("setPreferences", "/v1/calendars/:id/preferences", {
      params: space,
      payload: CalendarPreferencesRequest,
      success: CalendarPreferencesWire,
    }),
    HttpApiEndpoint.get("agenda", "/v1/calendars/:id/agenda", {
      params: space,
      query: { from: optional, days: optional, calendarIds: optional, ...zone },
      success: CalendarAgendaResponse,
    }),
    HttpApiEndpoint.get("day", "/v1/calendars/:id/day/:date", {
      params: spaceDay,
      query: zone,
      success: CalendarDayViewWire,
    }),
    HttpApiEndpoint.get("month", "/v1/calendars/:id/month/:year/:month", {
      params: { id: Schema.String, year: Schema.String, month: Schema.String },
      query: zone,
      success: CalendarMonthViewWire,
    }),
    HttpApiEndpoint.get("year", "/v1/calendars/:id/year/:year", {
      params: { id: Schema.String, year: Schema.String },
      query: zone,
      success: CalendarYearViewWire,
    }),

    // ---- weekly tasks, habits, time tracking, day context (C06–C08) ----
    HttpApiEndpoint.get("weekTasks", "/v1/calendars/:id/week-tasks", {
      params: space,
      query: { date: optional, firstWeekday: optional },
      success: CalendarWeekTasksResponse,
    }),
    HttpApiEndpoint.get("habits", "/v1/calendars/:id/habits", {
      params: space,
      query: { from: optional, to: optional },
      success: CalendarHabitsResponse,
    }),
    HttpApiEndpoint.get("timer", "/v1/calendars/:id/timer", {
      params: space,
      success: CalendarTimerResponse,
    }),
    HttpApiEndpoint.get("timeEntries", "/v1/calendars/:id/time-entries", {
      params: space,
      query: { from: optional, to: optional },
      success: CalendarTimeEntriesResponse,
    }),
    HttpApiEndpoint.get("dayContext", "/v1/calendars/:id/days/:date/context", {
      params: spaceDay,
      query: zone,
      success: CalendarDayContextWire,
    }),

    // ---- device surfaces and interoperability (C05, C10) ----
    HttpApiEndpoint.get("widget", "/v1/calendars/:id/widget", {
      params: space,
      query: zone,
      success: CalendarWidgetResponse,
    }),
    HttpApiEndpoint.get("changes", "/v1/calendars/:id/changes", {
      params: space,
      query: { cursor: optional },
      success: CalendarChangesResponse,
    }),
    HttpApiEndpoint.get("listFeedTokens", "/v1/calendars/:id/feed-tokens", {
      params: space,
      success: CalendarFeedTokensResponse,
    }),
    HttpApiEndpoint.post("createFeedToken", "/v1/calendars/:id/feed-tokens", {
      params: space,
      payload: CreateFeedTokenRequest,
      success: CalendarFeedTokenCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("revokeFeedToken", "/v1/calendars/:id/feed-tokens/:hash", {
      params: { id: Schema.String, hash: Schema.String },
      query: { commandId: optional },
      success: Ok,
    }),
    HttpApiEndpoint.post("importIcs", "/v1/calendars/:id/import", {
      params: space,
      payload: CalendarImportRequest,
      success: CalendarImportResult,
    }),
    HttpApiEndpoint.get("searchLocations", "/v1/locations", {
      query: { q: optional, lat: optional, lng: optional },
      success: LocationSuggestionsResponse,
    }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
