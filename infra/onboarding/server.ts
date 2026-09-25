// Onboarding HTTP service (spec.md §15.11). Node, because deployments run the Alchemy CLI.
//
//   BYE_ONBOARDING_ORIGIN=https://onboard.example.com   public origin (OAuth redirect, CSRF check)
//   BYE_ONBOARDING_DATA_DIR=/var/lib/bye-onboarding      private store and execution homes
//   BYE_ONBOARDING_KEYS=v1:<64 hex>                       credential encryption key ring
//   BYE_ONBOARDING_OPERATOR_HEADER=cf-access-authenticated-user-email
//                                                         Cloudflare Access mode: the operator is the
//                                                         verified Cf-Access-Jwt-Assertion email
//                                                         (this header, if sent, must agree)
//   BYE_ONBOARDING_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com   } required in
//   BYE_ONBOARDING_ACCESS_AUD=<Access application AUD tag>                  } Access mode
//   CLOUDFLARE_OAUTH_CLIENT_ID=…  [CLOUDFLARE_OAUTH_CLIENT_SECRET=…]
//   BYE_RELEASE_DIR=/srv/bye-release  BYE_RELEASE_VERSION=v1.0.0   pinned release checkout
//   PORT=8788  HOST=127.0.0.1   listens on loopback by default (reach it through a tunnel);
//                               set HOST explicitly to listen elsewhere
//
// Usage: node --experimental-strip-types infra/onboarding/server.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ACCESS_JWT_HEADER, accessVerifier } from "./access.ts";
import { cloudflareReader } from "./cloudflare.ts";
import { processExecutor } from "./executor.ts";
import { cloudflareOAuthConfig } from "./oauth.ts";
import { releaseMigrations, resolveRelease } from "./release.ts";
import { encode, parseKeyRing } from "./seal.ts";
import { OnboardingError, OnboardingService } from "./service.ts";
import { FileStore } from "./store.ts";
import { ONBOARDING_PAGE, ONBOARDING_SCRIPT, ONBOARDING_STYLE } from "./ui.ts";

export interface ServerOptions {
  readonly service: OnboardingService;
  /** Public origin, e.g. https://onboard.example.com. */
  readonly origin: string;
  /** Returns the authenticated operator for a request, or null. */
  readonly operator: (req: IncomingMessage) => string | null | Promise<string | null>;
  /**
   * HMAC key for session cookies. Only sessions this server issued are accepted, so a client
   * cannot pick (or be handed) a session id of its choosing. Default: random per process.
   */
  readonly sessionSecret?: Buffer;
}

const SESSION_COOKIE = "__Host-bye-onboarding";

const sessionMac = (secret: Buffer, id: string) =>
  createHmac("sha256", secret).update(`bye-onboarding-session\0${id}`).digest("base64url");

/** Cookie value for a server-issued session id: `<id>.<mac>`. */
export const signSession = (secret: Buffer, id: string): string =>
  `${id}.${sessionMac(secret, id)}`;

/** The session id from a cookie this server signed, or null (missing, malformed or forged). */
export const sessionOf = (req: IncomingMessage, secret: Buffer): string | null => {
  const m = /(?:^|;\s*)__Host-bye-onboarding=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(
    req.headers.cookie ?? "",
  );
  if (!m) return null;
  const expected = Buffer.from(sessionMac(secret, m[1]!));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1]! : null;
};

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new OnboardingError("invalid", "request too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(encode(Buffer.concat(chunks), "utf8") || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new OnboardingError("invalid", "invalid JSON");
  }
};

