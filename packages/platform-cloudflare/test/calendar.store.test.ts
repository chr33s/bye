import { describe, expect, it } from "vitest";
import {
  calParseCalendar,
  calParseDate,
  calTimed,
  calAllDay,
  calBuildRequest,
  calBuildReply,
  type CalIcsEvent,
} from "@bye/calendar-engine";
import {
  calendarExecute,
  calendarRead,
  CalendarStoreError,
  calendarValidateFeedUrl,
} from "@bye/platform-cloudflare";
import { makeTestCalendarStore } from "@bye/testing";

const dt = (s: string) => {
  const [d, t = "00:00"] = s.split("T");
  const [year, month, day] = d!.split("-").map(Number);
  const [hour, minute] = t.split(":").map(Number);
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: 0 };
};
const utc = (s: string) => Date.parse(`${s}Z`);
const START = utc("2026-09-25T12:00:00");
const GUEST = "usr_guest0000000000000000";

const setup = () => {
  const ctx = makeTestCalendarStore({}, START);
  const { calendarId } = ctx.store.createCalendar({
    commandId: ctx.cmd(),
    actor: ctx.owner,
    name: "Personal",
    color: "#f00",
  });
  return { ...ctx, calendarId };
};

const outboxOf = (store: ReturnType<typeof setup>["store"], topic: string) =>
  store.kernel
    .pendingOutbox(1000)
    .filter((e) => e.topic === topic)
    .map(
      (e) =>
        e.payload as { method?: string; ics?: string; recipients?: Array<string>; kind?: string },
    );

const invitation = (sequence: number, dtstamp: number, extra: Partial<CalIcsEvent> = {}): string =>
  calBuildRequest(
    {
      uid: "remote-1@example.com",
      sequence,
      dtstamp,
      series: {
        uid: "remote-1@example.com",
        dtstart: calTimed(dt("2026-10-01T15:00"), "America/New_York"),
        dtend: calTimed(dt("2026-10-01T16:00"), "America/New_York"),
        data: { summary: `Review v${sequence}` },
      },
      organizer: { address: "boss@example.com" },
      attendees: [{ address: "me@bye.test", partstat: "NEEDS-ACTION", rsvp: true }],
      alarms: [],
      ...extra,
    },
    dtstamp,
  ).ics;

