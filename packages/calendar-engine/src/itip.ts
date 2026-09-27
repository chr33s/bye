import { calNormAddress } from "./address.ts";
import {
  type CalAttendee,
  type CalIcsEvent,
  type CalPartstat,
  calSerializeCalendar,
} from "./ics.ts";
import { calRecurrenceKey, type CalTime } from "./time.ts";

// iTIP (RFC 5546) message construction and interpretation (§9, C04).
// Organizer authority, SEQUENCE/DTSTAMP ordering, and per-occurrence revisions are enforced
// here; transport-level sender authentication is established upstream (DKIM/SPF/DMARC evidence).

export type CalItipMethod =
  | "REQUEST"
  | "REPLY"
  | "CANCEL"
  | "ADD"
  | "REFRESH"
  | "COUNTER"
  | "DECLINECOUNTER"
  | "PUBLISH";

export interface CalRevision {
  readonly sequence: number;
  readonly dtstamp: number | undefined;
}

/** Negative when `a` is older than `b`; 0 when identical. */
export const calCompareRevision = (a: CalRevision, b: CalRevision): number =>
  a.sequence !== b.sequence ? a.sequence - b.sequence : (a.dtstamp ?? 0) - (b.dtstamp ?? 0);

export interface CalKnownInvitation {
  readonly organizer: string | undefined;
  readonly weAreOrganizer: boolean;
  /** Last applied revision for this (uid, recurrence) pair. */
  readonly revision: CalRevision | undefined;
  /** Last applied revision of the whole series; per-occurrence messages older than it are stale. */
  readonly seriesRevision: CalRevision | undefined;
  /** Last applied reply revision per attendee address (organizer side). */
  readonly attendeeRevisions: Readonly<Record<string, CalRevision>>;
  /**
   * A live event with this UID exists but was created locally (no ORGANIZER): it never came from
   * an invitation, so no external sender may claim it by UID.
   */
  readonly localEvent?: boolean | undefined;
}

export type CalItipDecision =
  | {
      readonly _tag: "Apply";
      readonly action: "create" | "update" | "cancel" | "reply";
      readonly recurrenceKey: string;
    }
  | { readonly _tag: "IgnoreStale"; readonly recurrenceKey: string }
  | { readonly _tag: "Duplicate"; readonly recurrenceKey: string }
  | { readonly _tag: "Unauthorized"; readonly reason: string }
  | { readonly _tag: "Unsupported"; readonly method: string };

export interface CalItipInput {
  readonly method: string | undefined;
  readonly event: CalIcsEvent;
  /** Authenticated envelope/From sender of the carrying email. */
  readonly sender: string;
  /** Addresses of the receiving account. */
  readonly self: ReadonlyArray<string>;
  readonly known: CalKnownInvitation | undefined;
  /**
   * DTSTART of the stored series this message addresses, when known. A RECURRENCE-ID in another
   * zone (UTC, a foreign TZID) is normalized to the series' wall clock so it keys the same occurrence.
   */
  readonly seriesStart?: CalTime | undefined;
}

