import { Context, Effect, Result, Schema } from "effect";
import { sha256Hex, toBase64Url } from "@bye/domain";
import {
  type CalendarAuthorityCommand,
  type CalendarAuthorityQuery,
  CreateEventFromMessageRequest,
  CreateFeedTokenRequest,
  decodeCalendarCommandEnvelope,
  decodeCalendarReadQuery,
  decodeOccurrencesQuery,
  type LocationSuggestion,
  type OccurrenceWire,
  RejectionCode,
} from "@bye/contracts";
import { NotFound, requireMailbox, requireScope, type RequestPayload } from "../services.ts";

// Calendar use cases (C01–C10). Authorization is two-layered (§3.2): the credential scope is
// checked here from the verified Principal; calendar grants and owner-only privacy for
// journals, habits, day context and time tracking are enforced inside the owning CalendarDO.

/** A calendar authority's refusal. `details` carries e.g. `currentRevision` on a conflict. */
export class CalendarFailure extends Schema.TaggedError<CalendarFailure>()("CalendarFailure", {
  code: RejectionCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface CalendarSearchHitWire {
  readonly docId: string;
  readonly kind: "event" | "task" | "journal" | "time" | "day" | "habit";
  readonly ref: string;
  readonly snippet: string;
}

export interface CalendarSubscriptionInfo {
  readonly url: string;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly itemLimit: number;
}

export type CalendarFetchOutcome =
  | {
      readonly status: "ok";
      readonly body: string;
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
    }
  | { readonly status: "not-modified" };

/** A calendar the principal can read in some calendar space (owned, or shared with them). */
export interface CalendarListItem {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly kind: string;
  readonly visible: boolean;
  readonly revision: number;
  readonly role: "owner" | "write" | "read";
}

/** Result types of the messages whose results use cases consume; the rest are passed through. */
export interface CalendarCommandResults {
  readonly CreateEventFromMessage: { readonly eventId: string; readonly uid: string };
  readonly ApplySubscriptionFetch: {
    readonly imported: number;
    readonly updated: number;
    readonly warnings: ReadonlyArray<string>;
  };
}

export interface CalendarReadResults {
  readonly Calendars: ReadonlyArray<CalendarListItem>;
  readonly Occurrences: ReadonlyArray<OccurrenceWire>;
  readonly Search: ReadonlyArray<CalendarSearchHitWire>;
  readonly Feed: string | undefined;
  readonly Subscription: CalendarSubscriptionInfo | undefined;
}

type ResultOf<M, K> = K extends keyof M ? M[K] : unknown;

/**
 * The calendar authority port: one command entry and one read entry, exactly the CalendarDO's RPC
 * surface. `actor` is the verified principal, or `null` for trusted principal-free operations
 * (bearer feeds, subscription refreshes); the authority's access table decides which is allowed.
 */
export class CalendarRepository extends Context.Service<
  CalendarRepository,
  {
    readonly execute: <C extends CalendarAuthorityCommand>(
      spaceId: string,
      actor: string | null,
      command: C,
    ) => Effect.Effect<ResultOf<CalendarCommandResults, C["type"]>, CalendarFailure>;
    readonly read: <Q extends CalendarAuthorityQuery>(
      spaceId: string,
      actor: string | null,
      query: Q,
    ) => Effect.Effect<ResultOf<CalendarReadResults, Q["type"]>, CalendarFailure>;
  }
>()("calendar/CalendarRepository") {}

/** Calendar spaces shared with a user (the D1 grant index; each authority re-checks its grants). */
export class CalendarDiscovery extends Context.Service<
  CalendarDiscovery,
  { readonly sharedSpaces: (userId: string) => Effect.Effect<ReadonlyArray<string>> }
>()("calendar/CalendarDiscovery") {}

export class CalendarFetchFailure extends Schema.TaggedError<CalendarFetchFailure>()(
  "CalendarFetchFailure",
  {
    reason: Schema.Literals(["blocked", "too-large", "timeout", "http", "content-type", "network"]),
    detail: Schema.String,
  },
) {}

/** Bounded external ICS fetcher with SSRF protection (C05, §9). */
export class CalendarFeedFetcher extends Context.Service<
  CalendarFeedFetcher,
  {
    readonly fetch: (request: {
      readonly url: string;
      readonly etag: string | undefined;
      readonly lastModified: string | undefined;
      readonly maxBytes: number;
    }) => Effect.Effect<CalendarFetchOutcome, CalendarFetchFailure>;
  }
>()("calendar/CalendarFeedFetcher") {}

export class LocationSearchFailure extends Schema.TaggedError<LocationSearchFailure>()(
  "LocationSearchFailure",
  {
    detail: Schema.String,
  },
) {}

/** Location autocomplete is an external data/provider adapter, not a D1 capability (§9, C10). */
export class LocationSearch extends Context.Service<
  LocationSearch,
  {
    readonly search: (query: {
      readonly text: string;
      readonly near: { readonly latitude: number; readonly longitude: number } | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<LocationSuggestion>, LocationSearchFailure>;
  }
>()("calendar/LocationSearch") {}

const invalid = (message: string) => new CalendarFailure({ code: "bad_request", message });

export const calendarExecuteCommand = (spaceId: string, body: RequestPayload) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("calendar");

    const envelope = yield* decodeCalendarCommandEnvelope(body).pipe(
      Effect.mapError((e) => invalid(String(e))),
    );

    // Inviting attendees mails them from the owner's address (iTIP), so it
    // needs send authority, not just the calendar scope.
    const command = envelope.command as {
      readonly attendees?: ReadonlyArray<unknown>;
      readonly changes?: { readonly attendees?: ReadonlyArray<unknown> };
    };

    const attendees = command.attendees ?? command.changes?.attendees;

    if (attendees !== undefined && attendees.length > 0) yield* requireScope("send");
    const repository = yield* CalendarRepository;

    return yield* repository.execute(spaceId, principal.userId, envelope.command);
  }).pipe(Effect.withSpan("calendar.command"));

/** Read models (views, week tasks, habits, timer, day context, widget, feed tokens, changes). */
export const calendarReadQuery = (spaceId: string, query: RequestPayload) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("read");

    const decoded = yield* decodeCalendarReadQuery(query).pipe(
      Effect.mapError((e) => invalid(String(e))),
    );

    const repository = yield* CalendarRepository;

    return yield* repository.read(spaceId, principal.userId, decoded);
  }).pipe(Effect.withSpan("calendar.read"));

