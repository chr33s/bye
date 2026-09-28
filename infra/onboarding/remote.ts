// Hosted execution (infra/onboarding/spec.md §42, §44): a DeployExecutor that runs the Alchemy
// stack in a deployer Worker + Container in the installation's own account. Before every plan it
// bootstraps that deployer (idempotently) with the operator's OAuth token: release images copied
// into the account's registry, the deployer script, its workers.dev route and its container
// application. Plans and applies are jobs on the deployer, polled until done; the token travels
// in each job request and the deployer never stores it.
import { createHmac } from "node:crypto";
import { CLOUDFLARE_API } from "./cloudflare.ts";
import type { ApplyResult, DeployExecutor, ExecutionContext } from "./executor.ts";
import { ACCOUNT_REGISTRY, accountImageRef, INSTALL_IMAGES } from "./images.ts";
import type { Fetch } from "./oauth.ts";
import { copyImage, type RegistryCredentials } from "./oci.ts";
import type { JobView } from "./deployer/server.ts";
import type { ReleaseImages, ReleaseRef } from "./store.ts";

/** The deployer's Durable Object class (container-backed) and its binding. */
export const DEPLOYER_CLASS = "Deployer";

export const DEPLOYER_MODULE = "worker.js";

/** Enough for pnpm, the web build and Alchemy; one instance per installation. */
export const DEPLOYER_INSTANCE_TYPE = "standard-2";

export const deployerName = (workersDevName: string) => `${workersDevName}-deployer`;

/** Per-installation request secret: reproducible, never stored, unrelated across installations. */
export const deployerSecret = (key: Uint8Array, installationId: string) =>
  createHmac("sha256", key).update(`bye-deployer\0${installationId}`).digest("base64url");

export class DeployerError extends Error {}

/** What the deployer's `/health` reports: the release and image it was bootstrapped with. */
interface DeployerHealth {
  readonly ok: boolean;
  readonly release: string;
  readonly image: string;
  /** The commit the running container was built from. */
  readonly commit: string;
}

export interface RemoteExecutorOptions {
  readonly fetch: Fetch;
  /** HMAC key for deployer secrets (BYE_ONBOARDING_DEPLOYER_KEY). */
  readonly deployerKey: Uint8Array;
  /** The pinned release (same source as the service's); its images and version. */
  readonly release: () => ReleaseRef | null;
  /** The bundled deployer module (deployer/worker.bundle.ts). */
  readonly deployerModule: string;
  readonly compatibilityDate: string;
  readonly api?: string;
  readonly pollMs?: number;
  /** How long a fresh deployer may take to answer (container rollout and cold start). */
  readonly readyTimeoutMs?: number;
  /** Consecutive failed polls before the job is reported lost (outcome uncertain). */
  readonly maxPollFailures?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const remoteExecutor = (o: RemoteExecutorOptions): DeployExecutor => {
  const api = o.api ?? CLOUDFLARE_API;
  const pollMs = o.pollMs ?? 2_000;
  const sleep = o.sleep ?? defaultSleep;

  const cf = async <T>(
    token: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; result: T | null; errors: string }> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const r = await o.fetch(`${api}${path}`, { ...init, headers });

    const body = (await r.json().catch(() => ({}))) as {
      result?: T;
      errors?: ReadonlyArray<{ code?: number; message?: string }>;
    };

    return {
      status: r.status,
      result: r.ok ? (body.result ?? null) : null,
      errors: (body.errors ?? [])
        .map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
        .join("; "),
    };
  };

  const must = <T>(what: string, r: { status: number; result: T | null; errors: string }): T => {
    if (r.result === null)
      throw new DeployerError(
        `Cloudflare refused ${what} (${r.status}${r.errors ? `: ${r.errors}` : ""})`,
      );

    return r.result;
  };

  const target = (ctx: ExecutionContext) => {
    const workersDevName = ctx.config.BYE_WORKERS_DEV_NAME;

    if (!workersDevName) throw new DeployerError("the installation has no Worker name yet");
    const release = o.release();

    if (!release?.images)
      throw new DeployerError("the pinned release has no images; hosted installs need them");

    return {
      account: encodeURIComponent(ctx.accountId),
      script: deployerName(workersDevName),
      secret: deployerSecret(o.deployerKey, ctx.installationId),
      release,
      images: release.images,
      deployerImage: accountImageRef(
        ctx.accountId,
        INSTALL_IMAGES.deployer,
        release.images.deployer,
      ),
    };
  };

