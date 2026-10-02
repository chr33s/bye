import { resolve } from "node:path";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertReleaseConfig } from "./release-config.ts";
import { workerMetadata } from "./metadata.ts";
import { discover } from "./discover.ts";
import { desiredResources } from "./desired.ts";
import { cfRunner } from "./command.ts";
import { operationRunner } from "./operations.ts";
import { httpWriterLocks } from "./locks.ts";
import { release } from "./release.ts";
import { releaseSubject } from "./subject.ts";
import { adopt } from "./adoption.ts";
import { adoptionResourceMap } from "./resource-map.ts";
import { provision } from "./provision.ts";
import { reconcile } from "./reconcile.ts";
import {
  buildWorkers,
  verifyWorkerBuild,
  applyMigrations,
  uploadWorker,
  deployTraffic,
  deployTriggers,
} from "./project.ts";
import { writeArtifact } from "./artifacts.ts";
import { RUNTIME_CONFIG } from "./config/runtime.ts";
import { DIGEST_PINNED } from "../resources/container-images.ts";
import { CONFIG_INPUTS } from "./config/workers.ts";
import { Adoption, decode, type ResourceMap } from "./schemas.ts";
import { runProbes } from "../probes/run.ts";

/** CLI composition. Credentials/approval/evidence paths are explicit; no legacy state client. */
export const applyRelease = async (input: {
  readonly map: ResourceMap;
  readonly adoptionPath?: string;
  readonly approvedDigest: string;
  readonly evidenceDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<void> => {
  const { env } = input;

  const required = (key: string) => {
    if (!env[key]) throw new Error(`cf apply requires ${key}`);

    return env[key];
  };

  if (env.BYE_DEPLOY_ENGINE !== "cf") throw new Error("cf apply requires BYE_DEPLOY_ENGINE=cf");

  assertReleaseConfig(input.map.stage, env);

  for (const [name, definition] of Object.entries(RUNTIME_CONFIG))
    if (definition.required && !env[name]) throw new Error(`missing runtime config ${name}`);

  required("SIGMIRROR_WRITE_TOKEN");

  // Release discovery can compare content-addressed images before and after deployment.
  if (env.SCANNER_SIGNATURES !== "baked")
    throw new Error("cf release requires baked scanner signatures");

  for (const name of ["SCANNER_IMAGE", "MIME_IMAGE", "SIGMIRROR_IMAGE"])
    if (!DIGEST_PINNED.test(required(name)))
      throw new Error(`${name} requires a digest-pinned image`);

  if (env.MAIL_ZONE || env.BYE_MX_CUTOVER)
    throw new Error("email routing changes require the separate reviewed foundation procedure");

  const locks = httpWriterLocks({
    origin: required("BYE_CF_LOCK_URL"),
    credential: required("BYE_CF_LOCK_CREDENTIAL"),
  });

  required("PROBE_BASE_URL");
  const root = resolve(import.meta.dirname, "../..");
  const read = cfRunner({ env });
  const temporary = mkdtempSync(resolve(tmpdir(), "bye-cf-release-"));
  let resolved = input.map;
  let index = 0;

  const adoption = input.adoptionPath
    ? decode(Adoption, JSON.parse(readFileSync(input.adoptionPath, "utf8")))
    : undefined;

  const writes = () =>
    operationRunner({
      env: { ...env, BYE_CF_RESOURCE_MAP: resolve(temporary, "resolved.cf-resources.json") },
      configKeys: [
        ...CONFIG_INPUTS,
        "STAGE",
        "BYE_CF_RESOURCE_MAP",
        ...Object.entries(RUNTIME_CONFIG)
          .filter(([, declaration]) => !declaration.secret)
          .map(([name]) => name),
      ],
      secrets: Object.entries(RUNTIME_CONFIG)
        .filter(([, declaration]) => declaration.secret)
        .flatMap(([name]) => (env[name] ? [env[name]!] : [])),
    });

  try {
    await release(
      {
        engine: env.BYE_DEPLOY_ENGINE,
        map: input.map,
        adoption,
        initialStage: env.BYE_CF_INITIAL_STAGE === "1",
        approvedDigest: input.approvedDigest,
        owner: env.GITHUB_RUN_ID ?? "operator",
        installation: env.BYE_WORKERS_DEV_NAME || undefined,
        canaryPercent: Number(env.BYE_CANARY_PERCENT || "100"),
        durableLifecycleChanged: env.BYE_CF_LIFECYCLE_CHANGED === "1",
        acknowledgeLifecycle: env.BYE_CF_ACK_LIFECYCLE === "approved",
      },
      {
        locks,
        discover: (map) =>
          discover(
            read,
            map,
            workerMetadata({
              accountId: map.accountId,
              apiToken: required("CLOUDFLARE_API_TOKEN"),
            }),
          ),
        desired: (map) => desiredResources(map, env),
        subject: async (map, discovery, plan) =>
          releaseSubject({ root, env, map, discovery, plan }),
        async provision(plan, desired, map, beforeWrite) {
          resolved = await provision({
            plan,
            desired,
            map,
            beforeWrite,
            runner: writes(),
            initialStage: env.BYE_CF_INITIAL_STAGE === "1",
          });
          writeArtifact(resolve(temporary, "resolved.cf-resources.json"), resolved);
          writeArtifact(resolve(input.evidenceDirectory, "resolved.cf-resources.json"), resolved);

          return resolved;
        },
        async resolve(map) {
          const snapshot = await discover(
            read,
            map,
            workerMetadata({
              accountId: map.accountId,
              apiToken: required("CLOUDFLARE_API_TOKEN"),
            }),
          );

          const manifest = adopt(snapshot, map.stage, map.accountId);
          resolved = adoptionResourceMap(manifest);
          writeArtifact(resolve(input.evidenceDirectory, "final.adoption.json"), manifest);
          writeArtifact(resolve(input.evidenceDirectory, "final.cf-resources.json"), resolved);

          return resolved;
        },
        build: (map) => buildWorkers(map, writes()),
        verifyBuild: verifyWorkerBuild,
        migrate: (map, beforeWrite) => applyMigrations(map, writes(), read, beforeWrite),
        upload: (worker, beforeWrite) =>
          uploadWorker({ worker, map: resolved, values: env, read, write: writes(), beforeWrite }),
        traffic: (worker, versions, beforeWrite) =>
          deployTraffic(writes(), worker, versions, beforeWrite),
        triggers: (worker, beforeWrite) => deployTriggers(writes(), worker, beforeWrite),
        reconcile: (plan, desired, beforeWrite) =>
          reconcile({ plan, desired, beforeWrite, runner: writes() }),
        probes: async (core) => ({
          results: await runProbes(
            required("PROBE_BASE_URL").replace(/\/$/, ""),
            required("PROBE_TOKEN"),
            fetch,
            60_000,
            { worker: core.name, versionId: core.versionId },
          ),
        }),
        record: async (event) =>
          writeArtifact(
            resolve(
              input.evidenceDirectory,
              `${String(index++).padStart(3, "0")}-${event.phase}.json`,
            ),
            event,
          ),
      },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};
