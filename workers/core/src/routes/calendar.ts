// Calendar routes (C01–C10). Authorization is two-layered (§3.2): credential scope in the use case,
// calendar grants and owner-only privacy inside the owning CalendarDO. Reads go through typed
// `CalendarReadQuery` values; writes through versioned `CalendarCommand` envelopes.
import { Effect, Schema } from "effect";
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
} from "@bye/application";
import { calParseDate } from "@bye/calendar-engine";
import { ApiError, CALENDAR_PHOTO_KEY } from "@bye/contracts";
import { calendarLocationSearchLive, readBounded } from "@bye/platform-cloudflare";
import { mint, verify } from "../capability.ts";
import type { CoreEnv } from "../env.ts";
import { route, type Route } from "../http.ts";
import { sniffRaster } from "../images.ts";
import { calendarDiscoveryLayer, calendarRepositoryLayer } from "../services.ts";
import { authed, authedBody } from "./common.ts";

// Route bodies that are one command's fields; the command envelope schema validates the values.
const CommandId = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)));
const PreferencesRequest = Schema.Struct({
  commandId: CommandId,
  preferences: Schema.optional(Schema.Unknown),
});
const ImportRequest = Schema.Struct({
  commandId: CommandId,
  calendarId: Schema.String,
  ics: Schema.String,
});

const zoneOf = (url: URL) =>
  url.searchParams.get("tz") ? { viewerZone: url.searchParams.get("tz")! } : {};

const dateParam = (value: string | undefined | null) =>
  Effect.try({
    try: () => calParseDate(value ?? ""),
    catch: () => new ApiError({ code: "bad_request", message: "date must be YYYY-MM-DD" }),
  });

// ---- day photos (C08): owner-only, private R2 key, magic-byte validated, short-lived signed reads ----

export const DAY_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_URL_TTL_MS = 10 * 60_000;

/** Propagate topic that scans an uploaded day photo (handled in topics/calendar.ts). */
export const DAY_PHOTO_SCAN_TOPIC = "calendar.photo-scan";

