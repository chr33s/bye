import type { SourceBindings } from "../../../infra/resources/queues.ts";
import { journalPartition, type CoreEnv } from "./env.ts";
import { metric } from "./metrics.ts";
import { mailbox } from "./authorities.ts";

// Dead-letter handling (§6). Messages that exhausted queue retries are drained from each DLQ into
// D1 for operator inspection. Replay re-validates against the source of truth (ingress journal,
// send job state) before re-enqueueing, so a replay never duplicates committed work; consumers are
// idempotent by (eventId, target) regardless.

export interface DeadLetterRow {
  readonly id: string;
  readonly queue: string;
  readonly message_type: string;
  readonly event_id: string | null;
  readonly body: string;
  readonly attempts: number;
  readonly received_at: number;
  readonly state: "held" | "replayed" | "discarded" | "obsolete";
  readonly note: string | null;
}

export const isDeadLetterQueue = (queueName: string): boolean =>
  /dlq$|[-_]dlq[-_]|deadletter/i.test(queueName);

/**
 * Lowercased logical queue ID → producer binding. Mirrors infra/resources/queues.ts `QUEUES`; the
 * `satisfies` fails to compile if a queue is added, renamed or rebound there and not here.
 */
const SOURCE_BINDING = {
  ingest: "INGEST",
  parsescan: "PARSE_SCAN",
  index: "INDEX",
  dispatch: "DISPATCH",
  notify: "NOTIFY",
  propagate: "PROPAGATE",
  publish: "PUBLISH",
} as const satisfies SourceBindings;

type SourceBinding = (typeof SOURCE_BINDING)[keyof typeof SOURCE_BINDING];

/**
 * Map a queue name to its stage's producer binding by exact logical-ID lookup. Physical names are
 * `<stack>-<logicalId>-<stage>-<suffix>` (lowercased by Alchemy; local drills use the bare
 * lowercased ID); a DLQ's ID is its source's plus `DLQ`.
 */
export const sourceBindingFor = (queueName: string): SourceBinding | null => {
  for (const segment of queueName.toLowerCase().split("-")) {
    const id = segment.endsWith("dlq") ? segment.slice(0, -3) : segment;
    if (Object.hasOwn(SOURCE_BINDING, id)) return SOURCE_BINDING[id as keyof typeof SOURCE_BINDING];
  }
  return null;
};

export const captureDeadLetters = async (
  batch: MessageBatch<unknown>,
  env: CoreEnv,
): Promise<void> => {
  for (const msg of batch.messages) {
    const body = msg.body as { type?: string; eventId?: string } | null;
    try {
      await env.DIRECTORY.prepare(
        "INSERT OR IGNORE INTO dead_letters (id, queue, message_type, event_id, body, attempts, received_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'held')",
      )
        .bind(
          `dl_${msg.id}`,
          batch.queue,
          String(body?.type ?? "unknown"),
          body?.eventId ?? null,
          JSON.stringify(msg.body ?? null),
          msg.attempts,
          Date.now(),
        )
        .run();
      msg.ack();
      metric("dlq.captured", 1, { queue: sourceBindingFor(batch.queue) ?? "unknown" });
    } catch {
      msg.retry({ delaySeconds: 60 });
    }
  }
};

export const listDeadLetters = async (
  env: CoreEnv,
  options: { readonly state?: string; readonly limit?: number } = {},
): Promise<ReadonlyArray<DeadLetterRow>> =>
  (
    await env.DIRECTORY.prepare(
      "SELECT id, queue, message_type, event_id, body, attempts, received_at, state, note FROM dead_letters WHERE state = ? ORDER BY received_at LIMIT ?",
    )
      .bind(options.state ?? "held", Math.min(options.limit ?? 50, 500))
      .all<DeadLetterRow>()
  ).results;

export type ReplayOutcome =
  | { readonly _tag: "Replayed" }
  | { readonly _tag: "Obsolete"; readonly reason: string }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unroutable" };

/**
 * Validate a dead letter against current source state and re-enqueue it if still needed.
 *   ingest   → skip when the receipt is already committed/rejected
 *   dispatch → skip unless the send job is still `ready`
 *   others   → idempotent consumers; replay as-is
 */
export const replayDeadLetter = async (env: CoreEnv, id: string): Promise<ReplayOutcome> => {
  const row = await env.DIRECTORY.prepare(
    "SELECT id, queue, message_type, event_id, body, attempts, received_at, state, note FROM dead_letters WHERE id = ? AND state = 'held'",
  )
    .bind(id)
    .first<DeadLetterRow>();
  if (!row) return { _tag: "NotFound" };
  const body = JSON.parse(row.body) as Record<string, unknown>;
  const settle = async (state: "replayed" | "obsolete", note: string | null) =>
    env.DIRECTORY.prepare(
      "UPDATE dead_letters SET state = ?, resolved_at = ?, note = ? WHERE id = ?",
    )
      .bind(state, Date.now(), note, id)
      .run();

  if (body.type === "ingest" || body.type === "parse-scan") {
    const receipt = await env.INGRESS_JOURNALS.getByName(
      journalPartition(String(body.ingestionId)),
    ).get(String(body.ingestionId));
    if (receipt && (receipt.state === "committed" || receipt.state === "rejected")) {
      await settle("obsolete", `receipt already ${receipt.state}`);
      return { _tag: "Obsolete", reason: `receipt ${receipt.state}` };
    }
  }
  if (body.type === "dispatch") {
    const job = await mailbox(env, String(body.mailboxId)).sendJob(String(body.sendJobId));
    if (!job || job.state !== "ready") {
      await settle("obsolete", `send job ${job?.state ?? "missing"}`);
      return { _tag: "Obsolete", reason: `send job ${job?.state ?? "missing"}` };
    }
  }
  const binding = sourceBindingFor(row.queue);
  if (!binding) return { _tag: "Unroutable" };
  await env[binding].send(body, { contentType: "json" });
  await settle("replayed", null);
  metric("dlq.replayed", 1, { queue: binding });
  return { _tag: "Replayed" };
};

export const discardDeadLetter = async (env: CoreEnv, id: string, note: string): Promise<boolean> =>
  (
    await env.DIRECTORY.prepare(
      "UPDATE dead_letters SET state = 'discarded', resolved_at = ?, note = ? WHERE id = ? AND state = 'held'",
    )
      .bind(Date.now(), note.slice(0, 500), id)
      .run()
  ).meta.changes === 1;
