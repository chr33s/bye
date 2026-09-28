import type {
  AudienceOutcome,
  BroadcastLookup,
  EventVerification,
  NewsletterProviderService,
  ProviderEvent,
} from "@bye/application";
import {
  hmacSha256,
  type NewsletterCapabilities,
  type ObservedBroadcastState,
  type OperationOutcome,
  timingSafeEqual,
} from "@bye/domain";
import { Effect, Option, Predicate, Schema } from "effect";
import type { FetchLike } from "../transport/http.ts";

// Resend newsletter adapter (spec.md §1, §5.5: Resend is evaluated for programmatic broadcasts). Direct
// HTTPS only; no Node SDK. Provider facts this relies on (docs checked 2026-09-26; qualification
// must re-verify them against a real account before enabling):
//
// - Contacts are account-global and their `unsubscribed` flag excludes them from EVERY broadcast.
//   Bye therefore never writes that flag (it would broaden a creator-scoped unsubscribe); each
//   creator gets a segment plus an `opt_out`-default topic, and consent is the contact's topic
//   subscription (only explicit opt-ins receive a topic broadcast).
// - Broadcast create/send accept no Idempotency-Key, so their ambiguous outcomes are reconciled by
//   the broadcast's unique name (create) or observed status (send), never by blind retry.
// - Broadcasts take no custom headers; unsubscribe is Resend's per-recipient
//   `{{{RESEND_UNSUBSCRIBE_URL}}}` preference link (topic-scoped).
// - Webhooks are Svix-signed. Topic-level unsubscribes are NOT reported by any documented event, so
//   creator-scoped provider unsubscribes are a declared coverage gap.

export const RESEND_API = "https://api.resend.com";

export const RESEND_UNSUBSCRIBE_PLACEHOLDER = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/** Svix libraries' default replay tolerance (not stated in Resend's docs). */
export const SVIX_TOLERANCE_MS = 5 * 60_000;

const none = { supported: false, idempotency: null, reconciliation: false } as const;

export const RESEND_CAPABILITIES: NewsletterCapabilities = {
  name: "resend",
  apiVersion: "2026-09 (segments/topics)",
  operations: {
    // Contact writes set state (not additive), so repeating one is safe without idempotency keys.
    "contact-sync": { supported: true, idempotency: null, reconciliation: false },
    "unsubscribe-sync": { supported: true, idempotency: null, reconciliation: false },
    "broadcast-create": {
      supported: true,
      idempotency: null,
      reconciliation: true,
      preservesHeaders: false,
      senderDomainRestricted: true,
    },
    "broadcast-send": {
      supported: true,
      idempotency: null,
      reconciliation: true,
      enforcesExclusionsAtDispatch: true,
    },
    // Autonomous provider scheduling stays off: Bye holds the schedule and submits at send time.
    "broadcast-schedule": none,
    "broadcast-cancel": {
      supported: true,
      idempotency: null,
      reconciliation: true,
      cancellable: "until-sent",
    },
    "broadcast-lookup": { supported: true, idempotency: null, reconciliation: true },
    events: {
      supported: true,
      idempotency: null,
      reconciliation: false,
      eventCoverage: [
        "delivered",
        "hard-bounce",
        "soft-bounce",
        "complaint",
        "contact-unsubscribed",
        "contact-subscribed",
      ],
    },
  },
};

export interface ResendConfig {
  readonly apiKey: string;
  /** Webhook signing secret (`whsec_…`). */
  readonly webhookSecret: string;
  /** Opaque account label the credentials belong to; events are bound to it. */
  readonly account: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

type Response_ = Awaited<ReturnType<FetchLike>>;

/** HTTP status → outcome. 429 is a definite non-acceptance; 5xx and transport errors are unknown. */
export const classifyResendStatus = (status: number, detail: string): OperationOutcome => {
  if (status === 429) return { _tag: "NotAccepted", retryable: true, detail: `http 429 ${detail}` };

  if (status >= 500) return { _tag: "Unknown", detail: `http ${status} ${detail}` };

  return { _tag: "NotAccepted", retryable: false, detail: `http ${status} ${detail}` };
};

const RESEND_STATES = new Map<string, ObservedBroadcastState>([
  ["draft", "draft"],
  ["scheduled", "scheduled"],
  ["queued", "queued"],
  ["sending", "sending"],
  ["sent", "sent"],
  ["canceled", "cancelled"],
  ["cancelled", "cancelled"],
]);

const str = <V>(v: V): string => (Predicate.isString(v) ? v : "");

const isJsonObject = (v: Schema.Json | undefined): v is Schema.JsonObject => Predicate.isObject(v);

/** Provider webhook envelope: every field is provider-controlled and inspected defensively. */
const ResendWebhook = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
});

