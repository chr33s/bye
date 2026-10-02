import { physicalName, workerName } from "../naming.ts";
import { HOSTED_NAMESPACES, WORKFLOWS } from "../inventory.ts";
import { QUEUE_NAMES } from "../../resources/queue-policy.ts";
import { validateResourceMap } from "../resource-map.ts";
import type { ResourceMap, Snapshot, Resource } from "../schemas.ts";

export const fixtureMap = (stage = "dev-abcdef", installation?: string): ResourceMap =>
  validateResourceMap(
    {
      format: "bye.cf-resources.v1",
      stage,
      accountId: "a".repeat(32),
      workers: Object.fromEntries(
        ["MailCore", "PublicSite", "SigMirror", ...(installation ? ["RenderOrigin"] : [])].map(
          (id) => [id, { name: workerName(stage, id, installation) }],
        ),
      ),
      d1: {
        Directory: {
          id: "11111111-1111-4111-8111-111111111111",
          name: physicalName(stage, "Directory", installation),
        },
      },
      kv: { ConfigCache: { id: "b".repeat(32) } },
      r2: Object.fromEntries(
        ["Originals", "Parts", "Exports", "Published", "ClamSignatures"].map((id) => [
          id,
          { name: physicalName(stage, id, installation) },
        ]),
      ),
      queues: Object.fromEntries(
        QUEUE_NAMES.flatMap((id) => [id, `${id}DLQ`]).map((id, i) => [
          id,
          { id: i.toString(16).padStart(32, "0"), name: physicalName(stage, id, installation) },
        ]),
      ),
      workflows: Object.fromEntries(
        Object.keys(WORKFLOWS).map((id) => [id, { name: physicalName(stage, id, installation) }]),
      ),
      containers: Object.fromEntries(
        ["Scanner", "MimeParser", "SigMirrorJob"].map((id, index) => [
          id,
          { name: physicalName(stage, id, installation), applicationId: `application-${index}` },
        ]),
      ),
      durableObjects: Object.fromEntries(
        HOSTED_NAMESPACES.map((namespace, index) => [
          namespace.logicalId,
          {
            namespaceId: index.toString(16).padStart(32, "0"),
            className: namespace.className,
            hostWorker: workerName(stage, namespace.hostWorker, installation),
            storage: "sqlite",
          },
        ]),
      ),
    },
    stage,
    "a".repeat(32),
  );

export const fixtureEnv = {
  APP_ORIGIN: "https://app.example.test",
  MAIL_RENDER_ORIGIN: "https://mail.example.test",
  MAIL_SANDBOX_DOMAINS: "sandbox.example.test",
};

export const fixtureSnapshot = (
  resources: ReadonlyArray<Resource>,
  stage = "dev-abcdef",
): Snapshot => ({
  format: "bye.cf-discovery.v1",
  stage,
  accountId: "a".repeat(32),
  resources,
  blockers: [],
});
