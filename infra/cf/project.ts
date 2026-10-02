import { resolve } from "node:path";
import { Schema } from "effect";
import { directoryDigest } from "./evidence.ts";
import { record, rows, stringField, paged } from "./discover.ts";
import { parseJson, type CommandRunner } from "./command.ts";
import { jsonArgument, type OperationRunner } from "./operations.ts";
import { withSecretsFile } from "./secrets.ts";
import { decode, type ResourceMap } from "./schemas.ts";
import { type BuiltWorker, type UploadedWorker } from "./release.ts";
import { RUNTIME_CONFIG } from "./config/runtime.ts";
import { workerConfig, type WorkerId } from "./config/workers.ts";

const DIRECTORIES = {
  SigMirror: "sigmirror",
  MailCore: "core",
  PublicSite: "public",
  RenderOrigin: "render",
} as const;

/** Dependency order is explicit: mirror before core, core before public/render. */
export const buildWorkers = async (
  map: ResourceMap,
  runner: OperationRunner,
): Promise<ReadonlyArray<BuiltWorker>> => {
  const workers: Array<BuiltWorker> = [];

  for (const logicalId of Object.keys(DIRECTORIES) as ReadonlyArray<WorkerId>) {
    const identity = map.workers[logicalId];

    if (!identity) continue;
    const directory = resolve(import.meta.dirname, "../../workers", DIRECTORIES[logicalId]);
    await runner.run({ args: ["build", "--mode", "production"], cwd: directory });
    workers.push({
      logicalId,
      name: identity.name,
      directory,
      digest: directoryDigest(resolve(directory, ".cloudflare/output/v0")),
    });
  }

  return workers;
};

export const verifyWorkerBuild = async (worker: BuiltWorker): Promise<void> => {
  if (directoryDigest(resolve(worker.directory, ".cloudflare/output/v0")) !== worker.digest)
    throw new Error("Worker Build Output changed after build");
};

export const applyMigrations = async (
  map: ResourceMap,
  runner: OperationRunner,
  read: CommandRunner,
  beforeWrite: () => Promise<void>,
): Promise<void> => {
  const directory = map.d1.Directory;

  if (!directory?.id) throw new Error("D1 migrations require resolved Directory ID");
  await beforeWrite();

  const output = await runner.run({
    args: [
      "d1",
      "migrations",
      "apply",
      directory.id,
      "--dir",
      resolve(import.meta.dirname, "../migrations/d1"),
    ],
  });

  // A malformed response is an unknown write outcome; do not replay.
  const applied = rows(parseJson(output));

  if (applied.some((migration) => migration.status !== "✅"))
    throw new Error("D1 migration reported failure");

  const pending = rows(
    await read.json([
      "d1",
      "migrations",
      "list",
      directory.id,
      "--dir",
      resolve(import.meta.dirname, "../migrations/d1"),
    ]),
  );

  if (pending.length) throw new Error("D1 migrations remain unapplied; deployment stopped");
};

export const uploadWorker = async (input: {
  readonly worker: BuiltWorker;
  readonly map: ResourceMap;
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly read: CommandRunner;
  readonly write: OperationRunner;
  readonly beforeWrite: () => Promise<void>;
}): Promise<UploadedWorker> => {
  const { worker } = input;

  const workerInventory = await paged(input.read, ["workers", "list"]);
  const exists = workerInventory.some((item) => item.name === worker.name);

  const deployments = exists
    ? rows(
        await input.read.json(["workers", "deployments", "list", "--worker", worker.name]),
        "deployments",
      )
    : [];

  const current = deployments[0] ? rows(deployments[0].versions) : [];

  if (current.length > 1 || (current[0] && current[0].percentage !== 100))
    throw new Error("release requires stable prior traffic");
  const previousVersionId = current[0] ? stringField(current[0], "version_id") : undefined;

  const before = exists
    ? await paged(input.read, ["workers", "versions", "list", "--worker-id", worker.name])
    : [];

  const existing = new Set(before.map((version) => stringField(version, "id")));
  const config = workerConfig(worker.logicalId as WorkerId, input.map, input.values);
  const values: Record<string, string> = {};

  for (const [name, binding] of Object.entries(config.worker.env ?? {})) {
    if (binding.type !== "secret") continue;

    const sourceName =
      worker.logicalId === "SigMirror" && name === "WRITE_TOKEN" ? "SIGMIRROR_WRITE_TOKEN" : name;

    const value = input.values[sourceName];

    if (!value && RUNTIME_CONFIG[sourceName as keyof typeof RUNTIME_CONFIG]?.required)
      throw new Error(`missing required runtime secret ${sourceName}`);

    values[name] = value ?? "";
  }

  await withSecretsFile(values, async (path) => {
    await input.beforeWrite();
    await input.write.run({
      cwd: worker.directory,
      args: [
        "workers",
        "versions",
        "create",
        "--prebuilt",
        "--mode",
        "production",
        "--secrets-file",
        path,
      ],
    });
  });

  // Project uploads do not expose structured IDs in beta.10. Resolve through the version API under the lock.
  const after = await paged(input.read, [
    "workers",
    "versions",
    "list",
    "--worker-id",
    worker.name,
  ]);

  const added = after.filter((version) => !existing.has(stringField(version, "id")));

  if (added.length !== 1)
    throw new Error("uploaded version cannot be resolved uniquely; reconcile before retrying");
  const versionId = stringField(added[0]!, "id");

  const version = record(
    await input.read.json(["workers", "versions", "get", versionId, "--worker-id", worker.name]),
  );

  if (decode(Schema.NonEmptyString, version.id) !== versionId)
    throw new Error("uploaded version identity mismatch");
  const uploaded: UploadedWorker = { ...worker, versionId };

  if (previousVersionId) return { ...uploaded, previousVersionId };

  return uploaded;
};

export const deployTraffic = async (
  runner: OperationRunner,
  worker: UploadedWorker,
  versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>,
  beforeWrite: () => Promise<void>,
): Promise<void> => {
  if (
    versions.some((version) => version.percentage <= 0 || !version.version_id) ||
    versions.reduce((sum, version) => sum + version.percentage, 0) !== 100
  )
    throw new Error("invalid version traffic allocation");
  await beforeWrite();
  parseJson(
    await runner.run({
      args: [
        "workers",
        "deployments",
        "create",
        "--worker",
        worker.name,
        "--strategy",
        "percentage",
        "--versions",
        jsonArgument(versions),
      ],
    }),
  );
};

export const deployTriggers = async (
  runner: OperationRunner,
  worker: BuiltWorker,
  beforeWrite: () => Promise<void>,
): Promise<void> => {
  await beforeWrite();
  await runner.run({
    cwd: worker.directory,
    args: ["workers", "triggers", "deploy", "--prebuilt", "--mode", "production"],
  });
};