/** Occurrences in a bounded window, with overlap columns for day/week grids (C01). */
export const calendarListOccurrences = (spaceId: string, query: RequestPayload) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("read");

    const decoded = yield* decodeOccurrencesQuery(query).pipe(
      Effect.mapError((e) => invalid(String(e))),
    );

    const repository = yield* CalendarRepository;

    return yield* repository.read(spaceId, principal.userId, { type: "Occurrences", ...decoded });
  }).pipe(Effect.withSpan("calendar.occurrences"));

export const calendarSearch = (spaceId: string, query: string, limit = 25) =>
  Effect.gen(function* () {
    const principal = yield* requireScope("read");

    if (query.length === 0 || query.length > 256)
      return yield* invalid("query must be 1-256 characters");
    const repository = yield* CalendarRepository;

    return yield* repository.read(spaceId, principal.userId, {
      type: "Search",
      query,
      limit: Math.min(Math.max(limit, 1), 100),
    });
  }).pipe(Effect.withSpan("calendar.search"));

/** Most calendar spaces one listing reads; each authority read runs with bounded concurrency. */
const VISIBLE_SPACES_MAX = 50;

/**
 * Discovery (C05): the calendars the principal can see across their own calendar spaces and the
 * spaces that shared calendars with them. The D1 grant index only suggests where to look; each
 * authority re-checks its grants, and an unreadable space contributes nothing.
 */
