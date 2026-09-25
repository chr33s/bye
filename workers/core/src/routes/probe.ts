import { isRejection } from "@bye/platform-cloudflare";
import { calendar, settle } from "../authorities.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, json, route, type Route } from "../http.ts";
import { PROBE_TTL_SECONDS, probeKey } from "../probe.ts";

// Operator-only post-deploy probes (§15.10). Guarded by the PROBE_TOKEN secret (header
// `x-bye-probe-token`); disabled when the secret is empty. Never exposes user data.

const ID = /^[A-Za-z0-9_-]{8,64}$/;

const authorized = (request: Request, env: CoreEnv): boolean => {
  const expected = (env.PROBE_TOKEN ?? "").trim();
  const got = request.headers.get("x-bye-probe-token") ?? "";
  if (!expected || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};

const guarded =
  (handler: (request: Request, id: string, env: CoreEnv) => Promise<Response>) =>
  async (
    request: Request,
    params: Readonly<Record<string, string>>,
    env: CoreEnv,
  ): Promise<Response> => {
    if (!authorized(request, env)) return errorResponse("not_found", "not found");
    const id = params.id ?? "";
    if (!ID.test(id)) return errorResponse("bad_request", "invalid probe id");
    return handler(request, id, env);
  };

export const probeRoutes: ReadonlyArray<Route<CoreEnv>> = [
  route(
    "POST",
    "/__probe/queue/:id",
    guarded(async (_r, id, env) => {
      await env.PROPAGATE.send(
        {
          schemaVersion: 1,
          type: "propagate",
          eventId: `probe:${id}`,
          topic: "probe.echo",
          source: "probe",
          target: id,
          payload: { topic: "probe.echo", probeId: id },
        },
        { contentType: "json" },
      );
      return json({ sent: true, ttlSeconds: PROBE_TTL_SECONDS }, 202);
    }),
  ),
  route(
    "GET",
    "/__probe/queue/:id",
    guarded(async (_r, id, env) =>
      json({ receivedAt: await env.CONFIG_CACHE.get(probeKey("queue", id)) }),
    ),
  ),
  route(
    "POST",
    "/__probe/alarm/:id",
    guarded(async (_r, id, env) => json(await env.PROBES.getByName(id).arm(1_000), 202)),
  ),
  route(
    "GET",
    "/__probe/alarm/:id",
    guarded(async (_r, id, env) => json(await env.PROBES.getByName(id).status())),
  ),
  route(
    "POST",
    "/__probe/workflow/:id",
    guarded(async (_r, id, env) => {
      await env.PROBE_WORKFLOW.create({ id: `probe-${id}`, params: { v: 1, probeId: id } });
      return json({ created: true }, 202);
    }),
  ),
  route(
    "GET",
    "/__probe/workflow/:id",
    guarded(async (_r, id, env) => {
      const instance = await env.PROBE_WORKFLOW.get(`probe-${id}`);
      const status = await instance.status();
      return json({
        status: status.status,
        marker: await env.CONFIG_CACHE.get(probeKey("workflow", id)),
      });
    }),
  ),
  // Calendar authority: a throwaway `probe-cal-<id>` CalendarDO writes an event through the real
  // command path and reads it back through the occurrence engine (SQLite + recurrence + zones).
  // Its storage is erased afterwards (pass or fail), so repeated probes leave no DO state behind.
  route(
    "POST",
    "/__probe/calendar/:id",
    guarded(async (_r, id, env) => {
      const owner = `probe-owner-${id}`;
      const cal = calendar(env, `probe-cal-${id}`);
      let step = "provision";
      try {
        await cal.provision({
          ownerId: owner,
          selfAddresses: [`probe-${id}@probe.invalid`],
          defaultZone: "Europe/London",
        });
        step = "create-calendar";
        const created = await settle(
          cal.execute(owner, {
            type: "CreateCalendar",
            commandId: `probe-${id}-cal`,
            name: "probe",
            color: "#000000",
          }),
        );
        const calendarId = (created as { calendarId?: unknown } | null)?.calendarId;
        if (typeof calendarId !== "string")
          return json({ ok: false, step, code: "invalid_result" }, 500);
        step = "create-event";
        const at = (hour: number) => ({
          kind: "timed" as const,
          tzid: "Europe/London",
          local: { year: 2030, month: 3, day: 31, hour, minute: 0, second: 0 },
        });
        await settle(
          cal.execute(owner, {
            type: "CreateEvent",
            commandId: `probe-${id}-evt`,
            calendarId,
            data: { summary: `probe ${id}` },
            start: at(9),
            end: at(10),
            rrule: "FREQ=DAILY;COUNT=2",
          }),
        );
        step = "occurrences";
        const found = await settle(
          cal.read(owner, {
            type: "Occurrences",
            from: Date.UTC(2030, 2, 30),
            to: Date.UTC(2030, 3, 3),
          }),
        );
        // 31 March 2030 is after the UK spring-forward: 09:00 BST = 08:00Z; the second occurrence follows.
        const starts = (Array.isArray(found) ? found : []).map((o: { startMs: number }) =>
          new Date(o.startMs).toISOString(),
        );
        const ok =
          starts.length === 2 &&
          starts[0] === "2030-03-31T08:00:00.000Z" &&
          starts[1] === "2030-04-01T08:00:00.000Z";
        return json({ ok, starts });
      } catch (e) {
        if (isRejection(e)) return json({ ok: false, step, code: e.code }, 500);
        throw e;
      } finally {
        await cal.eraseAll().catch(() => undefined);
      }
    }),
  ),
];
