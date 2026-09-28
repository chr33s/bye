// Cloudflare onboarding acceptance (spec.md §15.11 OB01–OB10) against fakes for Cloudflare's
// OAuth/API, the Alchemy executor and the deployed instance. Real-Cloudflare validation is the
// separate release record in infra/onboarding/README.md.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInstanceHandoff } from "../../packages/native-shared/src/instance/handoff.ts";
import { INVENTORY } from "../resources/inventory.ts";
import type { ExportedPlan, ExportedPlanRow } from "../policies/plan-normalize.ts";
import { guard } from "../policies/guard-stage.ts";
import { requiredConfig, scannerProblems } from "../policies/check-config.ts";
import { DurableObjectStore, MapStorage } from "../onboarding/do-store.ts";
import { manifestRelease } from "../onboarding/hosted-release.ts";
import {
  type Account,
  type CloudflareReader,
  cloudflareReader,
  type Zone,
} from "../onboarding/cloudflare.ts";
import {
  childEnv,
  type DeployExecutor,
  type ExecutionContext,
  type JobHandle,
  redactor,
} from "../onboarding/executor.ts";
import { checkCallback, cloudflareOAuthConfig, type Fetch } from "../onboarding/oauth.ts";
import { encodeQr } from "../onboarding/qr.ts";
import {
  approvalCovers,
  buildReview,
  domainProblems,
  isPermittedCustomDomain,
  isProhibited,
  STANDARD_FIRST_INSTALL_TYPES,
} from "../onboarding/review.ts";
import {
  coverageGaps,
  forbiddenScopes,
  ONBOARDING_SCOPES,
  requestedScopes,
} from "../onboarding/scopes.ts";
import { open, parseKeyRing, seal } from "../onboarding/seal.ts";
import {
  DEFAULT_HOSTNAME_LABEL,
  dkimPublicKey,
  handoffFor,
  OnboardingError,
  OnboardingService,
  type ReleaseSource,
} from "../onboarding/service.ts";
import { ONBOARDING_PAGE } from "../onboarding/ui.ts";
import { QUALIFICATION_FILE, releaseQualification } from "../onboarding/release.ts";
import { FileStore } from "../onboarding/file-store.ts";
import { MemoryStore, type OnboardingStore } from "../onboarding/store.ts";

const KEYS = parseKeyRing(`v1:${"ab".repeat(32)}`);

const ACCOUNT: Account = { id: "acc0000000000000000000000000001", name: "Operator Co" };

const OTHER: Account = { id: "acc0000000000000000000000000002", name: "Someone Else" };

const ZONE: Zone = {
  id: "zone00000000000000000000000000001",
  name: "example.com",
  status: "active",
};

const PENDING_ZONE: Zone = {
  id: "zone00000000000000000000000000002",
  name: "pending.test",
  status: "pending",
};

const OTHER_ZONE: Zone = {
  id: "zone00000000000000000000000000003",
  name: "other.test",
  status: "active",
};

/** The repository itself stands in for the pinned release checkout. */
const REPO = join(import.meta.dirname, "../..");

const RELEASE = { version: "v1.0.0", commit: "c".repeat(40), lockfileDigest: "d".repeat(64) };

const ACCESS = "cf-access-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const REFRESH = "cf-refresh-token-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const coreBindings = INVENTORY.filter((e) => e.owner === "stack" && e.binding !== undefined).map(
  (e) => e.binding as string,
);

const row = (
  logicalId: string,
  resourceType: string,
  action: ExportedPlanRow["action"],
): ExportedPlanRow => {
  const planRow: ExportedPlanRow = {
    fqn: `MailboxPlatform/${logicalId}`,
    logicalId,
    resourceType,
    action,
  };

  if (logicalId === "MailCore") return { ...planRow, envBindings: coreBindings };

  return planRow;
};

const RESOURCES: ReadonlyArray<readonly [string, string]> = [
  ["MailCore", "Cloudflare.Worker"],
  ["PublicSite", "Cloudflare.Worker"],
  ["RenderOrigin", "Cloudflare.Worker"],
  ["Directory", "Cloudflare.D1Database"],
  ["Originals", "Cloudflare.R2.Bucket"],
  ["Mailboxes", "Cloudflare.DurableObject"],
  ["Ingest", "Cloudflare.Queues.Queue"],
];

const planOf = (
  stage: string,
  actions: Partial<Record<string, ExportedPlanRow["action"]>> = {},
  extra: ReadonlyArray<ExportedPlanRow> = [],
): ExportedPlan => ({
  format: "bye.plan-export.v1",
  stack: "MailboxPlatform",
  stage,
  operation: "deploy",
  rows: [...RESOURCES.map(([id, type]) => row(id, type, actions[id] ?? "create")), ...extra],
});

const allNoop = (stage: string) =>
  planOf(stage, Object.fromEntries(RESOURCES.map(([id]) => [id, "noop" as const])));

class FakeExecutor implements DeployExecutor {
  plans: Array<(ctx: ExecutionContext) => ExportedPlan> = [];
  defaultPlan: (ctx: ExecutionContext) => ExportedPlan = (ctx) => planOf(ctx.stage);
  applies: Array<ExecutionContext> = [];
  applyBehavior: (
    ctx: ExecutionContext,
  ) => Promise<{ ok: boolean; detail: string; aborted: boolean }> = async () => ({
    ok: true,
    detail: "applied",
    aborted: false,
  });
  planCalls = 0;
  applied = false;
  async plan(ctx: ExecutionContext) {
    this.planCalls++;

    if (this.applied && this.plans.length === 0) return allNoop(ctx.stage);

    return (this.plans.shift() ?? this.defaultPlan)(ctx);
  }
  async apply(ctx: ExecutionContext, onLine: (l: string) => void) {
    this.applies.push(ctx);
    onLine(`deploying with ${ctx.apiToken}`); // must be redacted downstream
    const r = await this.applyBehavior(ctx);

    if (r.ok) this.applied = true;

    return r;
  }
}

/** Runs applies as detached jobs (like the hosted deployer), which a restarted service can follow. */
class ResumableExecutor extends FakeExecutor {
  resumes: Array<{ job: JobHandle; from: number }> = [];
  resumeBehavior: () => Promise<{ ok: boolean; detail: string; aborted: boolean }> = async () => ({
    ok: true,
    detail: "applied",
    aborted: false,
  });
  override async apply(
    ctx: ExecutionContext,
    onLine: (l: string) => void,
    onStarted?: (job: JobHandle) => void | Promise<void>,
  ) {
    await onStarted?.({ id: "job1", endpoint: "https://bye-deployer.operator.workers.dev" });

    return super.apply(ctx, onLine);
  }
  async resume(ctx: ExecutionContext, job: JobHandle, from: number, onLine: (l: string) => void) {
    this.resumes.push({ job, from });
    onLine(`resumed for ${ctx.installationId}`);
    const r = await this.resumeBehavior();

    if (r.ok) this.applied = true;

    return r;
  }
}

const fakeCloudflare = (
  accounts: ReadonlyArray<Account> = [ACCOUNT],
): CloudflareReader & {
  workers: Array<string>;
  accountsFor: (token: string) => ReadonlyArray<Account>;
  zonesFor: (accountId: string) => ReadonlyArray<Zone>;
} => {
  const cf = {
    workers: [] as Array<string>,
    accountsFor: (_token: string) => accounts,
    zonesFor: (accountId: string) =>
      accountId === ACCOUNT.id ? [ZONE, PENDING_ZONE] : accountId === OTHER.id ? [OTHER_ZONE] : [],
    async accounts(token: string) {
      return cf.accountsFor(token);
    },
    async zones(_token: string, accountId: string) {
      return cf.zonesFor(accountId);
    },
    async workersSubdomain() {
      return "operator";
    },
    async workerNames() {
      return cf.workers;
    },
  };

  return cf;
};

interface World {
  readonly store: OnboardingStore;
  readonly service: OnboardingService;
  readonly executor: FakeExecutor;
  readonly cf: ReturnType<typeof fakeCloudflare>;
  readonly calls: Array<string>;
  readonly revoked: Array<string>;
  health: (url: string, init?: RequestInit) => Response | Promise<Response> | null;
  release: ReleaseSource;
  now: number;
}

const json = <T>(v: T, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** A healthy deployed instance at the workers.dev URLs onboarding computes. */
const healthyInstance = (app: string) => {
  const probes = new Map<string, number>();

  return (url: string, init?: RequestInit): Response | null => {
    const u = new URL(url);
    const probe = (init?.headers as Record<string, string> | undefined)?.["x-bye-probe-token"];

    if (u.origin === app) {
      if (u.pathname === "/.well-known/bye-instance")
        return json({ schema: "bye.instance/1", baseUrl: app, issuer: app });

      if (u.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: app });

      if (u.pathname === "/v1/me") return json({ error: { code: "unauthenticated" } }, 401);

      if (u.pathname.startsWith("/__probe/")) {
        if (!probe) return json({}, 404);
        const kind = u.pathname.split("/")[2]!;

        if (init?.method === "POST") {
          if (kind === "calendar") return json({ ok: true, starts: [] });
          probes.set(kind, 1);

          return json({}, 202);
        }

        if (kind === "queue") return json({ receivedAt: "now" });

        if (kind === "alarm") return json({ firedAt: 1 });

        if (kind === "workflow") return json({ status: "complete", marker: "m" });
      }
    }

    if (u.hostname.includes("-render.")) return new Response("not found", { status: 404 });

    if (u.hostname.includes("-site.")) return new Response("ok");

    return null;
  };
};

