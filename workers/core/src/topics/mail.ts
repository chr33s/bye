import { classifyKey, copyMessageForTransfer, recordGcIntent } from "../blobgc.ts";
import type { CoreEnv } from "../env.ts";
import { scanStoredObject } from "../scan.ts";
import type { TopicHandlers } from "./types.ts";
import { mailbox } from "../authorities.ts";

// Mailbox topics: authorized redelivery, scanning, blob lifecycle.
export const mailTopics: TopicHandlers<"mailbox.redeliver" | "scan-message" | "scan" | "blob-gc"> =
  {
    "mailbox.redeliver": async ({ env, message: m, payload }) => {
      // The summary was produced by the source mailbox from the same codec; it is carried opaquely.
      const summary = payload.summary as Parameters<
        ReturnType<CoreEnv["MAILBOXES"]["getByName"]>["receiveTransfer"]
      >[0]["summary"];
      // The target gets its own copy of the bytes, so the source's GC can never delete them.
      const copy = await copyMessageForTransfer(env, {
        sourceKey: payload.messageKey,
        targetMailboxId: m.target,
        transferId: payload.transferId,
      });
      await mailbox(env, m.target).receiveTransfer({
        transferId: payload.transferId,
        ingestionId: payload.transferId,
        recipient: "",
        messageKey: copy.messageKey,
        rawSize: payload.rawSize ?? 0,
        summary,
        safety: { _tag: "Clean" },
        receivedAt: Date.now(),
      });
      return;
    },
    "scan-message": async ({ env, payload, mailboxId, attempt }) => {
      // Whole-message scan after commit (§10): the stored original goes to ClamAV once; attachments
      // stay blocked until the verdict is clean, and infected mail is quarantined.
      const result = await scanStoredObject(env, payload.messageKey, attempt, {
        bucket: "ORIGINALS",
        preFilter: false,
      });
      await mailbox(env, mailboxId).recordDeliveryScan(
        payload.deliveryId,
        result.outcome,
        result.signature,
      );
      return;
    },
    scan: async ({ env, payload, mailboxId, attempt }) => {
      // Uploads enter scanning before sending (§10): pre-filter, then the isolated ClamAV container.
      const result = await scanStoredObject(env, payload.key, attempt);
      await mailbox(env, mailboxId).setScanResult(payload.uploadId, result.outcome);
      return;
    },
    "blob-gc": async ({ env, payload, mailboxId }) => {
      // Reference-aware, delayed GC (§12): record an intent only; the daily sweep deletes after the
      // delay and a fresh reference check.
      const { key } = payload;
      const shape = classifyKey(key);
      const reason =
        shape.kind === "upload" && !String(payload.reason).startsWith("upload-")
          ? `upload-${String(payload.reason)}`
          : (payload.reason ?? "unspecified");
      const bucket =
        shape.kind === "upload" || shape.kind === "body" || shape.kind === "part"
          ? "PARTS"
          : shape.kind === "export"
            ? "EXPORTS"
            : "ORIGINALS";
      await recordGcIntent(env, { bucket, key, ownerKind: "mailbox", ownerId: mailboxId, reason });
    },
  };
