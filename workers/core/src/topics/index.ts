import { decodePropagatePayload, type PropagateTopic, type QueueMessage } from "@bye/contracts";
import type { CoreEnv } from "../env.ts";
import { calendarTopics } from "./calendar.ts";
import { mailTopics } from "./mail.ts";
import { opsTopics } from "./ops.ts";
import { probeTopics } from "./probe.ts";
import { sharedTopics } from "./shared.ts";
import type { TopicContext, TopicHandler, TopicHandlers } from "./types.ts";

export type { TopicContext, TopicHandler } from "./types.ts";

/** Every propagate topic has exactly one handler; a missing one fails to compile. */
const HANDLERS: TopicHandlers<PropagateTopic> = {
  ...mailTopics,
  ...calendarTopics,
  ...sharedTopics,
  ...opsTopics,
  ...probeTopics,
};

type PropagateEnvelope = Extract<QueueMessage, { type: "propagate" }>;

/**
 * Decode one propagate message's payload (lenient v1) and run its topic's handler. Unknown topics
 * and payloads that no deployed producer could have sent are logged and dropped: retrying cannot
 * make them valid.
 */
export const dispatchPropagate = async (
  env: CoreEnv,
  message: PropagateEnvelope,
  attempt = 1,
): Promise<void> => {
  const decoded = decodePropagatePayload(message);

  if (!decoded.ok) {
    const known = Object.hasOwn(HANDLERS, decoded.topic);
    console.warn(
      JSON.stringify(
        known
          ? {
              level: "warn",
              op: "propagate.invalid-payload",
              topic: decoded.topic,
              eventId: message.eventId,
              reason: decoded.reason,
            }
          : {
              level: "warn",
              op: "propagate.unknown-topic",
              topic: decoded.topic,
              eventId: message.eventId,
            },
      ),
    );

    return;
  }

  const handler = HANDLERS[decoded.payload.topic] as TopicHandler;
  await handler({
    env,
    message,
    payload: decoded.payload,
    mailboxId: message.source.replace(/^mailbox:/, ""),
    attempt,
  } satisfies TopicContext);
};
