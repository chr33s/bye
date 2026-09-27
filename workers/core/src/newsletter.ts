import type { NewsletterProviderShape } from "@bye/application";
import {
  checkOperation,
  type OperationOutcome,
  publicationFingerprintInput,
  sha256Hex,
} from "@bye/domain";
import {
  type AudienceMapping,
  makeResendNewsletterProvider,
  type NewsletterConfig,
  type NewsletterLedger,
  type NewsletterMethod,
  type PublicationRow,
  RESEND_UNSUBSCRIBE_PLACEHOLDER,
  type RpcResult,
} from "@bye/platform-cloudflare";
import { Effect } from "effect";
import { settle, world } from "./authorities.ts";
import type { CoreEnv } from "./env.ts";
import { escapeHtml } from "./html.ts";
import { metric } from "./metrics.ts";
import { loadRuntimeNewsletterConfig } from "./newsletter-config.ts";
import { origins } from "./origins.ts";
import { publicHtml } from "./publishing.ts";

// Newsletter engine (spec.md §5.5). Drives a creator's provider work from the
// ledger in its WorldDO: audience mapping, contact sync, then the open publication's
// create → verify → send, cancellation and reconciliation. Each provider call is preceded by a
// durable claim of its operation and followed by a settle; an ambiguous outcome is reconciled from
// provider evidence or held for an operator, never replayed blindly or failed over.

export type NewsletterSetup =
  | {
      readonly _tag: "Ready";
      readonly provider: NewsletterProviderShape;
      readonly config: NewsletterConfig;
      /**
       * Why NEW dispatch (audience creation, additions, drafts, sends) is blocked, or null. Removal
       * sync, reconciliation, cancellation and event intake continue while credentials permit.
       */
      readonly dispatchBlocked: string | null;
    }
  | { readonly _tag: "Blocked"; readonly reason: string };

/**
 * The configured provider (and whether it may dispatch), or why newsletters are unavailable.
 * Resolution order (infra/onboarding/spec.md §26): the sealed runtime configuration an operator entered,
 * else the legacy deployment env (`NEWSLETTER_*`), else blocked. The two sources are never mixed: a
 * runtime row that cannot be opened blocks rather than falling through to env credentials.
 * Credentials are decrypted per call and live only as long as the returned provider.
 */
export const newsletterSetup = async (
  env: CoreEnv,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
): Promise<NewsletterSetup> => {
  const runtime = await loadRuntimeNewsletterConfig(env);
  if (runtime._tag === "Unusable") return { _tag: "Blocked", reason: runtime.reason };
  let credentials: { apiKey: string; webhookSecret: string; account: string; provider: string };
  if (runtime._tag === "Present") credentials = runtime.credentials;
  else {
    const name = (env.NEWSLETTER_PROVIDER ?? "").trim();
    if (!name) return { _tag: "Blocked", reason: "no newsletter provider configured" };
    if (name !== "resend")
      return { _tag: "Blocked", reason: `unknown newsletter provider ${name}` };
    if (!env.NEWSLETTER_API_KEY || !env.NEWSLETTER_WEBHOOK_SECRET || !env.NEWSLETTER_ACCOUNT)
      return { _tag: "Blocked", reason: "newsletter credentials incomplete" };
    credentials = {
      provider: name,
      apiKey: env.NEWSLETTER_API_KEY,
      webhookSecret: env.NEWSLETTER_WEBHOOK_SECRET,
      account: env.NEWSLETTER_ACCOUNT,
    };
  }
  // Previews never hold production subscriber data: their sandbox forbids external audiences.
  if ((env.MAIL_SANDBOX_DOMAINS ?? "").trim())
    return { _tag: "Blocked", reason: "newsletters are disabled in sandboxed stages" };
  const provider = makeResendNewsletterProvider(
    {
      apiKey: credentials.apiKey,
      webhookSecret: credentials.webhookSecret,
      account: credentials.account,
    },
    (u, i) => fetchFn(u, i as RequestInit),
  );
  return {
    _tag: "Ready",
    provider,
    config: {
      provider: credentials.provider,
      account: credentials.account,
      configVersion: `${provider.capabilities.apiVersion}#${(env.NEWSLETTER_QUALIFIED ?? "").trim()}`,
    },
    // Release qualification is evidence, not a default: without it dispatch stays blocked. It is
    // deployment configuration only; the runtime config API cannot set it.
    dispatchBlocked: (env.NEWSLETTER_QUALIFIED ?? "").trim()
      ? null
      : "newsletter provider not qualified for this stage",
  };
};