/** Queue an isolated scan of a stored day photo (C08). `date` lets a rejection clear the day. */
const requestPhotoScan = (env: CoreEnv, photoKey: string, ownerId: string, date: unknown) => {
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

const decorateDay = (env: CoreEnv, spaceId: string) => (value: unknown) =>
  Effect.promise(async () => {
    const v = value as { context?: { photoKey?: string } };
    return v.context ? { ...v, context: await withPhotoUrl(env, spaceId, v.context) } : value;
  });

/**
 * A SetDayDecoration that replaced or cleared a photo reports it as `released` (no day shows it
 * any more): delete the stored object so replaced photos don't accumulate outside any quota.
 */
const deleteReleasedPhoto = (env: CoreEnv, spaceId: string, result: unknown) =>
  Effect.promise(async () => {
    const released = (result as { released?: unknown } | null)?.released;
    if (typeof released === "string" && photoInSpace(spaceId, released))
      await env.PARTS.delete(released).catch(() => undefined);
    return result;
  });

/** Commands through the generic endpoints; a day-photo change cleans up the photo it released. */
const executeCommand = (env: CoreEnv, spaceId: string, body: unknown) =>
  calendarExecuteCommand(spaceId, body).pipe(
    Effect.flatMap((result) => deleteReleasedPhoto(env, spaceId, result)),
  );

export const calendarRoutes: ReadonlyArray<Route<CoreEnv>> = [
  // ---- discovery: owned calendar spaces plus calendars shared with this account (C05) ----
  route(
    "GET",
    "/v1/calendars",
    authed(({ env }) =>
      calendarListVisible.pipe(
        Effect.provide(calendarDiscoveryLayer(env)),
        Effect.map((items) => ({ items })),
      ),
    ),
  ),

  route(
    "GET",
    "/v1/calendars/:id/events",
    authed(({ params, url }) =>
      calendarListOccurrences(params.id!, {
        from: Date.parse(url.searchParams.get("from") ?? ""),
        to: Date.parse(url.searchParams.get("to") ?? ""),
        ...zoneOf(url),
        ...(url.searchParams.get("calendarIds")
          ? { calendarIds: url.searchParams.get("calendarIds")!.split(",").filter(Boolean) }
          : {}),
        ...(url.searchParams.has("visibleOnly")
          ? { visibleOnly: url.searchParams.get("visibleOnly") !== "false" }
          : {}),
      }).pipe(Effect.map((occurrences) => ({ schemaVersion: 1, occurrences }))),
    ),
  ),
  route(
    "POST",
    "/v1/calendars/:id/events",
    authed(({ params, body, env }) => executeCommand(env, params.id!, body)),
  ),
  route(
    "POST",
    "/v1/calendars/:id/commands",
    authed(({ params, body, env }) => executeCommand(env, params.id!, body)),
  ),
  route(
    "GET",
    "/v1/calendars/:id/search",
    authed(({ params, url }) =>
      calendarSearch(
        params.id!,
        url.searchParams.get("q") ?? "",
        Number(url.searchParams.get("limit") ?? "25"),
      ).pipe(Effect.map((items) => ({ items }))),
    ),
  ),
  route(
    "POST",
    "/v1/calendars/:id/from-message",
    authed(({ params, body }) => calendarCreateEventFromMessage(params.id!, body), { status: 201 }),
  ),

  // ---- views and navigation (C01) ----
  route(
    "GET",
    "/v1/calendars/:id/calendars",
    authed(({ params }) =>
      calendarReadQuery(params.id!, { type: "Calendars" }).pipe(Effect.map((items) => ({ items }))),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/preferences",
    authed(({ params }) => calendarReadQuery(params.id!, { type: "Preferences" })),
  ),
  route(
    "PATCH",
    "/v1/calendars/:id/preferences",
    authedBody(PreferencesRequest, ({ params, body }) =>
      calendarExecuteCommand(params.id!, {
        schemaVersion: 1,
        command: {
          type: "SetPreferences",
          commandId: body.commandId,
          preferences: body.preferences ?? {},
        },
      }),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/agenda",
    authed(({ params, url }) =>
      Effect.flatMap(dateParam(url.searchParams.get("from")), (from) =>
        calendarReadQuery(params.id!, {
          type: "Agenda",
          from,
          days: Number(url.searchParams.get("days") ?? "14"),
          ...zoneOf(url),
          ...(url.searchParams.get("calendarIds")
            ? { calendarIds: url.searchParams.get("calendarIds")!.split(",").filter(Boolean) }
            : {}),
        }),
      ).pipe(Effect.map((days) => ({ days }))),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/day/:date",
    authed(({ params, url, env }) =>
      Effect.flatMap(dateParam(params.date), (date) =>
        calendarReadQuery(params.id!, { type: "Day", date, ...zoneOf(url) }),
      ).pipe(Effect.flatMap(decorateDay(env, params.id!))),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/month/:year/:month",
    authed(({ params, url }) =>
      calendarReadQuery(params.id!, {
        type: "Month",
        year: Number(params.year),
        month: Number(params.month),
        ...zoneOf(url),
      }),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/year/:year",
    authed(({ params, url }) =>
      calendarReadQuery(params.id!, { type: "Year", year: Number(params.year), ...zoneOf(url) }),
    ),
  ),

  // ---- weekly tasks, habits, time tracking, day context (C06–C08) ----
  route(
    "GET",
    "/v1/calendars/:id/week-tasks",
    authed(({ params, url }) =>
      Effect.flatMap(dateParam(url.searchParams.get("date")), (date) =>
        calendarReadQuery(params.id!, {
          type: "WeekTasks",
          date,
          ...(url.searchParams.get("firstWeekday")
            ? { firstWeekday: Number(url.searchParams.get("firstWeekday")) }
            : {}),
        }),
      ).pipe(Effect.map((items) => ({ items }))),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/habits",
    authed(({ params, url }) =>
      Effect.all([
        dateParam(url.searchParams.get("from")),
        dateParam(url.searchParams.get("to")),
      ]).pipe(
        Effect.flatMap(([from, to]) => calendarReadQuery(params.id!, { type: "Habits", from, to })),
        Effect.map((items) => ({ items })),
      ),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/timer",
    authed(({ params }) => calendarReadQuery(params.id!, { type: "Timer" })),
  ),
  route(
    "GET",
    "/v1/calendars/:id/time-entries",
    authed(({ params, url }) =>
      calendarReadQuery(params.id!, {
        type: "TimeEntries",
        from: Date.parse(url.searchParams.get("from") ?? ""),
        to: Date.parse(url.searchParams.get("to") ?? ""),
      }).pipe(Effect.map((items) => ({ items }))),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/days/:date/context",
    authed(({ params, url, env }) =>
      Effect.flatMap(dateParam(params.date), (date) =>
        calendarReadQuery(params.id!, { type: "DayContext", date, ...zoneOf(url) }),
      ).pipe(
        Effect.flatMap((ctx) =>
          Effect.promise(() => withPhotoUrl(env, params.id!, ctx as { photoKey?: string })),
        ),
      ),
    ),
  ),
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
          if (queued._tag === "Failure") {
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
          if (set._tag === "Failure") {
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

  // ---- device surfaces and interoperability (C05, C10) ----
  route(
    "GET",
    "/v1/calendars/:id/widget",
    authed(({ params, url }) => calendarReadQuery(params.id!, { type: "Widget", ...zoneOf(url) })),
  ),
  route(
    "GET",
    "/v1/calendars/:id/changes",
    authed(({ params, url }) =>
      calendarReadQuery(params.id!, {
        type: "Changes",
        cursor: Number(url.searchParams.get("cursor") ?? "0"),
      }),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/feed-tokens",
    authed(({ params }) =>
      calendarReadQuery(params.id!, { type: "FeedTokens" }).pipe(
        Effect.map((items) => ({ items })),
      ),
    ),
  ),
  route(
    "POST",
    "/v1/calendars/:id/feed-tokens",
    authed(
      ({ params, body, env }) =>
        Effect.map(calendarCreateFeedToken(params.id!, body), ({ token }) => ({
          token,
          url: `${env.APP_ORIGIN}/feeds/${params.id}/${token}.ics`,
        })),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/calendars/:id/feed-tokens/:hash",
    authed(({ params, url }) =>
      calendarExecuteCommand(params.id!, {
        schemaVersion: 1,
        command: {
          type: "RevokeFeedToken",
          commandId: url.searchParams.get("commandId") ?? `revoke:${params.hash}`,
          tokenHash: params.hash,
        },
      }),
    ),
  ),
  route(
    "GET",
    "/v1/calendars/:id/export.ics",
    authed(
      ({ params, url }) =>
        calendarReadQuery(params.id!, {
          type: "Export",
          ...(url.searchParams.get("calendarIds")
            ? { calendarIds: url.searchParams.get("calendarIds")!.split(",").filter(Boolean) }
            : {}),
        }),
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
  route(
    "POST",
    "/v1/calendars/:id/import",
    authedBody(ImportRequest, ({ params, body }) =>
      calendarExecuteCommand(params.id!, {
        schemaVersion: 1,
        command: { type: "ImportIcs", ...body },
      }),
    ),
  ),
  route(
    "GET",
    "/v1/locations",
    authed(({ url, env }) =>
      Effect.gen(function* () {
        const lat = Number(url.searchParams.get("lat"));
        const lng = Number(url.searchParams.get("lng"));
        const near =
          Number.isFinite(lat) && Number.isFinite(lng) && url.searchParams.has("lat")
            ? { latitude: lat, longitude: lng }
            : undefined;
        const items = yield* calendarSearchLocations(url.searchParams.get("q") ?? "", near).pipe(
          Effect.provide(calendarLocationSearchLive(env.LOCATION_API_KEY || undefined)),
          Effect.catchTag("LocationSearchFailure", () => Effect.succeed([])),
        );
        return { items };
      }),
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
    if (exit._tag !== "Success" || !exit.value) return new Response("not found", { status: 404 });
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
