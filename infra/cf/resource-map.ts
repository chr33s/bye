import { physicalName, workerName } from "./naming.ts";
import { WORKFLOWS } from "./inventory.ts";
import { QUEUE_NAMES } from "../resources/queue-policy.ts";
import { requireStage } from "../resources/stage.ts";
import { readFileSync } from "node:fs";
import { assertBoundary, assertNoSecrets, decode, ResourceMap, type Adoption } from "./schemas.ts";

export const validateResourceMap = <T>(value: T, stage: string, accountId: string): ResourceMap => {
  const map = decode(ResourceMap, value);
  assertBoundary(map, stage, accountId);
  assertNoSecrets(map);

  for (const identities of [
    Object.values(map.workers).map((identity) => identity.name),
    Object.values(map.d1).map((identity) => identity.id),
    Object.values(map.d1).map((identity) => identity.name),
    Object.values(map.kv).map((identity) => identity.id),
    Object.values(map.r2).map((identity) => identity.name),
    Object.values(map.queues).map((identity) => identity.id),
    Object.values(map.queues).map((identity) => identity.name),
    Object.values(map.workflows).map((identity) => identity.name),
    Object.values(map.containers).map((identity) => identity.name),
    Object.values(map.containers).flatMap((identity) =>
      identity.applicationId ? [identity.applicationId] : [],
    ),
    Object.values(map.durableObjects ?? {}).map((identity) => identity.namespaceId),
  ]) {
    if (new Set(identities).size !== identities.length)
      throw new Error("resource map contains duplicate physical identities");
  }

  return map;
};

export const loadResourceMap = (path: string, stage: string, accountId: string): ResourceMap =>
  validateResourceMap(JSON.parse(readFileSync(path, "utf8")), stage, accountId);

export const adoptionResourceMap = (adoption: Adoption): ResourceMap => {
  const group = (type: string) => adoption.resources.filter((resource) => resource.type === type);

  const required = (identity: Readonly<Record<string, string>>, key: string): string => {
    const value = identity[key];

    if (!value) throw new Error(`adopted identity missing ${key}`);

    return value;
  };

  return validateResourceMap(
    {
      format: "bye.cf-resources.v1",
      stage: adoption.stage,
      accountId: adoption.accountId,
      workers: Object.fromEntries(
        group("Cloudflare.Worker").map((r) => [
          r.logicalId,
          { name: required(r.identity, "name") },
        ]),
      ),
      d1: Object.fromEntries(
        group("Cloudflare.D1.Database").map((r) => [
          r.logicalId,
          { id: required(r.identity, "id"), name: required(r.identity, "name") },
        ]),
      ),
      kv: Object.fromEntries(
        group("Cloudflare.KV.Namespace").map((r) => [
          r.logicalId,
          { id: required(r.identity, "id") },
        ]),
      ),
      r2: Object.fromEntries(
        group("Cloudflare.R2.Bucket").map((r) => [
          r.logicalId,
          { name: required(r.identity, "name") },
        ]),
      ),
      queues: Object.fromEntries(
        group("Cloudflare.Queues.Queue").map((r) => [
          r.logicalId,
          { id: required(r.identity, "id"), name: required(r.identity, "name") },
        ]),
      ),
      workflows: Object.fromEntries(
        group("Cloudflare.Workflow").map((r) => [
          r.logicalId,
          { name: required(r.identity, "name") },
        ]),
      ),
      containers: Object.fromEntries(
        group("Cloudflare.Container").map((r) => [
          r.logicalId,
          {
            name: required(r.identity, "name"),
            applicationId: required(r.identity, "applicationId"),
          },
        ]),
      ),
      durableObjects: Object.fromEntries(
        adoption.resources.flatMap((resource) => {
          if (!["Cloudflare.DurableObject", "Cloudflare.Container"].includes(resource.type))
            return [];

          return [
            [
              resource.logicalId,
              {
                namespaceId: required(resource.identity, "namespaceId"),
                className: required(resource.identity, "className"),
                hostWorker: required(resource.identity, "hostWorker"),
                storage: required(resource.identity, "storage"),
              },
            ],
          ];
        }),
      ),
    },
    adoption.stage,
    adoption.accountId,
  );
};

/** Seeds genuinely new stages; persistent creation requires explicit initial-stage review. Pending IDs never reach a Worker build. */
export const newResourceMap = (
  stage: string,
  accountId: string,
  installation?: string,
  initialStage = false,
): ResourceMap => {
  if (requireStage(stage).persistent && !initialStage)
    throw new Error("new persistent stage requires explicit initial-stage review");
  const name = (id: string) => physicalName(stage, id, installation);

  return validateResourceMap(
    {
      format: "bye.cf-resources.v1",
      stage,
      accountId,
      workers: Object.fromEntries(
        ["MailCore", "PublicSite", "SigMirror", ...(installation ? ["RenderOrigin"] : [])].map(
          (id) => [id, { name: workerName(stage, id, installation) }],
        ),
      ),
      d1: { Directory: { name: name("Directory"), id: `pending:${name("Directory")}` } },
      kv: { ConfigCache: { id: `pending:${name("ConfigCache")}` } },
      r2: Object.fromEntries(
        ["Originals", "Parts", "Exports", "Published", "ClamSignatures"].map((id) => [
          id,
          { name: name(id) },
        ]),
      ),
      queues: Object.fromEntries(
        QUEUE_NAMES.flatMap((id) => [id, `${id}DLQ`]).map((id) => [
          id,
          { name: name(id), id: `pending:${name(id)}` },
        ]),
      ),
      workflows: Object.fromEntries(Object.keys(WORKFLOWS).map((id) => [id, { name: name(id) }])),
      containers: Object.fromEntries(
        ["Scanner", "MimeParser", "SigMirrorJob"].map((id) => [id, { name: name(id) }]),
      ),
    },
    stage,
    accountId,
  );
};
