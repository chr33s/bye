// Hosted onboarding (infra/onboarding/spec.md Part J): the public page at onboarding.<DOMAIN>. One
// Durable Object holds the service and every record, so its in-process rules (one writer per
// installation, duplicate "Create Bye") hold for all requests. Deployments run in a deployer in
// each installation's own account (remote.ts); this Worker never runs Alchemy.
import { DurableObject } from "cloudflare:workers";
import { COMPATIBILITY } from "../../resources/compat.ts";
import { ACCESS_JWT_HEADER, accessVerifier } from "../access.ts";
import { cloudflareReader } from "../cloudflare.ts";
import { DEPLOYER_WORKER_MODULE } from "../deployer/worker.bundle.ts";
import { DurableObjectStore } from "../do-store.ts";
import { manifestRelease } from "../hosted-release.ts";
import { fetchHandler, type OperatorSource } from "../http.ts";
import { cloudflareOAuthConfig } from "../oauth.ts";
import { RELEASE_PIN } from "../release-pin.ts";
import { remoteExecutor } from "../remote.ts";
import { parseKeyRing } from "../seal.ts";
import { OnboardingService } from "../service.ts";

export interface OnboardingEnv {
  readonly ONBOARDING: DurableObjectNamespace<OnboardingDO>;
  /** Public origin, e.g. https://bye.chr33s.dev. */
  readonly BYE_ONBOARDING_ORIGIN: string;
  readonly BYE_ONBOARDING_KEYS: string;
  /** 64 hex: signs session cookies. */
  readonly BYE_ONBOARDING_SESSION_KEY: string;
  /** 64 hex: derives each installation's deployer secret. */
  readonly BYE_ONBOARDING_DEPLOYER_KEY: string;
  readonly CLOUDFLARE_OAUTH_CLIENT_ID: string;
  readonly CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /** Both set: Cloudflare Access mode instead of public session mode. */
  readonly BYE_ONBOARDING_ACCESS_TEAM_DOMAIN?: string;
  readonly BYE_ONBOARDING_ACCESS_AUD?: string;
}

/** How often the heartbeat alarm re-arms while an operation runs. */
const HEARTBEAT_MS = 30_000;

const hexKey = (name: string, value: string | undefined): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(value ?? "")) throw new Error(`${name} must be 64 hex characters`);

  return Buffer.from(value!, "hex");
};

const operatorSource = (env: OnboardingEnv): OperatorSource => {
  const team = env.BYE_ONBOARDING_ACCESS_TEAM_DOMAIN;
  const aud = env.BYE_ONBOARDING_ACCESS_AUD;

  if (!team || !aud) return { kind: "session" };

  // Wrapped: workerd's fetch throws "Illegal invocation" when called as another object's method.
  const verify = accessVerifier({
    teamDomain: team,
    audience: aud,
    fetch: (url, init) => fetch(url, init),
  });

  // Identity comes only from a verified Access JWT.
  return (req) => verify(req.headers.get(ACCESS_JWT_HEADER));
};

export class OnboardingDO extends DurableObject<OnboardingEnv> {
  private readonly service: OnboardingService;
  private readonly handle: (req: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: OnboardingEnv) {
    super(ctx, env);
    const origin = new URL(env.BYE_ONBOARDING_ORIGIN).origin;
    const store = new DurableObjectStore(ctx.storage);
    const release = manifestRelease(RELEASE_PIN);

    this.service = new OnboardingService({
      store,
      keys: parseKeyRing(env.BYE_ONBOARDING_KEYS),
      oauth: cloudflareOAuthConfig(
        env.CLOUDFLARE_OAUTH_CLIENT_ID,
        `${origin}/oauth/callback`,
        env.CLOUDFLARE_OAUTH_CLIENT_SECRET || undefined,
      ),
      fetch: (url, init) => fetch(url, init),
      cloudflare: cloudflareReader((url, init) => fetch(url, init)),
      executor: remoteExecutor({
        fetch: (url, init) => fetch(url, init),
        deployerKey: hexKey("BYE_ONBOARDING_DEPLOYER_KEY", env.BYE_ONBOARDING_DEPLOYER_KEY),
        release: () => {
          const r = release.resolve();

          return r.ok ? r.release.ref : null;
        },
        deployerModule: DEPLOYER_WORKER_MODULE,
        compatibilityDate: COMPATIBILITY.date,
      }),
      release,
      // Execution homes live in each deployer container, not here.
      dataDir: "/tmp/bye-onboarding",
    });

    this.handle = fetchHandler({
      service: this.service,
      origin,
      operator: operatorSource(env),
      sessionSecret: hexKey("BYE_ONBOARDING_SESSION_KEY", env.BYE_ONBOARDING_SESSION_KEY),
      // Session mode: the session is the operator, so it must outlive a long first deploy.
      sessionMaxAge: 30 * 86_400,
      hostOf: (req) => new URL(req.url).host,
    });

    // A restart loses in-process work: operations left queued/running become `interrupted`, and
    // a fresh review re-plans against Alchemy state (never a blind replay).
    void ctx.blockConcurrencyWhile(async () => {
      // Only installations with queued or running work, not every visitor's record.
      const interrupted = await this.service.recover(await store.activeInstallationIds());

      if (interrupted > 0) console.log(`onboarding: marked ${interrupted} interrupted operations`);
      await store.prunePending(Date.now());
    });
  }

  private async heartbeat() {
    if (this.service.busy) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.handle(request);
    await this.heartbeat();

    return response;
  }

  /** Keeps the object resident while a deployment runs (expired OAuth states are swept on use). */
  override async alarm(): Promise<void> {
    await this.heartbeat();
  }
}

export default {
  async fetch(request: Request, env: OnboardingEnv): Promise<Response> {
    return env.ONBOARDING.get(env.ONBOARDING.idFromName("onboarding")).fetch(request);
  },
} satisfies ExportedHandler<OnboardingEnv>;
