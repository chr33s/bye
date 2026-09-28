// Calendar routes (C01–C10). Authorization is two-layered (§3.2): credential scope in the use case,
// calendar grants and owner-only privacy inside the owning CalendarDO. Reads go through typed
// `CalendarReadQuery` values; writes through versioned `CalendarCommand` envelopes.
import { Effect, Schema, Predicate, type Types } from "effect";
import {
  calendarCreateEventFromMessage,
  calendarCreateFeedToken,
  calendarExecuteCommand,
  calendarListOccurrences,
  calendarListVisible,
  calendarReadQuery,
  calendarSearch,
  calendarSearchLocations,
  calendarServeFeed,
  requireCalendar,
  requireMailbox,
} from "@bye/application";
import { calParseDate } from "@bye/calendar-engine";
import {
  ApiError,
  CALENDAR_PHOTO_KEY,
  CalendarAgendaResponse,
  CalendarChangesResponse,
  type CalendarCommandOutcome,
  CalendarDayContextWire,
  CalendarDayViewWire,
  CalendarFeedTokensResponse,
  CalendarHabitsResponse,
  CalendarImportResult,
  CalendarListResponse,
  CalendarMonthViewWire,
  CalendarPreferencesWire,
  CalendarTimeEntriesResponse,
  CalendarTimerResponse,
  CalendarWeekTasksResponse,
  CalendarWidgetResponse,
  CalendarYearViewWire,
  MessageInvitationsResponse,
  type OccurrencesQuery,
} from "@bye/contracts";
import { calendarLocationSearchLive, readBounded } from "@bye/platform-cloudflare";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { mint, verify } from "../capability.ts";
import type { CoreEnv } from "../env.ts";
import { Invocation, route, type Route } from "../http.ts";
import { ok, publicly } from "../httpapi.ts";
import { sniffRaster } from "../images.ts";
import { calendarDiscoveryLayer, calendarRepositoryLayer } from "../services.ts";
import { CoreApi } from "../spec/index.ts";
import { authed } from "./common.ts";

const zoneOf = (tz: string | undefined) => (tz ? { viewerZone: tz } : {});

const dateParam = (value: string | undefined | null) =>
  Effect.try({
    try: () => calParseDate(value ?? ""),
    catch: () => new ApiError({ code: "bad_request", message: "date must be YYYY-MM-DD" }),
  });

/**
 * The CalendarDO's read models cross its RPC untyped: read them as their contract. A result that
 * doesn't match is a defect (logged, answered `internal`), never a guess.
 */
const wire =
  <A, I>(schema: Schema.Codec<A, I>) =>
  <V>(value: V) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);

const csv = (value: string | undefined) => (value ? value.split(",").filter(Boolean) : undefined);

// ---- day photos (C08): owner-only, private R2 key, magic-byte validated, short-lived signed reads ----

export const DAY_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const PHOTO_URL_TTL_MS = 10 * 60_000;

/** Propagate topic that scans an uploaded day photo (handled in topics/calendar.ts). */
export const DAY_PHOTO_SCAN_TOPIC = "calendar.photo-scan";

/** Queue an isolated scan of a stored day photo (C08). `date` lets a rejection clear the day. */
const requestPhotoScan = <D>(env: CoreEnv, photoKey: string, ownerId: string, date: D) => {
  const calendarId = photoKey.split("/")[1]!;

  return env.PROPAGATE.send(
    {
      schemaVersion: 1,
      type: "propagate",
      eventId: `photo-scan:${photoKey}:${Date.now()}`,
      topic: DAY_PHOTO_SCAN_TOPIC,
      source: `calendar:${calendarId}`,
      target: calendarId,
      payload: { topic: DAY_PHOTO_SCAN_TOPIC, key: photoKey, calendarId, ownerId, date },
    },
    { contentType: "json" },
  );
};

/** Per-isolate throttle for read-triggered rescans (one per photo per minute). */
const RESCAN_INTERVAL_MS = 60_000;

const rescanAt = new Map<string, number>();

const rescanDue = (key: string, now: number): boolean => {
  const last = rescanAt.get(key);

  if (last !== undefined && now - last < RESCAN_INTERVAL_MS) return false;

  if (rescanAt.size > 10_000) rescanAt.clear();
  rescanAt.set(key, now);

  return true;
};

/** Whether a day-photo key lives in this calendar space (`cal/<space>/photo/…`). */
const photoInSpace = (spaceId: string, photoKey: string): boolean =>
  CALENDAR_PHOTO_KEY.test(photoKey) && photoKey.startsWith(`cal/${spaceId}/photo/`);

