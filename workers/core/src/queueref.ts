import { Predicate, type Schema } from "effect";
import type { CoreEnv } from "./env.ts";

// Large queue payloads by reference (§6, §7: queue messages ≤128 KB). The outbox relay stores an
// oversize body in private R2 and enqueues `{type:"ref", key}`; the consumer resolves it, processes
// the original body, and deletes the object after a successful ack.

export const QUEUE_REF_PREFIX = "_queue/";

/** A queue message body: JSON by construction (`contentType: "json"`), decoded per consumer. */
export type QueueBody = Schema.Json;

export type QueueRef = {
  readonly schemaVersion: 1;
  readonly type: "ref";
  readonly key: string;
};

export const isQueueRef = (body: QueueBody): body is QueueRef =>
  Predicate.isReadonlyObject(body) &&
  body.type === "ref" &&
  Predicate.isString(body.key) &&
  body.key.startsWith(QUEUE_REF_PREFIX);

export const offloadToR2 =
  (env: CoreEnv) =>
  async <B>(eventId: string, _queue: string, body: B): Promise<QueueRef> => {
    const key = `${QUEUE_REF_PREFIX}${eventId}.json`;
    await env.PARTS.put(key, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });

    return { schemaVersion: 1, type: "ref", key };
  };

/**
 * Marker for a reference whose object no longer exists. The object is released only after the
 * message was processed and acked, so on redelivery (ack lost, at-least-once) a missing object
 * means "already processed" — not a failure to retry until the DLQ. `resolveQueueRef` returns it
 * instead of the payload in that case.
 */
export const QUEUE_REF_GONE: unique symbol = Symbol("queue-ref-gone");

export const resolveQueueRef = async (
  env: CoreEnv,
  ref: QueueRef,
): Promise<QueueBody | typeof QUEUE_REF_GONE> => {
  const object = await env.PARTS.get(ref.key);

  if (!object) return QUEUE_REF_GONE;

  return JSON.parse(await object.text());
};

export const releaseQueueRef = (env: CoreEnv, ref: QueueRef): Promise<void> =>
  env.PARTS.delete(ref.key);
