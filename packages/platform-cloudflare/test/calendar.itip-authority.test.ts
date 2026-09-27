import { describe, expect, it } from "vitest";
import { calParseDate, calTimed } from "@bye/calendar-engine";
import { calendarExecute, calendarRepositoryLocal } from "@bye/platform-cloudflare";
import { CalendarRepository } from "@bye/application";
import { makeTestCalendarStore } from "@bye/testing";
import { Effect } from "effect";

// iTIP authority (C04): inbound messages may only touch events that came from an invitation (and
// never read-only subscription copies); outbound iTIP, which is mail from the owner's address,
// may only be caused by the owner. Day photos are bound to the space they were uploaded to (C08).

const START = Date.parse("2026-09-25T12:00:00Z");
const GUEST = "usr_guest0000000000000000";
const at = (day: number, hour: number) =>
  calTimed({ year: 2026, month: 10, day, hour, minute: 0, second: 0 }, "UTC");

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

const itipOutbox = (store: ReturnType<typeof setup>["store"]) =>
  store.kernel.pendingOutbox(1000).filter((e) => e.topic === "calendar.itip");

const message = (method: "REQUEST" | "CANCEL", uid: string, organizer: string) =>
  [
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20300101T000000Z",
    "DTSTART:20300101T100000Z",
    "DTEND:20300101T110000Z",
    "SUMMARY:Changed",
    `ORGANIZER:mailto:${organizer}`,
    "ATTENDEE:mailto:me@bye.test",
    "SEQUENCE:1",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

describe("inbound iTIP never claims a locally created event", () => {
  it("REQUEST and CANCEL for an organizer-less event's UID are unauthorized and change nothing", () => {
    const { store, cmd, owner, calendarId } = setup();
    const { eventId, uid } = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: { start: at(1, 9), end: at(1, 10), data: { summary: "Private" } },
    });
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId,
      grantee: GUEST,
      role: "read",
    });
    for (const [i, method] of (["REQUEST", "CANCEL"] as const).entries()) {
      const [result] = calendarExecute(store, null, {
        type: "ReceiveInvitation",
        commandId: `ing_${i}`,
        sender: "guest@example.test",
        ics: message(method, uid, "guest@example.test"),
      }) as Array<{ _tag: string }>;
      expect(result?._tag, method).toBe("Unauthorized");
    }
    const after = store.getEvent(owner, eventId);
    expect(after.series.data.summary).toBe("Private");
    expect(after.series.data.status).toBe("confirmed");
    expect(after.organizer).toBeUndefined();
    // The owner can still edit it (a takeover would have made it an attendee copy).
    expect(() =>
      store.updateEvent({
        commandId: cmd(),
        actor: owner,
        eventId,
        expectedRevision: after.revision,
        scope: "series",
        changes: { data: { summary: "Still mine" } },
      }),
    ).not.toThrow();
  });

  it("iTIP never mutates a read-only subscription's copy of an event", () => {
    const { store, cmd, owner } = setup();
    const { calendarId } = store.addSubscription({
      commandId: cmd(),
      actor: owner,
      name: "Team",
      color: "#00f",
      url: "https://calendars.example.com/team.ics",
    });
    store.applySubscriptionFetch({
      calendarId,
      fetchId: "f1",
      status: "ok",
      body: message("REQUEST", "shared-1@example.com", "boss@example.com").replace(
        "METHOD:REQUEST\r\n",
        "",
      ),
    });
    const [result] = store.receiveInvitation({
      ingestionId: "ing_sub",
      sender: "boss@example.com",
      ics: message("CANCEL", "shared-1@example.com", "boss@example.com"),
    });
    // No invitation copy exists, so the cancel finds nothing; the subscription row is untouched.
    expect(result).toMatchObject({ _tag: "Apply", action: "cancel" });
    expect((result as { eventId?: string }).eventId).toBeUndefined();
    const feedCopy = store
      .listOccurrences({
        actor: owner,
        from: Date.parse("2029-12-31T00:00:00Z"),
        to: Date.parse("2030-01-02T00:00:00Z"),
      })
      .find((o) => o.uid === "shared-1@example.com");
    expect(feedCopy?.calendarId).toBe(calendarId);
    expect(feedCopy?.data.status).not.toBe("cancelled");
  });

  it("an invitation from its organizer still applies (negative control)", () => {
    const { store } = setup();
    const [created] = store.receiveInvitation({
      ingestionId: "ing_1",
      sender: "boss@example.com",
      ics: message("REQUEST", "remote-9@example.com", "boss@example.com"),
    });
    expect(created).toMatchObject({ _tag: "Apply", action: "create" });
    const [cancelled] = store.receiveInvitation({
      ingestionId: "ing_2",
      sender: "boss@example.com",
      ics: message("CANCEL", "remote-9@example.com", "boss@example.com").replace(
        "SEQUENCE:1",
        "SEQUENCE:2",
      ),
    });
    expect(cancelled).toMatchObject({ _tag: "Apply", action: "cancel" });
  });
});