describe("CalendarStore events", () => {
  it("[C02] creates recurring events with exceptions, highlights and countdowns", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-28T09:00"), "Europe/London"),
        end: calTimed(dt("2026-09-28T09:30"), "Europe/London"),
        rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
        data: { summary: "Gym", location: "Club" },
      },
      highlight: true,
      countdown: true,
      alarms: [10, 60],
    });
    const occ = store.listOccurrences({
      actor: owner,
      from: utc("2026-09-28T00:00:00"),
      to: utc("2026-10-06T00:00:00"),
    });
    expect(occ.map((o) => o.key)).toEqual([
      "20260928T090000",
      "20260930T090000",
      "20261005T090000",
    ]);
    expect(occ.every((o) => o.highlight && o.countdown && o.eventId === eventId)).toBe(true);
    expect(() =>
      store.listOccurrences({ actor: owner, from: 0, to: utc("2030-01-01T00:00:00") }),
    ).toThrow(CalendarStoreError);
    const multi = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calAllDay(calParseDate("2026-10-10")),
        end: calAllDay(calParseDate("2026-10-13")),
        data: { summary: "Trip" },
      },
    });
    const trip = store
      .listOccurrences({
        actor: owner,
        from: utc("2026-10-11T00:00:00"),
        to: utc("2026-10-12T00:00:00"),
      })
      .find((o) => o.eventId === multi.eventId);
    expect(trip?.allDay).toBe(true);
  });

  it("[C03] edits one occurrence, future occurrences, or the series", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-28T10:00"), "America/New_York"),
        end: calTimed(dt("2026-09-28T11:00"), "America/New_York"),
        rrule: "FREQ=DAILY;COUNT=10",
        data: { summary: "Daily" },
      },
    });
    let rev = store.getEvent(owner, eventId).revision;
    rev = store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: rev,
      scope: "this",
      occurrenceKey: "20260929T100000",
      changes: { data: { summary: "Special" } },
    }).revision;
    expect(() =>
      store.updateEvent({
        commandId: cmd(),
        actor: owner,
        eventId,
        expectedRevision: rev - 1,
        scope: "series",
        changes: { data: { summary: "x" } },
      }),
    ).toThrow(/revision/);
    const split = store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: rev,
      scope: "future",
      occurrenceKey: "20261003T100000",
      changes: { start: calTimed(dt("2026-10-03T14:00"), "America/New_York") },
    });
    expect(split.splitEventId).toBeDefined();
    const occ = store.listOccurrences({
      actor: owner,
      from: utc("2026-09-28T00:00:00"),
      to: utc("2026-10-20T00:00:00"),
      viewerZone: "America/New_York",
    });
    expect(occ).toHaveLength(10);
    expect(occ.filter((o) => o.eventId === eventId)).toHaveLength(5);
    expect(occ.find((o) => o.key === "20260929T100000")?.data.summary).toBe("Special");
    expect(
      occ
        .filter((o) => o.eventId === split.splitEventId)
        .every((o) => o.start.kind === "timed" && o.start.local.hour === 14),
    ).toBe(true);
    const link = store.sql.one<{ original_uid: string; split_key: string }>(
      "SELECT original_uid, split_key FROM cal_series_links",
    );
    expect(link).toEqual({
      original_uid: store.getEvent(owner, eventId).uid,
      split_key: "20261003T100000",
    });
    // Series-scope edit and occurrence delete.
    const head = store.getEvent(owner, eventId);
    store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: head.revision,
      scope: "series",
      changes: { data: { location: "Room 2" } },
    });
    store.deleteEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      scope: "this",
      occurrenceKey: "20260930T100000",
    });
    expect(
      store
        .listOccurrences({
          actor: owner,
          from: utc("2026-09-28T00:00:00"),
          to: utc("2026-10-03T00:00:00"),
        })
        .filter((o) => o.eventId === eventId),
    ).toHaveLength(4);
  });

  it("[C02] schedules multiple reminders and invalidates obsolete jobs on edit", () => {
    const { store, cmd, owner, calendarId, clock } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-25T14:00"), "UTC"),
        end: calTimed(dt("2026-09-25T15:00"), "UTC"),
        data: { summary: "Call" },
      },
      alarms: [60, 10],
    });
    const first = store.kernel.job("reminder", eventId)!;
    expect(first.dueAt).toBe(utc("2026-09-25T13:00:00"));
    // Edit moves the event: the old due job must not fire at the old time.
    const rev = store.getEvent(owner, eventId).revision;
    store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: rev,
      scope: "series",
      changes: { start: calTimed(dt("2026-09-25T18:00"), "UTC") },
    });
    clock.advance(3_600_000 + 1);
    expect(store.runDueJobs().fired).toEqual([]);
    expect(store.kernel.completeJob(first)).toBe(false);
    clock.current = utc("2026-09-25T17:00:00");
    expect(store.runDueJobs().fired).toEqual([
      { eventId, occurrenceKey: "20260925T180000", offsetMinutes: 60 },
    ]);
    clock.current = utc("2026-09-25T17:50:00");
    const second = store.runDueJobs();
    expect(second.fired.map((f) => f.offsetMinutes)).toEqual([10]);
    expect(second.nextAlarm).toBeNull();
    expect(outboxOf(store, "calendar.notify").filter((p) => p.kind === "reminder")).toHaveLength(2);
    // Cancellation removes pending reminders.
    const other = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-26T09:00"), "UTC"),
        end: calTimed(dt("2026-09-26T10:00"), "UTC"),
        data: { summary: "x" },
      },
      alarms: [5],
    });
    store.deleteEvent({ commandId: cmd(), actor: owner, eventId: other.eventId, scope: "series" });
    expect(store.kernel.job("reminder", other.eventId)).toBeUndefined();
  });

  it("[C01] remembers navigation and view preferences", () => {
    const { store, cmd, owner } = setup();
    expect(store.preferences()).toMatchObject({
      firstWeekday: 1,
      hour12: false,
      lastView: "day",
      timeZone: "UTC",
    });
    store.setPreferences({
      commandId: cmd(),
      actor: owner,
      preferences: {
        lastView: "year",
        lastDate: "2026-12-01",
        firstWeekday: 0,
        hour12: true,
        nightHoursCollapsed: false,
      },
    });
    expect(store.preferences()).toMatchObject({
      lastView: "year",
      lastDate: "2026-12-01",
      firstWeekday: 0,
      hour12: true,
      nightHoursCollapsed: false,
    });
    expect(() =>
      store.setPreferences({ commandId: cmd(), actor: owner, preferences: { firstWeekday: 9 } }),
    ).toThrow(CalendarStoreError);
  });
});

