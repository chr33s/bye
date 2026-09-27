import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import {
  calendarCreateEventFromMessage,
  calendarCreateFeedToken,
  calendarExecuteCommand,
  calendarListOccurrences,
  calendarRefreshSubscription,
  calendarSearch,
  calendarSearchLocations,
  calendarServeFeed,
  LocationSearch,
  Principal,
  type PrincipalShape,
  type Scope,
} from "@bye/application";
import { calendarFeedFetcherLive, calendarRepositoryLocal } from "@bye/platform-cloudflare";
import { makeTestCalendarStore } from "@bye/testing";

const SPACE = "cal_space_owner";

const principal = (
  userId: string,
  scopes: ReadonlyArray<Scope>,
  mailboxIds: ReadonlyArray<string> = [],
): PrincipalShape => ({
  userId,
  sessionId: `ses_${userId}`,
  kind: "user",
  scopes,
  mailboxIds,
  calendarIds: [SPACE],
  organizationIds: [],
});

const setup = (fetchFn: typeof fetch = async () => new Response("", { status: 500 })) => {
  const ctx = makeTestCalendarStore({}, Date.UTC(2026, 8, 25, 12));
  const repo = calendarRepositoryLocal(() => ctx.store);
  const locations = Layer.succeed(LocationSearch, {
    search: (q) => Effect.succeed([{ label: `${q.text} Café`, address: "1 Main St" }]),
  });
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);
  const as =
    (p: PrincipalShape) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      run(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              repo,
              locations,
              calendarFeedFetcherLive(fetchFn),
              Layer.succeed(Principal, p),
            ),
          ),
        ) as Effect.Effect<A, E, never>,
      );
  return { ...ctx, as };
};

