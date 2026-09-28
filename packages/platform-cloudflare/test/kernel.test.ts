import { describe, expect, it } from "vitest";
import { Kernel, KERNEL_MIGRATIONS, migrate, Sql } from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";

const setup = () => {
  const storage = new MemoryDurableStorage();
  const sql = new Sql(storage);
  migrate(sql, "kernel", KERNEL_MIGRATIONS);
  const clock = new TestClock();

  return { storage, sql, clock, kernel: new Kernel(sql, clock) };
};

describe("durable kernel", () => {
  it("replays command receipts without re-running the mutation", () => {
    const { kernel, sql } = setup();
    let runs = 0;
    const first = sql.tx(() => kernel.receipt("cmd_1", "Test", () => ++runs));
    const second = sql.tx(() => kernel.receipt("cmd_1", "Test", () => ++runs));
    expect(first).toEqual({ result: 1, replayed: false });
    expect(second).toEqual({ result: 1, replayed: true });
    expect(runs).toBe(1);
  });

  it("rolls back receipt, change and outbox together on failure", () => {
    const { kernel, sql } = setup();
    expect(() =>
      sql.tx(() =>
        kernel.receipt("cmd_2", "Test", () => {
          kernel.change("r", "k", {});
          kernel.outbox("t", "x", {});
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
    expect(kernel.currentSeq()).toBe(0);
    expect(kernel.pendingOutbox(10)).toHaveLength(0);
    expect(sql.tx(() => kernel.receipt("cmd_2", "Test", () => "ok")).replayed).toBe(false);
  });

  it("stale job generations cannot complete after reschedule or cancel", () => {
    const { kernel, clock } = setup();
    const g1 = kernel.schedule("bubble", "thr_1", clock.now() + 10, {});
    const g2 = kernel.schedule("bubble", "thr_1", clock.now() + 20, {});
    expect(g2).toBe(g1 + 1);
    clock.advance(100);
    const [due] = kernel.dueJobs(clock.now(), 10);
    expect(due?.generation).toBe(g2);
    expect(kernel.completeJob({ kind: "bubble", key: "thr_1", generation: g1 })).toBe(false);
    expect(kernel.completeJob(due!)).toBe(true);
    kernel.schedule("bubble", "thr_2", clock.now(), {});
    const stale = kernel.dueJobs(clock.now(), 10)[0]!;
    kernel.cancelJob("bubble", "thr_2");
    expect(kernel.completeJob(stale)).toBe(false);
    expect(kernel.nextDueAt()).toBeNull();
  });

  it("deduplicates consumed events per target and reports change cursors", () => {
    const { kernel, sql } = setup();
    sql.tx(() =>
      kernel.consume("evt_1", "mbx_a", () => kernel.change("thread", "created", { id: 1 })),
    );

    const again = sql.tx(() =>
      kernel.consume("evt_1", "mbx_a", () => kernel.change("thread", "created", { id: 2 })),
    );

    expect(again.replayed).toBe(true);
    const page = kernel.changesSince(0, 10);
    expect(page.changes).toHaveLength(1);
    expect(page.cursor).toBe(1);

    for (let i = 0; i < 5; i++) kernel.change("x", "y", i);
    kernel.compactChanges(2);
    expect(kernel.changesSince(1, 10).expired).toBe(true);
  });

  it("a refused publish keeps the event pending (attempts counted); only acknowledgement clears it", () => {
    const { kernel } = setup();
    const id = kernel.outbox("index", "mbx_a", { a: 1 });
    kernel.markPublishFailed([id]);
    kernel.markPublishFailed([id]);
    expect(kernel.pendingOutbox(10).map((e) => e.eventId)).toEqual([id]);
    expect(kernel.outboxAttempts([id]).get(id)).toBe(2);
    kernel.markPublished([id]);
    expect(kernel.pendingOutbox(10)).toHaveLength(0);
  });

  it("dead-lettered rows are skipped by pendingOutbox until re-armed", () => {
    const { kernel, clock } = setup();
    const dead = kernel.outbox("index", "mbx_a", { a: 1 });
    const live = kernel.outbox("index", "mbx_b", { b: 2 });
    kernel.deadLetterOutbox([dead], "poison");
    expect(kernel.pendingOutbox(10).map((e) => e.eventId)).toEqual([live]);
    expect(kernel.deadOutbox(10)).toEqual([
      expect.objectContaining({ eventId: dead, reason: "poison", deadAt: clock.now() }),
    ]);
    expect(kernel.rearmOutbox(dead)).toBe(true);
    expect(
      kernel
        .pendingOutbox(10)
        .map((e) => e.eventId)
        .sort(),
    ).toEqual([dead, live].sort());
    expect(kernel.deadOutbox(10)).toHaveLength(0);
  });
});
