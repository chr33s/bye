import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plan } from "../policies/plan-policy.ts";
import { CF_VERSION } from "./command.ts";
import { canonicalPlan, digest } from "./plan-normalize.ts";
import { assertNoSecrets } from "./schemas.ts";

/** Includes paths and bytes; refuses symlinks and secret files before hashing artifacts. */
export const directoryDigest = (root: string): string => {
  const hash = createHash("sha256");

  const visit = (path: string) => {
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) throw new Error("release artifact contains a symlink");

    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));

      return;
    }

    if (!stat.isFile()) throw new Error("release artifact contains a nonregular file");
    const name = relative(root, path);

    if (/(^|\/)(\.env(?:\.|$)|\.dev\.vars|.*secrets.*)/i.test(name))
      throw new Error("release artifact contains a secrets file");
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  };

  visit(root);

  return hash.digest("hex");
};

export interface ApprovalInputs {
  readonly stage: string;
  readonly accountId: string;
  readonly releaseCommit: string;
  readonly sourceDigest: string;
  readonly lockDigest: string;
  readonly migrationDigest: string;
  readonly resourceMapDigest: string;
  readonly discoveryDigest: string;
  readonly configDigest: string;
  readonly configVersion: "0.22.0";
  readonly plan: Plan;
}

export const approvalSubject = (input: ApprovalInputs) => {
  assertNoSecrets(input);

  if (
    input.stage !== input.plan.stage ||
    !input.accountId ||
    !/^[a-f0-9]{40}$/.test(input.releaseCommit)
  )
    throw new Error("invalid release approval inputs");

  for (const key of [
    "sourceDigest",
    "lockDigest",
    "migrationDigest",
    "resourceMapDigest",
    "discoveryDigest",
    "configDigest",
  ] as const)
    if (!/^[a-f0-9]{64}$/.test(input[key])) throw new Error(`invalid ${key}`);

  return {
    format: "bye.cf-approval.v1",
    ...input,
    cfVersion: CF_VERSION,
    plan: JSON.parse(canonicalPlan(input.plan)),
  };
};

export const approvalDigest = (input: ApprovalInputs): string => digest(approvalSubject(input));

export const verifyFreshApproval = (approvedDigest: string, fresh: ApprovalInputs): void => {
  if (approvedDigest !== approvalDigest(fresh))
    throw new Error("fresh release subject differs from the approved digest");
};
