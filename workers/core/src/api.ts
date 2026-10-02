import { Effect, Exit, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Forbidden, requestAuthLayer, requireMailbox, requireScope } from "@bye/application";
import { ControlDirectory } from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";
import { errorResponse, fetchHandler, runHttp, withSecurityHeaders } from "./http.ts";
import { ApiPlatformLive, RequestServicesLive, SchemaErrorsLive } from "./httpapi.ts";
import { CoreApi } from "./spec/index.ts";
import { handleImageProxy, handleRender } from "./render.ts";

import { IdentityHandlers } from "./routes/identity.ts";
import { MailHandlers, mailRoutes } from "./routes/mail.ts";
import { CalendarHandlers, calendarRoutes } from "./routes/calendar.ts";
import { SharedHandlers, sharedRoutes } from "./routes/shared.ts";
import { AdminHandlers, adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { NewsletterConfigHandlers } from "./routes/newsletter-config.ts";
import { OpsHandlers, opsRoutes } from "./routes/ops.ts";
import { probeRoutes } from "./routes/probe.ts";
import { discoveryRoutes } from "./routes/discovery.ts";
import { authenticate, bearer, requestId, serviceDomain } from "./routes/common.ts";

// HTTP API (§8). The conventional JSON API is one HttpApi (./spec/*, handlers in ./routes/*); the
// rest are native routes (`NATIVE_ROUTES`). This module dispatches both through one HttpRouter and
// owns the render-origin split. `API_SURFACE` is every method and path either answers.

export { serviceDomain };

/** Routes that aren't plain JSON behind a credential: OAuth, WebAuthn, webhooks, files, tokens. */
export const NATIVE_ROUTES = [
  ...mailRoutes,
  ...calendarRoutes,
  ...sharedRoutes,
  ...adminRoutes,
  ...authRoutes,
  ...webhookRoutes,
  ...opsRoutes,
  ...probeRoutes,
  ...discoveryRoutes,
];

const ApiLive = HttpApiBuilder.layer(CoreApi).pipe(
  Layer.provide([
    IdentityHandlers,
    MailHandlers,
    CalendarHandlers,
    SharedHandlers,
    AdminHandlers,
    NewsletterConfigHandlers,
    OpsHandlers,
  ]),
  Layer.provide([RequestServicesLive, SchemaErrorsLive, ApiPlatformLive]),
);

/** Every method and path the Worker answers: the HttpApi endpoints and the native routes. */
export const API_SURFACE = [
  ...Object.values(CoreApi.groups).flatMap((group) => Object.values(group.endpoints)),
  ...NATIVE_ROUTES,
];

const dispatch = fetchHandler(Layer.merge(HttpRouter.addAll(NATIVE_ROUTES), ApiLive), API_SURFACE);

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

type LiveTarget = { readonly kind: "mailbox" | "calendar" | "space"; readonly id: string };

const liveTarget = (params: URLSearchParams): LiveTarget | null => {
  const given = (["mailbox", "calendar", "space"] as const).flatMap((kind) => {
    const id = params.get(kind);

    return id ? [{ kind, id }] : [];
  });

  return given.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(given[0]!.id) ? given[0]! : null;
};

/**
 * Read access to the live target: mailbox grants via the principal; a calendar space the actor
 * owns or holds any grant in (the calendar authority decides); an active shared-space member.
 */
const authorizeLive = (env: CoreEnv, target: LiveTarget) =>
  Effect.gen(function* () {
    if (target.kind === "mailbox")
      return yield* requireMailbox(target.id, "read").pipe(Effect.asVoid);
    const principal = yield* requireScope("read");

    const allowed =
      target.kind === "calendar"
        ? yield* Effect.promise(() =>
            env.CALENDARS.getByName(target.id)
              .mayObserve(principal.userId)
              .catch(() => false),
          )
        : yield* Effect.promise(() =>
            env.SHARED_SPACES.getByName(`space:${target.id}`)
              .isMember(principal.userId)
              .then(
                (r) => r.ok && r.value === true,
                () => false,
              ),
          );

    if (!allowed) return yield* new Forbidden({ reason: `no access to this ${target.kind}` });
  });

/**
 * Unauthenticated readiness probe: one trivial D1 query. Answers only 200/503 with no details and
 * is never cached, so it reveals nothing beyond "up".
 */
const healthz = async (env: CoreEnv): Promise<Response> => {
  const ok = await env.DIRECTORY.prepare("SELECT 1 AS ok")
    .first<{ ok: number }>()
    .then(
      (r) => Number(r?.ok) === 1,
      () => false,
    );

  return new Response(ok ? "ok" : "unavailable", {
    status: ok ? 200 : 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};

/** Every Worker-served response gets the baseline security headers (see `withSecurityHeaders`). */
export const handleFetch = async (
  request: Request,
  env: CoreEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const onRenderOrigin = new URL(request.url).host === new URL(env.MAIL_ORIGIN).host;
  const response = await routeFetch(request, env, ctx);

  return withSecurityHeaders(response, onRenderOrigin ? new URL(env.APP_ORIGIN).origin : "'none'");
};

const routeFetch = async (
  request: Request,
  env: CoreEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const mailHost = new URL(env.MAIL_ORIGIN).host;

  if (url.pathname === "/healthz" && request.method === "GET") return healthz(env);

  // The render origin serves only message documents and proxied images, never the API.
  if (url.host === mailHost) {
    if (url.pathname.startsWith("/render/"))
      return handleRender(request, env, safeDecode(url.pathname.slice(8)) ?? "");

    if (url.pathname === "/img") return handleImageProxy(request, env);

    return new Response("not found", { status: 404 });
  }

  if (url.pathname === "/v1/live") {
    // Change-hint sockets for one authority: `mailbox=`, `calendar=` or `space=` (§8).
    if (request.headers.get("upgrade") !== "websocket")
      return errorResponse("bad_request", "websocket required");
    const target = liveTarget(url.searchParams);

    if (!target)
      return errorResponse("bad_request", "exactly one of mailbox, calendar or space is required");

    // Cross-site WebSocket hijacking: browsers attach the session cookie to a socket opened from
    // any page, and upgrades aren't subject to CORS. A cookie-authenticated upgrade must come from
    // the app origin; bearer upgrades (CLI, native — a browser can't set Authorization on a
    // WebSocket) may omit Origin.
    if (!bearer(request) && request.headers.get("origin") !== env.APP_ORIGIN)
      return errorResponse("forbidden", "cross-origin socket rejected");

    // Authorize before handing the socket to the authority. The socket is tagged with the
    // authenticated credential (never a client-supplied value) so revocation closes exactly it.
    const authorized = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* authenticate(request, env);
        yield* authorizeLive(env, target).pipe(Effect.provide(requestAuthLayer(auth)));

        return auth.credentialId;
      }),
    );

    if (Exit.isFailure(authorized)) return runHttp(Effect.failCause(authorized.cause), requestId());
    const credential = authorized.value;
    const headers = new Headers(request.headers);
    headers.set("x-bye-credential", credential);
    const forwarded = new Request(request, { headers });

    switch (target.kind) {
      case "mailbox":
        return env.MAILBOXES.getByName(target.id).fetch(forwarded);
      case "calendar":
        return env.CALENDARS.getByName(target.id).fetch(forwarded);
      case "space":
        return env.SHARED_SPACES.getByName(`space:${target.id}`).fetch(forwarded);
    }
  }

  return dispatch(request, env, ctx);
};

export { ControlDirectory };
