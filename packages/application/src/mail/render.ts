import { Context, Effect, Schema } from "effect";
import { dispatch } from "../dispatch.ts";

export class RenderFailure extends Schema.TaggedError<RenderFailure>()("RenderFailure", {
  detail: Schema.String,
}) {}

/**
 * Renders a frozen send job to MIME at its deterministic content key (idempotent put) before
 * submission. Notes, clips, and private comments are not inputs to rendering.
 */
export class OutboundRenderer extends Context.Service<
  OutboundRenderer,
  { readonly render: (mailboxId: string, sendJobId: string) => Effect.Effect<void, RenderFailure> }
>()("mail/OutboundRenderer") {}

/** Queue consumer body for a dispatch message: render (idempotent), then the §7.3 dispatch. */
export const renderAndDispatch = (mailboxId: string, sendJobId: string) =>
  Effect.gen(function* () {
    const renderer = yield* OutboundRenderer;
    yield* renderer.render(mailboxId, sendJobId);
    yield* dispatch(sendJobId);
  }).pipe(Effect.withSpan("mail.renderAndDispatch"));