describe("outbound iTIP is owner-only", () => {
  const withWriter = () => {
    const ctx = setup();
    ctx.store.grantCalendar({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      grantee: GUEST,
      role: "write",
    });
    return ctx;
  };

  it("a write grantee can't invite attendees, re-invite, or cancel the owner's invitations", () => {
    const { store, cmd, owner, calendarId } = withWriter();
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "CreateEvent",
        commandId: cmd(),
        calendarId,
        start: at(2, 9),
        end: at(2, 10),
        data: { summary: "x", description: "attacker text" },
        attendees: [{ address: "victim@example.test" }],
      }),
    ).toThrow(/owner/);
    // Adding attendees to an organizer-less event.
    const plain = calendarExecute(store, GUEST, {
      type: "CreateEvent",
      commandId: cmd(),
      calendarId,
      start: at(3, 9),
      end: at(3, 10),
      data: { summary: "plain" },
    }) as { eventId: string };
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "UpdateEvent",
        commandId: cmd(),
        eventId: plain.eventId,
        expectedRevision: 1,
        scope: "series",
        changes: { attendees: [{ address: "victim@example.test" }] },
      }),
    ).toThrow(/owner/);
    // The owner's own invitation: the grantee can neither move it nor delete it.
    const meeting = store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: { start: at(4, 9), end: at(4, 10), data: { summary: "Kickoff" } },
      attendees: [{ address: "guest@example.net" }],
    });
    const sent = itipOutbox(store).length;
    expect(sent).toBe(1);
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "UpdateEvent",
        commandId: cmd(),
        eventId: meeting.eventId,
        expectedRevision: 1,
        scope: "series",
        changes: { start: at(4, 11), end: at(4, 12), data: { summary: "Moved" } },
      }),
    ).toThrow(/owner/);
    expect(() =>
      calendarExecute(store, GUEST, {
        type: "DeleteEvent",
        commandId: cmd(),
        eventId: meeting.eventId,
        scope: "series",
      }),
    ).toThrow(/owner/);
    expect(itipOutbox(store)).toHaveLength(sent);
  });

  it("grantees still edit events without invitees; the owner still sends invitations", () => {
    const { store, cmd, owner, calendarId } = withWriter();
    const plain = calendarExecute(store, GUEST, {
      type: "CreateEvent",
      commandId: cmd(),
      calendarId,
      start: at(3, 9),
      end: at(3, 10),
      data: { summary: "plain" },
    }) as { eventId: string };
    // Clients send the (unchanged, empty) attendee list with every edit.
    expect(
      calendarExecute(store, GUEST, {
        type: "UpdateEvent",
        commandId: cmd(),
        eventId: plain.eventId,
        expectedRevision: 1,
        scope: "series",
        changes: { data: { summary: "renamed" }, attendees: [] },
      }),
    ).toMatchObject({ revision: 2 });
    calendarExecute(store, owner, {
      type: "UpdateEvent",
      commandId: cmd(),
      eventId: plain.eventId,
      expectedRevision: 2,
      scope: "series",
      changes: { attendees: [{ address: "guest@example.net" }] },
    });
    expect(itipOutbox(store).map((e) => (e.payload as { method: string }).method)).toEqual([
      "REQUEST",
    ]);
  });

  it("attendee lists are bounded", () => {
    const { store, cmd, owner, calendarId } = setup();
    expect(() =>
      store.createEvent({
        commandId: cmd(),
        actor: owner,
        calendarId,
        series: { start: at(5, 9), end: at(5, 10), data: { summary: "All hands" } },
        attendees: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.net` })),
      }),
    ).toThrow(/at most 100/);
  });
});

describe("day photos are bound to their calendar space", () => {
  it("SetDayDecoration refuses a photo key from another space", async () => {
    const { store, owner } = setup();
    const layer = calendarRepositoryLocal(() => store);
    const set = (photoKey: string) =>
      Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            const repo = yield* CalendarRepository;
            return yield* repo.execute("cal_mine", owner, {
              type: "SetDayDecoration",
              commandId: `set:${photoKey}`,
              date: calParseDate("2030-01-01"),
              photoKey,
            });
          }).pipe(Effect.provide(layer)),
        ),
      ).catch(() => null);
    const refused = await set("cal/cal_victim/photo/0123456789abcdef0001");
    expect(refused).toMatchObject({ code: "bad_request" });
    expect(store.dayContext(calParseDate("2030-01-01")).photoKey).toBeUndefined();
    // Its own photo is accepted (flip fails on success, so null here).
    expect(await set("cal/cal_mine/photo/0123456789abcdef0001")).toBeNull();
    expect(store.dayContext(calParseDate("2030-01-01")).photoKey).toBe(
      "cal/cal_mine/photo/0123456789abcdef0001",
    );
  });

  it("a photo still shown on another day is not released", () => {
    const { store, cmd, owner } = setup();
    const key = "cal/cal_mine/photo/0123456789abcdef0001";
    const a = calParseDate("2030-01-01");
    const b = calParseDate("2030-01-02");
    store.setDayDecoration({ commandId: cmd(), actor: owner, date: a, photoKey: key });
    store.setDayDecoration({ commandId: cmd(), actor: owner, date: b, photoKey: key });
    expect(
      store.setDayDecoration({ commandId: cmd(), actor: owner, date: a, photoKey: null }),
    ).toEqual({ applied: true });
    expect(
      store.setDayDecoration({ commandId: cmd(), actor: owner, date: b, photoKey: null }),
    ).toEqual({ applied: true, released: key });
  });
});
