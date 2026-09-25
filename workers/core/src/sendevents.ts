import { Effect } from "effect";
import { SendingPolicy } from "@bye/platform-cloudflare";
import { kernelClock } from "./durable-host.ts";
import type { RecipientOutcome } from "@bye/domain";
import type { CoreEnv } from "./env.ts";
import { metric } from "./metrics.ts";
import { buildTransportAdapters } from "./transports.ts";
import { mailbox } from "./authorities.ts";

// Provider evidence for sends (§5.2, §5.3): acceptance IDs map provider events back to send jobs;
// asynchronous delivery events record per-recipient outcomes (and resolve an Unknown submission
// when the provider proves acceptance); a periodic reconciler asks adapters that support it.

const commandId = () => `cmd_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const recordAcceptance = (
  env: CoreEnv,
  providerId: string,
  mailboxId: string,
  sendJobId: string,
  transport: string,
): Promise<unknown> =>
  env.DIRECTORY.prepare(
    "INSERT OR IGNORE INTO send_acceptances (provider_id, mailbox_id, send_job_id, transport, accepted_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(providerId, mailboxId, sendJobId, transport, Date.now())
    .run();

export const recordUnknown = (
  env: CoreEnv,
  mailboxId: string,
  sendJobId: string,
  transport: string,
): Promise<unknown> =>
  env.DIRECTORY.prepare(
    "INSERT OR IGNORE INTO send_unknowns (mailbox_id, send_job_id, transport, first_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(mailboxId, sendJobId, transport, Date.now())
    .run();

export interface ProviderEvent {
  readonly eventId: string;
  readonly providerId: string;
  readonly recipient: string;
  readonly outcome: RecipientOutcome;
  readonly detail?: string;
  /** Our idempotency key echoed by the provider (= send job ID); matches Unknown submissions. */
  readonly idempotencyKey?: string;
}

const OUTCOMES: Readonly<Record<string, RecipientOutcome>> = {
  delivered: "delivered",
  delivery: "delivered",
  bounced: "bounced",
  bounce: "bounced",
  hard_bounce: "bounced",
  soft_bounce: "deferred",
  deferred: "deferred",
  delayed: "deferred",
  rejected: "rejected",
  dropped: "rejected",
  failed: "rejected",
  complaint: "complained",
  complained: "complained",
  spam_complaint: "complained",
};

/** Scalar fields as text; objects and other non-scalars read as empty. */
const text = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean"
    ? String(v)
    : "";

/**
 * Tolerant parser for provider/Cloudflare email lifecycle events arriving on a queue, e.g.
 * `{ type: "email.delivered", messageId, recipient }` or `{ eventType: "bounce", ... }`.
 * Returns null for anything that is not a recognized email event.
 */
export const parseProviderEvent = (body: unknown): ProviderEvent | null => {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const rawType = text(b.type ?? b.eventType ?? b.event);
  if (!/^email[._]|^(delivered|bounced?|deferred|rejected|dropped|complain)/i.test(rawType))
    return null;
  const kind = rawType.replace(/^email[._]/i, "").toLowerCase();
  const outcome = OUTCOMES[kind];
  const providerId = text(b.messageId ?? b.message_id ?? b.providerId ?? b.id);
  const recipient = text(b.recipient ?? b.to ?? b.email).toLowerCase();
  if (!outcome || !providerId || !recipient) return null;
  return {
    eventId: text(b.eventId ?? b.event_id) || `${providerId}:${recipient}:${kind}`,
    providerId,
    recipient,
    outcome,
    ...(typeof (b.idempotencyKey ?? b.idempotency_key ?? b.sendJobId) === "string"
      ? { idempotencyKey: String(b.idempotencyKey ?? b.idempotency_key ?? b.sendJobId) }
      : {}),
    ...(typeof b.reason === "string"
      ? { detail: b.reason.slice(0, 300) }
      : typeof b.detail === "string"
        ? { detail: b.detail.slice(0, 300) }
        : {}),
  };
};

export const handleProviderEvent = async (
  env: CoreEnv,
  event: ProviderEvent,
): Promise<"recorded" | "unmatched"> => {
  let row = await env.DIRECTORY.prepare(
    "SELECT mailbox_id, send_job_id FROM send_acceptances WHERE provider_id = ?",
  )
    .bind(event.providerId)
    .first<{ mailbox_id: string; send_job_id: string }>();
  if (!row && event.idempotencyKey) {
    // An Unknown submission never recorded a provider ID; the echoed idempotency key links it.
    row = await env.DIRECTORY.prepare(
      "SELECT mailbox_id, send_job_id FROM send_unknowns WHERE send_job_id = ?",
    )
      .bind(event.idempotencyKey)
      .first<{ mailbox_id: string; send_job_id: string }>();
    if (row)
      await recordAcceptance(env, event.providerId, row.mailbox_id, row.send_job_id, "event");
  }
  if (!row) {
    metric("sendevent.unmatched", 1);
    return "unmatched";
  }
  const stub = mailbox(env, row.mailbox_id);
  await stub.recordRecipientEvent(
    event.eventId,
    row.send_job_id,
    event.recipient,
    event.outcome,
    event.detail,
  );
  const job = (await stub.sendJob(row.send_job_id)) as { state?: string; from?: string } | null;
  // Abuse controls (§10): hard bounces/complaints suppress the recipient and feed sender review.
  if (
    job?.from &&
    (event.outcome === "bounced" || event.outcome === "complained" || event.outcome === "deferred")
  ) {
    const owner = await env.DIRECTORY.prepare("SELECT owner_user_id FROM mailboxes WHERE id = ?")
      .bind(row.mailbox_id)
      .first<{ owner_user_id: string | null }>();
    await new SendingPolicy(env.DIRECTORY, kernelClock).recordOutcome({
      userId: owner?.owner_user_id ?? row.mailbox_id,
      identity: job.from,
      recipient: event.recipient,
      outcome:
        event.outcome === "complained"
          ? "complaint"
          : event.outcome === "bounced"
            ? "hard-bounce"
            : "soft-bounce",
    });
  }
  if (job?.state === "unknown") {
    // Any lifecycle event for this acceptance proves the provider accepted it.
    await stub.execute({
      _tag: "ResolveUnknownSend",
      commandId: commandId(),
      sendJobId: row.send_job_id,
      decision: { _tag: "Accepted", providerId: event.providerId },
    });
    await env.DIRECTORY.prepare(
      "UPDATE send_unknowns SET resolved_at = ?, resolution = 'accepted-by-event' WHERE mailbox_id = ? AND send_job_id = ?",
    )
      .bind(Date.now(), row.mailbox_id, row.send_job_id)
      .run();
  }
  metric("sendevent.recorded", 1, { outcome: event.outcome });
  return "recorded";
};

/**
 * Periodic Unknown-send reconciliation: adapters with provider lookup resolve acceptance; an
 * "absent" answer is recorded as evidence but the resend decision stays explicit (§5.2).
 */
export const reconcileUnknownSends = async (
  env: CoreEnv,
  limit = 50,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
): Promise<{ readonly checked: number; readonly resolved: number }> => {
  const rows = (
    await env.DIRECTORY.prepare(
      "SELECT mailbox_id, send_job_id, transport FROM send_unknowns WHERE resolved_at IS NULL ORDER BY COALESCE(last_checked_at, 0), first_seen_at LIMIT ?",
    )
      .bind(limit)
      .all<{ mailbox_id: string; send_job_id: string; transport: string }>()
  ).results;
  let resolved = 0;
  for (const r of rows) {
    const adapters = await buildTransportAdapters(env, r.mailbox_id, fetchFn);
    const adapter = adapters.find(
      (a) => a.capabilities.trafficClasses.includes(r.transport as never) && a.lookup,
    );
    let resolution: string | null = null;
    if (adapter?.lookup) {
      const exit = await Effect.runPromiseExit(adapter.lookup(r.send_job_id));
      if (exit._tag === "Success" && exit.value._tag === "Accepted") {
        const stub = mailbox(env, r.mailbox_id);
        await stub.execute({
          _tag: "ResolveUnknownSend",
          commandId: commandId(),
          sendJobId: r.send_job_id,
          decision: { _tag: "Accepted", providerId: exit.value.providerId },
        });
        await env.DIRECTORY.prepare(
          "INSERT OR IGNORE INTO send_acceptances (provider_id, mailbox_id, send_job_id, transport, accepted_at) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(exit.value.providerId, r.mailbox_id, r.send_job_id, r.transport, Date.now())
          .run();
        resolution = "accepted-by-lookup";
        resolved++;
      } else if (exit._tag === "Success" && exit.value._tag === "Absent") {
        resolution = null;
        await env.DIRECTORY.prepare(
          "UPDATE send_unknowns SET resolution = 'absent-at-provider' WHERE mailbox_id = ? AND send_job_id = ?",
        )
          .bind(r.mailbox_id, r.send_job_id)
          .run();
      }
    }
    await env.DIRECTORY.prepare(
      "UPDATE send_unknowns SET last_checked_at = ?, resolved_at = CASE WHEN ? IS NOT NULL THEN ? ELSE resolved_at END, resolution = COALESCE(?, resolution) WHERE mailbox_id = ? AND send_job_id = ?",
    )
      .bind(Date.now(), resolution, Date.now(), resolution, r.mailbox_id, r.send_job_id)
      .run();
  }
  metric("send.unknown.reconciled", resolved);
  return { checked: rows.length, resolved };
};
