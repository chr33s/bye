import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MAX_MESSAGE_RECIPIENTS, MailDraftContent } from "@bye/contracts";
import {
  allInChunks,
  applyMailboxCommand,
  applyMailboxRead,
  inListChunks,
  Kernel,
  KERNEL_MIGRATIONS,
  KERNEL_RETENTION_MS,
  MAX_SEARCH_TERMS,
  migrate,
  RETENTION_BATCH,
  Sql,
} from "@bye/platform-cloudflare";
import {
  cmd,
  deliveryFixture,
  makeTestMailbox,
  makeTestSearchShard,
  MemoryDurableStorage,
  summaryFixture,
  TestClock,
} from "@bye/testing";

// Regression tests for Cloudflare's SQL limits (100 bound parameters, 50-byte LIKE patterns),
// which the test shims now enforce, and for kernel/mailbox housekeeping bounds.

const DAY = 24 * 3600 * 1000;
const long = (n: number) => "x".repeat(n);

const setup = () => {
  const m = makeTestMailbox();
  const deliver = (over: Parameters<typeof summaryFixture>[0] = {}) => {
    m.clock.advance(1000);
    return m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture(over)));
  };
  m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
  return { ...m, deliver };
};

const draftTo = (m: ReturnType<typeof setup>, addresses: ReadonlyArray<string>) =>
  m.store.drafts.createDraft({
    content: {
      to: addresses.map((address) => ({ name: undefined, address })),
      cc: [],
      bcc: [],
      subject: "Hi",
      text: "body",
      attachments: [],
    },
  });

describe("IN lists stay under 100 bound parameters", () => {
  it("chunks ids at 90 and de-duplicates", () => {
    expect(inListChunks(Array.from({ length: 181 }, (_, i) => i)).map((c) => c.length)).toEqual([
      90, 90, 1,
    ]);
    const seen: Array<number> = [];
    allInChunks(["a", "a", "b"], (c) => (seen.push(c.length), []));
    expect(seen).toEqual([2]);
  });

  it("listView at its 200-item maximum loads labels for every thread", () => {
    const m = setup();
    for (let i = 0; i < 205; i++) {
      const t = m.deliver({ subject: `t${i}` });
      if (i % 2 === 0) m.store.organize.setThreadLabels(t.threadId, ["even"], []);
    }
    const page = m.store.views.listView({ view: "everything", limit: 200 });
    expect(page.items).toHaveLength(200);
    expect(page.items.filter((t) => t.labels.includes("even")).length).toBeGreaterThan(90);
  });

  it("a thread with more than 100 deliveries loads its attachments", () => {
    const m = setup();
    const first = m.deliver({ messageIdHeader: "root@x", subject: "long thread" });
    for (let i = 0; i < 110; i++)
      m.deliver({
        subject: "Re: long thread",
        inReplyTo: ["root@x"],
        references: ["root@x"],
      });
    expect(m.store.views.getThread(first.threadId).deliveries.length).toBeGreaterThan(100);
  });

  it("SendJobs returns the latest 200 jobs, oldest first, with recipients", () => {
    const m = setup();
    const ids: Array<string> = [];
    for (let i = 0; i < 205; i++) {
      m.clock.advance(1);
      const { draftId } = draftTo(m, [`r${i}@example.com`]);
      const r = m.store.sends.send(draftId, { expectedRevision: 1 });
      if (r._tag !== "Queued") throw new Error(r._tag);
      ids.push(...r.sendJobIds);
    }
    const all = m.store.sends.jobs(undefined, 200);
    expect(all.map((j) => j.sendJobId)).toEqual(ids.slice(-200));
    expect(all.every((j) => j.recipients.length === 1)).toBe(true);
    const read = applyMailboxRead(m.store, { _tag: "SendJobs" }) as {
      items: ReadonlyArray<{ sendJobId: string }>;
    };
    expect(read.items.map((j) => j.sendJobId)).toEqual(ids.slice(-200));
  });

  it("contacts with groups export past 100 rows", () => {
    const m = setup();
    for (let i = 0; i < 130; i++)
      m.store.organize.putContact({
        name: `c${i}`,
        emails: [`c${i}@example.com`],
        groups: ["team"],
      });
    const all = m.store.organize.exportContacts();
    expect(all).toHaveLength(130);
    expect(all.every((c) => c.groups.includes("team"))).toBe(true);
  });
});

