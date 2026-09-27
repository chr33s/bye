import {
  type CalException,
  type CalIcsEvent,
  calInterpretItip,
  type CalKnownInvitation,
  calNormAddress,
  type CalPartstat,
  calParseCalendar,
  calRecurrenceKey,
  type CalSeries,
  type CalTime,
} from "@bye/calendar-engine";
import { bool } from "../durable/sql.ts";
import { CalendarCalendars } from "./calendars.ts";
import {
  calendarError,
  type CalendarInvitationResult,
  type CalendarMessageRef,
  type EventRow,
  REMINDER_JOB,
} from "./types.ts";

// Inbound iTIP (C04): invitations, updates, cancellations and attendee replies carried by mail,
// plus our own responses. Screened-out mail never reaches the calendar: the mailbox emits the
// `calendar.invitation` topic only for approved deliveries (§9), so there is no suppressed mode here.

export abstract class CalendarInvitations extends CalendarCalendars {
  /**
   * The live event an iTIP message for `uid` may address. Read-only subscription copies are never
   * a target (a feed's events are not invitations, and iTIP must not mutate them).
   */
  private invitationRow(uid: string): EventRow | undefined {
    return this.sql.one<EventRow>(
      `SELECT e.* FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id
       WHERE e.uid = ? AND e.deleted = 0 AND c.deleted = 0 AND c.kind != 'subscription'
       ORDER BY e.created_at LIMIT 1`,
      uid,
    );
  }

  private knownInvitation(
    uid: string,
    recurrenceKey: string,
  ): { known: CalKnownInvitation | undefined; row: EventRow | undefined } {
    const row = this.invitationRow(uid);
    const revision = (key: string) => {
      const r = this.sql.one<{ sequence: number; dtstamp: number | null }>(
        "SELECT sequence, dtstamp FROM cal_invitation_revisions WHERE uid = ? AND recurrence_key = ?",
        uid,
        key,
      );
      return r ? { sequence: Number(r.sequence), dtstamp: r.dtstamp ?? undefined } : undefined;
    };
    const rev = revision(recurrenceKey);
    const seriesRev = revision("");
    const attendeeRevisions: Record<string, { sequence: number; dtstamp: number | undefined }> = {};
    for (const a of this.sql.all<{ address: string; sequence: number; dtstamp: number | null }>(
      "SELECT address, sequence, dtstamp FROM cal_attendee_revisions WHERE uid = ?",
      uid,
    )) {
      attendeeRevisions[a.address] = {
        sequence: Number(a.sequence),
        dtstamp: a.dtstamp ?? undefined,
      };
    }
    if (!row && !rev && !seriesRev) return { known: undefined, row: undefined };
    const record = row ? this.toRecord(row) : undefined;
    return {
      row,
      known: {
        organizer: record?.organizer?.address,
        weAreOrganizer: record?.weAreOrganizer ?? false,
        // An organizer-less row was created here, not received: iTIP can never claim it by UID.
        localEvent: record !== undefined && !record.organizer,
        revision: rev,
        seriesRevision: seriesRev,
        attendeeRevisions,
      },
    };
  }

