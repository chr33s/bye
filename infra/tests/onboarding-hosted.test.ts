// Hosted onboarding (infra/onboarding/spec.md Part J): Durable Object store, session-mode HTTP,
// registry-to-registry image copy, the remote executor's deployer bootstrap and job polling, and
// the deployer's own job server and Worker. The service flow on these parts is in onboarding.test.ts.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prebuiltImage } from "../resources/container-images.ts";
import { bundleDeployer } from "../onboarding/deployer/build.ts";
import { DEPLOYER_WORKER_MODULE } from "../onboarding/deployer/worker.bundle.ts";
import { deployerHandler, type JobRequest, parseJob } from "../onboarding/deployer/server.ts";
import { DurableObjectStore, MapStorage } from "../onboarding/do-store.ts";
import type { DeployExecutor, ExecutionContext, JobHandle } from "../onboarding/executor.ts";
import { fetchHandler, sessionOperator, signSession } from "../onboarding/http.ts";
import { accountImageRef, parseImageRef } from "../onboarding/images.ts";
import type { Fetch } from "../onboarding/oauth.ts";
import { copyImage } from "../onboarding/oci.ts";
import { deployerName, deployerSecret, remoteExecutor } from "../onboarding/remote.ts";
import type { Installation, Operation, ReleaseRef } from "../onboarding/store.ts";
import type { ExportedPlan } from "../policies/plan-normalize.ts";

