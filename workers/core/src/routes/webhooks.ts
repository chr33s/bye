// Signed provider webhooks (billing, send events, newsletter provider events). Every body is decoded
// with its contract schema after the signature check; nothing is re-cast.
import { MailSendEventWebhook } from "@bye/contracts";
import { isRejection, verifyBillingSignature } from "@bye/platform-cloudflare";
import { mailbox } from "../authorities.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, json, route, type Route } from "../http.ts";
import { intakeNewsletterEvents } from "../newsletter.ts";
import { controlServices } from "../services.ts";
import { readTextCapped } from "./common.ts";
import { decodeBody } from "./decode.ts";

/** Whether our own send ledger (acceptances or Unknown submissions) holds this mailbox's job. */
const sendJobKnown = async (env: CoreEnv, mailboxId: string, sendJobId: string) =>
  (await env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT 1 AS k FROM send_acceptances WHERE mailbox_id = ? AND send_job_id = ? UNION ALL SELECT 1 AS k FROM send_unknowns WHERE mailbox_id = ? AND send_job_id = ? LIMIT 1",
    )
    .bind(mailboxId, sendJobId, mailboxId, sendJobId)
    .first()) !== null;

/**
 * Webhook bodies are small JSON events; the routes are unauthenticated until the signature is
 * checked, so the body is read with a streaming cap first (never buffered whole).
 */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

const tooLarge = () => errorResponse("payload_too_large", "webhook body too large");

export const webhookRoutes: ReadonlyArray<Route<CoreEnv>> = [
  route("POST", "/webhooks/billing", async (request, _p, env) => {
    const body = await readTextCapped(request, WEBHOOK_MAX_BYTES);
    if (body === null) return tooLarge();
    // Commerce side effects (checkout completion, referral credits, refunds) commit with the event.
    const { billing } = controlServices(env);
    try {
      const result = await billing.handleWebhook(
        body,
        request.headers.get("x-billing-signature"),
        env.BILLING_WEBHOOK_SECRET,
      );
      return json(result);
    } catch (e) {
      // Only the event's own faults are final; anything else (D1 outage, defect) is a 503 so the
      // provider retries instead of dropping a payment event.
      if (isRejection(e) && (e.code === "unauthenticated" || e.code === "bad_request"))
        return errorResponse(e.code, "webhook rejected");
      return errorResponse("unavailable", "webhook not processed");
    }
  }),
  // Delivery events from the personal-mail provider. Signed with a dedicated secret
  // (SEND_EVENTS_WEBHOOK_SECRET, never the provider API key) in the billing `t=<unix>,v1=<hex>`
  // scheme, so a captured request cannot be replayed outside the 5-minute window. The body's
  // (mailboxId, sendJobId) must be a send our own ledger recorded (acceptance or Unknown), so an
  // event can never be routed into a mailbox that did not make the send.
  route("POST", "/webhooks/send-events", async (request, _p, env) => {
    const body = await readTextCapped(request, WEBHOOK_MAX_BYTES);
    if (body === null) return tooLarge();
    const secret = env.SEND_EVENTS_WEBHOOK_SECRET ?? "";
    if (
      !(await verifyBillingSignature(
        body,
        request.headers.get("x-bye-signature"),
        secret,
        Date.now(),
      ))
    )
      return errorResponse("unauthenticated", "bad signature");
    const e = decodeBody(MailSendEventWebhook, body);
    if (!e) return errorResponse("bad_request", "invalid event");
    if (!(await sendJobKnown(env, e.mailboxId, e.sendJobId))) {
      console.warn(JSON.stringify({ level: "warn", op: "sendevent.unknown-job" }));
      return errorResponse("not_found", "unknown send job");
    }
    await mailbox(env, e.mailboxId).recordRecipientEvent(
      e.eventId,
      e.sendJobId,
      e.recipient,
      e.outcome,
      e.detail,
    );
    return json({ ok: true });
  }),
  // Newsletter provider events (spec.md §5.6). Authenticated with the provider's signing scheme
  // and bound to the configured provider account; every event is persisted before the 2xx, and
  // applied through the same consent/restriction rules as Bye-origin changes. A creator-scoped
  // unsubscribe is never broadened into the platform suppression list.
  route("POST", "/webhooks/newsletter", async (request, _p, env) => {
    const body = await readTextCapped(request, WEBHOOK_MAX_BYTES);
    if (body === null) return tooLarge();
    const intake = await intakeNewsletterEvents(env, body, request.headers);
    switch (intake._tag) {
      case "Unavailable":
        return errorResponse("not_found", "no newsletter provider");
      case "Unauthenticated":
        return errorResponse("unauthenticated", "bad signature");
      case "Persisted":
        return json({ ok: true, events: intake.events });
    }
  }),
];