/** The scope matrix once the release record has verified every scope. */
const VERIFIED = ONBOARDING_SCOPES.map((g) => ({ ...g, verified: true }));

const world = (
  options: {
    store?: OnboardingStore;
    executor?: FakeExecutor;
    accounts?: ReadonlyArray<Account>;
    verifiedScopes?: boolean;
  } = {},
): World => {
  const calls: Array<string> = [];
  const revoked: Array<string> = [];
  const store = options.store ?? new MemoryStore();
  const executor = options.executor ?? new FakeExecutor();
  const cf = fakeCloudflare(options.accounts);

  const w: World = {
    store,
    executor,
    cf,
    calls,
    revoked,
    health: () => null,
    release: {
      resolve: () => ({ ok: true, release: { ref: RELEASE, dir: REPO } }),
      migrations: async () => ["d1:0001_identity.sql", "do:MailCore:v1"],
      requiredConfig: (dir) => requiredConfig(join(dir, "infra/resources")).map((c) => c.name),
    },
    now: Date.parse("2026-09-26T12:00:00Z"),
    service: null as never,
  };

  const fetcher: Fetch = async (url, init) => {
    calls.push(url);

    if (url === "https://dash.cloudflare.com/oauth2/token") {
      const form = new URLSearchParams(init?.body as string);

      if (form.get("grant_type") === "authorization_code" && form.get("code") === "good-code")
        return json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: requestedScopes().join(" "),
        });

      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH)
        return json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: requestedScopes().join(" "),
        });

      if (form.get("code") === "narrow-code")
        return json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "memberships.read",
        });

      if (form.get("code") === "broad-code")
        return json({
          access_token: ACCESS,
          expires_in: 3600,
          scope: [...requestedScopes(), "dns.write"].join(" "),
        });

      return json({ error: "invalid_grant" }, 400);
    }

    if (url === "https://dash.cloudflare.com/oauth2/revoke") {
      revoked.push(new URLSearchParams(init?.body as string).get("token_type_hint")!);

      return new Response(null, { status: 200 });
    }

    const r = await w.health(url, init);

    if (r) return r;

    return new Response("unexpected", { status: 599 });
  };

  const service = new OnboardingService({
    store,
    keys: KEYS,
    oauth: cloudflareOAuthConfig("bye-onboarding", "https://onboard.test/oauth/callback"),
    fetch: fetcher,
    cloudflare: cf,
    executor,
    release: {
      resolve: () => w.release.resolve(),
      migrations: (d) => w.release.migrations(d),
      requiredConfig: (d) => w.release.requiredConfig(d),
    },
    dataDir: mkdtempSync(join(tmpdir(), "bye-onboarding-")),
    now: () => w.now,
    healthTimeouts: { request: 200, async: 300 },
    scopeMatrix: options.verifiedScopes ? VERIFIED : undefined,
  });

  Object.assign(w, { service });

  return w;
};

const connect = async (
  w: World,
  operator = "op@example.com",
  session = "session-1",
  code = "good-code",
) => {
  const { url } = await w.service.startAuthorization(operator, session);
  const state = new URL(url).searchParams.get("state")!;

  return w.service.completeAuthorization(operator, session, new URLSearchParams({ state, code }));
};

const ready = async (w: World, stage = "dev-trial01", operator = "op@example.com") => {
  await connect(w, operator);
  const inst = await w.service.bind(operator, ACCOUNT.id, stage);
  w.health = healthyInstance(inst.urls!.app);
  const review = await w.service.review(operator);
  const approval = await w.service.approve(operator, review.id, review.digest);
  const op = await w.service.deploy(operator, approval.id);
  await w.service.settled(op.id);

  return { inst, review, approval, op: (await w.store.getOperation(op.id))! };
};

