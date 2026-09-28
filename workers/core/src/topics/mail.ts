import { classifyKey, copyMessageForTransfer, recordGcIntent } from "../blobgc.ts";
import type { CoreEnv } from "../env.ts";
import { scanStoredObject } from "../scan.ts";
import type { TopicHandlers } from "./types.ts";
import { mailbox } from "../authorities.ts";

// Mailbox topics: authorized redelivery, scanning, blob lifecycle.

/**
 * Redelivery authority is re-checked at commit time, not trusted from when a rule or command was
 * written (E19): some active user of the source mailbox must still hold active send access to the
 * target (active account, active memberships in both orgs, active mailboxes, `can_send`). A member
 * removed or suspended from the target's org can no longer inject Screener-bypassing mail into it.
 */
const redeliveryAuthorized = async (
  env: CoreEnv,
  sourceMailboxId: string,
  targetMailboxId: string,
): Promise<boolean> =>
  (await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT 1 AS ok FROM mailbox_access sa
       JOIN mailboxes sm ON sm.id = sa.mailbox_id
       JOIN memberships sms ON sms.org_id = sm.org_id AND sms.user_id = sa.user_id
       JOIN users u ON u.id = sa.user_id
       JOIN mailbox_access ta ON ta.user_id = sa.user_id AND ta.mailbox_id = ?
       JOIN mailboxes tm ON tm.id = ta.mailbox_id
       JOIN memberships tms ON tms.org_id = tm.org_id AND tms.user_id = sa.user_id
       WHERE sa.mailbox_id = ? AND ta.can_send = 1 AND u.status = 'active'
         AND sm.status = 'active' AND sms.status = 'active'
         AND tm.status = 'active' AND tms.status = 'active'
       LIMIT 1`,
    )
    .bind(targetMailboxId, sourceMailboxId)
    .first<{ ok: number }>()) !== null;

export const mailTopics: TopicHandlers<"mailbox.redeliver" | "scan-message" | "scan" | "blob-gc"> =
  {
    "mailbox.redeliver": async ({ env, message: m, payload, mailboxId }) => {
      if (mailboxId === m.target || !(await redeliveryAuthorized(env, mailboxId, m.target))) {
        // Retrying cannot restore authority; the transfer is dropped (the source keeps its copy).
        console.warn(
          JSON.stringify({
            level: "warn",
            op: "mailbox.redeliver.unauthorized",
            transferId: payload.transferId,
          }),
        );

        return;
      }

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
      const parsed = classifyKey(key);

      const reason =
        parsed.kind === "upload" && !String(payload.reason).startsWith("upload-")
          ? `upload-${String(payload.reason)}`
          : (payload.reason ?? "unspecified");

      const bucket =
        parsed.kind === "upload" || parsed.kind === "body" || parsed.kind === "part"
          ? "PARTS"
          : parsed.kind === "export"
            ? "EXPORTS"
            : "ORIGINALS";

      await recordGcIntent(env, { bucket, key, ownerKind: "mailbox", ownerId: mailboxId, reason });
    },
  };