  /** Apply an iTIP message carried by an email. `ingestionId` makes redelivery idempotent. */
  receiveInvitation(input: {
    ingestionId: string;
    ics: string;
    sender: string;
    sourceRef?: CalendarMessageRef | undefined;
  }): Array<CalendarInvitationResult> {
    return this.command(input.ingestionId, "ReceiveInvitation", () => {
      let parsed;
      try {
        parsed = calParseCalendar(input.ics, { defaultZone: this.zone, maxItems: 200 });
      } catch (error) {
        return [
          {
            _tag: "Invalid",
            reason: error instanceof Error ? error.message : "invalid calendar",
          } as const,
        ];
      }
      const results: Array<CalendarInvitationResult> = [];
      // Series first, then per-occurrence overrides, so overrides attach to the series row.
      const events = [...parsed.events].sort(
        (a, b) => (a.recurrenceId ? 1 : 0) - (b.recurrenceId ? 1 : 0),
      );
      for (let event of events) {
        // RECURRENCE-IDs may be sent in UTC or another zone; key them in the stored series' zone
        // so they address the same occurrence the series expands to.
        let seriesStart = event.recurrenceId ? this.seriesStartFor(event.uid) : undefined;
        let recurrenceKey = event.recurrenceId
          ? calRecurrenceKey(event.recurrenceId, seriesStart)
          : "";
        // A "this and future" split moved later occurrences to a new UID (§9): route overrides for
        // those occurrences to the tail series so updates and replies keep applying.
        const targetUid = this.resolveSplitUid(event.uid, recurrenceKey);
        if (targetUid !== event.uid) {
          event = { ...event, uid: targetUid };
          seriesStart = this.seriesStartFor(targetUid) ?? seriesStart;
          recurrenceKey = calRecurrenceKey(event.recurrenceId!, seriesStart);
        }
        const { known, row } = this.knownInvitation(event.uid, recurrenceKey);
        const decision = calInterpretItip({
          method: parsed.method,
          event,
          sender: input.sender,
          self: this.self,
          known,
          seriesStart,
        });
        if (decision._tag !== "Apply") {
          results.push(decision);
          continue;
        }
        const eventId = this.applyInvitation(
          decision.action,
          event,
          recurrenceKey,
          row,
          input.sourceRef,
        );
        if (decision.action === "reply") {
          // A series-level attendee REPLY also applies to every tail series split from it.
          if (!recurrenceKey) {
            for (const link of this.sql.all<{ new_uid: string }>(
              "SELECT new_uid FROM cal_series_links WHERE original_uid = ?",
              event.uid,
            )) {
              const tail = this.invitationRow(link.new_uid);
              if (tail)
                this.applyInvitation(
                  "reply",
                  { ...event, uid: link.new_uid },
                  "",
                  tail,
                  input.sourceRef,
                );
            }
          }
          this.sql.run(
            `INSERT INTO cal_attendee_revisions (uid, address, sequence, dtstamp) VALUES (?, ?, ?, ?)
             ON CONFLICT (uid, address) DO UPDATE SET sequence = excluded.sequence, dtstamp = excluded.dtstamp`,
            event.uid,
            calNormAddress(event.attendees[0]!.address),
            event.sequence,
            event.dtstamp ?? null,
          );
        } else {
          this.sql.run(
            `INSERT INTO cal_invitation_revisions (uid, recurrence_key, sequence, dtstamp, method, received_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (uid, recurrence_key) DO UPDATE SET sequence = excluded.sequence, dtstamp = excluded.dtstamp, method = excluded.method, received_at = excluded.received_at`,
            event.uid,
            recurrenceKey,
            event.sequence,
            event.dtstamp ?? null,
            parsed.method ?? "",
            this.clock.now(),
          );
        }
        if (eventId)
          this.kernel.emit("calendar.notify", this.config.ownerId, {
            kind: `invitation.${decision.action}`,
            eventId,
            title: event.series.data.summary,
          });
        results.push({ ...decision, eventId });
      }
      return results;
    });
  }

  private applyInvitation(
    action: "create" | "update" | "cancel" | "reply",
    event: CalIcsEvent,
    recurrenceKey: string,
    row: EventRow | undefined,
    sourceRef: CalendarMessageRef | undefined,
  ): string | undefined {
    const record = row ? this.toRecord(row) : undefined;
    if (action === "reply") {
      if (!record) return undefined;
      const reply = calNormAddress(event.attendees[0]!.address);
      if (!record.attendees.some((a) => a.address === reply)) return undefined;
      this.writeEvent(
        {
          ...record,
          attendees: record.attendees.map((a) =>
            a.address === reply ? { ...a, partstat: event.attendees[0]!.partstat } : a,
          ),
        },
        false,
      );
      return record.id;
    }
    if (action === "cancel") {
      if (!record) return undefined;
      if (recurrenceKey) {
        this.writeEvent(
          {
            ...record,
            exceptions: [
              ...record.exceptions.filter((e) => e.recurrenceKey !== recurrenceKey),
              { recurrenceKey, cancelled: true },
            ],
            sequence: event.sequence,
          },
          false,
        );
      } else {
        this.writeEvent(
          {
            ...record,
            series: { ...record.series, data: { ...record.series.data, status: "cancelled" } },
            sequence: event.sequence,
          },
          false,
        );
        this.kernel.cancelJob(REMINDER_JOB, record.id);
      }
      return record.id;
    }
    if (recurrenceKey) {
      if (!record) return undefined; // Occurrence update for an unknown series: wait for the series.
      const exception: CalException = {
        recurrenceKey,
        cancelled: event.series.data.status === "cancelled",
        start: event.series.dtstart,
        end: event.series.dtend,
        data: event.series.data,
      };
      this.writeEvent(
        {
          ...record,
          exceptions: [
            ...record.exceptions.filter((e) => e.recurrenceKey !== recurrenceKey),
            exception,
          ],
        },
        false,
      );
      return record.id;
    }
    if (record) {
      // Preserve our own response unless the organizer changed timing (a new request needs a new answer).
      const timingChanged =
        JSON.stringify([record.series.dtstart, record.series.dtend, record.series.rule]) !==
        JSON.stringify([event.series.dtstart, event.series.dtend, event.series.rule]);
      const attendees = event.attendees.map((a) => {
        const address = calNormAddress(a.address);
        const prior = record.attendees.find((p) => p.address === address);
        return this.self.includes(address) && prior && !timingChanged
          ? { ...a, address, partstat: prior.partstat }
          : { ...a, address };
      });
      this.writeEvent(
        {
          ...record,
          series: event.series,
          attendees,
          organizer: event.organizer,
          sequence: event.sequence,
        },
        false,
      );
      return record.id;
    }
    const id = this.clock.id("evt");
    this.writeEvent(
      {
        id,
        calendarId: this.ensureInvitationsCalendar(),
        uid: event.uid,
        series: event.series,
        exceptions: [],
        organizer: event.organizer,
        weAreOrganizer: false,
        attendees: event.attendees.map((a) => ({ ...a, address: calNormAddress(a.address) })),
        alarms: event.alarms,
        sequence: event.sequence,
        highlight: false,
        countdown: false,
        privateNote: undefined,
        sourceRef,
      },
      true,
    );
    return id;
  }

