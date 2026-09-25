import { describe, expect, it } from "vitest";
import {
  publicError,
  reject,
  Rejection,
  REJECTION_CODES,
  toRpc,
  toRpcSync,
  unwrapRpc,
  valueOr,
  type RpcResult,
} from "@bye/platform-cloudflare";

// The one rejection → RPC envelope → public error path every authority uses (durable/rpc.ts).

const caught = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("RPC envelope", () => {
  it("toRpc carries values, turns rejections into data (with details), and rethrows defects", async () => {
    expect(await toRpc(async () => 42)).toEqual({ ok: true, value: 42 });
    expect(await toRpc(() => reject("gone", "deleted", { id: "x" }))).toEqual({
      ok: false,
      code: "gone",
      message: "deleted",
      details: { id: "x" },
    });
    const noDetails = await toRpc(() => reject("conflict", "busy"));
    expect(noDetails).toEqual({ ok: false, code: "conflict", message: "busy" });
    expect("details" in noDetails).toBe(false);
    const defect = new TypeError("boom");
    await expect(
      toRpc(() => {
        throw defect;
      }),
    ).rejects.toBe(defect);
  });

  it("toRpcSync mirrors toRpc without awaiting", () => {
    expect(toRpcSync(() => "v")).toEqual({ ok: true, value: "v" });
    expect(toRpcSync(() => reject("read_only", "archived"))).toMatchObject({
      ok: false,
      code: "read_only",
    });
    expect(
      caught(() =>
        toRpcSync(() => {
          throw new RangeError("defect");
        }),
      ),
    ).toBeInstanceOf(RangeError);
  });

  it("unwrapRpc returns the value or re-raises the same rejection on the caller's side", () => {
    expect(unwrapRpc({ ok: true, value: 1 })).toBe(1);
    const e = caught(() =>
      unwrapRpc({ ok: false, code: "forbidden", message: "no", details: { why: "x" } }),
    );
    expect(e).toBeInstanceOf(Rejection);
    expect(e).toMatchObject({ code: "forbidden", message: "no", details: { why: "x" } });
  });

  it("valueOr maps only the listed codes to null and re-raises any other rejection", () => {
    const missing: RpcResult<number> = { ok: false, code: "not_found", message: "nope" };
    expect(valueOr({ ok: true, value: 7 }, "not_found")).toBe(7);
    expect(valueOr(missing, "not_found", "gone")).toBeNull();
    expect(caught(() => valueOr(missing, "gone"))).toMatchObject({ code: "not_found" });
    expect(caught(() => valueOr(missing))).toMatchObject({ code: "not_found" });
  });
});

describe("publicError", () => {
  it("hides tombstones and read-only state behind the public codes and flags step-up", () => {
    expect(publicError("gone")).toEqual({ code: "not_found" });
    expect(publicError("gone", { id: "m" })).toEqual({ code: "not_found", details: { id: "m" } });
    expect(publicError("read_only")).toEqual({ code: "forbidden" });
    expect(publicError("read_only", { reason: "lapsed" })).toEqual({
      code: "forbidden",
      details: { reason: "lapsed" },
    });
    expect(publicError("step_up_required")).toEqual({
      code: "forbidden",
      details: { stepUp: true },
    });
    expect(publicError("step_up_required", { action: "delete" })).toEqual({
      code: "forbidden",
      details: { action: "delete", stepUp: true },
    });
  });

  it("passes every other rejection code through unchanged, keeping details only when present", () => {
    const special = new Set(["gone", "read_only", "step_up_required"]);
    for (const code of REJECTION_CODES.filter((c) => !special.has(c))) {
      expect(publicError(code)).toEqual({ code });
      expect(publicError(code, { k: 1 })).toEqual({ code, details: { k: 1 } });
    }
  });
});