const noWebhookPayload: ResendWebhookPayload = {};

const decodeResendWebhook = Schema.decodeUnknownOption(ResendWebhook);

/** A decoded Resend webhook envelope. */
export type ResendWebhookPayload = typeof ResendWebhook.Type;

interface ResendEventBase {
  eventId: string;
  occurredAt: number;
  rawType: string;
  address?: string;
  broadcastRef?: string;
}

interface ResendRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

type ResendBroadcastBody = {
  segment_id: string;
  topic_id?: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  name: string;
  reply_to?: string;
};

const fromBase64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/** Svix signature check over `${id}.${timestamp}.${body}` with the base64 key after `whsec_`. */
export const verifySvix = async (
  secret: string,
  body: string,
  headers: Headers,
  now: number,
  toleranceMs = SVIX_TOLERANCE_MS,
): Promise<{ ok: true; id: string } | { ok: false; detail: string }> => {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sig = headers.get("svix-signature");

  if (!secret || !id || !ts || !sig) return { ok: false, detail: "missing signature" };
  const seconds = Number(ts);

  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > toleranceMs)
    return { ok: false, detail: "timestamp outside tolerance" };
  let key: Uint8Array<ArrayBuffer>;

  try {
    key = fromBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return { ok: false, detail: "bad secret" };
  }

  const expected = toBase64(await hmacSha256(key, `${id}.${ts}.${body}`));

  const match = sig
    .split(" ")
    .some((part) => part.startsWith("v1,") && timingSafeEqual(part.slice(3), expected));

  return match ? { ok: true, id } : { ok: false, detail: "bad signature" };
};

/**
 * The Resend webhook event types Bye subscribes to: exactly those `mapResendEvent` turns into
 * consent, restriction or delivery facts. Runtime setup (newsletter-config.ts) creates the webhook
 * with this set; informational types are not requested.
 */
export const RESEND_WEBHOOK_EVENTS = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.suppressed",
  "contact.created",
  "contact.updated",
] as const;

/** Map one verified Resend event to Bye terms. Unknown types are kept as `unmapped`. */
export const mapResendEvent = (eventId: string, p: ResendWebhookPayload): ProviderEvent => {
  const rawType = Predicate.isString(p.type) ? p.type : "unknown";
  const data = Predicate.isObject(p.data) ? p.data : {};
  const occurredAt = Date.parse(str(p.created_at) || str(data.created_at)) || 0;
  const to = Array.isArray(data.to) ? data.to[0] : data.email;
  const address = Predicate.isString(to) ? to.trim().toLowerCase() : undefined;
  const broadcastRef = Predicate.isString(data.broadcast_id) ? data.broadcast_id : undefined;

  const base: ResendEventBase = { eventId, occurredAt, rawType };

  if (address) base.address = address;

  if (broadcastRef) base.broadcastRef = broadcastRef;

  switch (rawType) {
    case "email.delivered":
      return { ...base, kind: "delivered" };
    case "email.bounced": {
      const bounce = (data.bounce ?? {}) as { type?: unknown };

      return {
        ...base,
        kind: /permanent|hard/i.test(str(bounce.type)) ? "hard-bounce" : "soft-bounce",
      };
    }

    case "email.complained":
      return { ...base, kind: "complaint" };
    // Resend's own suppression list: an account-wide restriction Bye must respect as a minimum.
    case "email.suppressed":
      return { ...base, kind: "hard-bounce", scope: "provider" };
    case "contact.updated":
    case "contact.created":
      if (!Predicate.isBoolean(data.unsubscribed)) return { ...base, kind: "informational" };

      // The contact flag is account-wide ("unsubscribed from all Broadcasts").
      return {
        ...base,
        kind: data.unsubscribed ? "contact-unsubscribed" : "contact-subscribed",
        scope: "provider",
      };
    case "email.sent":
    case "email.opened":
    case "email.clicked":
    case "email.delivery_delayed":
    case "email.scheduled":
    case "contact.deleted":
      return { ...base, kind: "informational" };
    default:
      return { ...base, kind: "unmapped" };
  }
};

