// Deployment health (spec.md §15.11 step 4, OB06). Ready means every required check passed within
// its timeout: the public discovery documents native apps validate, the unauthenticated API
// contract, render-origin isolation, the public site, and the existing post-deploy probes (queue,
// Durable Object alarm, Workflow checkpoint, calendar write) on synthetic probe data. Nothing here
// reads a mailbox, and none of it says anything about inbound mail: that needs the manual cutover.
import { runProbes } from "../probes/run.ts";
import type { Fetch } from "./oauth.ts";
import type { HealthResult, InstanceUrls } from "./store.ts";

export const HEALTH_TIMEOUT_MS = 15_000;
export const ASYNC_PROBE_TIMEOUT_MS = 90_000;

/** A fetch that gives up after `ms`, so a hung endpoint fails its check instead of stalling. */
export const withTimeout =
  (fetcher: Fetch, ms: number): Fetch =>
  (url, init) =>
    fetcher(url, { ...init, signal: AbortSignal.timeout(ms), redirect: "manual" });

const check = async (name: string, fn: () => Promise<[boolean, string]>): Promise<HealthResult> => {
  const t0 = Date.now();
  try {
    const [ok, detail] = await fn();
    return { name, ok, ms: Date.now() - t0, detail };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      detail: timeout ? "timed out" : error instanceof Error ? error.message : String(error),
    };
  }
};

export const runHealthChecks = async (
  urls: InstanceUrls,
  probeToken: string,
  fetcher: Fetch,
  timeouts: { readonly request?: number; readonly async?: number } = {},
): Promise<ReadonlyArray<HealthResult>> => {
  const f = withTimeout(fetcher, timeouts.request ?? HEALTH_TIMEOUT_MS);
  const results: Array<HealthResult> = [];
  results.push(
    await check("instance.document", async () => {
      const r = await f(`${urls.app}/.well-known/bye-instance`);
      const doc = (await r.json().catch(() => null)) as {
        schema?: string;
        baseUrl?: string;
        issuer?: string;
      } | null;
      const ok = r.status === 200 && doc?.schema === "bye.instance/1" && doc.baseUrl === urls.app;
      return [ok, ok ? "compatible" : `status ${r.status}, baseUrl ${doc?.baseUrl ?? "missing"}`];
    }),
  );
  results.push(
    await check("instance.oauth-metadata", async () => {
      const r = await f(`${urls.app}/.well-known/oauth-authorization-server`);
      const doc = (await r.json().catch(() => null)) as { issuer?: string } | null;
      return [r.status === 200 && doc?.issuer === urls.app, `issuer ${doc?.issuer ?? "missing"}`];
    }),
  );
  results.push(
    await check("render.isolated", async () => {
      // The render host must not serve the API.
      const r = await f(`${urls.render}/v1/me`);
      return [r.status === 404, `render host /v1/me → ${r.status}`];
    }),
  );
  results.push(
    await check("public.reachable", async () => {
      const r = await f(`${urls.site}/`);
      return [r.status < 500, `status ${r.status}`];
    }),
  );
  // http.unauthenticated, queue.round-trip, do.alarm, workflow.checkpoint, calendar.event.
  const probes = await runProbes(urls.app, probeToken, f, timeouts.async ?? ASYNC_PROBE_TIMEOUT_MS);
  results.push(...probes.map((p) => ({ name: p.name, ok: p.ok, ms: p.ms, detail: p.detail })));
  return results;
};