  type Target = ReturnType<typeof target>;

  const deployerUrl = async (ctx: ExecutionContext, t: Target) => {
    const sub = must(
      "the workers.dev subdomain",
      await cf<{ subdomain?: string }>(ctx.apiToken, `/accounts/${t.account}/workers/subdomain`),
    ).subdomain;

    if (!sub) throw new DeployerError("the account has no workers.dev subdomain");

    return `https://${t.script}.${sub}.workers.dev`;
  };

  const health = async (url: string, secret: string): Promise<DeployerHealth | null> => {
    try {
      const r = await o.fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(30_000),
      });

      return r.ok ? ((await r.json()) as DeployerHealth) : null;
    } catch {
      return null;
    }
  };

  /** The deployer Worker was uploaded for this release (its container may still be rolling out). */
  const uploaded = (h: DeployerHealth | null, t: Target) =>
    h !== null && h.ok && h.release === t.release.version && h.image === t.deployerImage;

  /** Uploaded, and the running container is this release's. */
  const current = (h: DeployerHealth | null, t: Target) =>
    uploaded(h, t) && h!.commit === t.release.commit;

  /** Copies the four release images into the account's registry (no-op when present). */
  const copyImages = async (ctx: ExecutionContext, t: Target) => {
    const creds = must(
      "registry credentials",
      await cf<{ username?: string; user?: string; password?: string }>(
        ctx.apiToken,
        `/accounts/${t.account}/containers/registries/${ACCOUNT_REGISTRY}/credentials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions: ["pull", "push"], expiration_minutes: 60 }),
        },
      ),
    );

    const username = creds.username ?? creds.user;

    if (!username || !creds.password) throw new DeployerError("registry credentials were empty");
    const credentials: RegistryCredentials = { username, password: creds.password };

    // bounded: the release's four images (INSTALL_IMAGES), each copying a few blobs at a time.
    await Promise.all(
      (Object.keys(INSTALL_IMAGES) as Array<keyof ReleaseImages>).map((name) =>
        copyImage({
          fetch: o.fetch,
          source: t.images[name],
          target: {
            registry: ACCOUNT_REGISTRY,
            repository: `${ctx.accountId}/${INSTALL_IMAGES[name]}`,
          },
          credentials,
          tag: t.release.version,
        }),
      ),
    );
  };

  /** The script's settings, or null when no script has that name. */
  const settings = async (ctx: ExecutionContext, t: Target) => {
    const r = await cf<{
      tags?: ReadonlyArray<string>;
      bindings?: ReadonlyArray<{ type: string; class_name?: string; namespace_id?: string }>;
    }>(ctx.apiToken, `/accounts/${t.account}/workers/scripts/${t.script}/settings`);

    if (r.status === 404) return null;

    return must("the deployer script settings", r);
  };

  const upload = async (ctx: ExecutionContext, t: Target, first: boolean) => {
    const metadata = {
      main_module: DEPLOYER_MODULE,
      compatibility_date: o.compatibilityDate,
      compatibility_flags: [],
      bindings: [
        { type: "durable_object_namespace", name: "DEPLOYER", class_name: DEPLOYER_CLASS },
        { type: "secret_text", name: "DEPLOYER_SECRET", text: t.secret },
        { type: "plain_text", name: "DEPLOYER_RELEASE", text: t.release.version },
        { type: "plain_text", name: "DEPLOYER_IMAGE", text: t.deployerImage },
      ],
      containers: [{ class_name: DEPLOYER_CLASS }],
      tags: ["bye-deployer", `bye-install:${ctx.installationId}`],
      observability: { enabled: false },
    };

    // Only the first upload creates the class; later uploads keep it (and its SQLite storage).
    const migrations = { new_tag: "v1", new_sqlite_classes: [DEPLOYER_CLASS] };

    const form = new FormData();
    form.set("metadata", JSON.stringify(first ? { ...metadata, migrations } : metadata));
    form.set(
      DEPLOYER_MODULE,
      new Blob([o.deployerModule], { type: "application/javascript+module" }),
      DEPLOYER_MODULE,
    );

    must(
      "the deployer upload",
      await cf(ctx.apiToken, `/accounts/${t.account}/workers/scripts/${t.script}`, {
        method: "PUT",
        body: form,
      }),
    );

    must(
      "the deployer's workers.dev route",
      await cf(ctx.apiToken, `/accounts/${t.account}/workers/scripts/${t.script}/subdomain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      }),
    );
  };

  const namespaceId = async (ctx: ExecutionContext, t: Target) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = (await settings(ctx, t))?.bindings?.find(
        (b) => b.type === "durable_object_namespace" && b.class_name === DEPLOYER_CLASS,
      )?.namespace_id;

      if (id) return id;
      await sleep(Math.min(500 * 2 ** attempt, 5_000));
    }

    throw new DeployerError("the deployer's Durable Object namespace did not appear");
  };

  const appsPath = (t: Target) => `/accounts/${t.account}/containers/applications`;

  const configuration = (t: Target) => ({
    image: t.deployerImage,
    instance_type: DEPLOYER_INSTANCE_TYPE,
  });

  /** The deployer's container application, if it exists. */
  const containerApp = async (ctx: ExecutionContext, t: Target) =>
    must(
      "the container application list",
      await cf<ReadonlyArray<{ id: string; name: string; configuration?: { image?: string } }>>(
        ctx.apiToken,
        appsPath(t),
      ),
    ).find((a) => a.name === t.script) ?? null;

  /** When this process last asked for a rollout per installation (a new one replaces it). */
  const rollouts = new Map<string, number>();

  const rollout = async (ctx: ExecutionContext, t: Target, appId: string) => {
    must(
      "the deployer container rollout",
      await cf(ctx.apiToken, `${appsPath(t)}/${appId}/rollouts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: `Bye ${t.release.version}`,
          strategy: "rolling",
          kind: "full_auto",
          step_percentage: 100,
          target_configuration: configuration(t),
        }),
      }),
    );
    rollouts.set(ctx.installationId, Date.now());
  };

  /** Creates the container application, or points it at this release's image and rolls out. */
  const provisionContainer = async (ctx: ExecutionContext, t: Target) => {
    const existing = await containerApp(ctx, t);

    if (existing) {
      must(
        "the deployer container update",
        await cf(ctx.apiToken, `${appsPath(t)}/${existing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ max_instances: 1, configuration: configuration(t) }),
        }),
      );

      return rollout(ctx, t, existing.id);
    }

    must(
      "the deployer container",
      await cf(ctx.apiToken, appsPath(t), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: t.script,
          instances: 0,
          max_instances: 1,
          scheduling_policy: "default",
          configuration: configuration(t),
          durable_objects: { namespace_id: await namespaceId(ctx, t) },
        }),
      }),
    );
    // Creating the application starts its first container, like a rollout.
    rollouts.set(ctx.installationId, Date.now());
  };

  /** Bootstraps the deployer when it is missing or on another release; returns its URL. */
  const ensure = async (ctx: ExecutionContext, t: Target): Promise<string> => {
    const url = await deployerUrl(ctx, t);
    const now = await health(url, t.secret);
    const readyTimeout = o.readyTimeoutMs ?? 10 * 60_000;

    if (current(now, t)) return url;

    if (!uploaded(now, t)) {
      const existing = await settings(ctx, t);

      // A script with this name that isn't this installation's deployer is never overwritten.
      if (existing && !(existing.tags ?? []).includes(`bye-install:${ctx.installationId}`))
        throw new DeployerError(
          `a Worker named ${t.script} already exists in the account and is not this installation's deployer`,
        );

      await copyImages(ctx, t);
      await upload(ctx, t, existing === null);
      await provisionContainer(ctx, t);
    } else {
      // The Worker is on this release but its container is not (yet). A container update or
      // rollout that failed after the upload is retried; one this process started recently is
      // left to finish instead of being restarted.
      const app = await containerApp(ctx, t);

      if (!app || app.configuration?.image !== t.deployerImage) await provisionContainer(ctx, t);
      else if (Date.now() - (rollouts.get(ctx.installationId) ?? 0) > readyTimeout)
        await rollout(ctx, t, app.id);
    }

    const deadline = Date.now() + readyTimeout;

    for (;;) {
      if (ctx.signal.aborted) throw new DeployerError("cancelled while the deployer was starting");

      if (current(await health(url, t.secret), t)) return url;

      if (Date.now() > deadline)
        throw new DeployerError("the deployer did not start in time; review again to retry");
      await sleep(pollMs * 2);
    }
  };

  /** The job request: everything the child process needs, including the token (never stored). */
  const jobBody = (ctx: ExecutionContext, kind: "plan" | "apply", t: Target) =>
    JSON.stringify({
      kind,
      release: { version: t.release.version, commit: t.release.commit },
      ctx: {
        installationId: ctx.installationId,
        stage: ctx.stage,
        accountId: ctx.accountId,
        apiToken: ctx.apiToken,
        config: ctx.config,
      },
    });

  const deployer =
    (url: string, secret: string) =>
    (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${secret}`);

      return o.fetch(`${url}${path}`, { ...init, headers });
    };

  const start = async (
    call: ReturnType<typeof deployer>,
    ctx: ExecutionContext,
    kind: "plan" | "apply",
    t: Target,
  ) => {
    // One job at a time. A plan left running (a review whose page was closed) finishes within
    // minutes, so wait for it; a running apply is a deployment, which this must not queue behind.
    for (let attempt = 0; ; attempt++) {
      const r = await call("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jobBody(ctx, kind, t),
      });

      const body = (await r.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        kind?: "plan" | "apply";
      };

      if (r.status === 202 && body.id) return body.id;

      if (r.status === 409 && body.id && body.kind === "plan" && attempt < 3) {
        await follow(call, body.id, ctx.signal, () => {});
        continue;
      }

      if (r.status === 409 && body.kind === "apply")
        throw new DeployerError(
          "a deployment is still applying on the deployer; wait for it to finish, then review again",
        );

      throw new DeployerError(`the deployer refused the ${kind} (${body.error ?? r.status})`);
    }
  };

  /**
   * Polls a job to completion from line `from`; aborts it (once) when `signal` fires. "lost" when
   * the deployer stops answering, "unknown" when it answers but no longer has the job (its
   * container restarted, so the run died with it).
   */
  const follow = async (
    call: ReturnType<typeof deployer>,
    id: string,
    signal: AbortSignal,
    onLine: (line: string) => void,
    from = 0,
  ): Promise<JobView["result"] | "lost" | "unknown"> => {
    let next = from;
    let failures = 0;
    let abortSent = false;

    for (;;) {
      if (signal.aborted && !abortSent) {
        abortSent = true;
        await call(`/jobs/${id}/abort`, { method: "POST" }).catch(() => undefined);
      }

      let view: JobView | null = null;

      try {
        const r = await call(`/jobs/${id}?from=${next}`);

        if (r.status === 404) return "unknown";
        view = r.ok ? ((await r.json()) as JobView) : null;
      } catch {
        view = null;
      }

      if (view === null) {
        if (++failures >= (o.maxPollFailures ?? 30)) return "lost";
      } else {
        failures = 0;

        for (const l of view.lines) onLine(l);
        next = view.next;

        if (view.done) return view.result;
      }

      await sleep(pollMs);
    }
  };

  const outcome = (
    result: JobView["result"] | "lost" | "unknown",
    signal: AbortSignal,
  ): ApplyResult => {
    if (result === "unknown")
      return {
        ok: false,
        aborted: false,
        detail:
          "the deployer no longer has this job (its container restarted); the deploy's outcome is uncertain",
      };

    if (result === "lost" || result === null)
      return {
        ok: false,
        aborted: signal.aborted,
        detail: "lost contact with the deployer; the deploy's outcome is uncertain",
      };

    return { ok: result.ok, aborted: result.aborted, detail: result.detail };
  };

  return {
    provisionsOnPlan: true,
    async plan(ctx) {
      const t = target(ctx);
      const call = deployer(await ensure(ctx, t), t.secret);
      const result = await follow(call, await start(call, ctx, "plan", t), ctx.signal, () => {});

      if (result === "lost" || result === "unknown" || result === null)
        throw new DeployerError("lost contact with the deployer while planning");

      if (!result.ok || !result.plan)
        throw new DeployerError(result.aborted ? "planning was cancelled" : result.detail);

      return result.plan;
    },
    async apply(ctx, onLine, onStarted): Promise<ApplyResult> {
      const t = target(ctx);
      const endpoint = await ensure(ctx, t);
      const call = deployer(endpoint, t.secret);
      const id = await start(call, ctx, "apply", t);
      // Recorded before following, so a restarted service can pick the job up again.
      await onStarted?.({ id, endpoint });

      return outcome(await follow(call, id, ctx.signal, onLine), ctx.signal);
    },
    async resume(ctx, job, from, onLine): Promise<ApplyResult> {
      // Only the installation's secret: no Cloudflare API call, so it works whatever the token.
      const call = deployer(job.endpoint, deployerSecret(o.deployerKey, ctx.installationId));

      return outcome(await follow(call, job.id, ctx.signal, onLine, from), ctx.signal);
    },
  };
};
