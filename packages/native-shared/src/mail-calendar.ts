import { Predicate } from "effect";
import type { JsonValue } from "./json.ts";
import type {
  CreateEventFromMessageRequest,
  MessageInvitationWire,
  OccurrenceWire,
} from "@bye/contracts";
import { eventPayload } from "./calendar-form.ts";

// Email/calendar integration (C09) shared by the web and native clients: invitation responses in a
// thread, create-event-from-message, and the calendar cover panel in the mail view. Pure functions
// so each client's behaviour is tested once, without a DOM or a React Native renderer.

// ---- invitations ----

export type Partstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/** RSVP choices in display order, with the label each client shows. */
export const RSVP_CHOICES: ReadonlyArray<readonly [Partstat, string]> = [
  ["ACCEPTED", "Accept"],
  ["TENTATIVE", "Maybe"],
  ["DECLINED", "Decline"],
];

/** The event title an invitation's subject carries ("Invitation: Standup" → "Standup"). */
export const invitationTitle = (subject: string): string =>
  subject.replace(/^(invitation|updated invitation|invitation updated)\s*:\s*/i, "").trim();

/** A calendar search hit (`GET /v1/calendars/:id/search`); `ref` is the hit's calendar. */
export interface CalendarSearchHitWire {
  readonly docId?: string;
  readonly kind: string;
  readonly ref: string;
  readonly snippet: string;
}

/**
 * The events an invitation may refer to. An event hit's `docId` is `event:<eventId>` and its `ref`
 * is the calendar holding it, so the event ID comes from `docId`, never `ref`.
 */
export const invitationEvents = (
  hits: ReadonlyArray<CalendarSearchHitWire>,
): ReadonlyArray<{ readonly eventId: string; readonly snippet: string }> => {
  const seen = new Set<string>();
  const out: Array<{ eventId: string; snippet: string }> = [];

  for (const hit of hits) {
    if (hit.kind !== "event" || !hit.docId?.startsWith("event:")) continue;
    const eventId = hit.docId.slice("event:".length);

    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);
    out.push({ eventId, snippet: hit.snippet });
  }

  return out;
};

/** How each client names the owner's current answer. */
export const PARTSTAT_LABEL = Object.fromEntries([
  ["ACCEPTED", "Accepted"],
  ["TENTATIVE", "Maybe"],
  ["DECLINED", "Declined"],
  ["NEEDS-ACTION", "Not answered"],
  ["DELEGATED", "Delegated"],
]);

/** One invitation a thread can answer. */
export interface ThreadInvitation {
  readonly eventId: string;
  /** Set when the message is about a single occurrence: the answer then applies only to it. */
  readonly occurrenceKey: string | null;
  readonly label: string;
  /** The owner's current answer; null when it isn't known (older servers). */
  readonly answer: string | null;
  readonly cancelled: boolean;
}

export const threadInvitations = (
  invitations: ReadonlyArray<MessageInvitationWire>,
): ReadonlyArray<ThreadInvitation> =>
  invitations.map((i) => ({
    eventId: i.eventId,
    occurrenceKey: i.occurrenceKey,
    label: i.occurrenceKey
      ? `${i.summary} (this occurrence)`
      : i.recurring
        ? `${i.summary} (every occurrence)`
        : i.summary,
    answer: PARTSTAT_LABEL[i.partstat] ?? i.partstat,
    cancelled: i.cancelled,
  }));

/** The client calls the invitation lookup needs (ByeClient provides both). */
export interface InvitationLookupClient {
  messageInvitations(
    calendarId: string,
    mailboxId: string,
    deliveryId: string,
  ): Promise<{ readonly invitations: ReadonlyArray<MessageInvitationWire> }>;
  calendarSearch(
    calendarId: string,
    q: string,
    limit?: number,
  ): Promise<{ readonly items: ReadonlyArray<CalendarSearchHitWire> }>;
}

/**
 * The invitations one delivered message carried, with the owner's current answer and the
 * occurrence each concerns. When the instance has no lookup route (404), or no link for this
 * message (mail from before links existed), fall back to a title search, which can only answer
 * the whole series and can't show the current answer.
 */
export const findThreadInvitations = async (
  client: InvitationLookupClient,
  calendarId: string,
  mailboxId: string,
  deliveryId: string,
  subject: string,
): Promise<ReadonlyArray<ThreadInvitation>> => {
  try {
    const { invitations } = await client.messageInvitations(calendarId, mailboxId, deliveryId);

    if (invitations.length > 0) return threadInvitations(invitations);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }

  const { items } = await client.calendarSearch(calendarId, invitationTitle(subject), 5);

  return invitationEvents(items).map((e) => ({
    eventId: e.eventId,
    occurrenceKey: null,
    label: e.snippet,
    answer: null,
    cancelled: false,
  }));
};

// ---- create event from a message ----