/**
 * A short-lived read link for a day photo, bound to the space whose day shows it: the photo route
 * re-checks that the key belongs to that space, so a key attached elsewhere is never served.
 */
export const signDayPhotoUrl = async (
  env: CoreEnv,
  spaceId: string,
  photoKey: string,
  now: number,
): Promise<string> =>
  `/v1/calendar-photos?t=${await mint(env.PROXY_SIGNING_KEY, "dayphoto", [spaceId, photoKey], PHOTO_URL_TTL_MS, now)}`;

/** The photo key a day-photo capability link (`?t=`) grants, or null. */
const dayPhotoKey = async (env: CoreEnv, url: URL, now: number): Promise<string | null> => {
  const token = url.searchParams.get("t");

  if (token === null) return null;
  const fields = await verify(env.PROXY_SIGNING_KEY, "dayphoto", token, 2, now);

  if (!fields) return null;
  const [spaceId, key] = fields as [string, string];

  return photoInSpace(spaceId, key) ? key : null;
};

const withPhotoUrl = async <T extends { readonly photoKey?: string | undefined }>(
  env: CoreEnv,
  spaceId: string,
  context: T | undefined,
): Promise<(T & { photoUrl?: string }) | undefined> =>
  // A key from another space (stored before attachments were space-bound) is never signed.
  context?.photoKey && photoInSpace(spaceId, context.photoKey)
    ? { ...context, photoUrl: await signDayPhotoUrl(env, spaceId, context.photoKey, Date.now()) }
    : context;

/**
 * A SetDayDecoration that replaced or cleared a photo reports it as `released` (no day shows it
 * any more): delete the stored object so replaced photos don't accumulate outside any quota.
 */
const deleteReleasedPhoto = <R>(env: CoreEnv, spaceId: string, result: R) =>
  Effect.promise(async () => {
    const released = (result as { released?: unknown } | null)?.released;

    if (Predicate.isString(released) && photoInSpace(spaceId, released))
      await env.PARTS.delete(released).catch(() => undefined);

    return result;
  });

/** Commands through the generic endpoints; a day-photo change cleans up the photo it released. */
type CommandBody = Parameters<typeof calendarExecuteCommand>[1];

const executeCommand = (env: CoreEnv, spaceId: string, body: CommandBody) =>
  calendarExecuteCommand(spaceId, body).pipe(
    Effect.flatMap((result) => deleteReleasedPhoto(env, spaceId, result)),
  );

