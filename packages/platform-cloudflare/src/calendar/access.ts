import type { CalendarAuthorityCommand, CalendarAuthorityQuery } from "@bye/contracts";
import type { CalendarBase } from "./base.ts";
import { calendarError } from "./types.ts";

// Who may send what to a calendar authority (§3.2) — ONE exhaustive table, enforced once by the
// dispatcher before any store method runs. Adding a command or read without a policy fails to
// compile, so a new read kind can never ship unguarded.

export type CalendarMessage = CalendarAuthorityCommand | CalendarAuthorityQuery;
export type CalendarMessageType = CalendarMessage["type"];
type Of<K extends CalendarMessageType> = Extract<CalendarMessage, { type: K }>;

export type CalendarPolicy<M> =
  /** The account owner only: management and every private kind (journal, habits, time, day, preferences). */
  | "owner"
  /** Any principal; the authority narrows the result to calendars the actor can read (strangers get nothing). */
  | "readable"
  /** Trusted Worker code with no principal: bearer feeds, subscription refreshes, inbound invitations. */
  | "system"
  /** A role on the calendar the message names. */
  | { readonly calendar: (m: M) => string; readonly need: "read" | "write" }
  /** Write access to the calendar holding the event (a missing event is the store's `not_found`). */
  | { readonly event: (m: M) => string; readonly need: "write" };

const calendarWrite = <M extends { readonly calendarId: string }>(): CalendarPolicy<M> => ({
  calendar: (m) => m.calendarId,
  need: "write",
});
const eventWrite = <M extends { readonly eventId: string }>(): CalendarPolicy<M> => ({
  event: (m) => m.eventId,
  need: "write",
});

export const CALENDAR_ACCESS: { readonly [K in CalendarMessageType]: CalendarPolicy<Of<K>> } = {
  // ---- commands
  CreateCalendar: "owner",
  UpdateCalendar: "owner",
  DeleteCalendar: "owner",
  GrantCalendar: "owner",
  RevokeCalendar: "owner",
  CreateEvent: calendarWrite(),
  UpdateEvent: eventWrite(),
  DeleteEvent: eventWrite(),
  RespondInvitation: "owner",
  ImportIcs: calendarWrite(),
  AddWeekTask: "owner",
  ReorderWeekTask: "owner",
  MoveWeekTask: "owner",
  CompleteWeekTask: "owner",
  DeleteWeekTask: "owner",
  ConvertWeekTask: "owner",
  CreateHabit: "owner",
  SetHabitCompletion: "owner",
  ArchiveHabit: "owner",
  StartTimer: "owner",
  StopTimer: "owner",
  AddTimeEntry: "owner",
  SetDayDecoration: "owner",
  WriteJournal: "owner",
  SetPreferences: "owner",
  AddSubscription: "owner",
  RevokeFeedToken: "owner",
  // ---- authority-internal commands
  CreateEventFromMessage: "owner",
  CreateFeedToken: "owner",
  ApplySubscriptionFetch: "system",
  ReceiveInvitation: "system",
  // ---- reads
  Calendars: "readable",
  Agenda: "readable",
  Day: "readable",
  Month: "readable",
  Year: "readable",
  Occurrences: "readable",
  Search: "readable",
  Export: "readable",
  Changes: "readable",
  Preferences: "owner",
  WeekTasks: "owner",
  Habits: "owner",
  Timer: "owner",
  TimeEntries: "owner",
  DayContext: "owner",
  Widget: "owner",
  FeedTokens: "owner",
  // ---- authority-internal reads
  Feed: "system",
  Subscription: "system",
};

/** Enforce the message's policy for `actor` (`null`: trusted Worker code with no principal). */
export const authorizeCalendar = (
  store: CalendarBase,
  actor: string | null,
  message: CalendarMessage,
): void => {
  const policy = CALENDAR_ACCESS[message.type] as CalendarPolicy<CalendarMessage>;
  if (policy === "system") {
    if (actor !== null) throw calendarError("forbidden", "internal calendar operation");
    return;
  }
  if (actor === null) throw calendarError("forbidden", "a principal is required");
  if (policy === "readable") return;
  if (policy === "owner") {
    if (!store.isOwner(actor))
      throw calendarError("forbidden", "private calendar data is owner-only");
    return;
  }
  if ("calendar" in policy) {
    store.requireRole(policy.calendar(message), actor, policy.need);
    return;
  }
  const calendarId = store.calendarOfEvent(policy.event(message));
  if (calendarId) store.requireRole(calendarId, actor, policy.need);
};
