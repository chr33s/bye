import { blobKey } from "@bye/application";
import { encodeId, INBOUND_MAX_BYTES } from "@bye/domain";
import { Effect } from "effect";
import { Directory } from "@bye/application";
import { policyLayers } from "./services.ts";
import { type CoreEnv, journalPartition } from "./env.ts";

// Inbound pipeline steps 1–4 (§5.1). The application guarantee begins once the original bytes
// and the receipt intent are both durable. Transient failures throw (SMTP temp-fail) and are
// never translated into `setReject`, which is permanent. `waitUntil` is not used for durability.

export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  /** Message headers (Email Workers expose them on ForwardableEmailMessage). */
  readonly headers?: Headers;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

export const FORWARD_HOP_HEADER = "X-Bye-Loop";
export const FORWARD_MAX_HOPS = 5;

export type IngressFault = "throw" | "r2" | "timeout";
export const FAULT_TIMEOUT_MS = 60_000;

/** Fault mode for this recipient, if fault injection is configured and the address opts in. */
export const ingressFault = (
  env: { readonly BYE_FAULT_INGRESS?: string },
  recipient: string,
): IngressFault | null => {
  const mode = (env.BYE_FAULT_INGRESS ?? "").trim();
  if (mode !== "throw" && mode !== "r2" && mode !== "timeout") return null;
  return /\+fault@/i.test(recipient) ? mode : null;
};

export type InboundOutcome =
  | { readonly _tag: "Accepted"; readonly ingestionId: string; readonly enqueued: boolean }
  | { readonly _tag: "Rejected"; readonly reason: string }
  | { readonly _tag: "Forwarded" };

export const handleInbound = async (
  message: InboundMessage,
  env: CoreEnv,
): Promise<InboundOutcome> => {
  if (message.rawSize > INBOUND_MAX_BYTES) {
    message.setReject("552 message exceeds maximum size");
    return { _tag: "Rejected", reason: "too-large" };
  }

  // 1. Resolve the envelope recipient against the primary-consistent directory (Directory service, §7.1).
  const route = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Directory).resolveRecipient(message.to);
    }).pipe(Effect.provide(await policyLayers(env))),
  );
  switch (route._tag) {
    case "Rejected":
      message.setReject("550 5.1.1 recipient rejected");
      return { _tag: "Rejected", reason: route.reason };
    case "TransientFailure":
      // Throwing makes the SMTP session temp-fail so the sender retries.
      throw new Error("directory unavailable");
    case "Forward": {
      // Post-closure forwarding entitlement (A04) to a verified destination. A hop counter stops
      // loops between forwarding services (e.g. the destination forwarding back to us).
      const hops = Number.parseInt(message.headers?.get(FORWARD_HOP_HEADER) ?? "0", 10) || 0;
      if (hops >= FORWARD_MAX_HOPS) {
        message.setReject("554 5.4.6 forwarding loop detected");
        return { _tag: "Rejected", reason: "forward-loop" };
      }
      await message.forward(route.to, new Headers({ [FORWARD_HOP_HEADER]: String(hops + 1) }));
      return { _tag: "Forwarded" };
    }
    case "Deliver":
      break;
  }

  // §14.2 evidence: observe the provider's SMTP retry behaviour under handler, storage and timeout
  // failures. Only for recipients tagged `+fault` and only when explicitly configured (never on
  // prod/staging — enforced by infra/policies/check-config.ts).
  const fault = ingressFault(env, message.to);
  if (fault === "throw") throw new Error("fault injection: handler error");

  // 2. Register receipt intent before expensive work; identifiers only, no subjects/bodies.
  const ingestionId = encodeId("IngestionId", crypto.getRandomValues(new Uint8Array(16)));
  const objectKey = blobKey.original(route.mailboxId, ingestionId);
  const journal = env.INGRESS_JOURNALS.getByName(journalPartition(ingestionId));
  await journal.register({
    ingestionId,
    mailboxId: route.mailboxId,
    recipient: message.to.toLowerCase(),
    envelopeFrom: message.from.toLowerCase(),
    objectKey,
    rawSize: message.rawSize,
  });

  if (fault === "r2") throw new Error("fault injection: original storage unavailable");
  if (fault === "timeout") await new Promise((resolve) => setTimeout(resolve, FAULT_TIMEOUT_MS));

  // 3. Stream the original to R2 without buffering copies in the isolate.
  const { readable, writable } = new FixedLengthStream(message.rawSize);
  const [put] = await Promise.all([
    env.ORIGINALS.put(objectKey, readable, { httpMetadata: { contentType: "message/rfc822" } }),
    message.raw.pipeTo(writable),
  ]);
  if (!put) throw new Error("original not stored");
  await journal.markBlobReady(ingestionId);

  // 4. Enqueue by reference. A publish failure leaves the receipt blob-ready for the journal
  //    reconciler; the content is already durable, so the SMTP transaction still succeeds.
  try {
    await env.INGEST.send(
      {
        schemaVersion: 1,
        type: "ingest",
        eventId: `ingest:${ingestionId}`,
        ingestionId,
        mailboxId: route.mailboxId,
        recipient: message.to.toLowerCase(),
        envelopeFrom: message.from.toLowerCase(),
        objectKey,
        rawSize: message.rawSize,
        receivedAt: Date.now(),
      },
      { contentType: "json" },
    );
    await journal.markEnqueued(ingestionId);
    return { _tag: "Accepted", ingestionId, enqueued: true };
  } catch {
    console.warn(JSON.stringify({ level: "warn", op: "ingest.enqueue", ingestionId }));
    return { _tag: "Accepted", ingestionId, enqueued: false };
  }
};
