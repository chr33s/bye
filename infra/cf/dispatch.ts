import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { httpWriterLocks, writerKey } from "./locks.ts";
import { cfRunner, commandEnv, redact } from "./command.ts";
import { operationRunner } from "./operations.ts";
import { buildWorkers } from "./project.ts";
import { RUNTIME_CONFIG } from "./config/runtime.ts";
import { CONFIG_INPUTS } from "./config/workers.ts";
import { loadResourceMap } from "./resource-map.ts";
import { requireStage } from "../resources/stage.ts";

export type DeploymentEngine = "cf" | "alchemy";

export const deploymentEngine = (value: string | undefined): DeploymentEngine => {
  if (!value || value === "alchemy") return "alchemy";

  if (value === "cf") return "cf";
  throw new Error("BYE_DEPLOY_ENGINE must be cf or alchemy");
};

export const dispatch = async (
  operation: string,
  args: ReadonlyArray<string> = [],
): Promise<number> => {
  const engine = deploymentEngine(process.env.BYE_DEPLOY_ENGINE);

  if (!["plan", "apply", "destroy", "drift", "dev", "logs", "preflight"].includes(operation))
    throw new Error("unknown deployment operation");
  const root = resolve(import.meta.dirname, "../..");

  const runChild = async (
    command: string,
    argv: ReadonlyArray<string>,
    cwd = root,
    env = process.env,
  ): Promise<number> =>
    new Promise((done) => {
      const child = spawn(command, [...argv], { cwd, env, stdio: "inherit" });
      child.on("error", () => done(1));
      child.on("exit", (code) => done(code ?? 1));
    });

  if (engine === "alchemy" && operation === "preflight")
    return runChild("pnpm", ["run", "legacy:preflight", ...args]);
  const stage = requireStage(process.env.STAGE ?? "");

  if (engine === "cf") {
    if (["dev", "logs", "preflight"].includes(operation)) {
      const path = process.env.BYE_CF_RESOURCE_MAP;
      const account = process.env.CLOUDFLARE_ACCOUNT_ID;

      if (!path || !account)
        throw new Error("cf operation requires explicit account and resolved resource map");
      const map = loadResourceMap(path, stage.name, account);

      if (operation === "logs") {
        const now = Date.now();

        const result = await cfRunner().json([
          "observability",
          "telemetry",
          "query",
          "--query-id",
          "bye-cli",
          "--parameters-datasets",
          map.workers.MailCore!.name,
          "--view",
          "events",
          "--timeframe-from",
          String(now - 15 * 60_000),
          "--timeframe-to",
          String(now),
          "--limit",
          "50",
          "--dry",
        ]);

        console.log(
          redact(JSON.stringify(result, null, 2), [
            process.env.CLOUDFLARE_API_TOKEN ?? "",
            ...Object.entries(RUNTIME_CONFIG)
              .filter(([, declaration]) => declaration.secret)
              .flatMap(([key]) => (process.env[key] ? [process.env[key]!] : [])),
          ]),
        );

        return 0;
      }

      if (operation === "dev" && stage.class !== "dev")
        throw new Error("cf local dev requires a dev-* stage");
      const built = await runChild("pnpm", ["run", "build:deploy"]);

      if (built) return built;

      const configKeys = [
        ...CONFIG_INPUTS,
        "STAGE",
        "BYE_CF_RESOURCE_MAP",
        ...Object.entries(RUNTIME_CONFIG)
          .filter(([, declaration]) => !declaration.secret)
          .map(([name]) => name),
      ];

      if (operation === "preflight") {
        const runner = operationRunner({ env: process.env, configKeys });

        for (const worker of await buildWorkers(map, runner))
          await runner.run({
            cwd: worker.directory,
            args: ["deploy", "--dry-run", "--prebuilt", "--mode", "production"],
          });

        return 0;
      }

      const env = commandEnv(process.env);

      for (const key of configKeys) if (process.env[key]) env[key] = process.env[key]!;

      return runChild(
        process.execPath,
        [resolve(root, "node_modules/cf/bin/cf"), "dev", ...args],
        resolve(root, "workers/core"),
        env,
      );
    }

    const { main } = await import("./cli.ts");
    await main([operation, "--stage", stage.name, ...args]);

    return process.exitCode ? Number(process.exitCode) : 0;
  }

  // Rollback writers participate in the same authority once configured; no overlap with cf.
  const mutating = ["apply", "destroy"].includes(operation);
  const authority = process.env.BYE_CF_LOCK_URL;

  const lease =
    mutating && authority
      ? await httpWriterLocks({
          origin: authority,
          credential: process.env.BYE_CF_LOCK_CREDENTIAL ?? "",
        }).acquire(
          writerKey(
            process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
            stage.name,
            process.env.BYE_WORKERS_DEV_NAME || undefined,
          ),
          `legacy-${process.env.GITHUB_RUN_ID ?? "operator"}`,
        )
      : undefined;

  let complete = false;

  try {
    if (lease) await lease.assertHeld();

    const name = {
      plan: "deploy:plan",
      apply: "deploy",
      destroy: "destroy:preview",
      drift: "drift",
      dev: "dev",
      logs: "logs",
      preflight: "preflight",
    }[operation];

    const code = await new Promise<number>((done) => {
      const child = spawn("pnpm", ["run", `legacy:${name}`, ...args], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      });

      child.on("error", () => done(1));
      child.on("exit", (code) => done(code ?? 1));
    });

    complete = code === 0;

    if (lease && !complete)
      console.error(
        `rollback outcome requires reconciliation; retained lease ${lease.leaseId ?? "unknown"}`,
      );

    return code;
  } finally {
    if (complete) await lease?.release();
  }
};

if (process.argv[1] === import.meta.filename)
  dispatch(process.argv[2] ?? "", process.argv.slice(3))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : "deployment failed");
      process.exitCode = 1;
    });
