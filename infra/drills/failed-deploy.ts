// Failed / interrupted deploy recovery drill (§13 "failed-deploy recovery", §15.6). Drives the real
// state backend (infra/state/core.ts: HTTP state contract + writer lease) and the CI lease client
// (infra/state/lease.ts) through a deploy that dies half-way, then proves the recovery procedure in
// RUNBOOK.md "Interrupted deploy":
//   1. the crashed run's lease still blocks a second writer (fail closed, no concurrent repair);
//   2. the lease is recovered — released by the recorded holder, or it expires;
//   3. re-planning the SAME release manifest resumes half-written resources in place: no persistent
//      resource is replaced and every physical ID created before the crash is kept;
//   4. re-deploying converges, and a further plan is a no-op (the two-deploy invariant).
// The apply engine is a model of Alchemy's resource lifecycle (creating → created, IDs from
// state); the backend and lease are the production code. The real-account run is EVIDENCE.md #7.
//
// Usage: node --experimental-transform-types infra/drills/failed-deploy.ts   (exit 0 = drill passed)
// (transform, not strip: infra/state/core.ts uses constructor parameter properties)
import { acquireLease, type LeaseFetcher, releaseLease } from "../state/lease.ts";
import { handleStateRequest, type StateEnv, StateStoreObject } from "../state/core.ts";

export interface ManifestResource {
  readonly fqn: string;
  readonly type: string;
  /** Persistent data (D1, R2, DO namespace, queues): replacement is never acceptable. */
  readonly persistent: boolean;
  readonly props: Readonly<Record<string, unknown>>;
}

interface StateValue {
  readonly status: "creating" | "created";
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly attr: { readonly id: string };
}

export type Step =
  | { readonly op: "create"; readonly fqn: string }
  | { readonly op: "resume"; readonly fqn: string; readonly id: string }
  | { readonly op: "update"; readonly fqn: string; readonly id: string }
  | { readonly op: "replace"; readonly fqn: string; readonly id: string }
  | { readonly op: "noop"; readonly fqn: string };

export interface DrillBackend {
  /** Route a request through the production Worker entry (auth, routing, lease, sealed state). */
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly object: StateStoreObject;
}

export interface FailedDeployReport {
  readonly crashedAfter: number;
  readonly secondWriterBlocked: boolean;
  readonly recoveredBy: "release" | "expiry";
  readonly resumePlan: ReadonlyArray<Step>;
  readonly replacements: ReadonlyArray<string>;
  readonly idsKept: boolean;
  readonly converged: boolean;
  readonly finalPlanNoop: boolean;
}

const STACK = "MailboxPlatform";

/** The drill's stand-in for a release manifest: the resource graph a reviewed commit deploys. */
export const DRILL_MANIFEST: ReadonlyArray<ManifestResource> = [
  {
    fqn: "Storage/Directory",
    type: "Cloudflare.D1.Database",
    persistent: true,
    props: { name: "directory" },
  },
  {
    fqn: "Storage/Originals",
    type: "Cloudflare.R2.Bucket",
    persistent: true,
    props: { name: "originals" },
  },
  {
    fqn: "Storage/Parts",
    type: "Cloudflare.R2.Bucket",
    persistent: true,
    props: { name: "parts" },
  },
  {
    fqn: "Queues/Ingest",
    type: "Cloudflare.Queues.Queue",
    persistent: true,
    props: { name: "ingest" },
  },
  {
    fqn: "Durable/Mailboxes",
    type: "Cloudflare.DurableObjectNamespace",
    persistent: true,
    props: { className: "MailboxDO" },
  },
  {
    fqn: "Workers/MailCore",
    type: "Cloudflare.Worker",
    persistent: false,
    props: { main: "workers/core", compatibilityDate: "2026-07-30" },
  },
  {
    fqn: "Workers/Public",
    type: "Cloudflare.Worker",
    persistent: false,
    props: { main: "workers/public" },
  },
  {
    fqn: "Queues/IngestConsumer",
    type: "Cloudflare.Queues.Consumer",
    persistent: false,
    props: { queue: "ingest", batchSize: 10 },
  },
];

