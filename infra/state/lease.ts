// CI writer lease on the self-hosted state backend (§15.6 serialized deployments), in addition to
// the GitHub concurrency group. Usage:
//   node --experimental-strip-types infra/state/lease.ts acquire|renew|release|heartbeat <stack> <stage> <holder>
// Env: BYE_STATE_URL, BYE_STATE_TOKEN. Acquire waits (bounded) for a competing writer to finish.
//
// The lease has a TTL (LEASE_TTL_MS) so a crashed runner cannot block a stage forever. A deploy
// that outlives the TTL would let a second writer in, so the holder keeps it alive:
//   - `heartbeat` renews every HEARTBEAT_INTERVAL_MS until SIGTERM/SIGINT or until the lease is lost
//     (CI starts it in the background right after `acquire`; the runner reaps it at job end);
//   - `renew` is a one-shot renewal CI runs before each mutating step, failing fast if the lease
//     was lost (another holder took it after expiry).
// Renewal is an acquire by the same holder (the backend extends it; a different unexpired holder
// gets 409).

export type LeaseFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Covers the longest observed deploy with margin; renewals keep longer runs alive. */
export const LEASE_TTL_MS = 60 * 60_000;
/** Renewal cadence: many renewals per TTL, so a few failed renewals never lose the lease. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export interface LeaseOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetcher?: LeaseFetcher;
  readonly ttlMs?: number;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LeaseResult {
  readonly ok: boolean;
  readonly detail: string;
}

const lockUrl = (o: LeaseOptions, stack: string, stage: string) =>
  `${o.baseUrl.replace(/\/$/, "")}/state/locks/${encodeURIComponent(stack)}/${encodeURIComponent(stage)}`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const post = (o: LeaseOptions, stack: string, stage: string, holder: string) =>
  (o.fetcher ?? (fetch as unknown as LeaseFetcher))(lockUrl(o, stack, stage), {
    method: "POST",
    headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
    body: JSON.stringify({ holder, ttlMs: o.ttlMs ?? LEASE_TTL_MS }),
  });

export const acquireLease = async (
  o: LeaseOptions,
  stack: string,
  stage: string,
  holder: string,
): Promise<LeaseResult> => {
  const sleep = o.sleep ?? defaultSleep;
  const deadline = Date.now() + (o.waitMs ?? 15 * 60_000);
  for (;;) {
    const r = await post(o, stack, stage, holder);
    if (r.status === 200) return { ok: true, detail: "acquired" };
    if (r.status !== 409) return { ok: false, detail: `lease request failed with ${r.status}` };
    const current = (await r.json().catch(() => ({}))) as { holder?: string };
    if (Date.now() + (o.pollMs ?? 10_000) > deadline)
      return { ok: false, detail: `still held by ${current.holder ?? "another writer"}` };
    await sleep(o.pollMs ?? 10_000);
  }
};

/**
 * One renewal. `lost` means another holder owns the lease now (ours expired): the caller must stop
 * writing. Any other failure is transient; the lease is still ours until its TTL.
 */
export const renewLease = async (
  o: LeaseOptions,
  stack: string,
  stage: string,
  holder: string,
): Promise<LeaseResult & { readonly lost: boolean }> => {
  try {
    const r = await post(o, stack, stage, holder);
    if (r.status === 200) return { ok: true, lost: false, detail: "renewed" };
    if (r.status === 409) {
      const current = (await r.json().catch(() => ({}))) as { holder?: string };
      return {
        ok: false,
        lost: true,
        detail: `lease lost to ${current.holder ?? "another writer"}`,
      };
    }
    return { ok: false, lost: false, detail: `renewal failed with ${r.status}` };
  } catch (error) {
    return {
      ok: false,
      lost: false,
      detail: `renewal failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * Renew every `intervalMs` until `signal` aborts (normal end) or the lease is lost. Transient
 * renewal failures are logged and retried at the next tick; the TTL spans many ticks.
 */
export const heartbeatLease = async (
  o: LeaseOptions,
  stack: string,
  stage: string,
  holder: string,
  opts: {
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
    readonly log?: (line: string) => void;
  } = {},
): Promise<LeaseResult & { readonly renewals: number }> => {
  const sleep = o.sleep ?? defaultSleep;
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let renewals = 0;
  while (!opts.signal?.aborted) {
    await sleep(interval);
    if (opts.signal?.aborted) break;
    const r = await renewLease(o, stack, stage, holder);
    if (r.ok) renewals++;
    else opts.log?.(`lease: ${stack}/${stage}: ${r.detail}`);
    if (r.lost) return { ok: false, detail: r.detail, renewals };
  }
  return { ok: true, detail: "stopped", renewals };
};

export const releaseLease = async (
  o: LeaseOptions,
  stack: string,
  stage: string,
  holder: string,
): Promise<LeaseResult> => {
  const fetcher = o.fetcher ?? (fetch as unknown as LeaseFetcher);
  const r = await fetcher(`${lockUrl(o, stack, stage)}?holder=${encodeURIComponent(holder)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${o.token}` },
  });
  // 409 = not (or no longer) the holder, e.g. the lease expired; never fail the job on release.
  return { ok: r.status === 204 || r.status === 409, detail: `release ${r.status}` };
};

const OPS = ["acquire", "renew", "release", "heartbeat"] as const;

if (import.meta.main) {
  const [op, stack, stage, holder] = process.argv.slice(2);
  const baseUrl = process.env.BYE_STATE_URL ?? "";
  const token = process.env.BYE_STATE_TOKEN ?? "";
  if (
    !op ||
    !stack ||
    !stage ||
    !holder ||
    !baseUrl ||
    !token ||
    !(OPS as ReadonlyArray<string>).includes(op)
  ) {
    console.error(
      "usage: lease.ts acquire|renew|release|heartbeat <stack> <stage> <holder> (env BYE_STATE_URL, BYE_STATE_TOKEN)",
    );
    process.exit(2);
  }
  const o = { baseUrl, token };
  let result: LeaseResult;
  if (op === "heartbeat") {
    const stop = new AbortController();
    process.on("SIGTERM", () => stop.abort());
    process.on("SIGINT", () => stop.abort());
    const interval = Number(process.env.BYE_LEASE_HEARTBEAT_MS) || HEARTBEAT_INTERVAL_MS;
    // Sleep in short slices so a stop signal ends the loop promptly.
    const sliced = async (ms: number) => {
      const end = Date.now() + ms;
      while (!stop.signal.aborted && Date.now() < end)
        await defaultSleep(Math.min(1_000, end - Date.now()));
    };
    result = await heartbeatLease({ ...o, sleep: sliced }, stack, stage, holder, {
      intervalMs: interval,
      signal: stop.signal,
      log: (line) => console.error(line),
    });
  } else {
    result =
      op === "acquire"
        ? await acquireLease(o, stack, stage, holder)
        : op === "renew"
          ? await renewLease(o, stack, stage, holder)
          : await releaseLease(o, stack, stage, holder);
  }
  console.log(`lease: ${op} ${stack}/${stage}: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
