import { Schema } from "effect";
import { decode } from "./schemas.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { CF_VERSION } from "../policies/check-versions.ts";

const execute = promisify(execFile);

export { CF_VERSION };

export const CF_ENV = { DO_NOT_TRACK: "1", CF_SEND_TELEMETRY: "false", CI: "true" } as const;

const ALLOWED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "SystemRoot",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
] as const;

interface CommandEnvironment extends Record<string, string> {
  readonly DO_NOT_TRACK: "1";
  readonly CF_SEND_TELEMETRY: "false";
  readonly CI: "true";
}

export const commandEnv = (
  source: Readonly<Record<string, string | undefined>>,
): CommandEnvironment => ({
  ...Object.fromEntries(
    ALLOWED_ENV.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  ),
  ...CF_ENV,
});

export const redact = (output: string, secrets: ReadonlyArray<string>): string => {
  let result = output;

  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[redacted]");

  return result.replace(
    /(bearer\s+|(?:api[_-]?token|authorization|secret)["'=:\s]+)[A-Za-z0-9._~+/-]{8,}/gi,
    "$1[redacted]",
  );
};

/** No heuristic extraction from banner/log text: stdout must be exactly one JSON value. */
export const parseJson = (stdout: string): Schema.Schema.Type<typeof Schema.Json> => {
  try {
    return decode(Schema.Json, JSON.parse(stdout));
  } catch {
    throw new Error("cf did not return valid JSON");
  }
};

export interface CommandRunner {
  json(args: ReadonlyArray<string>): Promise<Schema.Schema.Type<typeof Schema.Json>>;
}

/** This runner intentionally exposes only reviewed read operations during characterization. */
const READ_COMMANDS = [
  "d1 list",
  "d1 get",
  "r2 buckets list",
  "r2 buckets lifecycle get",
  "r2 buckets domains managed list",
  "r2 buckets domains custom list",
  "r2 buckets get",
  "kv namespaces list",
  "kv namespaces get",
  "queues list",
  "queues get",
  "queues consumers list",
  "workers list",
  "observability telemetry query",
  "workers get",
  "workers deployments list",
  "workers versions get",
  "workers versions list",
  "durable-objects namespaces list",
  "workflows list",
  "workflows get",
  "containers applications list",
  "containers applications get",
  "d1 migrations list",
  "turnstile widgets list",
  "email-routing settings get",
  "email-routing rules catch-all get",
  "zones list",
  "zones get",
  "rulesets list",
  "rulesets get",
  "rulesets account-rulesets get",
] as const;

export const readCommand = (args: ReadonlyArray<string>): boolean =>
  (args.slice(0, 3).join(" ") !== "observability telemetry query" || args.includes("--dry")) &&
  READ_COMMANDS.some((command) => {
    const path = command.split(" ");

    return (
      path.every((part, i) => args[i] === part) &&
      args.slice(path.length).every((part) => !["--body", "--local", "--dry-run"].includes(part))
    );
  });

export const cfRunner = (
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  } = {},
): CommandRunner => {
  const cwd = options.cwd ?? process.cwd();
  const env = commandEnv(options.env ?? process.env);
  const binary = resolve(import.meta.dirname, "../../node_modules/cf/bin/cf");
  let characterized = false;

  return {
    async json(args) {
      if (!readCommand(args)) throw new Error("cf operation is not a reviewed read command");

      if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
        throw new Error("explicit Cloudflare account/token required; implicit auth is disabled");

      const run = async (argv: ReadonlyArray<string>): Promise<string> => {
        try {
          const result = await execute(process.execPath, [binary, ...argv], {
            cwd,
            env,
            signal: options.signal,
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          });

          return result.stdout;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "command failed";
          throw new Error(redact(message, [env.CLOUDFLARE_API_TOKEN ?? ""]));
        }
      };

      if (!characterized) {
        const version = await run(["--version"]);

        if (!version.split(/\s+/).includes(`v${CF_VERSION}`))
          throw new Error("cf version differs from the reviewed pin");
        characterized = true;
      }

      return parseJson(await run([...args, "--quiet"]));
    },
  };
};