describe("onboarding OAuth and credentials", () => {
  it("requests only the scope matrix: zone read and Workers Routes, never DNS writes or Email Routing", () => {
    expect(forbiddenScopes(requestedScopes())).toEqual([]);
    expect(requestedScopes()).toContain("zone.read");
    expect(requestedScopes()).toContain("workers-routes.write");

    const refused = [
      "dns-records.write",
      "dns.write",
      "zone.write",
      "zone-settings.write",
      "zone-dns-settings.write",
      "workers-routes.read.extra",
      "email-routing-rule.write",
      "email-routing.write",
      "email-sending.write",
      "memberships.write",
      "account-settings.write",
    ];

    expect(forbiddenScopes(refused)).toEqual(refused);
    // Zone read covers discovery only; the custom hostname is the only zone-level write.
    const zoneRead = ONBOARDING_SCOPES.find((g) => g.scope === "zone.read")!;
    expect(zoneRead.resourceTypes).toEqual([]);
    const routes = ONBOARDING_SCOPES.find((g) => g.scope === "workers-routes.write")!;
    expect(routes.resourceTypes).toEqual(["Cloudflare.Workers.CustomDomain"]);
    expect(requestedScopes()).toContain("workers-r2.write");
    expect(requestedScopes()).toContain("memberships.read");
    const cfg = cloudflareOAuthConfig("id", "https://o.test/cb");
    expect(cfg.scopes).toEqual(requestedScopes());
  });

  it("binds callbacks to the initiating session, expires them, and refuses replay", async () => {
    const w = world();
    const { url } = await w.service.startAuthorization("op", "s1");
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const state = u.searchParams.get("state")!;
    // Wrong session: refused (and the state is consumed).
    expect(
      await w.service.completeAuthorization(
        "op",
        "s2",
        new URLSearchParams({ state, code: "good-code" }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await w.service.completeAuthorization(
        "op",
        "s1",
        new URLSearchParams({ state, code: "good-code" }),
      ),
    ).toMatchObject({
      ok: false,
      reason: "unknown or already used authorization state",
    });

    // Valid once, then replay fails.
    const again = new URL((await w.service.startAuthorization("op", "s1")).url).searchParams.get(
      "state",
    )!;

    expect(
      await w.service.completeAuthorization(
        "op",
        "s1",
        new URLSearchParams({ state: again, code: "good-code" }),
      ),
    ).toEqual({ ok: true });
    expect(
      await w.service.completeAuthorization(
        "op",
        "s1",
        new URLSearchParams({ state: again, code: "good-code" }),
      ),
    ).toMatchObject({ ok: false });

    // Expiry.
    const pending = {
      state: "x",
      verifier: "v",
      sessionId: "s",
      installationId: "i",
      createdAt: 0,
      expiresAt: 10,
    };

    expect(checkCallback(pending, new URLSearchParams({ code: "c" }), "s", 11)).toMatchObject({
      ok: false,
      reason: "authorization expired; start again",
    });
  });

  it("rejects grants that are too narrow or too broad, and revokes them", async () => {
    const w = world();
    expect(await connect(w, "op", "s", "narrow-code")).toMatchObject({ ok: false });
    expect(await connect(w, "op", "s", "broad-code")).toMatchObject({ ok: false });
    const inst = await w.service.installation("op");
    expect(inst.credentials).toBeNull();
    expect(w.revoked).toContain("access_token");
  });

  it("lists accounts through memberships, falling back to /accounts", async () => {
    const seen: Array<string> = [];

    const reader = cloudflareReader(async (url) => {
      seen.push(new URL(url).pathname);

      if (url.includes("/memberships"))
        return json({
          result: [
            { status: "accepted", account: ACCOUNT },
            { status: "pending", account: OTHER },
          ],
        });

      return json({ result: [] });
    });

    expect(await reader.accounts("t")).toEqual([ACCOUNT]);

    const fallback = cloudflareReader(async (url) =>
      url.includes("/memberships") ? json({ result: [] }) : json({ result: [OTHER] }),
    );

    expect(await fallback.accounts("t")).toEqual([OTHER]);
    expect(seen).toEqual(["/client/v4/memberships"]);
  });

  it("refreshes the token right before an Alchemy run", async () => {
    const w = world();
    await ready(w);
    const refreshes = w.calls.filter((u) => u.endsWith("/oauth2/token")).length;
    expect(refreshes).toBeGreaterThanOrEqual(2); // code exchange + pre-run refresh
  });

  it("seals credentials to the installation", () => {
    const sealed = seal(KEYS, { accessToken: ACCESS }, "inst-a");
    expect(JSON.stringify(sealed)).not.toContain(ACCESS);
    expect(open<{ accessToken: string }>(KEYS, sealed, "inst-a").accessToken).toBe(ACCESS);
    expect(() => open(KEYS, sealed, "inst-b")).toThrow();
  });
});

describe("spec.md §15.11 acceptance", () => {
  it("OB01: authorizes, approves and deploys without a manual API token; release identifiable, checks pass", async () => {
    const w = world();
    const { op, inst } = await ready(w);
    expect(op.status).toBe("succeeded");
    expect(op.health.length).toBeGreaterThanOrEqual(9);
    expect(op.health.every((h) => h.ok)).toBe(true);
    const status = await w.service.status("op@example.com");
    expect(status.installation.ready).toBe(true);
    expect(status.installation.deployedRelease).toEqual(RELEASE);
    expect(status.installation.stateRef).toEqual({
      backend: "cloudflare",
      accountId: ACCOUNT.id,
      stack: "MailboxPlatform",
      stage: "dev-trial01",
    });
    expect(inst.urls!.app).toBe(`https://${inst.workerName}.operator.workers.dev`);
    // The OAuth token is what the executor received; no manually created token was involved.
    expect(w.executor.applies[0]!.apiToken).toBe(ACCESS);
    expect(w.executor.applies[0]!.config).toMatchObject({
      APP_ORIGIN: inst.urls!.app,
      MAIL_RENDER_ORIGIN: inst.urls!.render,
      BYE_WORKERS_DEV_NAME: inst.workerName,
    });
  });

  it("OB01: persistent stages stay blocked until the scope matrix is verified", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "prod");
    const review = await w.service.review("op@example.com");
    expect(review.blockers.some((b) => b.includes("scope workers-r2.write is unverified"))).toBe(
      true,
    );
    await expect(w.service.approve("op@example.com", review.id, review.digest)).rejects.toThrow(
      /blockers/,
    );
    expect(coverageGaps(["Cloudflare.Worker"])).toEqual([
      "Cloudflare.Worker: scope workers-scripts.write is unverified",
    ]);
  });

  it("binds callbacks to the operator who started them, and prunes expired pending records", async () => {
    const w = world();
    const { url } = await w.service.startAuthorization("op", "s1");
    const state = new URL(url).searchParams.get("state")!;
    // Same session cookie, different operator: refused before any code exchange.
    expect(
      await w.service.completeAuthorization(
        "intruder@example.com",
        "s1",
        new URLSearchParams({ state, code: "good-code" }),
      ),
    ).toEqual({ ok: false, reason: "authorization was started by a different operator" });
    // Pending records expire and are swept (startAuthorization sweeps too).
    await w.service.startAuthorization("op", "s1");
    expect(await w.store.prunePending(w.now)).toBe(0);
    expect(await w.store.prunePending(w.now + 11 * 60_000)).toBe(1);
  });

  it("OB02: withheld consent or a missing prerequisite starts no deployment writes", async () => {
    const w = world();
    const { url } = await w.service.startAuthorization("op", "s");
    const state = new URL(url).searchParams.get("state")!;
    expect(
      await w.service.completeAuthorization(
        "op",
        "s",
        new URLSearchParams({ state, error: "access_denied" }),
      ),
    ).toEqual({
      ok: false,
      reason: "consent was withheld",
    });
    await expect(w.service.review("op")).rejects.toThrow(/where Bye should live/);
    await expect(w.service.bind("op", ACCOUNT.id, "dev-trial01")).rejects.toMatchObject({
      code: "unauthorized",
    });

    await connect(w, "op", "s");
    const inst = await w.service.bind("op", ACCOUNT.id, "dev-trial01");
    w.cf.workers.push(inst.workerName!); // name collision in the account
    const review = await w.service.review("op");
    expect(review.blockers).toContain(
      `a Worker named ${inst.workerName} already exists in the account`,
    );
    await expect(w.service.approve("op", review.id, review.digest)).rejects.toMatchObject({
      code: "blocked",
    });
    expect(w.executor.applies).toHaveLength(0);
  });

  it("OB03: changed release, configuration or effects invalidate the approval", async () => {
    const w = world();
    await connect(w);
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    w.health = healthyInstance(inst.urls!.app);
    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);

    // Effects changed: a new resource appears in the plan between approval and apply.
    w.executor.plans.push((ctx) =>
      planOf(ctx.stage, {}, [row("Extra", "Cloudflare.Queues.Queue", "create")]),
    );
    let op = await w.service.deploy("op@example.com", approval.id);
    await w.service.settled(op.id);
    op = (await w.store.getOperation(op.id))!;
    expect(op).toMatchObject({ status: "failed", step: "revalidate" });
    expect(op.error!.message).toContain("unapproved create of Cloudflare.Queues.Queue Extra");

    // Release changed.
    w.release = {
      ...w.release,
      resolve: () => ({
        ok: true,
        release: { ref: { ...RELEASE, version: "v1.0.1", commit: "e".repeat(40) }, dir: REPO },
      }),
    };
    op = await w.service.deploy("op@example.com", approval.id);
    await w.service.settled(op.id);
    expect((await w.store.getOperation(op.id))!.error!.message).toContain(
      "not the approved v1.0.0",
    );
    expect(w.executor.applies).toHaveLength(0);

    // Pure check: configuration, account and stage are all covered by the digest.
    const s = review.subject;
    expect(approvalCovers(s, { ...s, configHash: "x" })).toContain("configuration changed");
    expect(approvalCovers(s, { ...s, accountId: OTHER.id })).toContain("account changed");
    expect(approvalCovers(s, { ...s, stage: "dev-other01" })).toContain("stage changed");
    expect(
      approvalCovers(s, { ...s, migrations: [...s.migrations, "d1:0099_new.sql"] })[0],
    ).toMatch(/unapproved migrations/);
  });

  it("OB04: repeated submissions reuse the one active writer", async () => {
    const w = world();
    await connect(w);
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    w.health = healthyInstance(inst.urls!.app);
    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);
    let release!: () => void;
    w.executor.applyBehavior = () =>
      new Promise((r) => (release = () => r({ ok: true, detail: "applied", aborted: false })));
    const first = await w.service.deploy("op@example.com", approval.id);

    const [second, third] = await Promise.all([
      w.service.deploy("op@example.com", approval.id),
      w.service.deploy("op@example.com", approval.id),
    ]);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await w.service.settled(first.id);
    expect(w.executor.applies).toHaveLength(1);
    expect((await w.store.operations(inst.id)).length).toBe(1);
  });

  it("OB04: the writer lock also holds across processes sharing a file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bye-onb-store-"));
    const a = new FileStore(dir);
    const b = new FileStore(dir);
    expect(await a.acquireWriter("inst1", "opA")).toBeNull();
    expect(await b.acquireWriter("inst1", "opB")).toBe("opA");
    await b.releaseWriter("inst1", "opB"); // not the holder: no effect
    expect(await b.writerHolder("inst1")).toBe("opA");
    await a.releaseWriter("inst1", "opA");
    expect(await b.acquireWriter("inst1", "opB")).toBeNull();
    // Pending authorization states are single use across processes too.
    await a.putPending({
      state: "st",
      verifier: "v",
      sessionId: "s",
      installationId: "i",
      createdAt: 0,
      expiresAt: 1,
    });
    expect(await b.takePending("st")).not.toBeNull();
    expect(await a.takePending("st")).toBeNull();
  });

  it("OB05: after process loss, recovery reconciles with state instead of recreating", async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), "bye-onb-a5-")));
    const w1 = world({ store });
    await connect(w1);
    const inst = await w1.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const review = await w1.service.review("op@example.com");
    const approval = await w1.service.approve("op@example.com", review.id, review.digest);
    // The process dies mid-apply: the executor never returns.
    w1.executor.applyBehavior = () => new Promise(() => {});
    const lost = await w1.service.deploy("op@example.com", approval.id);
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.getOperation(lost.id))!.status).toBe("running");

    // A new process over the same store.
    const w2 = world({ store });
    w2.health = healthyInstance(inst.urls!.app);
    expect(await w2.service.recover(await store.installationIds())).toBe(1);
    const interrupted = (await store.getOperation(lost.id))!;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.error!.nextAction).toMatch(/Review again/);
    expect((await store.getInstallation(inst.id))!.firstWriteAt).not.toBeNull();

    // Half-applied: two resources exist, MailCore resumes as an update; the rest are still creates.
    const partial = (ctx: ExecutionContext) =>
      planOf(ctx.stage, { Directory: "noop", Originals: "noop", MailCore: "update" });

    w2.executor.plans.push(partial);
    const retry = await w2.service.deploy("op@example.com", approval.id);
    await w2.service.settled(retry.id);
    const done = (await store.getOperation(retry.id))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("succeeded");
    expect(done.outcomes.every((o) => o.outcome === "completed")).toBe(true);

    // A plan that would replace persistent data stops for intervention, never retries.
    const w3 = world({ store });
    w3.executor.plans.push((stage) => planOf(stage.stage, { Directory: "replace" }));
    const blocked = await w3.service.deploy("op@example.com", approval.id);
    await w3.service.settled(blocked.id);
    const b = (await store.getOperation(blocked.id))!;
    expect(b.status).toBe("failed");
    expect(w3.executor.applies).toHaveLength(0);
  });

  it("OB05: a failed apply keeps completed resources and reports each outcome", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);
    w.executor.applyBehavior = async () => ({
      ok: false,
      detail: "deploy exited with 1",
      aborted: false,
    });
    w.executor.plans.push(
      (c) => planOf(c.stage),
      (c) => planOf(c.stage, { Directory: "noop", Mailboxes: "noop" }),
    );
    const op = await w.service.deploy("op@example.com", approval.id);
    await w.service.settled(op.id);
    const failed = (await w.store.getOperation(op.id))!;
    expect(failed).toMatchObject({ status: "failed", step: "apply" });
    expect(failed.error!.nextAction).toMatch(/same approval/);
    expect(failed.outcomes.find((o) => o.logicalId === "Directory")!.outcome).toBe("completed");
    expect(failed.outcomes.find((o) => o.logicalId === "MailCore")!.outcome).toBe("pending");
    expect((await w.service.status("op@example.com")).installation.ready).toBe(false);
  });

  it("OB06: a failing or hung health check is not ready and names the check", async () => {
    const w = world();
    await connect(w);
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const healthy = healthyInstance(inst.urls!.app);
    w.health = (url, init) => {
      if (url.endsWith("/.well-known/bye-instance")) return json({}, 500);

      if (url.includes("/__probe/alarm/") && init?.method !== "POST")
        return new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
          ),
        );

      return healthy(url, init);
    };

    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);
    const op = await w.service.deploy("op@example.com", approval.id);
    await w.service.settled(op.id);
    const failed = (await w.store.getOperation(op.id))!;
    expect(failed).toMatchObject({ status: "failed", step: "health" });
    expect(failed.error!.message).toContain("instance.document");
    expect(failed.error!.message).toContain("do.alarm");
    const status = await w.service.status("op@example.com");
    expect(status.installation.ready).toBe(false);
    expect(status.handoff).toBeNull();
    await expect(w.service.handoff("op@example.com")).rejects.toMatchObject({ code: "not_ready" });
  }, 10_000);

  it("OB07: disconnect during apply blocks writes, discloses uncertainty, deletes credentials, keeps resources", async () => {
    const w = world();
    await connect(w);
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);
    w.executor.applyBehavior = (ctx) =>
      new Promise((r) =>
        ctx.signal.addEventListener("abort", () =>
          r({ ok: false, detail: "stopped", aborted: true }),
        ),
      );
    const op = await w.service.deploy("op@example.com", approval.id);
    await new Promise((r) => setTimeout(r, 20));
    const plansBefore = w.executor.planCalls;
    const result = await w.service.disconnect("op@example.com");
    expect(result.inFlight).toMatch(/may still complete/);
    expect(result.revocation).toBe("revoked at Cloudflare");
    expect(w.revoked.sort()).toEqual(["access_token", "refresh_token"]);
    const stopped = (await w.store.getOperation(op.id))!;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.outcomes.every((o) => o.outcome === "uncertain")).toBe(true);
    expect(w.executor.planCalls).toBe(plansBefore); // no API calls after the stop
    const after = (await w.store.getInstallation(inst.id))!;
    expect(after.credentials).toBeNull();
    expect(after.authorization.status).toBe("disconnected");
    expect(after.stateRef).not.toBeNull(); // state reference and resources untouched
    await expect(w.service.deploy("op@example.com", approval.id)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(w.service.review("op@example.com")).rejects.toMatchObject({
      code: "unauthorized",
    });

    // Reconnect returns to the same installation and target.
    expect(await connect(w)).toEqual({ ok: true });
    const back = await w.service.installation("op@example.com");
    expect(back.id).toBe(inst.id);
    expect(back.accountId).toBe(ACCOUNT.id);
    await expect(w.service.bind("op@example.com", OTHER.id, "dev-trial01")).rejects.toMatchObject({
      code: "conflict",
    });

    // A reauthorization that can't reach the bound account is refused.
    await w.service.disconnect("op@example.com");
    w.cf.accountsFor = () => [OTHER];
    expect(await connect(w)).toMatchObject({ ok: false });
  });

  it("OB07: a failed provider revocation is reported without restoring access", async () => {
    const w = world();
    await connect(w);
    const failing: { deps: { fetch: Fetch } } = w.service as never;
    const original = failing.deps.fetch;
    (failing.deps as { fetch: Fetch }).fetch = async (url, init) =>
      url.endsWith("/revoke") ? new Response(null, { status: 503 }) : original(url, init);
    const r = await w.service.disconnect("op@example.com");
    expect(r.revocation).toMatch(/revocation failed/);
    expect((await w.service.installation("op@example.com")).credentials).toBeNull();
  });

  it("OB08: no path changes DNS, MX, Email Routing or catch-all routing", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    w.executor.plans.push((c) =>
      planOf(c.stage, {}, [
        row("MailRouting", "Cloudflare.Email.Routing", "create"),
        row("MailCatchAll", "Cloudflare.Email.CatchAll", "create"),
        row("MX", "Cloudflare.DNS.Record", "update"),
      ]),
    );
    const review = await w.service.review("op@example.com");
    expect(review.blockers.filter((b) => b.includes("outside onboarding"))).toHaveLength(3);

    for (const t of [
      "Cloudflare.Email.Routing",
      "Cloudflare.Email.CatchAll",
      "Cloudflare.DNS.Record",
      "Cloudflare.Workers.CustomDomain",
    ])
      expect(isProhibited(t)).toBe(true);

    // The executor environment forces every domain/mail switch empty, whatever the parent had.
    const env = childEnv(
      {
        installationId: "i",
        releaseDir: "/r",
        homeDir: "/h",
        stage: "prod",
        accountId: "a",
        apiToken: "t",
        config: { MAIL_ZONE: "x.com" },
        signal: new AbortController().signal,
      },
      {
        MAIL_ZONE: "example.com",
        BYE_MX_CUTOVER: "approved",
        APP_DOMAIN: "a.example.com",
        CF_DNS_API_TOKEN: "secret",
        PATH: "/bin",
      },
    );

    for (const k of [
      "MAIL_ZONE",
      "BYE_MX_CUTOVER",
      "APP_DOMAIN",
      "PUBLIC_DOMAIN",
      "CF_DNS_API_TOKEN",
    ])
      expect(env[k]).toBe("");

    // The installation's own chosen hostname is the one domain input that reaches the stack.
    const withHost = childEnv(
      {
        installationId: "i",
        releaseDir: "/r",
        homeDir: "/h",
        stage: "prod",
        accountId: "a",
        apiToken: "t",
        config: { APP_DOMAIN: "bye.example.com", MAIL_ZONE: "example.com" },
        signal: new AbortController().signal,
      },
      { PUBLIC_DOMAIN: "example.com" },
    );

    expect(withHost.APP_DOMAIN).toBe("bye.example.com");
    expect(withHost.MAIL_ZONE).toBe("");
    expect(withHost.PUBLIC_DOMAIN).toBe("");
    expect(env.PATH).toBe("/bin");
    expect(env.ALCHEMY_TELEMETRY_DISABLED).toBe("1");

    // Success without ever opening the guide.
    const ok = await ready(world());
    expect(ok.op.status).toBe("succeeded");
    const guide = await w.service.guide("op@example.com");
    expect(guide.notice).toMatch(/does not change DNS, MX, Email Routing/);
    expect(guide.sections.map((s) => s.id)).toEqual(["domains", "mail-cutover"]);
  });

  it("OB09: previews are refused, protected destruction is blocked, outputs carry no credentials", async () => {
    const w = world();
    await connect(w);
    await expect(w.service.bind("op@example.com", ACCOUNT.id, "preview-12")).rejects.toMatchObject({
      code: "invalid",
    });
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");

    // Destruction of a persistent type on a persistent stage is a policy violation (no decommission records).
    const persistentInst = { ...inst, stage: "prod", firstWriteAt: "x" };

    const destroy = buildReview({
      installation: persistentInst,
      release: RELEASE,
      exported: planOf("prod", { Directory: "delete", PublicSite: "replace" }),
      configHash: "h",
      releaseMigrations: [],
      prerequisiteBlockers: [],
      grantedScopes: requestedScopes(),
    });

    expect(
      destroy.blockers.some((b) => b.includes("requires an approved decommission record")),
    ).toBe(true);

    // After a first deployment, a non-protected replacement needs explicit acknowledgement.
    const ok = await ready(w, "dev-trial01");
    w.executor.plans.push((c) => planOf(c.stage, { PublicSite: "replace" }));
    const review = await w.service.review("op@example.com");
    expect(review.blockers).toEqual([]);
    expect(review.destructive.map((d) => d.logicalId)).toEqual(["PublicSite"]);
    await expect(w.service.approve("op@example.com", review.id, review.digest)).rejects.toThrow(
      /acknowledgement/,
    );
    await expect(
      w.service.approve("op@example.com", review.id, "0".repeat(64), true),
    ).rejects.toThrow(/does not match/);
    await w.service.approve("op@example.com", review.id, review.digest, true);

    // Nothing the operator or logs can see holds a token or runtime secret.
    const secrets = open<Record<string, string>>(
      KEYS,
      (await w.store.getInstallation(inst.id))!.runtimeSecrets!,
      inst.id,
    );

    const visible = JSON.stringify([
      await w.service.status("op@example.com"),
      await w.store.events(inst.id),
      await w.store.operations(inst.id),
      review,
      ok.approval,
    ]);

    for (const s of [ACCESS, REFRESH, ...Object.values(secrets)]) expect(visible).not.toContain(s);
    expect(visible).toContain("[redacted]"); // the executor's progress line had the token
    expect(redactor([ACCESS])(`Authorization: Bearer ${ACCESS}`)).not.toContain(ACCESS);
  });

  it("OB10: the handoff holds only the HTTPS instance URL", async () => {
    const w = world();
    const { inst } = await ready(w);
    const h = await w.service.handoff("op@example.com");
    expect(h.url).toBe(inst.urls!.app);
    expect(h.link).toBe(`bye://add-instance?url=${encodeURIComponent(inst.urls!.app)}`);
    expect(parseInstanceHandoff(h.link)).toEqual({ _tag: "AddInstance", url: inst.urls!.app });
    expect(parseInstanceHandoff(h.url, { scanned: true })).toEqual({
      _tag: "AddInstance",
      url: inst.urls!.app,
    });
    expect(h.qrSvg).toMatch(/^<svg /);
    expect(encodeQr(h.url).version).toBeLessThanOrEqual(4);
    expect(() => handoffFor("http://insecure.example")).toThrow(OnboardingError);
    expect(() => handoffFor("https://x.example/?token=1")).toThrow(OnboardingError);
  });
});

