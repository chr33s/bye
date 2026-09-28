import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  chunkByBytes,
  Kernel,
  KERNEL_MIGRATIONS,
  migrate,
  OUTBOX_MAX_ATTEMPTS,
  QueuePublisherLive,
  relayOutbox,
  Sql,
} from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";

const setup = () => {
  const sql = new Sql(new MemoryDurableStorage());
  migrate(sql, "kernel", KERNEL_MIGRATIONS);

  return new Kernel(sql, new TestClock());
};

const fakeQueue = (fail: (bodies: ReadonlyArray<unknown>) => boolean = () => false) => {
  const sent: Array<Array<unknown>> = [];

  return {
    sent,
    binding: {
      send: async () => undefined,
      sendBatch: async (batch: Iterable<{ body: unknown }>) => {
        const bodies = [...batch].map((b) => b.body);

        if (fail(bodies)) throw new Error("refused");
        sent.push(bodies);
      },
    },
  };
};

describe("outbox relay poison isolation (§6)", () => {
  it("[E18] oversize rows are dead-lettered locally and do not block later rows", async () => {
    const kernel = setup();
    const big = kernel.outbox("propagate-x", "mbx_a", { blob: "x".repeat(200 * 1024) });
    const small = kernel.outbox("propagate-x", "mbx_a", { ok: true });
    const q = fakeQueue();

    const result = await Effect.runPromise(
      relayOutbox(kernel, "mailbox:mbx_a").pipe(
        Effect.provide(QueuePublisherLive({ propagate: q.binding })),
      ),
    );

    expect(result).toMatchObject({ published: 1, dead: 1 });
    expect(kernel.pendingOutbox(10)).toHaveLength(0);
    expect(kernel.deadOutbox(10).map((d) => d.eventId)).toEqual([big]);
    expect(kernel.deadOutbox(10)[0]!.reason).toMatch(/oversize/);
    expect(q.sent.flat()).toHaveLength(1);
    void small;
  });

  it("[E18] oversize rows are sent by reference when an offloader is configured", async () => {
    const kernel = setup();
    kernel.outbox("propagate-x", "mbx_a", { blob: "x".repeat(200 * 1024) });
    const q = fakeQueue();
    const stored: Array<string> = [];
    await Effect.runPromise(
      relayOutbox(kernel, "mailbox:mbx_a", 100, {
        offload: async (eventId) => (
          stored.push(eventId),
          { schemaVersion: 1, type: "ref", key: `q/${eventId}.json` }
        ),
      }).pipe(Effect.provide(QueuePublisherLive({ propagate: q.binding }))),
    );
    expect(stored).toHaveLength(1);
    expect(q.sent[0]![0]).toMatchObject({ type: "ref" });
    expect(kernel.deadOutbox(10)).toHaveLength(0);
  });

  it("[E18] a row the queue keeps refusing is isolated after the attempt budget", async () => {
    const kernel = setup();
    kernel.outbox("propagate-x", "mbx_a", { n: 1 });
    const q = fakeQueue(() => true);

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++)
      await Effect.runPromise(
        relayOutbox(kernel, "mailbox:mbx_a").pipe(
          Effect.provide(QueuePublisherLive({ propagate: q.binding })),
        ),
      );
    expect(kernel.pendingOutbox(10)).toHaveLength(0);
    expect(kernel.deadOutbox(10)).toHaveLength(1);
    expect(kernel.hasPendingOutbox()).toBe(false);
    expect(kernel.rearmOutbox(kernel.deadOutbox(10)[0]!.eventId)).toBe(true);
    expect(kernel.pendingOutbox(10)).toHaveLength(1);
  });

  it("[E18] batches respect both the 100-message and 256 KB limits", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ item: i, bytes: 2_000 }));
    expect(chunkByBytes(items).map((c) => c.length)).toEqual([100, 100, 50]);
    const heavy = Array.from({ length: 10 }, (_, i) => ({ item: i, bytes: 100 * 1024 }));
    expect(chunkByBytes(heavy).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it('[§6] a dispatch/index/notify row with a missing field is dead-lettered, never sent as "undefined"', async () => {
    const kernel = setup();
    const bad = kernel.outbox("dispatch", "mbx_a", {});
    const badIndex = kernel.outbox("index", "mbx_a", { kind: "delivery" });
    const good = kernel.outbox("dispatch", "mbx_a", { sendJobId: "snd_1" });
    const q = fakeQueue();

    const result = await Effect.runPromise(
      relayOutbox(kernel, "mailbox:mbx_a").pipe(
        Effect.provide(QueuePublisherLive({ dispatch: q.binding, index: q.binding })),
      ),
    );

    expect(result).toMatchObject({ published: 1, dead: 2 });
    expect(
      kernel
        .deadOutbox(10)
        .map((d) => d.eventId)
        .sort(),
    ).toEqual([bad, badIndex].sort());
    expect(kernel.deadOutbox(10)[0]!.reason).toMatch(/payload invalid/);
    expect(JSON.stringify(q.sent)).not.toContain("undefined");
    expect(q.sent.flat()).toEqual([
      { schemaVersion: 1, type: "dispatch", eventId: good, mailboxId: "mbx_a", sendJobId: "snd_1" },
    ]);
  });
});
