import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import { build } from "rolldown";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { COMPATIBILITY } from "../../../infra/resources/workers.ts";

// A local deployment of the production bundles in real workerd (via Miniflare): SQLite-backed
// Durable Objects behind their RPC boundary, D1 with every real migration applied in order, R2,
// Queues with consumers, Workflows and the send_email binding. Shared by the workerd suites.

export const ROOT = join(import.meta.dirname, "../../..");

export const APP = "https://app.bye.test";

export const OPS_TOKEN = "workerd-ops-token-0123456789abcdef0123";

const QUEUES = ["ingest", "parse-scan", "index", "dispatch", "notify", "propagate", "publish"];

const BINDING_FOR = new Map([
  ["ingest", "INGEST"],
  ["parse-scan", "PARSE_SCAN"],
  ["index", "INDEX"],
  ["dispatch", "DISPATCH"],
  ["notify", "NOTIFY"],
  ["propagate", "PROPAGATE"],
  ["publish", "PUBLISH"],
]);

const bundle = async (dir: string, worker: string): Promise<string> => {
  const file = join(dir, `${worker}.js`);
  await build({
    input: join(ROOT, `workers/${worker}/src/index.ts`),
    platform: "neutral",
    external: [/^cloudflare:/],
    resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
    output: { file, format: "esm" },
    logLevel: "silent",
  });

  return file;
};

export const clock = {
  now: () => Date.now(),
  id: (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
};

export interface WorkerdEnv {
  readonly mf: Miniflare;
  readonly cookie: string;
  readonly token: string;
  readonly mailboxId: string;
  readonly calendarId: string;
  readonly userId: string;
  /** D1 migration files applied, in order. */
  readonly migrations: ReadonlyArray<string>;
  readonly auth: ControlAuth;
  readonly dispose: () => Promise<void>;
}

export interface WorkerdOptions {
  /** `MAIL_TRAFFIC_CLASSES` (default `transactional`). */
  readonly trafficClasses?: string;
}

export const startWorkerd = async (options: WorkerdOptions = {}): Promise<WorkerdEnv> => {
  const dir = mkdtempSync(join(tmpdir(), "bye-workerd-"));
  const core = await bundle(dir, "core");
  const pub = await bundle(dir, "public");

  const mf = new Miniflare({
    unsafeTriggerHandlers: true,
    log: new Log(process.env.BYE_WORKERD_LOG ? LogLevel.DEBUG : LogLevel.WARN),
    workers: [
      {
        name: "core",
        // Per-worker option; the production date (2026-09-25) is newer than this workerd build.
        compatibilityDate: COMPATIBILITY.date,
        modules: true,
        scriptPath: core,
        modulesRoot: dir,
        bindings: {
          APP_ORIGIN: APP,
          MAIL_ORIGIN: "https://mail.bye-render.test",
          MAIL_TRAFFIC_CLASSES: options.trafficClasses ?? "transactional",
          SESSION_KEY: "workerd-session-key-0123456789abcdef",
          PROXY_SIGNING_KEY: "workerd-proxy-key-0123456789abcdef",
          BILLING_WEBHOOK_SECRET: "workerd-billing-secret-0123456789abcdef",
          TURNSTILE_SECRET: "turnstile",
          OPS_TOKEN,
        },
        d1Databases: ["DIRECTORY"],
        r2Buckets: ["ORIGINALS", "PARTS", "EXPORTS", "PUBLISHED"],
        kvNamespaces: ["CONFIG_CACHE"],
        durableObjects: {
          MAILBOXES: { className: "MailboxDO", useSQLite: true },
          CALENDARS: { className: "CalendarDO", useSQLite: true },
          SHARED_SPACES: { className: "SharedSpaceDO", useSQLite: true },
          SEARCH_SHARDS: { className: "SearchShardDO", useSQLite: true },
          INGRESS_JOURNALS: { className: "IngressJournalDO", useSQLite: true },
        },
        queueProducers: Object.fromEntries(
          QUEUES.map((q) => [BINDING_FOR.get(q)!, { queueName: q }]),
        ),
        queueConsumers: Object.fromEntries(
          QUEUES.map((q) => [
            q,
            { maxBatchSize: 10, maxBatchTimeout: 0.1, maxRetries: 3, deadLetterQueue: `${q}-dlq` },
          ]),
        ),
        workflows: {
          PROVISION_DOMAIN: { name: "provision-domain", className: "ProvisionDomainWorkflow" },
          EXPORT_ACCOUNT: { name: "export-account", className: "ExportWorkflow" },
          ERASE_ACCOUNT: { name: "erase-account", className: "EraseWorkflow" },
          REINDEX: { name: "reindex", className: "ReindexWorkflow" },
          FANOUT: { name: "fanout", className: "FanoutWorkflow" },
        },
        email: { send_email: [{ name: "TRANSACTIONAL_EMAIL" }] },
        ratelimits: {
          AUTH_RATE_LIMIT: { namespace_id: "1001", simple: { limit: 1000, period: 60 } },
        },
        // No real egress from tests: Turnstile succeeds, everything else is refused.
        outboundService: (request: Request) =>
          new URL(request.url).hostname === "challenges.cloudflare.com"
            ? Response.json({ success: true })
            : new Response("egress blocked in test", { status: 599 }),
      },
      {
        name: "public",
        compatibilityDate: COMPATIBILITY.date,
        modules: true,
        scriptPath: pub,
        modulesRoot: dir,
        routes: ["bye.test/*"],
        bindings: { APP_ORIGIN: "https://app.bye.test" },
        r2Buckets: { PUBLISHED: "PUBLISHED" },
        ratelimits: {
          PUBLIC_RATE_LIMIT: { namespace_id: "1002", simple: { limit: 1000, period: 60 } },
        },
        serviceBindings: { CORE: { name: "core", entrypoint: "PublicGateway" } },
      },
    ],
  });

  await mf.ready;
  const d1 = await mf.getD1Database("DIRECTORY", "core");

  const migrations = readdirSync(join(ROOT, "infra/migrations/d1"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const m of migrations) {
    const sql = readFileSync(join(ROOT, "infra/migrations/d1", m), "utf8").replace(
      /--[^\n]*\n/g,
      "\n",
    );

    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    await d1.batch(statements.map((s) => d1.prepare(s)));
  }

  const account = await new ControlDirectory(d1 as never, clock).provisionPersonalAccount({
    address: "ana@bye.test",
    displayName: "Ana",
  });

  const origin = new URL(APP);

  const auth = new ControlAuth(d1 as never, clock, {
    rp: { rpId: origin.hostname, origins: [APP], requireUserVerification: true },
    totpKeys: { current: 1, keys: { 1: new Uint8Array(32) } },
    recoveryPepper: "workerd-session-key-0123456789abcdef",
  });

  const cookie = `__Host-session=${(await auth.issueSession(account.userId, "workerd", true)).token}`;

  const token = (
    await auth.createApiToken(account.userId, {
      kind: "agent",
      label: "jmap",
      scopes: ["read", "draft", "send", "screen", "delete", "admin"],
    })
  ).token;

  return {
    mf,
    cookie,
    token,
    mailboxId: account.mailboxId,
    calendarId: account.calendarId,
    userId: account.userId,
    migrations,
    auth,
    dispose: async () => {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
