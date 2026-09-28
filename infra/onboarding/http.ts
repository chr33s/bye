// Onboarding HTTP surface (spec.md §15.11) on the Fetch API, so the same routes, checks and
// headers serve the Node process (server.ts adapts node:http to this) and the hosted Worker
// (worker/onboarding.ts). Nothing here reads the filesystem or the process environment.
import { Option, Predicate, Schema } from "effect";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { encode } from "./seal.ts";
import { OnboardingError, type OnboardingService } from "./service.ts";
import { ONBOARDING_PAGE, ONBOARDING_SCRIPT, ONBOARDING_STYLE } from "./ui.ts";

/**
 * Who the operator is. A function names them from the request (Cloudflare Access, a local
 * operator). `"session"` is the hosted public mode: the operator is the signed session itself, so
 * anyone can start an installation and only that browser session can act on it.
 */
export type OperatorSource =
  | ((req: Request) => string | null | Promise<string | null>)
  | { readonly kind: "session" };

export interface HandlerOptions {
  readonly service: OnboardingService;
  /** Public origin, e.g. https://onboarding.example.com. */
  readonly origin: string;
  readonly operator: OperatorSource;
  /**
   * HMAC key for session cookies. Only sessions this server issued are accepted, so a client
   * cannot pick (or be handed) a session id of its choosing. Default: random per process, which
   * the hosted Worker must not use (isolates restart); it passes a configured secret.
   */
  readonly sessionSecret?: Uint8Array;
  /**
   * Local-operator mode: the operator is a constant, so the connecting peer must prove it is that
   * operator with this process's bearer token (or a session opened by the one-time login URL).
   */
  readonly local?: LocalOperatorAuth;
  /** Cookie lifetime in seconds (default one day; session mode uses longer). */
  readonly sessionMaxAge?: number;
  /**
   * The host a request was addressed to. Default: the Host header (Node, where the URL is built
   * from the configured origin). Workers pass the URL's host: Cloudflare routes only the Worker's
   * own hostname to it, and workerd does not reliably expose Host.
   */
  readonly hostOf?: (req: Request) => string;
}

/** Per-process credentials for local-operator mode (printed once at startup, never stored). */
export interface LocalOperatorAuth {
  /** `Authorization: Bearer <token>` for API clients. */
  readonly token: string;
  /** `GET /login?code=<loginCode>` sets an authenticated session cookie, once. */
  readonly loginCode: string;
}

export const localOperatorAuth = (): LocalOperatorAuth => ({
  token: encode(randomBytes(32), "base64url"),
  loginCode: encode(randomBytes(32), "base64url"),
});

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
};

const SESSION_COOKIE = "__Host-bye-onboarding";

/** Operator id for session mode: never collides with an Access email or a local operator name. */
export const sessionOperator = (session: string) => `session:${session}`;

const sessionMac = (secret: Uint8Array, id: string) =>
  createHmac("sha256", secret).update(`bye-onboarding-session\0${id}`).digest("base64url");

/** Cookie value for a server-issued session id: `<id>.<mac>`. */
export const signSession = (secret: Uint8Array, id: string): string =>
  `${id}.${sessionMac(secret, id)}`;

/** The session id from a cookie this server signed, or null (missing, malformed or forged). */
export const sessionFromCookie = (cookie: string | null, secret: Uint8Array): string | null => {
  const m = /(?:^|;\s*)__Host-bye-onboarding=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(
    cookie ?? "",
  );

  if (!m) return null;
  const expected = Buffer.from(sessionMac(secret, m[1]!));
  const given = Buffer.from(m[2]!);

  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1]! : null;
};

export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const send = <T>(status: number, body: T, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json", ...headers },
  });

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, location, ...headers } });

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

type RequestBody = typeof RequestBody.Type;

const decodeRequestBody = Schema.decodeUnknownOption(RequestBody);

/** Largest JSON body the API accepts. */
export const MAX_BODY = 16_384;