const envelope = (command: object) => ({ schemaVersion: 1, command });
const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`);
  return exit.value;
};
const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isFailure(exit)
    ? (JSON.stringify(exit.cause).match(
        /"_tag":"(Forbidden|NotFound|CalendarFailure|Conflict)"/,
      )?.[1] ?? "defect")
    : undefined;

describe("calendar use cases", () => {
  it("[C02] [X02] enforces credential scopes and decodes commands at the boundary", async () => {
    const { as, owner } = setup();
    const full = as(principal(owner, ["read", "calendar"]));
    const readOnlyAgent = as({ ...principal(owner, ["read", "draft"]), kind: "agent" });
    const created = ok(
      await full(
        calendarExecuteCommand(
          SPACE,
          envelope({ type: "CreateCalendar", commandId: "c1", name: "Work", color: "#123" }),
        ),
      ),
    ) as { calendarId: string };
    expect(
      failureTag(
        await readOnlyAgent(
          calendarExecuteCommand(
            SPACE,
            envelope({ type: "CreateCalendar", commandId: "c2", name: "x", color: "#000" }),
          ),
        ),
      ),
    ).toBe("Forbidden");
    expect(
      failureTag(
        await full(
          calendarExecuteCommand(SPACE, envelope({ type: "CreateCalendar", commandId: "c3" })),
        ),
      ),
    ).toBe("CalendarFailure");
    expect(
      failureTag(await full(calendarExecuteCommand(SPACE, { schemaVersion: 2, command: {} }))),
    ).toBe("CalendarFailure");
    ok(
      await full(
        calendarExecuteCommand(
          SPACE,
          envelope({
            type: "CreateEvent",
            commandId: "c4",
            calendarId: created.calendarId,
            start: {
              kind: "timed",
              tzid: "Europe/Paris",
              local: { year: 2026, month: 9, day: 26, hour: 9, minute: 0, second: 0 },
            },
            end: {
              kind: "timed",
              tzid: "Europe/Paris",
              local: { year: 2026, month: 9, day: 26, hour: 10, minute: 0, second: 0 },
            },
            rrule: "FREQ=DAILY;COUNT=2",
            data: { summary: "Standup" },
          }),
        ),
      ),
    );
    const occ = ok(
      await readOnlyAgent(
        calendarListOccurrences(SPACE, { from: Date.UTC(2026, 8, 26), to: Date.UTC(2026, 8, 28) }),
      ),
    );
    expect(occ.map((o) => [o.key, o.data.summary, new Date(o.startMs).toISOString()])).toEqual([
      ["20260926T090000", "Standup", "2026-09-26T07:00:00.000Z"],
      ["20260927T090000", "Standup", "2026-09-27T07:00:00.000Z"],
    ]);
    // A stale revision surfaces as a structured conflict, not a defect.
    const [first] = occ;
    const conflict = await full(
      calendarExecuteCommand(
        SPACE,
        envelope({
          type: "UpdateEvent",
          commandId: "c5",
          eventId: first!.eventId,
          expectedRevision: 99,
          scope: "series",
          changes: { data: { summary: "x" } },
        }),
      ),
    );
    expect(JSON.stringify(Exit.isFailure(conflict) && conflict.cause)).toContain(
      '"code":"conflict"',
    );
  });

  it("[C04] inviting attendees needs send authority, not just the calendar scope", async () => {
    const { as, owner } = setup();
    const calendarOnly = as({ ...principal(owner, ["read", "calendar"]), kind: "agent" });
    const withSend = as({ ...principal(owner, ["read", "calendar", "send"]), kind: "agent" });
    const { calendarId } = ok(
      await withSend(
        calendarExecuteCommand(
          SPACE,
          envelope({ type: "CreateCalendar", commandId: "s1", name: "Work", color: "#123" }),
        ),
      ),
    ) as { calendarId: string };
    const invite = (commandId: string) =>
      calendarExecuteCommand(
        SPACE,
        envelope({
          type: "CreateEvent",
          commandId,
          calendarId,
          start: { kind: "date", date: { year: 2026, month: 9, day: 26 } },
          end: { kind: "date", date: { year: 2026, month: 9, day: 27 } },
          data: { summary: "Sync" },
          attendees: [{ address: "guest@example.test" }],
        }),
      );
    expect(failureTag(await calendarOnly(invite("s2")))).toBe("Forbidden");
    ok(await withSend(invite("s3")));
  });

  it("[C10] searches with bounded queries and uses the location adapter", async () => {
    const { as, owner } = setup();
    const user = as(principal(owner, ["read", "calendar"]));
    ok(
      await user(
        calendarExecuteCommand(
          SPACE,
          envelope({
            type: "AddWeekTask",
            commandId: "t1",
            date: { year: 2026, month: 9, day: 25 },
            firstWeekday: 1,
            title: "Book flights",
          }),
        ),
      ),
    );
    expect(ok(await user(calendarSearch(SPACE, "flights"))).map((h) => h.kind)).toEqual(["task"]);
    expect(failureTag(await user(calendarSearch(SPACE, "x".repeat(300))))).toBe("CalendarFailure");
    expect(ok(await user(calendarSearchLocations("Blue Bottle")))).toEqual([
      { label: "Blue Bottle Café", address: "1 Main St" },
    ]);
    expect(
      failureTag(await as(principal(owner, ["read"]))(calendarSearchLocations("Blue Bottle"))),
    ).toBe("Forbidden");
  });

  it("[C09] creating an event from a message requires mailbox access", async () => {
    const { as, owner, store, cmd } = setup();
    const { calendarId } = store.createCalendar({
      commandId: cmd(),
      actor: owner,
      name: "P",
      color: "#000",
    });
    const body = {
      schemaVersion: 1,
      commandId: "m1",
      calendarId,
      message: { mailboxId: "mbx_mine", threadId: "thr_1" },
      title: "Lunch",
      start: {
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 10, day: 1, hour: 12, minute: 0, second: 0 },
      },
      end: {
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 10, day: 1, hour: 13, minute: 0, second: 0 },
      },
    };
    expect(
      failureTag(
        await as(principal(owner, ["read", "calendar"], ["mbx_other"]))(
          calendarCreateEventFromMessage(SPACE, body),
        ),
      ),
    ).toBe("Forbidden");
    const { eventId } = ok(
      await as(principal(owner, ["read", "calendar"], ["mbx_mine"]))(
        calendarCreateEventFromMessage(SPACE, body),
      ),
    );
    expect(store.getEvent(owner, eventId).sourceRef).toEqual({
      mailboxId: "mbx_mine",
      threadId: "thr_1",
    });
  });

  it("[C05] issues private feed tokens once, stores only hashes, and revokes them", async () => {
    const { as, owner, store, cmd } = setup();
    const { calendarId } = store.createCalendar({
      commandId: cmd(),
      actor: owner,
      name: "P",
      color: "#000",
    });
    const user = as(principal(owner, ["read", "calendar"]));
    const { token } = ok(
      await user(
        calendarCreateFeedToken(SPACE, {
          schemaVersion: 1,
          commandId: "f1",
          calendarIds: [calendarId],
          label: "phone",
        }),
      ),
    );
    expect(
      store.sql.all("SELECT token_hash FROM cal_feed_tokens").map((r) => r.token_hash),
    ).not.toContain(token);
    // Feed access needs only the bearer token, not a session principal.
    const anonymous = as(principal("usr_nobody", []));
    expect(ok(await anonymous(calendarServeFeed(SPACE, token)))).toContain("BEGIN:VCALENDAR");
    expect(failureTag(await anonymous(calendarServeFeed(SPACE, "A".repeat(43))))).toBe("NotFound");
    expect(failureTag(await anonymous(calendarServeFeed(SPACE, "../../etc")))).toBe("NotFound");
    const hash = store.sql.one<{ token_hash: string }>(
      "SELECT token_hash FROM cal_feed_tokens",
    )!.token_hash;
    ok(
      await user(
        calendarExecuteCommand(
          SPACE,
          envelope({ type: "RevokeFeedToken", commandId: "f2", tokenHash: hash }),
        ),
      ),
    );
    expect(failureTag(await anonymous(calendarServeFeed(SPACE, token)))).toBe("NotFound");
  });

  it("[C05] refreshes subscriptions with validators, bounded bodies, and redirect SSRF checks", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let mode: "ok" | "304" | "redirect-private" | "huge" = "ok";
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (mode === "redirect-private")
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        });
      if (mode === "304") return new Response(null, { status: 304 });
      if (mode === "huge")
        return new Response("x".repeat(6 * 1024 * 1024), {
          headers: { "content-type": "text/calendar" },
        });
      return new Response(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:h1\r\nDTSTART;VALUE=DATE:20261225\r\nSUMMARY:Christmas\r\nEND:VEVENT\r\nEND:VCALENDAR",
        {
          headers: { "content-type": "text/calendar; charset=utf-8", etag: '"abc"' },
        },
      );
    }) as typeof fetch;
    const { as, owner, store, cmd, clock } = setup(fetchFn);
    const { calendarId } = store.addSubscription({
      commandId: cmd(),
      actor: owner,
      name: "Holidays",
      color: "#0a0",
      url: "https://feeds.example.com/h.ics",
    });
    const system = as(principal("usr_system", []));
    expect(ok(await system(calendarRefreshSubscription(SPACE, calendarId, "r1")))).toMatchObject({
      imported: 1,
    });
    mode = "304";
    ok(await system(calendarRefreshSubscription(SPACE, calendarId, "r2")));
    expect(requests.at(-1)!.headers["if-none-match"]).toBe('"abc"');
    expect(
      store.listOccurrences({
        actor: owner,
        from: Date.UTC(2026, 11, 24),
        to: Date.UTC(2026, 11, 27),
        calendarIds: [calendarId],
      }),
    ).toHaveLength(1);
    mode = "redirect-private";
    const before = requests.length;
    ok(await system(calendarRefreshSubscription(SPACE, calendarId, "r3")));
    expect(requests.length).toBe(before + 1); // the private redirect target was never fetched
    expect(
      store.sql.one<{ last_status: string }>("SELECT last_status FROM cal_subscriptions")!
        .last_status,
    ).toBe("error: blocked");
    expect(store.kernel.job("subscription", calendarId)!.dueAt).toBe(clock.now() + 4 * 3_600_000);
    mode = "huge";
    ok(await system(calendarRefreshSubscription(SPACE, calendarId, "r4")));
    expect(
      store.sql.one<{ last_status: string }>("SELECT last_status FROM cal_subscriptions")!
        .last_status,
    ).toBe("error: too-large");
    // Existing contents survive failed refreshes.
    expect(
      store.listOccurrences({
        actor: owner,
        from: Date.UTC(2026, 11, 24),
        to: Date.UTC(2026, 11, 27),
        calendarIds: [calendarId],
      }),
    ).toHaveLength(1);
  });

  it("[C01] concurrent principals never share authorization context", async () => {
    const { as, owner, store, cmd } = setup();
    const { calendarId } = store.createCalendar({
      commandId: cmd(),
      actor: owner,
      name: "Private",
      color: "#000",
    });
    store.createEvent({
      commandId: cmd(),
      actor: owner,
      calendarId,
      series: {
        start: { kind: "date", date: { year: 2026, month: 9, day: 26 } },
        end: { kind: "date", date: { year: 2026, month: 9, day: 27 } },
        data: { summary: "Secret" },
      },
    });
    const query = { from: Date.UTC(2026, 8, 25), to: Date.UTC(2026, 8, 28) };
    const [mine, theirs] = await Promise.all([
      as(principal(owner, ["read"]))(calendarListOccurrences(SPACE, query)),
      as(principal("usr_stranger", ["read"]))(calendarListOccurrences(SPACE, query)),
    ]);
    expect(ok(mine)).toHaveLength(1);
    expect(ok(theirs)).toHaveLength(0);
  });
});
