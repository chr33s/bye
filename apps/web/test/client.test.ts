import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Browser-client behaviour exercised in Node: the real shared client over a stubbed `fetch`, with the
// passkey ceremony mocked (WebAuthn has no Node equivalent).
vi.hoisted(() => {
  (globalThis as { location?: unknown }).location = new URL("https://app.bye.test/");
});
vi.mock("../src/auth.ts", () => ({ stepUpWithPasskey: vi.fn(async () => undefined) }));

const { ApiRequestError } = await import("../src/api.ts");
const { stepUpWithPasskey } = await import("../src/auth.ts");
const { state, withStepUp } = await import("../src/core/state.ts");
const { uploadFile } = await import("../src/views/compose.ts");

const stepUpRequired = () =>
  new ApiRequestError(403, "forbidden", "step-up required", { stepUp: true });

describe("withStepUp", () => {
  beforeEach(() => vi.mocked(stepUpWithPasskey).mockClear());

  it("[X01] a step-up refusal runs the passkey ceremony and retries exactly once", async () => {
    const fn = vi.fn().mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce("ok");
    await expect(withStepUp(fn)).resolves.toBe("ok");
    expect(stepUpWithPasskey).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("[X01] a second step-up refusal after the ceremony propagates instead of looping", async () => {
    const second = stepUpRequired();
    const fn = vi.fn().mockRejectedValueOnce(stepUpRequired()).mockRejectedValueOnce(second);
    await expect(withStepUp(fn)).rejects.toBe(second);
    expect(stepUpWithPasskey).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("[X01] other errors (plain 403s, other statuses, non-API errors) propagate without a ceremony", async () => {
    for (const error of [
      new ApiRequestError(403, "forbidden", "not yours"),
      new ApiRequestError(403, "forbidden", "not yours", { stepUp: "yes" }),
      new ApiRequestError(401, "unauthenticated", "signed out", { stepUp: true }),
      new TypeError("offline"),
    ]) {
      const fn = vi.fn().mockRejectedValue(error);
      await expect(withStepUp(fn)).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(stepUpWithPasskey).not.toHaveBeenCalled();
  });

  it("[X01] a failed passkey ceremony surfaces and the action is not retried", async () => {
    vi.mocked(stepUpWithPasskey).mockRejectedValueOnce(new Error("cancelled"));
    const fn = vi.fn().mockRejectedValue(stepUpRequired());
    await expect(withStepUp(fn)).rejects.toThrow("cancelled");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("uploadFile (E20)", () => {
  interface Call {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  }
  let calls: Array<Call>;

  const stubFetch = (respond: (call: Call) => Response) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const call = {
          method: init.method ?? "GET",
          path: new URL(url).pathname + new URL(url).search,
          body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        };
        calls.push(call);
        return respond(call);
      }),
    );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    calls = [];
    state.mailboxId = "mbx_1";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("[E20] reserves, PUTs each part in order with progress, then completes", async () => {
    stubFetch((call) =>
      call.path === "/v1/uploads" ? json({ uploadId: "upl/1", partSize: 4 }) : json({}),
    );
    const progress: Array<number> = [];
    const file = new File(["0123456789"], "notes.txt", { type: "text/plain" });
    await expect(uploadFile(file, (done) => progress.push(done))).resolves.toBe("upl/1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/uploads",
      "PUT /v1/uploads/upl%2F1/parts/1?mailbox=mbx_1",
      "PUT /v1/uploads/upl%2F1/parts/2?mailbox=mbx_1",
      "PUT /v1/uploads/upl%2F1/parts/3?mailbox=mbx_1",
      "POST /v1/uploads/upl%2F1/complete",
    ]);
    expect(calls[0]?.body).toMatchObject({
      mailboxId: "mbx_1",
      filename: "notes.txt",
      contentType: "text/plain",
      declaredSize: 10,
    });
    expect(progress).toEqual([4, 8, 10]);
    expect(calls.slice(1, 4).map((c) => (c.body as Blob).size)).toEqual([4, 4, 2]);
  });

  it("[E20] a failed part aborts the reservation and rethrows the original error", async () => {
    stubFetch((call) => {
      if (call.path === "/v1/uploads") return json({ uploadId: "upl_2", partSize: 4 });
      if (call.path.includes("/parts/2"))
        return json({ error: { code: "too_large", message: "part rejected" } }, 413);
      return json({});
    });
    const file = new File(["0123456789"], "big.bin");
    const error = await uploadFile(file, () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as InstanceType<typeof ApiRequestError>).status).toBe(413);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/uploads",
      "PUT /v1/uploads/upl_2/parts/1?mailbox=mbx_1",
      "PUT /v1/uploads/upl_2/parts/2?mailbox=mbx_1",
      "POST /v1/uploads/upl_2/abort",
    ]);
    expect(calls[0]?.body).toMatchObject({ contentType: "application/octet-stream" });
  });

  it("[E20] a failing abort does not mask the upload error", async () => {
    stubFetch((call) => {
      if (call.path === "/v1/uploads") return json({ uploadId: "upl_3", partSize: 8 });
      // The part and the abort both fail; the caller sees the part's failure.
      return json({ error: { code: "unavailable" } }, call.path.endsWith("/abort") ? 503 : 500);
    });
    const error = await uploadFile(new File(["abc"], "a.txt"), () => undefined).catch(
      (e: unknown) => e,
    );
    expect((error as InstanceType<typeof ApiRequestError>).status).toBe(500);
    expect(calls.at(-1)?.path).toBe("/v1/uploads/upl_3/abort");
  });
});