type Ledger = NewsletterLedger;
export type LedgerCall = <K extends NewsletterMethod>(
  method: K,
  ...args: Parameters<Ledger[K]>
) => Promise<ReturnType<Ledger[K]>>;

/** Typed access to one creator's ledger over the WorldDO `newsletter` RPC. */
export const ledgerOf = (env: CoreEnv, handle: string): LedgerCall => {
  const stub = world(env, handle) as unknown as {
    newsletter(method: string, ...args: Array<unknown>): Promise<RpcResult<unknown>>;
  };
  return ((method: string, ...args: Array<unknown>) =>
    settle(stub.newsletter(method, ...args))) as LedgerCall;
};

interface PostContent {
  readonly slug: string;
  readonly title: string;
  readonly html: string;
  readonly text: string;
}

/**
 * The broadcast body: one content for every recipient. Unsubscribe is the provider's per-recipient
 * link, scoped to this creator's topic; no Bye-issued token can be personalised in a broadcast.
 */
export const renderNewsletter = (env: CoreEnv, handle: string, post: PostContent) => {
  const { publicOrigin: origin, serviceDomain: domain } = origins(env);
  const online = `${origin}/@${handle}/${post.slug}`;
  return {
    from: `@${handle} <world@${domain}>`,
    subject: post.title,
    html: `${publicHtml(post.html)}<hr><p><a href="${escapeHtml(online)}">Read online</a> · <a href="${RESEND_UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe from @${escapeHtml(handle)}</a></p>`,
    text: `${post.text}\n\n—\nRead online: ${online}\nUnsubscribe from @${handle}: ${RESEND_UNSUBSCRIBE_PLACEHOLDER}`,
  };
};

const fingerprint = async (
  postId: string,
  revision: number,
  message: ReturnType<typeof renderNewsletter>,
  scheduledAt: number | null,
) =>
  sha256Hex(
    publicationFingerprintInput({ postId, revision, ...message, from: message.from, scheduledAt }),
  );

const loadPost = (env: CoreEnv, handle: string, postId: string, revision: number) =>
  settle(world(env, handle).publishedRevision(postId, revision)) as Promise<PostContent>;

/**
 * Approve the publication of one post version: binds content, sender and the currently eligible
 * audience (snapshot taken inside the ledger). Idempotent per version.
 */
export const approveNewsletter = async (
  env: CoreEnv,
  handle: string,
  postId: string,
  revision: number,
  scheduledAt: number | null = null,
): Promise<PublicationRow | { readonly blocked: string }> => {
  const setup = await newsletterSetup(env);
  if (setup._tag === "Blocked") return { blocked: setup.reason };
  if (setup.dispatchBlocked) return { blocked: setup.dispatchBlocked };
  const post = await loadPost(env, handle, postId, revision);
  const message = renderNewsletter(env, handle, post);
  return ledgerOf(env, handle)("approve", {
    ...setup.config,
    postId,
    revision,
    sender: message.from,
    subject: message.subject,
    fingerprint: await fingerprint(postId, revision, message, scheduledAt),
    scheduledAt,
  });
};

export interface NewsletterRun {
  readonly blocked?: string;
  readonly synced: number;
  readonly publication?: {
    readonly id: string;
    readonly state: string;
    readonly detail: string | null;
  };
}

const SYNC_BATCH = 25;