describe("user input never reaches a LIKE pattern over 50 bytes", () => {
  const longDomain = `${long(60)}.example.com`;
  const longAddress = `${long(60)}@${longDomain}`;

  it("contact search, suggestions, import and history accept long values", () => {
    const m = setup();
    m.store.organize.putContact({ name: "Long", emails: [longAddress] });
    expect(m.store.organize.searchContacts(long(60)).map((c) => c.name)).toEqual(["Long"]);
    expect(m.store.organize.searchContacts("%")).toEqual([]);
    m.store.organize.recordRecipients([{ address: longAddress }]);
    expect(m.store.organize.suggestRecipients(long(55)).map((s) => s.address)).toContain(
      longAddress,
    );
    expect(m.store.organize.importContacts([{ name: "Renamed", emails: [longAddress] }])).toEqual({
      imported: 1,
    });
    expect(m.store.organize.exportContacts().map((c) => c.name)).toEqual(["Renamed"]);
    m.store.screener.screen([{ sender: longAddress, decision: "allow" }]);
    m.deliver({ fromAddress: longAddress });
    expect(m.store.organize.senderHistory(longDomain)).toHaveLength(1);
    // A domain filter is an exact `@domain` suffix: subdomains don't match (as with LIKE before).
    expect(m.store.organize.senderHistory("example.com")).toHaveLength(0);
    expect(m.store.organize.senderHistory("other.com")).toHaveLength(0);
    expect(m.store.organize.recipientHistory(longAddress)).toEqual([]);
    expect(m.store.organize.clips(long(80))).toEqual([]);
  });

  it("a domain sender policy with a long domain updates matching threads", () => {
    const m = setup();
    const from = `bob@${longDomain}`;
    m.store.screener.screen([{ sender: from, decision: "allow" }]);
    const t = m.deliver({ fromAddress: from });
    m.store.screener.setPolicy("domain", longDomain, {
      decision: "allowed",
      destination: "feed",
      labels: [],
      bundle: false,
      notify: false,
    });
    expect(m.store.views.getThread(t.threadId).thread.destination).toBe("feed");
  });

  it("search filters and punctuation terms accept long values", () => {
    const shard = makeTestSearchShard();
    shard.upsert({
      docId: "delivery:1",
      kind: "delivery",
      refId: "1",
      version: 1,
      date: 1,
      from: longAddress,
      to: [longAddress],
      labels: [long(60)],
      body: `${"!".repeat(60)} tail`,
    });
    const hits = (q: string) => shard.candidates(q).candidates.map((c) => c.refId);
    expect(hits(`from:${longDomain}`)).toEqual(["1"]);
    expect(hits(`from:${longAddress}`)).toEqual(["1"]);
    expect(hits(`to:${longAddress}`)).toEqual(["1"]);
    expect(hits(`label:${long(60)}`)).toEqual(["1"]);
    expect(hits("!".repeat(60))).toEqual(["1"]);
    expect(hits(`to:${long(61)}@nowhere.test`)).toEqual([]);
  });
});

describe("search bounds", () => {
  it("rejects queries with too many terms as bad_request", () => {
    const shard = makeTestSearchShard();
    const q = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `kind:k${i}`).join(" ");
    expect(() => shard.candidates(q)).toThrow(expect.objectContaining({ code: "bad_request" }));
    const ok = Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `t${i}`).join(" ");
    expect(shard.candidates(ok).candidates).toEqual([]);
  });

  it("an undecodable cursor is bad_request, not a defect", () => {
    const shard = makeTestSearchShard();
    for (const cursor of ["%%%not-base64", btoa("not json"), btoa(JSON.stringify({ d: "x" }))])
      expect(() => shard.candidates("hello", { cursor })).toThrow(
        expect.objectContaining({ code: "bad_request" }),
      );
  });
});

