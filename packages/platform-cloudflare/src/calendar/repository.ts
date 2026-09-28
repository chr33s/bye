import { Effect, Layer } from "effect";
import { CalendarFailure, CalendarRepository } from "@bye/application";
import {
  calIsValidTimeZone,
  calLayoutOverlaps,
  type CalTime,
  calTimeProblem,
} from "@bye/calendar-engine";
import type {
  CalendarAuthorityCommand,
  CalendarAuthorityQuery,
  OccurrenceWire,
} from "@bye/contracts";
import { isRejection, type RpcResult } from "../durable/rpc.ts";
import { authorizeCalendar } from "./access.ts";
import type { CalendarStore } from "./store.ts";
import { calendarError, type CalendarOccurrenceView } from "./types.ts";

// The CalendarDO's two entry points (§3.2): `calendarExecute` for commands and `calendarRead` for
// read models. Both enforce the access table first, then dispatch to the store. The DO RPC, the
// in-process repository used by tests, and nothing else call the store's operations.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Wire shapes are permissive (frozen v1 contracts), so time values are checked here, before any
 * zone or date math: an unknown `tzid`/`viewerZone` or an out-of-range field is a `bad_request`,
 * never a RangeError (500) or a silent `Date` rollover.
 */
const checkTimeInputs = (m: Record<string, unknown>): void => {
  const time = (what: string, v: unknown): void => {
    if (!isObject(v)) return;
    const problem = calTimeProblem(v as unknown as CalTime);
    if (problem) throw calendarError("bad_request", `${what}: ${problem}`);
  };
  const date = (what: string, v: unknown): void => {
    if (isObject(v)) time(what, { kind: "date", date: v });
  };
  for (const key of ["start", "end"]) time(key, m[key]);
  for (const key of ["rdates", "exdates"])
    if (Array.isArray(m[key])) for (const t of m[key] as Array<unknown>) time(key, t);
  if (isObject(m.changes)) for (const key of ["start", "end"]) time(key, m.changes[key]);
  for (const key of ["date", "from", "to"]) date(key, m[key]);
  const zone = m.viewerZone;
  if (zone !== undefined && (typeof zone !== "string" || !calIsValidTimeZone(zone)))
    throw calendarError("bad_request", `unknown time zone ${JSON.stringify(zone)}`);
  if (m.type === "Month" || m.type === "Year")
    date(String(m.type), { year: m.year, month: m.type === "Month" ? m.month : 1, day: 1 });
};

