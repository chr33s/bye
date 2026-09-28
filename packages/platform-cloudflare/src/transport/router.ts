import {
  type Acceptance,
  MailTransport,
  type Submission,
  TransportFailure,
} from "@bye/application";
import { checkSubmission, type TransportCapabilities, type TrafficClass } from "@bye/domain";
import { Effect, Layer, Predicate } from "effect";

/** An adapter with declared capabilities (§5.3). */
export interface TransportAdapter {
  readonly capabilities: TransportCapabilities;
  readonly submit: (submission: Submission) => Effect.Effect<Acceptance, TransportFailure>;
  /**
   * Provider evidence for an ambiguous submission (§5.2 Unknown), by idempotency key. Only
   * adapters whose provider supports reconciliation implement it.
   */
  readonly lookup?: (sendJobId: string) => Effect.Effect<ProviderLookup, TransportFailure>;
}

export type ProviderLookup =
  | { readonly _tag: "Accepted"; readonly providerId: string; readonly wireMessageId?: string }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Inconclusive" };

/** Enforce capability limits before any external I/O; oversize is a clear rejection, not a retry. */
export const guardedSubmit = (
  adapter: TransportAdapter,
  submission: Submission,
): Effect.Effect<Acceptance, TransportFailure> => {
  const check = checkSubmission(
    adapter.capabilities,
    submission.trafficClass,
    submission.bytes,
    submission.envelopeRecipients.length,
  );

  if (!Predicate.isTagged(check, "Ok"))
    return Effect.fail(
      new TransportFailure({
        kind: "Rejected",
        detail: `${adapter.capabilities.name}: ${check._tag}`,
      }),
    );

  return adapter.submit(submission);
};

/** Parse a stage's enabled traffic classes (`MAIL_TRAFFIC_CLASSES`); empty = transactional only. */
export const parseTrafficClasses = (raw: string | undefined): ReadonlySet<TrafficClass> => {
  const known: ReadonlyArray<TrafficClass> = [
    "transactional",
    "personal",
    "external-identity",
    "forwarding",
  ];

  const listed = (raw ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c): c is TrafficClass => (known as ReadonlyArray<string>).includes(c));

  return new Set(listed.length ? listed : ["transactional"]);
};

/**
 * Routes each submission to the adapter approved for its traffic class. A class that is not
 * enabled for this stage, or has no approved adapter, is rejected before any provider call rather
 * than silently sent through a transactional-only provider. Newsletter (`subscription`) traffic is
 * never an individual-message submission: it goes through `NewsletterProvider`.
 */
export const makeTransportRouter = (
  adapters: ReadonlyArray<TransportAdapter>,
  enabled?: ReadonlySet<TrafficClass>,
) =>
  MailTransport.of({
    submit: (submission) => {
      if (submission.trafficClass === "subscription")
        return Effect.fail(
          new TransportFailure({
            kind: "Rejected",
            detail: "newsletter traffic must use NewsletterProvider",
          }),
        );

      if (enabled && !enabled.has(submission.trafficClass))
        return Effect.fail(
          new TransportFailure({
            kind: "Rejected",
            detail: `${submission.trafficClass} is not enabled in this stage`,
          }),
        );

      const adapter = adapters.find((a) =>
        a.capabilities.trafficClasses.includes(submission.trafficClass),
      );

      return adapter
        ? guardedSubmit(adapter, submission)
        : Effect.fail(
            new TransportFailure({
              kind: "Rejected",
              detail: `no approved transport for ${submission.trafficClass}`,
            }),
          );
    },
  });

export const TransportRouterLive = (
  adapters: ReadonlyArray<TransportAdapter>,
  enabled?: ReadonlySet<TrafficClass>,
) => Layer.succeed(MailTransport, makeTransportRouter(adapters, enabled));

export const transportFor = (
  adapters: ReadonlyArray<TransportAdapter>,
  trafficClass: TrafficClass,
): TransportAdapter | undefined =>
  adapters.find((a) => a.capabilities.trafficClasses.includes(trafficClass));
