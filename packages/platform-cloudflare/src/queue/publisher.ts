import {
  DispatchMessage,
  IndexMessage,
  NotifyMessage,
  QUEUE_MESSAGE_MAX_BYTES,
} from "@bye/contracts";
import { QueueFailure, type QueueName, QueuePublisher, type QueueWireBody } from "@bye/application";
import { Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import type { Kernel } from "../durable/kernel.ts";

/** Narrow Cloudflare Queue producer binding. */
export interface QueueBindingLike {
  send<Body>(body: Body, options?: { contentType?: "json" }): Promise<QueueSendAck>;
  sendBatch<Body>(messages: Iterable<{ body: Body; contentType?: "json" }>): Promise<QueueSendAck>;
}

/** What a producer binding resolves with; callers never read it. */
type QueueSendAck = object | void;

const sizeOf = <Body>(body: Body): number =>
  new TextEncoder().encode(JSON.stringify(body)).byteLength;

/** Queue payloads stay small references; oversize is a defect in the caller, reported as failure. */
export const makeQueuePublisher = (queues: Partial<Record<QueueName, QueueBindingLike>>) =>
  QueuePublisher.of({
    send: (queue, body) =>
      Effect.gen(function* () {
        const q = queues[queue];

        if (!q) return yield* new QueueFailure({ queue, detail: "no binding" });

        if (sizeOf(body) > QUEUE_MESSAGE_MAX_BYTES)
          return yield* new QueueFailure({ queue, detail: "message exceeds 128 KB" });
        yield* Effect.tryPromise({
          try: () => q.send(body, { contentType: "json" }),
          catch: (e) =>
            new QueueFailure({ queue, detail: e instanceof Error ? e.message : "send" }),
        });
      }),
    sendBatch: (queue, bodies) =>
      Effect.gen(function* () {
        const q = queues[queue];

        if (!q) return yield* new QueueFailure({ queue, detail: "no binding" });

        if (bodies.length === 0) return;

        if (bodies.some((b) => sizeOf(b) > QUEUE_MESSAGE_MAX_BYTES))
          return yield* new QueueFailure({ queue, detail: "message exceeds 128 KB" });

        // Cloudflare batch limits: 100 messages and 256 KB; chunk by both.
        for (const chunk of chunkByBytes(
          bodies.map((body) => ({ item: body, bytes: sizeOf(body) })),
        )) {
          const batch = chunk.map((body) => ({ body, contentType: "json" as const }));
          yield* Effect.tryPromise({
            try: () => q.sendBatch(batch),
            catch: (e) =>
              new QueueFailure({ queue, detail: e instanceof Error ? e.message : "sendBatch" }),
          });
        }
      }),
  });

export const QueuePublisherLive = (queues: Partial<Record<QueueName, QueueBindingLike>>) =>
  Layer.succeed(QueuePublisher, makeQueuePublisher(queues));

/** An outbox row whose payload doesn't satisfy its queue's message schema (a producer defect). */
export class OutboxPayloadError extends Error {
  override readonly name = "OutboxPayloadError";
}

const OutboxPayload = Schema.Record(Schema.String, Schema.Unknown);

const decodeOutboxPayload = Schema.decodeUnknownOption(OutboxPayload);

const EMPTY_OUTBOX_PAYLOAD = Schema.decodeUnknownSync(OutboxPayload)({});

/** Validate a wire body against its queue schema; missing/mistyped fields never become "undefined". */
const checked = <S extends Schema.Top, Body>(schema: S, topic: string, body: Body): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema as never)(body) as S["Type"];
  } catch (e) {
    throw new OutboxPayloadError(
      `${topic} payload invalid: ${e instanceof Error ? e.message.split("\n")[0] : "schema"}`,
    );
  }
};

type OutboxToQueueMessageResult = { readonly queue: QueueName; readonly body: QueueWireBody };

/**
 * Map an outbox topic to a queue and wire message. Unknown topics go to the propagate queue.
 * Dispatch/index/notify bodies are checked against their `QueueMessage` schemas; a malformed
 * payload throws `OutboxPayloadError` (the relay dead-letters the row locally).
 */
export const outboxToQueueMessage = (
  source: string,
  e: {
    readonly eventId: string;
    readonly topic: string;
    readonly target: string;
    readonly payload: unknown;
  },
): OutboxToQueueMessageResult => {
  const p = Option.getOrElse(decodeOutboxPayload(e.payload ?? {}), () => EMPTY_OUTBOX_PAYLOAD);

  switch (e.topic) {
    case "dispatch":
      return {
        queue: "dispatch",
        body: checked(DispatchMessage, e.topic, {
          schemaVersion: 1,
          type: "dispatch",
          eventId: e.eventId,
          mailboxId: e.target,
          sendJobId: p.sendJobId,
        }),
      };
    case "index":
      return {
        queue: "index",
        body: checked(IndexMessage, e.topic, {
          schemaVersion: 1,
          type: "index",
          eventId: e.eventId,
          scope: e.target,
          op: p.op === "delete" ? "delete" : "upsert",
          docId:
            Predicate.isString(p.kind) && Predicate.isString(p.id) && p.kind && p.id
              ? [p.kind, p.id].join(":")
              : undefined,
          source: { mailboxId: e.target, kind: p.kind, id: p.id },
        }),
      };
    case "notify":
      return {
        queue: "notify",
        body: checked(NotifyMessage, e.topic, {
          schemaVersion: 1,
          type: "notify",
          eventId: e.eventId,
          userId: e.target,
          kind: p.kind ?? "generic",
          resource: p.threadId ?? p.address ?? "",
        }),
      };
    default:
      return {
        queue: "propagate",
        body: {
          schemaVersion: 1,
          type: "propagate",
          eventId: e.eventId,
          topic: e.topic,
          source,
          target: e.target,
          payload: e.payload,
        },
      };
  }
};

