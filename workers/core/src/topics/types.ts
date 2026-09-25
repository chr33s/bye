import type { PropagatePayload, PropagateTopic, QueueMessage } from "@bye/contracts";
import type { CoreEnv } from "../env.ts";

// Propagate-queue topic handlers (§3.2 source outbox → queue → idempotent target transaction).
// Each area registers its topics in its own module; ./index.ts merges them. A handler must be
// idempotent: messages are delivered at least once and replayed from source state.

export interface TopicContext<T extends PropagateTopic = PropagateTopic> {
  readonly env: CoreEnv;
  readonly message: Extract<QueueMessage, { type: "propagate" }>;
  /** The decoded payload for this topic (`PropagatePayload`, lenient v1 decode). */
  readonly payload: Extract<PropagatePayload, { readonly topic: T }>;
  /** Source mailbox ID when the source is `mailbox:<id>`. */
  readonly mailboxId: string;
  readonly attempt: number;
}

export type TopicHandler<T extends PropagateTopic = PropagateTopic> = (
  ctx: TopicContext<T>,
) => Promise<void>;

/** Handlers for a set of topics, each receiving its own payload type. */
export type TopicHandlers<T extends PropagateTopic> = { readonly [K in T]: TopicHandler<K> };

export const ownerOfMailbox = (env: CoreEnv, mailboxId: string) =>
  env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT u.id AS user_id, u.primary_address AS address, c.id AS calendar_id FROM mailboxes m JOIN users u ON u.id = m.owner_user_id LEFT JOIN calendars c ON c.owner_user_id = u.id WHERE m.id = ? ORDER BY c.id LIMIT 1",
    )
    .bind(mailboxId)
    .first<{ user_id: string; address: string; calendar_id: string | null }>();