describe("recovery kit and first account", () => {
  it("issues the recovery kit once after binding, with secrets but no Cloudflare credentials", async () => {
    const w = world();
    await connect(w);
    await expect(w.service.recoveryKit("op@example.com")).rejects.toMatchObject({
      code: "invalid",
    });
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const kit = await w.service.recoveryKit("op@example.com");
    const secrets = open<Record<string, string>>(KEYS, inst.runtimeSecrets!, inst.id);
    expect(kit).toMatchObject({
      format: "bye.recovery-kit.v1",
      stage: "dev-trial01",
      account: { id: ACCOUNT.id },
      state: { backend: "cloudflare", accountId: ACCOUNT.id, stack: "MailboxPlatform" },
    });
    expect(kit.env).toMatchObject({
      ...secrets,
      STAGE: "dev-trial01",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT.id,
      APP_ORIGIN: inst.urls!.app,
      BYE_WORKERS_DEV_NAME: inst.workerName,
      TURNSTILE_SECRET: "",
    });
    expect(JSON.stringify(kit)).not.toContain(ACCESS);
    expect(JSON.stringify(kit)).not.toContain(REFRESH);
    expect(kit.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    // Once only, and the issuance (not the contents) is recorded.
    await expect(w.service.recoveryKit("op@example.com")).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await w.service.status("op@example.com")).installation.recoveryKitIssuedAt).toBe(
      kit.issuedAt,
    );
    const log = JSON.stringify(await w.store.events(inst.id));
    expect(log).toContain("recovery-kit.issued");

    for (const v of Object.values(secrets)) expect(log).not.toContain(v);
  });

  it("gives a fragment-only first-account link once the instance is ready", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    await expect(w.service.firstAccountLink("op@example.com")).rejects.toMatchObject({
      code: "not_ready",
    });
    const { inst } = await ready(w);
    const { link } = await w.service.firstAccountLink("op@example.com");

    const token = open<Record<string, string>>(
      KEYS,
      inst.runtimeSecrets!,
      inst.id,
    ).BOOTSTRAP_TOKEN!;

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(link).toBe(`${inst.urls!.app}/#bootstrap=${token}`);
    // The instance receives it as BOOTSTRAP_TOKEN; the native handoff still carries only the URL.
    expect(w.executor.applies[0]!.config.BOOTSTRAP_TOKEN).toBe(token);
    expect((await w.service.handoff("op@example.com")).link).not.toContain(token);
  });
});