export const calendarRoutes: ReadonlyArray<Route> = [
  // ---- day photo upload (C08): a raw image body, streamed with a hard cap ----
  route(
    "POST",
    "/v1/calendars/:id/days/:date/photo",
    authed(
      ({ params: p, env, request }) =>
        Effect.gen(function* () {
          // Authenticate first (the body is left unread), then stream the raw image with a hard cap:
          // chunked uploads without Content-Length are bounded too, and anonymous bodies never buffered.
          // Owner check first (day photos are owner-only), so a non-owner never stores bytes.
          const principal = yield* requireCalendar(p.id!, "calendar");
          const date = yield* dateParam(p.date);

          // Each upload stores up to 10 MB and queues a scan: throttle per user before reading.
          const limited = yield* Effect.promise(() =>
            env.AUTH_RATE_LIMIT.limit({ key: `dayphoto:${principal.userId}` }),
          );

          if (!limited.success)
            return yield* new ApiError({ code: "rate_limited", message: "slow down" });

          if (Number(request.headers.get("content-length") ?? "0") > DAY_PHOTO_MAX_BYTES)
            return yield* new ApiError({
              code: "payload_too_large",
              message: "photos must be at most 10 MB",
            });
          const bytes = yield* Effect.promise(() => readBounded(request, DAY_PHOTO_MAX_BYTES));

          if (!bytes || bytes.byteLength === 0)
            return yield* new ApiError({
              code: "payload_too_large",
              message: "photos must be 1 byte to 10 MB",
            });
          const type = sniffRaster(bytes);

          if (!type)
            return yield* new ApiError({
              code: "bad_request",
              message: "only JPEG, PNG, WebP or GIF photos are accepted",
            });
          const photoKey = `cal/${p.id}/photo/${crypto.randomUUID().replace(/-/g, "")}`;
          // Stored as `pending` and served only once the isolated scanner marks it clean (C08, §10).
          // The scan is queued BEFORE the photo is attached to the day, so an attached photo always
          // has a scan in flight; if queuing fails nothing is attached and the upload is removed.
          yield* Effect.promise(() =>
            env.PARTS.put(photoKey, bytes, {
              httpMetadata: { contentType: type },
              customMetadata: {
                owner: principal.userId,
                scan: "pending",
                date: JSON.stringify(date),
              },
            }),
          );

          const queued = yield* Effect.result(
            Effect.tryPromise(() => requestPhotoScan(env, photoKey, principal.userId, date)),
          );

          if (Predicate.isTagged(queued, "Failure")) {
            yield* Effect.promise(() => env.PARTS.delete(photoKey));

            return yield* new ApiError({
              code: "unavailable",
              message: "photo scanning is unavailable; try again",
            });
          }

          const set = yield* Effect.result(
            calendarExecuteCommand(p.id!, {
              schemaVersion: 1,
              command: { type: "SetDayDecoration", commandId: `photo:${photoKey}`, date, photoKey },
            }),
          );

          if (Predicate.isTagged(set, "Failure")) {
            yield* Effect.promise(() => env.PARTS.delete(photoKey));

            return yield* set.failure;
          }

          yield* deleteReleasedPhoto(env, p.id!, set.success);

          return {
            photoKey,
            scan: "pending",
            photoUrl: yield* Effect.promise(() =>
              signDayPhotoUrl(env, p.id!, photoKey, Date.now()),
            ),
          };
        }),
      { status: 201, rawBody: true },
    ),
  ),

  // ---- ICS export (C05): a file download ----
  route(
    "GET",
    "/v1/calendars/:id/export.ics",
    authed(
      ({ params, url }) => {
        const calendarIds = url.searchParams.get("calendarIds");

        return calendarReadQuery(
          params.id!,
          calendarIds
            ? { type: "Export", calendarIds: calendarIds.split(",").filter(Boolean) }
            : { type: "Export" },
        );
      },
      {
        raw: (ics) =>
          new Response(ics as string, {
            headers: {
              "content-type": "text/calendar; charset=utf-8",
              "content-disposition": 'attachment; filename="calendar.ics"',
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
            },
          }),
      },
    ),
  ),

  // ---- bearer-token surfaces: private feeds and signed day-photo reads ----
  route("GET", "/feeds/:calendarId/:token", async (_request, params, env) => {
    const token = (params.token ?? "").replace(/\.ics$/, "");

    const exit = await Effect.runPromiseExit(
      calendarServeFeed(params.calendarId!, token).pipe(
        Effect.provide(calendarRepositoryLayer(env)),
      ),
    );

    if (!Predicate.isTagged(exit, "Success") || !exit.value)
      return new Response("not found", { status: 404 });

    return new Response(exit.value as string, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": "private, max-age=300",
      },
    });
  }),
  route("GET", "/v1/calendar-photos", async (request, _params, env) => {
    const key = await dayPhotoKey(env, new URL(request.url), Date.now());

    if (key === null || !CALENDAR_PHOTO_KEY.test(key))
      return new Response("forbidden", { status: 403 });
    const object = await env.PARTS.get(key);

    if (!object) return new Response("not found", { status: 404 });

    // Only scanned-clean photos are served; pending (or unscanned legacy) photos are withheld.
    if (object.customMetadata?.["scan"] !== "clean") {
      await object.body.cancel().catch(() => undefined);
      // Photos uploaded before scanning existed, or whose scan message was lost, get a scan
      // (re)queued here, throttled per photo; the scan handler is idempotent.
      const owner = object.customMetadata?.["owner"];

      if (owner && rescanDue(key, Date.now())) {
        const stored = object.customMetadata?.["date"];

        const day = stored
          ? (() => {
              try {
                return JSON.parse(stored) as unknown;
              } catch {
                return null;
              }
            })()
          : null;

        await requestPhotoScan(env, key, owner, day).catch(() => undefined);
      }

      return new Response("photo is being scanned", {
        status: 409,
        headers: { "cache-control": "no-store", "retry-after": "5" },
      });
    }

    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }),
];

/** A command through the generic endpoints; a command with no result answers `{ ok: true }`. */
const commandResult = (env: CoreEnv, spaceId: string, body: CommandBody) =>
  executeCommand(env, spaceId, body).pipe(
    Effect.map((result): CalendarCommandOutcome => result ?? ok),
  );

