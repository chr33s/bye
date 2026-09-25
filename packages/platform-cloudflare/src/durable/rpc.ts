import {
  type ErrorCode,
  isRejection,
  reject,
  REJECTION_CODES,
  Rejection,
  type RejectionCode,
} from "@bye/contracts";

export { isRejection, reject, REJECTION_CODES, Rejection, type RejectionCode };

// The ONE rejection model and RPC envelope for every authority (mailbox, calendar, space, world,
// control plane). Stores throw `Rejection` via `reject()`; Durable Object methods return
// `RpcResult` via `toRpc()`; callers unwrap with `unwrapRpc()`; HTTP maps with `publicError()`.
// Defects (anything that isn't a Rejection) are never converted: they stay defects.

/** A Durable Object method's result over RPC. Rejections cross as data; defects still throw. */
export type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly code: RejectionCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export const toRpc = async <A>(f: () => A | Promise<A>): Promise<RpcResult<A>> => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    if (isRejection(e))
      return {
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      };
    throw e;
  }
};

/** Synchronous variant for store methods called inside a DO without awaiting. */
export const toRpcSync = <A>(f: () => A): RpcResult<A> => {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (isRejection(e))
      return {
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      };
    throw e;
  }
};

/** Re-raise a rejected result as a `Rejection` on the caller's side. */
export const unwrapRpc = <A>(r: RpcResult<A>): A =>
  r.ok ? r.value : reject(r.code, r.message, r.details);

/** The value, or `null` when the authority refused with one of `codes` (e.g. not_found). */
export const valueOr = <A>(r: RpcResult<A>, ...codes: ReadonlyArray<RejectionCode>): A | null =>
  r.ok ? r.value : codes.includes(r.code) ? null : reject(r.code, r.message, r.details);

/** The single rejection → public error mapping (§7.3). */
export const publicError = (
  code: RejectionCode,
  details?: Readonly<Record<string, unknown>>,
): { readonly code: ErrorCode; readonly details?: Readonly<Record<string, unknown>> } => {
  switch (code) {
    case "gone":
      return { code: "not_found", ...(details ? { details } : {}) };
    case "read_only":
      return { code: "forbidden", ...(details ? { details } : {}) };
    case "step_up_required":
      return { code: "forbidden", details: { ...details, stepUp: true } };
    default:
      return { code, ...(details ? { details } : {}) };
  }
};

/**
 * The RPC surface a Durable Object exposes for a store: every public method, returning its result
 * in the envelope and asynchronously (as a DO stub does). Callers type stubs with this instead of
 * casting each call site.
 */
export type RpcSurface<T> = {
  readonly [
    K in keyof T as T[K] extends (...args: ReadonlyArray<never>) => unknown ? K : never
  ]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<RpcResult<Awaited<R>>>
    : never;
};
