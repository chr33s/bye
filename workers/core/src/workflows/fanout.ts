import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";
import { approveNewsletter, runNewsletter } from "../newsletter.ts";
import { renderPublished, siteRendered } from "../publishing.ts";
import type { CoreEnv } from "../env.ts";
import { decodeParams, promiseStep } from "./common.ts";

// The durable half of World publishing (P01) and its newsletter (P02, spec.md §5.5). For a
// committed post version it first finishes the public side effects (media copies, site rewrite +
// purge) if the synchronous attempt at publish time did not, then approves ONE newsletter
// publication for the version (immutable content + recipient snapshot) and drives it through the
// NewsletterProvider. Newsletters never go through individual-message transports. Without a
// configured, qualified provider nothing is approved or sent. Later passes (sync lag, provider
// reconciliation) continue from the 5-minute cron.
// Each step runs a fresh call and persists only a small serializable summary (§7.4).

export const FanoutParams = Schema.Struct({
  v: Schema.Literal(1),
  handle: Schema.String,
  userId: Schema.String,
  postId: Schema.String,
  revision: Schema.optional(Schema.Number),
  /** Private→public media copies for this version (absent on instances created before v1 carried them). */
  copies: Schema.optional(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
});

export type FanoutParams = typeof FanoutParams.Type;

/** Passes this instance makes before leaving the rest to the cron reconciler. */
export const FANOUT_PASSES = 6;

const Approval = Schema.Struct({
  publicationId: Schema.NullOr(Schema.String),
  blocked: Schema.NullOr(Schema.String),
});

const Pass = Schema.Struct({
  state: Schema.NullOr(Schema.String),
  blocked: Schema.NullOr(Schema.String),
  synced: Schema.Number,
});

const SETTLED = new Set(["sent", "cancelled", "failed", "held"]);

export class FanoutWorkflow extends WorkflowEntrypoint<CoreEnv, FanoutParams> {
  override async run(event: Readonly<WorkflowEvent<FanoutParams>>, step: WorkflowStep) {
    const params = decodeParams(FanoutParams)(event.payload);

    // Publish resume: render only if the synchronous attempt didn't record this version as done.
    if (params.revision !== undefined) {
      const plan = {
        postId: params.postId,
        revision: params.revision,
        copies: params.copies ?? [],
      };

      await promiseStep(step, "v1:site", Schema.Boolean, async () => {
        if (await siteRendered(this.env, params.handle, plan.postId, plan.revision)) return false;
        await renderPublished(this.env, params.handle, plan);

        return true;
      });
    }

    if (params.revision === undefined) return { blocked: "no post revision" };
    const revision = params.revision;

    const approval = await promiseStep(step, "v2:approve", Approval, async () => {
      const r = await approveNewsletter(this.env, params.handle, params.postId, revision);

      return "blocked" in r
        ? { publicationId: null, blocked: r.blocked }
        : { publicationId: r.id, blocked: null };
    });

    if (approval.blocked) return { blocked: approval.blocked };
    let last: typeof Pass.Type = { state: null, blocked: null, synced: 0 };

    for (let pass = 0; pass < FANOUT_PASSES; pass++) {
      last = await promiseStep(
        step,
        `v2:pass:${pass}`,
        Pass,
        async () => {
          const r = await runNewsletter(this.env, params.handle);

          return {
            state: r.publication?.id === approval.publicationId ? r.publication.state : null,
            blocked: r.blocked ?? null,
            synced: r.synced,
          };
        },
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
      );

      if (last.blocked || (last.state && SETTLED.has(last.state)) || last.state === null) break;
      await step.sleep(`v2:wait:${pass}`, "1 minute");
    }

    return { publicationId: approval.publicationId, ...last };
  }
}
