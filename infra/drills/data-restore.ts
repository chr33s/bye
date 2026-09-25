import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import { build } from "rolldown";
import { ControlDirectory } from "@bye/platform-cloudflare";
import { QUEUE_NAMES, QUEUES } from "../resources/queues.ts";
import { COMPATIBILITY } from "../resources/workers.ts";

// Data restore drills (§12: "Restore drills must cover a mailbox, an organization/shared resource,
// a calendar, and a complete export"). Runs the real MailCore bundle in local workerd with
// persisted D1/Durable Object/R2 state, takes a checkpoint of the authoritative state (D1 + DO
// SQLite), damages it, restores the checkpoint, and verifies each authority plus erasure-tombstone
// replay (erased data must not be resurrected by a restore).
//
// Production uses DO point-in-time recovery (`POST /v1/ops/restore`) and D1 Time Travel; see
// infra/drills/DATA_RESTORE.md. Local workerd lacks PITR, so this drill restores by checkpointing
// the persisted SQLite files, which exercises the same invariants: R2 (originals, tombstone ledger)
// is NOT rolled back, authorities are.
//
// Usage: node --experimental-transform-types --no-warnings infra/drills/data-restore.ts

const ROOT = join(import.meta.dirname, "../..");
const APP = "https://app.bye.test";
const OPS_TOKEN = "drill-ops-token-0123456789abcdef0123456789";
const clock = {
  now: () => Date.now(),
  id: (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
};

type RpcResult<A> = { ok: true; value: A } | { ok: false; code: string; message: string };

export interface DrillCheck {
  readonly drill: "mailbox" | "shared" | "calendar" | "export" | "tombstones";
  readonly ok: boolean;
  readonly detail: string;
}

const bundleCore = async (dir: string): Promise<string> => {
  const file = join(dir, "core.js");
  await build({
    input: join(ROOT, "workers/core/src/index.ts"),
    platform: "neutral",
    external: [/^cloudflare:/],
    resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
    output: { file, format: "esm" },
    logLevel: "silent",
  });
  return file;
};

const start = async (
  scriptPath: string,
  modulesRoot: string,
  persist: string,
): Promise<Miniflare> => {
  const mf = new Miniflare({
    defaultPersistRoot: persist,
    unsafeTriggerHandlers: true,
    log: new Log(LogLevel.WARN),
    workers: [
      {
        name: "core",
        compatibilityDate: COMPATIBILITY.date,
        modules: true,
        scriptPath,
        modulesRoot,
        bindings: {
          APP_ORIGIN: APP,
          MAIL_ORIGIN: "https://mail.bye-render.test",
          PERSONAL_MAIL_API_KEY: "",
          SESSION_KEY: "drill-session-key-0123456789abcdef",
          PROXY_SIGNING_KEY: "drill-proxy-key-0123456789abcdef",
          BILLING_WEBHOOK_SECRET: "drill-billing-webhook-0123456789abcdef",
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
        // Local queue names are the lowercased logical IDs, which dlq.ts's exact lookup resolves.
        queueProducers: Object.fromEntries(
          QUEUE_NAMES.map((name) => [QUEUES[name].binding, { queueName: name.toLowerCase() }]),
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
        outboundService: () => new Response("egress blocked in drill", { status: 599 }),
      },
    ],
  });
  await mf.ready;
  return mf;
};

const migrate = async (mf: Miniflare): Promise<void> => {
  const d1 = await mf.getD1Database("DIRECTORY", "core");
  for (const m of readdirSync(join(ROOT, "infra/migrations/d1"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(ROOT, "infra/migrations/d1", m), "utf8").replace(
      /--[^\n]*\n/g,
      "\n",
    );
    await d1.batch(
      sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => d1.prepare(s)),
    );
  }
};

const summary = (subject: string, from: string, to: string) => ({
  from: { name: undefined, address: from },
  to: [{ name: undefined, address: to }],
  cc: [],
  replyTo: [],
  subject,
  date: Date.now(),
  messageIdHeader: `${crypto.randomUUID()}@example.net`,
  inReplyTo: [],
  references: [],
  listId: undefined,
  listUnsubscribe: undefined,
  automated: false,
  snippet: subject,
  attachments: [],
  hasCalendar: false,
  calendarMethod: undefined,
});

// Checkpoint = the authoritative state (D1 + Durable Object SQLite). R2 is intentionally excluded.
const AUTHORITY_DIRS = ["d1", "do"] as const;
const checkpoint = (persist: string, to: string) => {
  for (const d of AUTHORITY_DIRS) cpSync(join(persist, d), join(to, d), { recursive: true });
};
const restore = (from: string, persist: string) => {
  for (const d of AUTHORITY_DIRS) {
    rmSync(join(persist, d), { recursive: true, force: true });
    cpSync(join(from, d), join(persist, d), { recursive: true });
  }
};

export const runDataRestoreDrill = async (): Promise<ReadonlyArray<DrillCheck>> => {
  const work = mkdtempSync(join(tmpdir(), "bye-drill-"));
  const code = join(work, "code");
  const persist = join(work, "state");
  const backup = join(work, "checkpoint");
  const checks: Array<DrillCheck> = [];
  try {
    const script = await bundleCore(code);
    let mf = await start(script, code, persist);
    await migrate(mf);
    const d1 = await mf.getD1Database("DIRECTORY", "core");
    const directory = new ControlDirectory(d1 as never, clock);
    const ana = await directory.provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "Ana",
    });
    const bo = await directory.provisionPersonalAccount({
      address: "bo@bye.test",
      displayName: "Bo",
    });
    const cy = await directory.provisionPersonalAccount({
      address: "cy@bye.test",
      displayName: "Cy",
    });

    const ns = async () => ({
      mail: await mf.getDurableObjectNamespace("MAILBOXES", "core"),
      cal: await mf.getDurableObjectNamespace("CALENDARS", "core"),
      spaces: await mf.getDurableObjectNamespace("SHARED_SPACES", "core"),
      originals: await mf.getR2Bucket("ORIGINALS", "core"),
    });
    const deliver = async (mailboxId: string, to: string, subject: string) => {
      const { mail, originals } = await ns();
      const ingestionId = clock.id("ing");
      const messageKey = `t/${mailboxId}/orig/${ingestionId}.eml`;
      await originals.put(messageKey, `Subject: ${subject}\r\n\r\nbody`);
      const r = (await (
        mail.getByName(mailboxId) as unknown as {
          commitDelivery(i: unknown): Promise<RpcResult<unknown>>;
        }
      ).commitDelivery({
        ingestionId,
        recipient: to,
        messageKey,
        rawSize: 32,
        summary: summary(subject, "friend@example.net", to),
        safety: { _tag: "Clean" },
        receivedAt: Date.now(),
      })) as RpcResult<unknown>;
      if (!r.ok) throw new Error(`seed delivery failed: ${r.code}`);
      return messageKey;
    };
    const manifest = async (mailboxId: string): Promise<ReadonlyArray<string>> => {
      const { mail } = await ns();
      const stub = mail.getByName(mailboxId) as unknown as {
        exportManifestPage(
          c: string | null,
          l: number,
        ): Promise<
          | { deliveries: ReadonlyArray<{ deliveryId: string }>; next: string | null }
          | { items?: ReadonlyArray<{ deliveryId: string }>; nextCursor?: string | null }
        >;
      };
      const ids: Array<string> = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const page = (await stub.exportManifestPage(cursor, 50)) as {
          deliveries?: ReadonlyArray<{ deliveryId: string }>;
          items?: ReadonlyArray<{ deliveryId: string }>;
          next?: string | null;
          nextCursor?: string | null;
        };
        ids.push(...(page.deliveries ?? page.items ?? []).map((d) => d.deliveryId));
        cursor = page.next ?? page.nextCursor ?? null;
        if (!cursor) break;
      }
      return ids.sort();
    };
    const calendarEvents = async (): Promise<number> => {
      const { cal } = await ns();
      const r = (await (
        cal.getByName(ana.calendarId) as unknown as {
          read(actor: string, q: unknown): Promise<RpcResult<ReadonlyArray<unknown>>>;
        }
      ).read(ana.userId, {
        type: "Occurrences",
        from: Date.UTC(2026, 9, 1),
        to: Date.UTC(2026, 9, 8),
      })) as RpcResult<ReadonlyArray<unknown>>;
      return r.ok ? r.value.length : -1;
    };
    const spaceMember = async (userId: string): Promise<boolean> => {
      const { spaces } = await ns();
      const r = (await (
        spaces.getByName("space:spc_drill") as unknown as {
          isMember(u: string): Promise<RpcResult<boolean>>;
        }
      ).isMember(userId)) as RpcResult<boolean>;
      return r.ok && r.value;
    };

    // ---- seed ----
    await deliver(ana.mailboxId, "ana@bye.test", "Invoice");
    await deliver(ana.mailboxId, "ana@bye.test", "Contract");
    const boKey = await deliver(bo.mailboxId, "bo@bye.test", "Private");
    {
      const { cal, spaces } = await ns();
      const calStub = cal.getByName(ana.calendarId) as unknown as {
        provision(c: unknown): Promise<void>;
        execute(a: string, c: unknown): Promise<RpcResult<unknown>>;
      };
      await calStub.provision({
        ownerId: ana.userId,
        selfAddresses: ["ana@bye.test"],
        defaultZone: "UTC",
      });
      const created = (await calStub.execute(ana.userId, {
        type: "CreateCalendar",
        commandId: clock.id("cmd"),
        name: "Work",
        color: "#123456",
      })) as RpcResult<string | { calendarId: string }>;
      if (!created.ok) throw new Error(`seed calendar failed: ${created.code}`);
      const calendarId =
        typeof created.value === "string" ? created.value : created.value.calendarId;
      const at = (h: number) => ({
        kind: "timed",
        tzid: "UTC",
        local: { year: 2026, month: 10, day: 2, hour: h, minute: 0, second: 0 },
      });
      const ev = (await calStub.execute(ana.userId, {
        type: "CreateEvent",
        commandId: clock.id("cmd"),
        calendarId,
        data: { summary: "Board" },
        start: at(9),
        end: at(10),
      })) as RpcResult<unknown>;
      if (!ev.ok) throw new Error(`seed event failed: ${ev.code}`);
      const space = spaces.getByName("space:spc_drill") as unknown as {
        initSpace(i: unknown): Promise<RpcResult<unknown>>;
        setMember(a: string, u: string, r: string | null): Promise<RpcResult<unknown>>;
      };
      await space.initSpace({
        spaceId: "spc_drill",
        kind: "team",
        organizationId: ana.organizationId,
        ownerId: ana.userId,
      });
      await space.setMember(ana.userId, bo.userId, "member");
      await space.setMember(ana.userId, cy.userId, "member");
    }
    const before = {
      anaManifest: await manifest(ana.mailboxId),
      events: await calendarEvents(),
      bo: await spaceMember(bo.userId),
      cy: await spaceMember(cy.userId),
    };

    // ---- checkpoint (authoritative state only) ----
    await mf.dispose();
    checkpoint(persist, backup);
    mf = await start(script, code, persist);

    // ---- damage + an erasure that happens AFTER the checkpoint ----
    {
      const { mail, spaces } = await ns();
      await (mail.getByName(ana.mailboxId) as unknown as { eraseAll(): Promise<void> }).eraseAll();
      await (
        spaces.getByName("space:spc_drill") as unknown as {
          setMember(a: string, u: string, r: null): Promise<unknown>;
        }
      ).setMember(ana.userId, cy.userId, null);
      const erase = await mf.dispatchFetch(`${APP}/v1/ops/erasure`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ userId: bo.userId, reason: "drill" }),
      });
      if (erase.status !== 202) throw new Error(`erasure request failed: ${erase.status}`);
      await mf.dispatchFetch(`${APP}/v1/ops/tombstones/replay`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPS_TOKEN}` },
      });
    }
    const damaged = {
      anaManifest: await manifest(ana.mailboxId).catch(() => [] as ReadonlyArray<string>),
      boOriginal: (await (await ns()).originals.head(boKey)) !== null,
    };

    // ---- restore the checkpoint (D1 + DO), keep R2 ----
    await mf.dispose();
    restore(backup, persist);
    mf = await start(script, code, persist);

    const after = {
      anaManifest: await manifest(ana.mailboxId),
      events: await calendarEvents(),
      cy: await spaceMember(cy.userId),
    };
    checks.push({
      drill: "mailbox",
      ok:
        damaged.anaManifest.length === 0 &&
        JSON.stringify(after.anaManifest) === JSON.stringify(before.anaManifest),
      detail: `deliveries before=${before.anaManifest.length} damaged=${damaged.anaManifest.length} restored=${after.anaManifest.length}`,
    });
    checks.push({
      drill: "calendar",
      ok: before.events === 1 && after.events === 1,
      detail: `events before=${before.events} restored=${after.events}`,
    });
    checks.push({
      drill: "export",
      ok: after.anaManifest.length === before.anaManifest.length && after.anaManifest.length > 0,
      detail: "complete export manifest is reproducible from restored authorities",
    });

    // The checkpoint predates Bo's erasure: D1 tombstone rows and Bo's DO rolled back. The R2
    // ledger survived, so replay must erase Bo again, including shared-space membership.
    const boBeforeReplay = await manifest(bo.mailboxId);
    const replay = await mf.dispatchFetch(`${APP}/v1/ops/tombstones/replay`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    const replayed = (await replay.json()) as { replayed?: number };
    const boAfterReplay = await manifest(bo.mailboxId);
    const boMemberAfterReplay = await spaceMember(bo.userId);
    checks.push({
      drill: "shared",
      ok:
        before.bo && before.cy && after.cy && !boMemberAfterReplay && damaged.boOriginal === false,
      detail: `removed member restored=${after.cy}; erased member after restore+replay=${boMemberAfterReplay}`,
    });
    checks.push({
      drill: "tombstones",
      ok: boBeforeReplay.length === 1 && boAfterReplay.length === 0 && (replayed.replayed ?? 0) > 0,
      detail: `restored bo deliveries=${boBeforeReplay.length} after replay=${boAfterReplay.length} tombstones=${replayed.replayed ?? 0}`,
    });
    await mf.dispose();
    return checks;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const checks = await runDataRestoreDrill();
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.drill}: ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