const tooLarge = () => new OnboardingError("invalid", "request too large");

/** The body, read only up to MAX_BODY: a larger one is refused without buffering it. */
const readLimited = async (req: Request): Promise<Uint8Array> => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw tooLarge();

  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > MAX_BODY) {
      await reader.cancel();
      throw tooLarge();
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
};

const readJson = async (req: Request): Promise<RequestBody> => {
  const bytes = await readLimited(req);

  try {
    return Option.getOrElse(
      decodeRequestBody(JSON.parse(encode(bytes, "utf8") || "{}")),
      (): RequestBody => ({}),
    );
  } catch {
    throw new OnboardingError("invalid", "invalid JSON");
  }
};

const str = (body: RequestBody, k: string) => {
  const v = body[k];

  if (!Predicate.isString(v) || v.length === 0 || v.length > 256)
    throw new OnboardingError("invalid", `${k} is required`);

  return v;
};

const STATUS: Record<OnboardingError["code"], number> = {
  not_found: 404,
  unauthorized: 401,
  conflict: 409,
  invalid: 400,
  blocked: 422,
  not_ready: 409,
};

const ASSETS = new Map([
  ["/app.js", { type: "text/javascript; charset=utf-8", body: ONBOARDING_SCRIPT }],
  ["/app.css", { type: "text/css; charset=utf-8", body: ONBOARDING_STYLE }],
]);

