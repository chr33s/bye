// Runs the existing Alchemy stack for one installation (spec.md §15.11 "Use the existing
// Alchemy stack ... Do not maintain a second resource definition"). Planning is plan-export.ts;
// applying is the repository's own `pnpm run deploy` (web build, guard-stage, alchemy deploy), in
// the pinned release checkout. Each run gets an isolated environment: its own HOME (Alchemy's
// local profile and caches), only allowlisted variables, the installation's account and token,
// the chosen Bye hostname (APP_DOMAIN) and every other domain/mail switch forced empty.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExportedPlan } from "../policies/plan-normalize.ts";
import { encode } from "./seal.ts";
import { REQUIRED_DEPLOY_ENV } from "../policies/telemetry.ts";

export interface ExecutionContext {
  readonly installationId: string;
  /** Pinned release checkout. */
  readonly releaseDir: string;
  /** Per-installation private directory (HOME for the child process). */
  readonly homeDir: string;
  readonly stage: string;
  readonly accountId: string;
  /** OAuth access token; only ever passed through the child environment. */
  readonly apiToken: string;
  /** Stack configuration: origins, BYE_WORKERS_DEV_NAME and runtime secrets. */
  readonly config: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly aborted: boolean;
}

export interface DeployExecutor {
  plan(ctx: ExecutionContext): Promise<ExportedPlan>;
  apply(ctx: ExecutionContext, onLine: (line: string) => void): Promise<ApplyResult>;
}

/**
 * Stack inputs that would configure public domains, DNS or mail routing. Always empty for
 * onboarding: MX/Email Routing is the separate, post-owner incoming-email activation.
 */
export const FORCED_EMPTY = [
  // The operator's base domain must never become an installation's hosts (resources/domain.ts).
  "DOMAIN",
  "PUBLIC_DOMAIN",
  "MAIL_ZONE",
  "BYE_MX_CUTOVER",
  "BYE_SERVICE_ZONE",
  "CF_DNS_API_TOKEN",
  "CF_CACHE_PURGE_TOKEN",
  "CF_PUBLIC_ZONE_ID",
  "BYE_CANARY_PERCENT",
] as const;

const PASSTHROUGH = ["PATH", "LANG", "TZ", "SystemRoot", "TMPDIR"] as const;

export const childEnv = (
  ctx: ExecutionContext,
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
) => {
  const env: Record<string, string> = {};

  for (const k of PASSTHROUGH) if (parent[k] !== undefined) env[k] = parent[k]!;
  Object.assign(env, REQUIRED_DEPLOY_ENV, ctx.config, extra, {
    HOME: ctx.homeDir,
    XDG_CONFIG_HOME: join(ctx.homeDir, ".config"),
    XDG_CACHE_HOME: join(ctx.homeDir, ".cache"),
    STAGE: ctx.stage,
    CLOUDFLARE_ACCOUNT_ID: ctx.accountId,
    CLOUDFLARE_API_TOKEN: ctx.apiToken,
    STATE_BACKEND: "cloudflare",
  });

  for (const k of FORCED_EMPTY) env[k] = "";
  // Only the installation's own chosen hostname, never a value inherited from elsewhere.
  env.APP_DOMAIN = ctx.config.APP_DOMAIN ?? "";

  return env;
};

/** Replaces every secret value (token, runtime secrets) in a line of child output. */
export const redactor = (secrets: ReadonlyArray<string>) => {
  const values = secrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);

  return (line: string): string => {
    let out = line;

    for (const v of values) out = out.split(v).join("[redacted]");

    // Bearer headers or token assignments from any tool that echoes them.
    return out.replace(/(bearer\s+|token["'=:\s]+)[A-Za-z0-9._~+/-]{16,}/gi, "$1[redacted]");
  };
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<{ code: number | null; aborted: boolean }> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let aborted = false;

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    const lines = (chunk: Buffer) => {
      for (const l of encode(chunk, "utf8").split("\n")) if (l.trim() !== "") onLine(l);
    };

    child.stdout.on("data", lines);
    child.stderr.on("data", lines);
    child.on("error", () => resolve({ code: null, aborted }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      resolve({ code, aborted });
    });
  });

export const processExecutor = (
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): DeployExecutor => ({
  async plan(ctx) {
    mkdirSync(ctx.homeDir, { recursive: true, mode: 0o700 });
    const out = mkdtempSync(join(ctx.homeDir, "plan-"));
    const redact = redactor([ctx.apiToken, ...Object.values(ctx.config)]);
    const tail: Array<string> = [];

    try {
      // The plan hashes the web assets and the MIME container context, so build them first
      // exactly as `pnpm run deploy` will (build:web + build:mime).
      const built = await run(
        "pnpm",
        ["run", "build:deploy"],
        ctx.releaseDir,
        childEnv(ctx, parentEnv),
        ctx.signal,
        (l) => tail.push(redact(l)),
      );

      if (built.aborted) throw new Error("planning was cancelled");

      if (built.code !== 0)
        throw new Error(`build failed: ${tail.slice(-5).join(" | ") || `exit ${built.code}`}`);

      const r = await run(
        process.execPath,
        ["--experimental-strip-types", "infra/policies/plan-export.ts", out, "deploy"],
        ctx.releaseDir,
        childEnv(ctx, parentEnv),
        ctx.signal,
        (l) => tail.push(redact(l)),
      );

      if (r.aborted) throw new Error("planning was cancelled");

      if (r.code !== 0)
        throw new Error(`planning failed: ${tail.slice(-5).join(" | ") || `exit ${r.code}`}`);

      return JSON.parse(readFileSync(join(out, "plan-export.json"), "utf8")) as ExportedPlan;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
  async apply(ctx, onLine) {
    mkdirSync(ctx.homeDir, { recursive: true, mode: 0o700 });
    const redact = redactor([ctx.apiToken, ...Object.values(ctx.config)]);

    const r = await run(
      "pnpm",
      ["run", "deploy"],
      ctx.releaseDir,
      // The service verified the approval against a fresh plan just before this call.
      childEnv(ctx, parentEnv, {
        BYE_DEPLOY_WRITER: "onboarding",
        BYE_RELEASE_MANIFEST_VERIFIED: "1",
      }),
      ctx.signal,
      (l) => onLine(redact(l)),
    );

    return {
      ok: r.code === 0 && !r.aborted,
      aborted: r.aborted,
      detail: r.aborted ? "stopped" : r.code === 0 ? "applied" : `deploy exited with ${r.code}`,
    };
  },
});