export const CalendarHandlers = HttpApiBuilder.group(CoreApi, "calendar", (handlers) =>
  handlers
    // ---- discovery: owned calendar spaces plus calendars shared with this account (C05) ----
    .handle("listVisibleCalendars", () =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;

        const items = yield* calendarListVisible.pipe(Effect.provide(calendarDiscoveryLayer(env)));

        return { items };
      }).pipe(publicly),
    )
    .handle("listOccurrences", ({ params, query: q }) =>
      Effect.gen(function* () {
        const query: Types.Mutable<OccurrencesQuery> = {
          from: Date.parse(q.from ?? ""),
          to: Date.parse(q.to ?? ""),
          ...zoneOf(q.tz),
        };

        const calendarIds = csv(q.calendarIds);

        if (calendarIds) query.calendarIds = calendarIds;

        if (q.visibleOnly !== undefined) query.visibleOnly = q.visibleOnly !== "false";

        const occurrences = yield* calendarListOccurrences(params.id, query);

        return { schemaVersion: 1 as const, occurrences };
      }).pipe(publicly),
    )
    .handle("createEvent", ({ params, payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;

        return yield* commandResult(env, params.id, payload);
      }).pipe(publicly),
    )
    .handle("executeCommand", ({ params, payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;

        return yield* commandResult(env, params.id, payload);
      }).pipe(publicly),
    )
    .handle("search", ({ params, query }) =>
      calendarSearch(params.id, query.q ?? "", Number(query.limit ?? "25")).pipe(
        Effect.map((items) => ({ items })),
        publicly,
      ),
    )
    .handle("messageInvitations", ({ params, query }) =>
      Effect.gen(function* () {
        const mailboxId = query.mailboxId ?? "";
        const deliveryId = query.deliveryId ?? "";

        if (!mailboxId || !deliveryId)
          return yield* new ApiError({
            code: "bad_request",
            message: "mailboxId and deliveryId are required",
          });
        yield* requireMailbox(mailboxId, "read");

        return yield* calendarReadQuery(params.id, {
          type: "Invitations",
          mailboxId,
          deliveryId,
        }).pipe(Effect.flatMap(wire(MessageInvitationsResponse)));
      }).pipe(publicly),
    )
    .handle("createEventFromMessage", ({ params, payload }) =>
      calendarCreateEventFromMessage(params.id, payload).pipe(publicly),
    )

    // ---- views and navigation (C01) ----
    .handle("listCalendars", ({ params }) =>
      calendarReadQuery(params.id, { type: "Calendars" }).pipe(
        Effect.map((items) => ({ items })),
        Effect.flatMap(wire(CalendarListResponse)),
        publicly,
      ),
    )
    .handle("preferences", ({ params }) =>
      calendarReadQuery(params.id, { type: "Preferences" }).pipe(
        Effect.flatMap(wire(CalendarPreferencesWire)),
        publicly,
      ),
    )
    .handle("setPreferences", ({ params, payload }) =>
      calendarExecuteCommand(params.id, {
        schemaVersion: 1,
        command: {
          type: "SetPreferences",
          commandId: payload.commandId,
          preferences: payload.preferences ?? {},
        },
      }).pipe(Effect.flatMap(wire(CalendarPreferencesWire)), publicly),
    )
    .handle("agenda", ({ params, query }) =>
      Effect.gen(function* () {
        const from = yield* dateParam(query.from);
        const calendarIds = csv(query.calendarIds);

        const agenda = {
          type: "Agenda",
          from,
          days: Number(query.days ?? "14"),
          ...zoneOf(query.tz),
        } as const;

        const days = yield* calendarReadQuery(
          params.id,
          calendarIds ? { ...agenda, calendarIds } : agenda,
        );

        return yield* wire(CalendarAgendaResponse)({ days });
      }).pipe(publicly),
    )
    .handle("day", ({ params, query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const date = yield* dateParam(params.date);

        const day = yield* calendarReadQuery(params.id, {
          type: "Day",
          date,
          ...zoneOf(query.tz),
        }).pipe(Effect.flatMap(wire(CalendarDayViewWire)));

        if (!day.context) return day;
        const context = day.context;

        return {
          ...day,
          context: yield* Effect.promise(() => withPhotoUrl(env, params.id, context)),
        };
      }).pipe(publicly),
    )
    .handle("month", ({ params, query }) =>
      calendarReadQuery(params.id, {
        type: "Month",
        year: Number(params.year),
        month: Number(params.month),
        ...zoneOf(query.tz),
      }).pipe(Effect.flatMap(wire(CalendarMonthViewWire)), publicly),
    )
    .handle("year", ({ params, query }) =>
      calendarReadQuery(params.id, {
        type: "Year",
        year: Number(params.year),
        ...zoneOf(query.tz),
      }).pipe(Effect.flatMap(wire(CalendarYearViewWire)), publicly),
    )

    // ---- weekly tasks, habits, time tracking, day context (C06–C08) ----
    .handle("weekTasks", ({ params, query }) =>
      Effect.gen(function* () {
        const date = yield* dateParam(query.date);

        const items = yield* calendarReadQuery(
          params.id,
          query.firstWeekday
            ? { type: "WeekTasks", date, firstWeekday: Number(query.firstWeekday) }
            : { type: "WeekTasks", date },
        );

        return yield* wire(CalendarWeekTasksResponse)({ items });
      }).pipe(publicly),
    )
    .handle("habits", ({ params, query }) =>
      Effect.gen(function* () {
        const [from, to] = yield* Effect.all([dateParam(query.from), dateParam(query.to)]);
        const items = yield* calendarReadQuery(params.id, { type: "Habits", from, to });

        return yield* wire(CalendarHabitsResponse)({ items });
      }).pipe(publicly),
    )
    .handle("timer", ({ params }) =>
      calendarReadQuery(params.id, { type: "Timer" }).pipe(
        Effect.flatMap(wire(CalendarTimerResponse)),
        publicly,
      ),
    )
    .handle("timeEntries", ({ params, query }) =>
      calendarReadQuery(params.id, {
        type: "TimeEntries",
        from: Date.parse(query.from ?? ""),
        to: Date.parse(query.to ?? ""),
      }).pipe(
        Effect.map((items) => ({ items })),
        Effect.flatMap(wire(CalendarTimeEntriesResponse)),
        publicly,
      ),
    )
    .handle("dayContext", ({ params, query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const date = yield* dateParam(params.date);

        const context = yield* calendarReadQuery(params.id, {
          type: "DayContext",
          date,
          ...zoneOf(query.tz),
        }).pipe(Effect.flatMap(wire(CalendarDayContextWire)));

        // The authority always answers a day context; `withPhotoUrl` only adds the signed link.
        return (yield* Effect.promise(() => withPhotoUrl(env, params.id, context))) ?? context;
      }).pipe(publicly),
    )

    // ---- device surfaces and interoperability (C05, C10) ----
    .handle("widget", ({ params, query }) =>
      calendarReadQuery(params.id, { type: "Widget", ...zoneOf(query.tz) }).pipe(
        Effect.flatMap(wire(CalendarWidgetResponse)),
        publicly,
      ),
    )
    .handle("changes", ({ params, query }) =>
      calendarReadQuery(params.id, {
        type: "Changes",
        cursor: Number(query.cursor ?? "0"),
      }).pipe(Effect.flatMap(wire(CalendarChangesResponse)), publicly),
    )
    .handle("listFeedTokens", ({ params }) =>
      calendarReadQuery(params.id, { type: "FeedTokens" }).pipe(
        Effect.map((items) => ({ items })),
        Effect.flatMap(wire(CalendarFeedTokensResponse)),
        publicly,
      ),
    )
    .handle("createFeedToken", ({ params, payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const { token } = yield* calendarCreateFeedToken(params.id, payload);

        return { token, url: `${env.APP_ORIGIN}/feeds/${params.id}/${token}.ics` };
      }).pipe(publicly),
    )
    .handle("revokeFeedToken", ({ params, query }) =>
      calendarExecuteCommand(params.id, {
        schemaVersion: 1,
        command: {
          type: "RevokeFeedToken",
          commandId: query.commandId ?? `revoke:${params.hash}`,
          tokenHash: params.hash,
        },
      }).pipe(Effect.as(ok), publicly),
    )
    .handle("importIcs", ({ params, payload }) =>
      calendarExecuteCommand(params.id, {
        schemaVersion: 1,
        command: { type: "ImportIcs", ...payload },
      }).pipe(Effect.flatMap(wire(CalendarImportResult)), publicly),
    )
    .handle("searchLocations", ({ query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        // `Number(null)` is 0, as the old `searchParams.get` read: presence is decided by `lat`.
        const lat = Number(query.lat ?? null);
        const lng = Number(query.lng ?? null);

        const near =
          Number.isFinite(lat) && Number.isFinite(lng) && query.lat !== undefined
            ? { latitude: lat, longitude: lng }
            : undefined;

        const items = yield* calendarSearchLocations(query.q ?? "", near).pipe(
          Effect.provide(calendarLocationSearchLive(env.LOCATION_API_KEY || undefined)),
          Effect.catchTag("LocationSearchFailure", () => Effect.succeed([])),
        );

        return { items };
      }).pipe(publicly),
    ),
);
