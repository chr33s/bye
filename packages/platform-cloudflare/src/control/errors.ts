import { isRejection, reject } from "../durable/rpc.ts";

// Control-plane adapter failures use the platform-wide `Rejection` (durable/rpc.ts). Promise-based
// D1 adapters throw it; callers map it by `code`. `Rejection`/`reject` remain as aliases
// while call sites migrate.

export type ControlErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "step_up_required"
  | "unavailable";

/** Wrap D1 access so storage outages surface as `unavailable`, never as "not found". */
export const guardD1 = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (isRejection(error)) throw error;
    return reject("unavailable", `${op}: directory unavailable`);
  }
};
