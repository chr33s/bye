import {
  calAddDays,
  calApplySeriesChanges,
  calAtTime,
  type CalAttendee,
  calBuildCancel,
  calBuildReply,
  calBuildRequest,
  calDateOf,
  calDateToDays,
  calDaysToDate,
  calEndFor,
  type CalException,
  calExpand,
  calExpandSeries,
  type CalIcsEvent,
  calInstant,
  calIsValidTimeZone,
  type CalLocalDateTime,
  calNextReminder,
  calNormAddress,
  type CalPartstat,
  calParseRRule,
  type CalPerson,
  type CalRRule,
  type CalSeries,
  calReminderRecheckAt,
  calSeriesDuration,
  calSplitSeries,
  calStartOfDay,
  type CalTime,
  calTimeFromKey,
  calTimeProblem,
  calZonedToInstant,
} from "@bye/calendar-engine";
import { MAX_CALENDAR_ATTENDEES } from "@bye/contracts";
import { CalendarBase } from "./base.ts";
import {
  calendarError,
  type CalendarEditScope,
  type CalendarEventChanges,
  type CalendarEventRecord,
  type CalendarEventWrite,
  type CalendarMessageRef,
  type CalendarOccurrenceView,
  type CalendarSeriesInput,
  type EventRow,
  MAX_WINDOW_MS,
  REMINDER_JOB,
  SUBSCRIPTION_JOB,
} from "./types.ts";

// Events (C02/C03): the write model, scoped edits ("this" / "this and future" / series),
// occurrence reads, reminders, and the outbound iTIP they imply. Access has been checked by the
// dispatcher; the rules here are domain rules (organizer ownership, owner-only fields, invariants).

/** What an iTIP message needs from an event: never a full record. */
type ItipSource = Pick<
  CalendarEventRecord,
  "uid" | "sequence" | "series" | "organizer" | "attendees" | "alarms"
>;

type ItipMessage = { method: string; ics: string; recipients: ReadonlyArray<string> };

/** COUNT rules longer than this are stored with an unbounded range instead of being expanded. */
const RANGE_COUNT_CAP = 5000;

/**
 * Latest instant an occurrence may start under an RFC 5545 UNTIL (inclusive): a UTC stamp, a
 * floating wall clock in the series zone, or a date (its whole day, in the series zone).
 */
const untilInstant = (until: string, dtstart: CalTime): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(until);

  if (!m) return undefined;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const zone = dtstart.kind === "timed" ? dtstart.tzid : "UTC";

  if (m[4] === undefined) return calStartOfDay(calAddDays(date, 1), zone) - 1;
  const local = { ...date, hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) };

  return m[7] === "Z"
    ? Date.UTC(date.year, date.month - 1, date.day, local.hour, local.minute, local.second)
    : calZonedToInstant(local, zone);
};

/** A newly invited attendee: required, awaiting a reply. */
const newAttendee = (person: CalPerson): CalAttendee => ({
  address: calNormAddress(person.address),
  name: person.name,
  partstat: "NEEDS-ACTION",
  role: "REQ-PARTICIPANT",
  rsvp: true,
});

/**
 * `time` moved by the same wall-clock amount that took `from` to `to` (days for all-day values,
 * minutes for timed ones, keeping `to`'s zone). A change of kind can't be carried over: `to` wins.
 */
const shiftLike = (time: CalTime, from: CalTime, to: CalTime): CalTime => {
  if (time.kind === "date" && from.kind === "date" && to.kind === "date")
    return {
      kind: "date",
      date: calAddDays(time.date, calDateToDays(to.date) - calDateToDays(from.date)),
    };

  if (time.kind !== "timed" || from.kind !== "timed" || to.kind !== "timed") return to;

  const minutes = (t: CalLocalDateTime) =>
    calDateToDays(calDateOf(t)) * 1440 + t.hour * 60 + t.minute + t.second / 60;

  const shifted = minutes(time.local) + minutes(to.local) - minutes(from.local);
  const days = Math.floor(shifted / 1440);
  const rest = shifted - days * 1440;

  return {
    kind: "timed",
    tzid: to.tzid,
    local: calAtTime(
      calDaysToDate(days),
      Math.floor(rest / 60),
      Math.floor(rest % 60),
      Math.round((rest * 60) % 60),
    ),
  };
};

