import type { Plan } from "../policies/plan-policy.ts";
import { requireStage } from "../resources/stage.ts";
import { record, stringField } from "./discover.ts";
import { writeJson, type OperationRunner } from "./operations.ts";
import { validateResourceMap } from "./resource-map.ts";
import { decode, ResourceMap, type Resource } from "./schemas.ts";

const ACCOUNT_TYPES = new Set([
  "Cloudflare.D1.Database",
  "Cloudflare.KV.Namespace",
  "Cloudflare.R2.Bucket",
  "Cloudflare.Queues.Queue",
]);

/** Preflight the entire action set before the first write. Worker-managed resources are built later. */
export const provision = async (input: {
  readonly plan: Plan;
  readonly initialStage?: boolean;
  readonly desired: ReadonlyArray<Resource>;
  readonly map: ResourceMap;
  readonly runner: OperationRunner;
  readonly beforeWrite: () => Promise<void>;
}): Promise<ResourceMap> => {
  if (input.plan.stage !== input.map.stage) throw new Error("provision stage mismatch");

  const creates = input.plan.entries.filter(
    (entry) => entry.action === "create" && ACCOUNT_TYPES.has(entry.type),
  );

  if (requireStage(input.plan.stage).persistent && creates.length && !input.initialStage)
    throw new Error(
      "persistent resource provisioning requires a separate reviewed initial-install procedure",
    );

  if (input.initialStage && input.plan.entries.some((entry) => entry.action !== "create"))
    throw new Error("initial stage provisioning cannot adopt an existing resource");

  const wanted = creates.map((entry) => {
    const resource = input.desired.find(
      (r) => r.logicalId === entry.logicalId && r.type === entry.type && r.stage === entry.stage,
    );

    if (!resource) throw new Error("approved creation has no desired resource");

    const name =
      resource.identity.name ??
      (resource.identity.id?.startsWith("pending:") ? resource.identity.id.slice(8) : undefined);

    if (!name || !/^[a-z0-9-]{1,63}$/.test(name))
      throw new Error("approved create has no valid deterministic name/title");

    return resource;
  });

  const d1 = { ...input.map.d1 };
  const kv = { ...input.map.kv };
  const queues = { ...input.map.queues };

  for (const resource of wanted) {
    await input.beforeWrite();
    const id = resource.identity.id;

    const name =
      resource.identity.name ??
      (id?.startsWith("pending:") ? id.slice("pending:".length) : undefined);

    switch (resource.type) {
      case "Cloudflare.D1.Database": {
        if (!name) throw new Error("D1 creation requires a deterministic name");
        const created = record(await writeJson(input.runner, ["d1", "create", "--name", name]));

        if (stringField(created, "name") !== name)
          throw new Error("created D1 name differs from approved identity");
        d1[resource.logicalId] = { id: stringField(created, "uuid"), name };
        break;
      }

      case "Cloudflare.KV.Namespace": {
        if (!name) throw new Error("KV creation requires a deterministic title");

        const created = record(
          await writeJson(input.runner, ["kv", "namespaces", "create", "--title", name]),
        );

        if (stringField(created, "title") !== name)
          throw new Error("created KV title differs from approved identity");
        kv[resource.logicalId] = { id: stringField(created, "id") };
        break;
      }

      case "Cloudflare.R2.Bucket":
        if (!name) throw new Error("R2 creation requires a deterministic name");
        await writeJson(input.runner, ["r2", "buckets", "create", "--name", name]);
        break;
      case "Cloudflare.Queues.Queue": {
        if (!name) throw new Error("Queue creation requires a deterministic name");

        const created = record(
          await writeJson(input.runner, ["queues", "create", "--queue-name", name]),
        );

        if (stringField(created, "queue_name") !== name)
          throw new Error("created Queue name differs from approved identity");
        queues[resource.logicalId] = { id: stringField(created, "queue_id"), name };
        break;
      }
    }
  }

  return validateResourceMap(
    { ...decode(ResourceMap, input.map), d1, kv, queues },
    input.map.stage,
    input.map.accountId,
  );
};
