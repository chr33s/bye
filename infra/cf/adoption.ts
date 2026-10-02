import { CF_INVENTORY, HOSTED_NAMESPACES } from "./inventory.ts";
import { assertBoundary, assertNoSecrets, decode, Adoption, Snapshot } from "./schemas.ts";

export const adopt = (value: Snapshot, stage: string, accountId: string): Adoption => {
  const snapshot = decode(Snapshot, value);
  assertBoundary(snapshot, stage, accountId);
  assertNoSecrets(snapshot);

  if (snapshot.blockers.length)
    throw new Error(`adoption blocked: ${snapshot.blockers.join("; ")}`);
  const keys = snapshot.resources.map((r) => `${r.type}/${r.logicalId}`);

  if (new Set(keys).size !== keys.length) throw new Error("ambiguous adoption inventory");

  const required = CF_INVENTORY.filter(
    (entry) =>
      entry.owner === "stack" &&
      !["RenderOrigin", "MailRouting", "MailCatchAll", "SignupChallenge"].includes(entry.logicalId),
  );

  for (const entry of required) {
    if (!keys.includes(`${entry.type}/${entry.logicalId}`))
      throw new Error(`missing adoption resource ${entry.logicalId}`);
  }

  for (const namespace of HOSTED_NAMESPACES) {
    const resource = snapshot.resources.find(
      (r) =>
        r.logicalId === namespace.logicalId &&
        ["Cloudflare.DurableObject", "Cloudflare.Container"].includes(r.type),
    );

    const host = snapshot.resources.find(
      (r) => r.logicalId === namespace.hostWorker && r.type === "Cloudflare.Worker",
    );

    if (
      !resource ||
      resource.identity.className !== namespace.className ||
      resource.identity.hostWorker !== host?.identity.name ||
      resource.identity.storage !== "sqlite" ||
      !resource.identity.namespaceId
    )
      throw new Error(`incompatible Durable Object identity ${namespace.logicalId}`);
  }

  for (const resource of snapshot.resources) {
    if (resource.stage !== stage) throw new Error(`cross-stage adoption of ${resource.logicalId}`);

    if (
      !CF_INVENTORY.some(
        (entry) => entry.logicalId === resource.logicalId && entry.type === resource.type,
      ) &&
      !resource.logicalId.endsWith("DLQConsumer")
    )
      throw new Error(`unexpected adoption resource ${resource.logicalId}`);
  }

  return decode(Adoption, {
    format: "bye.cf-adoption.v1",
    namingVersion: 1,
    stage,
    accountId,
    resources: snapshot.resources,
  });
};