export abstract class CalendarEvents extends CalendarBase {
  protected parseRule(rrule: string | undefined | null): CalRRule | undefined {
    if (!rrule) return undefined;

    try {
      return calParseRRule(rrule);
    } catch (error) {
      throw calendarError("bad_request", error instanceof Error ? error.message : "invalid rule");
    }
  }

  /** An occurrence key's original start in the series' own form (bad keys are the caller's error). */
  protected timeFromKey(series: CalSeries, key: string): CalTime {
    try {
      return calTimeFromKey(series.dtstart, key);
    } catch {
      throw calendarError("bad_request", "invalid occurrence key");
    }
  }

  /** Reject unusable time values (unknown zone, out-of-range fields) before any instant math. */
  protected validateTime(t: CalTime | undefined, what: string): void {
    if (t === undefined) return;
    const problem = calTimeProblem(t);

    if (problem) throw calendarError("bad_request", `${what}: ${problem}`);
  }

  protected validateZone(zone: string | undefined): void {
    if (zone !== undefined && !calIsValidTimeZone(zone))
      throw calendarError("bad_request", `unknown time zone ${zone}`);
  }

  private validateSeries(series: CalSeries, exceptions: ReadonlyArray<CalException>): void {
    this.validateTime(series.dtstart, "start");
    this.validateTime(series.dtend, "end");

    for (const t of series.rdates ?? []) this.validateTime(t, "rdate");

    for (const t of series.exdates ?? []) this.validateTime(t, "exdate");

    for (const e of exceptions) {
      this.validateTime(e.start, "occurrence start");
      this.validateTime(e.end, "occurrence end");
    }

    if (series.dtstart.kind !== series.dtend.kind)
      throw calendarError("bad_request", "start and end must both be dates or both be timed");

    if (calInstant(series.dtend) < calInstant(series.dtstart))
      throw calendarError("bad_request", "end precedes start");
  }

  /**
   * The instant span an event can occupy, stored so window queries can skip it (`range_end` NULL
   * means unbounded). Computed analytically — UNTIL is a bound by itself — and by a capped
   * expansion only for COUNT rules; a COUNT the cap cannot confirm is stored as unbounded rather
   * than truncated, so no occurrence ever falls outside its row's range.
   */
  private range(series: CalSeries, exceptions: ReadonlyArray<CalException>): CalendarEventRange {
    const slack = 14 * 3_600_000; // widest UTC offset, so all-day dates match any viewer zone
    const duration = Math.max(0, calInstant(series.dtend) - calInstant(series.dtstart));
    let start = calInstant(series.dtstart);
    let end = calInstant(series.dtend);

    const include = (from: number, to: number): void => {
      if (from < start) start = from;

      if (to > end) end = to;
    };

    for (const e of exceptions) {
      if (!e.start) continue;
      const s = calInstant(e.start);
      include(s, e.end ? Math.max(s + duration, calInstant(e.end)) : s + duration);
    }

    for (const r of series.rdates ?? []) {
      const s = calInstant(r);
      include(s, s + duration);
    }

    const rule = series.rule;

    if (rule) {
      const last = rule.until !== undefined ? untilInstant(rule.until, series.dtstart) : undefined;

      if (last !== undefined) {
        end = Math.max(end, last + duration);
      } else if (rule.count !== undefined && rule.count <= RANGE_COUNT_CAP) {
        const all = calExpand(
          { dtstart: series.dtstart, rule },
          {
            from: Number.MIN_SAFE_INTEGER / 2,
            to: Number.MAX_SAFE_INTEGER / 2,
            maxOccurrences: rule.count,
          },
        );

        // Fewer than COUNT means the expansion hit its period bound: the true end is unknown.
        if (all.length < rule.count) return { start: start - slack, end: null };
        const lastStart = all.at(-1)!.startMs;
        include(lastStart, lastStart + duration);
      } else {
        return { start: start - slack, end: null };
      }
    }

    return { start: start - slack, end: end + slack };
  }

