import { WorldPublishMedia } from "@bye/contracts";
import { Schema } from "effect";
import { ControlSharedRegistry, isRejection } from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import { mailbox, settle, sharedMessageOf, space } from "../authorities.ts";
import type { CoreEnv } from "../env.ts";
import { publishForAuthor } from "../publishing.ts";
import { ownerOfMailbox, type TopicHandlers } from "./types.ts";

// Collaboration, publishing and account topics.
//
// Mailbox hooks (emitted by the mailbox authority's outbox after a committed delivery/send):
//   - `shared.delivery` {deliveryId, threadId}: every committed inbound delivery. Routes mail for
//     extension mailboxes into their shared space (O03) and appends replies to threads shared with
//     "include future messages" (O04). Both targets consume idempotently by event ID.
//   - `world.publish` {fromAddress, subject, html, text, media?}: an authenticated internal send to
//     `world@<service domain>` (P01). The operation is built here from the mailbox owner, so inbound
//     SMTP can never reach it.

const isWorldMedia = Schema.is(WorldPublishMedia);

// ---- delayed shared propagation (§6 row 6) ----
//
// Every (target space, delivery) pair gets a `shared_propagation` row that stays `pending` until
// the space has applied the copy: members see "syncing" instead of a silently missing message, and
// the Cron reconciler replays rows whose queue message was lost, re-deriving everything from
// source state (registry + mailbox). Space operations are idempotent by event ID, so replays and
// duplicate deliveries are no-ops.

type PropagationTarget = {
  readonly key: string;
  readonly spaceId: string;
  readonly kind: "extension" | "reply";
  readonly sharedThreadId: string | null;
};

const setPropagation = (env: CoreEnv, key: string, state: "applied" | "dropped") =>
  env.DIRECTORY.prepare(
    "UPDATE shared_propagation SET state = ?, updated_at = ? WHERE event_key = ? AND state = 'pending'",
  )
    .bind(state, Date.now(), key)
    .run();

const FINAL_REFUSALS = new Set(["not_found", "forbidden", "gone"]);

/** Propagate one committed delivery into every space that should hold it; throws to retry. */
export const propagateDelivery = async (
  env: CoreEnv,
  mailboxId: string,
  threadId: string,
  deliveryId: string,
): Promise<void> => {
  const registry = new ControlSharedRegistry(env.DIRECTORY, kernelClock);

  const [extension, links] = await Promise.all([
    registry.extensionFor(mailboxId),
    registry.sharedThreadsFor(mailboxId, threadId),
  ]);

  const targets: Array<PropagationTarget> = [
    ...(extension
      ? [
          {
            key: `extension:${extension.spaceId}:${deliveryId}`,
            spaceId: extension.spaceId,
            kind: "extension" as const,
            sharedThreadId: null,
          },
        ]
      : []),
    ...links
      .filter((l) => l.includeFuture)
      .map((l) => ({
        key: `reply:${l.spaceId}:${deliveryId}`,
        spaceId: l.spaceId,
        kind: "reply" as const,
        sharedThreadId: l.sharedThreadId,
      })),
  ];

  // Pending rows for this delivery whose target no longer applies (extension moved to another
  // space, share no longer includes future mail) can never be applied: drop them, so they neither
  // show "syncing" forever nor crowd the replay window.
  // The current keys bind as ONE JSON parameter (`json_each`), so the list is never bounded by
  // D1's 100-parameter limit however many spaces share the thread.
  const current = targets.map((t) => t.key);
  await env.DIRECTORY.prepare(
    `UPDATE shared_propagation SET state = 'dropped', updated_at = ? WHERE mailbox_id = ? AND delivery_id = ? AND state = 'pending' AND event_key NOT IN (SELECT value FROM json_each(?))`,
  )
    .bind(Date.now(), mailboxId, deliveryId, JSON.stringify(current))
    .run();

  if (targets.length === 0) return;
  const now = Date.now();
  await env.DIRECTORY.batch(
    targets.map((t) =>
      env.DIRECTORY.prepare(
        `INSERT INTO shared_propagation (event_key, space_id, kind, shared_thread_id, mailbox_id, thread_id, delivery_id, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (event_key) DO NOTHING`,
      ).bind(t.key, t.spaceId, t.kind, t.sharedThreadId, mailboxId, threadId, deliveryId, now, now),
    ),
  );
  const selected = await sharedMessageOf(env, mailboxId, threadId, [deliveryId]);

  const d = selected?.messages[0]
    ? { subject: selected.subject, message: selected.messages[0] }
    : null;

  if (!d) {
    // The source is gone (deleted or erased): nothing will ever be applied.
    for (const t of targets) await setPropagation(env, t.key, "dropped");

    return;
  }

  let failure: unknown;

  for (const t of targets) {
    try {
      const stub = space(env, t.spaceId);
      let enroll: { readonly board: string } | undefined;

      if (t.kind === "extension") {
        ({ enroll } = await settle(
          stub.receiveExtensionMail(`ext:${deliveryId}`, {
            address: extension!.address,
            sourceMailboxId: mailboxId,
            sourceThreadId: threadId,
            subject: d.subject,
            message: d.message,
          }),
        ));
      } else {
        await settle(stub.appendReply(`reply:${deliveryId}`, mailboxId, threadId, d.message));
      }

      if (enroll) {
        // Workflow enrollment in the extension mailbox; the command ID makes replays no-ops.
        await mailbox(env, mailboxId).execute({
          _tag: "AddToBoard",
          commandId: `ext-enroll-${deliveryId}`,
          boardId: enroll.board,
          threadId,
        });
      }

      await setPropagation(env, t.key, "applied");
    } catch (error) {
      // Business refusals (revoked share, removed extension) are final; anything else retries.
      if (isRejection(error) && FINAL_REFUSALS.has(error.code)) {
        await setPropagation(env, t.key, "dropped");
        continue;
      }

      failure ??= error;
      await env.DIRECTORY.prepare(
        "UPDATE shared_propagation SET attempts = attempts + 1, updated_at = ? WHERE event_key = ? AND state = 'pending'",
      )
        .bind(Date.now(), t.key)
        .run()
        .catch(() => undefined);
    }
  }

  if (failure) throw failure;
};

