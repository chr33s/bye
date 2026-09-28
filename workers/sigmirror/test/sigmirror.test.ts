import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { SigMirrorJob, type SigMirrorEnv } from "../src/index.ts";
import {
  handleMirror,
  isDatabaseName,
  JOB_TIMEOUT_MS,
  MIRROR_HOST,
  type MirrorBucket,
  type MirrorEnv,
  parseRange,
} from "../src/mirror.ts";

// Private signature mirror (§3.1, §10): the only read path for scanner signatures.

class MemoryBucket implements MirrorBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date; etag: string }>();
  private n = 0;
  async head(key: string) {
    const o = this.objects.get(key);
    return o
      ? { size: o.bytes.byteLength, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded }
      : null;
  }
  async get(
    key: string,
    options: { range?: { offset: number; length?: number } | { suffix: number } } = {},
  ) {
    const o = this.objects.get(key);
    if (!o) return null;
    let bytes = o.bytes;
    const r = options.range;
    if (r)
      bytes =
        "suffix" in r
          ? bytes.slice(bytes.length - r.suffix)
          : bytes.slice(r.offset, r.length === undefined ? undefined : r.offset + r.length);
    return {
      size: o.bytes.byteLength,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      uploaded: o.uploaded,
      body: new Response(bytes).body!,
    };
  }
  async put(key: string, value: ReadableStream | ArrayBuffer | string) {
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, {
      bytes,
      uploaded: new Date(Date.UTC(2026, 8, 25, 12, 0, 0)),
      etag: `e${++this.n}`,
    });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(options: { prefix: string }) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(options.prefix))
      .map(([key, o]) => ({ key, size: o.bytes.byteLength, etag: o.etag }));
    return { objects, truncated: false };
  }
}

