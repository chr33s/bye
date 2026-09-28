import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import { QueuePublisher, type Submission } from "@bye/application";
import {
  Kernel,
  KERNEL_MIGRATIONS,
  makeCloudflarePersonalTransport,
  makeCloudflareTransactionalTransport,
  makeHttpTransport,
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

type KeyPair = { readonly privateKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> };

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

/** An idempotent HTTP provider (exercises the generic HTTP adapter, as the old personal one did). */
const HTTP_CAPABILITIES = {
  name: "http-test",
  trafficClasses: ["personal"],
  maxMessageBytes: 25 * 1024 * 1024,
  maxRecipients: 100,
  maxAttachmentBytes: 25 * 1024 * 1024,
  supportsCalendarMime: true,
  supportsRawMime: true,
  idempotentSubmission: true,
  reconciliation: true,
  exposesWireMessageId: true,
  deliveryEvents: true,
} as const;

const httpTransport = (
  c: { endpoint: string; apiKey: string },
  src: Parameters<typeof makeHttpTransport>[1],
  f: Parameters<typeof makeHttpTransport>[2],
) => makeHttpTransport({ ...c, capabilities: HTTP_CAPABILITIES }, src, f);

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

  it("[E18] HTTP transport: idempotency key, status mapping, wire Message-ID kept separate", async () => {
    const seen: Array<Record<string, string>> = [];
    let status = 200;

    const t = httpTransport(
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

  it("[E18] Cloudflare personal: one send per envelope recipient; partial acceptance is Unknown", async () => {
    const sends: Array<{ to: string; raw: string }> = [];
    let failAt = -1;

    const binding = {
      send: async (m: { from: string; to: string | ReadonlyArray<string>; raw: unknown }) => {
        if (sends.length === failAt) throw new Error("connection reset");
        sends.push({ to: String(m.to), raw: await new Response(m.raw as ReadableStream).text() });

        return { messageId: `cf-${sends.length}` };
      },
    };

    const t = makeCloudflarePersonalTransport(binding, content, null);
    expect(t.capabilities.trafficClasses).toEqual(["personal"]);

    const two = submission({
      trafficClass: "personal",
      envelopeRecipients: ["a@x.test", "b@x.test"],
    });

    expect(await Effect.runPromise(t.submit(two))).toEqual({ providerId: "cf-1,cf-2" });
    expect(sends.map((s) => s.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sends[0]!.raw).toBe("From: me\r\n\r\nhi");
    // First recipient fails: nothing accepted, classified as usual (in-flight reset = Unknown).
    sends.length = 0;
    failAt = 0;
    expect(await failureKind(t.submit(two))).toBe("Unknown");
    // Second fails after the first was accepted: Unknown, never a blind retry.
    sends.length = 0;
    failAt = 1;
    const partial = await Effect.runPromise(Effect.result(t.submit(two)));
    expect(Result.isFailure(partial) && partial.failure.detail).toMatch(/1 of 2/);
    // A router only reaches it when the class is enabled.
    const router = makeTransportRouter([t], new Set(["transactional"]));
    expect(await failureKind(router.submit(two))).toBe("Rejected");
  });

  it("Cloudflare personal: DKIM-signs with the installation key; a bad key is retryable", async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as KeyPair;

    const raws: Array<string> = [];

    const binding = {
      send: async (m: { raw: unknown }) => {
        raws.push(await new Response(m.raw as ReadableStream).text());

        return {};
      },
    };

    const mime = {
      load: async () =>
        "From: Ana <ana@example.org>\r\nTo: b@x.test\r\nSubject: Hi\r\n\r\nhello\r\n",
    };

    const t = makeCloudflarePersonalTransport(binding, mime, async () => ({
      algorithm: "rsa-sha256",
      selector: "bye1",
      key: pair.privateKey,
    }));

    await Effect.runPromise(t.submit(submission({ trafficClass: "personal" })));
    expect(raws[0]).toMatch(
      /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=example\.org; s=bye1;/,
    );

    const broken = makeCloudflarePersonalTransport(binding, mime, async () => {
      throw new Error("bad pem");
    });

    expect(await failureKind(broken.submit(submission({ trafficClass: "personal" })))).toBe(
      "RetryableBeforeAcceptance",
    );
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

    const t = httpTransport(
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
        } as never),
      ),
    );

    expect(Result.isFailure(big)).toBe(true);
  });
});
