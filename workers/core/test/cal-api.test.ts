import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  type JsonRecord,
  makeHarness,
  mockAs,
  enablePersonalMail,
  executionContext,
} from "./harness.ts";
import { signDayPhotoUrl } from "../src/routes/calendar.ts";
import { mint } from "../src/capability.ts";
import { hmacHex } from "@bye/domain";

// Calendar API end to end over in-memory bindings: discovery of shared calendars, private feed
// tokens, day photos, subscription refresh, reminder notifications, views, and outbound iTIP.

/** An APNs-shaped push as observed at the network edge (the real notification pipeline runs). */
interface ApnsPush {
  readonly aps: { readonly alert: { readonly title: string; readonly body: string } };
  readonly url: string;
}

const apnsKeyPem = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

const ctx = executionContext;

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly calendarId: string;
  readonly address: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );

  await h.env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: "UTC",
  });
  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);

  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async <BodyValue>(
  h: Harness,
  who: Account | null,
  method: string,
  path: string,
  body?: BodyValue,
  headers: Record<string, string> = {},
) => {
  const isBytes = body instanceof Uint8Array;

  const requestHeaders = new Headers();

  if (who) requestHeaders.set("cookie", who.cookie);

  if (method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

  if (method !== "GET")
    requestHeaders.set("content-type", isBytes ? "application/octet-stream" : "application/json");

  for (const [k, v] of Object.entries(headers ?? {})) requestHeaders.set(k, v);

  const response = await handleFetch(
    new Request(
      path.startsWith("http") ? path : `${h.env.APP_ORIGIN}${path}`,
      body !== undefined
        ? { method, headers: requestHeaders, body: isBytes ? body : JSON.stringify(body) }
        : { method, headers: requestHeaders },
    ),
    h.env,
    ctx,
  );

  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body: text && type.includes("json") ? JSON.parse(text) : text,
  };
};

let n = 0;

const cmdId = () => `cmd_cal_${(++n).toString(36).padStart(16, "0")}`;

const command = (h: Harness, who: Account, space: string, cmd: JsonRecord) =>
  call(h, who, "POST", `/v1/calendars/${space}/commands`, {
    schemaVersion: 1,
    command: { commandId: cmdId(), ...cmd },
  });

const newCalendar = async (h: Harness, who: Account) => {
  const created = await command(h, who, who.calendarId, {
    type: "CreateCalendar",
    name: "Work",
    color: "#123456",
  });

  expect(created.status, JSON.stringify(created.body)).toBe(200);

  return created.body.calendarId as string;
};

const at = (y: number, mo: number, d: number, h = 0, mi = 0, tzid = "UTC") => ({
  kind: "timed",
  tzid,
  local: { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 },
});

