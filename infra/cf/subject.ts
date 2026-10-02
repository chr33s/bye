import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { directoryDigest, type ApprovalInputs } from "./evidence.ts";
import { sourceDigest } from "./artifacts.ts";
import { digest } from "./plan-normalize.ts";
import { CONFIG_INPUTS } from "./config/workers.ts";
import { RUNTIME_CONFIG } from "./config/runtime.ts";
import type { Plan } from "../policies/plan-policy.ts";
import type { ResourceMap, Snapshot } from "./schemas.ts";

export const releaseSubject = (input: {
  readonly root: string;
  readonly map: ResourceMap;
  readonly discovery: Snapshot;
  readonly plan: Plan;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ApprovalInputs => {
  const { map, env, root } = input;

  const commit = existsSync(resolve(root, ".git"))
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    : (env.BYE_RELEASE_COMMIT ?? "");

  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("release subject requires a pinned commit");

  if (env.GITHUB_SHA && env.GITHUB_SHA !== commit)
    throw new Error("release checkout differs from CI commit");

  const config = Object.fromEntries([
    ...CONFIG_INPUTS.map((key) => [key, env[key] ?? ""]),
    ...Object.entries(RUNTIME_CONFIG).map(([key, declaration]) => [
      key,
      declaration.secret ? Boolean(env[key]) : (env[key] ?? ""),
    ]),
    // Rollout inputs are part of review even though they do not belong in Worker config.
    ...[
      "BYE_CANARY_PERCENT",
      "BYE_CF_LIFECYCLE_CHANGED",
      "BYE_CF_ACK_LIFECYCLE",
      "BYE_CF_INITIAL_STAGE",
      "PROVIDER_SENT_PREVIEWS",
    ].map((key) => [key, env[key] ?? ""]),
  ]);

  return {
    stage: map.stage,
    accountId: map.accountId,
    releaseCommit: commit,
    sourceDigest: sourceDigest(root),
    lockDigest: createHash("sha256")
      .update(readFileSync(resolve(root, "pnpm-lock.yaml")))
      .digest("hex"),
    migrationDigest: digest({
      d1: directoryDigest(resolve(root, "infra/migrations/d1")),
      durable: directoryDigest(resolve(root, "infra/migrations/durable")),
    }),
    resourceMapDigest: digest(map),
    discoveryDigest: digest(input.discovery),
    configDigest: digest(config),
    configVersion: "0.22.0",
    plan: input.plan,
  };
};