/** Cron replay of propagations still pending after `olderThanMs` (lost or dead-lettered messages). */
export const replayPendingPropagation = async (
  env: CoreEnv,
  now: number,
  olderThanMs = 10 * 60_000,
  limit = 100,
): Promise<{ readonly replayed: number; readonly failed: number }> => {
  const rows = await env.DIRECTORY.prepare(
    "SELECT DISTINCT mailbox_id, thread_id, delivery_id FROM shared_propagation WHERE state = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT ?",
  )
    .bind(now - olderThanMs, limit)
    .all<{ mailbox_id: string; thread_id: string; delivery_id: string }>();

  let replayed = 0;
  let failed = 0;

  for (const r of rows.results) {
    try {
      await propagateDelivery(env, r.mailbox_id, r.thread_id, r.delivery_id);
      replayed++;
    } catch {
      failed++;
    }
  }

  return { replayed, failed };
};

/** Pending propagation into a space (or one of its shared threads), shown to members as "syncing". */
export const pendingPropagation = async (
  env: CoreEnv,
  spaceId: string,
  sharedThreadId?: string,
): Promise<number> => {
  const row = await (
    sharedThreadId
      ? env.DIRECTORY.prepare(
          "SELECT COUNT(*) AS n FROM shared_propagation WHERE space_id = ? AND state = 'pending' AND shared_thread_id = ?",
        ).bind(spaceId, sharedThreadId)
      : env.DIRECTORY.prepare(
          "SELECT COUNT(*) AS n FROM shared_propagation WHERE space_id = ? AND state = 'pending'",
        ).bind(spaceId)
  ).first<{ n: number }>();

  return Number(row?.n ?? 0);
};

export const sharedTopics: TopicHandlers<"shared.delivery" | "world.publish"> = {
  "shared.delivery": async ({ env, payload, mailboxId }) => {
    const { deliveryId, threadId } = payload;

    if (!deliveryId || !threadId) return;
    await propagateDelivery(env, mailboxId, threadId, deliveryId);
  },
  "world.publish": async ({ env, message, payload, mailboxId }) => {
    const owner = await ownerOfMailbox(env, mailboxId);

    if (!owner) return;

    // Malformed or non-image media entries are skipped, not fatal (lenient v1).
    const media = (payload.media ?? [])
      .filter(isWorldMedia)
      .filter((m) => m.contentType.startsWith("image/"));

    try {
      await publishForAuthor(
        env,
        owner.user_id,
        {
          fromAddress: payload.fromAddress,
          title: (payload.subject ?? "").slice(0, 300) || "Untitled",
          html: payload.html ?? "",
          text: payload.text ?? "",
          media,
          publish: true,
        },
        message.eventId,
      );
    } catch (e) {
      // A refused publish (identity not the author's) is final; infrastructure failures retry.
      if (isRejection(e)) return;
      throw e;
    }
  },
};
