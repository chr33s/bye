import { Effect, Match, Predicate, type Types } from "effect";
import { requireMailbox, requireScope, requireStepUp } from "@bye/application";
import {
  ApiError,
  OpsDiscardRequest,
  OpsErasureRequest,
  OpsReindexRequest,
  OpsRestoreRequest,
} from "@bye/contracts";
import { isForbiddenProxyTarget } from "@bye/mail-codec";
import { type ExternalCredential, timingSafeEqual } from "@bye/platform-cloudflare";
import { calendar, mailbox, space } from "../authorities.ts";
import { sweepBlobGc } from "../blobgc.ts";
import { discardDeadLetter, listDeadLetters, replayDeadLetter } from "../dlq.ts";
import type { CoreEnv } from "../env.ts";
import { replayTombstones, replayTombstonesFor, startErasure } from "../erasure.ts";
import { validateRestorePoint, awaitRestart } from "../restore.ts";
import {
  errorResponse,
  Invocation,
  json,
  readJson,
  route,
  type Route,
  type RouteHandler,
} from "../http.ts";
import { ok, publicly } from "../httpapi.ts";
import { pruneEndedRegistrations, type PushRegistration, validateRegistration } from "../push.ts";
import { storeExternalCredential } from "../transports.ts";
import { requireUser } from "./common.ts";
import { decodeAs } from "./decode.ts";
import { HttpApiBuilder } from "effect/http-api";
import { CoreApi } from "../spec/index.ts";

// Push device registration (E23), external send-as credentials (E19), and operator recovery
// routes (§6 DLQ inspect/replay, §12 reindex/erasure/tombstone replay). Operator routes take a
// separate OPS_TOKEN bearer — they are never reachable with a user session or API token — so they
// stay native routes; the session/API-token endpoints are in ../spec/ops.ts.

const badRequest = (message: string) => Effect.fail(new ApiError({ code: "bad_request", message }));

const MAX_DEVICES_PER_USER = 20;

/** Operator bearer gate. Disabled entirely when OPS_TOKEN is unset or too short. */
export const isOpsRequest = (request: Request, env: CoreEnv): boolean => {
  const configured = env.OPS_TOKEN ?? "";
  const h = request.headers.get("authorization") ?? "";

  return (
    configured.length >= 32 &&
    h.startsWith("Bearer ") &&
    timingSafeEqual(h.slice(7).trim(), configured)
  );
};

type OpsHandler = (
  request: Request,
  params: Readonly<Record<string, string>>,
  env: CoreEnv,
) => Promise<Response>;

const ops =
  (op: string, handler: OpsHandler): RouteHandler =>
  async (request, params, env) => {
    if (!isOpsRequest(request, env))
      return errorResponse("unauthenticated", "operator token required");
    const response = await handler(request, params, env);
    console.log(
      JSON.stringify(
        params.id
          ? { level: "info", op: `ops.${op}`, status: response.status, id: params.id }
          : { level: "info", op: `ops.${op}`, status: response.status },
      ),
    );

    return response;
  };

/** An operator body decoded with its contract; an absent body reads as `{}`, a malformed one as `null` (→ 400). */
const opsBody = async <S extends Parameters<typeof decodeAs>[0]>(
  request: Request,
  schema: S,
): Promise<S["Type"] | null> => {
  const raw = await readJson(request).catch(() => null);

  return decodeAs(schema, raw ?? {});
};