describe("calendar API", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("[C05] grantees discover shared calendars through the directory index; revocation removes them", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const work = await newCalendar(h, ana);
    await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 10, 1, 9),
      end: at(2026, 10, 1, 10),
      data: { summary: "Planning" },
    });
    expect(
      (
        await command(h, ana, ana.calendarId, {
          type: "GrantCalendar",
          calendarId: work,
          grantee: bob.userId,
          role: "read",
        })
      ).status,
    ).toBe(200);
    await h.drain();

    const listed = await call(h, bob, "GET", "/v1/calendars");

    const shared = (
      listed.body.items as Array<{ spaceId: string; id: string; role: string; owned: boolean }>
    ).find((c) => c.id === work);

    expect(shared).toMatchObject({ spaceId: ana.calendarId, role: "read", owned: false });

    const events = await call(
      h,
      bob,
      "GET",
      `/v1/calendars/${ana.calendarId}/events?from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z&calendarIds=${work}`,
    );

    expect(
      events.body.occurrences.map((o: { data: { summary: string } }) => o.data.summary),
    ).toEqual(["Planning"]);
    // Read-only grantees cannot write.
    expect(
      (
        await command(h, bob, ana.calendarId, {
          type: "CreateEvent",
          calendarId: work,
          start: at(2026, 10, 2, 9),
          end: at(2026, 10, 2, 10),
          data: { summary: "x" },
        })
      ).status,
    ).toBe(403);

    await command(h, ana, ana.calendarId, {
      type: "RevokeCalendar",
      calendarId: work,
      grantee: bob.userId,
    });
    await h.drain();
    expect(
      (await call(h, bob, "GET", "/v1/calendars")).body.items.find(
        (c: { id: string }) => c.id === work,
      ),
    ).toBeUndefined();
  });

  it("[C05] private feed tokens: create once, fetch as ICS without private data, list, revoke → 404", async () => {
    const ana = await signup(h, "ana@bye.test");
    const work = await newCalendar(h, ana);
    await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 10, 1, 9),
      end: at(2026, 10, 1, 10),
      data: { summary: "Standup" },
      privateNote: "SECRET NOTE",
    });

    const created = await call(h, ana, "POST", `/v1/calendars/${ana.calendarId}/feed-tokens`, {
      schemaVersion: 1,
      commandId: cmdId(),
      calendarIds: [work],
      label: "Phone",
    });

    expect(created.status).toBe(201);
    const feedPath = new URL(created.body.url).pathname;
    const feed = await call(h, null, "GET", feedPath);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("text/calendar");
    expect(feed.body).toContain("SUMMARY:Standup");
    expect(feed.body).not.toContain("SECRET NOTE");
    const tokens = await call(h, ana, "GET", `/v1/calendars/${ana.calendarId}/feed-tokens`);
    expect(tokens.body.items).toHaveLength(1);
    expect(JSON.stringify(tokens.body)).not.toContain(created.body.token);
    expect(
      (
        await call(
          h,
          ana,
          "DELETE",
          `/v1/calendars/${ana.calendarId}/feed-tokens/${tokens.body.items[0].tokenHash}`,
        )
      ).status,
    ).toBe(200);
    expect((await call(h, null, "GET", feedPath)).status).toBe(404);
  });

  it("[C01] list routes answer { items } and command bodies are decoded at the boundary", async () => {
    const ana = await signup(h, "ana@bye.test");
    await newCalendar(h, ana);
    const calendars = await call(h, ana, "GET", `/v1/calendars/${ana.calendarId}/calendars`);
    expect(calendars.status).toBe(200);
    expect(calendars.body.items.length).toBeGreaterThan(0);
    expect(
      Array.isArray(
        (await call(h, ana, "GET", `/v1/calendars/${ana.calendarId}/search?q=x`)).body.items,
      ),
    ).toBe(true);
    expect(
      (
        await call(h, ana, "PATCH", `/v1/calendars/${ana.calendarId}/preferences`, {
          preferences: { hour12: true },
        })
      ).status,
    ).toBe(400); // no commandId
    expect(
      (
        await call(h, ana, "PATCH", `/v1/calendars/${ana.calendarId}/preferences`, {
          commandId: cmdId(),
          preferences: { hour12: true },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(h, ana, "POST", `/v1/calendars/${ana.calendarId}/import`, {
          commandId: cmdId(),
          ics: 5,
        })
      ).status,
    ).toBe(400);
  });

  it("[C08] day photos are owner-only, image-validated, privately stored and read through short-lived signed URLs", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    const up = await call(
      h,
      ana,
      "POST",
      `/v1/calendars/${ana.calendarId}/days/2026-09-25/photo`,
      png,
    );

    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.photoKey).toMatch(new RegExp(`^cal/${ana.calendarId}/photo/`));
    await h.drain(); // the photo is served only after the scanner marks it clean
    const photo = await call(h, null, "GET", up.body.photoUrl);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(up.body.photoUrl).toMatch(/^\/v1\/calendar-photos\?t=dayphoto\./);
    expect(
      (
        await call(
          h,
          null,
          "GET",
          up.body.photoUrl.replace(/.$/, (c: string) => (c === "A" ? "B" : "A")),
        )
      ).status,
    ).toBe(403);

    // A capability minted for another purpose over the same key is refused.
    const wrong = await mint(
      h.env.PROXY_SIGNING_KEY,
      "inline",
      [up.body.photoKey],
      60_000,
      Date.now(),
    );

    expect((await call(h, null, "GET", `/v1/calendar-photos?t=${wrong}`)).status).toBe(403);
    // Pre-unification `key/exp/sig` links are no longer accepted, even with a valid MAC.
    const exp = Date.now() + 60_000;
    const legacySig = await hmacHex(h.env.PROXY_SIGNING_KEY, `dayphoto:${up.body.photoKey}:${exp}`);
    expect(
      (
        await call(
          h,
          null,
          "GET",
          `/v1/calendar-photos?key=${encodeURIComponent(up.body.photoKey)}&exp=${exp}&sig=${legacySig}`,
        )
      ).status,
    ).toBe(403);

    const context = await call(
      h,
      ana,
      "GET",
      `/v1/calendars/${ana.calendarId}/days/2026-09-25/context`,
    );

    expect(context.body.photoUrl).toContain("/v1/calendar-photos?");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await call(h, null, "GET", up.body.photoUrl)).status).toBe(403);

    const svg = new TextEncoder().encode("<svg onload=alert(1)></svg>");
    expect(
      (await call(h, ana, "POST", `/v1/calendars/${ana.calendarId}/days/2026-09-26/photo`, svg))
        .status,
    ).toBe(400);
    const before = h.buckets.PARTS.objects.size;
    expect(
      (await call(h, bob, "POST", `/v1/calendars/${ana.calendarId}/days/2026-09-26/photo`, png))
        .status,
    ).toBe(403);
    expect(h.buckets.PARTS.objects.size).toBe(before);
  });

  it("[C08] day photos are bound to their space; replaced photos are deleted; uploads are throttled", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    const up = await call(
      h,
      ana,
      "POST",
      `/v1/calendars/${ana.calendarId}/days/2026-09-25/photo`,
      png,
    );

    expect(up.status).toBe(201);
    await h.drain();

    // Bob can't attach Ana's photo key (read from her link) to his own day and re-sign it.
    const laundered = await command(h, bob, bob.calendarId, {
      type: "SetDayDecoration",
      date: { year: 2030, month: 1, day: 1 },
      photoKey: up.body.photoKey,
    });

    expect(laundered.status).toBe(400);

    const context = await call(
      h,
      bob,
      "GET",
      `/v1/calendars/${bob.calendarId}/days/2030-01-01/context`,
    );

    expect(context.body.photoKey).toBeUndefined();
    expect(context.body.photoUrl).toBeUndefined();

    // A link is bound to the space whose day shows the photo: a mismatched space is refused.
    const crossSpace = await mint(
      h.env.PROXY_SIGNING_KEY,
      "dayphoto",
      [bob.calendarId, up.body.photoKey],
      60_000,
      Date.now(),
    );

    expect((await call(h, null, "GET", `/v1/calendar-photos?t=${crossSpace}`)).status).toBe(403);

    const legacyArity = await mint(
      h.env.PROXY_SIGNING_KEY,
      "dayphoto",
      [up.body.photoKey],
      60_000,
      Date.now(),
    );

    expect((await call(h, null, "GET", `/v1/calendar-photos?t=${legacyArity}`)).status).toBe(403);

    // Replacing the day's photo deletes the prior object; clearing it deletes the replacement.
    const next = await call(
      h,
      ana,
      "POST",
      `/v1/calendars/${ana.calendarId}/days/2026-09-25/photo`,
      png,
    );

    expect(next.status).toBe(201);
    expect(h.buckets.PARTS.objects.has(up.body.photoKey)).toBe(false);
    expect(h.buckets.PARTS.objects.has(next.body.photoKey)).toBe(true);

    const cleared = await command(h, ana, ana.calendarId, {
      type: "SetDayDecoration",
      date: { year: 2026, month: 9, day: 25 },
      photoKey: null,
    });

    expect(cleared.status).toBe(200);
    expect(h.buckets.PARTS.objects.has(next.body.photoKey)).toBe(false);

    // Uploads are rate limited per user, before any bytes are stored.
    h.rateLimit.deny = (key) => key === `dayphoto:${ana.userId}`;
    const before = h.buckets.PARTS.objects.size;

    const limited = await call(
      h,
      ana,
      "POST",
      `/v1/calendars/${ana.calendarId}/days/2026-09-26/photo`,
      png,
    );

    expect(limited.status).toBe(429);
    expect(h.buckets.PARTS.objects.size).toBe(before);
  });

  it("[C04] only the owner can invite: a write grantee can't make the owner's address send iTIP", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const work = await newCalendar(h, ana);
    expect(
      (
        await command(h, ana, ana.calendarId, {
          type: "GrantCalendar",
          calendarId: work,
          grantee: bob.userId,
          role: "write",
        })
      ).status,
    ).toBe(200);

    const invite = (who: Account, attendees: Array<{ address: string }>) =>
      command(h, who, ana.calendarId, {
        type: "CreateEvent",
        calendarId: work,
        start: at(2026, 10, 7, 15),
        end: at(2026, 10, 7, 16),
        data: { summary: "Kickoff" },
        attendees,
      });

    expect((await invite(bob, [{ address: "victim@example.net" }])).status).toBe(403);
    expect((await invite(ana, [{ address: "not an address" }])).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.net` }));
    expect((await invite(ana, many)).status).toBe(400);
    expect((await invite(ana, [{ address: "guest@example.net" }])).status).toBe(200);
  });

  it("[C05] subscriptions refresh through DNS-checked fetches and keep their schedule after errors", async () => {
    const ana = await signup(h, "ana@bye.test");
    const fetched: Array<string> = [];

    let feedBody =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:holiday-1@feeds.example\r\nDTSTAMP:20260901T000000Z\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261013\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.hostname === "cloudflare-dns.com") {
        const name = url.searchParams.get("name");
        const ip = name === "feeds.example" ? "93.184.216.34" : "10.1.2.3";

        return Response.json({
          Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: ip }] : [],
        });
      }

      fetched.push(url.toString());

      return new Response(feedBody, { headers: { "content-type": "text/calendar" } });
    }) as typeof fetch);

    const added = await command(h, ana, ana.calendarId, {
      type: "AddSubscription",
      name: "Holidays",
      color: "#0a0",
      url: "https://feeds.example/holidays.ics",
    });

    expect(added.status).toBe(200);
    const calendarDo = h.namespaces.CALENDARS.instance(ana.calendarId);
    await calendarDo.alarm();
    await h.drain();
    expect(fetched).toEqual(["https://feeds.example/holidays.ics"]);

    const events = await call(
      h,
      ana,
      "GET",
      `/v1/calendars/${ana.calendarId}/events?from=2026-10-10T00:00:00Z&to=2026-10-15T00:00:00Z`,
    );

    expect(
      events.body.occurrences.map((o: { data: { summary: string } }) => o.data.summary),
    ).toEqual(["Holiday"]);

    // A later refresh that fails still reschedules (with back-off) instead of stopping forever.
    feedBody = "not a calendar";
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    await calendarDo.alarm();
    await h.drain();

    const view: {
      store: { kernel: { job(kind: string, key: string): { dueAt: number } | undefined } };
    } = mockAs(calendarDo);

    const store = view.store;

    expect(store.kernel.job("subscription", added.body.calendarId)).toBeDefined();
  });

  it("[C02] reminders and invitation changes are delivered through the notification boundary with deep links", async () => {
    const ana = await signup(h, "ana@bye.test");
    const work = await newCalendar(h, ana);
    Object.assign(h.env, {
      APNS_KEY_P8: apnsKeyPem(),
      APNS_KEY_ID: "KEY1234567",
      APNS_TEAM_ID: "TEAM123456",
      APNS_TOPIC: "test.bye.app",
    });
    expect(
      (
        await call(h, ana, "POST", "/v1/push/subscriptions", {
          kind: "apns",
          endpoint: "ab".repeat(32),
        })
      ).status,
    ).toBe(201);
    const pushes: Array<ApnsPush> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      pushes.push(JSON.parse(await new Response(init?.body).text()));

      return new Response(null, { status: 200 });
    });
    await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 9, 25, 14),
      end: at(2026, 9, 25, 15),
      data: { summary: "Dentist" },
      alarms: [30],
    });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 13, 31));
    await h.namespaces.CALENDARS.instance(ana.calendarId).alarm();
    await h.drain();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      aps: { alert: { title: "Dentist", body: "Starts in 30 minutes" } },
    });
    expect(pushes[0]!.url).toMatch(/^bye:\/\/calendar\/event\//);

    const deliveries = await h.d1
      .prepare("SELECT dedupe_key FROM push_deliveries")
      .all<{ dedupe_key: string }>();

    expect(deliveries.results).toHaveLength(1);
    expect(deliveries.results[0]!.dedupe_key).toMatch(/^reminder:/);
  });

  it("[C01][C06][C07][C10] views, weekly tasks, habits, timer, widget, preferences and locations are served", async () => {
    const ana = await signup(h, "ana@bye.test");
    const work = await newCalendar(h, ana);
    await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 9, 25, 15),
      end: at(2026, 9, 25, 16),
      data: { summary: "Review" },
    });
    await command(h, ana, ana.calendarId, {
      type: "AddWeekTask",
      date: { year: 2026, month: 9, day: 25 },
      firstWeekday: 1,
      title: "Plan Q4",
    });

    const habit = await command(h, ana, ana.calendarId, {
      type: "CreateHabit",
      name: "Read",
      weekdays: [1, 2, 3, 4, 5],
    });

    await command(h, ana, ana.calendarId, {
      type: "SetHabitCompletion",
      habitId: habit.body.habitId,
      date: { year: 2026, month: 9, day: 25 },
      completed: true,
    });
    await command(h, ana, ana.calendarId, { type: "StartTimer", label: "Deep work" });

    const base = `/v1/calendars/${ana.calendarId}`;
    expect(
      (await call(h, ana, "GET", `${base}/day/2026-09-25`)).body.occurrences.map(
        (o: { data: { summary: string } }) => o.data.summary,
      ),
    ).toEqual(["Review"]);
    expect(
      (await call(h, ana, "GET", `${base}/agenda?from=2026-09-25&days=3`)).body.days[0].date,
    ).toBe("2026-09-25");
    expect((await call(h, ana, "GET", `${base}/month/2026/9`)).body.counts["2026-09-25"]).toBe(1);
    expect((await call(h, ana, "GET", `${base}/year/2026`)).body.counts["2026-09-25"]).toBe(1);
    expect(
      (await call(h, ana, "GET", `${base}/week-tasks?date=2026-09-25`)).body.items.map(
        (t: { title: string }) => t.title,
      ),
    ).toEqual(["Plan Q4"]);
    expect(
      (await call(h, ana, "GET", `${base}/habits?from=2026-09-21&to=2026-09-27`)).body.items[0]
        .completed,
    ).toEqual(["2026-09-25"]);
    expect((await call(h, ana, "GET", `${base}/timer`)).body.active.label).toBe("Deep work");
    const widget = await call(h, ana, "GET", `${base}/widget`);
    expect(widget.body).toMatchObject({ today: "2026-09-25", activeTimer: { label: "Deep work" } });
    expect(widget.body.upcoming[0].data.summary).toBe("Review");

    const prefs = await call(h, ana, "PATCH", `${base}/preferences`, {
      commandId: cmdId(),
      preferences: { lastView: "week", lastDate: "2026-09-25", timeZone: "Europe/London" },
    });

    expect(prefs.status).toBe(200);
    expect((await call(h, ana, "GET", `${base}/preferences`)).body).toMatchObject({
      lastView: "week",
      lastDate: "2026-09-25",
      timeZone: "Europe/London",
    });
    expect(
      (await call(h, ana, "GET", `${base}/changes?cursor=0`)).body.changes.length,
    ).toBeGreaterThan(0);
    expect((await call(h, ana, "GET", "/v1/locations?q=cafe")).body).toEqual({ items: [] });
    const ics = await call(h, ana, "GET", `${base}/export.ics`);
    expect(ics.headers.get("content-disposition")).toContain("attachment");
    expect(ics.body).toContain("SUMMARY:Review");

    const imported = await call(h, ana, "POST", `${base}/import`, {
      commandId: cmdId(),
      calendarId: work,
      ics: String(ics.body)
        .replace("SUMMARY:Review", "SUMMARY:Imported")
        .replace(/UID:[^\r\n]+/, "UID:imported-1@bye.test"),
    });

    expect(imported.body).toMatchObject({ imported: 1 });
  });

  it("[C01] a stale event write is a 409 carrying the current revision", async () => {
    const ana = await signup(h, "ana@bye.test");

    const created = await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: await newCalendar(h, ana),
      start: at(2026, 10, 1, 9),
      end: at(2026, 10, 1, 10),
      data: { summary: "Standup" },
    });

    const eventId = created.body.eventId as string;

    const update = (expectedRevision: number) =>
      command(h, ana, ana.calendarId, {
        type: "UpdateEvent",
        eventId,
        expectedRevision,
        scope: "series",
        changes: { data: { summary: `v${expectedRevision}` } },
      });

    expect((await update(1)).status).toBe(200);
    const stale = await update(1);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "conflict", details: { currentRevision: 2 } });
  });

  it("[C05] the change feed never shows a stranger or grantee the owner's private changes", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const eve = await signup(h, "eve@bye.test");
    const work = await newCalendar(h, ana);
    await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 10, 1, 9),
      end: at(2026, 10, 1, 10),
      data: { summary: "Shared" },
    });
    await command(h, ana, ana.calendarId, {
      type: "WriteJournal",
      date: { year: 2026, month: 9, day: 25 },
      body: "private",
      expectedRevision: 0,
    });
    await command(h, ana, ana.calendarId, {
      type: "GrantCalendar",
      calendarId: work,
      grantee: bob.userId,
      role: "read",
    });

    const changes = async (who: Account) =>
      (await call(h, who, "GET", `/v1/calendars/${ana.calendarId}/changes?cursor=0`)).body as {
        changes: Array<{ resource: string }>;
        cursor: number;
      };

    const own = await changes(ana);
    expect(own.changes.map((c) => c.resource)).toContain("journal");
    const granted = await changes(bob);
    expect(granted.changes.length).toBeGreaterThan(0);
    expect(granted.changes.every((c) => c.resource === "calendar" || c.resource === "event")).toBe(
      true,
    );
    expect((await changes(eve)).changes).toEqual([]);
  });

  it("[C04] organizing an event sends an iTIP REQUEST through the mailbox; deleting it sends CANCEL", async () => {
    const ana = await signup(h, "ana@bye.test");
    enablePersonalMail(h);
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify({ id: "prov-1" }), { status: 202 })) as typeof fetch,
    );
    await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const work = await newCalendar(h, ana);

    const created = await command(h, ana, ana.calendarId, {
      type: "CreateEvent",
      calendarId: work,
      start: at(2026, 10, 7, 15),
      end: at(2026, 10, 7, 16),
      data: { summary: "Kickoff" },
      attendees: [{ address: "guest@example.net" }],
    });

    await h.drain();
    await command(h, ana, ana.calendarId, {
      type: "DeleteEvent",
      eventId: created.body.eventId,
      scope: "series",
    });
    await h.drain();
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
    await h.drain();

    const mime = [...h.buckets.ORIGINALS.objects.entries()].flatMap(([k, v]) =>
      k.includes("/out/") ? [new TextDecoder().decode(v.bytes)] : [],
    );

    expect(mime.some((m) => /method=REQUEST/i.test(m) && /^To: guest@example.net/im.test(m))).toBe(
      true,
    );
    expect(mime.some((m) => /method=CANCEL/i.test(m) && /STATUS:CANCELLED/.test(m))).toBe(true);
  });
});

describe("[C08] day photos are virus-scanned before they are served", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  /**
   * A durable-step runtime stand-in: completed steps are checkpointed as JSON (what Workflows
   * persists); a checkpointed step returns its stored value without running its body again.
   * `crashAt` simulates the isolate dying just before that step starts.
   */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const ctx = executionContext;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  const setup = async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });

    await h.env.CALENDARS.getByName(account.calendarId).provision({
      ownerId: account.userId,
      selfAddresses: [account.address],
      defaultZone: "UTC",
    });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    const call = async (method: string, path: string, body?: BodyInit) => {
      const requestHeaders = new Headers({ cookie: `__Host-session=${session.token}` });

      if (method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

      const r = await handleFetch(
        new Request(
          `${h.env.APP_ORIGIN}${path}`,
          body
            ? { method, headers: requestHeaders, body: body }
            : { method, headers: requestHeaders },
        ),
        h.env,
        ctx,
      );

      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    return { account, call };
  };

  it("pending photos are withheld; a clean verdict makes them readable", async () => {
    const { account, call } = await setup();
    const up = await call("POST", `/v1/calendars/${account.calendarId}/days/2026-09-25/photo`, png);
    expect(up.status).toBe(201);
    expect(up.body.scan).toBe("pending");

    const read = () =>
      handleFetch(new Request(`${h.env.APP_ORIGIN}${up.body.photoUrl}`), h.env, ctx);

    expect((await read()).status).toBe(409);
    await h.drain();
    expect(h.scanner.scanned).toHaveLength(1);
    const served = await read();
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("an infected photo is deleted and removed from the day", async () => {
    const { account, call } = await setup();
    h.scanner.mode = "infected";
    const up = await call("POST", `/v1/calendars/${account.calendarId}/days/2026-09-25/photo`, png);
    await h.drain();
    expect(h.buckets.PARTS.objects.has(up.body.photoKey)).toBe(false);
    expect(
      (await handleFetch(new Request(`${h.env.APP_ORIGIN}${up.body.photoUrl}`), h.env, ctx)).status,
    ).toBe(404);
    const day = await call("GET", `/v1/calendars/${account.calendarId}/days/2026-09-25/context`);
    expect(day.body?.photoKey).toBeUndefined();
  });

  it("an infected photo's rejection leaves a replacement photo attached (compare-and-set)", async () => {
    const { account, call } = await setup();
    h.scanner.mode = "infected";
    const up = await call("POST", `/v1/calendars/${account.calendarId}/days/2026-09-25/photo`, png);
    const replacement = `cal/${account.calendarId}/photo/replacement00000001`;

    const set = await call(
      "POST",
      `/v1/calendars/${account.calendarId}/commands`,
      new Blob(
        [
          JSON.stringify({
            schemaVersion: 1,
            command: {
              type: "SetDayDecoration",
              commandId: "cmd_photo_replace_0001",
              date: { year: 2026, month: 9, day: 25 },
              photoKey: replacement,
            },
          }),
        ],
        { type: "application/json" },
      ),
    );

    expect(set.status).toBe(200);
    await h.drain();
    expect(h.buckets.PARTS.objects.has(up.body.photoKey)).toBe(false);
    const day = await call("GET", `/v1/calendars/${account.calendarId}/days/2026-09-25/context`);
    expect(day.body?.photoKey).toBe(replacement);
  });
});

describe("day photo scanning recovery", () => {
  const ctx = executionContext;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly calendarId: string;
    readonly token: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    await h.env.CALENDARS.getByName(account.calendarId).provision({
      ownerId: account.userId,
      selfAddresses: [address],
      defaultZone: "UTC",
    });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      calendarId: account.calendarId,
      token: session.token,
    };
  };

  const call = async (
    h: Harness,
    a: Account | null,
    method: string,
    path: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
  ) => {
    const requestHeaders = new Headers();

    if (a) requestHeaders.set("cookie", `__Host-session=${a.token}`);

    if (method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

    if (init.json !== undefined) requestHeaders.set("content-type", "application/json");

    for (const [k, v] of Object.entries(init.headers ?? {})) requestHeaders.set(k, v);

    const requestInit: RequestInit = { method, headers: requestHeaders };

    if (init.json !== undefined) requestInit.body = JSON.stringify(init.json);
    else if (init.body !== undefined) requestInit.body = init.body;

    const r = await handleFetch(new Request(`${h.env.APP_ORIGIN}${path}`, requestInit), h.env, ctx);

    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[C08] legacy (never-scanned) day photos get a scan on read and are served once clean", async () => {
    const ana = await signup(h, "ana@bye.test");
    const key = `cal/${ana.calendarId}/photo/legacy0000000000000001`;
    await h.buckets.PARTS.put(key, JPEG, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { owner: ana.userId },
    });
    const url = await signDayPhotoUrl(h.env, ana.calendarId, key, Date.now());
    const get = () => handleFetch(new Request(`${h.env.APP_ORIGIN}${url}`), h.env, ctx);
    expect((await get()).status).toBe(409);
    await h.drain();
    expect((await get()).status).toBe(200);
  });

  it("[C08] a photo is never attached to a day when its scan can't be queued", async () => {
    const ana = await signup(h, "ana@bye.test");
    const realSend = h.env.PROPAGATE.send.bind(h.env.PROPAGATE);
    (h.env.PROPAGATE as { send: unknown }).send = async () => {
      throw new Error("queue down");
    };

    const r = await call(h, ana, "POST", `/v1/calendars/${ana.calendarId}/days/2026-10-01/photo`, {
      body: JPEG,
      headers: { "content-type": "image/jpeg" },
    });

    (h.env.PROPAGATE as { send: unknown }).send = realSend;
    expect(r.status).toBe(503);
    expect(
      [...h.buckets.PARTS.objects.keys()].filter((k) =>
        k.startsWith(`cal/${ana.calendarId}/photo/`),
      ),
    ).toEqual([]);

    const day = await call(
      h,
      ana,
      "GET",
      `/v1/calendars/${ana.calendarId}/days/2026-10-01/context`,
    );

    expect(day.body?.photoKey).toBeUndefined();
  });
});

describe("day photo upload limits", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  const ctx = executionContext;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();

    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[C07] day photos: anonymous bodies are rejected before reading; chunked uploads are capped", async () => {
    const ana = await signup(h, "ana@bye.test");

    const calendarId = (await h.d1
      .prepare("SELECT id FROM calendars WHERE owner_user_id = ?")
      .bind(ana.userId)
      .first<{ id: string }>())!.id;

    await h.env.CALENDARS.getByName(calendarId).provision({
      ownerId: ana.userId,
      selfAddresses: ["ana@bye.test"],
      defaultZone: "UTC",
    });
    let pulled = 0;

    const stream = (bytes: number) =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled >= bytes) return controller.close();
            const chunk = new Uint8Array(Math.min(1 << 20, bytes - pulled));
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );

    const post = (a: Account | null, body: ReadableStream<Uint8Array>) => {
      const requestHeaders = new Headers({ origin: h.env.APP_ORIGIN });

      if (a) requestHeaders.set("cookie", `__Host-session=${a.token}`);

      return handleFetch(
        new Request(`${h.env.APP_ORIGIN}/v1/calendars/${calendarId}/days/2026-10-01/photo`, {
          method: "POST",
          headers: requestHeaders,
          body,
          duplex: "half",
        } as RequestInit),
        h.env,
        ctx,
      );
    };

    expect((await post(null, stream(50 << 20))).status).toBe(401);
    expect(pulled).toBe(0);
    pulled = 0;
    expect((await post(ana, stream(50 << 20))).status).toBe(413);
    expect(pulled).toBeLessThan(12 << 20);
  });
});
