import { describe, expect, it } from "vitest";
import { calZonedToInstant, calZonedToInstantDetailed } from "@bye/calendar-engine";
import {
  applyMailboxCommand,
  authorizeSearchResults,
  type MailboxUpload,
  type SearchCandidate,
} from "@bye/platform-cloudflare";
import {
  cmd,
  deliveryFixture,
  makeTestMailbox,
  makeTestSearchShard,
  openTestMailbox,
  summaryFixture,
} from "@bye/testing";

// §13 adversarial suites against the mailbox authority: interrupted multipart uploads, Durable
// Object eviction mid-flow (a fresh instance over the same storage), DST around deferred jobs,
// export paging under concurrent ingest, and search shard migration.

const evict = (m: ReturnType<typeof makeTestMailbox>) =>
  openTestMailbox(m.storage, m.mailboxId, m.clock);

describe("interrupted multipart upload", () => {
  it("parts after abort are rejected, the blob is queued for GC, and quota is released", () => {
    const m = makeTestMailbox();
    m.store.uploads.setQuota(10_000);
    const base = m.store.uploads.quota().usedBytes;

    const u = m.store.uploads.reserveUpload({
      filename: "a.bin",
      contentType: "application/octet-stream",
      declaredSize: 8000,
    });

    m.store.uploads.recordUploadPart(u.uploadId, 1, 4000, "e1");
    expect(m.store.uploads.quota().usedBytes).toBe(base + 8000);
    m.store.uploads.abortUpload(u.uploadId);
    expect(() => m.store.uploads.recordUploadPart(u.uploadId, 2, 4000, "e2")).toThrow(/closed/);
    expect(m.store.uploads.quota().usedBytes).toBe(base);
    expect(
      m.store.kernel
        .pendingOutbox(100)
        .some((e) => e.topic === "blob-gc" && (e.payload as { key: string }).key === u.blobKey),
    ).toBe(true);
    // Reservation after abort succeeds because the aborted bytes no longer count.
    expect(() =>
      m.store.uploads.reserveUpload({
        filename: "b.bin",
        contentType: "application/octet-stream",
        declaredSize: 9000,
      }),
    ).not.toThrow();
  });

  it("a retried part replaces rather than double-counts; parts exceeding the declaration fail the upload", () => {
    const m = makeTestMailbox();

    const u = m.store.uploads.reserveUpload({
      filename: "a",
      contentType: "text/plain",
      declaredSize: 100,
    });

    m.store.uploads.recordUploadPart(u.uploadId, 1, 60, "e1");
    m.store.uploads.recordUploadPart(u.uploadId, 1, 60, "e1-retry");
    m.store.uploads.recordUploadPart(u.uploadId, 2, 40, "e2");
    expect(m.store.uploads.upload(u.uploadId)!.state).toBe("uploading");
    m.store.uploads.recordUploadPart(u.uploadId, 3, 1, "e3");
    expect(m.store.uploads.upload(u.uploadId)!.state).toBe("failed");
    // A failed upload can never be completed into a sendable attachment.
    expect(m.store.uploads.completeUpload(u.uploadId, 100).state).toBe("failed");
  });

  it("completion survives eviction between the last part and complete; replayed complete is idempotent", () => {
    const m = makeTestMailbox();

    const u = m.store.uploads.reserveUpload({
      filename: "a",
      contentType: "text/plain",
      declaredSize: 100,
    });

    m.store.uploads.recordUploadPart(u.uploadId, 1, 100, "e1");
    const fresh = evict(m);
    const id = cmd();

    const complete = () =>
      applyMailboxCommand(fresh, {
        _tag: "CompleteUpload",
        commandId: id,
        uploadId: u.uploadId,
        actualSize: 100,
      }) as MailboxUpload;

    expect(complete().state).toBe("complete");
    expect(complete().state).toBe("complete");
    expect(fresh.kernel.pendingOutbox(100).filter((e) => e.topic === "scan")).toHaveLength(1);
  });

  it("unknown upload ids are not found (no probing another mailbox's uploads)", () => {
    const a = makeTestMailbox("mbx_a");
    const b = makeTestMailbox("mbx_b");

    const u = a.store.uploads.reserveUpload({
      filename: "x",
      contentType: "text/plain",
      declaredSize: 10,
    });

    expect(() => b.store.uploads.recordUploadPart(u.uploadId, 1, 10, "e")).toThrow(/upload/);
    expect(() => b.store.uploads.completeUpload(u.uploadId, 10)).toThrow(/upload/);
    expect(u.blobKey.startsWith("t/mbx_a/")).toBe(true);
  });
});