/** Dispatch a command (public or authority-internal). Runs synchronously inside the DO. */
export const calendarExecute = (
  store: CalendarStore,
  actor: string | null,
  c: CalendarAuthorityCommand,
): unknown => {
  authorizeCalendar(store, actor, c);
  checkTimeInputs(c as unknown as Record<string, unknown>);
  // Principal-free (system) commands never read `actor`; every other policy guarantees one.
  const base = { commandId: c.commandId, actor: actor ?? "" };
  switch (c.type) {
    case "CreateCalendar":
      return store.createCalendar({ ...base, name: c.name, color: c.color });
    case "UpdateCalendar":
      return store.updateCalendar({
        ...base,
        calendarId: c.calendarId,
        expectedRevision: c.expectedRevision,
        ...(c.name !== undefined ? { name: c.name } : {}),
        ...(c.color !== undefined ? { color: c.color } : {}),
        ...(c.visible !== undefined ? { visible: c.visible } : {}),
      });
    case "DeleteCalendar":
      return store.deleteCalendar({ ...base, calendarId: c.calendarId });
    case "GrantCalendar":
      return store.grantCalendar({
        ...base,
        calendarId: c.calendarId,
        grantee: c.grantee,
        role: c.role,
      });
    case "RevokeCalendar":
      return store.revokeCalendar({ ...base, calendarId: c.calendarId, grantee: c.grantee });
    case "CreateEvent":
      return store.createEvent({
        ...base,
        calendarId: c.calendarId,
        series: {
          start: c.start,
          end: c.end,
          rrule: c.rrule,
          rdates: c.rdates,
          exdates: c.exdates,
          data: c.data,
        },
        ...(c.attendees ? { attendees: c.attendees } : {}),
        ...(c.alarms ? { alarms: c.alarms } : {}),
        ...(c.highlight !== undefined ? { highlight: c.highlight } : {}),
        ...(c.countdown !== undefined ? { countdown: c.countdown } : {}),
        ...(c.privateNote !== undefined ? { privateNote: c.privateNote } : {}),
      });
    case "UpdateEvent":
      return store.updateEvent({
        ...base,
        eventId: c.eventId,
        expectedRevision: c.expectedRevision,
        scope: c.scope,
        ...(c.occurrenceKey ? { occurrenceKey: c.occurrenceKey } : {}),
        changes: c.changes,
      });
    case "DeleteEvent":
      return store.deleteEvent({
        ...base,
        eventId: c.eventId,
        scope: c.scope,
        ...(c.occurrenceKey ? { occurrenceKey: c.occurrenceKey } : {}),
      });
    case "RespondInvitation":
      return store.respondToInvitation({
        ...base,
        eventId: c.eventId,
        partstat: c.partstat,
        ...(c.occurrenceKey ? { occurrenceKey: c.occurrenceKey } : {}),
      });
    case "AddWeekTask":
      return store.addWeekTask({
        ...base,
        date: c.date,
        firstWeekday: c.firstWeekday,
        title: c.title,
      });
    case "ReorderWeekTask":
      return store.reorderWeekTask({
        ...base,
        taskId: c.taskId,
        ...(c.afterId ? { afterId: c.afterId } : {}),
        ...(c.beforeId ? { beforeId: c.beforeId } : {}),
      });
    case "MoveWeekTask":
      return store.moveWeekTask({
        ...base,
        taskId: c.taskId,
        date: c.date,
        firstWeekday: c.firstWeekday,
      });
    case "CompleteWeekTask":
      return store.completeWeekTask({ ...base, taskId: c.taskId, completed: c.completed });
    case "DeleteWeekTask":
      return store.deleteWeekTask({ ...base, taskId: c.taskId });
    case "ConvertWeekTask":
      return store.convertWeekTaskToEvent({
        ...base,
        taskId: c.taskId,
        calendarId: c.calendarId,
        start: c.start,
        end: c.end,
      });
    case "CreateHabit":
      return store.createHabit({ ...base, name: c.name, weekdays: c.weekdays });
    case "SetHabitCompletion":
      return store.setHabitCompletion({
        ...base,
        habitId: c.habitId,
        date: c.date,
        completed: c.completed,
      });
    case "ArchiveHabit":
      return store.archiveHabit({ ...base, habitId: c.habitId });
    case "StartTimer":
      return store.startTimer({ ...base, label: c.label });
    case "StopTimer":
      return store.stopTimer({ ...base, ...(c.entryId ? { entryId: c.entryId } : {}) });
    case "AddTimeEntry":
      return store.addTimeEntry({
        ...base,
        label: c.label,
        startedAt: c.startedAt,
        stoppedAt: c.stoppedAt,
      });
    case "SetDayDecoration":
      return store.setDayDecoration({
        ...base,
        date: c.date,
        label: c.label,
        photoKey: c.photoKey,
        expectedPhotoKey: c.expectedPhotoKey,
      });
    case "WriteJournal":
      return store.writeJournal({
        ...base,
        date: c.date,
        body: c.body,
        expectedRevision: c.expectedRevision,
      });
    case "SetPreferences":
      return store.setPreferences({
        ...base,
        preferences: Object.fromEntries(
          Object.entries(c.preferences).filter(([, v]) => v !== undefined),
        ),
      });
    case "AddSubscription":
      return store.addSubscription({
        ...base,
        name: c.name,
        color: c.color,
        url: c.url,
        ...(c.itemLimit !== undefined ? { itemLimit: c.itemLimit } : {}),
      });
    case "RevokeFeedToken":
      return store.revokeFeedToken({ ...base, tokenHash: c.tokenHash });
    case "ImportIcs":
      return store.importIcs({ ...base, calendarId: c.calendarId, ics: c.ics });
    case "CreateEventFromMessage":
      return store.createEventFromMessage({
        ...base,
        calendarId: c.calendarId,
        message: c.message,
        title: c.title,
        start: c.start,
        end: c.end,
      });
    case "CreateFeedToken":
      return store.createFeedToken({
        ...base,
        tokenHash: c.tokenHash,
        calendarIds: c.calendarIds,
        label: c.label,
      });
    case "ApplySubscriptionFetch":
      // The fetch ID is the command ID: the receipt key stays `subscription:<fetchId>`.
      return store.applySubscriptionFetch({
        calendarId: c.calendarId,
        fetchId: c.commandId,
        status: c.status,
        body: c.body,
        etag: c.etag,
        lastModified: c.lastModified,
        error: c.error,
      });
    case "ReceiveInvitation":
      return store.receiveInvitation({
        ingestionId: c.commandId,
        ics: c.ics,
        sender: c.sender,
        sourceRef: c.sourceRef,
      });
  }
};