const WRITE = "w".repeat(40);
const setup = (extra: Partial<MirrorEnv> = {}) => {
  const bucket = new MemoryBucket();
  const env: MirrorEnv = { SIGNATURES: bucket, WRITE_TOKEN: WRITE, ...extra };
  const call = (
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ) =>
    handleMirror(
      new Request(`http://sigmirror.internal${path}`, {
        method,
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      env,
    );
  const put = (name: string, body: string) =>
    call("PUT", `/w/${name}`, {
      headers: { authorization: `Bearer ${WRITE}`, "content-length": String(body.length) },
      body,
    });
  return { bucket, env, call, put };
};

describe("signature mirror Worker", () => {
  it("[E20] serves database files written by the mirror job", async () => {
    const m = setup();
    expect((await m.put("daily.cvd", "ClamAV-VDB:daily")).status).toBe(201);
    const res = await m.call("GET", "/daily.cvd");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("etag")).toBe('"e1"');
    expect(res.headers.get("last-modified")).toBe("Fri, 25 Sep 2026 12:00:00 GMT");
    expect(await res.text()).toBe("ClamAV-VDB:daily");
    expect((await m.call("HEAD", "/daily.cvd")).headers.get("content-length")).toBe("16");
    expect((await m.call("GET", "/main.cvd")).status).toBe(404);
  });

  it("[E20] answers freshclam's conditional requests with 304", async () => {
    const m = setup();
    await m.put("daily.cvd", "x");
    expect(
      (
        await m.call("GET", "/daily.cvd", {
          headers: { "if-modified-since": "Fri, 25 Sep 2026 12:00:00 GMT" },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await m.call("GET", "/daily.cvd", {
          headers: { "if-modified-since": "Fri, 25 Sep 2026 11:59:59 GMT" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await m.call("GET", "/daily.cvd", { headers: { "if-none-match": '"e1"' } })).status,
    ).toBe(304);
    expect(
      (await m.call("GET", "/daily.cvd", { headers: { "if-none-match": '"other"' } })).status,
    ).toBe(200);
  });

  it("[E20] supports single byte ranges, including the CVD header probe", async () => {
    const m = setup();
    await m.put("main.cvd", "0123456789");
    const header = await m.call("GET", "/main.cvd", { headers: { range: "bytes=0-3" } });
    expect(header.status).toBe(206);
    expect(header.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(await header.text()).toBe("0123");
    const tail = await m.call("GET", "/main.cvd", { headers: { range: "bytes=-2" } });
    expect(await tail.text()).toBe("89");
    expect(tail.headers.get("content-range")).toBe("bytes 8-9/10");
    expect((await m.call("GET", "/main.cvd", { headers: { range: "bytes=50-" } })).status).toBe(
      416,
    );
    expect(parseRange("bytes=2-", 10)).toEqual({ offset: 2, length: 8 });
    expect(parseRange("bytes=1-2,4-5", 10)).toBeNull();
  });

  it("[E20] rejects writes without the write token and never serves internal state", async () => {
    const m = setup();
    expect(
      (await m.call("PUT", "/w/daily.cvd", { headers: { "content-length": "1" }, body: "x" }))
        .status,
    ).toBe(401);
    expect(
      (
        await m.call("PUT", "/w/daily.cvd", {
          headers: { authorization: "Bearer nope", "content-length": "1" },
          body: "x",
        })
      ).status,
    ).toBe(401);
    expect((await m.call("PUT", "/daily.cvd", { body: "x" })).status).toBe(405);
    await m.put("_state", '{"uuid":"secret"}');
    expect((await m.call("GET", "/_state")).status).toBe(404);
    expect((await m.call("GET", "/w/_state")).status).toBe(401);
    expect(
      await (
        await m.call("GET", "/w/_state", { headers: { authorization: `Bearer ${WRITE}` } })
      ).text(),
    ).toBe('{"uuid":"secret"}');
    const manifest = (await (
      await m.call("GET", "/w/_manifest", { headers: { authorization: `Bearer ${WRITE}` } })
    ).json()) as { files: Record<string, unknown> };
    expect(Object.keys(manifest.files)).toEqual([]);
  });

  it("[E20] a write token under 32 characters disables writes, even when presented exactly", async () => {
    const short = "s".repeat(31);
    const m = setup({ WRITE_TOKEN: short });
    expect(
      (await m.call("GET", "/w/_manifest", { headers: { authorization: `Bearer ${short}` } }))
        .status,
    ).toBe(401);
    const unset = setup({ WRITE_TOKEN: "" });
    expect(
      (await unset.call("GET", "/w/_manifest", { headers: { authorization: "Bearer " } })).status,
    ).toBe(401);
  });

  it("[E20] rejects path traversal and non-database names", async () => {
    const m = setup();
    await m.put("daily.cvd", "x");
    // Encoded dot segments are normalised by the URL parser and cannot leave the database namespace.
    expect(await (await m.call("GET", "/%2e%2e/daily.cvd")).text()).toBe("x");
    for (const path of [
      "/..%2Fdaily.cvd",
      "/db%2Fdaily.cvd",
      "/w/..%2F_state",
      "/daily.cvd/extra",
      "/index.html",
    ]) {
      expect([400, 404]).toContain((await m.call("GET", path)).status);
    }
    expect([400, 405]).toContain((await m.put("../escape.cvd", "x")).status);
    expect((await m.put("evil.exe", "x")).status).toBe(400);
    expect(isDatabaseName("daily-27791.cdiff")).toBe(true);
    expect(isDatabaseName("daily-27791.cvd.sign")).toBe(true);
    expect(isDatabaseName("daily-27791.cdiff.sign")).toBe(true);
    expect(isDatabaseName("daily.cvd.exe")).toBe(false);
  });

  it("[E20] requires the unguessable path prefix when a read token is configured", async () => {
    const m = setup({ READ_TOKEN: "r".repeat(32) });
    await m.put("daily.cvd", "x");
    expect((await m.call("GET", "/daily.cvd")).status).toBe(404);
    expect((await m.call("GET", `/${"x".repeat(32)}/daily.cvd`)).status).toBe(404);
    expect((await m.call("GET", `/${"r".repeat(32)}/daily.cvd`)).status).toBe(200);
  });
});

describe("signature mirror writes", () => {
  const auth = { authorization: `Bearer ${WRITE}` };

  it("[E20] DELETE removes a database file but never the job state", async () => {
    const m = setup();
    await m.put("daily-1.cdiff", "diff");
    await m.put("_state", "{}");
    const removed = await m.call("DELETE", "/w/daily-1.cdiff", { headers: auth });
    expect(removed.status).toBe(204);
    expect(m.bucket.objects.has("db/daily-1.cdiff")).toBe(false);
    expect((await m.call("GET", "/daily-1.cdiff")).status).toBe(404);
    const state = await m.call("DELETE", "/w/_state", { headers: auth });
    expect([state.status, await state.text()]).toEqual([400, "state cannot be deleted"]);
    expect(m.bucket.objects.size).toBe(1);
    // Unauthenticated deletes are refused before touching the bucket.
    await m.put("main.cvd", "m");
    expect((await m.call("DELETE", "/w/main.cvd")).status).toBe(401);
    expect(m.bucket.objects.has("db/main.cvd")).toBe(true);
  });

  it("[E20] PUT without a usable content-length is a 411 and stores nothing", async () => {
    const m = setup();
    for (const headers of [
      { ...auth } as Record<string, string>,
      { ...auth, "content-length": "abc" },
      { ...auth, "content-length": "-1" },
      { ...auth, "content-length": String(10 * 1024 ** 3) },
    ]) {
      const r = await m.call("PUT", "/w/daily.cvd", { headers, body: "x" });
      expect([headers["content-length"], r.status]).toEqual([headers["content-length"], 411]);
    }
    // A declared length with no body is also refused.
    expect(
      (await m.call("PUT", "/w/daily.cvd", { headers: { ...auth, "content-length": "0" } })).status,
    ).toBe(411);
    expect(m.bucket.objects.size).toBe(0);
    expect((await m.call("POST", "/w/daily.cvd", { headers: auth, body: "x" })).status).toBe(405);
  });
});

describe("signature mirror job", () => {
  afterEach(() => vi.useRealTimers());

  const job = (container: unknown, exportsDefault: unknown = { fetch: () => undefined }) => {
    const alarms: Array<number> = [];
    const ctx = {
      container,
      exports: { default: exportsDefault },
      storage: { setAlarm: async (at: number) => void alarms.push(at) },
    };
    const env = { SIGNATURES: new MemoryBucket(), WRITE_TOKEN: WRITE } as unknown as SigMirrorEnv;
    return { job: new SigMirrorJob(ctx as never, env), alarms, ctx };
  };

  const fakeContainer = () => {
    const calls: Array<string> = [];
    const c = {
      running: false,
      started: null as unknown,
      intercepted: null as unknown,
      destroyedWith: null as unknown,
      start(options: unknown) {
        calls.push("start");
        c.started = options;
        c.running = true;
      },
      async interceptOutboundHttp(host: string, target: unknown) {
        calls.push("intercept");
        c.intercepted = { host, target };
      },
      async destroy(error: Error) {
        calls.push("destroy");
        c.destroyedWith = error;
        c.running = false;
      },
      calls,
    };
    return c;
  };

  it("[E20] run starts one cvdupdate pass wired to the mirror and arms the timeout alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 3));
    const container = fakeContainer();
    const self = { fetch: () => undefined };
    const { job: j, alarms } = job(container, self);
    expect(await j.run()).toEqual({ started: true });
    expect(container.started).toEqual({
      enableInternet: true,
      env: { MIRROR_URL: `http://${MIRROR_HOST}`, WRITE_TOKEN: WRITE },
    });
    // Writes are intercepted to this Worker; the alarm bounds the run.
    expect(container.intercepted).toEqual({ host: MIRROR_HOST, target: self });
    expect(alarms).toEqual([Date.now() + JOB_TIMEOUT_MS]);
    // A second trigger while the job is running does not start another pass.
    expect(await j.run()).toEqual({ started: false });
    expect(container.calls).toEqual(["start", "intercept"]);
    expect(alarms).toHaveLength(1);
  });

  it("[E20] run fails loudly without the container binding or the ctx.exports loopback", async () => {
    await expect(job(undefined).job.run()).rejects.toThrow(/container binding missing/);
    const noLoopback = fakeContainer();
    const missing = job(noLoopback, null);
    await expect(missing.job.run()).rejects.toThrow(/enable_ctx_exports/);
    // Refused before anything starts: no container left running without a timeout.
    expect(noLoopback.calls).toEqual([]);
    expect(missing.alarms).toEqual([]);
  });

  it("[E20] a failed intercept tears the container down instead of leaving it running", async () => {
    const container = fakeContainer();
    container.interceptOutboundHttp = async () => {
      container.calls.push("intercept");
      throw new Error("intercept refused");
    };
    const { job: j, alarms } = job(container);
    await expect(j.run()).rejects.toThrow(/intercept refused/);
    expect(container.calls).toEqual(["start", "intercept", "destroy"]);
    expect(container.running).toBe(false);
    expect(alarms).toHaveLength(1);
  });

  it("[E20] the alarm destroys a hung run and is a no-op once the job has exited", async () => {
    const container = fakeContainer();
    const { job: j } = job(container);
    await j.run();
    await j.alarm();
    expect(container.calls.at(-1)).toBe("destroy");
    expect(String(container.destroyedWith)).toMatch(/exceeded time limit/);
    await j.alarm();
    expect(container.calls.filter((c) => c === "destroy")).toHaveLength(1);
    // No container at all: the alarm is harmless.
    await expect(job(undefined).job.alarm()).resolves.toBeUndefined();
  });

  it("[E20] the cron trigger runs the single named mirror job", async () => {
    const names: Array<string> = [];
    let runs = 0;
    const env = {
      MIRROR_JOB: {
        getByName: (name: string) => (
          names.push(name),
          { run: async () => (runs++, { started: true }) }
        ),
      },
    } as unknown as SigMirrorEnv;
    await (
      worker.scheduled as unknown as (
        c: ScheduledController,
        e: SigMirrorEnv,
        x: ExecutionContext,
      ) => Promise<void>
    )({} as ScheduledController, env, {} as ExecutionContext);
    expect([names, runs]).toEqual([["mirror"], 1]);
  });
});
