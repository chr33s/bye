// Release inputs (§15.6 "preserve the reviewed commit, lockfile digest, configuration version,
// plan, and resource identity manifest"; §15.10 "no unreviewed lock/config change between plan
// and deployment"). `create` runs in the plan job; `verify` runs in the approval-gated deploy
// job against a freshly computed plan and fails if anything reviewed has changed.
//
// Usage:
//   release-manifest.ts create <plan-export.json> <manifest.json>
//   release-manifest.ts verify <manifest.json> <fresh-plan-export.json>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalPlan, type ExportedPlan, resourceIdentities } from "./plan-normalize.ts";
import { requiredConfig } from "./check-config.ts";

export interface ReleaseManifest {
  readonly format: "bye.release.v1";
  readonly commit: string;
  readonly lockfileDigest: string;
  /** Hash of non-secret config values and the NAMES of secrets present (never secret values). */
  readonly configHash: string;
  readonly stack: string;
  readonly stage: string;
  readonly accountIdHash: string;
  readonly stateBackend: string;
  readonly stateUrlHash: string;
  readonly planDigest: string;
  readonly resourceIdentities: ReadonlyArray<{
    readonly fqn: string;
    readonly logicalId: string;
    readonly type: string;
  }>;
}

const sha256 = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

/** Config values that are not secrets may be hashed by value; secrets contribute presence only. */
export const configHash = (
  env: Readonly<Record<string, string | undefined>>,
  names = requiredConfig(),
): string => {
  const parts = names
    .map(
      ({ name, secret }) =>
        `${name}=${secret ? (env[name] ? "<present>" : "<missing>") : (env[name] ?? "<missing>")}`,
    )
    .sort();
  return sha256(parts.join("\n"));
};

export interface ReleaseInputs {
  readonly commit: string;
  readonly lockfile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const buildManifest = (plan: ExportedPlan, inputs: ReleaseInputs): ReleaseManifest => ({
  format: "bye.release.v1",
  commit: inputs.commit,
  lockfileDigest: sha256(inputs.lockfile),
  configHash: configHash(inputs.env),
  stack: plan.stack,
  stage: plan.stage,
  accountIdHash: sha256(inputs.env.CLOUDFLARE_ACCOUNT_ID ?? ""),
  stateBackend: inputs.env.STATE_BACKEND ?? "cloudflare",
  stateUrlHash: sha256(inputs.env.BYE_STATE_URL ?? ""),
  planDigest: sha256(canonicalPlan(plan)),
  resourceIdentities: resourceIdentities(plan),
});

/** Fields that must be identical between the reviewed plan and the deploy-time recomputation. */
export const manifestDrift = (
  reviewed: ReleaseManifest,
  current: ReleaseManifest,
): ReadonlyArray<string> =>
  (
    [
      "commit",
      "lockfileDigest",
      "configHash",
      "stack",
      "stage",
      "accountIdHash",
      "stateBackend",
      "stateUrlHash",
      "planDigest",
    ] as const
  )
    .filter((k) => reviewed[k] !== current[k])
    .map((k) => `${k} changed since review`);

const currentInputs = (): ReleaseInputs => ({
  commit:
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  lockfile: readFileSync("pnpm-lock.yaml", "utf8"),
  env: process.env,
});

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "create" && a && b) {
    const manifest = buildManifest(
      JSON.parse(readFileSync(a, "utf8")) as ExportedPlan,
      currentInputs(),
    );
    writeFileSync(b, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `release manifest ${manifest.stack}/${manifest.stage} plan ${manifest.planDigest.slice(0, 12)}`,
    );
  } else if (cmd === "verify" && a && b) {
    const reviewed = JSON.parse(readFileSync(a, "utf8")) as ReleaseManifest;
    const drift = manifestDrift(
      reviewed,
      buildManifest(JSON.parse(readFileSync(b, "utf8")) as ExportedPlan, currentInputs()),
    );
    for (const d of drift) console.error(`release: ${d}`);
    if (drift.length) process.exit(1);
    console.log("release inputs match the reviewed plan");
  } else {
    console.error(
      "usage: release-manifest.ts create <plan-export.json> <manifest.json> | verify <manifest.json> <plan-export.json>",
    );
    process.exit(2);
  }
}
