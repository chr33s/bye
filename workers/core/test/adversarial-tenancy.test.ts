import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { GC_DELAY_MS, recordGcIntent, sweepBlobGc } from "../src/blobgc.ts";
import { kernelClock } from "../src/durable-host.ts";
import {
  eraseMailboxContent,
  replayTombstones,
  startErasure,
  writeTombstone,
} from "../src/erasure.ts";
import { handleInbound } from "../src/inbound.ts";
import { MailboxDO } from "../src/objects.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  HarnessState,
  inboundMessage,
  makeHarness,
  type StoredObject,
  rfc822,
} from "./harness.ts";

// §13 adversarial suites over the real MailCore wiring: cross-tenant key guessing, restore with
// erasure tombstones, and log redaction across ordinary flows.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly calendarId: string;
  readonly address: string;
  readonly cookie: string;
  readonly token: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
  const account = await directory.provisionPersonalAccount({
    address,
    displayName: address.split("@")[0]!,
  });
  await h.env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: "UTC",
  });
  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);
  return { ...account, cookie: `__Host-session=${session.token}`, token: session.token };
};

const api = async (
  h: Harness,
  account: Account | null,
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await handleFetch(
    new Request(path.startsWith("http") ? path : `${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(account ? { cookie: account.cookie } : {}),
        ...(method === "GET"
          ? {}
          : { origin: h.env.APP_ORIGIN, "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env,
    ctx,
  );
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  return { status: response.status, text, body: text && isJson ? JSON.parse(text) : null };
};

let n = 0;
const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

const allowDomain = (h: Harness, a: Account, domain: string) =>
  api(h, a, "POST", `/v1/mailboxes/${a.mailboxId}/commands`, {
    _tag: "SetPolicy",
    commandId: cmdId(),
    kind: "domain",
    subject: domain,
    policy: { decision: "allowed", destination: "imbox", labels: [], bundle: false, notify: false },
  });

const deliver = async (h: Harness, to: string, subject: string, body: string) => {
  const from = "sender@example.net";
  await handleInbound(
    inboundMessage(from, to, rfc822({ from, to, subject, body, messageId: `${++n}@example.net` })),
    h.env,
  );
  await h.drain();
};

const underPrefix = (h: Harness, prefix: string) =>
  [...h.buckets.ORIGINALS.objects.keys(), ...h.buckets.PARTS.objects.keys()].filter((k) =>
    k.startsWith(prefix),
  );

describe("adversarial tenancy and recovery", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("cross-tenant key guessing: known IDs from another tenant never authorize or leak", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await allowDomain(h, bob, "example.net");
    await deliver(h, "bob@bye.test", "Bob private subject", "bob-only-content");
    const imbox = await api(h, bob, "GET", `/v1/mailboxes/${bob.mailboxId}/views/imbox`);
    const threadId = imbox.body.items[0].threadId as string;
    const thread = await api(h, bob, "GET", `/v1/mailboxes/${bob.mailboxId}/threads/${threadId}`);
    const deliveryId = thread.body.deliveries[0].deliveryId as string;

    const probes = [
      ["GET", `/v1/mailboxes/${bob.mailboxId}/views/imbox`],
      ["GET", `/v1/mailboxes/${bob.mailboxId}/threads/${threadId}`],
      ["GET", `/v1/mailboxes/${bob.mailboxId}/search?q=bob-only-content`],
      ["GET", `/v1/mailboxes/${bob.mailboxId}/deliveries/${deliveryId}/attachments/1`],
      ["GET", `/v1/mailboxes/${bob.mailboxId}/attachments`],
    ] as const;
    for (const [method, path] of probes) {
      const r = await api(h, ana, method, path);
      expect([401, 403, 404], `${method} ${path}`).toContain(r.status);
      expect(r.text).not.toContain("bob-only-content");
      expect(r.text).not.toContain("Bob private subject");
    }
    // Calendar: the authority answers per principal; Bob's events never appear in Ana's reads.
    const at = (hour: number) => ({
      kind: "timed",
      tzid: "UTC",
      local: { year: 2026, month: 9, day: 28, hour, minute: 0, second: 0 },
    });
    const cal = await api(h, bob, "POST", `/v1/calendars/${bob.calendarId}/commands`, {
      schemaVersion: 1,
      command: { type: "CreateCalendar", commandId: cmdId(), name: "Bob", color: "#1f3a5f" },
    });
    const created = await api(h, bob, "POST", `/v1/calendars/${bob.calendarId}/commands`, {
      schemaVersion: 1,
      command: {
        type: "CreateEvent",
        commandId: cmdId(),
        calendarId: cal.body.calendarId ?? cal.body,
        data: { summary: "Bob secret meeting" },
        start: at(9),
        end: at(10),
      },
    });
    expect(created.status).toBe(200);
    const events = await api(
      h,
      ana,
      "GET",
      `/v1/calendars/${bob.calendarId}/events?from=2026-09-27T00:00:00Z&to=2026-09-30T00:00:00Z`,
    );
    expect(events.text).not.toContain("Bob secret meeting");
    expect(events.body?.occurrences ?? []).toEqual([]);
    expect(
      (
        await api(h, ana, "POST", `/v1/calendars/${bob.calendarId}/commands`, {
          schemaVersion: 1,
          command: { type: "CreateCalendar", commandId: cmdId(), name: "X", color: "#000000" },
        })
      ).status,
    ).not.toBe(200);
    const cmd = await api(h, ana, "POST", `/v1/mailboxes/${bob.mailboxId}/commands`, {
      _tag: "Screen",
      commandId: cmdId(),
      decisions: [{ sender: "sender@example.net", decision: "block" }],
    });
    expect(cmd.status).toBe(403);
    // Bob's thread ID replayed against Ana's own mailbox resolves to nothing of Bob's.
    const own = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/threads/${threadId}`);
    expect(own.status).toBe(404);
    expect(own.text).not.toContain("Bob private subject");
  });

  it("cross-tenant key guessing: capability URLs are bound to their key and signature", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const bobKey = `t/${bob.userId}/export/x/${bob.mailboxId}.mbox`;
    await h.buckets.EXPORTS.put(bobKey, "bob export");
    await h.buckets.EXPORTS.put(`t/${ana.userId}/export/x/a.mbox`, "ana export");
    await h.env.EXPORT_ACCOUNT.create({ id: `exp-${ana.userId}-x`, params: {} });
    // Bob asking for Ana's export id resolves to no instance of his: a 404, never her files.
    const guessed = await api(h, bob, "GET", "/v1/exports/x");
    expect([guessed.status, guessed.body?.error?.code]).toEqual([404, "not_found"]);
    const status = await api(h, ana, "GET", "/v1/exports/x");
    const url = new URL(status.body.files[0].url);
    const token = url.searchParams.get("token")!;
    // Ana's valid token cannot be replayed against Bob's key, and prefix tricks are refused.
    for (const key of [
      bobKey,
      `t/${ana.userId}/export/x/../../${bob.userId}/export/x/${bob.mailboxId}.mbox`,
      `t/${bob.userId}/orig/x.eml`,
    ]) {
      const r = await api(
        h,
        null,
        "GET",
        `/v1/downloads?key=${encodeURIComponent(key)}&token=${token}`,
      );
      expect(r.status).toBe(403);
      expect(r.text).not.toContain("bob export");
    }
    // Another user's export status never lists Bob's files.
    expect(JSON.stringify(status.body)).not.toContain(bob.userId);
    // Forged render/preview tokens for Bob's deliveries are refused on the render origin.
    for (const token of [
      `${bob.mailboxId}.dlv_x.${Date.now() + 60_000}.AAAA`,
      `p.${bob.mailboxId}.dlv_x.MQ.${Date.now() + 60_000}.AAAA`,
    ]) {
      expect((await api(h, null, "GET", `${h.env.MAIL_ORIGIN}/render/${token}`)).status).toBe(403);
    }
  });

  it("restore with tombstones: replay after a pre-erasure restore removes resurrected content", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allowDomain(h, ana, "example.net");
    await deliver(h, "ana@bye.test", "Before erasure", "to-be-erased");
    const prefix = `t/${ana.mailboxId}/`;
    expect(underPrefix(h, prefix).length).toBeGreaterThan(0);

    // Backup: R2 objects plus a point-in-time copy of the MailboxDO SQLite storage.
    const r2Backup = new Map<string, Map<string, StoredObject>>([
      ["ORIGINALS", new Map(h.buckets.ORIGINALS.objects)],
      ["PARTS", new Map(h.buckets.PARTS.objects)],
    ]);
    const entry = h.namespaces.MAILBOXES.instances.get(ana.mailboxId)!;
    const backupPath = join(mkdtempSync(join(tmpdir(), "bye-restore-")), "mailbox.sqlite");
    entry.state.storage.db.exec(`VACUUM INTO '${backupPath}'`);

    await startErasure(h.env, ana.userId, "user request");
    await eraseMailboxContent(h.env, ana.mailboxId);
    expect(underPrefix(h, prefix)).toEqual([]);

    // Restore everything from before the erasure (R2 + DO), as a disaster recovery would.
    for (const [name, objects] of r2Backup)
      for (const [k, v] of objects) h.buckets[name as "ORIGINALS" | "PARTS"].objects.set(k, v);
    const state = new HarnessState({ name: ana.mailboxId });
    (state.storage as unknown as { db: DatabaseSync }).db = new DatabaseSync(backupPath);
    h.namespaces.MAILBOXES.instances.set(ana.mailboxId, {
      object: new MailboxDO(state as never, h.env),
      state,
    });
    expect(underPrefix(h, prefix).length).toBeGreaterThan(0);

    const { replayed } = await replayTombstones(h.env);
    expect(replayed).toBeGreaterThan(0);
    expect(underPrefix(h, prefix)).toEqual([]);
    const tables = state.storage.db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'",
      )
      .get() as { n: number };
    expect(tables.n).toBe(0);
  });

  // Regression: tombstone replay pages through every tombstone (keyset pagination).
  it("restore with tombstones: replay covers every tombstone, not only the oldest 500", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allowDomain(h, ana, "example.net");
    await deliver(h, "ana@bye.test", "Newest erasure", "late");
    for (let i = 0; i < 500; i++) await writeTombstone(h.env, "world", `old-${i}`, i);
    await writeTombstone(h.env, "mailbox", ana.mailboxId, Date.now());
    await replayTombstones(h.env);
    await replayTombstones(h.env);
    expect(underPrefix(h, `t/${ana.mailboxId}/`)).toEqual([]);
  });

  // Regression: erasure and reindex clear every shard the mailbox has used, not only the base shard.
  it("erasure clears rolled-over search shards too", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allowDomain(h, ana, "example.net");
    const mailbox = h.namespaces.MAILBOXES.instance(ana.mailboxId);
    // Roll over before the fixture's Date header so the next message is placed in the new shard.
    vi.setSystemTime(Date.UTC(2026, 8, 24));
    const { opened } = mailbox.recordShardHealth(`search:${ana.mailboxId}`, 9_000_000_000);
    expect(opened).toBeTruthy();
    vi.setSystemTime(Date.now() + 1000);
    await deliver(h, "ana@bye.test", "After rollover", "rollover-body");
    expect(h.namespaces.SEARCH_SHARDS.instance(opened!).health().storedBytes).toBeGreaterThan(0);
    await eraseMailboxContent(h.env, ana.mailboxId);
    expect(h.namespaces.SEARCH_SHARDS.instance(opened!).health().storedBytes).toBe(0);
  });

  const redeliverDirect = async (from: Account, to: Account, mode: "copy" | "move") => {
    // Redelivery is re-authorized at delivery time: the source's user must be
    // able to send into the target, so grant that first.
    const org = (await h.d1
      .prepare("SELECT org_id FROM mailboxes WHERE id = ?")
      .bind(to.mailboxId)
      .first<{ org_id: string }>())!.org_id;
    await h.d1
      .prepare(
        "INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)",
      )
      .bind(org, from.userId, Date.now(), Date.now())
      .run();
    await h.d1
      .prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
      .bind(to.mailboxId, from.userId, Date.now())
      .run();
    const store = (
      h.namespaces.MAILBOXES.instance(from.mailboxId) as unknown as {
        store: import("@bye/platform-cloudflare").MailboxStore;
      }
    ).store;
    const imbox = await api(h, from, "GET", `/v1/mailboxes/${from.mailboxId}/views/imbox`);
    const thread = await api(
      h,
      from,
      "GET",
      `/v1/mailboxes/${from.mailboxId}/threads/${imbox.body.items[0].threadId}`,
    );
    const d = thread.body.deliveries[0] as { deliveryId: string; messageKey?: string };
    const messageKey = store.ctx.sql.one<{ message_key: string }>(
      "SELECT message_key FROM deliveries WHERE delivery_id = ?",
      d.deliveryId,
    )!.message_key;
    store.transfers.redeliver({
      deliveryId: d.deliveryId,
      targetMailboxId: to.mailboxId,
      mode,
      summary: store.ingest.deliverySummary(d.deliveryId),
    });
    await h.namespaces.MAILBOXES.instance(from.mailboxId).alarm?.();
    await h.drain();
    return messageKey;
  };

  it("copied redelivery: the target keeps its bytes while the source still holds the delivery", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await allowDomain(h, ana, "example.net");
    await deliver(h, "ana@bye.test", "Shared doc", "copied-body");
    const key = await redeliverDirect(ana, bob, "copy");
    expect((await api(h, bob, "GET", `/v1/mailboxes/${bob.mailboxId}/views/imbox`)).text).toContain(
      "Shared doc",
    );
    await recordGcIntent(h.env, {
      bucket: "ORIGINALS",
      key,
      ownerKind: "mailbox",
      ownerId: ana.mailboxId,
      reason: "retention",
    });
    await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS + 1);
    expect(h.buckets.ORIGINALS.objects.has(key)).toBe(true);
  });

  // Regression: a moved delivery must not depend on the source tenant's key (fixed by copying the
  // message into the target namespace on redelivery).
  it("moved redelivery: the target's bytes survive the source's GC sweep", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await allowDomain(h, ana, "example.net");
    await deliver(h, "ana@bye.test", "Moved doc", "moved-body");
    const key = await redeliverDirect(ana, bob, "move");
    expect((await api(h, bob, "GET", `/v1/mailboxes/${bob.mailboxId}/views/imbox`)).text).toContain(
      "Moved doc",
    );
    expect(
      (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).text,
    ).not.toContain("Moved doc");
    // The target holds its own tenant-scoped copy, so the source's sweep cannot touch it.
    const bobStore = (
      h.namespaces.MAILBOXES.instance(bob.mailboxId) as unknown as {
        store: import("@bye/platform-cloudflare").MailboxStore;
      }
    ).store;
    const targetKey = bobStore.ctx.sql.one<{ message_key: string }>(
      "SELECT message_key FROM deliveries ORDER BY received_at DESC LIMIT 1",
    )!.message_key;
    expect(targetKey).not.toBe(key);
    expect(targetKey.startsWith(`t/${bob.mailboxId}/`)).toBe(true);
    await recordGcIntent(h.env, {
      bucket: "ORIGINALS",
      key,
      ownerKind: "mailbox",
      ownerId: ana.mailboxId,
      reason: "moved",
    });
    await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS + 1);
    expect(h.buckets.ORIGINALS.objects.has(targetKey)).toBe(true);
    expect(new TextDecoder().decode(h.buckets.ORIGINALS.objects.get(targetKey)!.bytes)).toContain(
      "moved-body",
    );
  });

  it("log redaction: ordinary flows never log bodies, queries, credentials or signing keys", async () => {
    const lines: Array<string> = [];
    const capture = (...args: Array<unknown>) =>
      void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    try {
      const ana = await signup(h, "ana@bye.test");
      await allowDomain(h, ana, "example.net");
      await deliver(h, "ana@bye.test", "Quarterly SUBJECTCANARY", "BODYCANARY lorem ipsum");
      await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=QUERYCANARY`);
      await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
      await api(h, null, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
      await api(h, ana, "POST", "/v1/drafts", {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: {
          to: [{ address: "x@example.net" }],
          cc: [],
          bcc: [],
          subject: "DRAFTCANARY",
          text: "DRAFTBODYCANARY",
          attachments: [],
        },
      });
      // A failing dependency must not dump request data either.
      h.d1.failing = true;
      await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox?secret=QSCANARY`).catch(
        () => undefined,
      );
      h.d1.failing = false;
      const all = lines.join("\n");
      for (const canary of [
        "BODYCANARY",
        "QUERYCANARY",
        "DRAFTBODYCANARY",
        "QSCANARY",
        ana.token,
        h.env.SESSION_KEY,
        h.env.PROXY_SIGNING_KEY,
      ]) {
        expect(all, `log leaked ${canary.slice(0, 12)}`).not.toContain(canary);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
