import { type GcBucket, pinBlob, recordGcIntent, unpinBlob } from "../blobgc.ts";
import { startErasure } from "../erasure.ts";
import { deliverNotification } from "../push.ts";
import type { TopicHandlers } from "./types.ts";

// Operational topics: blob pins held by other authorities, erasure triggered by account closure,
// and notifications raised by non-mailbox authorities (calendar reminders, space invitations).

export const opsTopics: TopicHandlers<"blob.pin" | "blob.unpin" | "account.erase" | "push.notify"> =
  {
    "blob.pin": async ({ env, payload }) => {
      await pinBlob(
        env,
        payload.bucket ?? "ORIGINALS",
        payload.key,
        payload.holderKind,
        payload.holderId,
      );
    },
    "blob.unpin": async ({ env, payload, mailboxId }) => {
      const bucket: GcBucket = payload.bucket ?? "ORIGINALS";
      await unpinBlob(env, bucket, payload.key, payload.holderKind, payload.holderId);
      // Unpinning never deletes: it only makes the key eligible for the next delayed, re-checked sweep.
      await recordGcIntent(env, {
        bucket,
        key: payload.key,
        ownerKind: "mailbox",
        ownerId: mailboxId,
        reason: `unpin:${payload.holderKind}`,
      });
    },
    "account.erase": async ({ env, payload }) => {
      await startErasure(env, payload.userId, payload.reason ?? "account closed");
    },
    "push.notify": async ({ env, message, payload }) => {
      await deliverNotification(env, {
        userId: payload.userId,
        kind: payload.kind,
        title: payload.title ?? "",
        body: payload.body ?? "",
        url: payload.url ?? "",
        resource: payload.resource ?? "",
        dedupeKey: payload.dedupeKey ?? message.eventId,
      });
    },
  };
