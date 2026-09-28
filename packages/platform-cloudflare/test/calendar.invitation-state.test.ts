import { describe, expect, it } from "vitest";
import { calendarRead } from "@bye/platform-cloudflare";
import { makeTestCalendarStore } from "@bye/testing";

// Invitation state for clients (C04/C09): which message carried which invitation, the occurrence
// it concerns, and the owner's current answer — per occurrence as well as for the series.

const START = Date.parse("2026-09-25T12:00:00Z");
const GUEST = "usr_guest0000000000000000";
const REF = { mailboxId: "mbx_owner", threadId: "thr_1" };

const vevent = (lines: ReadonlyArray<string>) =>
  [
    "BEGIN:VEVENT",
    "UID:weekly-1@example.com",
    "DTSTAMP:20261001T000000Z",
    "ORGANIZER;CN=Boss:mailto:boss@example.com",
    "ATTENDEE:mailto:me@bye.test",
    ...lines,
    "END:VEVENT",
  ].join("\r\n");

const calendar = (...events: ReadonlyArray<string>) =>
  ["BEGIN:VCALENDAR", "METHOD:REQUEST", ...events, "END:VCALENDAR"].join("\r\n");

const SERIES = vevent([
  "DTSTART:20261005T090000Z",
  "DTEND:20261005T093000Z",
  "RRULE:FREQ=WEEKLY;COUNT=10",
  "SUMMARY:Weekly sync",
  "SEQUENCE:0",
]);

const moved = (hour: string, sequence: number) =>
  vevent([
    "RECURRENCE-ID:20261012T090000Z",
    `DTSTART:20261012T${hour}0000Z`,
    `DTEND:20261012T${hour}3000Z`,
    "SUMMARY:Weekly sync (moved)",
    `SEQUENCE:${sequence}`,
  ]);

const setup = () => {
  const ctx = makeTestCalendarStore({}, START);
  const receive = (deliveryId: string, ics: string) =>
    ctx.store.receiveInvitation({
      ingestionId: deliveryId,
      sender: "boss@example.com",
      ics,
      sourceRef: { ...REF, deliveryId },
    });
  const lookup = (deliveryId: string, mailboxId = REF.mailboxId) =>
    (
      calendarRead(ctx.store, ctx.owner, { type: "Invitations", mailboxId, deliveryId }) as {
        invitations: ReadonlyArray<Record<string, unknown>>;
      }
    ).invitations;
  return { ...ctx, receive, lookup };
};