describe("Durable Object eviction mid-flow", () => {
  it("scheduled sends, bubbles and idempotency records survive a fresh instance over the same storage", () => {
    const m = makeTestMailbox();
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    m.clock.advance(1000);
    const d = m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture({})));
    const at = m.clock.now() + 3_600_000;
    const bubbleCmd = cmd();

    const bubble = (store: typeof m.store) =>
      applyMailboxCommand(store, {
        _tag: "BubbleUp",
        commandId: bubbleCmd,
        threadId: d.threadId,
        at,
      }) as { generation: number };

    const { generation } = bubble(m.store);

    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [{ name: undefined, address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "x",
        attachments: [],
      },
    });

    const sendCmd = cmd();

    const send = (store: typeof m.store) =>
      applyMailboxCommand(store, {
        _tag: "Send",
        commandId: sendCmd,
        draftId,
        expectedRevision: 1,
        sendAt: at,
      });

    const sent = send(m.store) as { _tag: string };
    expect(sent._tag).toBe("Queued");

    const fresh = evict(m);
    // Replaying the same commands against the new instance returns the recorded results.
    expect(bubble(fresh).generation).toBe(generation);
    expect(send(fresh)).toEqual(sent);
    expect(fresh.kernel.nextDueAt()).toBe(at);
    m.clock.advance(3_600_000);
    const ran = fresh.runDueJobs(m.clock.now());
    expect(ran.ran).toBe(2);
    expect(fresh.views.getThread(d.threadId).thread.attention.bubble._tag).toBe("None");
    // The evicted instance cannot re-run a job the fresh one completed.
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
  });

  it("the ingestion receipt survives eviction: a replay on a fresh instance adds no rows or events", () => {
    const m = makeTestMailbox();
    m.clock.advance(1000);
    const input = deliveryFixture(m.clock, summaryFixture({ fromAddress: "x@example.com" }));
    const first = m.store.ingest.commitDelivery(input);
    const outboxBefore = m.store.kernel.pendingOutbox(100).length;
    const seqBefore = m.store.kernel.currentSeq();
    const fresh = evict(m);
    const again = fresh.ingest.commitDelivery(input);
    expect(again).toMatchObject({
      replayed: true,
      deliveryId: first.deliveryId,
      threadId: first.threadId,
    });
    // Nothing was re-written on the new instance: no change-feed entries, no outbox fan-out.
    expect(fresh.kernel.currentSeq()).toBe(seqBefore);
    expect(fresh.kernel.pendingOutbox(100)).toHaveLength(outboxBefore);
  });
});

describe("DST and deferred jobs", () => {
  const zone = "America/New_York";

  it("a 'tomorrow 09:00 local' bubble set across spring-forward fires at the absolute instant", () => {
    const m = makeTestMailbox();
    // Saturday 2026-03-07 12:00 local (EST, UTC-5); DST starts 2026-03-08 02:00.
    m.clock.current = calZonedToInstant(
      { year: 2026, month: 3, day: 7, hour: 12, minute: 0, second: 0 },
      zone,
    );
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    const d = m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture({})));

    const at = calZonedToInstant(
      { year: 2026, month: 3, day: 8, hour: 9, minute: 0, second: 0 },
      zone,
    );

    expect(at - m.clock.now()).toBe(20 * 3_600_000); // 21 wall-clock hours, one skipped.
    m.store.triage.bubbleUp(d.threadId, at);
    m.clock.current = at - 1;
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
    m.clock.current = at;
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(1);
  });

  it("send-later inside the fall-back fold fires once, at the earlier instant", () => {
    const m = makeTestMailbox();
    const local = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 };
    const resolved = calZonedToInstantDetailed(local, zone);
    expect(resolved.resolution).toBe("fold-earlier");
    m.clock.current = resolved.instant - 86_400_000;

    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [{ name: undefined, address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "x",
        attachments: [],
      },
    });

    m.store.sends.send(draftId, { expectedRevision: 1, sendAt: resolved.instant });
    m.clock.current = resolved.instant;
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(1);
    m.clock.current = resolved.instant + 3_600_000; // the second 01:30
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
  });

  it("a wall time in the spring-forward gap is shifted, never dropped", () => {
    const r = calZonedToInstantDetailed(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      zone,
    );

    expect(r.resolution).toBe("gap-shifted");
    expect(Number.isFinite(r.instant)).toBe(true);
  });

  it("quiet hours follow the zone's wall clock across the transition", () => {
    const m = makeTestMailbox();
    const settings = m.store.automation.notificationSettings();
    m.store.automation.setNotificationSettings({
      ...settings,
      quietHours: { start: "22:00", end: "07:00", timeZone: zone },
    });

    const at = (day: number, hour: number) =>
      calZonedToInstant({ year: 2026, month: 3, day, hour, minute: 0, second: 0 }, zone);

    expect(m.store.automation.inQuietHours(at(7, 23))).toBe(true);
    expect(m.store.automation.inQuietHours(at(8, 6))).toBe(true);
    expect(m.store.automation.inQuietHours(at(8, 7))).toBe(false);
  });
});

