import { Effect } from "effect";
import { ApiError } from "@bye/contracts";
import type { MailboxSelection } from "@bye/application";
import {
  type MailboxDelivery,
  type MailboxThread,
  publicError,
  reject,
  type RejectionCode,
} from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";

// Typed access to the authorities (Durable Objects). One place builds instance names; one helper
// unwraps their `RpcResult` envelopes, so no caller re-types a stub or casts its result.

export const mailbox = (env: CoreEnv, id: string) => env.MAILBOXES.getByName(id);

export const calendar = (env: CoreEnv, id: string) => env.CALENDARS.getByName(id);

export const space = (env: CoreEnv, spaceId: string) =>
  env.SHARED_SPACES.getByName(`space:${spaceId}`);

export const world = (env: CoreEnv, handle: string) =>
  env.SHARED_SPACES.getByName(`world:${handle}`);

/** The success value carried by an authority's `RpcResult` envelope. */
export type Settled<R> = R extends { readonly ok: true; readonly value: infer A } ? A : never;

type SharedMessage = Effect.Success<
  ReturnType<MailboxSelection["Service"]["selectMessages"]>
>["messages"][number];

type RejectionDetails = NonNullable<Parameters<typeof publicError>[1]>;

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: RejectionCode;
      readonly message: string;
      readonly details?: RejectionDetails;
    };

/**
 * Run one authority call as an Effect: the value, or its rejection as the public error (one
 * mapping, `publicError`). A transport failure stays a defect.
 */
export const call = <R extends Envelope>(
  f: () => Promise<R>,
): Effect.Effect<Settled<R>, ApiError> =>
  Effect.flatMap(Effect.promise(f), (r) => {
    if (r.ok) return Effect.succeed(r.value as Settled<R>);
    const pub = publicError(r.code, r.details);

    return Effect.fail(
      new ApiError(
        pub.details
          ? { code: pub.code, message: r.message, details: { ...pub.details } }
          : { code: pub.code, message: r.message },
      ),
    );
  });

/** Promise form for queue/workflow code: the value, or the rejection re-raised as `Rejection`. */
export const settle = async <R extends Envelope>(p: Promise<R>): Promise<Settled<R>> => {
  const r = await p;

  return r.ok ? (r.value as Settled<R>) : reject(r.code, r.message, r.details);
};

/** Like `settle`, but a refusal with one of `codes` (e.g. not_found) yields `null`. */
export const settleOr = async <R extends Envelope>(
  p: Promise<R>,
  ...codes: ReadonlyArray<RejectionCode>
): Promise<Settled<R> | null> => {
  const r = await p;

  if (r.ok) return r.value as Settled<R>;

  return codes.includes(r.code) ? null : reject(r.code, r.message, r.details);
};

/**
 * The selected messages of one mailbox thread as shared-resource copies (`null` when the thread is
 * gone). The one place that reads a thread for sharing: Bcc is never carried into shared
 * resources, and hidden recipients are not inferred. `MailboxDO.thread` is typed `unknown` over
 * RPC (its store type isn't Serializable), so its shape is restated here once.
 */
export const sharedMessageOf = async (
  env: CoreEnv,
  mailboxId: string,
  threadId: string,
  refs: ReadonlyArray<string>,
): Promise<{
  readonly subject: string;
  readonly messages: ReadonlyArray<SharedMessage>;
} | null> => {
  const detail = (await settleOr(mailbox(env, mailboxId).thread(threadId), "not_found")) as {
    readonly thread: MailboxThread;
    readonly deliveries: ReadonlyArray<MailboxDelivery>;
  } | null;

  if (!detail) return null;
  const wanted = new Set(refs);

  return {
    subject: detail.thread.subject,
    messages: detail.deliveries
      .filter((d) => wanted.has(d.deliveryId))
      .map((d) => ({
        messageRef: d.deliveryId,
        from: d.from,
        to: d.to,
        cc: d.cc,
        subject: d.subject,
        snippet: d.snippet,
        contentKey: d.messageKey,
        sentAt: d.date,
      })),
  };
};