export const opsRoutes: ReadonlyArray<Route> = [
  // ---- push subscriptions (E23, C02/C10) ----
  route("GET", "/v1/push/vapid-key", async (_r, _p, env) =>
    env.VAPID_PUBLIC_KEY
      ? json({ publicKey: env.VAPID_PUBLIC_KEY })
      : errorResponse("not_found", "web push not configured"),
  ),

  // ---- operator recovery (§6, §12) ----
  route(
    "GET",
    "/v1/ops/dlq",
    ops("dlq.list", async (request, _p, env) => {
      const url = new URL(request.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 500);

      const deadLetters = await listDeadLetters(env, {
        state: url.searchParams.get("state") ?? "held",
        limit,
      });

      return json({ deadLetters });
    }),
  ),
  route(
    "POST",
    "/v1/ops/dlq/:id/replay",
    ops("dlq.replay", async (_r, params, env) => {
      const outcome = await replayDeadLetter(env, params.id!);

      return Predicate.isTagged(outcome, "NotFound")
        ? errorResponse("not_found", "no held dead letter")
        : json(outcome, Predicate.isTagged(outcome, "Unroutable") ? 409 : 200);
    }),
  ),
  route(
    "POST",
    "/v1/ops/dlq/:id/discard",
    ops("dlq.discard", async (request, params, env) => {
      const b = await opsBody(request, OpsDiscardRequest);

      if (!b) return errorResponse("bad_request", "invalid body");
      const note = b.note ?? "discarded by operator";

      return (await discardDeadLetter(env, params.id!, note))
        ? json({ ok: true })
        : errorResponse("not_found", "no held dead letter");
    }),
  ),
  route(
    "POST",
    "/v1/ops/reindex",
    ops("reindex", async (request, _p, env) => {
      const b = await opsBody(request, OpsReindexRequest);

      if (!b) return errorResponse("bad_request", "mailboxId required");
      const { mailboxId } = b;

      const instance = await env.REINDEX.create({
        id: `reindex-${mailboxId}-${Date.now()}`,
        params: { v: 1, mailboxId },
      });

      return json({ instanceId: instance.id }, 202);
    }),
  ),
  route(
    "POST",
    "/v1/ops/erasure",
    ops("erasure", async (request, _p, env) => {
      const b = await opsBody(request, OpsErasureRequest);

      if (!b) return errorResponse("bad_request", "userId required");
      const { instanceId, plan } = await startErasure(env, b.userId, b.reason ?? "operator");

      return json(
        {
          instanceId,
          mailboxes: plan.mailboxIds.length,
          calendars: plan.calendarIds.length,
          spaces: plan.spaceIds.length,
        },
        202,
      );
    }),
  ),
  // Point-in-time restore of one authority (§12), followed by tombstone replay so erased data is
  // never resurrected. Requires an explicit `confirm` echo of the target ID.
  route(
    "POST",
    "/v1/ops/restore",
    ops("restore", async (request, _p, env) => {
      const b = await opsBody(request, OpsRestoreRequest);

      if (!b) return errorResponse("bad_request", "kind, id, confirm and at are required");
      const { kind, id, at } = b;

      const patterns = {
        mailbox: /^mbx_[A-Za-z0-9_-]{1,80}$/,
        calendar: /^cal_[A-Za-z0-9_-]{1,80}$/,
        space: /^spc_[A-Za-z0-9_-]{1,80}$/,
      };

      if (!patterns[kind].test(id))
        return errorResponse(
          "bad_request",
          "kind must be mailbox|calendar|space with a matching id",
        );

      if (b.confirm !== id)
        return errorResponse("bad_request", "confirm must repeat the target id");

      try {
        validateRestorePoint(at, Date.now());
      } catch (e) {
        return errorResponse(
          "bad_request",
          e instanceof Error ? e.message : "invalid restore point",
        );
      }

      const stub = Match.value(kind).pipe(
        Match.when("mailbox", () => mailbox(env, id)),
        Match.when("calendar", () => calendar(env, id)),
        Match.orElse(() => space(env, id)),
      );

      let restored: { bookmark: string; at: number };

      try {
        const before = await stub.sessionEpoch();
        restored = await stub.restoreTo(at);
        // Replay only after the object is running on the restored storage (no race with the abort).
        await awaitRestart(() => stub.sessionEpoch(), before);
      } catch (e) {
        return errorResponse("unavailable", e instanceof Error ? e.message : "restore failed");
      }

      const replay = await replayTombstonesFor(env, kind, id);

      return json(
        {
          kind,
          id,
          bookmark: restored.bookmark,
          at: restored.at,
          tombstonesReplayed: replay.replayed,
        },
        202,
      );
    }),
  ),
  route(
    "POST",
    "/v1/ops/tombstones/replay",
    ops("tombstones.replay", async (_r, _p, env) => json(await replayTombstones(env))),
  ),
  route(
    "POST",
    "/v1/ops/blob-gc/sweep",
    ops("blobgc.sweep", async (_r, _p, env) => json(await sweepBlobGc(env))),
  ),
];