const json = <T>(v: T, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The deployer upload's metadata part, as the fake API reads it back. */
interface UploadMetadata {
  readonly tags: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<{ readonly name: string; readonly text?: string }>;
  readonly migrations?: { readonly new_tag: string };
}

const digest = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

describe("DurableObjectStore", () => {
  const store = () => new DurableObjectStore(new MapStorage());

  it("keeps one writer per installation until the holder releases it", async () => {
    const s = store();
    expect(await s.acquireWriter("inst1", "opA")).toBeNull();
    expect(await s.acquireWriter("inst1", "opA")).toBeNull(); // re-entrant for the holder
    expect(await s.acquireWriter("inst1", "opB")).toBe("opA");
    await s.releaseWriter("inst1", "opB"); // not the holder: no effect
    expect(await s.writerHolder("inst1")).toBe("opA");
    await s.releaseWriter("inst1", "opA");
    expect(await s.acquireWriter("inst1", "opB")).toBeNull();
  });

  it("OAuth states are single use, and expired ones are pruned", async () => {
    const s = store();
    const pending = { verifier: "v", sessionId: "s", installationId: "i", createdAt: 0 };
    await s.putPending({ ...pending, state: "live", expiresAt: 100 });
    await s.putPending({ ...pending, state: "old", expiresAt: 1 });
    expect(await s.prunePending(50)).toBe(1);
    expect(await s.takePending("live")).toMatchObject({ state: "live" });
    expect(await s.takePending("live")).toBeNull();
    expect(await s.takePending("old")).toBeNull();
    expect(await s.takePending("../escape")).toBeNull();
  });

  it("indexes installations by operator and by account + stage, following rebinds", async () => {
    const s = store();

    const inst: Installation = {
      id: "inst1",
      operatorId: "session:abc",
      createdAt: "2026-09-28T00:00:00Z",
      accountId: "acc1",
      accountName: "Acc",
      stage: "prod",
      workerName: null,
      stateRef: null,
      boundAt: null,
      firstWriteAt: null,
      urls: null,
      runtimeSecrets: null,
      credentials: null,
      authorization: { status: "none", scopes: [], connectedAt: null, expiresAt: null },
      deployedRelease: null,
      appliedMigrations: [],
      ready: false,
      readyAt: null,
    };

    await s.putInstallation(inst);
    expect(await s.installationForOperator("session:abc")).toMatchObject({ id: "inst1" });
    expect(await s.installationForTarget("acc1", "prod")).toMatchObject({ id: "inst1" });
    await s.putInstallation({ ...inst, accountId: "acc2" });
    expect(await s.installationForTarget("acc1", "prod")).toBeNull();
    expect(await s.installationForTarget("acc2", "prod")).toMatchObject({ id: "inst1" });
    expect(await s.installationIds()).toEqual(["inst1"]);
  });

  it("appends made without waiting keep every event, in call order", async () => {
    const s = store();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        s.appendEvent({
          at: `t${i}`,
          installationId: "inst1",
          operationId: "op",
          kind: "apply.progress",
          detail: `line ${i}`,
        }),
      ),
    );

    expect((await s.events("inst1")).map((e) => e.detail)).toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${i}`),
    );
  });

  it("lists operations per installation and indexes only installations with active work", async () => {
    const s = store();

    const op: Operation = {
      id: "a",
      installationId: "inst1",
      kind: "deploy",
      approvalId: "ap",
      status: "running",
      step: "apply",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      finishedAt: null,
      outcomes: [],
      health: [],
      error: null,
    };

    await s.putOperation(op);
    await s.putOperation({ ...op, id: "z", installationId: "inst2", status: "succeeded" });
    expect((await s.operations("inst1")).map((o) => o.id)).toEqual(["a"]);
    expect(await s.getOperation("z")).toMatchObject({ installationId: "inst2" });
    expect(await s.getOperation("missing")).toBeNull();
    expect(await s.activeInstallationIds()).toEqual(["inst1"]);
    await s.putOperation({ ...op, status: "succeeded" });
    expect(await s.activeInstallationIds()).toEqual([]);
  });

  it("reads an operation's recent events without the whole log", async () => {
    const s = store();

    const event = (operationId: string | null, detail: string) => ({
      at: "t",
      installationId: "inst1",
      operationId,
      kind: "k",
      detail,
    });

    for (let i = 0; i < 60; i++) await s.appendEvent(event("op1", `line ${i}`));
    await s.appendEvent(event("op2", "other"));
    await s.appendEvent(event(null, "installation"));
    expect((await s.recentEvents("inst1", "op1", 50)).map((e) => e.detail)).toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${i + 10}`),
    );
    expect(await s.recentEvents("inst2", "op1", 50)).toEqual([]);
  });

  it("returns events in append order and operations newest first", async () => {
    const s = store();

    for (let i = 0; i < 12; i++)
      await s.appendEvent({
        at: `t${i}`,
        installationId: "inst1",
        operationId: null,
        kind: `k${i}`,
        detail: "",
      });

    expect((await s.events("inst1")).map((e) => e.kind)).toEqual(
      Array.from({ length: 12 }, (_, i) => `k${i}`),
    );

    const op: Operation = {
      id: "a",
      installationId: "inst1",
      kind: "deploy",
      approvalId: "ap",
      status: "succeeded",
      step: "done",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      finishedAt: null,
      outcomes: [],
      health: [],
      error: null,
    };

    await s.putOperation(op);
    await s.putOperation({ ...op, id: "b", createdAt: "2026-02-01" });
    expect((await s.operations("inst1")).map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("onboarding HTTP: hosted session mode", () => {
  const ORIGIN = "https://onboarding.test";
  const SECRET = new Uint8Array(32).fill(3);
  const SESSION = "q".repeat(43);

  const service = {
    status: vi.fn(async (op: string) => ({ operator: op })),
    completeAuthorization: vi.fn(async () => ({ ok: true })),
  };

  const handle = fetchHandler({
    service: service as never,
    origin: ORIGIN,
    operator: { kind: "session" },
    sessionSecret: SECRET,
    sessionMaxAge: 2_592_000,
  });

  const get = (path: string, cookie?: string) => {
    const headers = new Headers({ host: "onboarding.test" });

    if (cookie) headers.set("cookie", cookie);

    return handle(new Request(`${ORIGIN}${path}`, { headers }));
  };

  it("the page issues a long-lived session; API calls without one create nothing", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toContain("Max-Age=2592000");

    for (const path of ["/api/status", "/oauth/callback?state=x&code=y"]) {
      const r = await get(path);
      expect(r.status).toBe(401);
    }

    expect(service.status).not.toHaveBeenCalled();
    expect(service.completeAuthorization).not.toHaveBeenCalled();
  });

  it("the operator is the signed session", async () => {
    const cookie = `__Host-bye-onboarding=${signSession(SECRET, SESSION)}`;
    const r = await get("/api/status", cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ operator: sessionOperator(SESSION) });
    // A cookie signed with another key is not a session.
    const forged = `__Host-bye-onboarding=${signSession(new Uint8Array(32), SESSION)}`;
    expect((await get("/api/status", forged)).status).toBe(401);
  });

  it("refuses an oversized body without reading it all", async () => {
    const cookie = `__Host-bye-onboarding=${signSession(SECRET, SESSION)}`;
    let pulled = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(8_192));

        if (pulled > 1_000) c.close();
      },
    });

    const r = await handle(
      new Request(`${ORIGIN}/api/authorize`, {
        method: "POST",
        headers: {
          host: "onboarding.test",
          cookie,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body,
        // SAFETY: Node's fetch needs `duplex` for a stream body; the DOM type lacks it.
        duplex: "half",
      } as RequestInit),
    );

    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "request too large" });
    expect(pulled).toBeLessThan(10);
  });

  it("still refuses another Host (DNS rebinding)", async () => {
    const r = await handle(new Request(`${ORIGIN}/`, { headers: { host: "evil.test" } }));
    expect(r.status).toBe(421);
  });
});

