import { Schema } from "effect";

// Queue payloads carry references only, never MIME or attachments (§5.1 step 4, §6: ≤128 KB).
// Every message has an event ID for (eventId, targetId) deduplication and a schema version.

export const IngestMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("ingest"),
  eventId: Schema.String,
  ingestionId: Schema.String,
  mailboxId: Schema.String,
  recipient: Schema.String,
  envelopeFrom: Schema.String,
  objectKey: Schema.String,
  rawSize: Schema.Number,
  receivedAt: Schema.Number,
});
export type IngestMessage = typeof IngestMessage.Type;

export const DispatchMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("dispatch"),
  eventId: Schema.String,
  mailboxId: Schema.String,
  sendJobId: Schema.String,
});
export type DispatchMessage = typeof DispatchMessage.Type;

export const IndexMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("index"),
  eventId: Schema.String,
  scope: Schema.String,
  op: Schema.Literals(["upsert", "delete"]),
  docId: Schema.String,
  /** Reference to authoritative content; the indexer hydrates and never receives bodies here. */
  source: Schema.Struct({ mailboxId: Schema.String, kind: Schema.String, id: Schema.String }),
});
export type IndexMessage = typeof IndexMessage.Type;

export const NotifyMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("notify"),
  eventId: Schema.String,
  userId: Schema.String,
  kind: Schema.String,
  resource: Schema.String,
});
export type NotifyMessage = typeof NotifyMessage.Type;

/** Cross-authority propagation: source outbox → queue → idempotent target transaction (§3.2). */
export const PropagateMessage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("propagate"),
  eventId: Schema.String,
  topic: Schema.String,
  source: Schema.String,
  target: Schema.String,
  payload: Schema.Unknown,
});
export type PropagateMessage = typeof PropagateMessage.Type;

// ---- propagate payloads (one tagged union; `topic` is the tag) ----
//
// v1 producers send the topic either inside the payload or only on the envelope (`outbox(kind, …)`),
// and several optional fields are omitted by older producers. `decodePropagatePayload` is the
// lenient v1 reader: it takes the envelope topic when the payload has none and applies the
// handlers' defaults through optional fields. Excess fields are ignored.

const Str = Schema.String;
const OptStr = Schema.optional(Schema.String);
const topic = <const T extends string, F extends Schema.Struct.Fields>(name: T, fields: F) =>
  Schema.Struct({ topic: Schema.Literal(name), ...fields });

export const GcBucketSchema = Schema.Literals(["ORIGINALS", "PARTS", "EXPORTS"]);
export const WorldPublishMedia = Schema.Struct({ contentKey: Str, name: Str, contentType: Str });

export const PropagatePayload = Schema.Union([
  topic("mailbox.redeliver", {
    transferId: Str,
    messageKey: Str,
    rawSize: Schema.optional(Schema.Number),
    summary: Schema.Unknown,
  }),
  topic("scan-message", { messageKey: Str, deliveryId: Str }),
  topic("scan", { key: Str, uploadId: Str }),
  topic("blob-gc", { key: Str, reason: OptStr }),
  topic("blob.pin", {
    bucket: Schema.optional(GcBucketSchema),
    key: Str,
    holderKind: Str,
    holderId: Str,
  }),
  topic("blob.unpin", {
    bucket: Schema.optional(GcBucketSchema),
    key: Str,
    holderKind: Str,
    holderId: Str,
  }),
  topic("account.erase", { userId: Str, reason: OptStr }),
  topic("push.notify", {
    userId: Str,
    kind: Str,
    title: OptStr,
    body: OptStr,
    url: OptStr,
    resource: OptStr,
    dedupeKey: OptStr,
  }),
  topic("calendar.photo-scan", {
    key: Str,
    calendarId: Str,
    ownerId: Str,
    date: Schema.optional(Schema.Unknown),
  }),
  topic("calendar.invitation", { messageKey: Str, deliveryId: Str }),
  topic("calendar.itip", {
    method: Str,
    ics: Str,
    recipients: Schema.optional(Schema.Array(Str)),
    from: OptStr,
    summary: OptStr,
  }),
  topic("calendar.notify", {
    kind: Str,
    eventId: OptStr,
    title: OptStr,
    occurrenceKey: OptStr,
    offsetMinutes: Schema.optional(Schema.Number),
    /** The occurrence's start (reminders). */ startMs: Schema.optional(Schema.Number),
  }),
  topic("calendar.subscription.refresh", { calendarId: OptStr }),
  topic("calendar.grant", {
    calendarId: Str,
    role: Schema.optional(Schema.NullOr(Schema.Literals(["read", "write"]))),
  }),
  topic("shared.delivery", { deliveryId: Str, threadId: Str }),
  topic("world.publish", {
    fromAddress: Str,
    subject: OptStr,
    html: OptStr,
    text: OptStr,
    media: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  topic("probe.echo", { probeId: Str }),
]);
export type PropagatePayload = typeof PropagatePayload.Type;
export type PropagateTopic = PropagatePayload["topic"];

const decodePayloadSync = Schema.decodeUnknownSync(PropagatePayload);

/**
 * Lenient v1 decode of one propagate message's payload: the payload's own `topic` wins (as it did
 * before typing), else the envelope topic. Returns the typed payload, or the reason it is invalid.
 */
export const decodePropagatePayload = (
  message: Pick<PropagateMessage, "topic" | "payload">,
):
  | { readonly ok: true; readonly payload: PropagatePayload }
  | { readonly ok: false; readonly topic: string; readonly reason: string } => {
  const raw =
    message.payload !== null && typeof message.payload === "object"
      ? (message.payload as Record<string, unknown>)
      : {};
  const topicName = typeof raw.topic === "string" ? raw.topic : message.topic;
  try {
    return { ok: true, payload: decodePayloadSync({ ...raw, topic: topicName }) };
  } catch (error) {
    return {
      ok: false,
      topic: topicName,
      reason: error instanceof Error ? error.message.split("\n")[0]! : "invalid payload",
    };
  }
};

export const QueueMessage = Schema.Union([
  IngestMessage,
  DispatchMessage,
  IndexMessage,
  NotifyMessage,
  PropagateMessage,
]);
export type QueueMessage = typeof QueueMessage.Type;

export const decodeQueueMessage = Schema.decodeUnknownEffect(QueueMessage);

export const QUEUE_MESSAGE_MAX_BYTES = 128 * 1024;
