import type { DecommissionRecord } from "../policies/plan-policy.ts";
import { requireStage } from "../resources/stage.ts";
import { canonical, digest } from "./plan-normalize.ts";
import { assertBoundary, assertNoSecrets, type Resource, type Snapshot } from "./schemas.ts";
import { type OperationRunner } from "./operations.ts";
import { writerKey, type WriterLocks } from "./locks.ts";

const deleteArgs = (resource: Resource): ReadonlyArray<string> => {
  const identity = resource.identity;

  const required = (key: string) => {
    if (!identity[key]) throw new Error(`delete identity is missing ${key}`);

    return identity[key];
  };

  switch (resource.type) {
    case "Cloudflare.Worker":
      return ["workers", "delete", required("name"), "--force"];
    case "Cloudflare.Workflow":
      return ["workflows", "delete", required("name"), "--force"];
    case "Cloudflare.Container":
      return ["containers", "applications", "delete", required("applicationId"), "--force"];
    case "Cloudflare.D1.Database":
      return ["d1", "delete", required("id"), "--force"];
    case "Cloudflare.KV.Namespace":
      return ["kv", "namespaces", "delete", required("id"), "--force"];
    case "Cloudflare.Queues.Queue":
      return ["queues", "delete", required("id"), "--force"];
    case "Cloudflare.R2.Bucket":
      return ["r2", "buckets", "delete", required("name"), "--force"];
    default:
      throw new Error(`no reviewed deletion contract for ${resource.type}`);
  }
};

const key = (resource: Resource) => `${resource.type}/${resource.logicalId}`;

const workerManaged = new Set([
  "Cloudflare.DurableObject",
  "Cloudflare.Queues.Consumer",
  "Cloudflare.Email.SendEmail",
  "Cloudflare.RateLimit",
]);

const deleteOrder = [
  "Cloudflare.Container",
  "Cloudflare.Workflow",
  "Cloudflare.Worker",
  "Cloudflare.Queues.Queue",
  "Cloudflare.KV.Namespace",
  "Cloudflare.D1.Database",
  "Cloudflare.R2.Bucket",
];

export const destructionSubject = (
  snapshot: Snapshot,
  records: ReadonlyArray<DecommissionRecord>,
) => {
  assertNoSecrets(snapshot);

  return {
    format: "bye.cf-destroy.v1",
    snapshot,
    records: [...records].sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
  };
};

/** A successful process exit is insufficient: the read after each delete must prove absence. */
export const destroy = async (input: {
  readonly engine: string;
  readonly stage: string;
  readonly accountId: string;
  readonly owner: string;
  readonly installation?: string;
  readonly approvedDigest: string;
  readonly decommissions: ReadonlyArray<DecommissionRecord>;
  readonly discover: () => Promise<Snapshot>;
  readonly locks: WriterLocks;
  readonly runner: OperationRunner;
  readonly record: (result: {
    readonly deleted: ReadonlyArray<string>;
    readonly status: "complete" | "unknown";
    readonly leaseId?: string;
  }) => Promise<void>;
}): Promise<void> => {
  if (input.engine !== "cf") throw new Error("cf destroy requires explicit opt-in");

  if (requireStage(input.stage).persistent)
    throw new Error("automated persistent-stage destruction is forbidden");

  const lease = await input.locks.acquire(
    writerKey(input.accountId, input.stage, input.installation),
    input.owner,
  );

  const deleted: Array<string> = [];
  let wrote = false;
  let complete = false;

  const record = async (status: "complete" | "unknown") => {
    const result = { deleted, status };
    await input.record(lease.leaseId ? { ...result, leaseId: lease.leaseId } : result);
  };

  try {
    const snapshot = await input.discover();
    assertBoundary(snapshot, input.stage, input.accountId);

    if (snapshot.blockers.length) throw new Error("incomplete discovery blocks destruction");

    if (digest(destructionSubject(snapshot, input.decommissions)) !== input.approvedDigest)
      throw new Error("fresh destroy plan differs from approval");

    for (const resource of snapshot.resources) {
      if (
        !input.decommissions.some(
          (record) =>
            record.stage === resource.stage &&
            record.logicalId === resource.logicalId &&
            record.action === "delete" &&
            record.approvedBy.trim() &&
            record.ticket.trim(),
        )
      )
        throw new Error(`missing decommission record for ${resource.logicalId}`);

      if (workerManaged.has(resource.type)) {
        if (
          !snapshot.resources.some(
            (worker) =>
              worker.type === "Cloudflare.Worker" &&
              worker.identity.name === resource.identity.hostWorker,
          )
        )
          throw new Error("dependent deletion has no approved host Worker");
      } else deleteArgs(resource);
    }

    const operations = snapshot.resources
      .filter((resource) => !workerManaged.has(resource.type))
      .sort(
        (a, b) =>
          deleteOrder.indexOf(a.type) - deleteOrder.indexOf(b.type) ||
          (a.logicalId === "MailCore" ? 1 : -1),
      );

    let current = snapshot;

    for (const resource of operations) {
      const live = current.resources.find((item) => key(item) === key(resource));

      if (!live) continue;

      if (canonical(live.identity) !== canonical(resource.identity))
        throw new Error("delete target identity changed during destroy");
      await lease.assertHeld();
      wrote = true;
      await input.runner.run({ args: deleteArgs(resource) });
      current = await input.discover();
      assertBoundary(current, input.stage, input.accountId);

      if (current.blockers.length || current.resources.some((item) => key(item) === key(resource)))
        throw new Error("cf delete outcome unverified; do not retry without fresh review");
      deleted.push(key(resource));
    }

    const final = await input.discover();
    assertBoundary(final, input.stage, input.accountId);

    if (final.blockers.length || final.resources.length)
      throw new Error("owned resources remain after destroy");
    await record("complete");
    complete = true;
  } catch (cause) {
    await record("unknown");
    throw cause;
  } finally {
    if (!wrote || complete) await lease.release();
  }
};