  /** Accept/tentative/decline: updates our attendee status and emits a real iTIP REPLY. */
  respondToInvitation(input: {
    commandId: string;
    actor: string;
    eventId: string;
    partstat: Exclude<CalPartstat, "DELEGATED" | "NEEDS-ACTION">;
    occurrenceKey?: string;
  }): { revision: number } {
    return this.command(input.commandId, "RespondInvitation", () => {
      const row = this.eventRow(input.eventId);
      if (!row) throw calendarError("not_found", "event not found");
      const record = this.toRecord(row);
      if (record.weAreOrganizer || !record.organizer)
        throw calendarError("bad_request", "not an invitation");
      const me = record.attendees.find((a) => this.self.includes(a.address));
      if (!me) throw calendarError("forbidden", "this account is not an attendee");
      const attendees = input.occurrenceKey
        ? record.attendees
        : record.attendees.map((a) => (a === me ? { ...a, partstat: input.partstat } : a));
      const { revision } = this.writeEvent({ ...record, attendees }, false);
      this.itipReply(
        record.id,
        record,
        me.address,
        input.partstat,
        input.occurrenceKey
          ? { recurrenceId: this.timeFromKey(record.series, input.occurrenceKey) }
          : {},
      );
      return { revision };
    });
  }

  /** DTSTART of the stored series for a UID (following split links when the original is gone). */
  private seriesStartFor(uid: string): CalTime | undefined {
    let current = uid;
    for (let depth = 0; depth < 16; depth++) {
      const row = this.sql.one<{ series: string }>(
        "SELECT series FROM cal_events WHERE uid = ? AND deleted = 0 ORDER BY created_at LIMIT 1",
        current,
      );
      if (row) return (JSON.parse(row.series) as CalSeries).dtstart;
      const link = this.sql.one<{ new_uid: string }>(
        "SELECT new_uid FROM cal_series_links WHERE original_uid = ? ORDER BY split_key LIMIT 1",
        current,
      );
      if (!link) return undefined;
      current = link.new_uid;
    }
    return undefined;
  }

  /** Follow "this and future" split links for an occurrence key (keys sort chronologically). */
  private resolveSplitUid(uid: string, recurrenceKey: string): string {
    if (!recurrenceKey) return uid;
    let current = uid;
    for (let depth = 0; depth < 16; depth++) {
      const link = this.sql.one<{ new_uid: string }>(
        "SELECT new_uid FROM cal_series_links WHERE original_uid = ? AND split_key <= ? ORDER BY split_key DESC LIMIT 1",
        current,
        recurrenceKey,
      );
      if (!link) return current;
      current = link.new_uid;
    }
    return current;
  }

  /**
   * Whether this account organizes the event with this UID (directly or via a split). The mailbox
   * uses it (a direct DO call, not a public read) to let attendee REPLYs for our own invitations
   * bypass the Screener (C04).
   */
  isOrganizerOf(uid: string): boolean {
    const direct = this.invitationRow(uid);
    if (direct) return bool(direct.we_are_organizer);
    const linked = this.sql.one<{ new_uid: string }>(
      "SELECT new_uid FROM cal_series_links WHERE original_uid = ? LIMIT 1",
      uid,
    );
    return linked ? this.isOrganizerOf(linked.new_uid) : false;
  }
}
