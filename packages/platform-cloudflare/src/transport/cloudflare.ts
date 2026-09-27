import { type Acceptance, type Submission, TransportFailure } from "@bye/application";
import {
  CLOUDFLARE_PERSONAL_CAPABILITIES,
  CLOUDFLARE_TRANSACTIONAL_CAPABILITIES,
  type TransportCapabilities,
} from "@bye/domain";
import { Effect } from "effect";
import { dkimSign, type DkimKey } from "./dkim.ts";
import type { TransportAdapter } from "./router.ts";

/** Narrow shape of the Workers `send_email` binding used with raw MIME (§5.3, [C12]). */
export interface SendEmailBindingLike {
  send(message: {
    readonly from: string;
    readonly to: string | ReadonlyArray<string>;
    readonly raw: ReadableStream<Uint8Array> | string;
  }): Promise<{ readonly messageId?: string } | void>;
}

export interface RawContentSource {
  /** Fetch rendered MIME by content key from private storage. */
  readonly load: (
    contentKey: string,
  ) => Promise<ReadableStream<Uint8Array> | Uint8Array | string | null>;
}

/**
 * Load raw MIME as bytes, never through a text decoder: 8-bit bodies and non-UTF-8 charsets must
 * reach the provider byte-for-byte. Strings (rendered in-process) are UTF-8 encoded.
 */
export const loadRawBytes = async (
  content: RawContentSource,
  contentKey: string,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const body = await content.load(contentKey);
  if (body === null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
};

/**
 * Classify a provider error. Validation/policy errors are permanent; errors raised before the
 * request left the isolate are retryable; anything after (timeouts, resets) is Unknown, because the
 * provider may already have accepted the message (§5.2 ambiguous send).
 */
export const classifyCloudflareSendError = (
  error: unknown,
  phase: "before-request" | "in-flight",
): TransportFailure => {
  const message = error instanceof Error ? error.message : String(error);
  // Throttling/quota/transient provider errors mean "not accepted, try later" — checked before the
  // permanent patterns, which would otherwise match e.g. "rate limit exceeded".
  if (phase === "before-request" || /rate|quota|temporar|try again/i.test(message))
    return new TransportFailure({
      kind: "RetryableBeforeAcceptance",
      detail: message.slice(0, 300),
    });
  if (
    /not (allowed|verified|authorized)|invalid|rejected|forbidden|too large|limit/i.test(message)
  ) {
    return new TransportFailure({ kind: "Rejected", detail: message.slice(0, 300) });
  }
  return new TransportFailure({ kind: "Unknown", detail: message.slice(0, 300) });
};

export const makeCloudflareTransactionalTransport = (
  binding: SendEmailBindingLike,
  content: RawContentSource,
  capabilities: TransportCapabilities = CLOUDFLARE_TRANSACTIONAL_CAPABILITIES,
): TransportAdapter => ({
  capabilities,
  submit: (submission: Submission) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => content.load(submission.contentKey),
        catch: (e) => classifyCloudflareSendError(e, "before-request"),
      });
      if (raw === null)
        return yield* new TransportFailure({
          kind: "RetryableBeforeAcceptance",
          detail: "rendered content missing",
        });
      const result = yield* Effect.tryPromise({
        try: () =>
          binding.send({
            from: submission.from,
            to: submission.envelopeRecipients,
            raw: raw instanceof Uint8Array ? new Response(raw).body! : raw,
          }),
        catch: (e) => classifyCloudflareSendError(e, "in-flight"),
      });
      // Cloudflare controls the wire Message-ID; the acceptance ID is not assumed to equal it.
      const acceptance: Acceptance = {
        providerId: (result && result.messageId) || `cf:${submission.sendJobId}`,
      };
      return acceptance;
    }).pipe(Effect.withSpan("transport.cloudflare.submit")),
});

/**
 * Personal correspondence over the Cloudflare `send_email` binding (MAIL_TRAFFIC_CLASSES must
 * enable `personal`). The rendered MIME is DKIM-signed with the installation key when one is
 * configured, then sent once per envelope recipient (the binding takes one recipient per message;
 * Bcc recipients never appear in headers). A failure before any recipient was accepted is
 * classified as usual; after a partial acceptance it is Unknown, so dispatch never re-sends to
 * recipients who already have the message.
 */
export const makeCloudflarePersonalTransport = (
  binding: SendEmailBindingLike,
  content: RawContentSource,
  dkimKey: (() => Promise<DkimKey | null>) | null,
  capabilities: TransportCapabilities = CLOUDFLARE_PERSONAL_CAPABILITIES,
): TransportAdapter => ({
  capabilities,
  submit: (submission: Submission) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => loadRawBytes(content, submission.contentKey),
        catch: (e) => classifyCloudflareSendError(e, "before-request"),
      });
      if (raw === null)
        return yield* new TransportFailure({
          kind: "RetryableBeforeAcceptance",
          detail: "rendered content missing",
        });
      const bytes = yield* Effect.tryPromise({
        try: async () => {
          const key = dkimKey ? await dkimKey() : null;
          if (!key) return raw;
          const signed = await dkimSign(raw, key);
          return signed._tag === "Signed" ? signed.raw : raw;
        },
        catch: () =>
          new TransportFailure({
            kind: "RetryableBeforeAcceptance",
            detail: "DKIM signing key could not be used",
          }),
      });
      const accepted: Array<string> = [];
      for (const recipient of submission.envelopeRecipients) {
        const result = yield* Effect.tryPromise({
          try: () =>
            binding.send({ from: submission.from, to: recipient, raw: new Response(bytes).body! }),
          catch: (e) =>
            accepted.length === 0
              ? classifyCloudflareSendError(e, "in-flight")
              : new TransportFailure({
                  kind: "Unknown",
                  detail: `accepted for ${accepted.length} of ${submission.envelopeRecipients.length} recipients before a failure`,
                }),
        });
        accepted.push(
          (result && result.messageId) || `cf:${submission.sendJobId}:${accepted.length}`,
        );
      }
      const acceptance: Acceptance = { providerId: accepted.join(",") };
      return acceptance;
    }).pipe(Effect.withSpan("transport.cloudflare.personal.submit")),
});