const recordRef = (
  env: CoreEnv,
  config: NewsletterConfig,
  kind: "audience" | "broadcast",
  ref: string,
  handle: string,
) =>
  env.DIRECTORY.prepare(
    "INSERT OR IGNORE INTO newsletter_refs (provider, account, kind, ref, handle, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(config.provider, config.account, kind, ref, handle, Date.now())
    .run();

/** One bounded pass over a creator's newsletter work. Safe to run concurrently and repeatedly. */
export const runNewsletter = async (
  env: CoreEnv,
  handle: string,
  fetchFn?: typeof fetch,
): Promise<NewsletterRun> => {
  const setup = await newsletterSetup(env, fetchFn);
  if (setup._tag === "Blocked") return { blocked: setup.reason, synced: 0 };
  const { provider, config, dispatchBlocked } = setup;
  const L = ledgerOf(env, handle);
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);

  // 1. Audience. A mapping to another provider/account is never silently replaced.
  let audience = await L("audience");
  if (audience && (audience.provider !== config.provider || audience.account !== config.account))
    return {
      blocked: "creator is mapped to another provider account; reconcile before switching",
      synced: 0,
    };
  if (!audience && dispatchBlocked) return { blocked: dispatchBlocked, synced: 0 };
  if (!audience) {
    const opId = `aud_${handle}`;
    const claim = await L("claimOp", opId, "audience", null, null);
    if (claim._tag === "Reconcile") {
      // No documented lookup for a half-created segment/topic pair: hold for an operator.
      await L("reconcileOp", opId, "inconclusive");
      return { blocked: "audience creation outcome unknown", synced: 0 };
    }
    if (claim._tag === "Skip")
      return { blocked: `audience operation ${claim.op.state}`, synced: 0 };
    const created = await run(provider.createAudience(`bye-${handle}`, opId));
    if (created._tag !== "Accepted") {
      await L("settleOp", opId, created, null);
      return { blocked: `audience not created: ${created.detail}`, synced: 0 };
    }
    const mapping: AudienceMapping = {
      ...config,
      audienceId: created.audience.audienceId,
      ...(created.audience.scopeId ? { scopeId: created.audience.scopeId } : {}),
    };
    await L("mapAudience", mapping);
    await recordRef(env, config, "audience", mapping.audienceId, handle);
    await L("settleOp", opId, { _tag: "Accepted", providerRef: mapping.audienceId }, null);
    audience = mapping;
  }
  const ref = {
    audienceId: audience.audienceId,
    ...(audience.scopeId ? { scopeId: audience.scopeId } : {}),
  };

  // 2. Contact sync (removals first; additions wait while a publication is open).
  let synced = 0;
  for (const item of await L("dueSync", SYNC_BATCH)) {
    // Removals always reach the provider; additions only while dispatch is enabled.
    if (item.subscribed && dispatchBlocked) continue;
    const op = item.subscribed ? "contact-sync" : "unsubscribe-sync";
    const check = checkOperation(provider.capabilities, op);
    const outcome: OperationOutcome =
      check._tag === "Ok"
        ? await run(
            provider.syncContact(ref, { address: item.address, subscribed: item.subscribed }),
          )
        : { _tag: "NotAccepted", retryable: false, detail: check.detail };
    await L("settleSync", item.address, item.revision, outcome);
    if (outcome._tag === "Accepted") {
      synced++;
      await env.DIRECTORY.prepare(
        "INSERT INTO newsletter_contacts (provider, account, address, handle, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET updated_at = excluded.updated_at",
      )
        .bind(config.provider, config.account, item.address, handle, Date.now())
        .run();
    }
    // Rate limited: stop this pass; the outbox keeps the rest.
    if (outcome._tag === "NotAccepted" && outcome.detail.startsWith("http 429")) break;
  }

  // 3. The open publication.
  const open = await L("openPublication");
  if (!open) return { synced };
  const after = await advancePublication(
    env,
    handle,
    provider,
    config,
    ref,
    open,
    L,
    dispatchBlocked,
  );
  return {
    synced,
    publication: { id: after.id, state: after.state, detail: after.detail },
  };
};

