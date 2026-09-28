import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type StepResult } from "./harness.ts";
import { readJson, runHttp } from "../src/http.ts";
import { decodeParams, effectStep, WorkflowParamsError } from "../src/workflows/common.ts";

// §7.4/§7.5 runtime rules: cancellation closes scopes and runs finalizers; expected failures map
// to envelopes while defects are redacted; Workflow params are versioned and step results are
// Schema-encoded at the checkpoint boundary.

describe("[A03] request cancellation and finalizers (§7.4)", () => {
  it("aborting the request interrupts the fiber and runs scope finalizers", async () => {
    const released: Array<string> = [];
    const controller = new AbortController();

    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.succeed("stream"), () =>
          Effect.sync(() => void released.push("closed")),
        );
        yield* Effect.never;

        return new Response("unreachable");
      }),
    );

    const pending = runHttp(program, "req-1", controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const response = await pending;
    expect(released).toEqual(["closed"]);
    expect(response.status).toBe(500);
  });

  it("expected failures become envelopes; defects are redacted", async () => {
    const expected = await runHttp(Effect.fail({ _tag: "Forbidden", reason: "nope" }), "r");
    expect(expected.status).toBe(403);
    const defect = await runHttp(Effect.die(new Error("secret internals")), "r");
    const body = await defect.text();
    expect(defect.status).toBe(500);
    expect(body).not.toContain("secret internals");
  });

  it("production defect logs carry a redacted tag, message and top stack frames", async () => {
    const lines: Array<string> = [];

    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a) => void lines.push(a.join(" ")));

    const debug = (globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__;
    (globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__ = false;

    try {
      class StoreDefect extends Error {
        override name = "StoreDefect";
      }

      await runHttp(
        Effect.die(
          new StoreDefect(
            "lookup failed for ana@example.net at https://api.example/x?token=QSCANARY with Bearer abc.def and tok_4f9a8b7c6d5e4f3a2b1c0d9e",
          ),
        ),
        "req-9",
      );

      const entry = JSON.parse(lines[0]!) as {
        requestId: string;
        error: { tag: string; message: string; stack: Array<string> };
      };

      expect(entry.requestId).toBe("req-9");
      expect(entry.error.tag).toBe("StoreDefect");
      expect(entry.error.message).toContain("lookup failed");
      expect(entry.error.stack.length).toBeGreaterThan(0);
      expect(entry.error.stack.length).toBeLessThanOrEqual(5);

      for (const leaked of [
        "ana@example.net",
        "QSCANARY",
        "abc.def",
        "tok_4f9a8b7c6d5e4f3a2b1c0d9e",
      ])
        expect(lines.join("\n")).not.toContain(leaked);
    } finally {
      (globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__ = debug;
      spy.mockRestore();
    }
  });

  it("readJson enforces its byte cap on the stream even without content-length", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;

        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const request = new Request("https://x.test/", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJson(request, 256 * 1024)).rejects.toMatchObject({ _tag: "PayloadTooLarge" });
    expect(pulled).toBeLessThan(10);
    expect(
      await readJson(new Request("https://x.test/", { method: "POST", body: '{"a":1}' })),
    ).toEqual({ a: 1 });
  });
});

describe("[A04] versioned Workflow params and Schema-encoded steps (§15.9, §7.4)", () => {
  const ParamsV1 = Schema.Struct({ v: Schema.Literal(1), exportId: Schema.String });

  const ParamsV2 = Schema.Struct({
    v: Schema.Literal(2),
    exportId: Schema.String,
    format: Schema.Literals(["mbox", "eml"]),
  });

  const Params = Schema.Union([ParamsV1, ParamsV2]);

  it("decodes current and previous versions and rejects unknown ones as non-retryable", () => {
    const decode = decodeParams(Params);
    expect(decode({ v: 1, exportId: "e1" })).toEqual({ v: 1, exportId: "e1" });
    expect(decode({ v: 2, exportId: "e1", format: "eml" })).toMatchObject({ v: 2 });
    // Instances created before payloads were versioned carry no `v`: they decode as v1.
    expect(decode({ exportId: "e1" })).toEqual({ v: 1, exportId: "e1" });
    expect(() => decode({ v: 1 })).toThrow(WorkflowParamsError);
    expect(() => decode({ v: 3, exportId: "e1" })).toThrow(/v=3/);
  });

  it("persists only the Schema encoding and decodes it back on replay", async () => {
    // The checkpoint store only accepts JSON; a Date and a bigint survive only if effectStep
    // encodes before persisting and decodes after reading back.
    const checkpoints = new Map<string, string>();

    const step = {
      do: async (name: string, ...args: ReadonlyArray<unknown>) => {
        if (!checkpoints.has(name)) {
          const fn = args.at(-1) as () => Promise<StepResult>;
          checkpoints.set(name, JSON.stringify(await fn()));
        }

        return JSON.parse(checkpoints.get(name)!);
      },
    };

    const Result = Schema.Struct({
      files: Schema.Array(Schema.String),
      at: Schema.DateFromString,
      bytes: Schema.BigIntFromString,
    });

    let runs = 0;
    const at = new Date(Date.UTC(2026, 8, 25, 12));

    const program = Effect.sync(() => {
      runs++;

      return { files: ["a.mbox"], at, bytes: 2n ** 64n };
    });

    const first = await effectStep(step, "v1:files", program, { schema: Result });
    expect(JSON.parse(checkpoints.get("v1:files")!)).toEqual({
      files: ["a.mbox"],
      at: at.toISOString(),
      bytes: "18446744073709551616",
    });
    const replay = await effectStep(step, "v1:files", program, { schema: Result });
    expect(first).toEqual({ files: ["a.mbox"], at, bytes: 2n ** 64n });
    expect(replay.at).toBeInstanceOf(Date);
    expect(replay).toEqual(first);
    expect(runs).toBe(1);
  });

  it("a failing step surfaces the failure for the Workflow's retry policy (no silent success)", async () => {
    const attempted: Array<string> = [];
    const checkpoints = new Map<string, unknown>();

    const step = {
      do: async (name: string, ...args: ReadonlyArray<unknown>) => {
        attempted.push(name);
        const value = await (args.at(-1) as () => Promise<StepResult>)();
        checkpoints.set(name, value);

        return value;
      },
    };

    await expect(
      effectStep(step, "v1:boom", Effect.fail(new Error("transient upstream")), {
        schema: Schema.String,
      }),
    ).rejects.toThrow("transient upstream");
    expect(attempted).toEqual(["v1:boom"]);
    // Nothing was checkpointed, so a retry re-runs the step instead of replaying a fake success.
    expect(checkpoints.has("v1:boom")).toBe(false);
  });
});