/** Cloudflare Queues limits: 100 messages and 256 KB per sendBatch. */
export const QUEUE_BATCH_MAX_MESSAGES = 100;

export const QUEUE_BATCH_MAX_BYTES = 256 * 1024;

/** Rows refused this many times are dead-lettered locally so they cannot block the queue. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Chunk bodies by count and total serialized size. */
export const chunkByBytes = <T>(
  items: ReadonlyArray<{ readonly item: T; readonly bytes: number }>,
  maxMessages = QUEUE_BATCH_MAX_MESSAGES,
  maxBytes = QUEUE_BATCH_MAX_BYTES,
): Array<Array<T>> => {
  const chunks: Array<Array<T>> = [];
  let current: Array<T> = [];
  let size = 0;

  for (const { item, bytes } of items) {
    if (current.length > 0 && (current.length >= maxMessages || size + bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(item);
    size += bytes;
  }

  if (current.length > 0) chunks.push(current);

  return chunks;
};

export interface RelayOptions {
  /**
   * Store an oversize body by reference (e.g. R2) and return the small message to enqueue instead.
   * Without it, oversize rows are dead-lettered locally with diagnostics.
   */
  readonly offload?: (
    eventId: string,
    queue: QueueName,
    body: QueueWireBody,
  ) => Promise<QueueWireBody>;
}

/**
 * Relay pending outbox rows to queues. Rows are marked published only after the queue accepted
 * them; a crash in between yields a harmless duplicate that consumers deduplicate (§6). Oversize
 * rows are offloaded by reference or dead-lettered, and a row refused OUTBOX_MAX_ATTEMPTS times is
 * isolated, so one poison row never blocks the rows behind it.
 */
export const relayOutbox = (
  kernel: Kernel,
  source: string,
  limit = 100,
  options: RelayOptions = {},
) =>
  Effect.gen(function* () {
    const publisher = yield* QueuePublisher;
    const pending = kernel.pendingOutbox(limit);

    const byQueue = new Map<
      QueueName,
      Array<{ item: { id: string; body: QueueWireBody }; bytes: number }>
    >();

    let dead = 0;

    for (const e of pending) {
      let m: OutboxToQueueMessageResult;

      try {
        m = outboxToQueueMessage(source, e);
      } catch (error) {
        if (!(error instanceof OutboxPayloadError)) throw error;
        // A malformed row can never succeed: isolate it instead of blocking the rows behind it.
        kernel.deadLetterOutbox([e.eventId], error.message);
        dead++;
        continue;
      }

      let body = m.body;
      let bytes = sizeOf(body);

      if (bytes > QUEUE_MESSAGE_MAX_BYTES) {
        if (options.offload) {
          const offloaded = yield* Effect.tryPromise({
            try: () => options.offload!(e.eventId, m.queue, body),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));

          if (offloaded !== null && sizeOf(offloaded) <= QUEUE_MESSAGE_MAX_BYTES) {
            body = offloaded;
            bytes = sizeOf(offloaded);
          } else {
            kernel.deadLetterOutbox([e.eventId], `oversize ${bytes} bytes; offload failed`);
            dead++;
            continue;
          }
        } else {
          kernel.deadLetterOutbox([e.eventId], `oversize ${bytes} bytes`);
          dead++;
          continue;
        }
      }

      byQueue.set(m.queue, [
        ...(byQueue.get(m.queue) ?? []),
        { item: { id: e.eventId, body }, bytes },
      ]);
    }

    let published = 0;

    for (const [queue, items] of byQueue) {
      for (const chunk of chunkByBytes(items)) {
        const result = yield* Effect.result(
          publisher.sendBatch(
            queue,
            chunk.map((i) => i.body),
          ),
        );

        if (Result.isSuccess(result)) {
          kernel.markPublished(chunk.map((i) => i.id));
          published += chunk.length;
        } else {
          const ids = chunk.map((i) => i.id);
          kernel.markPublishFailed(ids);
          const attempts = kernel.outboxAttempts(ids);
          const exhausted = ids.filter((id) => (attempts.get(id) ?? 0) >= OUTBOX_MAX_ATTEMPTS);

          if (exhausted.length > 0) {
            kernel.deadLetterOutbox(
              exhausted,
              `queue refused ${OUTBOX_MAX_ATTEMPTS} times: ${result.failure.detail}`,
            );
            dead += exhausted.length;
          }
        }
      }
    }

    return { published, pending: pending.length, dead };
  });
