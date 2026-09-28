import { describe, expect, it } from "vitest";
import { Exit, Schema } from "effect";
import {
  calBuildRequest,
  calParseDateTime,
  calTimed,
  type CalIcsEvent,
  type CalTime,
} from "@bye/calendar-engine";
import { CalendarCommand } from "@bye/contracts";
import { calendarExecute, calendarRead, CalendarStoreError } from "@bye/platform-cloudflare";
import { makeTestCalendarStore } from "@bye/testing";

const utc = (s: string) => Date.parse(`${s}Z`);

const ny = (s: string) => calTimed(calParseDateTime(s), "America/New_York");

const DAY = 86_400_000;

const setup = (start = utc("2026-09-25T12:00:00")) => {
  const ctx = makeTestCalendarStore({}, start);

  const { calendarId } = ctx.store.createCalendar({
    commandId: ctx.cmd(),
    actor: ctx.owner,
    name: "Personal",
    color: "#f00",
  });

  return { ...ctx, calendarId };
};

const rejection = (fn: () => void): { code?: string; message?: string } => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarStoreError);

    return error as { code?: string; message?: string };
  }

  throw new Error("expected a rejection");
};

/** A daily 09:00 New York series invitation from boss@example.com. */
const seriesInvite = (extra: Partial<CalIcsEvent> = {}): string =>
  calBuildRequest(
    {
      uid: "daily@example.com",
      sequence: 1,
      dtstamp: 1000,
      series: {
        uid: "daily@example.com",
        dtstart: ny("2026-10-29T09:00:00"),
        dtend: ny("2026-10-29T09:30:00"),
        rule: { freq: "DAILY", interval: 1, count: 7, wkst: 1 },
        data: { summary: "Standup" },
      },
      organizer: { address: "boss@example.com" },
      attendees: [{ address: "me@bye.test", partstat: "NEEDS-ACTION", rsvp: true }],
      alarms: [],
      ...extra,
    },
    1000,
  ).ics;

const occurrencesOf = (ctx: ReturnType<typeof setup>) =>
  ctx.store
    .listOccurrences({
      actor: ctx.owner,
      from: utc("2026-10-20T00:00:00"),
      to: utc("2026-11-20T00:00:00"),
    })
    .map((o) => ({ key: o.key, startMs: o.startMs }));

describe("RECURRENCE-ID keys (per-occurrence iTIP and import)", () => {
  it("[C04] a per-occurrence CANCEL with a UTC RECURRENCE-ID removes that occurrence (across DST)", () => {
    const ctx = setup();
    ctx.store.receiveInvitation({
      ingestionId: "i1",
      ics: seriesInvite(),
      sender: "boss@example.com",
    });
    expect(occurrencesOf(ctx)).toHaveLength(7);

    // 2 Nov 09:00 EST (after the fall change) = 14:00Z.
    const cancel = [
      "BEGIN:VCALENDAR",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:daily@example.com",
      "SEQUENCE:2",
      "DTSTAMP:20261001T000000Z",
      "RECURRENCE-ID:20261102T140000Z",
      "DTSTART:20261102T140000Z",
      "ORGANIZER:mailto:boss@example.com",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [r] = ctx.store.receiveInvitation({
      ingestionId: "i2",
      ics: cancel,
      sender: "boss@example.com",
    });

    expect(r).toMatchObject({ _tag: "Apply", action: "cancel", recurrenceKey: "20261102T090000" });
    const keys = occurrencesOf(ctx).map((o) => o.key);
    expect(keys).toHaveLength(6);
    expect(keys).not.toContain("20261102T090000");
  });

  it("[C04] a moved occurrence with a foreign-TZID RECURRENCE-ID appears once, at its new time", () => {
    const ctx = setup();
    ctx.store.receiveInvitation({
      ingestionId: "i1",
      ics: seriesInvite(),
      sender: "boss@example.com",
    });

    // 30 Oct 09:00 EDT is 14:00 in Berlin (CEST); move it to 11:00 New York.
    const moved = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:daily@example.com",
      "SEQUENCE:2",
      "DTSTAMP:20261001T000000Z",
      "RECURRENCE-ID;TZID=Europe/Berlin:20261030T140000",
      "DTSTART;TZID=America/New_York:20261030T110000",
      "DTEND;TZID=America/New_York:20261030T113000",
      "SUMMARY:Standup (moved)",
      "ORGANIZER:mailto:boss@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [r] = ctx.store.receiveInvitation({
      ingestionId: "i2",
      ics: moved,
      sender: "boss@example.com",
    });

    expect(r).toMatchObject({ _tag: "Apply", recurrenceKey: "20261030T090000" });
    const occ = occurrencesOf(ctx);
    expect(occ).toHaveLength(7);

    const onDay = occ.filter(
      (o) => o.startMs >= utc("2026-10-30T00:00:00") && o.startMs < utc("2026-10-31T00:00:00"),
    );

    expect(onDay).toEqual([{ key: "20261030T090000", startMs: utc("2026-10-30T15:00:00") }]);
  });

  it("[C05] importing overrides keyed in UTC attaches them to the series occurrence", () => {
    const ctx = setup();

    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:imp@example.com",
      "DTSTART;TZID=America/New_York:20261029T090000",
      "DTEND;TZID=America/New_York:20261029T093000",
      "RRULE:FREQ=DAILY;COUNT=7",
      "SUMMARY:Imported",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:imp@example.com",
      "RECURRENCE-ID:20261102T140000Z",
      "DTSTART;TZID=America/New_York:20261102T120000",
      "DTEND;TZID=America/New_York:20261102T123000",
      "SUMMARY:Imported (moved)",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:imp@example.com",
      "RECURRENCE-ID:20261031T130000Z",
      "DTSTART;TZID=America/New_York:20261031T090000",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    ctx.store.importIcs({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      ics,
    });
    const occ = occurrencesOf(ctx);
    expect(occ.map((o) => o.key)).not.toContain("20261031T090000");
    expect(occ).toHaveLength(6);
    expect(occ.filter((o) => o.key === "20261102T090000")).toEqual([
      { key: "20261102T090000", startMs: utc("2026-11-02T17:00:00") },
    ]);
  });
});