export const makeResendNewsletterProvider = (
  config: ResendConfig,
  fetchFn: FetchLike,
): NewsletterProviderService => {
  const base = config.baseUrl ?? RESEND_API;

  const request = (method: string, path: string, body?: Schema.Json) =>
    Effect.tryPromise({
      try: () => {
        const init: ResendRequestInit = {
          method,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            // Requests without a User-Agent are refused by Resend's edge.
            "user-agent": "bye-mailcore/1",
          },
          signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
        };

        if (body !== undefined) init.body = JSON.stringify(body);

        return fetchFn(`${base}${path}`, init);
      },
      // The request may have reached the provider: never "not accepted".
      catch: (e): Extract<OperationOutcome, { _tag: "Unknown" }> => ({
        _tag: "Unknown",
        detail: e instanceof Error ? e.name : "network",
      }),
    });

  const errorName = async (r: Response_): Promise<string> => {
    try {
      const b = await r.json();

      return isJsonObject(b) && Predicate.isString(b.name) ? b.name.slice(0, 60) : "";
    } catch {
      return "";
    }
  };

  /** Run a mutating call; 2xx → Accepted with the returned id (or `fallbackRef`). */
  const mutate = (
    method: string,
    path: string,
    body: Schema.Json | undefined,
    fallbackRef: string,
  ) =>
    request(method, path, body).pipe(
      Effect.flatMap((r) =>
        Effect.promise(async (): Promise<OperationOutcome> => {
          if (r.status >= 200 && r.status < 300) {
            let id = fallbackRef;

            try {
              const b = await r.json();

              if (isJsonObject(b) && Predicate.isString(b.id) && b.id) id = b.id;
            } catch {
              // An unreadable success body is still an acceptance.
            }

            return { _tag: "Accepted", providerRef: id };
          }

          return classifyResendStatus(r.status, await errorName(r));
        }),
      ),
      Effect.catch((outcome) => Effect.succeed<OperationOutcome>(outcome)),
    );

  const lookup = (
    path: string,
    pick: (body: Schema.Json | undefined) => Schema.JsonObject | undefined,
  ) =>
    request("GET", path).pipe(
      Effect.flatMap((r) =>
        Effect.promise(async (): Promise<BroadcastLookup> => {
          if (r.status === 404) return { _tag: "Absent" };

          if (r.status !== 200) return { _tag: "Inconclusive", detail: `http ${r.status}` };
          const b = pick(await r.json().catch(() => undefined));

          if (!b) return { _tag: "Absent" };
          const state = RESEND_STATES.get(str(b.status));

          if (!state || !Predicate.isString(b.id))
            return { _tag: "Inconclusive", detail: "unrecognized broadcast" };

          return {
            _tag: "Found",
            broadcast: {
              providerRef: b.id,
              audienceId: str(b.segment_id) || str(b.audience_id),
              subject: str(b.subject),
              from: str(b.from),
              state,
            },
          };
        }),
      ),
      Effect.catch((o) =>
        Effect.succeed<BroadcastLookup>({ _tag: "Inconclusive", detail: o.detail }),
      ),
    );

  return {
    capabilities: RESEND_CAPABILITIES,
    account: config.account,
    createAudience: (name, operationId) =>
      Effect.gen(function* () {
        const segment = yield* mutate("POST", "/segments", { name }, "");

        if (!Predicate.isTagged(segment, "Accepted") || !segment.providerRef)
          return segment as AudienceOutcome;

        // opt_out default: only contacts that explicitly opt in receive this creator's broadcasts.
        const topic = yield* mutate(
          "POST",
          "/topics",
          {
            name: name.slice(0, 50),
            default_subscription: "opt_out",
            description: `bye ${operationId}`.slice(0, 200),
          },
          "",
        );

        if (!Predicate.isTagged(topic, "Accepted") || !topic.providerRef)
          return (
            Predicate.isTagged(topic, "Accepted")
              ? { _tag: "Unknown", detail: "topic id missing" }
              : topic
          ) as AudienceOutcome;

        const out: AudienceOutcome = {
          _tag: "Accepted",
          audience: { audienceId: segment.providerRef, scopeId: topic.providerRef },
        };

        return out;
      }),
    syncContact: (audience, change) =>
      Effect.gen(function* () {
        const email = encodeURIComponent(change.address);

        if (!audience.scopeId)
          return {
            _tag: "NotAccepted",
            retryable: false,
            detail: "audience has no topic",
          } as const;

        const topics = [
          { id: audience.scopeId, subscription: change.subscribed ? "opt_in" : "opt_out" },
        ];

        const updated = yield* mutate("PATCH", `/contacts/${email}/topics`, topics, change.address);

        if (!change.subscribed) {
          // No contact at the provider means there is nothing to exclude.
          return Predicate.isTagged(updated, "NotAccepted") && updated.detail.startsWith("http 404")
            ? ({ _tag: "Accepted", providerRef: change.address } as const)
            : updated;
        }

        if (Predicate.isTagged(updated, "NotAccepted") && updated.detail.startsWith("http 404"))
          return yield* mutate(
            "POST",
            "/contacts",
            { email: change.address, segments: [{ id: audience.audienceId }], topics },
            change.address,
          );

        if (!Predicate.isTagged(updated, "Accepted")) return updated;

        const joined = yield* mutate(
          "POST",
          `/contacts/${email}/segments/${encodeURIComponent(audience.audienceId)}`,
          undefined,
          change.address,
        );

        // Already a member is fine: membership is a set.
        return Predicate.isTagged(joined, "NotAccepted") && /http 409/.test(joined.detail)
          ? updated
          : joined;
      }),
    createBroadcast: (draft) => {
      if (Object.keys(draft.headers).length > 0)
        return Effect.succeed<OperationOutcome>({
          _tag: "NotAccepted",
          retryable: false,
          detail: "resend broadcasts cannot carry custom headers",
        });

      const broadcastBody: ResendBroadcastBody = {
        segment_id: draft.audience.audienceId,
        from: draft.from,
        subject: draft.subject,
        html: draft.html,
        text: draft.text,
        name: draft.name,
      };

      if (draft.audience.scopeId) broadcastBody.topic_id = draft.audience.scopeId;

      if (draft.replyTo) broadcastBody.reply_to = draft.replyTo;

      return mutate("POST", "/broadcasts", broadcastBody, "").pipe(
        Effect.map((o): OperationOutcome =>
          Predicate.isTagged(o, "Accepted") && !o.providerRef
            ? { _tag: "Unknown", detail: "broadcast id missing" }
            : o,
        ),
      );
    },
    sendBroadcast: (providerRef, _operationId, scheduledAt) =>
      scheduledAt !== null
        ? Effect.succeed<OperationOutcome>({
            _tag: "NotAccepted",
            retryable: false,
            detail: "provider scheduling is disabled",
          })
        : mutate("POST", `/broadcasts/${encodeURIComponent(providerRef)}/send`, {}, providerRef),
    cancelBroadcast: (providerRef) =>
      mutate("POST", `/broadcasts/${encodeURIComponent(providerRef)}/cancel`, {}, providerRef),
    getBroadcast: (providerRef) =>
      lookup(`/broadcasts/${encodeURIComponent(providerRef)}`, (b) =>
        isJsonObject(b) ? b : undefined,
      ),
    findBroadcast: (name) =>
      // Bounded: the newest page only. A missing name there is inconclusive, never proof of absence.
      lookup("/broadcasts?limit=100", (body) => {
        const list = isJsonObject(body) && Array.isArray(body.data) ? body.data : [];

        return list.filter(isJsonObject).find((b) => b.name === name);
      }).pipe(
        Effect.map((l): BroadcastLookup =>
          Predicate.isTagged(l, "Absent")
            ? { _tag: "Inconclusive", detail: "not in newest page" }
            : l,
        ),
      ),
    verifyEvents: (body, headers, now) =>
      Effect.promise(async (): Promise<EventVerification> => {
        const verified = await verifySvix(config.webhookSecret, body, headers, now);

        if (!verified.ok) return { _tag: "Unauthenticated", detail: verified.detail };
        let payload: Schema.Json;

        try {
          payload = JSON.parse(body);
        } catch {
          return { _tag: "Unauthenticated", detail: "unparseable body" };
        }

        const envelope = Option.getOrElse(decodeResendWebhook(payload), () => noWebhookPayload);

        return { _tag: "Verified", events: [mapResendEvent(verified.id, envelope)] };
      }),
  };
};
