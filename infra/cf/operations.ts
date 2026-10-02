import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { CF_VERSION, commandEnv, parseJson, redact, type CommandRunner } from "./command.ts";
import { canonical } from "./plan-normalize.ts";

/** Arguments are constructed by the resource/release adapters, never interpreted by a shell. */
export interface Operation {
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}

export interface OperationRunner {
  run(operation: Operation): Promise<string>;
}

const WRITE_PATHS = [
  "d1 create",
  "d1 delete",
  "d1 migrations apply",
  "kv namespaces create",
  "kv namespaces delete",
  "r2 buckets create",
  "r2 buckets delete",
  "r2 buckets lifecycle update",
  "r2 buckets domains managed update",
  "queues create",
  "queues delete",
  "workers versions create",
  "workers deployments create",
  "workers triggers deploy",
  "workers delete",
  "workflows delete",
  "containers applications delete",
  "rulesets account-rulesets rules update",
] as const;

export const operationAllowed = (args: ReadonlyArray<string>): boolean => {
  if (
    args.some((arg) =>
      ["--local", "--bypass-deployment-checks", "--delete-with-references"].includes(arg),
    )
  )
    return false;

  if (args[0] === "build") return true;

  if (args[0] === "deploy" && args.includes("--dry-run")) return true;

  return WRITE_PATHS.some((path) => path.split(" ").every((part, i) => args[i] === part));
};

const execute = promisify(execFile);

/** Opt-in is checked at construction and again for every operation. No implicit auth/profile. */
export const operationRunner = (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly configKeys?: ReadonlyArray<string>;
  readonly secrets?: ReadonlyArray<string>;
}): OperationRunner => {
  const env = commandEnv(options.env);

  for (const key of options.configKeys ?? []) {
    const value = options.env[key];

    if (value !== undefined) env[key] = value;
  }

  const binary = resolve(import.meta.dirname, "../../node_modules/cf/bin/cf");
  let checked = false;

  return {
    async run(operation) {
      if (options.env.BYE_DEPLOY_ENGINE !== "cf")
        throw new Error("cf writes require BYE_DEPLOY_ENGINE=cf");

      if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
        throw new Error("explicit account/token required");

      if (!operationAllowed(operation.args)) throw new Error("unreviewed cf operation");

      const run = async (args: ReadonlyArray<string>) => {
        try {
          const result = await execute(process.execPath, [binary, ...args], {
            cwd: operation.cwd ?? process.cwd(),
            env,
            signal: options.signal,
            timeout: 900_000,
            maxBuffer: 16 * 1024 * 1024,
          });

          return result.stdout;
        } catch {
          // Child errors can include arguments, secret filenames and tool payloads.
          throw new Error("cf operation failed; reconcile live state before retrying");
        }
      };

      if (!checked) {
        if (!(await run(["--version"])).split(/\s+/).includes(`v${CF_VERSION}`))
          throw new Error("cf version differs from reviewed pin");
        checked = true;
      }

      return redact(await run([...operation.args, "--quiet"]), [
        env.CLOUDFLARE_API_TOKEN,
        ...(options.secrets ?? []),
      ]);
    },
  };
};

/** Account API writes must return a single JSON value; project commands have their own output contracts. */
export const writeJson = async (runner: OperationRunner, args: ReadonlyArray<string>) =>
  parseJson(await runner.run({ args }));

export const jsonArgument = <T>(input: T): string => canonical(input);

export interface CloudflareOperations {
  readonly read: CommandRunner;
  readonly write: OperationRunner;
}
