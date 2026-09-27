import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";
import type { CoreEnv } from "../env.ts";
import {
  eraseCalendarContent,
  eraseMailboxContent,
  eraseSpaceMembership,
  eraseUserRows,
  eraseWorldAuthor,
  fenceErasedMailbox,
  spaceMemberTombstoneId,
  worldTombstoneId,
  writeTombstone,
} from "../erasure.ts";
import { decodeParams, promiseStep } from "./common.ts";

export const EraseParamsSchema = Schema.Struct({
  v: Schema.Literal(1),
  userId: Schema.String,
  mailboxIds: Schema.Array(Schema.String),
  calendarIds: Schema.optional(Schema.Array(Schema.String)),
  spaceIds: Schema.optional(Schema.Array(Schema.String)),
  worldHandle: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.String),
});
export type EraseParams = typeof EraseParamsSchema.Encoded;

/**
 * Erasure (§12): tombstones first, then every resource kind — mailbox blobs/indexes/authority,
 * calendars, shared-space membership, published copies, credentials and D1 rows. Every step is
 * idempotent; tombstone replay re-applies it after any restore.
 */
export class EraseWorkflow extends WorkflowEntrypoint<CoreEnv, EraseParams> {
  override async run(event: Readonly<WorkflowEvent<EraseParams>>, step: WorkflowStep) {
    const p = decodeParams(EraseParamsSchema)(event.payload);
    const env = this.env;
    // Step results are Schema-encoded checkpoints (§7.4); names are unchanged from earlier releases.
    await promiseStep(step, "v1:tombstones", Schema.Boolean, async () => {
      await writeTombstone(env, "user", p.userId);
      for (const id of p.mailboxIds) await writeTombstone(env, "mailbox", id);
      // Closed + routes disabled before any content is removed, so no new mail is accepted.
      for (const id of p.mailboxIds) await fenceErasedMailbox(env, id);
      for (const id of p.calendarIds ?? []) await writeTombstone(env, "calendar", id);
      for (const spaceId of p.spaceIds ?? [])
        await writeTombstone(env, "space-member", spaceMemberTombstoneId(spaceId, p.userId));
      if (p.worldHandle)
        await writeTombstone(env, "world", worldTombstoneId(p.worldHandle, p.userId));
      return true;
    });
    for (const mailboxId of p.mailboxIds) {
      await promiseStep(
        step,
        `v1:mailbox:${mailboxId}`,
        Schema.Number,
        () => eraseMailboxContent(env, mailboxId),
        { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } },
      );
    }
    for (const calendarId of p.calendarIds ?? []) {
      await promiseStep(step, `v1:calendar:${calendarId}`, Schema.Boolean, () =>
        eraseCalendarContent(env, calendarId),
      );
    }
    for (const spaceId of p.spaceIds ?? []) {
      await promiseStep(step, `v1:space:${spaceId}`, Schema.Boolean, () =>
        eraseSpaceMembership(env, spaceId, p.userId),
      );
    }
    if (p.worldHandle) {
      const handle = p.worldHandle;
      await promiseStep(step, "v1:published", Schema.Boolean, () =>
        eraseWorldAuthor(env, handle, p.userId).then(() => true),
      );
    }
    await promiseStep(step, "v1:user-rows", Schema.Boolean, () =>
      eraseUserRows(env, p.userId).then(() => true),
    );
    return { v: 1, erased: p.mailboxIds.length, userId: p.userId };
  }
}