export const calendarListVisible = Effect.gen(function* () {
  const principal = yield* requireScope("read");
  const shared = yield* (yield* CalendarDiscovery).sharedSpaces(principal.userId);
  const repository = yield* CalendarRepository;
  const spaces = [...new Set([...principal.calendarIds, ...shared])].slice(0, VISIBLE_SPACES_MAX);

  const perSpace = yield* Effect.forEach(
    spaces,
    (spaceId) =>
      repository.read(spaceId, principal.userId, { type: "Calendars" }).pipe(
        Effect.map((calendars) =>
          calendars.map((c) => ({ spaceId, owned: principal.calendarIds.includes(spaceId), ...c })),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  );

  return perSpace.flat();
}).pipe(Effect.withSpan("calendar.listVisible"));

/** C09: requires read access to the source mailbox as well as calendar scope. */
export const calendarCreateEventFromMessage = (spaceId: string, body: RequestPayload) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(CreateEventFromMessageRequest)(body).pipe(
      Effect.mapError((e) => invalid(String(e))),
    );

    yield* requireMailbox(request.message.mailboxId, "read");
    const principal = yield* requireScope("calendar");
    const repository = yield* CalendarRepository;

    return yield* repository.execute(spaceId, principal.userId, {
      type: "CreateEventFromMessage",
      commandId: request.commandId,
      calendarId: request.calendarId,
      message: request.message,
      title: request.title,
      start: request.start,
      end: request.end,
    });
  }).pipe(Effect.withSpan("calendar.createFromMessage"));

/** Private feed tokens are stored only as SHA-256 hashes. */
export const calendarHashToken = (token: string) => Effect.promise(() => sha256Hex(token));

/** Create a revocable private feed URL token. The raw token is returned exactly once. */
export const calendarCreateFeedToken = (spaceId: string, body: RequestPayload) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(CreateFeedTokenRequest)(body).pipe(
      Effect.mapError((e) => invalid(String(e))),
    );

    const principal = yield* requireScope("calendar");
    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = yield* calendarHashToken(token);
    const repository = yield* CalendarRepository;
    yield* repository.execute(spaceId, principal.userId, {
      type: "CreateFeedToken",
      commandId: request.commandId,
      tokenHash,
      calendarIds: request.calendarIds,
      label: request.label,
    });

    return { token };
  }).pipe(Effect.withSpan("calendar.feedToken"));

/** Bearer feed access: no session principal; the token itself is the revocable credential. */
export const calendarServeFeed = (spaceId: string, token: string) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return yield* new NotFound({ resource: "feed" });
    const repository = yield* CalendarRepository;

    const ics = yield* repository.read(spaceId, null, {
      type: "Feed",
      tokenHash: yield* calendarHashToken(token),
    });

    if (ics === undefined) return yield* new NotFound({ resource: "feed" });

    return ics;
  }).pipe(Effect.withSpan("calendar.feed"));

export const CALENDAR_FEED_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Refresh an external read-only subscription with conditional-request validators. Fetch failures
 * are recorded (with back-off) rather than retried inline; the durable job owns the retry.
 */
export const calendarRefreshSubscription = (spaceId: string, calendarId: string, fetchId: string) =>
  Effect.gen(function* () {
    const repository = yield* CalendarRepository;
    const fetcher = yield* CalendarFeedFetcher;
    const sub = yield* repository.read(spaceId, null, { type: "Subscription", calendarId });

    if (!sub) return yield* new NotFound({ resource: "subscription" });

    const outcome = yield* Effect.result(
      fetcher.fetch({
        url: sub.url,
        etag: sub.etag,
        lastModified: sub.lastModified,
        maxBytes: CALENDAR_FEED_MAX_BYTES,
      }),
    );

    // The fetch ID is the command ID, so a redelivered refresh applies at most once.
    const apply = { type: "ApplySubscriptionFetch", commandId: fetchId, calendarId } as const;

    if (Result.isFailure(outcome))
      return yield* repository.execute(spaceId, null, {
        ...apply,
        status: "error",
        error: outcome.failure.reason,
      });
    const fetched = outcome.success;

    return yield* repository.execute(
      spaceId,
      null,
      fetched.status === "ok"
        ? {
            ...apply,
            status: "ok",
            body: fetched.body,
            etag: fetched.etag,
            lastModified: fetched.lastModified,
          }
        : { ...apply, status: "not-modified" },
    );
  }).pipe(Effect.withSpan("calendar.refreshSubscription"));

export const calendarSearchLocations = (
  text: string,
  near?: { latitude: number; longitude: number },
) =>
  Effect.gen(function* () {
    yield* requireScope("calendar");
    const trimmed = text.trim();

    if (trimmed.length < 2 || trimmed.length > 200)
      return yield* invalid("query must be 2-200 characters");
    const locations = yield* LocationSearch;

    return yield* locations.search({ text: trimmed, near, limit: 8 });
  }).pipe(Effect.withSpan("calendar.locations"));