describe("input validation (tzid, date and time bounds)", () => {
  const create = (start: CalTime, end: CalTime) =>
    ({
      type: "CreateEvent",
      commandId: `c_${Math.random()}`,
      calendarId: "",
      start,
      end,
      data: { summary: "x" },
    }) as never;

  it("rejects unknown zones and out-of-range fields as bad_request instead of RangeError or rollover", () => {
    const ctx = setup();

    const withCal = (c: Record<string, Schema.Json>) =>
      ({ ...c, calendarId: ctx.calendarId }) as never;

    const bad = [
      create(
        { kind: "timed", tzid: "Mars/Olympus", local: calParseDateTime("2026-10-01T09:00:00") },
        { kind: "timed", tzid: "Mars/Olympus", local: calParseDateTime("2026-10-01T10:00:00") },
      ),
      create(
        { kind: "timed", tzid: "\n", local: calParseDateTime("2026-10-01T09:00:00") },
        { kind: "timed", tzid: "UTC", local: calParseDateTime("2026-10-01T10:00:00") },
      ),
      create(
        { kind: "date", date: { year: 2026, month: 13, day: 1 } },
        { kind: "date", date: { year: 2026, month: 13, day: 2 } },
      ),
      create(
        {
          kind: "timed",
          tzid: "UTC",
          local: { year: 2026, month: 2, day: 30, hour: 9, minute: 0, second: 0 },
        },
        {
          kind: "timed",
          tzid: "UTC",
          local: { year: 2026, month: 3, day: 1, hour: 9, minute: 0, second: 0 },
        },
      ),
      create(
        {
          kind: "timed",
          tzid: "UTC",
          local: { year: 2026, month: 1, day: 1, hour: 25, minute: 0, second: 0 },
        },
        {
          kind: "timed",
          tzid: "UTC",
          local: { year: 2026, month: 1, day: 2, hour: 1, minute: 0, second: 0 },
        },
      ),
    ];

    for (const c of bad) {
      const e = rejection(() => calendarExecute(ctx.store, ctx.owner, withCal(c)));
      expect(e.code).toBe("bad_request");
    }

    // Store-level guard too (imports and invitations do not pass through the dispatcher).
    const e = rejection(() =>
      ctx.store.createEvent({
        commandId: ctx.cmd(),
        actor: ctx.owner,
        calendarId: ctx.calendarId,
        series: {
          start: {
            kind: "timed",
            tzid: "Nowhere/City",
            local: calParseDateTime("2026-10-01T09:00:00"),
          },
          end: {
            kind: "timed",
            tzid: "Nowhere/City",
            local: calParseDateTime("2026-10-01T10:00:00"),
          },
          data: { summary: "x" },
        },
      }),
    );

    expect(e.code).toBe("bad_request");

    for (const q of [
      { type: "Day", date: { year: 2026, month: 1, day: 32 } },
      { type: "Day", date: { year: 2026, month: 1, day: 1 }, viewerZone: "Bad/Zone" },
      { type: "Month", year: 2026, month: 0 },
      { type: "Occurrences", from: 0, to: DAY, viewerZone: "Bad/Zone" },
    ]) {
      expect(rejection(() => calendarRead(ctx.store, ctx.owner, q as never)).code).toBe(
        "bad_request",
      );
    }
  });

  it("the public contract rejects CR/LF in values that reach iCalendar output", () => {
    const decode = Schema.decodeUnknownExit(CalendarCommand);

    const base = {
      type: "CreateEvent",
      commandId: "c1",
      calendarId: "cal",
      start: { kind: "date", date: { year: 2026, month: 10, day: 1 } },
      end: { kind: "date", date: { year: 2026, month: 10, day: 2 } },
    };

    expect(
      Exit.isSuccess(decode({ ...base, data: { summary: "ok\tfine", description: "a\r\nb" } })),
    ).toBe(true);
    expect(Exit.isFailure(decode({ ...base, data: { summary: "a\r\nATTENDEE:x" } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...base, data: { summary: "a", url: "https://x\n" } }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decode({
          ...base,
          data: { summary: "a" },
          attendees: [{ address: "a@b.c", name: "A\r\nB" }],
        }),
      ),
    ).toBe(true);
  });
});

describe("reminders beyond the 400-day horizon", () => {
  it("[C02] parks a recheck at the horizon instead of dropping the reminder, then schedules it", () => {
    const ctx = setup();

    const { eventId } = ctx.store.createEvent({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      series: {
        start: ny("2028-06-01T09:00:00"),
        end: ny("2028-06-01T10:00:00"),
        data: { summary: "Far away" },
      },
      alarms: [10],
    });

    const job = ctx.store.kernel.job("reminder", eventId)!;
    expect(job.dueAt).toBe(ctx.clock.now() + 400 * DAY);
    expect(job.payload).toMatchObject({ recheck: true });
    ctx.clock.advance(job.dueAt - ctx.clock.now() + 1);
    const result = ctx.store.runDueJobs();
    // The recheck notifies nobody; it schedules the real reminder.
    expect(result.fired).toEqual([]);
    expect(ctx.store.kernel.pendingOutbox(100).some((e) => e.topic === "calendar.notify")).toBe(
      false,
    );
    expect(ctx.store.kernel.job("reminder", eventId)!.dueAt).toBe(utc("2028-06-01T12:50:00"));
  });
});

describe("event range bounds", () => {
  const rangeOf = (ctx: ReturnType<typeof setup>, eventId: string) =>
    ctx.store.sql.one<{ range_start: number; range_end: number | null }>(
      "SELECT range_start, range_end FROM cal_events WHERE id = ?",
      eventId,
    )!;

  it("UNTIL bounds analytically; COUNT past the cap is unbounded, not truncated", () => {
    const ctx = setup();
    const slack = 14 * 3_600_000;

    const until = ctx.store.createEvent({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      series: {
        start: ny("2026-10-01T09:00:00"),
        end: ny("2026-10-01T10:00:00"),
        rrule: "FREQ=WEEKLY;UNTIL=20261231T235959Z",
        data: { summary: "Until" },
      },
    });

    expect(rangeOf(ctx, until.eventId).range_end).toBe(
      utc("2026-12-31T23:59:59") + 3_600_000 + slack,
    );

    const counted = ctx.store.createEvent({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      series: {
        start: ny("2026-10-01T09:00:00"),
        end: ny("2026-10-01T10:00:00"),
        rrule: "FREQ=DAILY;COUNT=10",
        data: { summary: "Counted" },
      },
    });

    // Last occurrence 10 Oct 09:00 EDT = 13:00Z, plus an hour.
    expect(rangeOf(ctx, counted.eventId).range_end).toBe(utc("2026-10-10T14:00:00") + slack);

    const huge = ctx.store.createEvent({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      series: {
        start: ny("2026-10-01T09:00:00"),
        end: ny("2026-10-01T10:00:00"),
        rrule: "FREQ=DAILY;COUNT=50000",
        data: { summary: "Huge" },
      },
    });

    expect(rangeOf(ctx, huge.eventId).range_end).toBeNull();
    // Far-future occurrences of the unbounded row are still found by window queries.
    const from = utc("2075-01-01T00:00:00");
    const listed = ctx.store.listOccurrences({ actor: ctx.owner, from, to: from + 2 * DAY });
    expect(listed.filter((o) => o.eventId === huge.eventId)).toHaveLength(2);
  });
});

describe("ICS import in bounded batches", () => {
  const many = (n: number, prefix = "Item") =>
    [
      "BEGIN:VCALENDAR",
      ...Array.from({ length: n }, (_, i) =>
        [
          "BEGIN:VEVENT",
          `UID:bulk-${i}@example.com`,
          `DTSTART:202611${String((i % 28) + 1).padStart(2, "0")}T120000Z`,
          `DTEND:202611${String((i % 28) + 1).padStart(2, "0")}T130000Z`,
          `SUMMARY:${prefix} ${i}`,
          "END:VEVENT",
        ].join("\r\n"),
      ),
      "BEGIN:VEVENT",
      "UID:broken@example.com",
      "DTSTART;TZID=America/New_York:20261301T120000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

  it("[C05] imports across batches, reports bad events, replays by command ID and re-imports idempotently", () => {
    const ctx = setup();
    const commandId = ctx.cmd();

    const first = ctx.store.importIcs({
      commandId,
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      ics: many(250),
    });

    expect(first.imported).toBe(250);
    expect(first.warnings.some((w) => w.startsWith("broken@example.com"))).toBe(true);

    const count = () =>
      Number(
        ctx.store.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM cal_events WHERE deleted = 0")!
          .n,
      );

    expect(count()).toBe(250);

    const revisions = () =>
      Number(ctx.store.sql.one<{ n: number }>("SELECT SUM(revision) AS n FROM cal_events")!.n);

    const before = revisions();
    // Same command ID: the stored result, with no rewrite.
    expect(
      ctx.store.importIcs({
        commandId,
        actor: ctx.owner,
        calendarId: ctx.calendarId,
        ics: many(250),
      }),
    ).toEqual(first);
    expect(revisions()).toBe(before);

    // A retry under a new ID (e.g. after a failure part-way) upserts by UID.
    const again = ctx.store.importIcs({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      ics: many(250, "Renamed"),
    });

    expect(again).toMatchObject({ imported: 0, updated: 250 });
    expect(count()).toBe(250);
  });

  it("[C05] a retried import resumes after the last committed batch and reports whole-import totals", () => {
    const ctx = setup();
    const commandId = ctx.cmd();
    const ics = many(250);
    const input = { commandId, actor: ctx.owner, calendarId: ctx.calendarId, ics };
    // Crash while committing the second batch: it rolls back, the first stays committed.
    const run = ctx.store.sql.run.bind(ctx.store.sql);
    let checkpoints = 0;
    ctx.store.sql.run = (query, ...bindings) => {
      if (query.includes("INSERT INTO cal_import_checkpoints") && ++checkpoints === 2)
        throw new Error("crash");

      return run(query, ...bindings);
    };

    expect(() => ctx.store.importIcs(input)).toThrow("crash");
    ctx.store.sql.run = run;

    const revision = (uid: string) =>
      Number(
        ctx.store.sql.one<{ revision: number }>(
          "SELECT revision FROM cal_events WHERE uid = ?",
          uid,
        )?.revision ?? 0,
      );

    expect(revision("bulk-0@example.com")).toBeGreaterThan(0);
    expect(revision("bulk-100@example.com")).toBe(0);
    const firstBatch = revision("bulk-0@example.com");
    // A different document under the same command ID is refused rather than mixed in.
    expect(() => ctx.store.importIcs({ ...input, ics: many(250, "Other") })).toThrow(
      /different document/,
    );
    const result = ctx.store.importIcs(input);
    expect(result).toMatchObject({ imported: 250, updated: 0 });
    expect(result.warnings.filter((w) => w.startsWith("broken@example.com"))).toHaveLength(1);
    // The committed batch was not rewritten, and the checkpoint is gone with the receipt.
    expect(revision("bulk-0@example.com")).toBe(firstBatch);
    expect(
      ctx.store.sql.one(
        "SELECT 1 AS x FROM cal_import_checkpoints WHERE command_id = ?",
        commandId,
      ),
    ).toBeUndefined();
  });

  it("[C05] abandoned import checkpoints expire", () => {
    const ctx = setup();
    ctx.store.sql.run(
      "INSERT INTO cal_import_checkpoints VALUES ('old', ?, 'h', 100, 100, 0, '[]', 0)",
      ctx.calendarId,
    );
    ctx.store.importIcs({
      commandId: ctx.cmd(),
      actor: ctx.owner,
      calendarId: ctx.calendarId,
      ics: many(1),
    });
    expect(ctx.store.sql.one("SELECT 1 AS x FROM cal_import_checkpoints")).toBeUndefined();
  });
});
