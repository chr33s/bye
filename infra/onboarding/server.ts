// Self-hosted onboarding (spec.md §15.11): the Fetch handler (http.ts) on node:http, with deploys
// run by the Alchemy CLI on this host. The hosted service is worker/onboarding.ts.
//
//   BYE_ONBOARDING_ORIGIN=https://onboard.example.com   public origin (OAuth redirect, CSRF check)
//                                                         (default https://onboarding.<DOMAIN>)
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
//   BYE_ONBOARDING_LOCAL_OPERATOR=<name>                  local mode (instead of Access): loopback
//                                                         only; a per-process bearer token and a
//                                                         one-time login URL are printed at startup
//   PORT=8788  HOST=127.0.0.1   listens on loopback by default (reach it through a tunnel);
//                               set HOST explicitly to listen elsewhere (Access mode only)
//
// Usage: node --experimental-strip-types infra/onboarding/server.ts
import { Predicate } from "effect";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { domainDefaults } from "../resources/domain.ts";
import { requiredConfig } from "../policies/check-config.ts";
import { ACCESS_JWT_HEADER, accessVerifier } from "./access.ts";
import { cloudflareReader } from "./cloudflare.ts";
import { processExecutor } from "./executor.ts";
import { FileStore } from "./file-store.ts";
import { readBody } from "./node-body.ts";
import { fetchHandler, type LocalOperatorAuth, localOperatorAuth, MAX_BODY } from "./http.ts";
import { cloudflareOAuthConfig } from "./oauth.ts";
import { releaseMigrations, resolveRelease } from "./release.ts";
import { parseKeyRing } from "./seal.ts";
import { OnboardingService } from "./service.ts";

export { type LocalOperatorAuth, localOperatorAuth, signSession } from "./http.ts";

export interface ServerOptions {
  readonly service: OnboardingService;
  /** Public origin, e.g. https://onboard.example.com. */
  readonly origin: string;
  /** Returns the authenticated operator for a request, or null. */
  readonly operator: (req: IncomingMessage) => string | null | Promise<string | null>;
  /** HMAC key for session cookies (default: random per process). */
  readonly sessionSecret?: Buffer;
  /** Local-operator mode (see http.ts). */
  readonly local?: LocalOperatorAuth;
}

/** Loopback bind addresses local-operator mode accepts. */
export const isLoopbackHost = (host: string): boolean =>
  /^(localhost|::1|\[::1\]|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(host);

/** node:http adapter over the Fetch handler (http.ts); the Node request is kept for `operator`. */
export const handler = ({ service, origin, operator, sessionSecret, local }: ServerOptions) => {
  const requests = new WeakMap<Request, IncomingMessage>();

  const handle = fetchHandler({
    service,
    origin,
    sessionSecret,
    local,
    operator: (r) => operator(requests.get(r)!),
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const headers = new Headers();

      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Predicate.isString(v) ? v : v.join(", "));

      const method = req.method ?? "GET";

      const body =
        method === "GET" || method === "HEAD" ? undefined : await readBody(req, MAX_BODY);

      const request = new Request(new URL(req.url ?? "/", origin), { method, headers, body });
      requests.set(request, req);
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body === null ? undefined : await response.text());
    } catch {
      // A client that aborts mid-upload (or a malformed request) must not take the process down,
      // and with it every running deployment.
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
    }
  };
};

if (import.meta.main) {
  // An absent BYE_ONBOARDING_ORIGIN defaults to https://onboarding.<DOMAIN> (resources/domain.ts).
  const env = { ...process.env, ...domainDefaults(process.env) };

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

  const port = Number(env.PORT ?? 8788);
  const host = env.HOST || "127.0.0.1";

  // Local mode has no identity proxy in front: only loopback peers, and they must hold the token.
  if (!header && !isLoopbackHost(host)) {
    console.error(
      `onboarding: BYE_ONBOARDING_LOCAL_OPERATOR listens on loopback only (HOST=${host}); use Access mode to listen elsewhere`,
    );
    process.exit(2);
  }

  const local = header ? undefined : localOperatorAuth();

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
    release: {
      resolve: () => resolveRelease(releaseDir, version),
      migrations: releaseMigrations,
      requiredConfig: (dir) => requiredConfig(join(dir, "infra/resources")).map((c) => c.name),
    },
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
      local,
      operator: async (req) => {
        if (verifyAccess && header) {
          const jwt = req.headers[ACCESS_JWT_HEADER];
          const email = await verifyAccess(Predicate.isString(jwt) ? jwt : null);

          if (email === null) return null;
          // The proxy's identity header, when present, must name the same operator.
          const claimed = req.headers[header];

          if (Predicate.isString(claimed) && claimed.toLowerCase() !== email.toLowerCase())
            return null;

          return email;
        }

        return localOperator ?? null;
      },
    }),
  );

  server.listen(port, host, () => {
    console.log(`onboarding: listening on ${host}:${port} for ${origin}`);

    if (local) {
      console.log(`onboarding: open ${origin}/login?code=${local.loginCode} (works once)`);
      console.log(`onboarding: API bearer token (this process only): ${local.token}`);
    }
  });
}