export const fetchHandler = ({
  service,
  origin,
  operator,
  sessionSecret = randomBytes(32),
  local,
  sessionMaxAge = 86_400,
  hostOf = (req) => req.headers.get("host") ?? "",
}: HandlerOptions) => {
  const expectedHost = new URL(origin).host.toLowerCase();
  // Local mode: sessions opened through the one-time login URL (in memory, per process).
  const authenticated = new Set<string>();
  let loginUsed = false;

  const cookieFor = (session: string) =>
    `${SESSION_COOKIE}=${signSession(sessionSecret, session)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAge}`;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, origin);

    try {
      // DNS rebinding: a request whose Host is not the configured origin's is refused, so a page
      // on another name that resolves here can't read even the GET routes.
      if (hostOf(req).toLowerCase() !== expectedHost)
        return send(421, { error: "unexpected host" });
      let session = sessionFromCookie(req.headers.get("cookie"), sessionSecret);
      const setCookie: Record<string, string> = {};

      if (session === null) {
        session = encode(randomBytes(32), "base64url");
        setCookie["set-cookie"] = cookieFor(session);
      }

      const byRequest = Predicate.isFunction(operator) ? operator : null;
      const op = byRequest ? await byRequest(req) : sessionOperator(session);

      if (op === null) return send(401, { error: "sign in through the access proxy first" });
      const asset = req.method === "GET" ? ASSETS.get(url.pathname) : undefined;

      if (asset)
        return new Response(asset.body, {
          headers: { ...SECURITY_HEADERS, "content-type": asset.type },
        });

      // Session mode: API calls must come from a session the page already established, so a
      // cookie-less client (a crawler, a replayed request) never creates installations.
      if (
        !byRequest &&
        setCookie["set-cookie"] !== undefined &&
        (url.pathname.startsWith("/api/") || url.pathname === "/oauth/callback")
      )
        return send(401, { error: "your session expired; reload the page" }, setCookie);

      if (local) {
        if (req.method === "GET" && url.pathname === "/login") {
          const code = url.searchParams.get("code") ?? "";

          if (loginUsed || !safeEqual(code, local.loginCode))
            return send(401, { error: "login link invalid or already used" });
          loginUsed = true;
          // Always a fresh session: a pre-planted cookie is never promoted.
          const fresh = encode(randomBytes(32), "base64url");
          authenticated.add(fresh);

          return redirect("/", { "set-cookie": cookieFor(fresh) });
        }

        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];

        const peer =
          (bearer !== undefined && safeEqual(bearer, local.token)) ||
          (setCookie["set-cookie"] === undefined && authenticated.has(session));

        // The page itself is static; everything that reads or changes state needs the operator.
        if (!peer && !(req.method === "GET" && url.pathname === "/"))
          return send(401, {
            error: "open the login URL printed at startup, or send Authorization: Bearer <token>",
          });
      }

      if (req.method === "GET" && url.pathname === "/")
        return new Response(ONBOARDING_PAGE, {
          headers: {
            ...SECURITY_HEADERS,
            "content-type": "text/html; charset=utf-8",
            ...setCookie,
          },
        });

      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const result = await service.completeAuthorization(op, session, url.searchParams);

        return redirect(
          result.ok ? "/" : `/?error=${encodeURIComponent(result.reason)}`,
          setCookie,
        );
      }

      if (req.method === "GET") {
        const opMatch = /^\/api\/operations\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);

        if (opMatch) return send(200, await service.operation(op, opMatch[1]!), setCookie);

        switch (url.pathname) {
          case "/api/status":
            return send(200, await service.status(op), setCookie);
          case "/api/accounts":
            return send(200, { accounts: await service.accounts(op) }, setCookie);
          case "/api/zones": {
            const accountId = url.searchParams.get("accountId") ?? "";

            if (!/^[A-Za-z0-9]{1,64}$/.test(accountId))
              throw new OnboardingError("invalid", "accountId is required");

            return send(200, { zones: await service.zones(op, accountId) }, setCookie);
          }

          case "/api/reattach":
            return send(200, { installations: await service.reattachable(op) }, setCookie);
          case "/api/guide":
            return send(200, await service.guide(op), setCookie);
          case "/api/handoff":
            return send(200, await service.handoff(op), setCookie);
        }

        return send(404, { error: "not found" });
      }

      if (req.method !== "POST") return send(405, { error: "method not allowed" });

      // CSRF: state-changing calls come only from this origin's page, as JSON.
      if (
        req.headers.get("origin") !== origin ||
        !(req.headers.get("content-type") ?? "").startsWith("application/json")
      )
        return send(403, { error: "cross-origin request refused" });
      const body = await readJson(req);

      switch (url.pathname) {
        case "/api/authorize":
          return send(200, await service.startAuthorization(op, session), setCookie);
        case "/api/install": {
          // Only ids and the label: zone name, hostname and stage are derived server-side.
          const result = await service.install(op, {
            accountId: str(body, "accountId"),
            zoneId: str(body, "zoneId"),
            label: Predicate.isString(body.label) ? body.label : "bye",
          });

          return send(result.status === "deploying" ? 202 : 200, result);
        }

        case "/api/bind":
          await service.bind(op, str(body, "accountId"), str(body, "stage"));

          return send(200, await service.status(op));
        case "/api/reattach":
          return send(200, await service.reattach(op, str(body, "installationId")));
        case "/api/review":
          return send(200, await service.review(op));
        case "/api/approve":
          return send(
            200,
            await service.approve(
              op,
              str(body, "reviewId"),
              str(body, "digest"),
              body.acknowledgeDestructive === true,
            ),
          );
        case "/api/deploy":
          return send(202, await service.deploy(op, str(body, "approvalId")));
        case "/api/disconnect":
          return send(200, await service.disconnect(op));
        case "/api/first-account":
          return send(200, await service.firstAccountLink(op));
        case "/api/recovery-kit":
          return send(200, await service.recoveryKit(op), {
            "content-disposition": 'attachment; filename="bye-recovery-kit.json"',
          });
      }

      return send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof OnboardingError)
        return send(STATUS[e.code], {
          error: e.message,
          code: e.code,
          nextAction: e.nextAction ?? null,
        });
      console.error(
        `onboarding: ${req.method} ${url.pathname} failed: ${e instanceof Error ? e.name : "error"}`,
      );

      return send(500, {
        error: "internal error",
        nextAction: "Reload to see the recorded status",
      });
    }
  };
};
