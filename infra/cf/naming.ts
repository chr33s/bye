import { createHash } from "node:crypto";
import { requireStage } from "../resources/stage.ts";

export const NAMING_VERSION = 1;

/** Only for genuinely new resources. Existing resources always use adoption identities. */
export const physicalName = (stage: string, logicalId: string, installation?: string): string => {
  requireStage(stage);

  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(logicalId)) throw new Error("invalid logical resource ID");

  if (installation !== undefined && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(installation))
    throw new Error("invalid installation name");
  const subject = `bye:v${NAMING_VERSION}:${installation ?? "ci"}:${stage}:${logicalId}`;
  const hash = createHash("sha256").update(subject).digest("hex").slice(0, 10);

  // Queue/R2 names cap at 63 bytes; the longest valid stage leaves 27 for the logical stem.
  return `bye-${stage}-${logicalId.toLowerCase().slice(0, 27)}-${hash}`;
};

export const workerName = (stage: string, logicalId: string, installation?: string): string => {
  requireStage(stage);

  if (installation !== undefined) {
    physicalName(stage, logicalId, installation); // validate the immutable installation name

    if (logicalId === "MailCore") return installation;

    if (logicalId === "PublicSite") return `${installation}-site`;

    if (logicalId === "RenderOrigin") return `${installation}-render`;
  }

  return physicalName(stage, logicalId, installation);
};