/** Dispatch a read model query (C01, C05–C08, C10). */
export const calendarRead = (
  store: CalendarStore,
  actor: string | null,
  q: CalendarAuthorityQuery,
): unknown => {
  authorizeCalendar(store, actor, q);
  checkTimeInputs(q as unknown as Record<string, unknown>);
  const who = actor ?? "";
  switch (q.type) {
    case "Calendars":
      return store.listCalendars(who);
    case "Preferences":
      return store.preferences();
    case "Agenda":
      return store
        .agenda(who, q.from, q.days, q.viewerZone, q.calendarIds)
        .map((d) => ({ date: d.date, occurrences: d.occurrences.map(calendarOccurrenceWire) }));
    case "Day": {
      const day = store.day(who, q.date, q.viewerZone);
      return {
        ...day,
        occurrences: day.occurrences.map(calendarOccurrenceWire),
        context: day.context
          ? { ...day.context, highlights: day.context.highlights.map(calendarOccurrenceWire) }
          : undefined,
      };
    }
    case "Month":
      return store.month(who, q.year, q.month, q.viewerZone);
    case "Year":
      return { year: q.year, counts: store.yearOverview(who, q.year, q.viewerZone) };
    case "Occurrences":
      return withLayout(
        store.listOccurrences({
          actor: who,
          from: q.from,
          to: q.to,
          viewerZone: q.viewerZone,
          calendarIds: q.calendarIds,
          visibleOnly: q.visibleOnly,
        }),
      );
    case "Search":
      return store.search(who, q.query, q.limit);
    case "Invitations":
      return {
        schemaVersion: 1,
        invitations: store.invitationsForMessage(q.mailboxId, q.deliveryId),
      };
    case "Export":
      return store.exportIcs(who, q.calendarIds);
    case "Changes":
      return store.changes(who, q.cursor);
    case "WeekTasks":
      return store.listWeekTasks(q.date, q.firstWeekday ?? store.preferences().firstWeekday);
    case "Habits":
      return store.listHabits(q.from, q.to);
    case "Timer":
      return { active: store.activeTimer() ?? null };
    case "TimeEntries":
      return store.timeEntries(q.from, q.to);
    case "DayContext": {
      const context = store.dayContext(q.date, q.viewerZone);
      return { ...context, highlights: context.highlights.map(calendarOccurrenceWire) };
    }
    case "Widget": {
      const w = store.widgetSnapshot(q.viewerZone);
      return { ...w, upcoming: w.upcoming.map(calendarOccurrenceWire) };
    }
    case "FeedTokens":
      return store.listFeedTokens();
    case "Feed":
      return store.feedIcs(q.tokenHash);
    case "Subscription":
      return store.subscription(q.calendarId);
  }
};

export const calendarOccurrenceWire = (o: CalendarOccurrenceView): OccurrenceWire => ({
  eventId: o.eventId,
  calendarId: o.calendarId,
  uid: o.uid,
  key: o.key,
  start: o.start,
  end: o.end,
  startMs: o.startMs,
  endMs: o.endMs,
  allDay: o.allDay,
  recurring: o.recurring,
  isException: o.isException,
  highlight: o.highlight,
  countdown: o.countdown,
  revision: o.revision,
  ...(o.invitation
    ? {
        invitation: {
          organizer: {
            address: o.invitation.organizer.address,
            ...(o.invitation.organizer.name !== undefined
              ? { name: o.invitation.organizer.name }
              : {}),
          },
          partstat: o.invitation.partstat,
        },
      }
    : {}),
  data: {
    summary: o.data.summary,
    ...(o.data.description !== undefined ? { description: o.data.description } : {}),
    ...(o.data.location !== undefined ? { location: o.data.location } : {}),
    ...(o.data.url !== undefined ? { url: o.data.url } : {}),
    ...(o.data.transparent !== undefined ? { transparent: o.data.transparent } : {}),
    ...(o.data.status !== undefined ? { status: o.data.status } : {}),
  },
});