const resourcePath = (stage: string, fqn: string) =>
  `/state/stacks/${STACK}/stages/${stage}/resources/${encodeURIComponent(fqn)}`;

const readState = async (
  b: DrillBackend,
  stage: string,
  fqn: string,
): Promise<StateValue | undefined> => {
  const r = await b.call(resourcePath(stage, fqn));
  if (r.status !== 200) return undefined;
  // An absent resource is answered with an empty body (the contract's "absent").
  const text = await r.text();
  return text.trim() === "" ? undefined : ((JSON.parse(text) as StateValue | null) ?? undefined);
};

const writeState = async (
  b: DrillBackend,
  stage: string,
  fqn: string,
  value: StateValue,
): Promise<void> => {
  const r = await b.call(resourcePath(stage, fqn), { method: "PUT", body: JSON.stringify(value) });
  if (r.status !== 200) throw new Error(`state write ${fqn} failed with ${r.status}`);
};

const sameProps = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Plan the manifest against recorded state, the way the engine diffs desired vs. state. */
export const planDeploy = async (
  b: DrillBackend,
  stage: string,
  manifest: ReadonlyArray<ManifestResource>,
): Promise<ReadonlyArray<Step>> => {
  const steps: Array<Step> = [];
  for (const r of manifest) {
    const s = await readState(b, stage, r.fqn);
    if (!s) steps.push({ op: "create", fqn: r.fqn });
    // A resource the crashed run began: finish it in place, keeping any physical ID it recorded.
    else if (s.status === "creating") steps.push({ op: "resume", fqn: r.fqn, id: s.attr.id });
    else if (s.type !== r.type) steps.push({ op: "replace", fqn: r.fqn, id: s.attr.id });
    else if (!sameProps(s.props, r.props)) steps.push({ op: "update", fqn: r.fqn, id: s.attr.id });
    else steps.push({ op: "noop", fqn: r.fqn });
  }
  return steps;
};

/**
 * Apply a plan. Each resource is recorded as `creating` (with its physical ID) before the provider
 * call and `created` after it, as the engine does; `crashAfter` kills the run between those writes
 * of the N-th changed resource, leaving a half-applied stage.
 */
export const applyPlan = async (
  b: DrillBackend,
  stage: string,
  manifest: ReadonlyArray<ManifestResource>,
  steps: ReadonlyArray<Step>,
  options: { readonly crashAfter?: number; readonly newId: (fqn: string) => string },
): Promise<{ readonly crashed: boolean }> => {
  let changed = 0;
  for (const step of steps) {
    if (step.op === "noop") continue;
    const r = manifest.find((m) => m.fqn === step.fqn)!;
    const id = step.op === "create" || step.op === "replace" ? options.newId(step.fqn) : step.id;
    await writeState(b, stage, r.fqn, {
      status: "creating",
      type: r.type,
      props: r.props,
      attr: { id },
    });
    changed++;
    if (options.crashAfter !== undefined && changed === options.crashAfter)
      return { crashed: true };
    await writeState(b, stage, r.fqn, {
      status: "created",
      type: r.type,
      props: r.props,
      attr: { id },
    });
  }
  return { crashed: false };
};