describe("recipient ceiling", () => {
  const content = (to: number, cc = 0, bcc = 0) => {
    const list = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => ({ address: `${p}${i}@example.com` }));
    return {
      to: list(to, "t"),
      cc: list(cc, "c"),
      bcc: list(bcc, "b"),
      subject: "s",
      text: "t",
      attachments: [],
    };
  };
  const decode = Schema.decodeUnknownExit(MailDraftContent);

  it("caps each list and the combined total", () => {
    expect(decode(content(MAX_MESSAGE_RECIPIENTS))._tag).toBe("Success");
    expect(decode(content(MAX_MESSAGE_RECIPIENTS + 1))._tag).toBe("Failure");
    expect(decode(content(50, 30, 20))._tag).toBe("Success");
    expect(decode(content(50, 30, 21))._tag).toBe("Failure");
  });

  it("group expansion past the ceiling is rejected at send", () => {
    const m = setup();
    for (let i = 0; i < MAX_MESSAGE_RECIPIENTS; i++)
      m.store.organize.putContact({
        name: `g${i}`,
        emails: [`g${i}@example.com`],
        groups: ["all"],
      });
    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [{ name: undefined, address: "extra@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "body",
        attachments: [],
        groups: ["all"],
      },
    });
    expect(() => m.store.sends.send(draftId, { expectedRevision: 1 })).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
  });
});