  protected writeEvent(record: CalendarEventWrite, isNew: boolean): CalendarEventRevision {
    this.validateSeries(record.series, record.exceptions);
    const now = this.clock.now();
    const range = this.range(record.series, record.exceptions);

    const columns = [
      JSON.stringify(record.series),
      record.organizer ? JSON.stringify(record.organizer) : null,
      record.weAreOrganizer,
      JSON.stringify(record.attendees),
      JSON.stringify(record.alarms),
      record.sequence,
      now,
      record.highlight,
      record.countdown,
      record.privateNote ?? null,
      record.sourceRef ? JSON.stringify(record.sourceRef) : null,
      range.start,
      range.end,
    ] as const;

    if (isNew) {
      this.sql.run(
        `INSERT INTO cal_events (id, calendar_id, uid, series, organizer, we_are_organizer, attendees, alarms, sequence, dtstamp,
           highlight, countdown, private_note, source_ref, range_start, range_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.calendarId,
        record.uid,
        ...columns,
        now,
        now,
      );
    } else {
      this.sql.run(
        `UPDATE cal_events SET series = ?, organizer = ?, we_are_organizer = ?, attendees = ?, alarms = ?, sequence = ?,
           dtstamp = ?, highlight = ?, countdown = ?, private_note = ?, source_ref = ?, range_start = ?, range_end = ?,
           calendar_id = ?, revision = revision + 1, generation = generation + 1, updated_at = ?
         WHERE id = ?`,
        ...columns,
        record.calendarId,
        now,
        record.id,
      );
    }

    this.sql.run("DELETE FROM cal_exceptions WHERE event_id = ?", record.id);

    for (const e of record.exceptions) {
      this.sql.run(
        "INSERT INTO cal_exceptions (event_id, recurrence_key, body) VALUES (?, ?, ?)",
        record.id,
        e.recurrenceKey,
        JSON.stringify(e),
      );
    }

    const row = this.sql.one<{ revision: number; generation: number }>(
      "SELECT revision, generation FROM cal_events WHERE id = ?",
      record.id,
    )!;

    this.indexEvent(record);
    this.scheduleReminder(record.id);
    this.kernel.change("event", isNew ? "created" : "updated", {
      eventId: record.id,
      calendarId: record.calendarId,
    });

    return { revision: Number(row.revision), generation: Number(row.generation) };
  }

  protected removeEventRow(eventId: string): void {
    const calendarId = this.calendarOfEvent(eventId);
    this.sql.run(
      "UPDATE cal_events SET deleted = 1, revision = revision + 1, generation = generation + 1 WHERE id = ?",
      eventId,
    );
    this.sql.run("DELETE FROM cal_exceptions WHERE event_id = ?", eventId);
    this.kernel.cancelJob(REMINDER_JOB, eventId);
    this.unindex(`event:${eventId}`);
    this.kernel.change("event", "deleted", { eventId, calendarId });
  }

  private indexEvent(
    r: Pick<CalendarEventWrite, "id" | "calendarId" | "series" | "exceptions">,
  ): void {
    const text = [
      r.series.data.summary,
      r.series.data.description,
      r.series.data.location,
      ...r.exceptions.map((e) => e.data?.summary ?? ""),
    ]
      .filter(Boolean)
      .join("\n");

    this.index(`event:${r.id}`, "event", r.calendarId, text);
  }

  // ---------------------------------------------------------------- outbound iTIP

  private icsEvent(source: ItipSource, extra: Partial<CalIcsEvent> = {}): CalIcsEvent {
    return {
      uid: source.uid,
      sequence: source.sequence,
      dtstamp: this.clock.now(),
      series: source.series,
      organizer: source.organizer,
      attendees: source.attendees,
      alarms: source.alarms,
      ...extra,
    };
  }

  /** Queue an iTIP message for the owner's mailbox (with the summary, so no one reparses ICS). */
  private sendItip(eventId: string, source: ItipSource, message: ItipMessage): void {
    if (message.recipients.length === 0) return;
    this.kernel.emit("calendar.itip", eventId, {
      method: message.method,
      ics: message.ics,
      recipients: message.recipients,
      from: this.config.selfAddresses[0],
      summary: source.series.data.summary,
    });
  }

  protected itipRequest(
    eventId: string,
    source: ItipSource,
    extra: Partial<CalIcsEvent> = {},
  ): void {
    this.sendItip(eventId, source, calBuildRequest(this.icsEvent(source, extra), this.clock.now()));
  }

  protected itipCancel(
    eventId: string,
    source: ItipSource,
    extra: Partial<CalIcsEvent> = {},
  ): void {
    this.sendItip(eventId, source, calBuildCancel(this.icsEvent(source, extra), this.clock.now()));
  }

  protected itipReply(
    eventId: string,
    source: ItipSource,
    attendee: string,
    partstat: Exclude<CalPartstat, "DELEGATED" | "NEEDS-ACTION">,
    extra: Partial<CalIcsEvent> = {},
  ): void {
    this.sendItip(
      eventId,
      source,
      calBuildReply(this.icsEvent(source, extra), attendee, partstat, this.clock.now()),
    );
  }

  // ---------------------------------------------------------------- commands

  createEvent(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    series: CalendarSeriesInput;
    attendees?: ReadonlyArray<CalPerson>;
    alarms?: ReadonlyArray<number>;
    highlight?: boolean;
    countdown?: boolean;
    privateNote?: string;
    sourceRef?: CalendarMessageRef;
  }): { eventId: string; uid: string } {
    return this.command(input.commandId, "CreateEvent", () => {
      this.writableCalendar(input.calendarId);

      // Owner-only fields: a grantee with write access can't annotate or backlink the owner's data.
      if (
        (input.privateNote !== undefined || input.sourceRef !== undefined) &&
        !this.isOwner(input.actor)
      )
        throw calendarError("forbidden", "private calendar data is owner-only");
      const id = this.clock.id("evt");
      const uid = `${id}@bye.calendar`;

      const series: CalSeries = {
        uid,
        dtstart: input.series.start,
        dtend: input.series.end,
        rule: this.parseRule(input.series.rrule),
        rdates: input.series.rdates ?? [],
        exdates: input.series.exdates ?? [],
        data: { status: "confirmed", ...input.series.data },
      };

      const attendees = (input.attendees ?? []).filter(
        (a) => !this.self.includes(calNormAddress(a.address)),
      );

      this.checkInvitees(input.actor, attendees.length);

      const organizer =
        attendees.length > 0
          ? { address: calNormAddress(this.config.selfAddresses[0]) }
          : undefined;

      const record: CalendarEventWrite = {
        id,
        calendarId: input.calendarId,
        uid,
        series,
        exceptions: [],
        organizer,
        weAreOrganizer: organizer !== undefined,
        attendees: attendees.map(newAttendee),
        alarms: [...new Set(input.alarms ?? [])],
        sequence: 0,
        highlight: input.highlight ?? false,
        countdown: input.countdown ?? false,
        privateNote: input.privateNote,
        sourceRef: input.sourceRef,
      };

      this.writeEvent(record, true);

      if (organizer) this.itipRequest(id, record);

      return { eventId: id, uid };
    });
  }

  /** C09: create an event from a message with a backlink; the caller has checked mailbox access. */
  createEventFromMessage(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    message: CalendarMessageRef;
    title: string;
    start: CalTime;
    end: CalTime;
  }): { eventId: string; uid: string } {
    return this.createEvent({
      commandId: input.commandId,
      actor: input.actor,
      calendarId: input.calendarId,
      series: { start: input.start, end: input.end, data: { summary: input.title } },
      sourceRef: input.message,
    });
  }

  updateEvent(input: {
    commandId: string;
    actor: string;
    eventId: string;
    expectedRevision: number;
    scope: CalendarEditScope;
    occurrenceKey?: string;
    changes: CalendarEventChanges;
  }): { eventId: string; revision: number; splitEventId?: string } {
    return this.command(input.commandId, "UpdateEvent", () => {
      const row = this.eventRow(input.eventId);

      if (!row) throw calendarError("not_found", "event not found");
      this.writableCalendar(row.calendar_id);
      const current = this.toRecord(row);

      if (current.revision !== input.expectedRevision)
        throw calendarError("conflict", "event revision changed", current.revision);
      const c = input.changes;

      if (!current.weAreOrganizer && current.organizer) {
        // Attendee copies accept only personal fields; the organizer owns shared event data.
        const allowed = ["alarms", "highlight", "countdown", "privateNote"];

        if (Object.keys(c).some((k) => !allowed.includes(k)))
          throw calendarError("forbidden", "only the organizer can change this event");
      }

      if (c.privateNote !== undefined && !this.isOwner(input.actor))
        throw calendarError("forbidden", "private calendar data is owner-only");

      const personal = {
        alarms: c.alarms ? [...new Set(c.alarms)] : current.alarms,
        highlight: c.highlight ?? current.highlight,
        countdown: c.countdown ?? current.countdown,
        privateNote: c.privateNote === null ? undefined : (c.privateNote ?? current.privateNote),
      };

      const attendees: ReadonlyArray<CalAttendee> = c.attendees
        ? c.attendees
            .filter((a) => !this.self.includes(calNormAddress(a.address)))
            .map(
              (a) =>
                current.attendees.find((x) => x.address === calNormAddress(a.address)) ??
                newAttendee(a),
            )
        : current.attendees;

      const removed = current.attendees.filter(
        (a) => !attendees.some((x) => x.address === a.address),
      );

      const significant =
        c.start !== undefined ||
        c.end !== undefined ||
        c.rrule !== undefined ||
        c.data?.location !== undefined ||
        c.data?.summary !== undefined ||
        c.attendees !== undefined;

      if (!this.isOwner(input.actor)) {
        // Outbound iTIP is mail from the owner's address, so only the owner may invite, re-invite
        // or cancel: a write grantee can't change who is invited, nor the shared fields of an
        // event the owner organizes with invitees (either would mail those invitees).
        const inviteesChanged =
          removed.length > 0 ||
          attendees.some((a) => !current.attendees.some((x) => x.address === a.address));

        if (inviteesChanged)
          throw calendarError("forbidden", "only the calendar owner can invite attendees");

        if (
          current.weAreOrganizer &&
          current.attendees.length > 0 &&
          (significant || input.scope === "future")
        )
          throw calendarError("forbidden", "only the calendar owner can change an invitation");
      }

      if (attendees.length > MAX_CALENDAR_ATTENDEES)
        throw calendarError("bad_request", `at most ${MAX_CALENDAR_ATTENDEES} attendees`);

      const organizer = current.weAreOrganizer
        ? (current.organizer ?? { address: calNormAddress(this.config.selfAddresses[0]) })
        : current.organizer;

      const weAreOrganizer = current.weAreOrganizer || (!current.organizer && attendees.length > 0);
      const sequence = weAreOrganizer && significant ? current.sequence + 1 : current.sequence;

      // A whole-series time change made from one occurrence (the occurrence key names it) moves
      // the series by the same wall-clock amount, rather than making that occurrence the first.
      const anchorKey =
        input.scope === "series" && current.series.rule ? input.occurrenceKey : undefined;

      const anchor = anchorKey
        ? current.exceptions.find((e) => e.recurrenceKey === anchorKey)
        : undefined;

      const anchorStart = anchorKey
        ? (anchor?.start ?? this.timeFromKey(current.series, anchorKey))
        : undefined;

      const duration = calSeriesDuration(current.series);

      const start =
        c.start && anchorStart ? shiftLike(current.series.dtstart, anchorStart, c.start) : c.start;

      const end =
        c.end && anchorStart
          ? shiftLike(current.series.dtend, anchor?.end ?? calEndFor(anchorStart, duration), c.end)
          : c.end;

      // `null` (or an empty rule) removes the recurrence; `undefined` keeps it.
      const seriesChanges = {
        start,
        end,
        rule: c.rrule === null || c.rrule === "" ? null : this.parseRule(c.rrule),
        data: c.data,
      };

      if (input.scope === "this") {
        // One occurrence: an override keyed by its original start (RECURRENCE-ID).
        const key = this.requireKey(input.occurrenceKey);
        const original = this.timeFromKey(current.series, key);
        const prior = current.exceptions.find((e) => e.recurrenceKey === key);

        const exception: CalException = {
          recurrenceKey: key,
          cancelled: false,
          start: c.start ?? prior?.start,
          end: c.end ?? prior?.end,
          data: { ...prior?.data, ...c.data },
        };

        const next = {
          ...current,
          ...personal,
          sequence,
          exceptions: [...current.exceptions.filter((e) => e.recurrenceKey !== key), exception],
        };

        const { revision } = this.writeEvent(next, false);

        if (weAreOrganizer && significant) {
          const start = exception.start ?? original;
          const end = exception.end ?? calEndFor(start, calSeriesDuration(current.series));

          const occurrence: CalSeries = {
            ...current.series,
            dtstart: start,
            dtend: end,
            rule: undefined,
            rdates: [],
            exdates: [],
            data: { ...current.series.data, ...exception.data },
          };

          this.itipRequest(current.id, { ...next, series: occurrence }, { recurrenceId: original });
        }

        return { eventId: current.id, revision };
      }

      if (input.scope === "future") {
        // Split at the occurrence: the head keeps the UID, the tail becomes a new linked series.
        const key = this.requireKey(input.occurrenceKey);
        const newId = this.clock.id("evt");

        const split = calSplitSeries(
          current.series,
          current.exceptions,
          { key, start: this.timeFromKey(current.series, key) },
          `${newId}@bye.calendar`,
        );

        this.sql.run(
          "INSERT INTO cal_series_links (original_uid, new_uid, split_key, created_at) VALUES (?, ?, ?, ?)",
          split.mapping.originalUid,
          split.mapping.newUid,
          split.mapping.splitKey,
          this.clock.now(),
        );

        const tail = {
          ...current,
          ...personal,
          id: newId,
          uid: split.mapping.newUid,
          series: calApplySeriesChanges(split.tail, seriesChanges),
          exceptions: c.start ? [] : split.tailExceptions,
          attendees,
          organizer,
          weAreOrganizer,
          sequence: 0,
        };

        this.writeEvent(tail, true);
        let revision = current.revision;

        if (split.head) {
          const head = {
            ...current,
            series: split.head,
            exceptions: split.headExceptions,
            sequence: weAreOrganizer ? current.sequence + 1 : current.sequence,
          };

          revision = this.writeEvent(head, false).revision;

          if (weAreOrganizer) this.itipRequest(current.id, head);
        } else {
          this.removeEventRow(current.id);
        }

        if (weAreOrganizer) this.itipRequest(newId, tail);

        return { eventId: current.id, revision, splitEventId: newId };
      }

      // The whole series. Moving its start or rule invalidates occurrence keys: overrides are dropped.
      const exceptions = c.start || c.rrule !== undefined ? [] : current.exceptions;

      const next = {
        ...current,
        ...personal,
        series: calApplySeriesChanges(current.series, seriesChanges),
        exceptions,
        attendees,
        organizer: weAreOrganizer ? organizer : current.organizer,
        weAreOrganizer,
        sequence,
      };

      const { revision } = this.writeEvent(next, false);

      if (weAreOrganizer && significant) {
        this.itipRequest(current.id, next);

        if (removed.length) this.itipCancel(current.id, { ...next, attendees: removed });
      }

      return { eventId: current.id, revision };
    });
  }

  deleteEvent(input: {
    commandId: string;
    actor: string;
    eventId: string;
    scope: CalendarEditScope;
    occurrenceKey?: string;
  }): { deleted: boolean } {
    return this.command(input.commandId, "DeleteEvent", () => {
      const row = this.eventRow(input.eventId);

      if (!row) return { deleted: false };
      this.writableCalendar(row.calendar_id);
      const current = this.toRecord(row);
      const organizerView = current.weAreOrganizer;

      // Deleting an invitation the owner organizes mails a CANCEL from the owner's address.
      if (organizerView && current.attendees.length > 0 && !this.isOwner(input.actor))
        throw calendarError("forbidden", "only the calendar owner can cancel an invitation");
      const bumped = organizerView ? current.sequence + 1 : current.sequence;

      if (input.scope === "series" || !current.series.rule) {
        this.removeEventRow(current.id);

        if (organizerView) this.itipCancel(current.id, { ...current, sequence: bumped });

        return { deleted: true };
      }

      const key = this.requireKey(input.occurrenceKey);

      if (input.scope === "this") {
        this.writeEvent(
          {
            ...current,
            exceptions: [
              ...current.exceptions.filter((e) => e.recurrenceKey !== key),
              { recurrenceKey: key, cancelled: true },
            ],
            sequence: bumped,
          },
          false,
        );

        if (organizerView)
          this.itipCancel(current.id, current, {
            recurrenceId: this.timeFromKey(current.series, key),
            sequence: bumped,
          });

        return { deleted: true };
      }

      const split = calSplitSeries(
        current.series,
        current.exceptions,
        { key, start: this.timeFromKey(current.series, key) },
        `${current.uid}-cut`,
      );

      if (!split.head) this.removeEventRow(current.id);
      else
        this.writeEvent(
          { ...current, series: split.head, exceptions: split.headExceptions, sequence: bumped },
          false,
        );

      if (organizerView)
        this.itipRequest(current.id, {
          ...current,
          series: split.head ?? current.series,
          sequence: bumped,
        });

      return { deleted: true };
    });
  }

  /** Invitees make the owner's address send mail: owner-only, and bounded. */
  private checkInvitees(actor: string, count: number): void {
    if (count === 0) return;

    if (!this.isOwner(actor))
      throw calendarError("forbidden", "only the calendar owner can invite attendees");

    if (count > MAX_CALENDAR_ATTENDEES)
      throw calendarError("bad_request", `at most ${MAX_CALENDAR_ATTENDEES} attendees`);
  }

  private requireKey(occurrenceKey: string | undefined): string {
    if (!occurrenceKey) throw calendarError("bad_request", "occurrenceKey required");

    return occurrenceKey;
  }

  // ---------------------------------------------------------------- occurrences

  /** Occurrences overlapping a bounded window across calendars the actor can read. */
  listOccurrences(input: {
    actor: string;
    from: number;
    to: number;
    viewerZone?: string | undefined;
    calendarIds?: ReadonlyArray<string> | undefined;
    visibleOnly?: boolean | undefined;
  }): Array<CalendarOccurrenceView> {
    if (input.to <= input.from || input.to - input.from > MAX_WINDOW_MS)
      throw calendarError("bad_request", "window must be positive and at most 400 days");
    this.validateZone(input.viewerZone);

    const calendars = this.listCalendars(input.actor).filter(
      (c) =>
        (!input.calendarIds || input.calendarIds.includes(c.id)) &&
        (!input.visibleOnly || c.visible),
    );

    if (calendars.length === 0) return [];

    const rows = this.sql.all<EventRow>(
      "SELECT * FROM cal_events WHERE calendar_id IN (SELECT value FROM json_each(?)) AND deleted = 0 AND range_start < ? AND (range_end IS NULL OR range_end > ?)",
      JSON.stringify(calendars.map((c) => c.id)),
      input.to,
      input.from,
    );

    const viewerZone = input.viewerZone ?? this.zone;
    const records = this.toRecords(rows);
    // Invitation state is the owner's own business: shared readers see the event, not the answer.
    const self = new Set(this.self);

    const invited = new Map(
      this.isOwner(input.actor)
        ? records.flatMap((r) => {
            const me = this.invitedAs(r, self);

            return me ? [[r.id, me] as const] : [];
          })
        : [],
    );

    const answers = this.occurrenceResponses([...invited.keys()]);

    return records
      .flatMap((record) => {
        const me = invited.get(record.id);

        return calExpandSeries(record.series, record.exceptions, {
          from: input.from,
          to: input.to,
          viewerZone,
        }).map((o) => {
          const base = {
            ...o,
            eventId: record.id,
            calendarId: record.calendarId,
            highlight: record.highlight,
            countdown: record.countdown,
            revision: record.revision,
          };

          if (!me) return base;

          return {
            ...base,
            invitation: {
              organizer: record.organizer!,
              partstat: answers.get(`${record.id}\u0000${o.key}`) ?? me.partstat,
            },
          };
        });
      })
      .sort((a, b) => a.startMs - b.startMs || a.eventId.localeCompare(b.eventId));
  }

  // ---------------------------------------------------------------- invitation state (C04)

  /**
   * The owner's attendee entry when someone else organizes this event, else undefined. Pass
   * `self` when checking many events, so the owner's addresses are normalized once.
   */
  protected invitedAs(
    record: CalendarEventRecord,
    self: ReadonlySet<string> = new Set(this.self),
  ): CalAttendee | undefined {
    if (record.weAreOrganizer || !record.organizer) return undefined;

    return record.attendees.find((a) => self.has(a.address));
  }

  /** Per-occurrence answers for these events, keyed `eventId\0occurrenceKey`. */
  protected occurrenceResponses(eventIds: ReadonlyArray<string>): Map<string, CalPartstat> {
    if (eventIds.length === 0) return new Map();

    return new Map(
      this.sql
        .all<{ event_id: string; occurrence_key: string; partstat: CalPartstat }>(
          "SELECT event_id, occurrence_key, partstat FROM cal_occurrence_responses WHERE event_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(eventIds),
        )
        .map((r) => [`${r.event_id}\u0000${r.occurrence_key}`, r.partstat]),
    );
  }

  // ---------------------------------------------------------------- reminders and jobs

  /**
   * Persist the event's next due reminder. When none falls inside the lookahead horizon but the
   * series continues past it, a recheck job is parked at the horizon instead, so far-future
   * occurrences still get their reminders.
   */
  protected scheduleReminder(eventId: string, after?: number): void {
    const row = this.eventRow(eventId);
    const record = row ? this.toRecord(row) : undefined;

    if (!record || record.series.data.status === "cancelled") {
      this.kernel.cancelJob(REMINDER_JOB, eventId);

      return;
    }

    const from = after ?? this.clock.now();
    const args = [record.series, record.exceptions, record.alarms, from, this.zone] as const;
    const next = calNextReminder(eventId, record.generation, ...args);

    if (next) {
      this.kernel.schedule(REMINDER_JOB, eventId, next.dueAt, { ...next });

      return;
    }

    const recheckAt = calReminderRecheckAt(...args);

    if (recheckAt !== undefined)
      this.kernel.schedule(REMINDER_JOB, eventId, recheckAt, {
        eventId,
        recheck: true,
        generation: record.generation,
        dueAt: recheckAt,
      });
    else this.kernel.cancelJob(REMINDER_JOB, eventId);
  }

  /**
   * Alarm handler body: drain a bounded batch of due jobs, revalidating generations, and
   * return the next wake-up. Notifications leave through the outbox.
   */
  runDueJobs(limit = 100): CalendarDueJobs {
    const now = this.clock.now();
    const fired: Array<CalendarFiredReminder> = [];
    const refreshes: Array<string> = [];

    for (const job of this.kernel.dueJobs(now, limit)) {
      this.sql.tx(() => {
        if (!this.kernel.completeJob(job)) return;

        if (job.kind === REMINDER_JOB) {
          const payload = job.payload as {
            eventId: string;
            occurrenceKey: string;
            offsetMinutes: number;
            generation: number;
            dueAt: number;
            recheck?: boolean;
          };

          const row = this.eventRow(payload.eventId);

          if (!row || Number(row.generation) !== payload.generation) return;

          if (payload.recheck) {
            // Horizon reached with nothing due yet: look ahead again from here.
            this.scheduleReminder(payload.eventId, payload.dueAt);

            return;
          }

          const series = JSON.parse(row.series) as CalSeries;
          this.kernel.emit("calendar.notify", this.config.ownerId, {
            kind: "reminder",
            eventId: payload.eventId,
            occurrenceKey: payload.occurrenceKey,
            offsetMinutes: payload.offsetMinutes,
            title: series.data.summary,
            startMs: payload.dueAt + payload.offsetMinutes * 60_000,
          });
          fired.push({
            eventId: payload.eventId,
            occurrenceKey: payload.occurrenceKey,
            offsetMinutes: payload.offsetMinutes,
          });
          this.scheduleReminder(payload.eventId, payload.dueAt);
        } else if (job.kind === SUBSCRIPTION_JOB) {
          this.kernel.emit("calendar.subscription.refresh", job.key, { calendarId: job.key });
          refreshes.push(job.key);
        }
      });
    }

    return { fired, refreshes, nextAlarm: this.kernel.nextDueAt() };
  }
}

/** The epoch-ms window an event series can occupy (`end` null: unbounded). */
export interface CalendarEventRange {
  start: number;
  end: number | null;
}

/** Revision and generation stamps of a written event. */
export interface CalendarEventRevision {
  revision: number;
  generation: number;
}

/** A fired reminder. */
export interface CalendarFiredReminder {
  eventId: string;
  occurrenceKey: string;
  offsetMinutes: number;
}

/** What one pass over the due jobs produced. */
export interface CalendarDueJobs {
  fired: Array<CalendarFiredReminder>;
  refreshes: Array<string>;
  nextAlarm: number | null;
}