/** Advance one publication by at most one provider step per state. */
export const advancePublication = async (
  env: CoreEnv,
  handle: string,
  provider: NewsletterProviderShape,
  config: NewsletterConfig,
  audience: { readonly audienceId: string; readonly scopeId?: string },
  p: PublicationRow,
  L: LedgerCall,
  dispatchBlocked: string | null = null,
): Promise<PublicationRow> => {
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);
  const now = Date.now();
  const hold = (detail: string) => L("setPublication", p.id, { state: "held", detail });
  const wait = (detail: string) => L("setPublication", p.id, { detail });

  if (p.provider !== config.provider || p.account !== config.account)
    return hold("publication bound to another provider account; never failed over");

  // Cancellation requested after submission.
  if (p.cancel?._tag === "Requested") return cancelSubmitted(provider, p, L);

  if (p.state === "submitted" || (p.state === "submit-pending" && p.providerRef)) {
    if (p.state === "submit-pending") {
      const settled = await settleAmbiguous(provider, p, "send", L);
      if (settled) return settled;
    }
    const seen = await run(provider.getBroadcast(p.providerRef!));
    return seen._tag === "Found" ? L("observe", p.id, seen.broadcast.state) : p;
  }

  if (p.state === "draft-pending") {
    const settled = await settleAmbiguous(provider, p, "create", L);
    if (settled) return settled;
  }

  if (p.state !== "approved" && p.state !== "drafted") return p;
  // Disabling sends stops new provider steps; it never asserts that submitted work was cancelled.
  if (dispatchBlocked) return wait(dispatchBlocked);

  // Dispatch-time rechecks: still published, within its send window, due, fresh, no drift.
  const published = await settle(world(env, handle).isPublished(p.postId, p.revision));
  if (!published) return L("requestCancel", p.id);
  if (now > p.expiresAt) return hold("send window expired before dispatch; approve again to send");
  if (p.scheduledAt !== null && p.scheduledAt > now) return wait("scheduled");
  const sync = await L("freshness", p.id);
  if (sync.pending > 0 || sync.held > 0)
    return wait(
      sync.held > 0
        ? "contact sync held; freshness cannot be established"
        : "awaiting contact sync",
    );
  const drift = await L("audienceDrift", p.id);
  if (drift.length > 0)
    return hold(`provider audience exceeds approved snapshot (${drift.length})`);
  const eligible = await L("snapshotEligible", p.id);
  if (eligible.eligible === 0)
    return L("setPublication", p.id, {
      state: "cancelled",
      detail: "no eligible recipients",
      cancel: { _tag: "Confirmed", coverage: "complete" },
    });

  const post = await loadPost(env, handle, p.postId, p.revision);
  const message = renderNewsletter(env, handle, post);
  if ((await fingerprint(p.postId, p.revision, message, p.scheduledAt)) !== p.fingerprint)
    return hold("content no longer matches the approved publication");

  if (p.state === "approved") {
    const check = checkOperation(provider.capabilities, "broadcast-create");
    if (check._tag !== "Ok") return hold(check.detail);
    const opId = `${p.id}:create`;
    const claim = await L("claimOp", opId, "create", p.id, check.capability.idempotency);
    if (claim._tag !== "Proceed") return p;
    await L("setPublication", p.id, { state: "draft-pending" });
    const outcome = await run(
      provider.createBroadcast({
        operationId: opId,
        audience,
        name: p.id,
        from: message.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: {},
      }),
    );
    const op = await L("settleOp", opId, outcome, check.capability.idempotency);
    if (op.state === "accepted" && op.providerRef) {
      await recordRef(env, config, "broadcast", op.providerRef, handle);
      return L("setPublication", p.id, {
        state: "drafted",
        providerRef: op.providerRef,
        detail: null,
      });
    }
    if (op.state === "rejected")
      return L("setPublication", p.id, { state: "failed", detail: op.detail });
    if (op.state === "pending")
      return L("setPublication", p.id, { state: "approved", detail: op.detail });
    return L("setPublication", p.id, { detail: `create ${op.state}` });
  }

  // drafted: verify the provider draft still matches before submitting it.
  const check = checkOperation(provider.capabilities, "broadcast-send", {
    exclusionsAtDispatch: true,
  });
  if (check._tag !== "Ok") return hold(check.detail);
  const seen = await run(provider.getBroadcast(p.providerRef!));
  if (seen._tag !== "Found") return wait(`draft lookup ${seen._tag}`);
  const b = seen.broadcast;
  if (
    b.state !== "draft" ||
    b.subject !== p.subject ||
    b.from !== p.sender ||
    b.audienceId !== audience.audienceId
  )
    return hold("provider draft does not match the publication");
  const opId = `${p.id}:send`;
  const claim = await L("claimOp", opId, "send", p.id, check.capability.idempotency);
  if (claim._tag !== "Proceed") return p;
  await L("setPublication", p.id, { state: "submit-pending" });
  const outcome = await run(provider.sendBroadcast(p.providerRef!, opId, null));
  const op = await L("settleOp", opId, outcome, check.capability.idempotency);
  if (op.state === "accepted")
    return L("setPublication", p.id, { state: "submitted", detail: null });
  if (op.state === "rejected")
    return L("setPublication", p.id, { state: "failed", detail: op.detail });
  if (op.state === "pending")
    return L("setPublication", p.id, { state: "drafted", detail: op.detail });
  return L("setPublication", p.id, { detail: `send ${op.state}` });
};

