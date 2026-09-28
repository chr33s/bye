// Deployer container (infra/onboarding/spec.md §42): runs plans and applies for one installation
// with the existing process executor (executor.ts), in the release checkout baked into the image.
// Reachable only through its Durable Object, which the deployer Worker guards with the
// installation's secret. One job at a time; the OAuth token lives only in the job's request and
// its child process, and is dropped when the job ends.
//
//   BYE_RELEASE_DIR=/srv/bye  BYE_RELEASE_COMMIT=<sha>  PORT=8080
//
// Usage: node --experimental-strip-types infra/onboarding/deployer/server.ts
import { Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { DeployExecutor, ExecutionContext } from "../executor.ts";
import { DEPLOYER_RELEASE_DIR } from "../hosted-release.ts";
import { readBody } from "../node-body.ts";
import { encode } from "../seal.ts";
import type { ExportedPlan } from "../../policies/plan-normalize.ts";

/** A job request is a context and configuration: a few KiB. */
const MAX_JOB_BYTES = 256 * 1024;

/** Finished jobs kept for polling (the service reads each result right after it finishes). */
const KEEP_FINISHED = 2;

/** Lines kept per job (the service records at most 400 as progress events). */
export const MAX_LINES = 2_000;

export interface JobResult {
  readonly ok: boolean;
  readonly aborted: boolean;
  readonly detail: string;
  readonly plan?: ExportedPlan;
}

interface Job {
  readonly id: string;
  readonly kind: "plan" | "apply";
  readonly lines: Array<string>;
  readonly controller: AbortController;
  done: boolean;
  result: JobResult | null;
}

export interface DeployerOptions {
  readonly executor: DeployExecutor;
  /** Release checkout baked into the image, and the commit it was built from. */
  readonly releaseDir: string;
  readonly releaseCommit: string;
  /** Parent of per-installation HOME directories. */
  readonly homes: string;
}

const JobRequest = Schema.Struct({
  kind: Schema.Literals(["plan", "apply"]),
  release: Schema.Struct({ version: Schema.String, commit: Schema.String }),
  ctx: Schema.Struct({
    installationId: Schema.String,
    stage: Schema.String,
    accountId: Schema.String,
    apiToken: Schema.String,
    config: Schema.Record(Schema.String, Schema.String),
  }),
});

export type JobRequest = typeof JobRequest.Type;

const decodeJobRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JobRequest));

/** A well-formed job (from the request body) whose installation id is safe as a directory name. */
export const parseJob = (text: string): JobRequest | null => {
  const req = Option.getOrNull(decodeJobRequest(text));

  return req && /^[A-Za-z0-9_-]{1,64}$/.test(req.ctx.installationId) ? req : null;
};

/** What `GET /jobs/:id` returns (remote.ts polls it). */
export interface JobView {
  readonly id: string;
  readonly lines: ReadonlyArray<string>;
  readonly next: number;
  readonly done: boolean;
  readonly result: JobResult | null;
}

type Reply =
  | { readonly ok: true; readonly commit: string }
  | { readonly id: string }
  | { readonly error: string; readonly id?: string; readonly kind?: Job["kind"] }
  | JobView;

export const deployerHandler = (o: DeployerOptions) => {
  const jobs = new Map<string, Job>();
  let active: Job | null = null;

  const run = async (job: Job, req: JobRequest) => {
    const ctx: ExecutionContext = {
      ...req.ctx,
      releaseDir: o.releaseDir,
      homeDir: join(o.homes, req.ctx.installationId),
      signal: job.controller.signal,
    };

    const line = (l: string) => {
      if (job.lines.length < MAX_LINES) job.lines.push(l);
    };

    try {
      if (job.kind === "plan") {
        const plan = await o.executor.plan(ctx);
        job.result = { ok: true, aborted: false, detail: "planned", plan };
      } else job.result = await o.executor.apply(ctx, line);
    } catch (e) {
      job.result = {
        ok: false,
        aborted: job.controller.signal.aborted,
        detail: e instanceof Error ? e.message : `${job.kind} failed`,
      };
    } finally {
      job.done = true;
      active = null;
      // Finished jobs hold their log and plan: keep only the newest few (Map order is insertion).
      const finished = [...jobs.values()].filter((j) => j.done);

      for (const old of finished.slice(0, -KEEP_FINISHED)) jobs.delete(old.id);
    }
  };

  return async (method: string, url: URL, req: JobRequest | null): Promise<[number, Reply]> => {
    // The commit this container was built from: what it will actually run, whatever the
    // Worker in front of it was just told (a rollout replaces containers after the upload).
    if (method === "GET" && url.pathname === "/health")
      return [200, { ok: true, commit: o.releaseCommit }];

    if (method === "POST" && url.pathname === "/jobs") {
      if (!req) return [400, { error: "invalid job" }];

      // The image is the release: a job for another release must not run this checkout.
      if (req.release.commit !== o.releaseCommit)
        return [
          409,
          {
            error: `this deployer runs ${o.releaseCommit.slice(0, 12)}, not the requested release`,
          },
        ];

      if (active)
        return [409, { error: "another job is running", id: active.id, kind: active.kind }];

      const job: Job = {
        id: encode(randomBytes(12), "hex"),
        kind: req.kind,
        lines: [],
        controller: new AbortController(),
        done: false,
        result: null,
      };

      jobs.set(job.id, job);
      active = job;
      void run(job, req);

      return [202, { id: job.id }];
    }

    const m = /^\/jobs\/([0-9a-f]{24})(\/abort)?$/.exec(url.pathname);
    const job = m ? jobs.get(m[1]!) : undefined;

    if (!job) return [404, { error: "not found" }];

    if (method === "POST" && m![2]) {
      job.controller.abort();

      return [202, { id: job.id }];
    }

    if (method === "GET" && !m![2]) {
      const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) || 0);

      return [
        200,
        {
          id: job.id,
          lines: job.lines.slice(from),
          next: job.lines.length,
          done: job.done,
          result: job.result,
        },
      ];
    }

    return [405, { error: "method not allowed" }];
  };
};

if (import.meta.main) {
  const { processExecutor } = await import("../executor.ts");
  const releaseDir = process.env.BYE_RELEASE_DIR ?? DEPLOYER_RELEASE_DIR;
  const releaseCommit = process.env.BYE_RELEASE_COMMIT ?? "";

  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
    console.error(
      "deployer: set BYE_RELEASE_COMMIT to the release commit the image was built from",
    );
    process.exit(2);
  }

  const handle = deployerHandler({
    // The child gets only allowlisted variables (childEnv); this process's env is not passed on.
    executor: processExecutor(),
    releaseDir,
    releaseCommit,
    homes: "/tmp/bye-homes",
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let reply: [number, Reply];

    try {
      const url = new URL(req.url ?? "/", "http://deployer");
      const text = encode(await readBody(req, MAX_JOB_BYTES), "utf8");
      reply = await handle(req.method ?? "GET", url, parseJob(text));
    } catch {
      reply = [400, { error: "bad request" }];
    }

    res.writeHead(reply[0], { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(reply[1]));
  });

  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
    console.log(`deployer: release ${releaseCommit.slice(0, 12)} ready`),
  );
}
