import * as Cloudflare from "alchemy/Cloudflare";
import { declareQueues, QUEUE_NAMES, QUEUES, type QueueName } from "./queue-policy.ts";

export * from "./queue-policy.ts";

const declared = declareQueues((id) => Cloudflare.Queues.Queue(id));

export const Queues = declared.queues;

export const DeadLetters = declared.deadLetters;

/** MailCore producer bindings (INGEST, PARSE_SCAN, …) for the core Worker env. */
export const queueBindings = Object.fromEntries(
  QUEUE_NAMES.map((name) => [QUEUES[name].binding, Queues[name]]),
) as {
  readonly [K in QueueName as (typeof QUEUES)[K]["binding"]]: (typeof Queues)[K];
};
