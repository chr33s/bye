import { ControlSharedRegistry } from "@bye/platform-cloudflare";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";
import { mailbox, space } from "../authorities.ts";
import { pinBlob } from "../blobgc.ts";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { mailboxShardNames } from "../erasure.ts";
import { decodeParams, promiseStep } from "./common.ts";

export const ReindexParamsSchema = Schema.Struct({
  v: Schema.Literal(1),
  mailboxId: Schema.String,
});

export type ReindexParams = typeof ReindexParamsSchema.Encoded;

const PageResult = Schema.Struct({ next: Schema.NullOr(Schema.String), count: Schema.Number });

/** Rebuild a mailbox search shard from authoritative state, page by page (§6 "index can rebuild"). */
export class ReindexWorkflow extends WorkflowEntrypoint<CoreEnv, ReindexParams> {
  override async run(event: Readonly<WorkflowEvent<ReindexParams>>, step: WorkflowStep) {
    const { mailboxId } = decodeParams(ReindexParamsSchema)(event.payload);
    const env = this.env;
    await promiseStep(step, "v1:clear", Schema.Boolean, async () => {
      // Every shard the mailbox has used, not only the base shard (rollover shards included).
      for (const shard of await mailboxShardNames(env, mailboxId))
        await env.SEARCH_SHARDS.getByName(shard).clear();

      return true;
    });

    const enqueue = (docs: ReadonlyArray<{ kind: string; id: string }>) =>
      env.INDEX.sendBatch(
        docs.map((d) => ({
          body: {
            schemaVersion: 1,
            type: "index",
            eventId: `reindex:${event.instanceId}:${d.kind}:${d.id}`,
            scope: mailboxId,
            op: "upsert",
            docId: `${d.kind}:${d.id}`,
            source: { mailboxId, kind: d.kind, id: d.id },
          },
          contentType: "json" as const,
        })),
      );

    let cursor: string | null = null;
    let page = 0;
    let total = 0;

    do {
      const current: string | null = cursor;

      const result = await promiseStep(step, `v1:deliveries:${page++}`, PageResult, async () => {
        const p = await mailbox(env, mailboxId).exportManifestPage(current, 100);

        if (p.deliveries.length)
          await enqueue(p.deliveries.map((d) => ({ kind: "delivery", id: d.deliveryId })));

        return { next: p.nextCursor, count: p.deliveries.length };
      });

      total += result.count;
      cursor = result.next;
    } while (cursor);

    total += await promiseStep(step, "v1:other-docs", Schema.Number, async () => {
      const m = await mailbox(env, mailboxId).exportSettings();

      const docs = [
        ...m.contacts.map((c) => ({ kind: "contact", id: c.contactId })),
        ...m.notes.map((n) => ({ kind: "note", id: n.noteId })),
        ...m.clips.map((c) => ({ kind: "clip", id: c.clipId })),
      ];

      for (let i = 0; i < docs.length; i += 100) await enqueue(docs.slice(i, i + 100));

      return docs.length;
    });

    // Pin backfill (§12): content shared before spaces pinned what they copy has no pin, so blob GC
    // could collect it after the owner's purge. Re-pin every key each holding space still reads.
    // Idempotent (INSERT OR IGNORE), so re-running a reindex is harmless.
    const spaces = await promiseStep(step, "v1:pin-spaces", Schema.Array(Schema.String), () =>
      new ControlSharedRegistry(env.DIRECTORY, kernelClock)
        .spacesHoldingMailbox(mailboxId)
        .then((s) => [...s]),
    );

    let pinned = 0;

    for (const spaceId of spaces) {
      pinned += await promiseStep(step, `v1:pins:${spaceId}`, Schema.Number, async () => {
        const stub = space(env, spaceId);
        let after: string | null = null;
        let count = 0;

        for (;;) {
          const r = await stub.contentKeys(`t/${mailboxId}/`, after, 500);

          // A failed read must fail the step (so it retries), never count as "no keys left":
          // that would silently skip pins and let blob GC collect content the space still reads.
          if (!r.ok) throw new Error(`space ${spaceId} content keys unavailable`);
          const keys = r.value;

          for (const key of keys) await pinBlob(env, "ORIGINALS", key, "space", spaceId);
          count += keys.length;

          if (keys.length < 500) return count;
          after = keys.at(-1)!;
        }
      });
    }

    return { v: 1, mailboxId, enqueued: total, pinned };
  }
}
