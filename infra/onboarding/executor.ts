import { Schema } from "effect";
// Runs the selected deployment engine in the pinned release, with an isolated
// installation HOME, explicit credentials and forced private domain/mail settings.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExportedPlan } from "../policies/plan-normalize.ts";
import { newResourceMap } from "../cf/resource-map.ts";
import { writeArtifact } from "../cf/artifacts.ts";
import { CF_ENV } from "../cf/command.ts";
import { deploymentEngine } from "../cf/dispatch.ts";
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

/** A detached apply (hosted deployer job) that outlives the process following it. */
export interface JobHandle {
  readonly id: string;
  /** Where the job runs (the deployer's origin); not a secret. */
  readonly endpoint: string;
}

export interface DeployExecutor {
  /**
   * Planning writes to the account (hosted: it provisions the deployer first), so the service
   * records it and never plans for a target that fails its prerequisites.
   */
  readonly provisionsOnPlan?: boolean;
  plan(ctx: ExecutionContext): Promise<ExportedPlan>;
  /** `onStarted` fires once when the apply runs as a detached job that `resume` can follow. */
  apply(
    ctx: ExecutionContext,
    onLine: (line: string) => void,
    onStarted?: (job: JobHandle) => void | Promise<void>,
  ): Promise<ApplyResult>;
  /**
   * Follows a detached apply from line `from` after a restart. A job the executor no longer has
   * (its runner restarted) resolves as not ok with an uncertain outcome. Absent: applies die with
   * the process that runs them, so a restarted service marks them interrupted.
   */
  resume?(
    ctx: ExecutionContext,
    job: JobHandle,
    from: number,
    onLine: (line: string) => void,
  ): Promise<ApplyResult>;
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

interface ApplyEnvironment extends Record<string, string> {
  readonly BYE_DEPLOY_WRITER: string;
  readonly BYE_RELEASE_MANIFEST_VERIFIED: string;
}

const PASSTHROUGH = ["PATH", "LANG", "TZ", "SystemRoot", "TMPDIR"] as const;

export const childEnv = (
  ctx: ExecutionContext,
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
) => {
  const env: Record<string, string> = {};

  for (const k of PASSTHROUGH) if (parent[k] !== undefined) env[k] = parent[k]!;
  const engine = deploymentEngine(ctx.config.BYE_DEPLOY_ENGINE ?? parent.BYE_DEPLOY_ENGINE);
  Object.assign(env, engine === "cf" ? CF_ENV : REQUIRED_DEPLOY_ENV, ctx.config, extra, {
    HOME: ctx.homeDir,
    XDG_CONFIG_HOME: join(ctx.homeDir, ".config"),
    XDG_CACHE_HOME: join(ctx.homeDir, ".cache"),
    STAGE: ctx.stage,
    CLOUDFLARE_ACCOUNT_ID: ctx.accountId,
    CLOUDFLARE_API_TOKEN: ctx.apiToken,
    BYE_DEPLOY_ENGINE: engine,
  });

  if (engine === "alchemy") env.STATE_BACKEND = "cloudflare";
  else {
    for (const key of Object.keys(env))
      if (
        key.startsWith("BYE_STATE_") ||
        ["STATE_BACKEND", "ALCHEMY_TELEMETRY_DISABLED", "NO_TRACK"].includes(key)
      )
        delete env[key];
    env.BYE_CF_RESOURCE_MAP = join(ctx.homeDir, "resolved.cf-resources.json");
    const adoptionPath = ctx.config.BYE_CF_ADOPTION ?? join(ctx.homeDir, "adoption.json");
    env.BYE_CF_ADOPTION = existsSync(adoptionPath) ? adoptionPath : "";
    env.BYE_CF_INITIAL_STAGE = env.BYE_CF_ADOPTION ? "" : "1";

    if (parent.BYE_RELEASE_COMMIT) env.BYE_RELEASE_COMMIT = parent.BYE_RELEASE_COMMIT;
    else delete env.BYE_RELEASE_COMMIT;

    for (const key of ["BYE_CF_LOCK_URL", "BYE_CF_LOCK_CREDENTIAL"] as const)
      if (parent[key]) env[key] = parent[key]!;
    env.PROBE_BASE_URL = ctx.config.APP_ORIGIN ?? "";
  }

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

/**
 * Whole lines from a byte stream. A chunk can end mid-line (and mid-secret), so the tail is held
 * until its newline arrives: the redactor only matches a secret it sees whole.
 */
export const lineSplitter = (onLine: (line: string) => void) => {
  let partial = "";
  const decoder = new TextDecoder();

  const emit = (text: string) => {
    if (text.trim() !== "") onLine(text);
  };

  return {
    push: (chunk: Uint8Array) => {
      const parts = (partial + decoder.decode(chunk, { stream: true })).split("\n");
      partial = parts.pop() ?? "";

      for (const l of parts) emit(l);
    },
    flush: () => {
      emit(partial + decoder.decode());
      partial = "";
    },
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

    const out = lineSplitter(onLine);
    const err = lineSplitter(onLine);
    child.stdout.on("data", out.push);
    child.stderr.on("data", err.push);
    child.on("error", () => resolve({ code: null, aborted }));
    child.on("close", (code) => {
      out.flush();
      err.flush();
      signal.removeEventListener("abort", abort);
      resolve({ code, aborted });
    });
  });

export const processExecutor = (
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): DeployExecutor => ({
  async plan(ctx) {
    mkdirSync(ctx.homeDir, { recursive: true, mode: 0o700 });
    const environment = childEnv(ctx, parentEnv);

    if (environment.BYE_DEPLOY_ENGINE === "cf" && !existsSync(environment.BYE_CF_RESOURCE_MAP!))
      writeArtifact(
        environment.BYE_CF_RESOURCE_MAP!,
        newResourceMap(
          ctx.stage,
          ctx.accountId,
          ctx.config.BYE_WORKERS_DEV_NAME || undefined,
          true,
        ),
      );

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
        childEnv(ctx, parentEnv).BYE_DEPLOY_ENGINE === "cf"
          ? [
              "--experimental-strip-types",
              "infra/cf/cli.ts",
              "plan",
              "--out",
              join(out, "plan.json"),
            ]
          : ["--experimental-strip-types", "infra/policies/plan-export.ts", out, "deploy"],
        ctx.releaseDir,
        childEnv(ctx, parentEnv),
        ctx.signal,
        (l) => tail.push(redact(l)),
      );

      if (r.aborted) throw new Error("planning was cancelled");

      if (r.code !== 0)
        throw new Error(`planning failed: ${tail.slice(-5).join(" | ") || `exit ${r.code}`}`);

      const cf = childEnv(ctx, parentEnv).BYE_DEPLOY_ENGINE === "cf";

      const plan = JSON.parse(
        readFileSync(join(out, cf ? "plan.json.export.json" : "plan-export.json"), "utf8"),
      ) as ExportedPlan;

      if (cf) {
        if (!/^[a-f0-9]{64}$/.test(plan.cfApprovalDigest ?? ""))
          throw new Error("cf plan is missing its approval digest");
        writeFileSync(
          join(ctx.homeDir, "cf-approval.json"),
          JSON.stringify({ digest: plan.cfApprovalDigest }),
          { mode: 0o600 },
        );
      }

      return plan;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
  async apply(ctx, onLine) {
    mkdirSync(ctx.homeDir, { recursive: true, mode: 0o700 });
    const redact = redactor([ctx.apiToken, ...Object.values(ctx.config)]);

    const extra: ApplyEnvironment = {
      BYE_DEPLOY_WRITER: "onboarding",
      BYE_RELEASE_MANIFEST_VERIFIED: "1",
    };

    if (childEnv(ctx, parentEnv).BYE_DEPLOY_ENGINE === "cf") {
      const approved = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.NonEmptyString }))(
        JSON.parse(readFileSync(join(ctx.homeDir, "cf-approval.json"), "utf8")),
      );

      extra.BYE_CF_APPROVED_DIGEST = approved.digest;
      extra.BYE_CF_OUTPUT = mkdtempSync(join(ctx.homeDir, "cf-evidence-"));
    }

    const r = await run(
      "pnpm",
      ["run", "deploy"],
      ctx.releaseDir,
      // The service verified the approval against a fresh plan just before this call.
      childEnv(ctx, parentEnv, extra),
      ctx.signal,
      (l) => onLine(redact(l)),
    );

    if (r.code === 0 && !r.aborted && extra.BYE_CF_OUTPUT) {
      copyFileSync(
        join(extra.BYE_CF_OUTPUT, "final.cf-resources.json"),
        join(ctx.homeDir, "resolved.cf-resources.json"),
      );
      copyFileSync(
        join(extra.BYE_CF_OUTPUT, "final.adoption.json"),
        join(ctx.homeDir, "adoption.json"),
      );
    }

    return {
      ok: r.code === 0 && !r.aborted,
      aborted: r.aborted,
      detail: r.aborted ? "stopped" : r.code === 0 ? "applied" : `deploy exited with ${r.code}`,
    };
  },
});
