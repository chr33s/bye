// Work delivery (§15.4): one queue per pipeline stage, each with a dead-letter queue.
// Queues carry references only; journals and outboxes are the durable record (§6).
//
// QUEUES is the single table: the Alchemy resources, the MailCore producer bindings, the consumer
// wiring in stack.ts, the local drills and the DLQ replay mapping (workers/core/src/dlq.ts, checked
// against this table at compile time) all derive from it. Logical IDs are the table keys and must
// never change: renaming one replaces the queue and drops in-flight messages.
import * as Cloudflare from "alchemy/Cloudflare";

export interface ConsumerPolicy {
  readonly batchSize: number;
  readonly maxRetries: number;
  readonly maxWaitTimeMs: number;
  readonly maxConcurrency: number;
  readonly retryDelay: number;
}

/**
 * Per stage: the MailCore producer binding and its bounded batches and retries. Dispatch keeps a
 * low retry budget because transport uncertainty is resolved by send-job reconciliation, not by
 * queue redelivery (§5.2, §7.4 Retries).
 */
export const QUEUES = {
  Ingest: {
    binding: "INGEST",
    consumer: {
      batchSize: 10,
      maxRetries: 5,
      maxWaitTimeMs: 2000,
      maxConcurrency: 20,
      retryDelay: 10,
    },
  },
  ParseScan: {
    binding: "PARSE_SCAN",
    consumer: {
      batchSize: 5,
      maxRetries: 5,
      maxWaitTimeMs: 2000,
      maxConcurrency: 10,
      retryDelay: 30,
    },
  },
  Index: {
    binding: "INDEX",
    consumer: {
      batchSize: 25,
      maxRetries: 8,
      maxWaitTimeMs: 5000,
      maxConcurrency: 10,
      retryDelay: 30,
    },
  },
  Dispatch: {
    binding: "DISPATCH",
    consumer: {
      batchSize: 5,
      maxRetries: 3,
      maxWaitTimeMs: 1000,
      maxConcurrency: 10,
      retryDelay: 15,
    },
  },
  Notify: {
    binding: "NOTIFY",
    consumer: {
      batchSize: 25,
      maxRetries: 5,
      maxWaitTimeMs: 2000,
      maxConcurrency: 10,
      retryDelay: 15,
    },
  },
  Propagate: {
    binding: "PROPAGATE",
    consumer: {
      batchSize: 25,
      maxRetries: 8,
      maxWaitTimeMs: 2000,
      maxConcurrency: 10,
      retryDelay: 15,
    },
  },
  Publish: {
    binding: "PUBLISH",
    consumer: {
      batchSize: 10,
      maxRetries: 5,
      maxWaitTimeMs: 5000,
      maxConcurrency: 5,
      retryDelay: 60,
    },
  },
} as const satisfies Record<
  string,
  { readonly binding: string; readonly consumer: ConsumerPolicy }
>;

export type QueueName = keyof typeof QUEUES;

export type QueueBinding = (typeof QUEUES)[QueueName]["binding"];

export const QUEUE_NAMES = Object.keys(QUEUES) as ReadonlyArray<QueueName>;

/** DLQ drain (§6): one drainer at a time persists dead letters to D1; generous retries, no DLQ of its own. */
export const DLQ_CONSUMER_POLICY: ConsumerPolicy = {
  batchSize: 25,
  maxRetries: 10,
  maxWaitTimeMs: 5000,
  maxConcurrency: 1,
  retryDelay: 60,
};

/** Alchemy logical IDs (state keys) per stage. */
export const queueIds = (name: QueueName) =>
  ({
    queue: name,
    deadLetter: `${name}DLQ`,
    consumer: `${name}Consumer`,
    deadLetterConsumer: `${name}DLQConsumer`,
  }) as const;

/** Lowercased logical ID → producer binding: the exact lookup dlq.ts mirrors (type-checked). */
export type SourceBindings = {
  readonly [K in QueueName as Lowercase<K>]: (typeof QUEUES)[K]["binding"];
};

const byName = <T>(make: (name: QueueName) => T): { readonly [K in QueueName]: T } =>
  Object.fromEntries(QUEUE_NAMES.map((name) => [name, make(name)])) as {
    readonly [K in QueueName]: T;
  };

export const CONSUMER_POLICY: Readonly<Record<QueueName, ConsumerPolicy>> = byName(
  (name) => QUEUES[name].consumer,
);

/** Declares every queue then every dead-letter queue by logical ID, in table order. */
export const declareQueues = <T>(makeQueue: (id: string) => T) => ({
  queues: byName((name) => makeQueue(queueIds(name).queue)),
  deadLetters: byName((name) => makeQueue(queueIds(name).deadLetter)),
});

const declared = declareQueues((id) => Cloudflare.Queues.Queue(id));

export const Queues = declared.queues;

export const DeadLetters = declared.deadLetters;

/** MailCore producer bindings (INGEST, PARSE_SCAN, …) for the core Worker env. */
export const queueBindings = Object.fromEntries(
  QUEUE_NAMES.map((name) => [QUEUES[name].binding, Queues[name]]),
) as {
  readonly [K in QueueName as (typeof QUEUES)[K]["binding"]]: (typeof Queues)[K];
};