describe("export under concurrent ingest", () => {
  it("every delivery present at export start appears exactly once across pages while mail keeps arriving", () => {
    const m = makeTestMailbox();

    const deliver = () => {
      m.clock.advance(1000);

      return m.store.ingest.commitDelivery(
        deliveryFixture(m.clock, summaryFixture({ fromAddress: "x@example.com" })),
      );
    };

    for (let i = 0; i < 450; i++) deliver();

    const initial = new Set(
      m.store.retention.exportManifestPage(null, 1000).deliveries.map((d) => d.deliveryId),
    );

    expect(initial.size).toBe(450);
    const seen: Array<string> = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = m.store.retention.exportManifestPage(cursor, 200);
      seen.push(...page.deliveries.map((d) => d.deliveryId));
      cursor = page.nextCursor;

      // Ingest between pages (the Workflow checkpoints each page in its own step).
      for (let i = 0; i < 30; i++) deliver();
      pages++;
    } while (cursor && pages < 50);

    expect(new Set(seen).size).toBe(seen.length);

    for (const id of initial) expect(seen).toContain(id);
  });

  it("deliveries removed between pages do not shift the cursor or break later pages", () => {
    const m = makeTestMailbox();
    m.store.screener.screen([{ sender: "x@example.com", decision: "allow" }]);
    const ids: Array<string> = [];

    for (let i = 0; i < 250; i++) {
      m.clock.advance(1000);
      m.store.ingest.commitDelivery(
        deliveryFixture(m.clock, summaryFixture({ fromAddress: "x@example.com" })),
      );
    }

    for (const d of m.store.retention.exportManifestPage(null, 1000).deliveries)
      ids.push(d.deliveryId);
    const first = m.store.retention.exportManifestPage(null, 200);

    // Move away one delivery from the already-exported page and one from the next page.
    for (const id of [ids[10]!, ids[220]!])
      m.store.transfers.redeliver({
        deliveryId: id,
        targetMailboxId: "mbx_other",
        mode: "move",
        summary: m.store.ingest.deliverySummary(id),
      });
    const second = m.store.retention.exportManifestPage(first.nextCursor, 200);
    expect(second.deliveries.map((d) => d.deliveryId)).toEqual(
      ids.slice(200).filter((id) => id !== ids[220]),
    );
    expect(second.nextCursor).toBeNull();
  });
});

describe("search shard migration", () => {
  const doc = (docId: string, version: number, date: number, body: string) => ({
    docId,
    kind: "delivery",
    refId: docId,
    version,
    threadId: `thr_${docId}`,
    date,
    subject: "s",
    body,
  });

  it("a document copied to a new shard is returned once, and stale shards cannot resurrect a deletion", async () => {
    const old = makeTestSearchShard();
    const next = makeTestSearchShard();
    old.upsert(doc("d1", 1, 1000, "migrating kumquat"));
    old.upsert(doc("d2", 1, 2000, "stays kumquat"));
    // Migration copies d1 forward, then d1 is deleted on the new shard only.
    next.upsert(doc("d1", 1, 1000, "migrating kumquat"));
    old.setWatermark(10);
    next.setWatermark(7);
    const pages = [old.candidates("kumquat"), next.candidates("kumquat")];
    const authoritative = new Set(["d1", "d2"]);

    const hydrate = async (cs: ReadonlyArray<SearchCandidate>) =>
      cs.map((c) => (authoritative.has(c.refId) ? c.refId : undefined));

    const merged = await authorizeSearchResults(pages, hydrate, 50);
    expect(merged.results).toEqual(["d2", "d1"]);
    expect(merged.watermark).toBe(7);

    next.remove("d1", 2);
    authoritative.delete("d1");

    // The old shard still has d1 (migration not yet cleaned); rehydration drops it.
    const after = await authorizeSearchResults(
      [old.candidates("kumquat"), next.candidates("kumquat")],
      hydrate,
      50,
    );

    expect(after.results).toEqual(["d2"]);
    // A late, older index event replayed onto the new shard is stale after the tombstone.
    expect(next.upsert(doc("d1", 1, 1000, "migrating kumquat"))).toBe("stale");
    expect(next.candidates("kumquat").candidates).toHaveLength(0);
  });

  it("merge order is stable across shards regardless of which shard answers first", async () => {
    const a = makeTestSearchShard();
    const b = makeTestSearchShard();

    for (let i = 0; i < 20; i++)
      (i % 2 ? a : b).upsert(doc(`d${String(i).padStart(2, "0")}`, 1, 1000 + (i % 5), "fig"));
    const hydrate = async (cs: ReadonlyArray<SearchCandidate>) => cs.map((c) => c.docId);

    const ab = await authorizeSearchResults(
      [a.candidates("fig"), b.candidates("fig")],
      hydrate,
      10,
    );

    const ba = await authorizeSearchResults(
      [b.candidates("fig"), a.candidates("fig")],
      hydrate,
      10,
    );

    expect(ab.results).toEqual(ba.results);
  });
});