describe("onboarding binding and stage policy", () => {
  it("binds one operator to one account and stage; collisions are rejected", async () => {
    const w = world();
    await connect(w, "a@example.com", "sa");
    await w.service.bind("a@example.com", ACCOUNT.id, "dev-trial01");
    expect((await w.service.bind("a@example.com", ACCOUNT.id, "dev-trial01")).stage).toBe(
      "dev-trial01",
    );
    await expect(w.service.bind("a@example.com", ACCOUNT.id, "staging")).rejects.toMatchObject({
      code: "conflict",
    });
    await connect(w, "b@example.com", "sb");
    await expect(w.service.bind("b@example.com", ACCOUNT.id, "dev-trial01")).rejects.toThrow(
      /another installation/,
    );
  });

  it("refuses to adopt an existing deployment's state on first install", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    w.executor.plans.push((c) => allNoop(c.stage));
    const review = await w.service.review("op@example.com");
    expect(review.blockers.some((b) => b.includes("will not adopt"))).toBe(true);
  });

  it("guard-stage accepts the onboarding writer for shared stages only with a verified plan", () => {
    const optOut = { ALCHEMY_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", NO_TRACK: "1" };
    expect(guard("deploy", "prod", { ...optOut, BYE_DEPLOY_WRITER: "onboarding" })).toEqual([
      "production deploys require a verified release manifest (release-manifest.ts verify)",
    ]);
    expect(
      guard("deploy", "prod", {
        ...optOut,
        BYE_DEPLOY_WRITER: "onboarding",
        BYE_RELEASE_MANIFEST_VERIFIED: "1",
      }),
    ).toEqual([]);
  });
});

/** Connect, then "Create Bye" at bye.example.com (the normal three-step path). */
const createBye = async (w: World, label = "bye", zoneId = ZONE.id, accountId = ACCOUNT.id) => {
  await connect(w);
  w.health = healthyInstance(`https://${label}.${ZONE.name}`);
  const result = await w.service.install("op@example.com", { accountId, zoneId, label });

  if (result.status === "deploying") await w.service.settled(result.operationId);

  return result;
};

