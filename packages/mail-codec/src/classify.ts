import type { MessageSummary, ParsedMessage } from "./types.ts";

// Auto-reply safety (E22, §10) and destination hints (E05/E06). Hints never override explicit
// sender/domain policy; they only prefill the Screener choice.

export type AutoReplyDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const NO_REPLY_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|listserv|majordomo|owner-[^@]*|[^@]*-(request|owner|bounces?))([+-][^@]*)?@/i;

export const shouldAutoReply = (
  parsed: Pick<
    ParsedMessage,
    "autoSubmitted" | "precedence" | "listId" | "listUnsubscribe" | "headers" | "from"
  >,
  envelopeFrom: string,
): AutoReplyDecision => {
  const sender = envelopeFrom.trim().replace(/^<|>$/g, "");

  if (!sender || !sender.includes("@")) return { ok: false, reason: "empty-envelope-sender" };

  if (NO_REPLY_SENDER.test(sender)) return { ok: false, reason: "automated-sender" };

  if (parsed.autoSubmitted !== undefined && parsed.autoSubmitted !== "no")
    return { ok: false, reason: "auto-submitted" };

  if (
    parsed.precedence !== undefined &&
    ["bulk", "list", "junk", "auto_reply"].includes(parsed.precedence)
  ) {
    return { ok: false, reason: "precedence" };
  }

  if (parsed.listId !== undefined || parsed.listUnsubscribe !== undefined)
    return { ok: false, reason: "list-traffic" };
  const lower = parsed.headers.map(([n, v]) => [n.toLowerCase(), v.toLowerCase()] as const);

  if (lower.some(([n]) => n === "x-autoreply" || n === "x-autorespond" || n === "list-post"))
    return { ok: false, reason: "auto-reply-header" };

  if (lower.some(([n, v]) => n === "x-auto-response-suppress" && /all|oof|autoreply/.test(v)))
    return { ok: false, reason: "suppressed" };

  if (parsed.from.some((a) => NO_REPLY_SENDER.test(a.address)))
    return { ok: false, reason: "automated-sender" };

  return { ok: true };
};

const RECEIPT_WORDS =
  /\b(receipt|invoice|order|confirmation|confirmed|payment|purchase|shipped|shipping|booking|reservation|statement|refund)\b/i;

export const suggestDestination = (
  summary: Pick<MessageSummary, "listId" | "listUnsubscribe" | "subject" | "automated">,
): "imbox" | "feed" | "paper-trail" => {
  if (RECEIPT_WORDS.test(summary.subject) && summary.automated) return "paper-trail";

  if (summary.listUnsubscribe !== undefined || summary.listId !== undefined) return "feed";

  if (RECEIPT_WORDS.test(summary.subject)) return "paper-trail";

  return "imbox";
};