/** The body for `POST /v1/calendars/:id/from-message`; the client adds the command ID. */
export type FromMessageBody = Omit<CreateEventFromMessageRequest, "commandId" | "schemaVersion">;

export interface FromMessageForm {
  readonly calendarId: string;
  readonly mailboxId: string;
  readonly threadId: string;
  readonly deliveryId?: string;
  readonly title: string;
  /** Wall clock `YYYY-MM-DDTHH:mm` in `timeZone`. */
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

/**
 * Validate a create-from-message form. The server re-checks read access to the source mailbox
 * before it stores the backlink, which only the calendar owner ever sees.
 */
export const fromMessagePayload = (
  form: FromMessageForm,
):
  | { readonly ok: true; readonly body: FromMessageBody }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> } => {
  const built = eventPayload({
    calendarId: form.calendarId,
    title: form.title,
    allDay: false,
    start: form.start,
    end: form.end,
    timeZone: form.timeZone,
    frequency: "none",
    interval: 1,
    byDay: [],
    ends: { kind: "never" },
    location: "",
    description: "",
    attendees: "",
    reminders: "",
  });

  if (!built.ok) return { ok: false, errors: built.errors.map((e) => `${e.field}: ${e.message}`) };

  const message: MessageRef = {
    mailboxId: form.mailboxId,
    threadId: form.threadId,
  };

  if (form.deliveryId) message.deliveryId = form.deliveryId;

  return {
    ok: true,
    body: {
      calendarId: form.calendarId,
      message,
      title: built.command.data.summary,
      start: built.command.start,
      end: built.command.end,
    },
  };
};

/** The first calendar an event can be created in (list routes answer `id` or `calendarId`). */
export const firstCalendarId = (
  calendars: ReadonlyArray<{ readonly id?: string; readonly calendarId?: string }>,
): string | null => {
  const first = calendars[0];

  return first?.calendarId ?? first?.id ?? null;
};

// ---- calendar cover panel ----

/** The occurrence fields the cover panel reads (the OccurrenceWire contract, or a subset of it). */
export type CoverOccurrence = Pick<
  OccurrenceWire,
  "eventId" | "calendarId" | "key" | "startMs" | "endMs" | "allDay"
> & { readonly data: { readonly summary: string } };

/**
 * How the panel labels an occurrence: "All day", the start time today, or weekday and date plus
 * time for a later day. Uses the viewer's locale unless one is given.
 */
export const coverTimeText = (
  o: Pick<CoverOccurrence, "allDay" | "startMs">,
  now: number,
  locale?: string,
): string => {
  if (o.allDay) return "All day";
  const start = new Date(o.startMs);
  const time = start.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

  return start.toDateString() === new Date(now).toDateString()
    ? time
    : `${start.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

export interface CoverAgenda<O extends CoverOccurrence = CoverOccurrence> {
  /** Everything on today (all-day first, then by start), including events already over. */
  readonly today: ReadonlyArray<O>;
  /** The next timed event that hasn't started yet, today or later in the window. */
  readonly next: O | null;
}

/** Days after today the panel looks ahead for the next event. */
export const COVER_LOOKAHEAD_DAYS = 7;

const startOfDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
};

/** The window the cover panel loads: local midnight today through the lookahead. */
export const coverWindow = (now: number): CoverWindow => {
  const from = startOfDay(now);
  const end = new Date(from);
  end.setDate(end.getDate() + COVER_LOOKAHEAD_DAYS + 1);

  return { from, to: end.getTime() };
};

/** Today's agenda and the next event from an occurrence window (duplicates dropped). */
export const coverAgenda = <O extends CoverOccurrence>(
  occurrences: ReadonlyArray<O>,
  now: number,
): CoverAgenda<O> => {
  const from = startOfDay(now);
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const to = tomorrow.getTime();
  const unique = [...new Map(occurrences.map((o) => [`${o.eventId}:${o.key}`, o])).values()];

  const today = unique
    .filter((o) => o.startMs < to && Math.max(o.endMs, o.startMs + 1) > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);

  const next =
    unique.filter((o) => !o.allDay && o.startMs >= now).sort((a, b) => a.startMs - b.startMs)[0] ??
    null;

  return { today, next };
};

/**
 * Whether the mail view shows the cover panel: the `calendarPanel` mailbox preference, read from
 * `GET /v1/mailboxes/:id/preferences` (`{ preferences: {...} }`). Off unless the user turned it on.
 */
export const calendarPanelEnabled = (response: JsonValue): boolean => {
  if (!Predicate.isObject(response)) return false;
  const preferences = response.preferences;
  const prefs = Predicate.isObject(preferences) ? preferences : response;

  return prefs.calendarPanel === true;
};

interface MessageRef {
  mailboxId: string;
  threadId: string;
  deliveryId?: string;
}

interface CoverWindow {
  readonly from: number;
  readonly to: number;
}