describe("CalendarStore invitations", () => {
  it("[C04] creates, updates, deduplicates and cancels invitations; ignores out-of-order revisions", () => {
    const { store, owner } = setup();
    const [created] = store.receiveInvitation({
      ingestionId: "ing_1",
      ics: invitation(1, 1000),
      sender: "boss@example.com",
    });
    expect(created).toMatchObject({ _tag: "Apply", action: "create" });
    const eventId = (created as { eventId: string }).eventId;
    // Redelivery of the same ingestion is a replay, not a second event.
    expect(
      store.receiveInvitation({
        ingestionId: "ing_1",
        ics: invitation(1, 1000),
        sender: "boss@example.com",
      }),
    ).toEqual([created]);
    expect(
      store.receiveInvitation({
        ingestionId: "ing_2",
        ics: invitation(1, 1000),
        sender: "boss@example.com",
      })[0]!._tag,
    ).toBe("Duplicate");
    expect(
      store.receiveInvitation({
        ingestionId: "ing_3",
        ics: invitation(3, 3000),
        sender: "boss@example.com",
      })[0],
    ).toMatchObject({ _tag: "Apply", action: "update" });
    // Older update arriving late is ignored.
    expect(
      store.receiveInvitation({
        ingestionId: "ing_4",
        ics: invitation(2, 2000),
        sender: "boss@example.com",
      })[0]!._tag,
    ).toBe("IgnoreStale");
    expect(store.getEvent(owner, eventId).series.data.summary).toBe("Review v3");
    const cancel = invitation(4, 4000).replace("METHOD:REQUEST", "METHOD:CANCEL");
    expect(
      store.receiveInvitation({ ingestionId: "ing_5", ics: cancel, sender: "boss@example.com" })[0],
    ).toMatchObject({ _tag: "Apply", action: "cancel" });
    expect(store.getEvent(owner, eventId).series.data.status).toBe("cancelled");
    expect(store.listCalendars(owner).some((c) => c.kind === "invitations")).toBe(true);
  });

  it("[C04] rejects unauthorized organizers", () => {
    const { store, owner } = setup();
    store.receiveInvitation({
      ingestionId: "ing_1",
      ics: invitation(1, 1000),
      sender: "boss@example.com",
    });
    const hijack = invitation(9, 9000, { organizer: { address: "mallory@evil.test" } });
    expect(
      store.receiveInvitation({
        ingestionId: "ing_2",
        ics: hijack,
        sender: "mallory@evil.test",
      })[0],
    ).toMatchObject({ _tag: "Unauthorized" });
    expect(
      store.receiveInvitation({
        ingestionId: "ing_3",
        ics: invitation(9, 9000),
        sender: "intern@example.com",
      })[0],
    ).toMatchObject({ _tag: "Unauthorized" });
    expect(outboxOf(store, "calendar.notify").every((n) => n.kind !== undefined)).toBe(true);
    expect(
      store.listOccurrences({
        actor: owner,
        from: utc("2026-10-01T00:00:00"),
        to: utc("2026-10-03T00:00:00"),
      }),
    ).toHaveLength(1);
  });

  it("[C04] [C09] accept/tentative/decline emit a real iTIP REPLY to the organizer", () => {
    const { store, cmd, owner } = setup();
    const [r] = store.receiveInvitation({
      ingestionId: "ing_1",
      ics: invitation(1, 1000),
      sender: "boss@example.com",
      sourceRef: { mailboxId: "mbx_1", threadId: "thr_1" },
    });
    const eventId = (r as { eventId: string }).eventId;
    store.respondToInvitation({ commandId: cmd(), actor: owner, eventId, partstat: "TENTATIVE" });
    const [reply] = outboxOf(store, "calendar.itip");
    expect(reply).toMatchObject({ method: "REPLY", recipients: ["boss@example.com"] });
    const parsed = calParseCalendar(reply!.ics!);
    expect(parsed.method).toBe("REPLY");
    expect(parsed.events[0]!.attendees).toEqual([
      expect.objectContaining({ address: "me@bye.test", partstat: "TENTATIVE" }),
    ]);
    expect(store.getEvent(owner, eventId).attendees[0]!.partstat).toBe("TENTATIVE");
    expect(store.getEvent(owner, eventId).sourceRef).toEqual({
      mailboxId: "mbx_1",
      threadId: "thr_1",
    });
    expect(() =>
      store.updateEvent({
        commandId: cmd(),
        actor: owner,
        eventId,
        expectedRevision: store.getEvent(owner, eventId).revision,
        scope: "series",
        changes: { data: { summary: "mine now" } },
      }),
    ).toThrow(/organizer/);
  });

  it("[C04] organizer sends REQUEST/CANCEL and applies attendee replies with ordering", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId, uid } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-10-05T10:00"), "UTC"),
        end: calTimed(dt("2026-10-05T11:00"), "UTC"),
        data: { summary: "Kickoff" },
      },
      attendees: [{ address: "Ann@Example.com", name: "Ann" }, { address: "me@bye.test" }],
    });
    expect(outboxOf(store, "calendar.itip")[0]).toMatchObject({
      method: "REQUEST",
      recipients: ["ann@example.com"],
    });
    const record = store.getEvent(owner, eventId);
    const asIcs: CalIcsEvent = {
      uid,
      sequence: 0,
      dtstamp: 5000,
      series: record.series,
      organizer: record.organizer,
      attendees: record.attendees,
      alarms: [],
    };
    const accept = calBuildReply(asIcs, "ann@example.com", "ACCEPTED", 5000).ics;
    expect(
      store.receiveInvitation({ ingestionId: "ing_r1", ics: accept, sender: "ann@example.com" })[0],
    ).toMatchObject({ _tag: "Apply", action: "reply" });
    const oldDecline = calBuildReply(asIcs, "ann@example.com", "DECLINED", 4000).ics;
    expect(
      store.receiveInvitation({
        ingestionId: "ing_r2",
        ics: oldDecline,
        sender: "ann@example.com",
      })[0]!._tag,
    ).toBe("IgnoreStale");
    expect(
      store.receiveInvitation({ ingestionId: "ing_r3", ics: accept, sender: "eve@example.com" })[0]!
        ._tag,
    ).toBe("Unauthorized");
    expect(store.getEvent(owner, eventId).attendees[0]!.partstat).toBe("ACCEPTED");
    const rev = store.getEvent(owner, eventId).revision;
    store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: rev,
      scope: "series",
      changes: { start: calTimed(dt("2026-10-05T12:00"), "UTC") },
    });
    expect(store.getEvent(owner, eventId).sequence).toBe(1);
    store.deleteEvent({ commandId: cmd(), actor: owner, eventId, scope: "series" });
    expect(outboxOf(store, "calendar.itip").map((m) => m.method)).toEqual([
      "REQUEST",
      "REQUEST",
      "CANCEL",
    ]);
  });
});

