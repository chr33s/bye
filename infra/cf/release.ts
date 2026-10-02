import type { Plan } from "../policies/plan-policy.ts";
import { canaryDecision, type ProbeReport } from "../policies/canary.ts";
import { requireStage } from "../resources/stage.ts";
import { planResources } from "./plan.ts";
import { verifyFreshApproval, type ApprovalInputs } from "./evidence.ts";
import { canonical, digest } from "./plan-normalize.ts";
import {
  assertBoundary,
  assertNoSecrets,
  type Adoption,
  type Resource,
  type ResourceMap,
  type Snapshot,
} from "./schemas.ts";
import { writerKey, type WriterLocks } from "./locks.ts";

export interface BuiltWorker {
  readonly logicalId: string;
  readonly name: string;
  readonly directory: string;
  readonly digest: string;
}

export interface UploadedWorker extends BuiltWorker {
  readonly versionId: string;
  readonly previousVersionId?: string;
}

export type ReleasePhase =
  | "validated"
  | "approved"
  | "provisioned"
  | "built"
  | "migrated"
  | "uploaded"
  | "traffic"
  | "triggers"
  | "reconciled"
  | "probed"
  | "promoted"
  | "failed"
  | "unknown";

export interface ReleaseEvent {
  readonly phase: ReleasePhase;
  readonly approval: string;
  readonly workers: ReadonlyArray<{
    readonly name: string;
    readonly versionId: string;
    readonly previousVersionId?: string;
  }>;
  readonly detail: string;
  readonly leaseId?: string;
  readonly builds: ReadonlyArray<{ readonly name: string; readonly digest: string }>;
}

/** Every mutating adapter receives the lease assertion; compound adapters must check before each API write. */
export interface ReleasePorts {
  readonly locks: WriterLocks;
  discover(map: ResourceMap): Promise<Snapshot>;
  desired(map: ResourceMap): ReadonlyArray<Resource>;
  subject(map: ResourceMap, discovery: Snapshot, plan: Plan): Promise<ApprovalInputs>;
  provision(
    plan: Plan,
    desired: ReadonlyArray<Resource>,
    map: ResourceMap,
    beforeWrite: () => Promise<void>,
  ): Promise<ResourceMap>;
  resolve?(map: ResourceMap): Promise<ResourceMap>;
  build(map: ResourceMap): Promise<ReadonlyArray<BuiltWorker>>;
  verifyBuild(worker: BuiltWorker): Promise<void>;
  migrate(map: ResourceMap, beforeWrite: () => Promise<void>): Promise<void>;
  upload(worker: BuiltWorker, beforeWrite: () => Promise<void>): Promise<UploadedWorker>;
  traffic(
    worker: UploadedWorker,
    versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>,
    beforeWrite: () => Promise<void>,
  ): Promise<void>;
  triggers(worker: BuiltWorker, beforeWrite: () => Promise<void>): Promise<void>;
  reconcile(
    plan: Plan,
    desired: ReadonlyArray<Resource>,
    beforeWrite: () => Promise<void>,
  ): Promise<void>;
  probes(core: UploadedWorker): Promise<ProbeReport>;
  record(event: ReleaseEvent): Promise<void>;
}

export interface ReleaseRequest {
  readonly engine: string;
  readonly map: ResourceMap;
  readonly adoption?: Adoption;
  readonly initialStage?: boolean;
  readonly approvedDigest: string;
  readonly owner: string;
  readonly installation?: string;
  readonly canaryPercent: number;
  readonly durableLifecycleChanged: boolean;
  readonly acknowledgeLifecycle: boolean;
}

const WORKER_OWNED = new Set([
  "Cloudflare.Worker",
  "Cloudflare.DurableObject",
  "Cloudflare.Container",
  "Cloudflare.Workflow",
  "Cloudflare.Queues.Consumer",
  "Cloudflare.Email.SendEmail",
  "Cloudflare.RateLimit",
]);

const ACCOUNT_OWNED = new Set([
  "Cloudflare.D1.Database",
  "Cloudflare.KV.Namespace",
  "Cloudflare.R2.Bucket",
  "Cloudflare.Queues.Queue",
]);