/** Occurrences on the wire, with overlap columns for day/week grids (C01) on timed ones. */
const withLayout = (occurrences: ReadonlyArray<CalendarOccurrenceView>): Array<OccurrenceWire> => {
  const layout = new Map(
    calLayoutOverlaps(
      occurrences
        .filter((o) => !o.allDay)
        .map((o) => ({ id: `${o.eventId}:${o.key}`, startMs: o.startMs, endMs: o.endMs })),
    ).map((l) => [l.id, l]),
  );
  return occurrences.map((o) => {
    const l = layout.get(`${o.eventId}:${o.key}`);
    return l
      ? { ...calendarOccurrenceWire(o), column: l.column, columns: l.columns }
      : calendarOccurrenceWire(o);
  });
};

const calendarFailure = (r: {
  readonly code: CalendarFailure["code"];
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): CalendarFailure =>
  new CalendarFailure({
    code: r.code,
    message: r.message,
    ...(r.details ? { details: r.details } : {}),
  });

/** Run a store call, mapping expected rejections to CalendarFailure; anything else is a defect. */
export const calendarAttempt = <T>(fn: () => T): Effect.Effect<T, CalendarFailure> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(fn());
    } catch (error) {
      if (isRejection(error)) return Effect.fail(calendarFailure(error));
      return Effect.die(error);
    }
  });

/**
 * A day photo belongs to the space it was uploaded to (`cal/<space>/photo/…`, the binding the
 * photo scanner enforces too): a space may attach only its own photos, so a key read from another
 * account's photo link can never be re-signed through this space's day views.
 */
const requireOwnPhoto = (spaceId: string, command: CalendarAuthorityCommand): void => {
  if (
    command.type === "SetDayDecoration" &&
    typeof command.photoKey === "string" &&
    !command.photoKey.startsWith(`cal/${spaceId}/photo/`)
  )
    throw calendarError("bad_request", "photoKey must reference a photo uploaded to this calendar");
};

/**
 * CalendarRepository over directly reachable stores (inside a DO, or in tests). The Worker-side
 * implementation forwards the same two calls to the CalendarDO over RPC.
 */
export const calendarRepositoryLocal = (resolve: (spaceId: string) => CalendarStore) =>
  Layer.succeed(CalendarRepository, {
    execute: (spaceId, actor, command) =>
      calendarAttempt(() => {
        requireOwnPhoto(spaceId, command);
        return calendarExecute(resolve(spaceId), actor, command);
      }) as never,
    read: (spaceId, actor, query) =>
      calendarAttempt(() => calendarRead(resolve(spaceId), actor, query)) as never,
  });

/** The CalendarDO's RPC surface as seen through a stub (§3.2). */
export interface CalendarRpc {
  execute(actor: string | null, command: CalendarAuthorityCommand): Promise<RpcResult<unknown>>;
  read(actor: string | null, query: CalendarAuthorityQuery): Promise<RpcResult<unknown>>;
}

const calendarRpcCall = (
  f: () => Promise<RpcResult<unknown>>,
): Effect.Effect<unknown, CalendarFailure> =>
  Effect.tryPromise(f).pipe(
    // Transport failures to the authority are defects here: the HTTP boundary reports `internal`.
    Effect.orDie,
    Effect.flatMap((r) => (r.ok ? Effect.succeed(r.value) : Effect.fail(calendarFailure(r)))),
  );

/** CalendarRepository over CalendarDO stubs: the same two calls, rejections (with details) as CalendarFailure. */
export const calendarRepositoryRpc = (resolve: (spaceId: string) => CalendarRpc) =>
  Layer.succeed(CalendarRepository, {
    execute: (spaceId, actor, command) =>
      calendarAttempt(() => requireOwnPhoto(spaceId, command)).pipe(
        Effect.flatMap(() => calendarRpcCall(() => resolve(spaceId).execute(actor, command))),
      ) as never,
    read: (spaceId, actor, query) =>
      calendarRpcCall(() => resolve(spaceId).read(actor, query)) as never,
  });