describe("CalendarStore sharing, feeds and interoperability", () => {
  it("[C05] shares calendars without leaking private notes, journals or write access", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-26T10:00"), "UTC"),
        end: calTimed(dt("2026-09-26T11:00"), "UTC"),
        data: { summary: "Shared" },
      },
      privateNote: "secret",
    });
    expect(() => store.getEvent(GUEST, eventId)).toThrow(CalendarStoreError);
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "read",
    });
    expect(store.getEvent(GUEST, eventId).privateNote).toBeUndefined();
    expect(store.getEvent(owner, eventId).privateNote).toBe("secret");
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "CreateEvent",
        commandId: cmd(),
        calendarId,
        start: calTimed(dt("2026-09-26T10:00"), "UTC"),
        end: calTimed(dt("2026-09-26T11:00"), "UTC"),
        data: { summary: "x" },
      }),
    ).toThrow(/read-only/);
    expect(() =>
      calendarRead(store, GUEST, { type: "DayContext", date: calParseDate("2026-09-26") }),
    ).toThrow(/owner-only/);
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "GrantCalendar",
        commandId: cmd(),
        calendarId,
        grantee: "usr_x",
        role: "write",
      }),
    ).toThrow(/owner-only/);
    store.revokeCalendar({ commandId: cmd(), actor: owner, calendarId, grantee: GUEST });
    expect(
      store.listOccurrences({ actor: GUEST, from: START, to: START + 86_400_000 * 2 }),
    ).toEqual([]);
  });

  it("[A04] [C05] exports and re-imports ICS without private data", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-10-01T09:00"), "Europe/London"),
        end: calTimed(dt("2026-10-01T10:00"), "Europe/London"),
        rrule: "FREQ=WEEKLY;COUNT=4",
        data: { summary: "Weekly, sync", description: "Agenda; notes" },
      },
      privateNote: "never export me",
      alarms: [15],
    });
    store.updateEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      expectedRevision: 1,
      scope: "this",
      occurrenceKey: "20261008T090000",
      changes: { data: { summary: "Moved sync" } },
    });
    store.deleteEvent({
      commandId: cmd(),
      actor: owner,
      eventId,
      scope: "this",
      occurrenceKey: "20261015T090000",
    });
    const ics = store.exportIcs(owner);
    expect(ics).not.toContain("never export me");
    const target = makeTestCalendarStore({}, START);
    const cal = target.store.createCalendar({
      commandId: target.cmd(),
      actor: target.owner,
      name: "Imported",
      color: "#0f0",
    });
    const result = target.store.importIcs({
      commandId: target.cmd(),
      actor: target.owner,
      calendarId: cal.calendarId,
      ics,
    });
    expect(result).toMatchObject({ imported: 1, updated: 0 });
    const window = { from: utc("2026-09-30T00:00:00"), to: utc("2026-11-01T00:00:00") };
    const a = store
      .listOccurrences({ actor: owner, ...window })
      .map((o) => [o.key, o.data.summary, o.startMs]);
    const b = target.store
      .listOccurrences({ actor: target.owner, ...window })
      .map((o) => [o.key, o.data.summary, o.startMs]);
    expect(b).toEqual(a);
    expect(a).toHaveLength(3);
    // Re-import updates rather than duplicating.
    expect(
      target.store.importIcs({
        commandId: target.cmd(),
        actor: target.owner,
        calendarId: cal.calendarId,
        ics,
      }),
    ).toMatchObject({ imported: 0, updated: 1 });
  });

  it("[C05] validates subscription URLs against SSRF and keeps subscriptions read-only", () => {
    expect(calendarValidateFeedUrl("webcal://calendars.example.com/team.ics")).toBe(
      "https://calendars.example.com/team.ics",
    );
    for (const bad of [
      "http://example.com/a.ics",
      "https://127.0.0.1/a.ics",
      "https://10.1.2.3/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest",
      "https://localhost/x",
      "https://user:pw@example.com/x",
      "https://example.com:8443/x",
      "https://2130706433/x",
      "https://metadata.google.internal/x",
    ]) {
      expect(() => calendarValidateFeedUrl(bad), bad).toThrow(CalendarStoreError);
    }
    const { store, cmd, owner, clock } = setup();
    const { calendarId } = store.addSubscription({
      commandId: cmd(),
      actor: owner,
      name: "Holidays",
      color: "#00f",
      url: "https://calendars.example.com/h.ics",
      itemLimit: 2,
    });
    expect(store.runDueJobs().refreshes).toEqual([calendarId]);
    const feed = [
      "BEGIN:VCALENDAR",
      ...["a", "b", "c"].map(
        (u, i) =>
          `BEGIN:VEVENT\r\nUID:${u}\r\nDTSTART;VALUE=DATE:2026100${i + 1}\r\nSUMMARY:Holiday ${u}\r\nEND:VEVENT`,
      ),
      "END:VCALENDAR",
    ].join("\r\n");
    const applied = store.applySubscriptionFetch({
      calendarId,
      fetchId: "f1",
      status: "ok",
      body: feed,
      etag: '"v1"',
    });
    expect(applied.imported).toBe(2);
    expect(applied.warnings.join()).toContain("first 2");
    expect(store.subscription(calendarId)).toMatchObject({ etag: '"v1"', itemLimit: 2 });
    expect(() =>
      store.createEvent({
        commandId: cmd(),
        actor: owner,
        calendarId,
        series: {
          start: calAllDay(calParseDate("2026-10-09")),
          end: calAllDay(calParseDate("2026-10-10")),
          data: { summary: "x" },
        },
      }),
    ).toThrow(/read-only/);
    // A later fetch without an item removes it; 304 keeps contents.
    const smaller = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART;VALUE=DATE:20261001",
      "SUMMARY:Holiday a",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    store.applySubscriptionFetch({ calendarId, fetchId: "f2", status: "ok", body: smaller });
    store.applySubscriptionFetch({ calendarId, fetchId: "f3", status: "not-modified" });
    expect(
      store
        .listOccurrences({
          actor: owner,
          from: utc("2026-09-30T00:00:00"),
          to: utc("2026-10-10T00:00:00"),
          calendarIds: [calendarId],
        })
        .map((o) => o.data.summary),
    ).toEqual(["Holiday a"]);
    expect(store.kernel.job("subscription", calendarId)!.dueAt).toBe(clock.now() + 3_600_000);
  });

  it("[C05] serves private feeds by hashed token, excluding private data, and honours revocation", () => {
    const { store, cmd, owner, calendarId } = setup();
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-27T10:00"), "UTC"),
        end: calTimed(dt("2026-09-27T11:00"), "UTC"),
        data: { summary: "Dentist" },
      },
      privateNote: "bring x-ray",
      attendees: [{ address: "dr@example.com" }],
    });
    store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("2026-09-27"),
      body: "Dear diary",
      expectedRevision: 0,
    });
    store.createFeedToken({
      commandId: cmd(),
      actor: owner,
      tokenHash: "hash-1",
      calendarIds: [calendarId],
      label: "phone",
    });
    const feed = store.feedIcs("hash-1")!;
    expect(feed).toContain("SUMMARY:Dentist");
    expect(feed).not.toContain("bring x-ray");
    expect(feed).not.toContain("Dear diary");
    expect(feed).not.toContain("dr@example.com");
    expect(store.feedIcs("unknown")).toBeUndefined();
    store.revokeFeedToken({ commandId: cmd(), actor: owner, tokenHash: "hash-1" });
    expect(store.feedIcs("hash-1")).toBeUndefined();
  });
});