/** An in-memory OCI registry: Bearer-challenge (anonymous) or Basic auth. */
const fakeRegistry = (host: string, mode: "bearer" | "basic") => {
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, { type: string; body: Uint8Array }>();
  const uploads = new Map<string, true>();
  /** Blob uploads refused with 401 (an expired token) before one is accepted. */
  const refuse = { puts: 0 };
  const log: Array<string> = [];

  const handle = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization") ?? "";
    log.push(`${method} ${url.pathname}`);

    if (url.pathname === "/token") return json({ token: "anon-token" });

    if (mode === "bearer" && auth !== "Bearer anon-token")
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="https://${host}/token",service="${host}",scope="repository:x:pull"`,
        },
      });

    if (mode === "basic" && !auth.startsWith("Basic ")) return new Response(null, { status: 401 });
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);

    if (url.pathname.endsWith("/blobs/uploads/") && method === "POST") {
      const id = `u${uploads.size}`;
      uploads.set(id, true);

      return new Response(null, {
        status: 202,
        headers: { location: `/v2/upload/${id}?_state=abc` },
      });
    }

    if (url.pathname.startsWith("/v2/upload/") && method === "PUT") {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());

      if (refuse.puts > 0) {
        refuse.puts--;

        return new Response(null, { status: 401 });
      }

      const d = url.searchParams.get("digest")!;

      if (digest(body) !== d) return new Response(null, { status: 400 });
      blobs.set(d, body);

      return new Response(null, { status: 201 });
    }

    if (!m) return new Response(null, { status: 404 });
    const [, , kind, ref] = m;

    if (kind === "blobs") {
      const b = blobs.get(ref!);

      if (!b) return new Response(null, { status: 404 });

      return new Response(method === "HEAD" ? null : b, { status: 200 });
    }

    if (method === "PUT") {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      const entry = { type: new Headers(init.headers).get("content-type")!, body };
      manifests.set(ref!, entry);
      manifests.set(digest(body), entry);

      return new Response(null, {
        status: 201,
        headers: { "docker-content-digest": digest(body) },
      });
    }

    const found = manifests.get(ref!);

    if (!found) return new Response(null, { status: 404 });

    return new Response(method === "HEAD" ? null : found.body, {
      status: 200,
      headers: { "content-type": found.type },
    });
  };

  return { host, blobs, manifests, log, handle, refuse };
};

type Registry = ReturnType<typeof fakeRegistry>;

const routing =
  (...registries: ReadonlyArray<Registry>): Fetch =>
  async (url, init) => {
    const u = new URL(url);
    const r = registries.find((x) => x.host === u.host);

    return r ? r.handle(u, init) : new Response("no route", { status: 599 });
  };

/** Publishes a single-platform image in `reg`; returns its pinned reference. */
const publish = (reg: Registry, repository: string, layer = "layer-bytes") => {
  const config = new TextEncoder().encode('{"architecture":"amd64","os":"linux"}');
  const l = new TextEncoder().encode(layer);
  reg.blobs.set(digest(config), config);
  reg.blobs.set(digest(l), l);

  const manifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: digest(config),
        size: config.length,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          digest: digest(l),
          size: l.length,
        },
      ],
    }),
  );

  const entry = { type: "application/vnd.oci.image.manifest.v1+json", body: manifest };
  reg.manifests.set(digest(manifest), entry);

  return `${reg.host}/${repository}@${digest(manifest)}`;
};

const CREDS = { username: "v1", password: "pw" };

describe("OCI copy into the account registry", () => {
  it("copies blobs and the manifest byte for byte, keeping the digest", async () => {
    const ghcr = fakeRegistry("ghcr.io", "bearer");
    const cf = fakeRegistry("registry.cloudflare.com", "basic");
    const source = publish(ghcr, "chr33s/bye/mime");

    const ref = await copyImage({
      fetch: routing(ghcr, cf),
      source,
      target: { registry: cf.host, repository: "acc1/bye-mime" },
      credentials: CREDS,
      tag: "v1.0.0",
    });

    const pinned = parseImageRef(source).digest;
    expect(ref).toBe(`registry.cloudflare.com/acc1/bye-mime@${pinned}`);
    expect(ref).toBe(accountImageRef("acc1", "bye-mime", source));
    expect(cf.blobs.size).toBe(2);
    expect(digest(cf.manifests.get(pinned)!.body)).toBe(pinned);
    expect(cf.manifests.has("v1.0.0")).toBe(true);

    // A second copy finds the manifest and uploads nothing.
    cf.log.length = 0;
    await copyImage({
      fetch: routing(ghcr, cf),
      source,
      target: { registry: cf.host, repository: "acc1/bye-mime" },
      credentials: CREDS,
    });

    expect(cf.log.filter((l) => l.startsWith("PUT") || l.startsWith("POST"))).toEqual([]);
  });

  it("a blob upload refused mid-stream (expired token) is re-streamed from the source once", async () => {
    const ghcr = fakeRegistry("ghcr.io", "bearer");
    const cf = fakeRegistry("registry.cloudflare.com", "basic");
    const source = publish(ghcr, "chr33s/bye/mime");
    cf.refuse.puts = 1;

    await copyImage({
      fetch: routing(ghcr, cf),
      source,
      target: { registry: cf.host, repository: "acc1/bye-mime" },
      credentials: CREDS,
    });

    expect(cf.blobs.size).toBe(2);
    // One of the two blobs was read from the source twice.
    expect(ghcr.log.filter((l) => l.startsWith("GET") && l.includes("/blobs/")).length).toBe(3);

    // Refused again on the retry: a clear registry error, not a disturbed-stream TypeError.
    const again = fakeRegistry("registry.cloudflare.com", "basic");
    again.refuse.puts = 10; // every attempt of every (parallel) blob
    await expect(
      copyImage({
        fetch: routing(ghcr, again),
        source,
        target: { registry: again.host, repository: "acc1/bye-mime" },
        credentials: CREDS,
      }),
    ).rejects.toThrow(/refused blob .* \(401\)/);
  });

  it("refuses a manifest that doesn't match its pin, and multi-platform indexes", async () => {
    const ghcr = fakeRegistry("ghcr.io", "bearer");
    const cf = fakeRegistry("registry.cloudflare.com", "basic");
    const source = publish(ghcr, "chr33s/bye/mime");
    const pinned = parseImageRef(source).digest;

    const tampered = {
      type: "application/vnd.oci.image.manifest.v1+json",
      body: new TextEncoder().encode("{}"),
    };

    ghcr.manifests.set(pinned, tampered);

    const copy = (s: string) =>
      copyImage({
        fetch: routing(ghcr, cf),
        source: s,
        target: { registry: cf.host, repository: "acc1/bye-mime" },
        credentials: CREDS,
      });

    await expect(copy(source)).rejects.toThrow(/does not match its pinned digest/);

    const index = new TextEncoder().encode(
      JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }),
    );

    ghcr.manifests.set(digest(index), {
      type: "application/vnd.oci.image.index.v1+json",
      body: index,
    });
    await expect(copy(`ghcr.io/chr33s/bye/mime@${digest(index)}`)).rejects.toThrow(
      /multi-platform/,
    );
    await expect(copy("ghcr.io/chr33s/bye/mime:latest")).rejects.toThrow(/pinned by digest/);
    expect(cf.blobs.size).toBe(0);
  });
});

describe("remote executor: deployer bootstrap and jobs", () => {
  const ACCOUNT = "acc1";
  const INSTALL = "inst0000001";
  const KEY = new Uint8Array(32).fill(9);

  const plan: ExportedPlan = {
    format: "bye.plan-export.v1",
    stack: "MailboxPlatform",
    stage: "prod",
    operation: "deploy",
    rows: [],
  };

  /** Cloudflare API + registries + the deployer at its workers.dev URL. */
  const world = () => {
    const ghcr = fakeRegistry("ghcr.io", "bearer");
    const cfReg = fakeRegistry("registry.cloudflare.com", "basic");

    const release: ReleaseRef = {
      version: "v1.0.0",
      commit: "c".repeat(40),
      lockfileDigest: "d".repeat(64),
      images: {
        deployer: publish(ghcr, "chr33s/bye/deployer", "deployer"),
        scanner: publish(ghcr, "chr33s/bye/scanner", "scanner"),
        mime: publish(ghcr, "chr33s/bye/mime", "mime"),
        sigmirror: publish(ghcr, "chr33s/bye/sigmirror", "sigmirror"),
      },
    };

    const state = {
      script: null as null | { tags: ReadonlyArray<string>; metadata: UploadMetadata },
      apps: [] as Array<{ id: string; name: string; image: string }>,
      rollouts: 0,
      deployerUp: false,
      /** Health polls that still see the previous container while a rollout replaces it. */
      rolloutLag: 0,
      patches: 0,
      /** A job already running on the deployer when the next one is posted. */
      busy: null as null | "plan" | "apply",
      deployerRelease: "",
      deployerImage: "",
      jobs: [] as Array<JobRequest>,
      lines: ["one", "two", "three"],
      aborts: 0,
      pollFailures: 0,
      apiCalls: [] as Array<string>,
    };

    const api: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      const path = u.pathname.replace("/client/v4", "");
      state.apiCalls.push(`${method} ${path}`);
      const script = `/accounts/${ACCOUNT}/workers/scripts/bye-abc-deployer`;

      if (path === `/accounts/${ACCOUNT}/workers/subdomain`)
        return json({ result: { subdomain: "op" } });

      if (path === `/accounts/${ACCOUNT}/containers/registries/registry.cloudflare.com/credentials`)
        return json({ result: { username: "v1", password: "pw" } });

      if (path === `${script}/settings`)
        return state.script
          ? json({
              result: {
                tags: state.script.tags,
                bindings: [
                  { type: "durable_object_namespace", class_name: "Deployer", namespace_id: "ns1" },
                ],
              },
            })
          : json({ errors: [{ code: 10007, message: "not found" }] }, 404);

      if (path === script && method === "PUT") {
        const form = init!.body as FormData;
        const metadata = JSON.parse(form.get("metadata") as string) as UploadMetadata;
        state.script = { tags: metadata.tags, metadata };
        const text = (name: string) => metadata.bindings.find((b) => b.name === name)!.text!;

        state.deployerRelease = text("DEPLOYER_RELEASE");
        state.deployerImage = text("DEPLOYER_IMAGE");

        return json({ result: {} });
      }

      if (path === `${script}/subdomain`) return json({ result: {} });
      const apps = `/accounts/${ACCOUNT}/containers/applications`;

      if (path === apps && method === "GET")
        return json({
          result: state.apps.map((a) => ({ ...a, configuration: { image: a.image } })),
        });

      if (path === apps && method === "POST") {
        const body = JSON.parse(init!.body as string) as {
          name: string;
          configuration: { image: string };
        };

        state.apps.push({ id: "app1", name: body.name, image: body.configuration.image });
        state.deployerUp = true;

        return json({ result: { id: "app1" } });
      }

      if (path === `${apps}/app1` && method === "PATCH") {
        const body = JSON.parse(init!.body as string) as { configuration: { image: string } };
        state.apps[0] = { ...state.apps[0]!, image: body.configuration.image };
        state.patches++;
        state.deployerUp = true;

        return json({ result: {} });
      }

      if (path === `${apps}/app1/rollouts`) {
        state.rollouts++;

        return json({ result: {} });
      }

      return json({ errors: [{ message: `unexpected ${method} ${path}` }] }, 500);
    };

    const secret = deployerSecret(KEY, INSTALL);

    const deployer: Fetch = async (url, init) => {
      const u = new URL(url);
      const headers = new Headers(init?.headers);

      if (headers.get("authorization") !== `Bearer ${secret}`)
        return json({ error: "unauthorized" }, 401);

      if (!state.deployerUp) return json({ error: "starting" }, 503);

      if (u.pathname === "/health") {
        const old = state.rolloutLag > 0;
        state.rolloutLag = Math.max(0, state.rolloutLag - 1);

        return json({
          ok: true,
          release: state.deployerRelease,
          image: state.deployerImage,
          commit: old ? "0".repeat(40) : release.commit,
        });
      }

      if (u.pathname === "/jobs" && init?.method === "POST") {
        if (state.busy) {
          const kind = state.busy;

          // A plan finishes (it is followed to the end); an apply keeps running.
          if (kind === "plan") state.busy = null;

          return json({ error: "another job is running", id: "a".repeat(24), kind }, 409);
        }

        state.jobs.push(parseJob(init.body as string)!);

        return json({ id: "a".repeat(24) }, 202);
      }

      if (u.pathname.endsWith("/abort")) {
        state.aborts++;

        return json({}, 202);
      }

      if (state.pollFailures > 0) {
        state.pollFailures--;

        return json({ error: "gone" }, 503);
      }

      // Only the one job this deployer ran; anything else is gone (container restarted).
      if (!u.pathname.startsWith(`/jobs/${"a".repeat(24)}`))
        return json({ error: "not found" }, 404);
      const from = Number(u.searchParams.get("from"));
      const kind = state.jobs.at(-1)?.kind ?? "plan";
      const done = from >= state.lines.length;

      return json({
        id: "a".repeat(24),
        lines: state.lines.slice(from, from + 2),
        next: Math.min(from + 2, state.lines.length),
        done,
        result: done
          ? kind === "plan"
            ? { ok: true, aborted: false, detail: "planned", plan }
            : {
                ok: state.aborts === 0,
                aborted: state.aborts > 0,
                detail: state.aborts ? "stopped" : "applied",
              }
          : null,
      });
    };

    const fetcher: Fetch = async (url, init) => {
      const u = new URL(url);

      if (u.host === "api.cloudflare.com") return api(url, init);

      if (u.host === "bye-abc-deployer.op.workers.dev") return deployer(url, init);

      return routing(ghcr, cfReg)(url, init);
    };

    const executor = remoteExecutor({
      fetch: fetcher,
      deployerKey: KEY,
      release: () => release,
      deployerModule: "export default {}",
      compatibilityDate: "2026-07-30",
      pollMs: 1,
      readyTimeoutMs: 1_000,
      maxPollFailures: 3,
      sleep: async () => {},
    });

    const ctx = (signal = new AbortController().signal): ExecutionContext => ({
      installationId: INSTALL,
      releaseDir: "/srv/bye",
      homeDir: "/tmp/x",
      stage: "prod",
      accountId: ACCOUNT,
      apiToken: "oauth-access-token",
      config: { BYE_WORKERS_DEV_NAME: "bye-abc", APP_ORIGIN: "https://bye.example.com" },
      signal,
    });

    return { state, executor, ctx, cfReg, release };
  };

  it("bootstraps the deployer in the account on first plan, then reuses it", async () => {
    const w = world();
    expect(await w.executor.plan(w.ctx())).toEqual(plan);

    // Four images copied into the account's registry with their pinned digests.
    for (const name of ["deployer", "scanner", "mime", "sigmirror"] as const)
      expect(w.cfReg.manifests.has(parseImageRef(w.release.images![name]).digest)).toBe(true);

    const meta = w.state.script!.metadata;
    expect(meta).toMatchObject({
      main_module: "worker.js",
      containers: [{ class_name: "Deployer" }],
      migrations: { new_tag: "v1", new_sqlite_classes: ["Deployer"] },
      tags: ["bye-deployer", `bye-install:${INSTALL}`],
    });
    expect(JSON.stringify(meta)).not.toContain("oauth-access-token");
    expect(w.state.apps).toEqual([
      {
        id: "app1",
        name: deployerName("bye-abc"),
        image: accountImageRef(ACCOUNT, "bye-deployer", w.release.images!.deployer),
      },
    ]);

    // The job carries the token and config; the release commit pins the deployer's checkout.
    expect(w.state.jobs[0]).toMatchObject({
      kind: "plan",
      release: { commit: "c".repeat(40) },
      ctx: { apiToken: "oauth-access-token", config: { BYE_WORKERS_DEV_NAME: "bye-abc" } },
    });

    // Second plan: the deployer reports the pinned release, so nothing is re-provisioned.
    w.state.apiCalls.length = 0;
    await w.executor.plan(w.ctx());
    expect(w.state.apiCalls.filter((c) => !c.endsWith("/workers/subdomain"))).toEqual([]);
  });

  it("a new release updates the deployer in place (no new migration, a rollout)", async () => {
    const w = world();
    await w.executor.plan(w.ctx());
    w.state.deployerRelease = "v0.9.0"; // the running deployer is older
    await w.executor.plan(w.ctx());
    expect(w.state.script!.metadata.migrations).toBeUndefined();
    expect(w.state.rollouts).toBe(1);
    expect(w.state.apps).toHaveLength(1);
  });

  it("waits for a container rollout instead of uploading again or running the old container", async () => {
    const w = world();
    await w.executor.plan(w.ctx());
    // The Worker is on this release but its container is still the previous one.
    w.state.rolloutLag = 2;
    w.state.apiCalls.length = 0;
    const jobs = w.state.jobs.length;
    await w.executor.plan(w.ctx());
    expect(w.state.rolloutLag).toBe(0);
    expect(w.state.apiCalls.filter((c) => c.startsWith("PUT") || c.startsWith("PATCH"))).toEqual(
      [],
    );
    expect(w.state.rollouts).toBe(0);
    // The job was posted only once the new container answered.
    expect(w.state.jobs).toHaveLength(jobs + 1);
  });

  it("retries a container update that failed after the Worker upload", async () => {
    const w = world();
    await w.executor.plan(w.ctx());
    // The Worker was uploaded for this release, but its container application still names
    // another image (the PATCH failed), and the running container is the previous one.
    w.state.apps[0] = {
      ...w.state.apps[0]!,
      image: "registry.cloudflare.com/acc1/bye-deployer@sha256:old",
    };
    w.state.rolloutLag = 1;
    await w.executor.plan(w.ctx());
    expect(w.state.patches).toBe(1);
    expect(w.state.rollouts).toBe(1);
    expect(w.state.apps[0]!.image).toBe(
      accountImageRef(ACCOUNT, "bye-deployer", w.release.images!.deployer),
    );
  });

  it("a plan left running is waited for; a running apply is reported, not queued behind", async () => {
    const w = world();
    await w.executor.plan(w.ctx());
    w.state.busy = "plan";
    await expect(w.executor.plan(w.ctx())).resolves.toEqual(plan);
    w.state.busy = "apply";
    await expect(w.executor.plan(w.ctx())).rejects.toThrow(/still applying/);
  });

  it("never overwrites a Worker with the deployer's name that isn't this installation's", async () => {
    const w = world();
    w.state.script = { tags: ["someone-else"], metadata: { tags: ["someone-else"], bindings: [] } };
    await expect(w.executor.plan(w.ctx())).rejects.toThrow(/not this installation's deployer/);
    expect(w.state.apps).toEqual([]);
  });

  it("apply streams the job's lines and reports its result", async () => {
    const w = world();
    const lines: Array<string> = [];
    const r = await w.executor.apply(w.ctx(), (l) => lines.push(l));
    expect(r).toEqual({ ok: true, aborted: false, detail: "applied" });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("a stop aborts the job on the deployer; lost contact is reported as uncertain", async () => {
    const w = world();
    const c = new AbortController();
    await w.executor.plan(w.ctx()); // bootstrapped
    c.abort();
    const stopped = await w.executor.apply(w.ctx(c.signal), () => {});
    expect(w.state.aborts).toBe(1);
    expect(stopped).toMatchObject({ ok: false, aborted: true });

    const lost = world();
    await lost.executor.plan(lost.ctx());
    lost.state.pollFailures = 10;
    const r = await lost.executor.apply(lost.ctx(), () => {});
    expect(r).toEqual({
      ok: false,
      aborted: false,
      detail: "lost contact with the deployer; the deploy's outcome is uncertain",
    });
  });

  it("apply reports its job handle; resume follows it from a line, or reports it gone", async () => {
    const w = world();
    const handles: Array<JobHandle> = [];
    await w.executor.apply(
      w.ctx(),
      () => {},
      (h) => void handles.push(h),
    );
    expect(handles).toEqual([
      { id: "a".repeat(24), endpoint: "https://bye-abc-deployer.op.workers.dev" },
    ]);

    // A restarted service: no Cloudflare API calls, only the deployer with the derived secret.
    w.state.apiCalls.length = 0;
    const lines: Array<string> = [];
    const resumed = await w.executor.resume!(w.ctx(), handles[0]!, 1, (l) => lines.push(l));
    expect(resumed).toEqual({ ok: true, aborted: false, detail: "applied" });
    expect(lines).toEqual(["two", "three"]);
    expect(w.state.apiCalls).toEqual([]);

    const gone = await w.executor.resume!(
      w.ctx(),
      { ...handles[0]!, id: "b".repeat(24) },
      0,
      () => {},
    );

    expect(gone).toMatchObject({ ok: false, aborted: false });
    expect(gone.detail).toMatch(/no longer has this job/);
  });

  it("deployer secrets differ per installation and are reproducible", () => {
    expect(deployerSecret(KEY, "a")).toBe(deployerSecret(KEY, "a"));
    expect(deployerSecret(KEY, "a")).not.toBe(deployerSecret(KEY, "b"));
    expect(deployerSecret(KEY, "a")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

/** A job request as a client might send it, including invalid kinds and ids. */
interface JobFixture {
  readonly kind: string;
  readonly release: { readonly version: string; readonly commit: string };
  readonly ctx: Omit<JobRequest["ctx"], "installationId"> & { readonly installationId: string };
}

describe("deployer container job server", () => {
  const COMMIT = "c".repeat(40);

  const job = (kind: "plan" | "apply", commit = COMMIT): JobFixture => ({
    kind,
    release: { version: "v1.0.0", commit },
    ctx: {
      installationId: "inst1",
      stage: "prod",
      accountId: "acc1",
      apiToken: "tok",
      config: { A: "1" },
    },
  });

  const plan: ExportedPlan = {
    format: "bye.plan-export.v1",
    stack: "MailboxPlatform",
    stage: "prod",
    operation: "deploy",
    rows: [],
  };

  const setup = () => {
    let release: () => void = () => {};

    const seen: Array<ExecutionContext> = [];

    const executor: DeployExecutor = {
      async plan(ctx) {
        seen.push(ctx);

        return plan;
      },
      async apply(ctx, onLine) {
        seen.push(ctx);
        onLine("applying");
        await new Promise<void>((r) => {
          release = r;
          ctx.signal.addEventListener("abort", () => r());
        });

        return { ok: !ctx.signal.aborted, aborted: ctx.signal.aborted, detail: "done" };
      },
    };

    const handle = deployerHandler({
      executor,
      releaseDir: "/srv/bye",
      releaseCommit: COMMIT,
      homes: "/tmp/h",
    });

    /** Bodies go through the same parser as the HTTP server, malformed ones included. */
    const call = (method: string, path: string, body: JobFixture | null = null) =>
      handle(method, new URL(`http://deployer${path}`), parseJob(JSON.stringify(body)));

    return { call, seen, release: () => release() };
  };

  it("runs a plan in the baked checkout with a per-installation HOME", async () => {
    const d = setup();
    const [status, started] = await d.call("POST", "/jobs", job("plan"));
    expect(status).toBe(202);
    const id = (started as { id: string }).id;
    await new Promise((r) => setTimeout(r, 0));
    const [, view] = await d.call("GET", `/jobs/${id}?from=0`);
    expect(view).toMatchObject({ done: true, result: { ok: true, plan } });
    expect(d.seen[0]).toMatchObject({
      releaseDir: "/srv/bye",
      homeDir: "/tmp/h/inst1",
      apiToken: "tok",
    });
  });

  it("keeps only the newest finished jobs", async () => {
    const d = setup();
    const ids: Array<string> = [];

    for (let i = 0; i < 4; i++) {
      const [, started] = await d.call("POST", "/jobs", job("plan"));
      ids.push((started as { id: string }).id);
      await new Promise((r) => setTimeout(r, 0));
    }

    expect((await d.call("GET", `/jobs/${ids[0]}`))[0]).toBe(404);
    expect((await d.call("GET", `/jobs/${ids[1]}`))[0]).toBe(404);
    expect((await d.call("GET", `/jobs/${ids[3]}`))[0]).toBe(200);
  });

  it("one job at a time; another release's job and malformed jobs are refused", async () => {
    const d = setup();
    const [, started] = await d.call("POST", "/jobs", job("apply"));
    const id = (started as { id: string }).id;
    expect((await d.call("POST", "/jobs", job("plan")))[0]).toBe(409);
    expect((await d.call("POST", "/jobs", job("plan", "e".repeat(40))))[0]).toBe(409);
    expect((await d.call("POST", "/jobs", { ...job("plan"), kind: "destroy" }))[0]).toBe(400);
    expect(
      (
        await d.call("POST", "/jobs", {
          ...job("plan"),
          ctx: { ...job("plan").ctx, installationId: "../x" },
        })
      )[0],
    ).toBe(400);

    // Lines stream, then an abort stops the job.
    const [, running] = await d.call("GET", `/jobs/${id}?from=0`);
    expect(running).toMatchObject({ lines: ["applying"], next: 1, done: false });
    expect((await d.call("POST", `/jobs/${id}/abort`))[0]).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    const [, done] = await d.call("GET", `/jobs/${id}?from=1`);
    expect(done).toMatchObject({ lines: [], done: true, result: { ok: false, aborted: true } });
    // The slot is free again.
    expect((await d.call("POST", "/jobs", job("plan")))[0]).toBe(202);
  });
});

describe("deployer Worker bundle and stack images", () => {
  it("the committed deployer bundle matches worker.ts (pnpm build:onboarding)", async () => {
    expect(DEPLOYER_WORKER_MODULE).toBe(await bundleDeployer());
  });

  it("prebuilt images must be pinned by digest; empty means build", () => {
    expect(prebuiltImage({}, "MIME_IMAGE")).toBeUndefined();
    expect(prebuiltImage({ MIME_IMAGE: " " }, "MIME_IMAGE")).toBeUndefined();
    const pinned = `registry.cloudflare.com/acc/bye-mime@sha256:${"a".repeat(64)}`;
    expect(prebuiltImage({ MIME_IMAGE: pinned }, "MIME_IMAGE")).toBe(pinned);
    expect(() =>
      prebuiltImage({ SIGMIRROR_IMAGE: "ghcr.io/x/y:latest" }, "SIGMIRROR_IMAGE"),
    ).toThrow(/pinned by digest/);
  });
});
