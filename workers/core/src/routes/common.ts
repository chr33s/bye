// Shared HTTP route helpers: authentication, request-scoped layers, parsing, auth utilities.
import { mint, verify } from "../capability.ts";

export { publicOrigin, serviceDomain } from "../origins.ts";

import { escapeHtml } from "../html.ts";
import { Effect, Layer, Schema, Predicate } from "effect";
import {
  authenticateRequest,
  type CalendarRepository,
  type CurrentAuthentication,
  type MailboxFacts,
  type MailboxRepository,
  type MailboxSelection,
  type RequestPayload,
  type SharedSpaces,
  Forbidden,
  Principal,
  requestAuthLayer,
  requireScope,
} from "@bye/application";
import { ApiError } from "@bye/contracts";
import {
  checkCsrf,
  type ControlServices,
  isRejection,
  publicError,
  readCookie,
  type RejectionCode,
  type RpcResult,
  SESSION_COOKIE,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, json, type Params, readJson, runHttp } from "../http.ts";
import {
  calendarRepositoryLayer,
  controlAdapters,
  controlLayer,
  mailboxFactsLayer,
  mailboxRepositoryLayer,
  sharedLayers,
} from "../services.ts";

// HTTP API (§8). Every request builds its own principal layer from verified credentials; no
// authorization context outlives the invocation (§7.4). Web, mobile, desktop, CLI/TUI and agents
// use the same contracts.

export type AppServices =
  | Principal
  | CurrentAuthentication
  | ControlServices
  | MailboxFacts
  | MailboxRepository
  | CalendarRepository
  | SharedSpaces
  | MailboxSelection;

export type Handler = (
  request: Request,
  params: Params,
  env: CoreEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

export const requestId = () => crypto.randomUUID();

export const bearer = (request: Request): string | undefined => {
  const h = request.headers.get("authorization");

  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
};

const credentialsOf = (request: Request) => ({
  method: request.method,
  cookieToken: readCookie(request.headers.get("cookie"), SESSION_COOKIE),
  bearerToken: bearer(request),
  origin: request.headers.get("origin"),
  secFetchSite: request.headers.get("sec-fetch-site"),
});

/**
 * Authenticate a request into its per-request authentication state, as an Effect. Callers that
 * aren't a full `authed` route (e.g. the `/v1/live` socket upgrade) compose with this.
 */
export const authenticate = (request: Request, env: CoreEnv) =>
  Effect.flatMap(
    Effect.promise(() => controlLayer(env)),
    (control) =>
      authenticateRequest(credentialsOf(request), env.APP_ORIGIN).pipe(Effect.provide(control)),
  );

/** Authenticate, then run an application Effect with request-scoped layers. */
export const authed =
  <A>(
    program: (input: {
      request: Request;
      params: Params;
      env: CoreEnv;
      body: RequestPayload;
      url: URL;
    }) => Effect.Effect<A, unknown, AppServices>,
    options: {
      readonly status?: number;
      readonly raw?: (value: A) => Response;
      /** Leave the body unread (binary/CSV uploads). */ readonly rawBody?: boolean;
    } = {},
  ): Handler =>
  async (request, params, env) => {
    const id = requestId();
    const url = new URL(request.url);

    const body =
      request.method === "GET" || request.method === "HEAD" || options.rawBody
        ? undefined
        : await readJson(request).catch((e) => e);

    if (body instanceof Error)
      return errorResponse(
        Predicate.isTagged(body as { _tag?: string }, "PayloadTooLarge")
          ? "payload_too_large"
          : "bad_request",
        body.message || "invalid body",
        id,
      );
    const control = await controlLayer(env);

    const effect = Effect.gen(function* () {
      const auth = yield* authenticateRequest(credentialsOf(request), env.APP_ORIGIN);

      const value = yield* program({ request, params, env, body, url }).pipe(
        Effect.provide(requestAuthLayer(auth)),
        // X02 / P0#10: every write through the API is attributed to the exact credential (kind + ID)
        // in the user's audit log. Bodies are never recorded (redaction); the path carries only IDs.
        Effect.onExit((exit) =>
          request.method === "GET" || request.method === "HEAD"
            ? Effect.void
            : auditWrite(
                env,
                auth,
                request.method,
                url.pathname,
                Predicate.isTagged(exit, "Success") ? "ok" : "failed",
              ),
        ),
      );

      return options.raw ? options.raw(value) : json(value ?? { ok: true }, options.status ?? 200);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          control,
          mailboxRepositoryLayer(env),
          mailboxFactsLayer(env),
          calendarRepositoryLayer(env),
          sharedLayers(env),
        ),
      ),
    );

    return runHttp(effect as Effect.Effect<Response, unknown>, id);
  };