describe("CalendarStore planning", () => {
  it("[C06] keeps week tasks without timestamps across week-start preferences", () => {
    const { store, cmd, owner, calendarId, clock } = setup();
    const sunday = calParseDate("2026-09-27");
    const a = store.addWeekTask({
      commandId: cmd(),
      actor: owner,
      date: sunday,
      firstWeekday: 1,
      title: "Taxes",
    });
    expect(a.anchor).toBe("2026-09-21");
    const b = store.addWeekTask({
      commandId: cmd(),
      actor: owner,
      date: sunday,
      firstWeekday: 0,
      title: "Call mom",
    });
    expect(b.anchor).toBe("2026-09-27");
    const c = store.addWeekTask({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("2026-09-22"),
      firstWeekday: 1,
      title: "Groceries",
    });
    store.reorderWeekTask({ commandId: cmd(), actor: owner, taskId: c.taskId, beforeId: a.taskId });
    expect(store.listWeekTasks(calParseDate("2026-09-25"), 1).map((t) => t.title)).toEqual([
      "Groceries",
      "Taxes",
    ]);
    store.moveWeekTask({
      commandId: cmd(),
      actor: owner,
      taskId: a.taskId,
      date: calParseDate("2026-10-01"),
      firstWeekday: 1,
    });
    expect(store.listWeekTasks(calParseDate("2026-09-28"), 1).map((t) => t.title)).toEqual([
      "Taxes",
    ]);
    store.completeWeekTask({ commandId: cmd(), actor: owner, taskId: c.taskId, completed: true });
    clock.advance(60_000);
    const { eventId } = store.convertWeekTaskToEvent({
      commandId: cmd(),
      actor: owner,
      taskId: b.taskId,
      calendarId,
      start: calTimed(dt("2026-09-29T18:00"), "UTC"),
      end: calTimed(dt("2026-09-29T18:30"), "UTC"),
    });
    expect(store.getEvent(owner, eventId).series.data.summary).toBe("Call mom");
    const converted = store.listWeekTasks(sunday, 0)[0]!;
    expect(converted.eventId).toBe(eventId);
    // Converting completes the task at the conversion instant.
    expect(converted.completedAt).toBe(clock.now());
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "AddWeekTask",
        commandId: cmd(),
        date: sunday,
        firstWeekday: 1,
        title: "x",
      }),
    ).toThrow(/owner-only/);
  });

  it("[C07] tracks habits and enforces one active timer with cross-device reconciliation", () => {
    const { store, cmd, owner, clock } = setup();
    const { habitId } = store.createHabit({
      commandId: cmd(),
      actor: owner,
      name: "Read",
      weekdays: [1, 3, 5],
    });
    store.setHabitCompletion({
      commandId: cmd(),
      actor: owner,
      habitId,
      date: calParseDate("2026-09-21"),
      completed: true,
    });
    store.setHabitCompletion({
      commandId: cmd(),
      actor: owner,
      habitId,
      date: calParseDate("2026-09-23"),
      completed: true,
    });
    store.setHabitCompletion({
      commandId: cmd(),
      actor: owner,
      habitId,
      date: calParseDate("2026-09-23"),
      completed: true,
    });
    store.setHabitCompletion({
      commandId: cmd(),
      actor: owner,
      habitId,
      date: calParseDate("2026-09-21"),
      completed: false,
    });
    expect(
      store.habitHistory(habitId, calParseDate("2026-09-01"), calParseDate("2026-09-30")).completed,
    ).toEqual(["2026-09-23"]);

    const phone = store.startTimer({
      commandId: "cmd_phone_start",
      actor: owner,
      label: "Writing",
    });
    // The same command retried by a flaky device does not start a second timer.
    expect(
      store.startTimer({ commandId: "cmd_phone_start", actor: owner, label: "Writing" }),
    ).toEqual(phone);
    clock.advance(30 * 60_000);
    const laptop = store.startTimer({
      commandId: "cmd_laptop_start",
      actor: owner,
      label: "Email",
    });
    expect(laptop.stoppedEntryId).toBe(phone.entryId);
    expect(store.activeTimer()?.id).toBe(laptop.entryId);
    clock.advance(10 * 60_000);
    // Phone still thinks its timer is running; stopping it must not stop the laptop's timer.
    expect(store.stopTimer({ commandId: cmd(), actor: owner, entryId: phone.entryId })._tag).toBe(
      "AlreadyStopped",
    );
    expect(store.activeTimer()?.id).toBe(laptop.entryId);
    const stopped = store.stopTimer({ commandId: cmd(), actor: owner });
    expect(stopped).toMatchObject({
      _tag: "Stopped",
      entry: { id: laptop.entryId, stoppedAt: clock.now() },
    });
    store.addTimeEntry({
      commandId: cmd(),
      actor: owner,
      label: "Manual",
      startedAt: START - 3_600_000,
      stoppedAt: START - 1_800_000,
    });
    const entries = store.timeEntries(START - 86_400_000, START + 86_400_000);
    expect(entries.map((e) => [e.label, (e.stoppedAt! - e.startedAt) / 60_000])).toEqual([
      ["Manual", 30],
      ["Writing", 30],
      ["Email", 10],
    ]);
    expect(() =>
      store.sql.run(
        "INSERT INTO cal_time_entries (id, label, started_at, active, source, created_at) VALUES ('x', 'x', 0, 1, 'timer', 0), ('y', 'y', 0, 1, 'timer', 0)",
      ),
    ).toThrow();
  });

  it("[C08] keeps day labels, photos, private journal, highlights and free time", () => {
    const { store, cmd, owner, calendarId } = setup();
    const day = calParseDate("2026-09-28");
    store.setDayDecoration({
      commandId: cmd(),
      actor: owner,
      date: day,
      label: "Launch day",
      photoKey: "cal/cal_space1/photo/0123456789abcdef0123",
    });
    store.setDayDecoration({ commandId: cmd(), actor: owner, date: day, label: "Launch day!" });
    const r1 = store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: day,
      body: "Nervous",
      expectedRevision: 0,
    });
    expect(() =>
      store.writeJournal({
        commandId: cmd(),
        actor: owner,
        date: day,
        body: "stale device",
        expectedRevision: 0,
      }),
    ).toThrow(/another device/);
    store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: day,
      body: "Went well",
      expectedRevision: r1.revision,
    });
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-28T09:00"), "UTC"),
        end: calTimed(dt("2026-09-28T12:00"), "UTC"),
        data: { summary: "Launch" },
      },
      highlight: true,
    });
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-28T13:00"), "UTC"),
        end: calTimed(dt("2026-09-28T14:00"), "UTC"),
        data: { summary: "Focus", transparent: true },
      },
    });
    const ctx = store.dayContext(day);
    expect(ctx).toMatchObject({
      label: "Launch day!",
      photoKey: "cal/cal_space1/photo/0123456789abcdef0123",
      journal: { body: "Went well", revision: 2 },
    });
    expect(ctx.highlights.map((h) => h.data.summary)).toEqual(["Launch"]);
    expect(
      ctx.freeTime.map((f) => [
        new Date(f.startMs).toISOString().slice(11, 16),
        new Date(f.endMs).toISOString().slice(11, 16),
      ]),
    ).toEqual([
      ["07:00", "09:00"],
      ["12:00", "22:00"],
    ]);
  });

  it("[C08] clearing a day photo is a compare-and-set against the expected key", () => {
    const { store, cmd, owner } = setup();
    const day = calParseDate("2026-09-28");
    const first = "cal/cal_space1/photo/0123456789abcdef0001";
    const second = "cal/cal_space1/photo/0123456789abcdef0002";
    store.setDayDecoration({ commandId: cmd(), actor: owner, date: day, photoKey: first });
    store.setDayDecoration({ commandId: cmd(), actor: owner, date: day, photoKey: second });
    // The scanner rejects the FIRST photo after it was replaced: the day keeps the second.
    expect(
      store.setDayDecoration({
        commandId: cmd(),
        actor: owner,
        date: day,
        photoKey: null,
        expectedPhotoKey: first,
      }),
    ).toEqual({ applied: false });
    expect(store.dayContext(day).photoKey).toBe(second);
    expect(
      store.setDayDecoration({
        commandId: cmd(),
        actor: owner,
        date: day,
        photoKey: null,
        expectedPhotoKey: second,
      }),
    ).toEqual({ applied: true });
    expect(store.dayContext(day).photoKey).toBeUndefined();
  });

  it("[C09] creates events from messages with an owner-only backlink", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId } = store.createEventFromMessage({
      commandId: cmd(),
      actor: owner,
      calendarId,
      message: { mailboxId: "mbx_1", threadId: "thr_9", deliveryId: "dlv_3" },
      title: "Dinner with Sam",
      start: calTimed(dt("2026-10-02T19:00"), "UTC"),
      end: calTimed(dt("2026-10-02T21:00"), "UTC"),
    });
    expect(store.getEvent(owner, eventId).sourceRef).toEqual({
      mailboxId: "mbx_1",
      threadId: "thr_9",
      deliveryId: "dlv_3",
    });
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "write",
    });
    expect(store.getEvent(GUEST, eventId).sourceRef).toBeUndefined();
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "CreateEventFromMessage",
        commandId: cmd(),
        calendarId,
        message: { mailboxId: "mbx_2", threadId: "t" },
        title: "x",
        start: calTimed(dt("2026-10-02T19:00"), "UTC"),
        end: calTimed(dt("2026-10-02T20:00"), "UTC"),
      }),
    ).toThrow(/owner-only/);
  });

  it("[C10] searches events, tasks, journal, time and day labels with privacy, and feeds widgets", () => {
    const { store, cmd, owner, calendarId } = setup();
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: calTimed(dt("2026-09-25T15:00"), "UTC"),
        end: calTimed(dt("2026-09-25T16:00"), "UTC"),
        data: { summary: "Café planning", location: "Zürich" },
      },
    });
    store.addWeekTask({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("2026-09-25"),
      firstWeekday: 1,
      title: "Planning doc",
    });
    store.writeJournal({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("2026-09-25"),
      body: "Planning felt good",
      expectedRevision: 0,
    });
    store.startTimer({ commandId: cmd(), actor: owner, label: "planning session" });
    store.setDayDecoration({
      commandId: cmd(),
      actor: owner,
      date: calParseDate("2026-09-26"),
      label: "Planning retreat",
    });
    expect(
      store
        .search(owner, "planning")
        .map((h) => h.kind)
        .sort(),
    ).toEqual(["day", "event", "journal", "task", "time"]);
    expect(store.search(owner, "cafe zurich").map((h) => h.kind)).toEqual(["event"]);
    expect(store.search(owner, "planning -journal -felt").map((h) => h.kind)).not.toContain(
      "journal",
    );
    expect(store.search(owner, '"planning doc"').map((h) => h.kind)).toEqual(["task"]);
    expect(store.search(owner, 'bad " syntax ) OR')).toEqual([]);
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "read",
    });
    expect(store.search(GUEST, "planning").map((h) => h.kind)).toEqual(["event"]);
    const widget = store.widgetSnapshot();
    expect(widget.upcoming.map((o) => o.data.summary)).toEqual(["Café planning"]);
    expect(widget.activeTimer?.label).toBe("planning session");
    expect(widget.weekTasks.map((t) => t.title)).toEqual(["Planning doc"]);
    expect(widget.today).toBe("2026-09-25");
    expect(store.changes(owner, 0).changes.length).toBeGreaterThan(0);
    // A grantee sees only event/calendar changes for calendars it can read; a stranger sees none.
    const shared = store.changes(GUEST, 0).changes;
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((c) => c.resource === "calendar" || c.resource === "event")).toBe(true);
    expect(
      (
        calendarRead(store, "usr_stranger00000000000000", { type: "Changes", cursor: 0 }) as {
          changes: Array<unknown>;
        }
      ).changes,
    ).toEqual([]);
  });
});
