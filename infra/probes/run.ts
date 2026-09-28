// Post-deploy verification (§15.10 "Deploy and verify", §15.9 canary). Exercises HTTP and the
// async paths a canary must cover: queue → consumer, Durable Object alarm, Workflow checkpoint.
//
// Usage: PROBE_BASE_URL=https://app.<stage> PROBE_TOKEN=… node --experimental-strip-types infra/probes/run.ts
// Exit 0 only when every probe passes; the JSON report is uploaded with the release artifact.
//
// Canary: during a gradual rollout only a fraction of requests reach the new version, so probes
// would mostly test the old one. With PROBE_WORKER_NAME and PROBE_VERSION_ID (the stack outputs
// `coreWorkerName`/`coreVersionId`, read by infra/state/output.ts), every probe request carries
// `Cloudflare-Workers-Version-Overrides: <worker>="<version id>"`, pinning it to the new version.

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const poll = async <T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> => {
  const end = Date.now() + timeoutMs;

  for (;;) {
    const v = await fn();

    if (done(v) || Date.now() > end) return v;
    await sleep(intervalMs);
  }
};

export interface VersionOverride {
  readonly worker: string;
  readonly versionId: string;
}

/** `Cloudflare-Workers-Version-Overrides` value (a Structured Fields dictionary). */
export const versionOverrideHeader = (o: VersionOverride): string => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.worker)) throw new Error("invalid Worker name for override");

  if (!/^[0-9a-f-]{8,64}$/i.test(o.versionId)) throw new Error("invalid version id for override");

  return `${o.worker}="${o.versionId}"`;
};

export const runProbes = async (
  base: string,
  token: string,
  fetcher: Fetcher = fetch,
  timeoutMs = 60_000,
  override?: VersionOverride,
): Promise<ReadonlyArray<ProbeResult>> => {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const pin: Record<string, string> = override
    ? { "cloudflare-workers-version-overrides": versionOverrideHeader(override) }
    : {};

  const raw = fetcher;
  fetcher = (url, init) =>
    raw(url, { ...init, headers: { ...pin, ...(init?.headers as Record<string, string>) } });
  const headers = { "x-bye-probe-token": token };
  const results: Array<ProbeResult> = [];

  const probe = async (name: string, fn: () => Promise<[boolean, string]>) => {
    const t0 = Date.now();

    try {
      const [ok, detail] = await fn();
      results.push({ name, ok, ms: Date.now() - t0, detail });
    } catch (error) {
      results.push({
        name,
        ok: false,
        ms: Date.now() - t0,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await probe("http.unauthenticated", async () => {
    const r = await fetcher(`${base}/v1/me`);
    const body = (await r.json().catch(() => null)) as { error?: { code?: string } } | null;

    return [r.status === 401 && body?.error?.code === "unauthenticated", `status ${r.status}`];
  });
  await probe("http.probe-guard", async () => {
    const r = await fetcher(`${base}/__probe/queue/${id}`);

    return [r.status === 404, `unauthenticated probe → ${r.status}`];
  });
  await probe("queue.round-trip", async () => {
    const sent = await fetcher(`${base}/__probe/queue/${id}`, { method: "POST", headers });

    if (sent.status !== 202) return [false, `send ${sent.status}`];

    const got = await poll(
      async () =>
        (await (await fetcher(`${base}/__probe/queue/${id}`, { headers })).json()) as {
          receivedAt: string | null;
        },
      (v) => v.receivedAt !== null,
      timeoutMs,
    );

    return [got.receivedAt !== null, got.receivedAt ? "consumed" : "not consumed before timeout"];
  });
  await probe("do.alarm", async () => {
    const armed = await fetcher(`${base}/__probe/alarm/${id}`, { method: "POST", headers });

    if (armed.status !== 202) return [false, `arm ${armed.status}`];

    const s = await poll(
      async () =>
        (await (await fetcher(`${base}/__probe/alarm/${id}`, { headers })).json()) as {
          firedAt: number | null;
        },
      (v) => v.firedAt !== null,
      timeoutMs,
    );

    return [s.firedAt !== null, s.firedAt ? "fired" : "alarm did not fire"];
  });
  await probe("workflow.checkpoint", async () => {
    const created = await fetcher(`${base}/__probe/workflow/${id}`, { method: "POST", headers });

    if (created.status !== 202) return [false, `create ${created.status}`];

    const s = await poll(
      async () =>
        (await (await fetcher(`${base}/__probe/workflow/${id}`, { headers })).json()) as {
          status: string;
          marker: string | null;
        },
      (v) => v.status === "complete" || v.status === "errored",
      timeoutMs,
    );

    return [s.status === "complete" && s.marker !== null, `status ${s.status}`];
  });
  await probe("calendar.event", async () => {
    const r = await fetcher(`${base}/__probe/calendar/${id}`, { method: "POST", headers });

    const body = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      starts?: ReadonlyArray<string>;
      step?: string;
    };

    return [
      r.status === 200 && body.ok === true,
      body.ok ? "event written and expanded" : `failed at ${body.step ?? `status ${r.status}`}`,
    ];
  });

  return results;
};

if (import.meta.main) {
  const base = process.env.PROBE_BASE_URL ?? "";
  const token = process.env.PROBE_TOKEN ?? "";

  if (!base || !token) {
    console.error("probes: set PROBE_BASE_URL and PROBE_TOKEN");
    process.exit(2);
  }

  const worker = process.env.PROBE_WORKER_NAME ?? "";
  const versionId = process.env.PROBE_VERSION_ID ?? "";
  const override = worker && versionId ? { worker, versionId } : undefined;
  const results = await runProbes(base.replace(/\/$/, ""), token, fetch, 60_000, override);
  console.log(
    JSON.stringify(
      { at: new Date().toISOString(), versionOverride: override ?? null, results },
      null,
      2,
    ),
  );
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