describe("[C09] invitations by message", () => {
  it("[C09] a message's invitation carries the event, its occurrence key and the owner's answer", () => {
    const { store, owner, cmd, receive, lookup } = setup();
    receive("dlv_series", calendar(SERIES));
    receive("dlv_moved", calendar(moved("10", 1)));

    const [series] = lookup("dlv_series");
    expect(series).toMatchObject({
      summary: "Weekly sync",
      recurring: true,
      occurrenceKey: null,
      partstat: "NEEDS-ACTION",
      cancelled: false,
      organizer: { address: "boss@example.com", name: "Boss" },
    });
    const [occurrence] = lookup("dlv_moved");
    expect(occurrence).toMatchObject({
      eventId: series!.eventId,
      summary: "Weekly sync (moved)",
      partstat: "NEEDS-ACTION",
      start: { kind: "timed", local: { day: 12, hour: 10 } },
    });
    expect(occurrence!.occurrenceKey).toEqual(expect.any(String));

    // Answering the one occurrence records it for that occurrence only.
    store.respondToInvitation({
      commandId: cmd(),
      actor: owner,
      eventId: series!.eventId as string,
      partstat: "DECLINED",
      occurrenceKey: occurrence!.occurrenceKey as string,
    });
    store.respondToInvitation({
      commandId: cmd(),
      actor: owner,
      eventId: series!.eventId as string,
      partstat: "ACCEPTED",
    });
    expect(lookup("dlv_moved")[0]).toMatchObject({ partstat: "DECLINED" });
    expect(lookup("dlv_series")[0]).toMatchObject({ partstat: "ACCEPTED" });

    // Occurrences carry the same state, per occurrence.
    const occurrences = store.listOccurrences({
      actor: owner,
      from: Date.parse("2026-10-05T00:00:00Z"),
      to: Date.parse("2026-10-20T00:00:00Z"),
    });
    expect(occurrences.map((o) => o.invitation?.partstat)).toEqual([
      "ACCEPTED",
      "DECLINED",
      "ACCEPTED",
    ]);

    // Moving the occurrence again asks for a new answer.
    receive("dlv_moved_again", calendar(moved("11", 2)));
    expect(lookup("dlv_moved_again")[0]).toMatchObject({ partstat: "ACCEPTED" });
  });

  it("[C09] an occurrence update that doesn't move it keeps the owner's answer", () => {
    const { store, owner, cmd, receive, lookup } = setup();
    receive("dlv_series", calendar(SERIES));
    const [series] = lookup("dlv_series");
    // Answer the 19 Oct occurrence, which has no exception of its own yet.
    const occurrenceKey = store.listOccurrences({
      actor: owner,
      from: Date.parse("2026-10-19T00:00:00Z"),
      to: Date.parse("2026-10-20T00:00:00Z"),
    })[0]!.key;
    store.respondToInvitation({
      commandId: cmd(),
      actor: owner,
      eventId: series!.eventId as string,
      partstat: "TENTATIVE",
      occurrenceKey,
    });
    // Same time (written with a zone), new description: not a move.
    receive(
      "dlv_note",
      calendar(
        vevent([
          "RECURRENCE-ID:20261019T090000Z",
          "DTSTART;TZID=Europe/London:20261019T100000",
          "DTEND;TZID=Europe/London:20261019T103000",
          "SUMMARY:Weekly sync",
          "DESCRIPTION:Agenda attached",
          "SEQUENCE:1",
        ]),
      ),
    );
    expect(lookup("dlv_note")[0]).toMatchObject({ partstat: "TENTATIVE" });
    // Moving it asks again.
    receive(
      "dlv_move",
      calendar(
        vevent([
          "RECURRENCE-ID:20261019T090000Z",
          "DTSTART:20261019T130000Z",
          "DTEND:20261019T133000Z",
          "SUMMARY:Weekly sync",
          "SEQUENCE:2",
        ]),
      ),
    );
    expect(lookup("dlv_move")[0]).toMatchObject({ partstat: "NEEDS-ACTION" });
  });

  it("[C09] a re-sent copy of an invitation can be answered from its own thread", () => {
    const { receive, lookup } = setup();
    receive("dlv_first", calendar(SERIES));
    const [result] = receive("dlv_resent", calendar(SERIES));
    expect(result?._tag).toBe("Duplicate");
    expect(lookup("dlv_resent")).toEqual(lookup("dlv_first"));
  });

  it("[C09] another mailbox's delivery ID finds nothing, and non-owners are refused", () => {
    const { store, owner, cmd, receive, lookup } = setup();
    receive("dlv_series", calendar(SERIES));
    expect(lookup("dlv_series", "mbx_other")).toEqual([]);
    expect(lookup("dlv_unknown")).toEqual([]);
    expect(() =>
      calendarRead(store, GUEST, {
        type: "Invitations",
        mailboxId: REF.mailboxId,
        deliveryId: "dlv_series",
      }),
    ).toThrow();
    // A shared reader sees the event but not the owner's answer.
    const [first] = lookup("dlv_series");
    store.grantCalendar({
      commandId: cmd(),
      actor: owner,
      calendarId: first!.calendarId as string,
      grantee: GUEST,
      role: "read",
    });
    const window = {
      from: Date.parse("2026-10-05T00:00:00Z"),
      to: Date.parse("2026-10-06T00:00:00Z"),
    };
    expect(store.listOccurrences({ actor: owner, ...window })[0]?.invitation).toBeDefined();
    const shared = store.listOccurrences({ actor: GUEST, ...window });
    expect(shared).toHaveLength(1);
    expect(shared[0]?.invitation).toBeUndefined();
  });
});