export const OpsHandlers = HttpApiBuilder.group(CoreApi, "ops", (handlers) =>
  handlers
    // ---- push subscriptions (E23, C02/C10) ----
    .handle("listPushSubscriptions", () =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const principal = yield* requireScope("read");
        yield* Effect.promise(() => pruneEndedRegistrations(env, principal.userId));

        const rows = yield* Effect.promise(() =>
          env.DIRECTORY.prepare(
            "SELECT id, kind, label, enabled, created_at, last_success_at, disabled_at FROM push_devices WHERE user_id = ? ORDER BY created_at DESC",
          )
            .bind(principal.userId)
            .all<{
              id: string;
              kind: string;
              label: string;
              enabled: number;
              created_at: number;
              last_success_at: number | null;
              disabled_at: number | null;
            }>(),
        );

        return {
          items: rows.results.map((r) => ({
            id: r.id,
            kind: r.kind,
            label: r.label,
            enabled: r.enabled === 1,
            createdAt: r.created_at,
            lastSuccessAt: r.last_success_at,
            disabledAt: r.disabled_at,
          })),
        };
      }).pipe(publicly),
    )
    .handle("registerPushSubscription", ({ payload: b }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        // A registration outlives the credential that made it, so only the account holder's own
        // session (browser or signed-in app) registers — never agent/CLI tokens or support access.
        const principal = yield* requireUser();
        const p256dh = b.p256dh ?? b.keys?.p256dh;
        const auth = b.auth ?? b.keys?.auth;

        const registration: Types.Mutable<PushRegistration> = {
          kind: b.kind,
          endpoint: b.endpoint,
          label: (b.label ?? "").slice(0, 80),
        };

        if (p256dh !== undefined) registration.p256dh = p256dh;

        if (auth !== undefined) registration.auth = auth;

        if (b.sandbox !== undefined) registration.sandbox = b.sandbox;

        const invalid = validateRegistration(registration);

        if (invalid) return yield* badRequest(invalid);
        const id = `pd_${crypto.randomUUID()}`;

        const result = yield* Effect.promise(async () => {
          await pruneEndedRegistrations(env, principal.userId);

          const count = await env.DIRECTORY.prepare(
            "SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ? AND enabled = 1 AND endpoint <> ?",
          )
            .bind(principal.userId, registration.endpoint)
            .first<{ n: number }>();

          if ((count?.n ?? 0) >= MAX_DEVICES_PER_USER) return null;

          return env.DIRECTORY.prepare(
            // Bound to the registering credential: revoking it removes the registration (P1.7).
            `INSERT INTO push_devices (id, user_id, kind, endpoint, p256dh, auth, label, enabled, created_at, failures, session_id, apns_sandbox) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
           ON CONFLICT (user_id, endpoint) DO UPDATE SET kind = excluded.kind, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, enabled = 1, failures = 0, disabled_at = NULL, session_id = excluded.session_id, apns_sandbox = COALESCE(excluded.apns_sandbox, push_devices.apns_sandbox)
           RETURNING id`,
          )
            .bind(
              id,
              principal.userId,
              registration.kind,
              registration.endpoint,
              registration.p256dh ?? null,
              registration.auth ?? null,
              registration.label ?? "",
              Date.now(),
              principal.sessionId,
              registration.kind === "apns" && registration.sandbox !== undefined
                ? Number(registration.sandbox)
                : null,
            )
            .first<{ id: string }>();
        });

        if (result === null)
          return yield* new ApiError({
            code: "conflict",
            message: `at most ${MAX_DEVICES_PER_USER} devices`,
          });

        return { id: result?.id ?? id };
      }).pipe(publicly),
    )
    .handle("removePushSubscription", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const principal = yield* requireUser();

        const r = yield* Effect.promise(() =>
          env.DIRECTORY.prepare("DELETE FROM push_devices WHERE id = ? AND user_id = ?")
            .bind(params.id, principal.userId)
            .run(),
        );

        if (r.meta.changes !== 1)
          return yield* new ApiError({ code: "not_found", message: "device not found" });

        return ok;
      }).pipe(publicly),
    )
    .handle("unregisterPushEndpoint", ({ payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const principal = yield* requireUser();

        yield* Effect.promise(() =>
          env.DIRECTORY.prepare("DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?")
            .bind(principal.userId, payload.endpoint)
            .run(),
        );

        return ok;
      }).pipe(publicly),
    )

    // ---- external send-as credentials (§5.3 ExternalIdentityTransport, E19) ----
    .handle("storeExternalIdentity", ({ params, payload: b }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.mailboxId, "send");
        yield* requireStepUp("credentials");
        const address = params.address.toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
          return yield* badRequest("invalid address");
        const { provider } = b;
        const credential: ExternalCredential = b;

        for (const url of [credential.endpoint, credential.tokenEndpoint]) {
          if (url !== undefined && (!url.startsWith("https://") || isForbiddenProxyTarget(url)))
            return yield* badRequest("endpoints must be public https URLs");
        }

        if (provider === "http" && (!credential.endpoint || !credential.apiKey))
          return yield* badRequest("relay needs endpoint and apiKey");

        if (provider !== "http" && !credential.accessToken && !credential.refreshToken)
          return yield* badRequest("accessToken or refreshToken required");

        if (!env.EXTERNAL_IDENTITY_SEAL_KEY)
          return yield* new ApiError({
            code: "conflict",
            message: "external identities are not enabled",
          });
        yield* Effect.promise(() =>
          storeExternalCredential(env, params.mailboxId, address, credential),
        );

        return ok;
      }).pipe(publicly),
    )
    .handle("revokeExternalIdentity", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.mailboxId, "send");
        yield* requireStepUp("credentials");
        yield* Effect.promise(() =>
          env.DIRECTORY.prepare(
            "UPDATE external_identity_credentials SET revoked_at = ?, ciphertext = '', iv = '' WHERE mailbox_id = ? AND address = ?",
          )
            .bind(Date.now(), params.mailboxId, params.address.toLowerCase())
            .run(),
        );

        return ok;
      }).pipe(publicly),
    ),
);
