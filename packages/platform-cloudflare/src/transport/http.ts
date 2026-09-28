import type { Types } from "effect";
import { type Acceptance, type Submission, TransportFailure } from "@bye/application";
import type { TransportCapabilities } from "@bye/domain";
import { Effect, Option, Schema } from "effect";
import { encodeBase64 } from "@bye/mail-codec";
import { loadRawBytes, type RawContentSource } from "./cloudflare.ts";
import type { ProviderLookup, TransportAdapter } from "./router.ts";

/** Acceptance payload a provider answers with on 2xx. */
const ProviderAcceptanceBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
});

const noAcceptanceBody: typeof ProviderAcceptanceBody.Type = {};

const parseAcceptanceBody = (json: Schema.Json) =>
  Option.getOrElse(
    Schema.decodeUnknownOption(ProviderAcceptanceBody)(json),
    () => noAcceptanceBody,
  );

/** Minimal fetch signature so adapters are testable without a Worker environment. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<Schema.Json>; text(): Promise<string> }>;

export interface HttpTransportConfig {
  readonly endpoint: string;
  /** Resolved from a Redacted config at construction; never logged. */
  readonly apiKey: string;
  readonly capabilities: TransportCapabilities;
  readonly timeoutMs?: number;
}

/**
 * Generic HTTPS submission adapter for approved providers (personal, external
 * send-as via provider API, forwarding). Sends the idempotency key when the provider supports it.
 * Provider contract: POST JSON `{from, to, raw, rawEncoding: "base64", trafficClass}`.
 * Status mapping: 2xx accepted; 4xx (except 408/429) rejected; 408/429 and connection errors before
 * a response are retryable only when the provider is idempotent, otherwise Unknown.
 */
export const makeHttpTransport = (
  config: HttpTransportConfig,
  content: RawContentSource,
  fetchFn: FetchLike,
): TransportAdapter => {
  const adapter: Types.Mutable<TransportAdapter> = {
    capabilities: config.capabilities,
    submit: (submission: Submission) =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: async () => {
            const bytes = await loadRawBytes(content, submission.contentKey);

            if (bytes === null) throw new Error("rendered content missing");

            return bytes;
          },
          catch: (e) =>
            new TransportFailure({
              kind: "RetryableBeforeAcceptance",
              detail: e instanceof Error ? e.message : "content",
            }),
        });

        const idempotent = config.capabilities.idempotentSubmission;
        const idempotencyHeader: Record<string, string> = {};

        if (idempotent) idempotencyHeader["idempotency-key"] = submission.sendJobId;

        const response = yield* Effect.tryPromise({
          try: () =>
            fetchFn(config.endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                ...idempotencyHeader,
              },
              body: JSON.stringify({
                from: submission.from,
                to: submission.envelopeRecipients,
                // Raw MIME bytes, base64: JSON cannot carry 8-bit octets losslessly.
                raw: encodeBase64(raw),
                rawEncoding: "base64",
                trafficClass: submission.trafficClass,
              }),
              signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
            }),
          catch: (e) =>
            new TransportFailure({
              kind: idempotent ? "RetryableBeforeAcceptance" : "Unknown",
              detail: e instanceof Error ? e.name : "network",
            }),
        });

        if (response.status >= 200 && response.status < 300) {
          const body = parseAcceptanceBody(
            yield* Effect.tryPromise({
              try: () => response.json(),
              catch: () =>
                new TransportFailure({ kind: "Unknown", detail: "unreadable acceptance" }),
            }),
          );

          const acceptance: Types.Mutable<Acceptance> = {
            providerId: body.id ?? submission.sendJobId,
          };

          if (body.messageId) acceptance.wireMessageId = body.messageId;

          return acceptance;
        }

        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          return yield* new TransportFailure({
            kind: idempotent || response.status === 429 ? "RetryableBeforeAcceptance" : "Unknown",
            detail: `http ${response.status}`,
          });
        }

        return yield* new TransportFailure({ kind: "Rejected", detail: `http ${response.status}` });
      }).pipe(Effect.withSpan("transport.http.submit")),
  };

  if (config.capabilities.reconciliation) {
    // Provider contract below.
    // Provider contract: GET {endpoint}?idempotency_key=<sendJobId> → 200 {id, messageId?} when the
    // submission was accepted, 404 when the provider has no record of it.
    adapter.lookup = (sendJobId: string) =>
      Effect.tryPromise({
        try: async (): Promise<ProviderLookup> => {
          const response = await fetchFn(
            `${config.endpoint}?idempotency_key=${encodeURIComponent(sendJobId)}`,
            {
              method: "GET",
              headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
              signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
            },
          );

          if (response.status === 404) return { _tag: "Absent" };

          if (response.status !== 200) return { _tag: "Inconclusive" };
          const body = parseAcceptanceBody(await response.json());

          if (!body.id) return { _tag: "Inconclusive" };

          const found: Types.Mutable<Extract<ProviderLookup, { _tag: "Accepted" }>> = {
            _tag: "Accepted",
            providerId: body.id,
          };

          if (body.messageId) found.wireMessageId = body.messageId;

          return found;
        },
        catch: (e) =>
          new TransportFailure({
            kind: "Unknown",
            detail: e instanceof Error ? e.name : "lookup",
          }),
      });
  }

  return adapter;
};

const base = {
  maxAttachmentBytes: 25 * 1024 * 1024,
  supportsCalendarMime: true,
  supportsRawMime: true,
  deliveryEvents: true,
} as const;

export const EXTERNAL_IDENTITY_CAPABILITIES: TransportCapabilities = {
  ...base,
  name: "external-identity",
  trafficClasses: ["external-identity"],
  maxMessageBytes: 25 * 1024 * 1024,
  maxRecipients: 100,
  idempotentSubmission: false,
  reconciliation: false,
  exposesWireMessageId: true,
};

export const FORWARDING_CAPABILITIES: TransportCapabilities = {
  ...base,
  name: "forwarding",
  trafficClasses: ["forwarding"],
  maxMessageBytes: 25 * 1024 * 1024,
  maxRecipients: 1,
  idempotentSubmission: true,
  reconciliation: false,
  exposesWireMessageId: false,
};

/** Owning-module alias so runtime callers import a capability, not a `make*` constructor. */
export const httpTransport = makeHttpTransport;

export const makeExternalIdentityTransport = (
  c: Omit<HttpTransportConfig, "capabilities">,
  content: RawContentSource,
  f: FetchLike,
) => makeHttpTransport({ ...c, capabilities: EXTERNAL_IDENTITY_CAPABILITIES }, content, f);

export const makeForwardingTransport = (
  c: Omit<HttpTransportConfig, "capabilities">,
  content: RawContentSource,
  f: FetchLike,
) => makeHttpTransport({ ...c, capabilities: FORWARDING_CAPABILITIES }, content, f);
