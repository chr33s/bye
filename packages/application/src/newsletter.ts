import type {
  NewsletterCapabilities,
  ObservedBroadcastState,
  OperationOutcome,
  ProviderEventKind,
} from "@bye/domain";
import { Context, type Effect } from "effect";

// Newsletter provider contract (spec.md §5.3, §5.5). Separate from `MailTransport`:
// newsletters never fall back to individual-message APIs. Every mutating operation reports an
// `OperationOutcome` (Accepted / NotAccepted / Unknown) as data; adapters never retry internally.

/**
 * One audience per creator at the provider; Bye's mapping is authoritative. `scopeId` is the
 * provider construct that carries a creator-scoped subscription (e.g. a topic) when the provider's
 * own unsubscribe flag is account-wide.
 */
export interface AudienceRef {
  readonly audienceId: string;
  readonly scopeId?: string;
}

export type AudienceOutcome =
  | { readonly _tag: "Accepted"; readonly audience: AudienceRef }
  | Exclude<OperationOutcome, { readonly _tag: "Accepted" }>;

export interface ContactChange {
  readonly address: string;
  /** false = the provider must exclude this contact from every broadcast to the audience. */
  readonly subscribed: boolean;
}

export interface BroadcastDraft {
  /** Immutable operation identity; doubles as the provider idempotency key where supported. */
  readonly operationId: string;
  readonly audience: AudienceRef;
  readonly name: string;
  readonly from: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Headers the message must carry; rejected before any call when the provider drops them. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface BroadcastView {
  readonly providerRef: string;
  readonly audienceId: string;
  readonly subject: string;
  readonly from: string;
  readonly state: ObservedBroadcastState;
}

/** A provider event after authentication, mapped to Bye terms. Unknown types stay `unmapped`. */
export interface ProviderEvent {
  readonly eventId: string;
  readonly occurredAt: number;
  /** `informational`: a known type Bye does not act on (opens, clicks …). */
  readonly kind: ProviderEventKind | "informational" | "unmapped";
  readonly rawType: string;
  readonly audienceId?: string;
  readonly address?: string;
  /** For contact events: whether the change is account-wide at the provider or creator-scoped. */
  readonly scope?: "creator" | "provider";
  readonly broadcastRef?: string;
  readonly broadcastState?: ObservedBroadcastState;
}

export type EventVerification =
  | { readonly _tag: "Verified"; readonly events: ReadonlyArray<ProviderEvent> }
  | { readonly _tag: "Unauthenticated"; readonly detail: string };

export type BroadcastLookup =
  | { readonly _tag: "Found"; readonly broadcast: BroadcastView }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Inconclusive"; readonly detail: string };

export interface NewsletterProviderShape {
  readonly capabilities: NewsletterCapabilities;
  /** Identifies the provider account the credentials belong to; events bind to it. */
  readonly account: string;
  readonly createAudience: (name: string, operationId: string) => Effect.Effect<AudienceOutcome>;
  readonly syncContact: (
    audience: AudienceRef,
    change: ContactChange,
  ) => Effect.Effect<OperationOutcome>;
  readonly createBroadcast: (draft: BroadcastDraft) => Effect.Effect<OperationOutcome>;
  /** `scheduledAt` null sends now. The provider applies its unsubscribe exclusions at dispatch. */
  readonly sendBroadcast: (
    providerRef: string,
    operationId: string,
    scheduledAt: number | null,
  ) => Effect.Effect<OperationOutcome>;
  readonly cancelBroadcast: (
    providerRef: string,
    operationId: string,
  ) => Effect.Effect<OperationOutcome>;
  readonly getBroadcast: (providerRef: string) => Effect.Effect<BroadcastLookup>;
  /** Reconcile an ambiguous create by the broadcast's unique name (the publication operation ID). */
  readonly findBroadcast: (name: string) => Effect.Effect<BroadcastLookup>;
  /** Authenticate a webhook delivery with the configured secret and map its events. */
  readonly verifyEvents: (
    body: string,
    headers: Headers,
    now: number,
  ) => Effect.Effect<EventVerification>;
}

export class NewsletterProvider extends Context.Service<
  NewsletterProvider,
  NewsletterProviderShape
>()("mail/NewsletterProvider") {}