/**
 * Resolve an ambiguous create/send from provider evidence. Returns the updated publication when
 * this pass should stop, or null when the operation was settled and the caller may continue.
 */
const settleAmbiguous = async (
  provider: NewsletterProviderShape,
  p: PublicationRow,
  kind: "create" | "send",
  L: LedgerCall,
): Promise<PublicationRow | null> => {
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);
  const opId = `${p.id}:${kind}`;
  const op = await L("operation", opId);
  if (!op) return L("setPublication", p.id, { state: kind === "create" ? "approved" : "drafted" });
  if (op.state === "accepted") {
    return L("setPublication", p.id, {
      state: kind === "create" ? "drafted" : "submitted",
      ...(op.providerRef && kind === "create" ? { providerRef: op.providerRef } : {}),
      detail: null,
    });
  }
  if (op.state === "pending") {
    return L("setPublication", p.id, { state: kind === "create" ? "approved" : "drafted" });
  }
  if (op.state === "in-flight") {
    // Claim again: a live lease skips; an expired one turns into Unknown for reconciliation below.
    const claim = await L("claimOp", opId, kind, p.id, null);
    if (claim._tag === "Skip") return p;
    if (claim._tag === "Proceed") {
      // Only reachable when the provider protects retries; the ledger decided it is safe.
      await L("settleOp", opId, { _tag: "Unknown", detail: "re-claimed without a call" }, null);
      return p;
    }
  }
  if (op.state === "held" || op.state === "rejected")
    return L("setPublication", p.id, {
      state: "held",
      detail: `${kind} ${op.state}: ${op.detail ?? ""}`,
    });
  // Unknown: look for provider evidence. Absence is never inferred from a missing record.
  if (kind === "create") {
    const found = await run(provider.findBroadcast(p.id));
    if (found._tag === "Found") {
      await L("reconcileOp", opId, "accepted", found.broadcast.providerRef);
      return L("setPublication", p.id, {
        state: "drafted",
        providerRef: found.broadcast.providerRef,
        detail: "create reconciled",
      });
    }
  } else {
    const seen = await run(provider.getBroadcast(p.providerRef!));
    if (seen._tag === "Found" && seen.broadcast.state !== "draft") {
      await L("reconcileOp", opId, "accepted", p.providerRef!);
      await L("setPublication", p.id, { state: "submitted", detail: "send reconciled" });
      return L("observe", p.id, seen.broadcast.state);
    }
  }
  await L("reconcileOp", opId, "inconclusive");
  return L("setPublication", p.id, {
    state: "held",
    detail: `${kind} outcome unknown; awaiting operator review`,
  });
};

const cancelSubmitted = async (
  provider: NewsletterProviderShape,
  p: PublicationRow,
  L: LedgerCall,
): Promise<PublicationRow> => {
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);
  const check = checkOperation(provider.capabilities, "broadcast-cancel");
  if (check._tag !== "Ok")
    return L("setPublication", p.id, { cancel: { _tag: "Unsupported", detail: check.detail } });
  if (!p.providerRef)
    return L("setPublication", p.id, {
      cancel: { _tag: "Uncertain", detail: "no provider reference for the submitted broadcast" },
    });
  const before = await run(provider.getBroadcast(p.providerRef));
  if (before._tag === "Found") {
    const observed = await L("observe", p.id, before.broadcast.state);
    if (observed.state === "cancelled") return observed;
    if (before.broadcast.state === "sent")
      return L("setPublication", p.id, {
        cancel: { _tag: "Unsupported", detail: "already sent; cancellation cannot recall mail" },
      });
  }
  const opId = `${p.id}:cancel`;
  const claim = await L("claimOp", opId, "cancel", p.id, check.capability.idempotency);
  if (claim._tag === "Reconcile") {
    await L("reconcileOp", opId, "inconclusive");
    return L("setPublication", p.id, {
      cancel: { _tag: "Uncertain", detail: "cancel outcome unknown" },
    });
  }
  if (claim._tag === "Skip") {
    // Already accepted: confirm coverage from the observed state.
    const seen = await run(provider.getBroadcast(p.providerRef));
    return seen._tag === "Found" ? L("observe", p.id, seen.broadcast.state) : p;
  }
  const outcome = await run(provider.cancelBroadcast(p.providerRef, opId));
  const op = await L("settleOp", opId, outcome, check.capability.idempotency);
  if (op.state === "accepted") {
    const seen = await run(provider.getBroadcast(p.providerRef));
    if (seen._tag === "Found") {
      const observed = await L("observe", p.id, seen.broadcast.state);
      if (observed.state === "cancelled") return observed;
      // Scheduled broadcasts return to draft on cancel: nothing was sent.
      if (seen.broadcast.state === "draft")
        return L("setPublication", p.id, {
          state: "cancelled",
          cancel: { _tag: "Confirmed", coverage: "complete" },
        });
    }
    return p;
  }
  if (op.state === "rejected")
    return L("setPublication", p.id, {
      cancel: { _tag: "Unsupported", detail: op.detail ?? "provider refused cancellation" },
    });
  if (op.state === "unknown" || op.state === "held")
    return L("setPublication", p.id, {
      cancel: { _tag: "Uncertain", detail: op.detail ?? "unknown" },
    });
  return p;
};