describe("kernel housekeeping", () => {
  const kernel = (storage = new MemoryDurableStorage()) => {
    const sql = new Sql(storage);
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    const clock = new TestClock();
    return { sql, clock, kernel: new Kernel(sql, clock) };
  };

  it("a command ID reused with a different payload is a conflict", () => {
    const { kernel: k } = kernel();
    expect(k.receipt("c1", "Put", () => 1, { a: 1, b: [1, 2] }).result).toBe(1);
    // Same payload (key order doesn't matter) replays.
    expect(k.receipt("c1", "Put", () => 2, { b: [1, 2], a: 1 })).toEqual({
      result: 1,
      replayed: true,
    });
    expect(() => k.receipt("c1", "Put", () => 3, { a: 2, b: [1, 2] })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    // Without a payload the check is skipped (legacy callers, pre-hash receipts).
    expect(k.receipt("c1", "Put", () => 4).replayed).toBe(true);
  });

  it("prunes old receipts, published outbox rows and finished jobs in bounded batches", () => {
    const { sql, clock, kernel: k } = kernel();
    for (let i = 0; i < 5; i++) {
      k.receipt(`cmd${i}`, "K", () => i, { i });
      k.consume(`evt${i}`, "t", () => i);
    }
    const published = k.outbox("topic", "t", {});
    k.markPublished([published]);
    const pending = k.outbox("topic", "t", {});
    const dead = k.outbox("topic", "t", {});
    k.deadLetterOutbox([dead], "poison");
    k.schedule("job", "done", clock.now(), {});
    k.completeJob(k.job("job", "done")!);
    k.schedule("job", "cancelled", clock.now(), {});
    k.cancelJob("job", "cancelled");
    k.schedule("job", "pending", clock.now(), {});

    expect(k.prune().deleted).toBe(0);
    clock.advance(KERNEL_RETENTION_MS + DAY);
    k.receipt("fresh", "K", () => 0);
    expect(k.prune({ batch: 3 })).toEqual({ deleted: 3 + 3 + 1 + 2, more: true });
    expect(k.prune({ batch: 3 })).toEqual({ deleted: 2 + 2, more: false });

    const count = (table: string) =>
      Number(sql.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    expect(count("command_receipts")).toBe(1);
    expect(count("inbound_receipts")).toBe(0);
    expect(k.pendingOutbox(10).map((e) => e.eventId)).toEqual([pending]);
    expect(k.deadOutbox(10).map((e) => e.eventId)).toEqual([dead]);
    expect(k.job("job", "pending")).toBeDefined();
    expect(count("scheduled_jobs")).toBe(1);
  });

  it("migration 3 backfills inbound receipts with the migration time", () => {
    const storage = new MemoryDurableStorage();
    const sql = new Sql(storage);
    migrate(
      sql,
      "kernel",
      KERNEL_MIGRATIONS.filter((m) => m.version < 3),
    );
    sql.run("INSERT INTO inbound_receipts (event_id, target, result) VALUES ('e', 't', 'null')");
    const before = Date.now();
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    const at = Number(sql.one<{ c: number }>("SELECT created_at AS c FROM inbound_receipts")!.c);
    expect(at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("the mailbox reconcile path (compactChanges) prunes", () => {
    const m = setup();
    applyMailboxCommand(m.store, { _tag: "CreateLabel", commandId: cmd(), name: "x" });
    m.clock.advance(KERNEL_RETENTION_MS + DAY);
    m.store.kernel.compactChanges(10_000);
    expect(
      m.store.ctx.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM command_receipts")!.n,
    ).toBe(0);
  });
});

describe("upload state transitions", () => {
  const upload = () => {
    const m = makeTestMailbox();
    const u = m.store.uploads.reserveUpload({
      filename: "a",
      contentType: "text/plain",
      declaredSize: 10,
    });
    return { m, u };
  };

  it("an aborted upload cannot complete", () => {
    const { m, u } = upload();
    m.store.uploads.abortUpload(u.uploadId);
    expect(() => m.store.uploads.completeUpload(u.uploadId, 10)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(m.store.uploads.upload(u.uploadId)!.state).toBe("aborted");
    // A repeated abort is a no-op.
    expect(() => m.store.uploads.abortUpload(u.uploadId)).not.toThrow();
  });

  it("a completed upload cannot be aborted or re-completed with another size", () => {
    const { m, u } = upload();
    expect(m.store.uploads.completeUpload(u.uploadId, 10).state).toBe("complete");
    expect(m.store.uploads.completeUpload(u.uploadId, 10).state).toBe("complete");
    expect(() => m.store.uploads.completeUpload(u.uploadId, 5)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => m.store.uploads.abortUpload(u.uploadId)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(m.store.uploads.upload(u.uploadId)!.state).toBe("complete");
  });
});

describe("retention batches", () => {
  it("sweepRetention purges a bounded batch and reschedules itself until done", () => {
    const m = setup();
    const n = RETENTION_BATCH + 25;
    const threads = Array.from({ length: n }, (_, i) => m.deliver({ subject: `s${i}` }).threadId);
    m.store.triage.moveToTrash(threads);
    m.clock.advance(31 * DAY);
    expect(m.store.retention.sweepRetention(m.clock.now())).toEqual({
      deleted: RETENTION_BATCH,
      more: true,
    });
    expect(m.store.kernel.job("retention-sweep", "sweep")).toBeDefined();
    expect(m.store.runDueJobs(m.clock.now())).toMatchObject({ ran: 1, failed: [] });
    expect(m.store.views.listView({ view: "trash" }).items).toHaveLength(0);
    expect(m.store.kernel.job("retention-sweep", "sweep")).toBeUndefined();
  });

  it("Empty removes one batch and continues from a job, sparing mail trashed afterwards", () => {
    const m = setup();
    const threads = Array.from(
      { length: RETENTION_BATCH + 10 },
      (_, i) => m.deliver({ subject: `s${i}` }).threadId,
    );
    m.store.triage.moveToTrash(threads);
    const r = applyMailboxCommand(m.store, {
      _tag: "Empty",
      commandId: cmd(),
      disposition: "trash",
    });
    expect(r).toEqual({ deleted: RETENTION_BATCH, more: true });
    m.clock.advance(1000);
    const late = m.deliver({ subject: "late" }).threadId;
    m.store.triage.moveToTrash([late]);
    m.store.runDueJobs(m.clock.now());
    expect(m.store.views.listView({ view: "trash" }).items.map((t) => t.threadId)).toEqual([late]);
  });
});

describe("due jobs are isolated", () => {
  it("a throwing job is retried, then parked as failed; other jobs still run", () => {
    const m = setup();
    const t = m.deliver();
    // A "world-publish" job whose payload makes the handler throw.
    m.store.kernel.schedule("world-publish", "poison", m.clock.now(), null);
    const onDue = m.store.sends.onLegacyWorldPublishDue.bind(m.store.sends);
    m.store.sends.onLegacyWorldPublishDue = (key, payload) => {
      if (key === "poison") throw new Error("boom");
      return onDue(key, payload);
    };
    m.store.triage.bubbleUp(t.threadId, m.clock.now());
    const first = m.store.runDueJobs(m.clock.now());
    expect(first.ran).toBe(1);
    expect(first.failed).toEqual([
      { kind: "world-publish", key: "poison", outcome: "retry", error: "boom" },
    ]);
    // Backed off: not due again immediately.
    expect(m.store.runDueJobs(m.clock.now()).failed).toEqual([]);
    for (let i = 0; i < 5; i++) {
      m.clock.advance(3600_000);
      m.store.runDueJobs(m.clock.now());
    }
    expect(m.store.kernel.job("world-publish", "poison")).toBeUndefined();
    expect(m.store.kernel.failedJobs(10)).toEqual([
      expect.objectContaining({ kind: "world-publish", key: "poison", error: "Error: boom" }),
    ]);
  });
});
