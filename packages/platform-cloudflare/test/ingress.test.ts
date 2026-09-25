import { describe, expect, it } from "vitest";
import { IngressJournal, QUARANTINE_RETRY_MS, REPLAY_ATTEMPT_CAP } from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";

const intent = {
  ingestionId: "ing_1",
  mailboxId: "mbx_a",
  recipient: "alice@bye.test",
  envelopeFrom: "bob@example.test",
  objectKey: "t/mbx_a/orig/ing_1.eml",
  rawSize: 1234,
};

describe("ingress journal", () => {
  it("records receipt intent before blob storage and advances forward-only", () => {
    const clock = new TestClock();
    const j = new IngressJournal(new MemoryDurableStorage(), clock);
    expect(j.register(intent).state).toBe("registered");
    expect(j.register({ ...intent, rawSize: 9 }).rawSize).toBe(1234);
    expect(j.markBlobReady("ing_1")).toBe(true);
    expect(j.markEnqueued("ing_1")).toBe(true);
    expect(j.markCommitted("ing_1")).toBe(true);
    expect(j.markBlobReady("ing_1")).toBe(false);
    expect(j.get("ing_1")?.state).toBe("committed");
  });

  it("reconciler republishes blob-ready receipts that never reached a mailbox commit", () => {
    const clock = new TestClock();
    const j = new IngressJournal(new MemoryDurableStorage(), clock);
    j.register(intent);
    j.markBlobReady("ing_1"); // queue publish failed here
    j.register({ ...intent, ingestionId: "ing_2" });
    j.markBlobReady("ing_2");
    j.markEnqueued("ing_2");
    j.markCommitted("ing_2");
    j.register({ ...intent, ingestionId: "ing_3" }); // blob write never finished
    expect(j.pendingReplay(60_000, 10)).toHaveLength(0);
    clock.advance(120_000);
    const replay = j.pendingReplay(60_000, 10);
    expect(replay.map((r) => r.ingestionId)).toEqual(["ing_1"]);
    const message = j.toIngestMessage(replay[0]!);
    expect(message).toMatchObject({
      type: "ingest",
      eventId: "ingest:ing_1",
      objectKey: intent.objectKey,
    });
    expect(JSON.stringify(message).length).toBeLessThan(1024);
    expect(j.abandonStale(60_000)).toBe(1);
    expect(j.get("ing_3")?.state).toBe("abandoned");
    j.markEnqueued("ing_1");
    j.markCommitted("ing_1");
    expect(j.pruneCommitted(0)).toBe(3);
  });

  it("a rejected receipt is terminal: never replayed, never committed, pruned with the rest", () => {
    const clock = new TestClock();
    const j = new IngressJournal(new MemoryDurableStorage(), clock);
    j.register(intent);
    j.markBlobReady("ing_1");
    j.markEnqueued("ing_1");
    expect(j.markRejected("ing_1")).toBe(true);
    expect(j.markRejected("ing_1")).toBe(true); // repeat is an idempotent no-op
    expect(j.markRejected("ing_missing")).toBe(false);
    // Neither a late commit nor an earlier state can overwrite the rejection.
    expect(j.markCommitted("ing_1")).toBe(false);
    expect(j.markEnqueued("ing_1")).toBe(false);
    expect(j.get("ing_1")?.state).toBe("rejected");
    // The reverse also holds: a committed receipt cannot be rejected.
    j.register({ ...intent, ingestionId: "ing_2" });
    j.markCommitted("ing_2");
    expect(j.markRejected("ing_2")).toBe(false);
    expect(j.get("ing_2")?.state).toBe("committed");
    clock.advance(120_000);
    expect(j.pendingReplay(60_000, 10)).toEqual([]);
    expect(j.pruneCommitted(60_000)).toBe(2);
    expect(j.get("ing_1")).toBeUndefined();
  });

  it("exhausted receipts whose quarantine failed are parked, retried slowly and never pruned", () => {
    const clock = new TestClock();
    const j = new IngressJournal(new MemoryDurableStorage(), clock);
    j.register(intent);
    j.markBlobReady("ing_1");
    j.markEnqueued("ing_1");
    for (let n = 1; n < REPLAY_ATTEMPT_CAP; n++) j.touchRepublished("ing_1");
    const row = j.get("ing_1")!;
    expect(row.publishAttempts).toBe(REPLAY_ATTEMPT_CAP);
    expect(IngressJournal.exhausted(row)).toBe(true);
    // Transient quarantine failure: parked, not rejected.
    expect(j.markQuarantineFailed("ing_1")).toBe(true);
    expect(j.get("ing_1")?.state).toBe("quarantine-failed");
    expect(IngressJournal.exhausted(j.get("ing_1")!)).toBe(true);
    // Not due again on the normal replay cadence…
    clock.advance(20 * 60_000);
    expect(j.pendingReplay(10 * 60_000, 10)).toEqual([]);
    // …and never pruned, however old.
    expect(j.pruneCommitted(0)).toBe(0);
    clock.advance(QUARANTINE_RETRY_MS);
    expect(j.pendingReplay(10 * 60_000, 10).map((r) => r.ingestionId)).toEqual(["ing_1"]);
    // A later successful quarantine commits it.
    expect(j.markCommitted("ing_1")).toBe(true);
    expect(j.get("ing_1")?.state).toBe("committed");
    expect(j.markQuarantineFailed("ing_1")).toBe(false);
  });
});