// ---- provider events ----

export type EventIntake =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Unauthenticated"; readonly detail: string }
  | { readonly _tag: "Persisted"; readonly events: number; readonly applied: number };

interface StoredEvent {
  readonly provider: string;
  readonly account: string;
  readonly event_id: string;
  readonly kind: string;
  readonly raw_type: string;
  readonly scope: string | null;
  readonly address: string | null;
  readonly broadcast_ref: string | null;
  readonly occurred_at: number;
}

/**
 * Authenticate a provider webhook, persist every event (idempotently) BEFORE acknowledging, then
 * try to apply them. Events that fail to apply stay `received` for the reconciler.
 */
export const intakeNewsletterEvents = async (
  env: CoreEnv,
  body: string,
  headers: Headers,
  now = Date.now(),
): Promise<EventIntake> => {
  const setup = await newsletterSetup(env);
  if (setup._tag === "Blocked") return { _tag: "Unavailable" };
  const verified = await Effect.runPromise(setup.provider.verifyEvents(body, headers, now));
  if (verified._tag === "Unauthenticated")
    return { _tag: "Unauthenticated", detail: verified.detail };
  const { provider, account } = setup.config;
  await env.DIRECTORY.batch(
    verified.events.map((e) =>
      env.DIRECTORY.prepare(
        `INSERT OR IGNORE INTO newsletter_events (provider, account, event_id, kind, raw_type, scope, address, broadcast_ref, occurred_at, received_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        provider,
        account,
        e.eventId,
        e.kind,
        e.rawType,
        e.scope ?? null,
        e.address ?? null,
        e.broadcastRef ?? null,
        e.occurredAt,
        now,
        // Informational events are retained as applied (nothing to do); nothing else is dropped.
        e.kind === "informational" ? "applied" : "received",
      ),
    ),
  );
  let applied = 0;
  for (const e of verified.events) {
    if (e.kind === "informational") continue;
    try {
      if (await applyStoredEvent(env, { provider, account, event_id: e.eventId })) applied++;
    } catch {
      // Left `received`: the reconciler applies it later. The receipt is already durable.
    }
  }
  return { _tag: "Persisted", events: verified.events.length, applied };
};

/**
 * Route one persisted event to the creators it belongs to (by broadcast, else by synced contact)
 * and apply it there. Each WorldDO de-duplicates by event ID, so a partial failure is safe to redo.
 */
export const applyStoredEvent = async (
  env: CoreEnv,
  key: { readonly provider: string; readonly account: string; readonly event_id: string },
): Promise<boolean> => {
  const e = await env.DIRECTORY.prepare(
    "SELECT * FROM newsletter_events WHERE provider = ? AND account = ? AND event_id = ? AND state = 'received'",
  )
    .bind(key.provider, key.account, key.event_id)
    .first<StoredEvent>();
  if (!e) return true;
  await env.DIRECTORY.prepare(
    "UPDATE newsletter_events SET attempts = attempts + 1 WHERE provider = ? AND account = ? AND event_id = ?",
  )
    .bind(e.provider, e.account, e.event_id)
    .run();
  // Bound to the configured provider account: refs from any other account never match.
  const handles = e.broadcast_ref
    ? (
        await env.DIRECTORY.prepare(
          "SELECT handle FROM newsletter_refs WHERE provider = ? AND account = ? AND kind = 'broadcast' AND ref = ?",
        )
          .bind(e.provider, e.account, e.broadcast_ref)
          .all<{ handle: string }>()
      ).results
    : e.address
      ? (
          await env.DIRECTORY.prepare(
            "SELECT handle FROM newsletter_contacts WHERE provider = ? AND account = ? AND address = ? LIMIT 500",
          )
            .bind(e.provider, e.account, e.address)
            .all<{ handle: string }>()
        ).results
      : [];
  let mapped = false;
  for (const { handle } of handles) {
    const r = await ledgerOf(env, handle)("applyEvent", {
      eventId: e.event_id,
      kind: e.kind,
      rawType: e.raw_type,
      ...(e.address ? { address: e.address } : {}),
      ...(e.broadcast_ref ? { broadcastRef: e.broadcast_ref } : {}),
      ...(e.scope === "provider" || e.scope === "creator" ? { scope: e.scope } : {}),
      occurredAt: Number(e.occurred_at),
    });
    if (r !== "unmapped") mapped = true;
  }
  await env.DIRECTORY.prepare(
    "UPDATE newsletter_events SET state = ? WHERE provider = ? AND account = ? AND event_id = ?",
  )
    .bind(mapped ? "applied" : "unmapped", e.provider, e.account, e.event_id)
    .run();
  if (!mapped) metric("newsletter.event.unmapped", 1, { kind: e.kind });
  return true;
};

/** Creators reconciled per cron run, least recently run first. */
export const NEWSLETTER_RECONCILE_BATCH = 20;

/**
 * Cron reconciliation: re-apply persisted events, then run a bounded pass for the creators whose
 * newsletter work was looked at least recently. Emits lag/uncertainty counters for alerting.
 */
export const reconcileNewsletters = async (
  env: CoreEnv,
  now = Date.now(),
): Promise<{ readonly events: number; readonly creators: number; readonly failures: number }> => {
  const setup = await newsletterSetup(env);
  if (setup._tag === "Blocked") return { events: 0, creators: 0, failures: 0 };
  const { provider, account } = setup.config;
  let events = 0;
  let failures = 0;
  const pending = await env.DIRECTORY.prepare(
    "SELECT provider, account, event_id, received_at FROM newsletter_events WHERE provider = ? AND account = ? AND state = 'received' ORDER BY received_at LIMIT 100",
  )
    .bind(provider, account)
    .all<{ provider: string; account: string; event_id: string; received_at: number }>();
  const oldest = pending.results[0]?.received_at;
  metric("newsletter.event.lag_ms", oldest ? now - Number(oldest) : 0);
  for (const row of pending.results) {
    try {
      if (await applyStoredEvent(env, row)) events++;
    } catch {
      failures++;
    }
  }
  const creators = await env.DIRECTORY.prepare(
    "SELECT ref, handle FROM newsletter_refs WHERE provider = ? AND account = ? AND kind = 'audience' ORDER BY last_run_at LIMIT ?",
  )
    .bind(provider, account, NEWSLETTER_RECONCILE_BATCH)
    .all<{ ref: string; handle: string }>();
  let unknown = 0;
  let held = 0;
  let oldestSync = 0;
  let uncertainCancels = 0;
  for (const c of creators.results) {
    await env.DIRECTORY.prepare(
      "UPDATE newsletter_refs SET last_run_at = ? WHERE provider = ? AND account = ? AND kind = 'audience' AND ref = ?",
    )
      .bind(now, provider, account, c.ref)
      .run();
    try {
      await runNewsletter(env, c.handle);
      const h = await ledgerOf(env, c.handle)("health");
      unknown += h.unknownOps;
      held += h.heldOps;
      uncertainCancels += h.uncertainCancels;
      if (h.oldestSyncPendingAt !== null)
        oldestSync = Math.max(oldestSync, now - h.oldestSyncPendingAt);
    } catch {
      failures++;
    }
  }
  metric("newsletter.ops.unknown", unknown);
  metric("newsletter.ops.held", held);
  metric("newsletter.sync.lag_ms", oldestSync);
  metric("newsletter.cancel.uncertain", uncertainCancels);
  if (unknown + held + uncertainCancels > 0)
    console.warn(
      JSON.stringify({ level: "warn", op: "newsletter.review", unknown, held, uncertainCancels }),
    );
  return { events, creators: creators.results.length, failures };
};