export const calInterpretItip = (input: CalItipInput): CalItipDecision => {
  const method = (input.method ?? "").toUpperCase();
  const e = input.event;
  const recurrenceKey = e.recurrenceId ? calRecurrenceKey(e.recurrenceId, input.seriesStart) : "";
  const sender = calNormAddress(input.sender);
  const self = input.self.map(calNormAddress);
  const organizer = calNormAddress(e.organizer?.address);
  const incoming: CalRevision = { sequence: e.sequence, dtstamp: e.dtstamp };
  const known = input.known;

  const ordering = (current: CalRevision | undefined): CalItipDecision | undefined => {
    if (
      known?.seriesRevision &&
      recurrenceKey &&
      incoming.sequence < known.seriesRevision.sequence
    ) {
      return { _tag: "IgnoreStale", recurrenceKey };
    }
    if (!current) return undefined;
    const cmp = calCompareRevision(incoming, current);
    if (cmp < 0) return { _tag: "IgnoreStale", recurrenceKey };
    if (cmp === 0) return { _tag: "Duplicate", recurrenceKey };
    return undefined;
  };

  switch (method) {
    case "REQUEST":
    case "ADD":
    case "CANCEL": {
      if (!organizer) return { _tag: "Unauthorized", reason: "missing organizer" };
      if (sender !== organizer)
        return { _tag: "Unauthorized", reason: "sender is not the organizer" };
      if (self.includes(organizer))
        return { _tag: "Unauthorized", reason: "message claims our own organizer identity" };
      if (known?.weAreOrganizer)
        return { _tag: "Unauthorized", reason: "event is organized by this account" };
      if (known?.localEvent)
        return { _tag: "Unauthorized", reason: "event was not received as an invitation" };
      if (known?.organizer && calNormAddress(known.organizer) !== organizer)
        return { _tag: "Unauthorized", reason: "organizer change rejected" };
      const stale = ordering(known?.revision);
      if (stale) return stale;
      if (method === "CANCEL") return { _tag: "Apply", action: "cancel", recurrenceKey };
      return {
        _tag: "Apply",
        action: known?.revision || known?.seriesRevision ? "update" : "create",
        recurrenceKey,
      };
    }
    case "REPLY": {
      if (!known?.weAreOrganizer)
        return { _tag: "Unauthorized", reason: "reply for an event we do not organize" };
      const attendee = e.attendees[0];
      if (!attendee || e.attendees.length !== 1)
        return { _tag: "Unauthorized", reason: "reply must carry exactly one attendee" };
      const attendeeAddress = calNormAddress(attendee.address);
      if (attendeeAddress !== sender)
        return { _tag: "Unauthorized", reason: "reply sender is not the attendee" };
      const prior = known.attendeeRevisions[attendeeAddress];
      if (prior) {
        const cmp = calCompareRevision(incoming, prior);
        if (cmp < 0) return { _tag: "IgnoreStale", recurrenceKey };
        if (cmp === 0) return { _tag: "Duplicate", recurrenceKey };
      }
      return { _tag: "Apply", action: "reply", recurrenceKey };
    }
    default:
      return { _tag: "Unsupported", method: method || "(none)" };
  }
};

export interface CalItipMessage {
  readonly method: CalItipMethod;
  readonly ics: string;
  readonly recipients: ReadonlyArray<string>;
}

/** Attendee addresses other than the organizer's. */
const invitees = (event: CalIcsEvent): ReadonlyArray<string> =>
  event.attendees
    .map((a) => a.address)
    .filter((a) => calNormAddress(a) !== calNormAddress(event.organizer?.address));

export const calBuildRequest = (event: CalIcsEvent, now: number): CalItipMessage => ({
  method: "REQUEST",
  ics: calSerializeCalendar([event], { method: "REQUEST", now }),
  recipients: invitees(event),
});

/** CANCEL for the whole series, or one occurrence when `event.recurrenceId` is set. */
export const calBuildCancel = (event: CalIcsEvent, now: number): CalItipMessage => {
  const cancelled: CalIcsEvent = {
    ...event,
    series: { ...event.series, data: { ...event.series.data, status: "cancelled" } },
  };
  return {
    method: "CANCEL",
    ics: calSerializeCalendar([cancelled], { method: "CANCEL", now }),
    recipients: invitees(event),
  };
};

/** Attendee REPLY carrying only the responding attendee — a real RSVP, not prose email. */
export const calBuildReply = (
  event: CalIcsEvent,
  attendeeAddress: string,
  partstat: CalPartstat,
  now: number,
): CalItipMessage => {
  const me = event.attendees.find(
    (a) => calNormAddress(a.address) === calNormAddress(attendeeAddress),
  );
  const attendee: CalAttendee = {
    address: calNormAddress(attendeeAddress),
    name: me?.name,
    partstat,
    role: me?.role,
  };
  const reply: CalIcsEvent = { ...event, dtstamp: now, attendees: [attendee], alarms: [] };
  return {
    method: "REPLY",
    ics: calSerializeCalendar([reply], { method: "REPLY", now, includeDescription: false }),
    recipients: event.organizer ? [event.organizer.address] : [],
  };
};