describe("standard install: Cloudflare account → Bye hostname → Create Bye", () => {
  it("lists only the selected account's active zones, and never another account's", async () => {
    const w = world({ accounts: [ACCOUNT, OTHER] });
    await connect(w);
    expect(await w.service.zones("op@example.com", ACCOUNT.id)).toEqual([
      { id: ZONE.id, name: "example.com" },
    ]);
    await expect(w.service.zones("op@example.com", "acc-not-reachable")).rejects.toMatchObject({
      code: "invalid",
    });

    // The HTTP reader filters by account again, even if the API ignored the filter.
    const reader = cloudflareReader(async (url) => {
      expect(url).toContain(`account.id=${ACCOUNT.id}`);

      return json({
        result: [
          { ...ZONE, account: { id: ACCOUNT.id } },
          { ...OTHER_ZONE, account: { id: OTHER.id } },
        ],
      });
    });

    expect(await reader.zones("t", ACCOUNT.id)).toEqual([ZONE]);
  });

  it("defaults the Bye address label to bye, and validates labels server-side", async () => {
    expect(DEFAULT_HOSTNAME_LABEL).toBe("bye");
    expect(ONBOARDING_PAGE).toContain('id="label" type="text" value="bye"');
    // The normal page never asks for a stage.
    expect(ONBOARDING_PAGE).not.toMatch(/id="stage"/);
    const w = world({ verifiedScopes: true });
    await connect(w);

    for (const label of ["", "-bye", "bye-", "b_y", "a".repeat(64), "bye.mail", "by e"])
      await expect(
        w.service.install("op@example.com", { accountId: ACCOUNT.id, zoneId: ZONE.id, label }),
      ).rejects.toMatchObject({ code: "invalid" });
    expect(w.executor.applies).toHaveLength(0);
    expect((await w.service.installation("op@example.com")).boundAt).toBeNull();
  });

  it("refuses a zone from another account or an inactive zone", async () => {
    const w = world({ accounts: [ACCOUNT, OTHER], verifiedScopes: true });
    await connect(w);

    for (const zoneId of [OTHER_ZONE.id, PENDING_ZONE.id, "zone-unknown"])
      await expect(
        w.service.install("op@example.com", { accountId: ACCOUNT.id, zoneId, label: "bye" }),
      ).rejects.toMatchObject({ code: "invalid" });
    expect((await w.service.installation("op@example.com")).boundAt).toBeNull();
  });

  it("binds prod with the custom hostname, auto-approves a standard first install, and deploys it", async () => {
    const w = world({ verifiedScopes: true });
    const result = await createBye(w);
    expect(result).toMatchObject({ status: "deploying", appUrl: "https://bye.example.com" });
    const inst = (await w.service.installation("op@example.com"))!;
    expect(inst).toMatchObject({
      stage: "prod",
      zoneId: ZONE.id,
      zoneName: "example.com",
      appHostname: "bye.example.com",
      ownerAddressDomain: "example.com",
      ready: true,
    });
    expect(inst.stateRef).toMatchObject({ stage: "prod" });
    expect(inst.installIntent).toMatchObject({
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      zoneName: "example.com",
      appHostname: "bye.example.com",
      stage: "prod",
      release: RELEASE,
      operatorId: "op@example.com",
    });
    // URLs: the app on the custom hostname, the render origin and site on workers.dev.
    expect(inst.urls).toEqual({
      app: "https://bye.example.com",
      site: `https://${inst.workerName}-site.operator.workers.dev`,
      render: `https://${inst.workerName}-render.operator.workers.dev`,
    });
    // APP_DOMAIN reaches the Alchemy run; mail/DNS inputs don't exist in its config.
    const config = w.executor.applies[0]!.config;
    expect(config).toMatchObject({
      APP_ORIGIN: "https://bye.example.com",
      APP_DOMAIN: "bye.example.com",
      MAIL_RENDER_ORIGIN: inst.urls!.render,
      BOOTSTRAP_ADDRESS_DOMAIN: "example.com",
      INSTALL_ACCOUNT_ID: ACCOUNT.id,
      INSTALL_ZONE_ID: ZONE.id,
      INSTALL_ZONE_NAME: "example.com",
      MAIL_WORKER_NAME: inst.workerName,
    });
    expect(config.NEWSLETTER_CONFIG_SEAL_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Outbound personal mail: DKIM key pair generated once, public half is the `p=` value.
    expect(config.MAIL_TRAFFIC_CLASSES).toBe("transactional,personal");
    expect(config.MAIL_DKIM_PRIVATE_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(config.MAIL_DKIM_PUBLIC_KEY).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(config.MAIL_DKIM_PUBLIC_KEY).toBe(dkimPublicKey(config.MAIL_DKIM_PRIVATE_KEY!));
    expect(config).not.toHaveProperty("PERSONAL_MAIL_API_KEY");

    for (const k of ["PUBLIC_DOMAIN", "MAIL_ZONE", "BYE_MX_CUTOVER", "CF_DNS_API_TOKEN"])
      expect(config[k] ?? "").toBe("");
    // The approval was recorded by policy against the install intent.
    const op = (await w.store.operations(inst.id))[0]!;
    expect(op.status).toBe("succeeded");
    const approval = (await w.store.getApproval(op.approvalId))!;
    expect(approval).toMatchObject({
      policy: "standard-first-install",
      installIntentId: inst.installIntent!.id,
    });
    // Health checks ran against the custom origin.
    expect(w.calls).toContain("https://bye.example.com/.well-known/bye-instance");
    const status = await w.service.status("op@example.com");
    expect(status.state).toBe("ready");
    expect(status.installation.appHostname).toBe("bye.example.com");
  });

  it("sends any unexpected resource type, replacement or deletion to review", async () => {
    for (const extra of [
      [row("Surprise", "Cloudflare.Hyperdrive.Config", "create")],
      [row("Waf", "Cloudflare.Ruleset", "create")],
      [row("MX", "Cloudflare.DNS.Record", "create")],
      [row("OtherDomain", "Cloudflare.Workers.CustomDomain", "create")],
    ]) {
      const w = world({ verifiedScopes: true });
      w.executor.defaultPlan = (ctx) => planOf(ctx.stage, {}, extra);
      const result = await createBye(w);
      expect(result.status).toBe("needs-review");
      expect(w.executor.applies).toHaveLength(0);
      const status = await w.service.status("op@example.com");
      expect(status.state).toBe("needs-review");
      expect(status.installation.pendingReviewId).toBe(
        result.status === "needs-review" ? result.reviewId : null,
      );
    }

    const replaced = world({ verifiedScopes: true });
    replaced.executor.defaultPlan = (ctx) => planOf(ctx.stage, { PublicSite: "replace" });
    expect((await createBye(replaced)).status).toBe("needs-review");
    const deleted = world({ verifiedScopes: true });
    deleted.executor.defaultPlan = (ctx) => planOf(ctx.stage, { Originals: "delete" });
    const r = await createBye(deleted);
    expect(r).toMatchObject({ status: "needs-review" });
    expect(deleted.executor.applies).toHaveLength(0);
  });

  it("waits for review while the scope matrix is unverified (release gate)", async () => {
    const w = world();
    const result = await createBye(w);
    expect(result.status).toBe("needs-review");

    if (result.status !== "needs-review") return;
    expect(result.reasons.join(" ")).toMatch(/review blockers/);
    expect(w.executor.applies).toHaveLength(0);
    // The existing review can still be shown; with blockers it can't be approved.
    const review = (await w.store.getReview(result.reviewId))!;
    expect(review.blockers.some((b) => b.includes("unverified"))).toBe(true);
  });

  it("permits only MailCore's own custom-domain row, and only with a chosen hostname", () => {
    const host = { appHostname: "bye.example.com" };
    const cd = { type: "Cloudflare.Workers.CustomDomain", action: "create" as const };
    expect(isPermittedCustomDomain({ ...cd, logicalId: "MailCore" }, host)).toBe(true);
    expect(isPermittedCustomDomain({ ...cd, logicalId: "PublicSite" }, host)).toBe(false);
    expect(isPermittedCustomDomain({ ...cd, logicalId: "MailCore" }, { appHostname: null })).toBe(
      false,
    );
    expect(isPermittedCustomDomain({ ...cd, action: "delete", logicalId: "MailCore" }, host)).toBe(
      false,
    );
    expect(
      isPermittedCustomDomain(
        { type: "Cloudflare.Workers.Route", action: "create", logicalId: "MailCore" },
        host,
      ),
    ).toBe(false);
    const w = world({ verifiedScopes: true });
    w.executor.defaultPlan = (ctx) =>
      planOf(ctx.stage, {}, [row("MailCore.domain", "Cloudflare.Workers.CustomDomain", "create")]);

    return createBye(w).then((r) => expect(r.status).toBe("deploying"));
  });

  it("keeps the recorded account, zone and hostname on retry", async () => {
    const w = world({ accounts: [ACCOUNT, OTHER], verifiedScopes: true });
    w.executor.applyBehavior = async () => ({
      ok: false,
      detail: "deploy exited with 1",
      aborted: false,
    });
    const first = await createBye(w);
    expect(first.status).toBe("deploying");

    for (const change of [
      { accountId: ACCOUNT.id, zoneId: ZONE.id, label: "mail" },
      { accountId: OTHER.id, zoneId: OTHER_ZONE.id, label: "bye" },
    ])
      await expect(w.service.install("op@example.com", change)).rejects.toMatchObject({
        code: "conflict",
      });
    await expect(w.service.bind("op@example.com", ACCOUNT.id, "staging")).rejects.toMatchObject({
      code: "conflict",
    });
    // Retrying the failed deployment resumes the same approval and target.
    w.executor.applyBehavior = async () => ({ ok: true, detail: "applied", aborted: false });

    const failed = (
      await w.store.operations((await w.service.installation("op@example.com")).id)
    )[0]!;

    const retry = await w.service.deploy("op@example.com", failed.approvalId);
    await w.service.settled(retry.id);
    expect((await w.store.getOperation(retry.id))!.status).toBe("succeeded");
    expect(w.executor.applies.every((c) => c.config.APP_DOMAIN === "bye.example.com")).toBe(true);
    // A zone that disappears from the account blocks later deployments.
    w.cf.zonesFor = () => [];
    const review = await w.service.review("op@example.com");
    expect(review.blockers.some((b) => b.includes("no longer an active zone"))).toBe(true);
  });

  it("hands the first owner a fragment-only link with the selected zone", async () => {
    const w = world({ verifiedScopes: true });
    await createBye(w);
    const inst = await w.service.installation("op@example.com");

    const token = open<Record<string, string>>(
      KEYS,
      inst.runtimeSecrets!,
      inst.id,
    ).BOOTSTRAP_TOKEN!;

    const { link } = await w.service.firstAccountLink("op@example.com");
    expect(link).toBe(`https://bye.example.com/#bootstrap=${token}&domain=example.com`);
    expect(new URL(link).search).toBe("");
  });

  it("issues a recovery kit with the zone and hostname but no Cloudflare credentials", async () => {
    const w = world({ verifiedScopes: true });
    await createBye(w);
    const kit = await w.service.recoveryKit("op@example.com");
    expect(kit).toMatchObject({
      account: { id: ACCOUNT.id, name: ACCOUNT.name },
      zone: { id: ZONE.id, name: "example.com" },
      appHostname: "bye.example.com",
      ownerAddressDomain: "example.com",
      stage: "prod",
    });
    expect(kit.env.APP_DOMAIN).toBe("bye.example.com");
    expect(JSON.stringify(kit)).not.toContain(ACCESS);
    expect(JSON.stringify(kit)).not.toContain(REFRESH);
  });

  it("keeps the standard first-install graph in step with the stack inventory", () => {
    // Every type the stack creates must be reviewed into (or deliberately kept out of) the graph.
    const KEPT_OUT = new Set([
      "Cloudflare.Email.Routing",
      "Cloudflare.Email.CatchAll",
      "Cloudflare.Turnstile.Widget",
      "Cloudflare.Ruleset",
    ]);

    const inventoryTypes = new Set(INVENTORY.map((e) => e.type));

    for (const t of inventoryTypes)
      expect(STANDARD_FIRST_INSTALL_TYPES.has(t) || KEPT_OUT.has(t), t).toBe(true);

    for (const t of KEPT_OUT) expect(STANDARD_FIRST_INSTALL_TYPES.has(t)).toBe(false);
  });

  it("refuses a Bye address that already has DNS records, but not a wildcard match", async () => {
    const doh = (answered: (name: string) => boolean) => (url: string) => {
      if (!url.startsWith("https://cloudflare-dns.com/dns-query")) return null;
      const name = new URL(url).searchParams.get("name")!;

      return json({ Status: 0, Answer: answered(name) ? [{ data: "192.0.2.1" }] : [] });
    };

    const taken = world({ verifiedScopes: true });
    await connect(taken);
    taken.health = doh((n) => n === "bye.example.com");
    await expect(
      taken.service.install("op@example.com", {
        accountId: ACCOUNT.id,
        zoneId: ZONE.id,
        label: "bye",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "bye.example.com already has DNS records",
    });
    expect((await taken.service.installation("op@example.com")).boundAt).toBeNull();

    // A wildcard answers for every name; the custom domain can still take the name over.
    const wildcard = world({ verifiedScopes: true });
    await connect(wildcard);
    const healthy = healthyInstance("https://bye.example.com");
    const answers = doh(() => true);
    wildcard.health = (url, init) => answers(url) ?? healthy(url, init);

    const r = await wildcard.service.install("op@example.com", {
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      label: "bye",
    });

    expect(r.status).toBe("deploying");
  });

  it("lets a standard install move to another hostname only before the first write", async () => {
    const w = world(); // unverified scopes: the first attempt waits in review, nothing written
    const first = await createBye(w);
    expect(first.status).toBe("needs-review");
    const before = await w.service.installation("op@example.com");

    const moved = await w.service.install("op@example.com", {
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      label: "mail",
    });

    expect(moved.status).toBe("needs-review");
    const after = await w.service.installation("op@example.com");
    expect(after.appHostname).toBe("mail.example.com");
    expect(after.urls!.app).toBe("https://mail.example.com");
    expect(after.runtimeSecrets).toEqual(before.runtimeSecrets); // same generated secrets
    expect(after.installIntent!.appHostname).toBe("mail.example.com");
    // Once the recovery kit names the target, it no longer moves.
    await w.service.recoveryKit("op@example.com");
    await expect(
      w.service.install("op@example.com", { accountId: ACCOUNT.id, zoneId: ZONE.id, label: "bye" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("blocks any planned hostname other than the chosen one on MailCore", async () => {
    const inst = { appHostname: "bye.example.com" };
    const plan = (rows: ReadonlyArray<ExportedPlanRow>) => ({ ...planOf("prod"), rows });
    expect(
      domainProblems(
        plan([{ ...row("MailCore", "Cloudflare.Worker", "create"), domains: ["bye.example.com"] }]),
        inst,
      ),
    ).toEqual([]);
    expect(
      domainProblems(
        plan([
          { ...row("MailCore", "Cloudflare.Worker", "create"), domains: ["evil.example.com"] },
        ]),
        inst,
      ),
    ).toHaveLength(1);
    expect(
      domainProblems(
        plan([
          { ...row("PublicSite", "Cloudflare.Worker", "create"), domains: ["bye.example.com"] },
        ]),
        inst,
      ),
    ).toHaveLength(1);
    expect(
      domainProblems(
        plan([{ ...row("MailCore", "Cloudflare.Worker", "create"), domains: ["bye.example.com"] }]),
        { appHostname: null },
      ),
    ).toHaveLength(1);
    // End to end: such a plan is never auto-approved.
    const w = world({ verifiedScopes: true });
    w.executor.defaultPlan = (ctx) => ({
      ...planOf(ctx.stage),
      rows: planOf(ctx.stage).rows.map((r) =>
        r.logicalId === "MailCore" ? { ...r, domains: ["other.example.com"] } : r,
      ),
    });
    expect((await createBye(w)).status).toBe("needs-review");
  });

  it("passes newsletter qualification only from the pinned release's evidence file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bye-release-"));
    expect(releaseQualification(dir)).toEqual({ newsletter: null });
    mkdirSync(join(dir, "infra/release"), { recursive: true });
    writeFileSync(
      join(dir, QUALIFICATION_FILE),
      JSON.stringify({ newsletter: "EVIDENCE.md#1 run-42" }),
    );
    expect(releaseQualification(dir)).toEqual({ newsletter: "EVIDENCE.md#1 run-42" });
    writeFileSync(join(dir, QUALIFICATION_FILE), JSON.stringify({ newsletter: "x\ny" }));
    expect(releaseQualification(dir)).toEqual({ newsletter: null });
    writeFileSync(join(dir, QUALIFICATION_FILE), "{not json");
    expect(releaseQualification(dir)).toEqual({ newsletter: null });

    // Unqualified release: nothing set, newsletters stay unavailable.
    const plain = world({ verifiedScopes: true });
    await createBye(plain);
    expect(plain.executor.applies[0]!.config.NEWSLETTER_QUALIFIED).toBeUndefined();
    // Qualified release: the evidence reaches the instance, and is covered by the approval digest.
    const w = world({ verifiedScopes: true });
    w.release = {
      ...w.release,
      resolve: () => ({
        ok: true,
        release: { ref: RELEASE, dir: REPO, qualification: { newsletter: "EVIDENCE.md#1 run-42" } },
      }),
    };
    await createBye(w);
    const config = w.executor.applies[0]!.config;
    expect(config.NEWSLETTER_QUALIFIED).toBe("EVIDENCE.md#1 run-42");
    expect(config.ZONE_TOKEN_SEAL_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("hosted onboarding: service on Durable Object storage", () => {
  const IMAGES = {
    deployer: `ghcr.io/chr33s/bye/deployer@sha256:${"1".repeat(64)}`,
    scanner: `ghcr.io/chr33s/bye/scanner@sha256:${"2".repeat(64)}`,
    mime: `ghcr.io/chr33s/bye/mime@sha256:${"3".repeat(64)}`,
    sigmirror: `ghcr.io/chr33s/bye/sigmirror@sha256:${"4".repeat(64)}`,
  };

  it("runs the standard install end to end on the Durable Object store", async () => {
    const store = new DurableObjectStore(new MapStorage());
    const w = world({ store, verifiedScopes: true });
    const result = await createBye(w);
    expect(result.status).toBe("deploying");
    const inst = (await store.installationForOperator("op@example.com"))!;
    expect(inst.ready).toBe(true);
    expect(await store.installationForTarget(ACCOUNT.id, "prod")).toMatchObject({ id: inst.id });
    expect((await store.operations(inst.id))[0]!.status).toBe("succeeded");
    expect(await store.writerHolder(inst.id)).toBeNull();
    const kinds = (await store.events(inst.id)).map((e) => e.kind);
    expect(kinds[0]).toBe("installation.created");
    expect(kinds.at(-1)).toBe("operation.succeeded");
  });

  it("a release with images deploys them from the account's registry, covered by the digest", async () => {
    const w = world({ verifiedScopes: true });
    w.release = {
      ...w.release,
      resolve: () => ({ ok: true, release: { ref: { ...RELEASE, images: IMAGES }, dir: REPO } }),
    };
    await createBye(w);
    const config = w.executor.applies[0]!.config;
    expect(config.SCANNER_SIGNATURES).toBe("baked");
    expect(config.SCANNER_IMAGE).toBe(
      `registry.cloudflare.com/${ACCOUNT.id}/bye-scanner@sha256:${"2".repeat(64)}`,
    );
    expect(config.MIME_IMAGE).toBe(
      `registry.cloudflare.com/${ACCOUNT.id}/bye-mime@sha256:${"3".repeat(64)}`,
    );
    expect(config.SIGMIRROR_IMAGE).toBe(
      `registry.cloudflare.com/${ACCOUNT.id}/bye-sigmirror@sha256:${"4".repeat(64)}`,
    );
    // The stack accepts exactly these references.
    expect(scannerProblems(config)).toEqual([]);
  });

  it("a pinned release manifest resolves without a checkout; no pin blocks installs", async () => {
    expect(manifestRelease(null).resolve()).toMatchObject({ ok: false });

    const pin = {
      format: "bye.onboarding-release.v1" as const,
      ref: { ...RELEASE, images: IMAGES },
      migrations: ["d1:0001_identity.sql"],
      requiredConfig: ["APP_ORIGIN"],
      qualification: { newsletter: null },
    };

    const source = manifestRelease(pin);
    expect(source.resolve()).toMatchObject({ ok: true, release: { ref: pin.ref } });
    expect(await source.migrations("/anywhere")).toEqual(pin.migrations);
    expect(source.requiredConfig("/anywhere")).toEqual(["APP_ORIGIN"]);

    const w = world();
    w.release = manifestRelease(null);
    await connect(w);
    await expect(
      w.service.install("op@example.com", { accountId: ACCOUNT.id, zoneId: ZONE.id, label: "bye" }),
    ).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("review during a deployment", () => {
  it("is refused up front instead of planning against a running apply", async () => {
    const w = world();
    await connect(w);
    await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    const review = await w.service.review("op@example.com");
    const approval = await w.service.approve("op@example.com", review.id, review.digest);
    w.executor.applyBehavior = () => new Promise(() => {});
    await w.service.deploy("op@example.com", approval.id);
    await new Promise((r) => setTimeout(r, 20));
    const plans = w.executor.planCalls;
    await expect(w.service.review("op@example.com")).rejects.toMatchObject({
      code: "conflict",
      nextAction: "Wait for it to finish, then review again",
    });
    expect(w.executor.planCalls).toBe(plans);
  });
});

describe("hosted onboarding: resuming after a restart (spec §47)", () => {
  /** Service 1 starts "Create Bye" and dies at the given step; returns its store and operation. */
  const lostAt = async (hang: "plan" | "apply") => {
    const store = new DurableObjectStore(new MapStorage());
    const executor = new ResumableExecutor();
    const w1 = world({ store, executor, verifiedScopes: true });

    // The process dies mid-step: the executor never returns.
    if (hang === "apply") executor.applyBehavior = () => new Promise(() => {});
    else
      executor.plans.push(
        (ctx) => planOf(ctx.stage),
        () => new Promise(() => {}) as never,
      );
    await connect(w1);
    w1.health = healthyInstance(`https://bye.${ZONE.name}`);

    const pending = w1.service.install("op@example.com", {
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      label: "bye",
    });

    if (hang === "apply") await pending;
    await new Promise((r) => setTimeout(r, 20));
    const inst = (await store.installationForOperator("op@example.com"))!;
    const op = (await store.operations(inst.id))[0]!;

    return { store, inst, op };
  };

  const restart = (store: OnboardingStore) => {
    const executor = new ResumableExecutor();
    const w2 = world({ store, executor, verifiedScopes: true });
    w2.health = healthyInstance(`https://bye.${ZONE.name}`);

    return w2;
  };

  it("follows the running deployer job instead of interrupting it, with no second apply", async () => {
    const { store, inst, op } = await lostAt("apply");
    expect(op).toMatchObject({ status: "running", step: "apply", job: { id: "job1", next: 0 } });
    expect(op.planned!.length).toBeGreaterThan(0);

    const w2 = restart(store);
    expect(await w2.service.recover(await store.installationIds())).toBe(0);
    await w2.service.settled(op.id);

    const done = (await store.getOperation(op.id))!;
    expect(done.status).toBe("succeeded");
    expect(w2.executor.applies).toHaveLength(0);
    expect((w2.executor as ResumableExecutor).resumes).toEqual([
      { job: { id: "job1", endpoint: "https://bye-deployer.operator.workers.dev" }, from: 0 },
    ]);
    expect((await store.getInstallation(inst.id))!.ready).toBe(true);
    expect(await store.writerHolder(inst.id)).toBeNull();
    const kinds = (await store.events(inst.id)).map((e) => e.kind);
    expect(kinds).toContain("operation.resumed");
  });

  it("a job the deployer no longer has fails with an uncertain outcome, never a replay", async () => {
    const { store, op } = await lostAt("apply");
    const w2 = restart(store);

    (w2.executor as ResumableExecutor).resumeBehavior = async () => ({
      ok: false,
      aborted: false,
      detail:
        "the deployer no longer has this job (its container restarted); the deploy's outcome is uncertain",
    });

    await w2.service.recover(await store.installationIds());
    await w2.service.settled(op.id);
    const failed = (await store.getOperation(op.id))!;
    expect(failed).toMatchObject({ status: "failed", step: "apply" });
    expect(failed.error!.message).toContain("no longer has this job");
    expect(w2.executor.applies).toHaveLength(0);
  });

  it("an operation lost before any write revalidates from the start", async () => {
    const { store, inst, op } = await lostAt("plan");
    expect(op).toMatchObject({ status: "running", step: "revalidate" });
    expect((await store.getInstallation(inst.id))!.firstWriteAt).toBeNull();

    const w2 = restart(store);
    expect(await w2.service.recover(await store.installationIds())).toBe(0);
    await w2.service.settled(op.id);
    expect((await store.getOperation(op.id))!.status).toBe("succeeded");
    expect(w2.executor.applies).toHaveLength(1);
  });

  it("without a connected authorization, or an executor that can resume, it is interrupted", async () => {
    const { store, inst, op } = await lostAt("apply");
    const current = (await store.getInstallation(inst.id))!;
    await store.putInstallation({
      ...current,
      authorization: { ...current.authorization, status: "expired" },
    });
    const w2 = restart(store);
    expect(await w2.service.recover(await store.installationIds())).toBe(1);
    expect((await store.getOperation(op.id))!.status).toBe("interrupted");

    const again = await lostAt("apply");
    const plain = world({ store: again.store, verifiedScopes: true }); // FakeExecutor: no resume
    expect(await plain.service.recover(await again.store.installationIds())).toBe(1);
    expect((await again.store.getOperation(again.op.id))!.status).toBe("interrupted");
  });
});

describe("hosted onboarding: re-attaching a new session (spec §43)", () => {
  const setup = async () => {
    const store = new DurableObjectStore(new MapStorage());
    const w = world({ store, verifiedScopes: true });
    await createBye(w);
    const inst = (await store.installationForOperator("op@example.com"))!;

    return { store, w, inst };
  };

  it("a fresh grant to the account takes the installation over; the old session loses it", async () => {
    const { store, w, inst } = await setup();
    await connect(w, "session:new", "session-2");

    expect(await w.service.reattachable("session:new")).toEqual([
      {
        installationId: inst.id,
        accountName: ACCOUNT.name,
        appUrl: `https://bye.${ZONE.name}`,
        ready: true,
      },
    ]);

    const status = await w.service.reattach("session:new", inst.id);
    expect(status.installation.id).toBe(inst.id);
    expect(status.state).toBe("ready");
    expect((await store.getInstallation(inst.id))!.operatorId).toBe("session:new");
    // The new session's own empty installation is gone; the old session starts from nothing.
    expect(await store.installationIds()).toEqual([inst.id]);
    expect(await store.installationForOperator("op@example.com")).toBeNull();
    expect((await w.service.status("op@example.com")).installation.id).not.toBe(inst.id);
    // The grant was resealed for this installation: management works (review re-plans).
    await expect(w.service.review("session:new")).resolves.toMatchObject({
      installationId: inst.id,
    });
    expect((await store.events(inst.id)).map((e) => e.kind)).toContain("installation.reattached");
    // The recovery kit is still issued once, not again because of the new session.
    expect((await store.getInstallation(inst.id))!.recoveryKitIssuedAt ?? null).toBeNull();
  });

  it("a grant that can't reach the installation's account is refused and offered nothing", async () => {
    const { w, inst } = await setup();
    w.cf.accountsFor = () => [OTHER];
    await connect(w, "session:new", "session-2");
    expect(await w.service.reattachable("session:new")).toEqual([]);
    await expect(w.service.reattach("session:new", inst.id)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("moves the grant as refreshed, not the credentials read before the refresh", async () => {
    const { store, w, inst } = await setup();
    await connect(w, "session:new", "session-2");
    // The new session's access token expires: re-attach refreshes it first.
    w.now += 2 * 3_600_000;
    await w.service.reattach("session:new", inst.id);
    const moved = (await store.getInstallation(inst.id))!;
    const creds = open<{ expiresAt: number }>(KEYS, moved.credentials!, inst.id);
    expect(creds.expiresAt).toBeGreaterThan(w.now);
    expect(moved.authorization.expiresAt).toBe(new Date(creds.expiresAt).toISOString());
    // And it stays usable: no "expired" on the next management call.
    await expect(w.service.review("session:new")).resolves.toMatchObject({
      installationId: inst.id,
    });
  });

  it("only standard (prod) installations can be taken over", async () => {
    const w = world();
    await connect(w);
    const staged = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    await connect(w, "session:new", "session-2");
    expect(await w.service.reattachable("session:new")).toEqual([]);
    await expect(w.service.reattach("session:new", staged.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await w.store.getInstallation(staged.id))!.operatorId).toBe("op@example.com");
  });

  it("a session with its own bound installation cannot take another", async () => {
    const { w, inst } = await setup();
    w.cf.accountsFor = () => [ACCOUNT, OTHER];
    await connect(w, "session:new", "session-2");
    await w.service.bind("session:new", OTHER.id, "dev-other01");
    await expect(w.service.reattach("session:new", inst.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await w.service.reattachable("session:new")).toEqual([]);
  });
});

describe("hosted onboarding: provisioning the deployer is a write (spec §44)", () => {
  /** Like the remote executor: planning provisions the deployer in the account first. */
  class ProvisioningExecutor extends ResumableExecutor {
    readonly provisionsOnPlan = true;
  }

  it("is recorded before the first plan and fixes the target", async () => {
    const executor = new ProvisioningExecutor();
    // Unverified scopes send a prod install to review: no apply, yet the plan wrote the deployer.
    const w = world({ executor });
    const result = await createBye(w);
    expect(result.status).toBe("needs-review");
    const inst = (await w.store.installationForOperator("op@example.com"))!;
    expect(inst.provisionedAt).not.toBeNull();
    expect(inst.firstWriteAt).toBeNull();
    expect((await w.store.events(inst.id)).map((e) => e.kind)).toContain("deployer.provisioning");
    // The deployer lives in this account now: the target can't move to another hostname.
    await expect(
      w.service.install("op@example.com", {
        accountId: ACCOUNT.id,
        zoneId: ZONE.id,
        label: "mail",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("never provisions for a target that fails its prerequisites", async () => {
    const executor = new ProvisioningExecutor();
    const w = world({ executor, verifiedScopes: true });
    await connect(w);
    const inst = await w.service.bind("op@example.com", ACCOUNT.id, "dev-trial01");
    w.cf.workers.push(inst.workerName!); // a Worker with the installation's name already exists
    await expect(w.service.review("op@example.com")).rejects.toMatchObject({
      code: "blocked",
      nextAction: "Resolve these first; nothing has been created in your Cloudflare account yet",
    });
    expect(executor.planCalls).toBe(0);
    expect((await w.store.getInstallation(inst.id))!.provisionedAt ?? null).toBeNull();
  });
});
