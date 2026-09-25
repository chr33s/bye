import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import { QueuePublisher, type Submission } from "@bye/application";
import {
  Kernel,
  KERNEL_MIGRATIONS,
  makeCloudflareTransactionalTransport,
  makePersonalMailTransport,
  makeQueuePublisher,
  makeR2BlobStore,
  makeTransportRouter,
  migrate,
  type QueueBindingLike,
  type R2BucketLike,
  relayOutbox,
  Sql,
} from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";

const submission = (over: Partial<Submission> = {}): Submission => ({
  sendJobId: "snd_1",
  identityId: "idn_1",
  from: "me@bye.test",
  contentKey: "t/x/out/snd_1.eml",
  envelopeRecipients: ["a@x.test"],
  trafficClass: "transactional",
  bytes: 1000,
  ...over,
});

const content = { load: async () => "From: me\r\n\r\nhi" };
const failureKind = async (e: Effect.Effect<unknown, { kind: string }>) => {
  const r = await Effect.runPromise(Effect.result(e));
  return Result.isFailure(r) ? r.failure.kind : "accepted";
};

describe("transport adapters (§5.3)", () => {
  it("[E18] Cloudflare transactional: limits enforced before I/O; in-flight timeouts are Unknown", async () => {
    let sent = 0;
    const ok = makeCloudflareTransactionalTransport(
      { send: async () => (sent++, { messageId: "cf-123" }) },
      content,
    );
    const router = makeTransportRouter([ok]);
    expect(await Effect.runPromise(router.submit(submission()))).toEqual({ providerId: "cf-123" });
    expect(await failureKind(router.submit(submission({ bytes: 6 * 1024 * 1024 })))).toBe(
      "Rejected",
    );
    expect(
      await failureKind(
        router.submit(
          submission({ envelopeRecipients: Array.from({ length: 51 }, (_, i) => `r${i}@x.test`) }),
        ),
      ),
    ).toBe("Rejected");
    // Personal mail through a transactional-only provider is refused, not silently sent.
    expect(await failureKind(router.submit(submission({ trafficClass: "personal" })))).toBe(
      "Rejected",
    );
    expect(sent).toBe(1);
    const timeout = makeCloudflareTransactionalTransport(
      {
        send: async () => {
          throw new Error("network timeout");
        },
      },
      content,
    );
    expect(await failureKind(timeout.submit(submission()))).toBe("Unknown");
    const denied = makeCloudflareTransactionalTransport(
      {
        send: async () => {
          throw new Error("destination address not verified");
        },
      },
      content,
    );
    expect(await failureKind(denied.submit(submission()))).toBe("Rejected");
    const missing = makeCloudflareTransactionalTransport(
      { send: async () => ({}) },
      { load: async () => null },
    );
    expect(await failureKind(missing.submit(submission()))).toBe("RetryableBeforeAcceptance");
  });

  it("[E18] HTTP personal transport: idempotency key, status mapping, wire Message-ID kept separate", async () => {
    const seen: Array<Record<string, string>> = [];
    let status = 200;
    const t = makePersonalMailTransport(
      { endpoint: "https://mail.example/send", apiKey: "k" },
      content,
      async (_u, init) => {
        seen.push(init.headers);
        return {
          status,
          json: async () => ({ id: "prov-1", messageId: "<wire@prov>" }),
          text: async () => "",
        };
      },
    );
    expect(await Effect.runPromise(t.submit(submission({ trafficClass: "personal" })))).toEqual({
      providerId: "prov-1",
      wireMessageId: "<wire@prov>",
    });
    expect(seen[0]!["idempotency-key"]).toBe("snd_1");
    status = 550 - 128;
    expect(await failureKind(t.submit(submission({ trafficClass: "personal" })))).toBe("Rejected");
    status = 503;
    expect(await failureKind(t.submit(submission({ trafficClass: "personal" })))).toBe(
      "RetryableBeforeAcceptance",
    );
  });

  it("Cloudflare transactional: rate/quota/temporary errors retry before the permanent patterns", async () => {
    for (const message of [
      "rate limit exceeded",
      "daily sending quota reached",
      "temporary failure, try again later",
    ]) {
      const t = makeCloudflareTransactionalTransport(
        {
          send: async () => {
            throw new Error(message);
          },
        },
        content,
      );
      expect(await failureKind(t.submit(submission())), message).toBe("RetryableBeforeAcceptance");
    }
  });

  it("HTTP transport sends raw MIME bytes base64-encoded, never through a text decoder", async () => {
    // 8-bit latin1 body: 0xE9 is not valid UTF-8 on its own and would become U+FFFD if decoded.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("From: me\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf"),
      0xe9,
      0x0d,
      0x0a,
    ]);
    const bodies: Array<{ raw: string; rawEncoding: string }> = [];
    const t = makePersonalMailTransport(
      { endpoint: "https://mail.example/send", apiKey: "k" },
      { load: async () => new Response(bytes).body! },
      async (_u, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return { status: 202, json: async () => ({ id: "p" }), text: async () => "" };
      },
    );
    await Effect.runPromise(t.submit(submission({ trafficClass: "personal" })));
    expect(bodies[0]!.rawEncoding).toBe("base64");
    expect(Uint8Array.from(atob(bodies[0]!.raw), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});

describe("R2 blob store and queue relay", () => {
  it("R2 adapter maps content type to httpMetadata and binding failures to BlobStoreFailure", async () => {
    const puts: Array<{ key: string; options: unknown }> = [];
    let refuse = false;
    const bucket: R2BucketLike = {
      put: async (key, _value, options) => {
        puts.push({ key, options });
        return refuse ? null : { key, size: 3 };
      },
      get: async (key) => ({
        key,
        size: 3,
        httpMetadata: { contentType: "message/rfc822" },
        body: new Response("abc").body!,
        arrayBuffer: async () => new TextEncoder().encode("abc").buffer as ArrayBuffer,
      }),
      head: async () => null,
      delete: async () => {
        throw new Error("r2 down");
      },
    };
    const blobs = makeR2BlobStore(bucket);
    expect(
      await Effect.runPromise(blobs.put("t/a/1.eml", "abc", { contentType: "message/rfc822" })),
    ).toEqual({ key: "t/a/1.eml", size: 3 });
    await Effect.runPromise(blobs.put("t/a/2.bin", "abc"));
    expect(puts).toEqual([
      { key: "t/a/1.eml", options: { httpMetadata: { contentType: "message/rfc822" } } },
      { key: "t/a/2.bin", options: undefined },
    ]);
    const got = await Effect.runPromise(blobs.get("t/a/1.eml"));
    expect(got).toMatchObject({ key: "t/a/1.eml", size: 3, contentType: "message/rfc822" });
    expect(new TextDecoder().decode(await got!.bytes())).toBe("abc");
    expect(await Effect.runPromise(blobs.head("t/a/missing"))).toBeNull();
    refuse = true;
    const refused = await Effect.runPromise(Effect.result(blobs.put("t/a/3.eml", "abc")));
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      _tag: "BlobStoreFailure",
      op: "put",
      detail: "t/a/3.eml: precondition failed",
    });
    const failed = await Effect.runPromise(Effect.result(blobs.delete("t/a/1.eml")));
    expect(Result.isFailure(failed) && failed.failure).toMatchObject({
      _tag: "BlobStoreFailure",
      op: "delete",
      detail: "t/a/1.eml: r2 down",
    });
  });

  it("outbox rows are marked published only after the queue accepts; failures stay pending for replay", async () => {
    const storage = new MemoryDurableStorage();
    const sql = new Sql(storage);
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    const kernel = new Kernel(sql, new TestClock());
    kernel.outbox("dispatch", "mbx_1", { sendJobId: "snd_1" });
    kernel.outbox("index", "mbx_1", { op: "upsert", kind: "delivery", id: "dlv_1" });
    kernel.outbox("propagate", "mbx_2", { topic: "mailbox.redeliver" });
    const sent: Record<string, Array<unknown>> = {};
    let failIndex = true;
    const binding = (name: string): QueueBindingLike => ({
      send: async (b) => void (sent[name] ??= []).push(b),
      sendBatch: async (msgs) => {
        if (name === "index" && failIndex) throw new Error("queue unavailable");
        for (const m of msgs) (sent[name] ??= []).push(m.body);
      },
    });
    const layer = Layer.succeed(
      QueuePublisher,
      makeQueuePublisher({
        dispatch: binding("dispatch"),
        index: binding("index"),
        propagate: binding("propagate"),
      }),
    );
    const first = await Effect.runPromise(relayOutbox(kernel, "mbx_1").pipe(Effect.provide(layer)));
    expect(first).toEqual({ published: 2, pending: 3, dead: 0 });
    expect(kernel.pendingOutbox(10).map((e) => e.topic)).toEqual(["index"]);
    expect(sent.dispatch).toEqual([
      {
        schemaVersion: 1,
        type: "dispatch",
        eventId: expect.any(String),
        mailboxId: "mbx_1",
        sendJobId: "snd_1",
      },
    ]);
    failIndex = false;
    await Effect.runPromise(relayOutbox(kernel, "mbx_1").pipe(Effect.provide(layer)));
    expect(kernel.pendingOutbox(10)).toHaveLength(0);
    expect(sent.index).toHaveLength(1);
    const big = await Effect.runPromise(
      Effect.result(
        makeQueuePublisher({ index: binding("index") }).send("index", {
          x: "y".repeat(130 * 1024),
        }),
      ),
    );
    expect(Result.isFailure(big)).toBe(true);
  });
});
