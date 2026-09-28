import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeServerSocket, HarnessState, MemoryR2, makeHarness } from "./harness.ts";

// The Node harness stands in for Cloudflare bindings in most MailCore tests; these pin the
// runtime semantics it claims to emulate so a harness regression can't silently weaken them.

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

describe("harness fidelity", () => {
  it("waitUntil rejections fail settle() instead of being swallowed", async () => {
    const h = makeHarness();
    const state = h.namespaces.MAILBOXES.state("mbx_x");
    state.waitUntil(Promise.resolve("fine"));
    state.waitUntil(Promise.reject(new Error("background boom")));
    await expect(h.settle()).rejects.toThrow("background boom");
    // Reported once; the next settle is clean.
    await expect(h.settle()).resolves.toBeUndefined();
  });

  it("hibernatable sockets keep their tags and getWebSockets(tag) filters by them", () => {
    const state = new HarnessState({ name: "x" });
    const a = new FakeServerSocket();
    const b = new FakeServerSocket();
    const c = new FakeServerSocket();
    state.acceptWebSocket(a, ["cred:ses_a"]);
    state.acceptWebSocket(b, ["cred:ses_b", "extra"]);
    state.acceptWebSocket(c);
    expect(state.getWebSockets()).toEqual([a, b, c]);
    expect(state.getWebSockets("cred:ses_a")).toEqual([a]);
    expect(state.getWebSockets("extra")).toEqual([b]);
    expect(state.getWebSockets("cred:none")).toEqual([]);
    expect(state.getTags(b)).toEqual(["cred:ses_b", "extra"]);
  });

  it("blockConcurrencyWhile serializes callers and holds RPC delivery until it finishes", async () => {
    const h = makeHarness();
    const state = h.namespaces.CALENDARS.state("cal_x");
    const order: Array<string> = [];
    let release!: () => void;

    const first = state.blockConcurrencyWhile(
      () => new Promise<void>((r) => (release = () => (order.push("first"), r()))),
    );

    const second = state.blockConcurrencyWhile(async () => void order.push("second"));

    const rpc = h.env.CALENDARS.getByName("cal_x")
      .mayObserve("usr_x")
      .then(() => order.push("rpc"));

    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second, rpc]);
    expect(order).toEqual(["first", "second", "rpc"]);
  });

  it("deleteAll clears the synchronous KV store too", async () => {
    const state = new HarnessState({ name: "x" });
    state.storage.kv.put("config", { a: 1 });
    state.storage.sql.exec("CREATE TABLE t (x)");
    await state.storage.deleteAll();
    expect(state.storage.kv.get("config")).toBeUndefined();
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
  });

  it("R2 etags are content MD5s and listing uses a key cursor that survives deletes", async () => {
    const r2 = new MemoryR2();
    const put = await r2.put("a/1", "one");
    expect(put.etag).toBe(md5("one"));
    expect(put.httpEtag).toBe(`"${md5("one")}"`);

    for (const k of ["a/2", "a/3", "a/4", "b/1"]) await r2.put(k, k);
    const page1 = await r2.list({ prefix: "a/", limit: 2 });
    expect(page1.objects.map((o) => o.key)).toEqual(["a/1", "a/2"]);
    expect(page1.objects[0]).toMatchObject({ size: 3, etag: md5("one") });
    expect(page1.objects[0]!.uploaded).toBeInstanceOf(Date);
    expect(page1.truncated).toBe(true);
    // Deleting what was already listed must not skip anything (an offset cursor would).
    await r2.delete(["a/1", "a/2"]);
    const page2 = await r2.list({ prefix: "a/", limit: 2, cursor: page1.cursor! });
    expect(page2.objects.map((o) => o.key)).toEqual(["a/3", "a/4"]);
    expect(page2.truncated).toBe(false);
    expect(page2.cursor).toBeUndefined();
  });

  it("multipart complete() assembles exactly the listed parts and validates their etags", async () => {
    const r2 = new MemoryR2();
    const upload = await r2.createMultipartUpload("big");
    const p1 = await upload.uploadPart(1, "hello ");
    const p2 = await upload.uploadPart(2, "world");
    await upload.uploadPart(3, "IGNORED");
    expect(p1.etag).toBe(md5("hello "));
    await expect(upload.complete([])).rejects.toThrow(/parts list/);
    await expect(upload.complete([p2, p1])).rejects.toThrow(/ascending/);
    await expect(upload.complete([{ partNumber: 1, etag: "nope" }, p2])).rejects.toThrow(
      /etag mismatch/,
    );
    await expect(upload.complete([p1, { partNumber: 4, etag: "x" }])).rejects.toThrow(
      /not uploaded/,
    );
    const done = await upload.complete([p1, p2]);
    expect(await (await r2.get("big"))!.text()).toBe("hello world");
    expect(done.etag).toMatch(/^[0-9a-f]{32}-2$/);
    await expect(upload.complete([p1, p2])).rejects.toThrow(/no such multipart upload/);
  });

  it("workflow ids are unique and get() of an unknown id throws", async () => {
    const h = makeHarness();
    await h.env.ERASE_ACCOUNT.create({ id: "erase-1", params: {} } as never);
    await expect(
      h.env.ERASE_ACCOUNT.create({ id: "erase-1", params: {} } as never),
    ).rejects.toThrow(/already_exists/);
    expect(h.workflows.ERASE_ACCOUNT).toHaveLength(1);
    expect(await (await h.env.ERASE_ACCOUNT.get("erase-1")).status()).toEqual({ status: "queued" });
    await expect(h.env.ERASE_ACCOUNT.get("erase-2")).rejects.toThrow(/not_found/);
  });

  it("queue sends record options; retries redeliver with rising attempts, then dead-letter", async () => {
    const h = makeHarness();
    await h.queues.NOTIFY.send({ not: "a valid message" }, { delaySeconds: 30 });
    expect(h.queues.NOTIFY.sends).toEqual([
      { body: { not: "a valid message" }, options: { delaySeconds: 30 } },
    ]);
    await expect(h.drain()).rejects.toThrow(/queue NOTIFY message failed/);

    await h.queues.NOTIFY.send({ not: "a valid message" });
    await h.drain(20, { tolerateRetries: true, maxRetries: 2 });
    expect(h.deadLettered).toEqual([
      { queue: "NOTIFY", body: { not: "a valid message" }, attempts: 3 },
    ]);

    // The DLQ consumer captured it into D1 for operator replay.
    const held = await h.d1
      .prepare("SELECT queue, attempts, state FROM dead_letters")
      .all<{ queue: string; attempts: number; state: string }>();

    expect(held.results).toEqual([{ queue: "notifydlq", attempts: 3, state: "held" }]);
  });

  it("the auth rate limiter records keys and can be told to deny", async () => {
    const h = makeHarness();
    h.rateLimit.deny = (key) => key.startsWith("login:");

    const limiter = h.env.AUTH_RATE_LIMIT as {
      limit(o: { key: string }): Promise<{ success: boolean }>;
    };

    expect(await limiter.limit({ key: "login:1.2.3.4" })).toEqual({ success: false });
    expect(await limiter.limit({ key: "signup:1.2.3.4" })).toEqual({ success: true });
    expect(h.rateLimit.keys).toEqual(["login:1.2.3.4", "signup:1.2.3.4"]);
  });
});