const str = (body: Record<string, unknown>, k: string) => {
  const v = body[k];
  if (typeof v !== "string" || v.length === 0 || v.length > 256)
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

const ASSETS: Record<string, { readonly type: string; readonly body: string }> = {
  "/app.js": { type: "text/javascript; charset=utf-8", body: ONBOARDING_SCRIPT },
  "/app.css": { type: "text/css; charset=utf-8", body: ONBOARDING_STYLE },
};

export const handler =
  ({ service, origin, operator, sessionSecret = randomBytes(32) }: ServerOptions) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", origin);
    try {
      const op = await operator(req);
      if (op === null) return send(res, 401, { error: "sign in through the access proxy first" });
      let session = sessionOf(req, sessionSecret);
      const setCookie: Record<string, string> = {};
      if (session === null) {
        session = encode(randomBytes(32), "base64url");
        setCookie["set-cookie"] =
          `${SESSION_COOKIE}=${signSession(sessionSecret, session)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`;
      }

      const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
      if (asset) {
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": asset.type });
        return void res.end(asset.body);
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
          ...setCookie,
        });
        return void res.end(ONBOARDING_PAGE);
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const result = await service.completeAuthorization(op, session, url.searchParams);
        const to = result.ok ? "/" : `/?error=${encodeURIComponent(result.reason)}`;
        res.writeHead(303, { ...SECURITY_HEADERS, location: to, ...setCookie });
        return void res.end();
      }
      if (req.method === "GET") {
        switch (url.pathname) {
          case "/api/status":
            return send(res, 200, await service.status(op), setCookie);
          case "/api/accounts":
            return send(res, 200, { accounts: await service.accounts(op) }, setCookie);
          case "/api/guide":
            return send(res, 200, await service.guide(op), setCookie);
          case "/api/handoff":
            return send(res, 200, await service.handoff(op), setCookie);
        }
        return send(res, 404, { error: "not found" });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      // CSRF: state-changing calls come only from this origin's page, as JSON.
      if (
        req.headers.origin !== origin ||
        !(req.headers["content-type"] ?? "").startsWith("application/json")
      )
        return send(res, 403, { error: "cross-origin request refused" });
      const body = await readJson(req);
      switch (url.pathname) {
        case "/api/authorize":
          return send(res, 200, await service.startAuthorization(op, session), setCookie);
        case "/api/bind":
          await service.bind(op, str(body, "accountId"), str(body, "stage"));
          return send(res, 200, await service.status(op));
        case "/api/review":
          return send(res, 200, await service.review(op));
        case "/api/approve":
          return send(
            res,
            200,
            await service.approve(
              op,
              str(body, "reviewId"),
              str(body, "digest"),
              body.acknowledgeDestructive === true,
            ),
          );
        case "/api/deploy":
          return send(res, 202, await service.deploy(op, str(body, "approvalId")));
        case "/api/disconnect":
          return send(res, 200, await service.disconnect(op));
        case "/api/first-account":
          return send(res, 200, await service.firstAccountLink(op));
        case "/api/recovery-kit":
          return send(res, 200, await service.recoveryKit(op), {
            "content-disposition": 'attachment; filename="bye-recovery-kit.json"',
          });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof OnboardingError)
        return send(res, STATUS[e.code], {
          error: e.message,
          code: e.code,
          nextAction: e.nextAction ?? null,
        });
      console.error(
        `onboarding: ${req.method} ${url.pathname} failed: ${e instanceof Error ? e.name : "error"}`,
      );
      return send(res, 500, {
        error: "internal error",
        nextAction: "Reload to see the recorded status",
      });
    }
  };

if (import.meta.main) {
  const env = process.env;
  const need = (k: string) => {
    const v = env[k];
    if (!v) {
      console.error(`onboarding: set ${k}`);
      process.exit(2);
    }
    return v;
  };
  const origin = new URL(need("BYE_ONBOARDING_ORIGIN")).origin;
  const dataDir = need("BYE_ONBOARDING_DATA_DIR");
  const releaseDir = need("BYE_RELEASE_DIR");
  const version = need("BYE_RELEASE_VERSION");
  const header = env.BYE_ONBOARDING_OPERATOR_HEADER?.toLowerCase();
  const localOperator = env.BYE_ONBOARDING_LOCAL_OPERATOR;
  if (!header && !localOperator) {
    console.error(
      "onboarding: set BYE_ONBOARDING_OPERATOR_HEADER (or BYE_ONBOARDING_LOCAL_OPERATOR for a single local operator)",
    );
    process.exit(2);
  }
  // Access mode: identity comes only from a verified Access JWT, never from a header alone.
  const verifyAccess = header
    ? accessVerifier({
        teamDomain: need("BYE_ONBOARDING_ACCESS_TEAM_DOMAIN"),
        audience: need("BYE_ONBOARDING_ACCESS_AUD"),
        fetch,
      })
    : null;
  const store = new FileStore(join(dataDir, "store"));
  const service = new OnboardingService({
    store,
    keys: parseKeyRing(env.BYE_ONBOARDING_KEYS),
    oauth: cloudflareOAuthConfig(
      need("CLOUDFLARE_OAUTH_CLIENT_ID"),
      `${origin}/oauth/callback`,
      env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    ),
    fetch,
    cloudflare: cloudflareReader(fetch),
    executor: processExecutor(),
    release: { resolve: () => resolveRelease(releaseDir, version), migrations: releaseMigrations },
    dataDir,
  });
  const interrupted = await service.recover(await store.installationIds());
  if (interrupted > 0) console.log(`onboarding: marked ${interrupted} interrupted operations`);
  // Expired OAuth pending records (PKCE verifiers) are swept regularly, not only on new logins.
  const sweep = () =>
    store.prunePending(Date.now()).catch(() => console.error("onboarding: pending sweep failed"));
  await sweep();
  setInterval(sweep, 10 * 60_000).unref();
  const server = createServer(
    handler({
      service,
      origin,
      operator: async (req) => {
        if (verifyAccess && header) {
          const jwt = req.headers[ACCESS_JWT_HEADER];
          const email = await verifyAccess(typeof jwt === "string" ? jwt : null);
          if (email === null) return null;
          // The proxy's identity header, when present, must name the same operator.
          const claimed = req.headers[header];
          if (typeof claimed === "string" && claimed.toLowerCase() !== email.toLowerCase())
            return null;
          return email;
        }
        return localOperator ?? null;
      },
    }),
  );
  const port = Number(env.PORT ?? 8788);
  const host = env.HOST || "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`onboarding: listening on ${host}:${port} for ${origin}`),
  );
}
