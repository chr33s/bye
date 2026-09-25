// Transport capability contract (§5.3).

export type TrafficClass =
  | "transactional"
  | "personal"
  | "subscription"
  | "external-identity"
  | "forwarding";

export interface TransportCapabilities {
  readonly name: string;
  readonly trafficClasses: ReadonlyArray<TrafficClass>;
  readonly maxMessageBytes: number;
  readonly maxRecipients: number;
  readonly maxAttachmentBytes: number;
  readonly supportsCalendarMime: boolean;
  readonly supportsRawMime: boolean;
  /** Whether the provider accepts an idempotency key, making resubmission after a lost response safe. */
  readonly idempotentSubmission: boolean;
  /** Whether provider evidence can resolve an Unknown submission. */
  readonly reconciliation: boolean;
  readonly exposesWireMessageId: boolean;
  readonly deliveryEvents: boolean;
}

/** Cloudflare Email Sending beta limits (§1, [C2]). */
export const CLOUDFLARE_TRANSACTIONAL_CAPABILITIES: TransportCapabilities = {
  name: "cloudflare-transactional",
  trafficClasses: ["transactional"],
  maxMessageBytes: 5 * 1024 * 1024,
  maxRecipients: 50,
  maxAttachmentBytes: 5 * 1024 * 1024,
  supportsCalendarMime: true,
  supportsRawMime: true,
  idempotentSubmission: false,
  reconciliation: false,
  exposesWireMessageId: false,
  deliveryEvents: true,
};

export const INBOUND_MAX_BYTES = 25 * 1024 * 1024;

export type SubmissionCheck =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "TrafficClassNotPermitted"; readonly trafficClass: TrafficClass }
  | { readonly _tag: "TooLarge"; readonly bytes: number; readonly limit: number }
  | { readonly _tag: "TooManyRecipients"; readonly count: number; readonly limit: number };

/** Capability-aware composer/dispatch validation (§5.4 Limits gate). */
export const checkSubmission = (
  caps: TransportCapabilities,
  trafficClass: TrafficClass,
  bytes: number,
  recipients: number,
): SubmissionCheck => {
  if (!caps.trafficClasses.includes(trafficClass))
    return { _tag: "TrafficClassNotPermitted", trafficClass };
  if (bytes > caps.maxMessageBytes) return { _tag: "TooLarge", bytes, limit: caps.maxMessageBytes };
  if (recipients > caps.maxRecipients)
    return { _tag: "TooManyRecipients", count: recipients, limit: caps.maxRecipients };
  return { _tag: "Ok" };
};