/**
 * `authed` with the JSON body decoded by a contract schema at the boundary (§8). The program
 * receives the typed body; a body that doesn't match is a `bad_request`, never a silent default.
 */
export const authedBody = <S extends Schema.Codec<unknown, unknown>, A>(
  schema: S,
  program: (input: {
    request: Request;
    params: Params;
    env: CoreEnv;
    body: S["Type"];
    url: URL;
  }) => Effect.Effect<A, unknown, AppServices>,
  options: { readonly status?: number; readonly raw?: (value: A) => Response } = {},
): Handler =>
  authed(
    (input) =>
      Effect.flatMap(
        Effect.mapError(
          Schema.decodeUnknownEffect(schema as never)(input.body ?? {}),
          (e) =>
            new ApiError({
              code: "bad_request",
              message: `invalid request body: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`,
            }),
        ),
        (body) => program({ ...input, body }),
      ),
    options,
  );

export const authorizeParams = (p: URLSearchParams) => ({
  responseType: p.get("response_type") ?? "",
  clientId: p.get("client_id") ?? "",
  redirectUri: p.get("redirect_uri") ?? "",
  codeChallenge: p.get("code_challenge") ?? "",
  codeChallengeMethod: p.get("code_challenge_method") ?? "",
  state: p.get("state") ?? "",
  deviceName: (p.get("device_name") ?? "").slice(0, 120),
});

export { escapeHtml };

/** The consent page's only inline content; its CSP allows exactly this stylesheet by hash. */
export const CONSENT_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}";

/** base64(sha256(CONSENT_STYLE)); a test recomputes it, so an edit to the style can't drift. */
export const CONSENT_STYLE_HASH = "sha256-E0F0TbT/oggDEpjTnARjsSQ0TiJmiuBOG0rm1nanz8U=";

