// Deployer Worker (infra/onboarding/spec.md §44), uploaded into the installation's account by the
// hosted onboarding service (remote.ts). It only forwards requests signed with the installation's
// secret to its container. Dependency-free: bundled into worker.bundle.ts (`pnpm build:onboarding`)
// and uploaded as a single module.
import { DurableObject } from "cloudflare:workers";

export interface DeployerEnv {
  readonly DEPLOYER: DurableObjectNamespace<Deployer>;
  readonly DEPLOYER_SECRET: string;
  readonly DEPLOYER_RELEASE: string;
  readonly DEPLOYER_IMAGE: string;
}

/** The container's job server (deployer/server.ts). Only handlers and classes may be exported. */
const DEPLOYER_PORT = 8080;

const READY_TIMEOUT_MS = 120_000;

/** Idle containers stop after this; a running job is polled every few seconds, so it stays up. */
const INACTIVITY_MS = 15 * 60_000;

type Reply = Readonly<Record<string, string | boolean>>;

const json = (status: number, body: Reply) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const bytes = (s: string) => new TextEncoder().encode(s);

/** Constant-time comparison of the presented bearer secret. */
const authorized = (header: string | null, secret: string): boolean => {
  const given = bytes(/^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? "");
  const expected = bytes(secret);

  return (
    secret.length >= 32 &&
    given.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(given, expected)
  );
};

export class Deployer extends DurableObject<DeployerEnv> {
  private async port(): Promise<Fetcher> {
    const container = this.ctx.container;

    if (!container) throw new Error("deployer container binding missing");
    const port = container.getTcpPort(DEPLOYER_PORT);

    // A running container is used as is: a job poll every few seconds costs one round trip.
    if (container.running) return port;
    // Egress: the Cloudflare API (Alchemy) and nothing the release doesn't already contain.
    container.start({ enableInternet: true });
    await container.setInactivityTimeout(INACTIVITY_MS);
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
      try {
        if ((await port.fetch("http://deployer/health")).ok) return port;
      } catch {
        // not listening yet
      }

      if (Date.now() > deadline) throw new Error("deployer container not ready");
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const port = await this.port();
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // The Worker's settings plus the commit the running container reports: during a rollout
      // they differ, and the deployer is not current until the container has been replaced.
      const container = (await (await port.fetch("http://deployer/health")).json()) as {
        readonly commit?: string;
      };

      return json(200, {
        ok: true,
        release: this.env.DEPLOYER_RELEASE,
        image: this.env.DEPLOYER_IMAGE,
        commit: container.commit ?? "",
      });
    }

    return port.fetch(`http://deployer${url.pathname}${url.search}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "GET" ? undefined : await request.text(),
    });
  }
}

export default {
  async fetch(request: Request, env: DeployerEnv): Promise<Response> {
    if (!authorized(request.headers.get("authorization"), env.DEPLOYER_SECRET))
      return json(401, { error: "unauthorized" });
    const url = new URL(request.url);

    if (!/^\/(health|jobs(\/[0-9a-f]{24}(\/abort)?)?)$/.test(url.pathname))
      return json(404, { error: "not found" });

    try {
      return await env.DEPLOYER.get(env.DEPLOYER.idFromName("deployer")).fetch(request);
    } catch {
      return json(503, { error: "the deployer is starting" });
    }
  },
} satisfies ExportedHandler<DeployerEnv>;