export const runFailedDeployDrill = async (
  b: DrillBackend,
  options: { readonly stage?: string; readonly recovery?: "release" | "expiry" } = {},
): Promise<FailedDeployReport> => {
  const stage = options.stage ?? "staging";
  const recovery = options.recovery ?? "release";
  let seq = 0;
  const newId = (fqn: string) => `${fqn.replace(/\W/g, "-").toLowerCase()}-${(++seq).toString(36)}`;
  const fetcher: LeaseFetcher = async (url, init) => {
    const u = new URL(url);
    return b.call(`${u.pathname}${u.search}`, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  };
  const lease = {
    baseUrl: "https://state.drill",
    token: "unused",
    fetcher,
    waitMs: 0,
    pollMs: 1,
    sleep: async () => undefined,
  };

  // Run 1 takes the lease, plans, and dies half-way through apply (runner lost; lease NOT released).
  if (!(await acquireLease(lease, STACK, stage, "gha-run-1")).ok)
    throw new Error("run 1 could not take the lease");
  const firstPlan = await planDeploy(b, stage, DRILL_MANIFEST);
  const crashAfter = Math.ceil(DRILL_MANIFEST.length / 2);
  await applyPlan(b, stage, DRILL_MANIFEST, firstPlan, { crashAfter, newId });
  const idsBeforeCrash = new Map<string, string>();
  for (const r of DRILL_MANIFEST) {
    const s = await readState(b, stage, r.fqn);
    if (s) idsBeforeCrash.set(r.fqn, s.attr.id);
  }

  // Step 1: a second writer is refused while the crashed run's lease is live.
  const blocked = await acquireLease(lease, STACK, stage, "gha-run-2");

  // Step 2: recover the lease — the operator releases it as the recorded holder, or it expires.
  if (recovery === "release") await releaseLease(lease, STACK, stage, "gha-run-1");
  else b.object.acquireLock(STACK, stage, "gha-run-1", 1_000, Date.now() - 2 * 6 * 3600_000); // backdate: already expired
  const retaken = await acquireLease(lease, STACK, stage, "gha-run-2");
  if (!retaken.ok) throw new Error(`recovery could not take the lease: ${retaken.detail}`);

  // Step 3: re-plan the same manifest. Nothing persistent may be replaced; begun resources resume.
  const resumePlan = await planDeploy(b, stage, DRILL_MANIFEST);
  const replacements = resumePlan
    .filter((s) => s.op === "replace" && DRILL_MANIFEST.find((m) => m.fqn === s.fqn)!.persistent)
    .map((s) => s.fqn);

  // Step 4: re-deploy the same manifest, then verify convergence and a no-op follow-up plan.
  await applyPlan(b, stage, DRILL_MANIFEST, resumePlan, { newId });
  await releaseLease(lease, STACK, stage, "gha-run-2");
  let converged = true;
  let idsKept = true;
  for (const r of DRILL_MANIFEST) {
    const s = await readState(b, stage, r.fqn);
    if (!s || s.status !== "created" || !sameProps(s.props, r.props)) converged = false;
    const before = idsBeforeCrash.get(r.fqn);
    if (before !== undefined && s?.attr.id !== before) idsKept = false;
  }
  const finalPlan = await planDeploy(b, stage, DRILL_MANIFEST);
  return {
    crashedAfter: crashAfter,
    secondWriterBlocked: !blocked.ok,
    recoveredBy: recovery,
    resumePlan,
    replacements,
    idsKept,
    converged,
    finalPlanNoop: finalPlan.every((s) => s.op === "noop"),
  };
};

/** In-memory backend: the production state object and Worker entry over node:sqlite storage. */
export const memoryBackend = async (): Promise<DrillBackend> => {
  const { MemoryDurableStorage } = await import("../../packages/testing/src/sqlite.ts");
  const token = "drill-state-token-0123456789abcdef";
  const puts = new Map<string, string>();
  const env: StateEnv = {
    STATE_TOKEN: token,
    STATE_ENCRYPTION_KEY: `v1:${"cd".repeat(32)}`,
    BACKUPS: {
      put: async (k: string, v: string) => void puts.set(k, v),
      get: async (k: string) => (puts.has(k) ? { text: async () => puts.get(k)! } : null),
      list: async ({ prefix }) => ({
        objects: [...puts.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
      delete: async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) puts.delete(k);
      },
    },
    STATE: { getByName: () => object },
  };
  const object = new StateStoreObject({ storage: new MemoryDurableStorage() as never }, env);
  const call = (path: string, init: RequestInit = {}) =>
    handleStateRequest(
      new Request(`https://state.drill${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
      env,
    );
  return { call, object };
};

export const drillPassed = (r: FailedDeployReport): boolean =>
  r.secondWriterBlocked &&
  r.replacements.length === 0 &&
  r.idsKept &&
  r.converged &&
  r.finalPlanNoop &&
  r.resumePlan.some((s) => s.op === "resume");

if (import.meta.main) {
  const reports = [
    await runFailedDeployDrill(await memoryBackend(), { recovery: "release" }),
    await runFailedDeployDrill(await memoryBackend(), { recovery: "expiry" }),
  ];
  console.log(JSON.stringify(reports, null, 2));
  process.exit(reports.every(drillPassed) ? 0 : 1);
}