export const consentPage = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CONSENT_STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Consent must never be framed (clickjacking) and posts only to this origin.
        "content-security-policy": `default-src 'none'; style-src '${CONSENT_STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        "x-frame-options": "DENY",
        // `same-origin` (not `no-referrer`): the consent form's POST must carry a real Origin
        // for the CSRF check; nothing leaks cross-origin.
        "referrer-policy": "same-origin",
      },
    },
  );

export const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status, { pragma: "no-cache" });

/** OAuth token/revocation forms are tiny; anything larger is refused without buffering it. */
export const OAUTH_FORM_MAX_BYTES = 8192;

/**
 * Read at most `maxBytes` of a request body as UTF-8, whatever `content-length` claims (or when
 * it is absent): the stream is cancelled as soon as the cap is passed. Null when over the cap.
 */
export const readTextCapped = async (
  request: Request,
  maxBytes: number,
): Promise<string | null> => {
  const declared = Number(request.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > maxBytes) return null;

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);

      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

export const oauthForm = async (request: Request): Promise<URLSearchParams> => {
  // An oversized body reads as an empty form, which every caller rejects as invalid_request.
  const text = (await readTextCapped(request, OAUTH_FORM_MAX_BYTES)) ?? "";

  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      return new URLSearchParams(
        Object.entries(JSON.parse(text) as Record<string, string>).map(([k, v]) => [k, String(v)]),
      );
    } catch {
      return new URLSearchParams();
    }
  }

  return new URLSearchParams(text);
};

/** Provision the account's calendar authority in the user's IANA zone (defaults to UTC). */
export const provisionCalendar = (
  env: CoreEnv,
  account: { userId: string; calendarId: string; address: string },
  timeZone = "UTC",
) =>
  env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: timeZone,
  });

export const SIGNUP_TOKEN_TTL_MS = 30 * 60_000;

/** Signup-retry capability (bound to the user ID). */
export const signupToken = (env: CoreEnv, userId: string, now: number): Promise<string> =>
  mint(env.SESSION_KEY, "signup", [userId], SIGNUP_TOKEN_TTL_MS, now);

export const verifySignupToken = async (
  env: CoreEnv,
  userId: string,
  token: string,
  now: number,
): Promise<boolean> => {
  const fields = await verify(env.SESSION_KEY, "signup", token, 1, now);

  return fields !== null && fields[0] === userId;
};

/**
 * Login-CSRF defense for the unauthenticated routes that issue a session cookie (passkey sign-in,
 * signup registration, recovery): the same origin rule as cookie-authenticated writes
 * (`checkCsrf`), and a JSON body, which a cross-site form can't send without a CORS preflight.
 * Otherwise a hostile page could plant a session for the attacker's own account in the victim's
 * browser.
 */
export const sameOriginJson = (request: Request, env: CoreEnv): boolean =>
  checkCsrf(request.method, request.headers, env.APP_ORIGIN) &&
  (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() ===
    "application/json";

export const currentSession = async (request: Request, env: CoreEnv) => {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);

  if (!token || !checkCsrf(request.method, request.headers, env.APP_ORIGIN)) return null;
  const { auth } = await controlAdapters(env);
  const cred = await auth.authenticate(token).catch(() => null);

  return cred?.kind === "session" ? cred.session : null;
};

export const verifyTurnstile = async (
  env: CoreEnv,
  token: string,
  ip: string,
): Promise<boolean> => {
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  form.set("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });

  return ((await response.json()) as { success?: boolean }).success === true;
};

/** Record an API write for the acting credential. Best effort: an audit outage never blocks the response. */
export const auditWrite = (
  env: CoreEnv,
  auth: {
    readonly principal: {
      readonly userId: string;
      readonly kind: string;
      readonly sessionId: string;
    };
  },
  method: string,
  path: string,
  outcome: "ok" | "failed",
) =>
  Effect.promise(async () => {
    try {
      await env.DIRECTORY.prepare(
        "INSERT INTO audit_log (id, org_id, actor_id, action, target, detail, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
      )
        .bind(
          kernelClock.id("aud"),
          auth.principal.userId,
          `api.${method.toLowerCase()}`,
          path.slice(0, 256),
          JSON.stringify({
            credentialKind: auth.principal.kind,
            credentialId: auth.principal.sessionId,
            outcome,
          }),
          Date.now(),
        )
        .run();
    } catch {
      console.warn(JSON.stringify({ level: "warn", op: "audit.write-failed" }));
    }
  });

type RejectionDetails = NonNullable<Parameters<typeof publicError>[1]>;

const apiErrorOf = (code: RejectionCode, message: string, details?: RejectionDetails) => {
  const pub = publicError(code, details);

  return new ApiError(
    pub.details
      ? { code: pub.code, message, details: { ...pub.details } }
      : { code: pub.code, message },
  );
};

/**
 * Run a Promise-based control/space/world operation. A `Rejection` becomes its public error
 * (one mapping: `publicError`); anything else is a defect.
 */
export const ctl = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (e) => {
      if (isRejection(e)) return apiErrorOf(e.code, e.message, e.details);
      throw e;
    },
  });

/** Unwrap a DO RPC result envelope into a value or a public error. */
export const rpcResult = <A, R>(fn: () => Promise<R>) =>
  Effect.flatMap(Effect.promise(fn), (raw) => {
    const r = raw as RpcResult<A>;

    return r.ok ? Effect.succeed(r.value) : Effect.fail(apiErrorOf(r.code, r.message, r.details));
  });

/** Expiring export-download capability (bound to the storage key). */
export const signDownload = (
  env: CoreEnv,
  key: string,
  expiresAt: number,
  now = Date.now(),
): Promise<string> => mint(env.SESSION_KEY, "export", [key], expiresAt - now, now);

export const verifyDownload = async (
  env: CoreEnv,
  key: string,
  token: string,
  now: number,
): Promise<boolean> => {
  const fields = await verify(env.SESSION_KEY, "export", token, 1, now);

  return fields !== null && fields[0] === key;
};

/** The user's personal organization (billing and closure terms live there). */
export const personalOrgOf = (env: CoreEnv, userId: string) =>
  env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT o.id FROM organizations o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? AND o.kind = 'personal' LIMIT 1",
    )
    .bind(userId)
    .first<{ id: string }>()
    .then((r) => r?.id ?? null);

export const validTimeZone = <T>(tz: T): string | undefined => {
  if (!Predicate.isString(tz) || tz.length === 0 || tz.length > 64) return undefined;

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** Interactive-session-only operations (credential management, consent): agents and CLIs are refused. */
export const requireUser = (scope: "read" | "admin" = "read") =>
  Effect.gen(function* () {
    const principal = yield* requireScope(scope);

    if (principal.kind !== "user")
      return yield* new Forbidden({ reason: "requires an interactive session" });

    return principal;
  });

/**
 * Close live change-feed sockets opened with a revoked credential (§8, DS09) on every authority
 * the user can subscribe to: mailboxes they can read, calendars they own or hold a grant in, and
 * spaces they belong to. `null` closes all of the user's sockets (every credential revoked, e.g.
 * account recovery). Best effort: the credential is already revoked in D1, and sockets carry only
 * sequence hints, never data.
 */
export const closeLiveSockets = async (
  env: CoreEnv,
  userId: string,
  credentialId: string | null,
): Promise<void> => {
  type Live = { closeSockets(id?: string): Promise<number> };

  const close = <S>(stub: S) => {
    const live = stub as Live;

    return (credentialId === null ? live.closeSockets() : live.closeSockets(credentialId)).catch(
      () => 0,
    );
  };

  const db = env.DIRECTORY.withSession("first-primary");

  const ids = async (sql: string) =>
    (
      await db
        .prepare(sql)
        .bind(userId)
        .all<{ id: string }>()
        .catch(() => ({ results: [] as Array<{ id: string }> }))
    ).results.map((r) => r.id);

  // The four lookups are independent (fixed tuple); the closes then run in bounded batches so a
  // well-connected user's step-up or logout isn't one sequential RPC per authority.
  const [mailboxes, owned, granted, spaces] = await Promise.all([
    ids("SELECT mailbox_id AS id FROM mailbox_access WHERE user_id = ?"),
    ids("SELECT id FROM calendars WHERE owner_user_id = ?"),
    ids("SELECT DISTINCT space_id AS id FROM calendar_grants WHERE grantee_user_id = ?"),
    ids("SELECT space_id AS id FROM space_memberships WHERE user_id = ?"),
  ]);

  const stubs = [
    ...mailboxes.map((id) => env.MAILBOXES.getByName(id)),
    ...[...new Set([...owned, ...granted])].map((id) => env.CALENDARS.getByName(id)),
    ...spaces.map((id) => env.SHARED_SPACES.getByName(`space:${id}`)),
  ];

  for (let i = 0; i < stubs.length; i += LIVE_CLOSE_CONCURRENCY)
    await Promise.all(stubs.slice(i, i + LIVE_CLOSE_CONCURRENCY).map(close));
};

const LIVE_CLOSE_CONCURRENCY = 8;