/** Validate supported actions before provisioning, not halfway through a release. */
export const validateReleasePlan = (plan: Plan): void => {
  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;

    if (!["create", "update"].includes(entry.action))
      throw new Error(
        "release cannot execute destructive actions; use a reviewed lifecycle/decommission procedure",
      );

    if (!WORKER_OWNED.has(entry.type) && !ACCOUNT_OWNED.has(entry.type))
      throw new Error(`no release adapter for ${entry.type}`);

    if (
      entry.action === "update" &&
      ACCOUNT_OWNED.has(entry.type) &&
      entry.type !== "Cloudflare.R2.Bucket"
    )
      throw new Error(`no settings update adapter for ${entry.type}`);
  }
};

/** Approval is recomputed while holding the shared writer authority. Opt-in never implies approval. */
export const release = async (request: ReleaseRequest, ports: ReleasePorts): Promise<void> => {
  if (request.engine !== "cf") throw new Error("cf release requires explicit opt-in");
  const stage = requireStage(request.map.stage);

  if (stage.persistent && !request.adoption && !request.initialStage)
    throw new Error("persistent cf release requires reviewed adoption");

  if (
    !Number.isInteger(request.canaryPercent) ||
    request.canaryPercent <= 0 ||
    request.canaryPercent > 100
  )
    throw new Error("invalid canary percentage");

  if (
    request.durableLifecycleChanged &&
    (!request.acknowledgeLifecycle || request.canaryPercent !== 100)
  )
    throw new Error("DO lifecycle release requires acknowledged full rollout");

  if (request.initialStage && (request.adoption || request.canaryPercent !== 100))
    throw new Error("first deployment requires full rollout without an adoption manifest");

  if (request.adoption) assertBoundary(request.adoption, stage.name, request.map.accountId);

  const lease = await ports.locks.acquire(
    writerKey(request.map.accountId, stage.name, request.installation),
    request.owner,
  );

  const uploaded: Array<UploadedWorker> = [];
  let built: ReadonlyArray<BuiltWorker> = [];
  let writing = false;
  let restoredTraffic = false;
  let retainLease = false;

  const record = async (phase: ReleasePhase, detail = "") => {
    const event = {
      phase,
      approval: request.approvedDigest,
      workers: uploaded.map(({ name, versionId, previousVersionId }) =>
        previousVersionId ? { name, versionId, previousVersionId } : { name, versionId },
      ),
      detail,
      builds: built.map(({ name, digest }) => ({ name, digest })),
    };

    assertNoSecrets(event);
    await ports.record(lease.leaseId ? { ...event, leaseId: lease.leaseId } : event);
  };

  const beforeWrite = async () => {
    await lease.assertHeld();
    writing = true;
  };

  try {
    await lease.assertHeld();
    await record("validated");
    const discovery = await ports.discover(request.map);
    const desired = ports.desired(request.map);

    const plan = planResources({
      stage: stage.name,
      accountId: request.map.accountId,
      desired,
      discovery,
      adoption: request.adoption,
    });

    if (request.initialStage && plan.entries.some((entry) => entry.action !== "create"))
      throw new Error(
        "first-deployment path requires every owned resource to be absent; adopt/review existing identities",
      );
    validateReleasePlan(plan);
    const subject = await ports.subject(request.map, discovery, plan);

    if (
      subject.stage !== stage.name ||
      subject.resourceMapDigest !== digest(request.map) ||
      subject.discoveryDigest !== digest(discovery) ||
      subject.plan !== plan ||
      subject.accountId !== request.map.accountId
    )
      throw new Error("release subject does not describe fresh inputs");
    verifyFreshApproval(request.approvedDigest, subject);
    await record("approved");
    let map = await ports.provision(plan, desired, request.map, beforeWrite);
    assertBoundary(map, stage.name, request.map.accountId);

    // Only approved creates may resolve generated IDs. Existing IDs must remain byte-for-byte identical.
    for (const group of [
      "d1",
      "kv",
      "queues",
      "r2",
      "workers",
      "workflows",
      "containers",
      "durableObjects",
    ] as const) {
      for (const [id, identity] of Object.entries(request.map[group] ?? {})) {
        const changed = canonical(identity) !== canonical(map[group]?.[id]);

        if (
          changed &&
          !plan.entries.some((entry) => entry.logicalId === id && entry.action === "create")
        )
          throw new Error("provisioning changed an unapproved identity");
      }
    }

    await record("provisioned");
    built = await ports.build(map);
    const expected = Object.entries(map.workers);

    if (
      built.length !== expected.length ||
      new Set(built.map((worker) => worker.logicalId)).size !== built.length ||
      expected.some(
        ([id, worker]) => !built.some((item) => item.logicalId === id && item.name === worker.name),
      )
    )
      throw new Error("build does not cover resolved Worker inventory");

    for (const worker of built) await ports.verifyBuild(worker);
    await record("built");
    verifyFreshApproval(request.approvedDigest, await ports.subject(request.map, discovery, plan));
    await ports.migrate(map, beforeWrite);
    await record("migrated");

    for (const worker of built) {
      await ports.verifyBuild(worker);
      const version = await ports.upload(worker, beforeWrite);

      if (
        version.name !== worker.name ||
        version.digest !== worker.digest ||
        !version.versionId ||
        (request.canaryPercent < 100 && !version.previousVersionId)
      )
        throw new Error("upload returned invalid version identity");
      uploaded.push(version);
      await record("uploaded");
    }

    for (const worker of uploaded) {
      const percent = worker.logicalId === "MailCore" ? request.canaryPercent : 100;
      const versions = [{ version_id: worker.versionId, percentage: percent }];

      if (percent < 100)
        versions.push({ version_id: worker.previousVersionId!, percentage: 100 - percent });
      // A lost response after traffic write has an unknown outcome and must never be replayed.
      await ports.traffic(worker, versions, beforeWrite);
    }

    await record("traffic");

    for (const worker of uploaded) {
      await ports.verifyBuild(worker);
      await ports.triggers(worker, beforeWrite);
    }

    await record("triggers");
    await ports.reconcile(plan, ports.desired(map), beforeWrite);
    await record("reconciled");
    const core = uploaded.find((worker) => worker.logicalId === "MailCore");

    if (!core) throw new Error("release has no MailCore probe target");
    const report = await ports.probes(core);
    await record("probed", canaryDecision(report));

    if (canaryDecision(report) !== "promote") {
      if (request.durableLifecycleChanged || uploaded.some((worker) => !worker.previousVersionId))
        throw new Error("probes failed; traffic rollback requires operator reconciliation");

      for (const worker of [...uploaded].reverse())
        await ports.traffic(
          worker,
          [{ version_id: worker.previousVersionId!, percentage: 100 }],
          beforeWrite,
        );
      restoredTraffic = true;
      throw new Error(
        "probes failed; previous traffic restored; triggers and account settings require fresh review",
      );
    }

    if (request.canaryPercent < 100)
      await ports.traffic(core, [{ version_id: core.versionId, percentage: 100 }], beforeWrite);

    if (ports.resolve) {
      const resolved = await ports.resolve(map);
      assertBoundary(resolved, stage.name, request.map.accountId);

      for (const group of [
        "d1",
        "kv",
        "r2",
        "queues",
        "workers",
        "workflows",
        "containers",
        "durableObjects",
      ] as const) {
        for (const [id, identity] of Object.entries(resolved[group] ?? {})) {
          if (
            canonical(identity) !== canonical(map[group]?.[id]) &&
            !plan.entries.some((entry) => entry.logicalId === id && entry.action === "create")
          )
            throw new Error("post-deploy identity resolution changed an unapproved resource");
        }
      }

      map = resolved;
    }

    const finalDiscovery = await ports.discover(map);

    const finalPlan = planResources({
      stage: stage.name,
      accountId: map.accountId,
      desired: ports.desired(map),
      discovery: finalDiscovery,
      adoption: request.adoption,
    });

    if (finalPlan.entries.some((entry) => entry.action !== "noop"))
      throw new Error("post-release drift remains; release is not complete");
    await record("promoted");
  } catch (cause) {
    retainLease = writing && !restoredTraffic;

    // Read-only reconciliation is mandatory before any later fresh approval/retry.
    if (writing) {
      try {
        await ports.discover(request.map);
      } catch {
        /* Evidence remains unknown when live reads fail. */
      }
    }

    await record(
      writing && !restoredTraffic ? "unknown" : "failed",
      "release stopped; obtain a fresh discovery and approval before retrying",
    );
    throw cause;
  } finally {
    if (!retainLease) await lease.release();
  }
};
