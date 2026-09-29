// Cloudflare onboarding (spec.md §15.11, infra/onboarding/spec.md): Cloudflare account → Bye hostname →
// "Create Bye" (bind, plan, policy review, deploy, verify) → first owner, for one self-hosted
// installation per operator. A standard clean first install is approved by policy against the
// recorded install intent; anything else falls back to the operator review (`needs-review`). The
// service owns ordering and safety; Alchemy (through executor.ts) owns resources and state.
// Nothing here deletes resources or state, changes DNS, MX or mail routing (only MailCore's
// custom hostname), or exposes management tokens.
import { Match } from "effect";
import { createECDH, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { addInstanceLink } from "../../packages/native-shared/src/instance/handoff.ts";
import type { ExportedPlan } from "../policies/plan-normalize.ts";
import {
  type Account,
  CloudflareApiError,
  type CloudflareReader,
  type Zone,
} from "./cloudflare.ts";
import type { ApplyResult, DeployExecutor, ExecutionContext } from "./executor.ts";
import { manualGuide, type ManualGuide } from "./guide.ts";
import { accountImageRef, INSTALL_IMAGES } from "./images.ts";
import { runHealthChecks } from "./health.ts";
import {
  beginAuthorization,
  checkCallback,
  exchangeCode,
  type Fetch,
  missingScopes,
  OAuthError,
  type OAuthConfig,
  refreshTokens,
  revokeToken,
  type TokenSet,
} from "./oauth.ts";
import { qrSvg } from "./qr.ts";
import type { ReleaseResolution } from "./release.ts";
import {
  allowedStage,
  approvalCovers,
  autoApprovalBlockers,
  buildReview,
  canonical,
  configHash,
} from "./review.ts";
import type { ScopeGrant } from "./scopes.ts";
import { encode, type KeyRing, open, seal } from "./seal.ts";
import type {
  Approval,
  HealthResult,
  InstallIntent,
  Installation,
  InstanceUrls,
  OnboardingEvent,
  OnboardingStore,
  Operation,
  OperationStep,
  PlannedAction,
  ResourceOutcome,
  Review,
} from "./store.ts";

/** Generated once per installation and kept stable across retries and upgrades. */
export const GENERATED_SECRETS = [
  "SESSION_KEY",
  "PROXY_SIGNING_KEY",
  "PROBE_TOKEN",
  "BILLING_WEBHOOK_SECRET",
  // Delivery-event signing secret (/webhooks/send-events); handed to the mail provider only when
  // one is approved, so an installation never runs with an empty (refuse-everything) secret.
  "SEND_EVENTS_WEBHOOK_SECRET",
  "SIGMIRROR_WRITE_TOKEN",
  // Single-use first-account token (workers/core/src/bootstrap.ts): stands in for Turnstile.
  "BOOTSTRAP_TOKEN",
  // Seals the newsletter provider credentials entered on first use (newsletter-config.ts).
  "NEWSLETTER_CONFIG_SEAL_KEY",
  // Seals the zone-scoped Cloudflare token the owner may enter for incoming-email activation.
  "ZONE_TOKEN_SEAL_KEY",
] as const;

/** Required by the stack but deliberately empty: no approved mail provider, no Turnstile without a domain. */
export const DISABLED_SECRETS = ["TURNSTILE_SECRET"] as const;

/**
 * Generated key pairs: the DKIM private key (PKCS#8 PEM) that signs outbound personal mail. Its
 * public half (MAIL_DKIM_PUBLIC_KEY) is derived from it and published by incoming-email
 * activation at `bye1._domainkey.<domain>`. The VAPID private key (RFC 8292, base64url P-256
 * scalar) signs Web Push for browsers and, through Bye's push gateway, the native apps; its public
 * half (VAPID_PUBLIC_KEY) is derived from it.
 */
export const GENERATED_KEYPAIRS = ["MAIL_DKIM_PRIVATE_KEY", "VAPID_PRIVATE_KEY"] as const;

export const SECRET_NAMES: ReadonlyArray<string> = [
  ...GENERATED_SECRETS,
  ...GENERATED_KEYPAIRS,
  ...DISABLED_SECRETS,
];

/** Every generated runtime secret for a new installation. */
export const generateRuntimeSecrets = () => ({
  ...Object.fromEntries(GENERATED_SECRETS.map((k) => [k, b64(32)])),
  MAIL_DKIM_PRIVATE_KEY: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey,
  VAPID_PRIVATE_KEY: vapidPrivateKey(),
});

/** Push notifications are on unless the operator turned them off. */
export const pushEnabled = (inst: Installation): boolean => inst.pushNotifications !== false;

export interface InstallInput {
  readonly accountId: string;
  readonly zoneId: string;
  readonly label: string;
  /** Omitted keeps the installation's current choice (on for a new one). */
  readonly pushNotifications?: boolean;
}

/** A fresh VAPID key: the raw 32-byte P-256 scalar, base64url (what the Worker's sender imports). */
const vapidPrivateKey = (): string => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();

  // Always 32 bytes: a short scalar (leading zero byte) would not import as a JWK `d`.
  return encode(Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]), "base64url");
};

/** The VAPID application-server key for a private scalar: uncompressed point, base64url. */
export const vapidPublicKey = (privateKey: string): string => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));

  // Uncompressed point (0x04 ‖ X ‖ Y), Node's default format.
  return encode(ecdh.getPublicKey(), "base64url");
};

/** Non-secret runtime configuration derived from an installation. */
interface RuntimeConfig {
  APP_ORIGIN: string;
  MAIL_RENDER_ORIGIN: string;
  BYE_WORKERS_DEV_NAME: string;
  APP_DOMAIN?: string;
  BOOTSTRAP_ADDRESS_DOMAIN?: string;
  INSTALL_ACCOUNT_ID?: string;
  INSTALL_ZONE_ID?: string;
  INSTALL_ZONE_NAME?: string;
  MAIL_WORKER_NAME?: string;
  NEWSLETTER_QUALIFIED?: string;
  MAIL_DKIM_PUBLIC_KEY?: string;
  MAIL_TRAFFIC_CLASSES?: string;
  VAPID_PUBLIC_KEY?: string;
  SCANNER_SIGNATURES?: string;
  SCANNER_IMAGE?: string;
  MIME_IMAGE?: string;
  SIGMIRROR_IMAGE?: string;
}

/** The DKIM `p=` value (base64 SPKI DER) for a PKCS#8 PEM private key. */
export const dkimPublicKey = (privatePem: string): string =>
  encode(createPublicKey(privatePem).export({ type: "spki", format: "der" }), "base64");

/** The "What Bye creates" disclosure; never a mandatory screen. */
export const WHAT_BYE_CREATES: ReadonlyArray<string> = [
  "Workers (the Bye app, its public site and a render origin), with Durable Objects, Workflows and Containers.",
  "A D1 database, R2 buckets, a KV namespace and Queues for your mail and data.",
  "Deployment state in your own account (Cloudflare state store).",
  "One Worker custom hostname: the Bye address you choose. No DNS, MX or Email Routing changes.",
  "A deployer Worker and container that runs the installation in your account, from Bye's release images copied into your account's container registry.",
];

/** Kept for stage-bound (internal/operator) installations and older clients. */
export const PREREQUISITES: ReadonlyArray<string> = [
  "A Cloudflare account you administer, on a Workers plan that includes Durable Objects, Queues and Containers.",
  "A workers.dev subdomain registered for that account (Workers & Pages → Overview).",
  "An active zone in that account for the Bye address.",
];

export const MANUAL_STEPS: ReadonlyArray<string> = [
  "Incoming email for your domain is a separate, optional step offered in Bye after you create your owner account; onboarding never changes DNS, MX or Email Routing.",
  "The recovery kit is available from the Recovery section at any time after Bye is created; it is issued once.",
];

/** Default label for the Bye hostname (`bye.<zone>`). */
export const DEFAULT_HOSTNAME_LABEL = "bye";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validates and normalizes a hostname label; null when invalid. */
export const normalizeLabel = (label: string): string | null => {
  const l = label.trim().toLowerCase();

  return LABEL.test(l) ? l : null;
};

/** `label.zone`, lowercase without a trailing dot, when it is a strict subdomain of `zone`. */
export const appHostnameFor = (label: string, zoneName: string): string | null => {
  const l = normalizeLabel(label);
  const zone = zoneName.trim().toLowerCase().replace(/\.$/, "");

  if (l === null || zone === "" || !zone.includes(".")) return null;
  const host = `${l}.${zone}`;

  return host.length <= 253 ? host : null;
};

/** Normal-path states (infra/onboarding/spec.md §30) plus the exceptional ones. */
export type InstallState =
  | "new"
  | "authorized"
  | "target-selected"
  | "planning"
  | "deploying"
  | "verifying"
  | "ready"
  | "needs-review"
  | "failed"
  | "interrupted"
  | "disconnected";

/** The one-time recovery kit (flow: after binding). Holds no Cloudflare credentials. */
export interface RecoveryKit {
  readonly format: "bye.recovery-kit.v1";
  readonly issuedAt: string;
  readonly installationId: string;
  readonly account: { readonly id: string; readonly name: string | null };
  /** The chosen zone and Bye hostname; null on stage-bound installations. */
  readonly zone: { readonly id: string; readonly name: string } | null;
  readonly appHostname: string | null;
  readonly ownerAddressDomain: string | null;
  readonly stage: string;
  readonly stack: "MailboxPlatform";
  readonly state: NonNullable<Installation["stateRef"]>;
  readonly release: Installation["deployedRelease"];
  readonly urls: InstanceUrls;
  /** Stack configuration for a deploy without this service (secrets included). */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Push notifications: whether they are on, and the VAPID public key to set as VAPID_PUBLIC_KEY
   * to turn them on. `env` always holds the VAPID private key, so subscriptions survive a redeploy.
   */
  readonly push: { readonly enabled: boolean; readonly vapidPublicKey: string };
  readonly notes: ReadonlyArray<string>;
}

export type OnboardingErrorCode =
  | "not_found"
  | "unauthorized"
  | "conflict"
  | "invalid"
  | "blocked"
  | "not_ready";

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  readonly nextAction: string | undefined;
  constructor(code: OnboardingErrorCode, message: string, nextAction?: string) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
  }
}

export interface ReleaseSource {
  resolve(): ReleaseResolution;
  migrations(dir: string): Promise<ReadonlyArray<string>>;
  /** Stack configuration names the release requires (check-config.ts `requiredConfig`). */
  requiredConfig(dir: string): ReadonlyArray<string>;
}

export interface ServiceDeps {
  readonly store: OnboardingStore;
  readonly keys: KeyRing;
  readonly oauth: OAuthConfig;
  /** OAuth token/revocation endpoints and deployed-instance health checks. */
  readonly fetch: Fetch;
  readonly cloudflare: CloudflareReader;
  readonly executor: DeployExecutor;
  readonly release: ReleaseSource;
  /** Private directory for per-installation execution homes. */
  readonly dataDir: string;
  readonly now?: () => number;
  readonly healthTimeouts?: { readonly request?: number; readonly async?: number };
  /** Scope matrix used for plan coverage (default: ONBOARDING_SCOPES). */
  readonly scopeMatrix?: ReadonlyArray<ScopeGrant>;
}

interface StoredCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
}

const hex = (n: number) => encode(randomBytes(n), "hex");

const b64 = (n: number) => encode(randomBytes(n), "base64url");

/** Scrubs anything token-shaped from event text, in addition to the executor's exact redaction. */
const scrub = (s: string) =>
  s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, 500);

export const workersDevUrls = (workerName: string, subdomain: string): InstanceUrls => ({
  app: `https://${workerName}.${subdomain}.workers.dev`,
  site: `https://${workerName}-site.${subdomain}.workers.dev`,
  render: `https://${workerName}-render.${subdomain}.workers.dev`,
});

/**
 * Standard installs serve the app on the chosen hostname; the public site and the separate render
 * origin stay on workers.dev (no second domain decision).
 */
export const customDomainUrls = (
  appHostname: string,
  workerName: string,
  subdomain: string,
): InstanceUrls => ({ ...workersDevUrls(workerName, subdomain), app: `https://${appHostname}` });

/**
 * Whether public DNS already answers for `host` (DNS-over-HTTPS; no zone DNS scope needed). A
 * wildcard in the zone answers for every name, which a custom domain can still take over, so an
 * answer for a random sibling means "can't tell" (null), as does any lookup failure.
 */
export const hostnameInUse = async (
  fetcher: Fetch,
  host: string,
  zone: string,
): Promise<boolean | null> => {
  const answers = async (name: string): Promise<boolean | null> => {
    for (const type of ["CNAME", "A", "AAAA"]) {
      try {
        const r = await fetcher(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
          { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
        );

        if (!r.ok) return null;
        const body = (await r.json()) as { Status?: number; Answer?: ReadonlyArray<unknown> };

        if (body.Status !== 0 && body.Status !== 3) return null;

        if ((body.Answer ?? []).length > 0) return true;
      } catch {
        return null;
      }
    }

    return false;
  };

  const direct = await answers(host);

  if (direct !== true) return direct;
  const wildcard = await answers(`bye-probe-${hex(6)}.${zone}`);

  return wildcard === false ? true : null;
};

/** Derived installation state for the progress UI (infra/onboarding/spec.md §30). */
export const installState = (
  inst: Installation,
  operation: Operation | null,
  planning = false,
): InstallState => {
  if (inst.authorization.status === "disconnected" || inst.authorization.status === "expired")
    return "disconnected";

  if (operation && (operation.status === "queued" || operation.status === "running"))
    return Match.value(operation.step).pipe(
      Match.when("revalidate", () => "planning" as const),
      Match.when("health", () => "verifying" as const),
      Match.orElse(() => "deploying" as const),
    );

  if (planning) return "planning";

  if (inst.ready) return "ready";

  if (inst.pendingReviewId) return "needs-review";

  if (operation?.status === "interrupted") return "interrupted";

  if (operation && operation.status !== "succeeded") return "failed";

  if (inst.boundAt !== null) return "target-selected";

  if (inst.authorization.status === "connected") return "authorized";

  return "new";
};

export interface StatusView {
  readonly state: InstallState;
  readonly installation: {
    readonly id: string;
    readonly accountId: string | null;
    readonly accountName: string | null;
    readonly zoneId: string | null;
    readonly zoneName: string | null;
    readonly appHostname: string | null;
    readonly ownerAddressDomain: string | null;
    readonly pendingReviewId: string | null;
    readonly stage: string | null;
    readonly stateRef: Installation["stateRef"];
    readonly urls: InstanceUrls | null;
    readonly deployedRelease: Installation["deployedRelease"];
    readonly ready: boolean;
    readonly readyAt: string | null;
    readonly recoveryKitIssuedAt: string | null;
    readonly pushNotifications: boolean;
  };
  readonly pinnedRelease: { readonly version: string; readonly commit: string } | null;
  readonly releaseProblem: string | null;
  readonly authorization: Installation["authorization"];
  readonly operation: Operation | null;
  readonly progress: ReadonlyArray<OnboardingEvent>;
  readonly prerequisites: ReadonlyArray<string>;
  readonly manualSteps: ReadonlyArray<string>;
  readonly whatByeCreates: ReadonlyArray<string>;
  readonly handoff: Handoff | null;
}

/** Result of "Create Bye": a started (or resumed) deployment, or a plan that needs review. */
export type InstallResult =
  | { readonly status: "deploying"; readonly operationId: string; readonly appUrl: string }
  | {
      readonly status: "needs-review";
      readonly reviewId: string;
      readonly reasons: ReadonlyArray<string>;
    };

/**
 * Where a deployment continues after a restart: from the start (nothing written yet), by
 * following its detached apply job, or with the read-only reconcile and health steps.
 */
type ResumePoint = "revalidate" | "follow" | "reconcile";

/** An existing installation a new session may take over (re-attach). */
export interface ReattachCandidate {
  readonly installationId: string;
  readonly accountName: string;
  readonly appUrl: string | null;
  readonly ready: boolean;
}

export interface Handoff {
  readonly url: string;
  readonly link: string;
  readonly qrSvg: string;
}

export class OnboardingService {
  private readonly active = new Map<string, { opId: string; controller: AbortController }>();
  /** Installations with a "Create Bye" request being planned (duplicate submissions are refused). */
  private readonly installing = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly deps: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Whether a deployment or "Create Bye" is in progress in this process (hosted heartbeat). */
  get busy(): boolean {
    return this.running.size > 0 || this.installing.size > 0;
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  private async event(
    installationId: string,
    kind: string,
    detail: string,
    operationId: string | null = null,
  ) {
    await this.deps.store.appendEvent({
      at: this.iso(),
      installationId,
      operationId,
      kind,
      detail: scrub(detail),
    });
  }

  // ── Installation identity ────────────────────────────────────────────────────────────────

  async installation(operatorId: string): Promise<Installation> {
    const existing = await this.deps.store.installationForOperator(operatorId);

    if (existing) return existing;

    const created: Installation = {
      id: hex(12),
      operatorId,
      createdAt: this.iso(),
      accountId: null,
      accountName: null,
      stage: null,
      workerName: null,
      stateRef: null,
      boundAt: null,
      firstWriteAt: null,
      urls: null,
      runtimeSecrets: null,
      credentials: null,
      authorization: { status: "none", scopes: [], connectedAt: null, expiresAt: null },
      deployedRelease: null,
      appliedMigrations: [],
      ready: false,
      readyAt: null,
      recoveryKitIssuedAt: null,
      zoneId: null,
      zoneName: null,
      appHostname: null,
      ownerAddressDomain: null,
      installIntent: null,
      pendingReviewId: null,
    };

    await this.deps.store.putInstallation(created);
    await this.event(created.id, "installation.created", "installation created");

    return created;
  }

  private async fresh(id: string): Promise<Installation> {
    const i = await this.deps.store.getInstallation(id);

    if (!i) throw new OnboardingError("not_found", "installation not found");

    return i;
  }

  // ── Authorization ────────────────────────────────────────────────────────────────────────

  async startAuthorization(operatorId: string, sessionId: string): Promise<{ url: string }> {
    const inst = await this.installation(operatorId);
    // Pending records hold PKCE verifiers; never let abandoned ones accumulate.
    await this.deps.store.prunePending(this.now());

    const { url, pending } = beginAuthorization(
      this.deps.oauth,
      { sessionId, installationId: inst.id },
      this.now(),
    );

    await this.deps.store.putPending(pending);
    await this.event(inst.id, "authorization.started", "redirected to Cloudflare");

    return { url };
  }

  /**
   * Handles the OAuth redirect. The callback must arrive in the session that started it AND from
   * the operator who owns the installation it was started for, so a leaked or fixated session
   * alone can't attach someone's Cloudflare grant to another operator's installation.
   * Authorization alone never starts a deployment.
   */
  async completeAuthorization(
    operatorId: string,
    sessionId: string,
    params: URLSearchParams,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const state = params.get("state");
    const pending = state ? await this.deps.store.takePending(state) : null;
    const checked = checkCallback(pending, params, sessionId, this.now());

    if (!checked.ok) {
      if (pending) await this.event(pending.installationId, "authorization.failed", checked.reason);

      return checked;
    }

    const inst = await this.fresh(checked.pending.installationId);

    if (inst.operatorId !== operatorId) {
      const reason = "authorization was started by a different operator";
      await this.event(inst.id, "authorization.failed", reason);

      return { ok: false, reason };
    }

    let tokens: TokenSet;

    try {
      tokens = await exchangeCode(
        this.deps.oauth,
        checked.code,
        checked.pending.verifier,
        this.deps.fetch,
      );
    } catch (e) {
      const reason = e instanceof OAuthError ? e.message : "token exchange failed";
      await this.event(inst.id, "authorization.failed", reason);

      return { ok: false, reason };
    }

    const reject = async (reason: string) => {
      await revokeToken(this.deps.oauth, tokens.accessToken, "access_token", this.deps.fetch);
      await this.event(inst.id, "authorization.failed", reason);

      return { ok: false as const, reason };
    };

    const missing = missingScopes(tokens.scopes);

    if (missing.length > 0)
      return reject(
        `Cloudflare granted less access than onboarding needs (missing ${missing.join(", ")})`,
      );

    // Reauthorization returns to the bound installation: the grant must still reach its account.
    if (inst.accountId !== null) {
      let accounts: ReadonlyArray<Account>;

      try {
        accounts = await this.deps.cloudflare.accounts(tokens.accessToken);
      } catch (e) {
        return reject(e instanceof CloudflareApiError ? e.message : "account check failed");
      }

      if (!accounts.some((a) => a.id === inst.accountId))
        return reject(
          `this authorization cannot reach account ${inst.accountName ?? inst.accountId}, which this installation is bound to`,
        );
    }

    const credentials: StoredCredentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };

    await this.deps.store.putInstallation({
      ...(await this.fresh(inst.id)),
      credentials: seal(this.deps.keys, credentials, inst.id),
      authorization: {
        status: "connected",
        scopes: tokens.scopes,
        connectedAt: this.iso(),
        expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
      },
    });
    await this.event(inst.id, "authorization.connected", `scopes: ${tokens.scopes.join(" ")}`);

    return { ok: true };
  }

  /**
   * A usable access token, refreshed when near expiry — or, with `fresh`, refreshed now so a
   * long Alchemy run starts with the token's full lifetime (Alchemy treats an env token as
   * non-expiring and cannot refresh it). Never returned to HTTP callers.
   */
  private async accessToken(inst: Installation, fresh = false): Promise<string> {
    if (inst.authorization.status !== "connected" || inst.credentials === null)
      throw new OnboardingError(
        "unauthorized",
        inst.authorization.status === "expired"
          ? "the Cloudflare authorization expired"
          : "Cloudflare is not connected",
        "Connect Cloudflare",
      );
    const creds = open<StoredCredentials>(this.deps.keys, inst.credentials, inst.id);
    const valid = creds.expiresAt === null || creds.expiresAt - 60_000 > this.now();

    if (valid && !(fresh && creds.refreshToken !== null)) return creds.accessToken;

    const expire = async (why: string) => {
      await this.deps.store.putInstallation({
        ...(await this.fresh(inst.id)),
        credentials: null,
        authorization: { ...inst.authorization, status: "expired" },
      });
      await this.event(inst.id, "authorization.expired", why);

      return new OnboardingError("unauthorized", why, "Reconnect Cloudflare");
    };

    if (creds.refreshToken === null) throw await expire("the Cloudflare authorization expired");

    try {
      const next = await refreshTokens(this.deps.oauth, creds.refreshToken, this.deps.fetch);
      const current = await this.fresh(inst.id);

      // A disconnect that raced the refresh wins: never restore access.
      if (current.authorization.status !== "connected")
        throw new OnboardingError(
          "unauthorized",
          "Cloudflare was disconnected",
          "Connect Cloudflare",
        );
      await this.deps.store.putInstallation({
        ...current,
        credentials: seal(
          this.deps.keys,
          {
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
            expiresAt: next.expiresAt,
          },
          inst.id,
        ),
        authorization: {
          ...current.authorization,
          expiresAt: next.expiresAt ? new Date(next.expiresAt).toISOString() : null,
        },
      });

      return next.accessToken;
    } catch (e) {
      if (e instanceof OnboardingError) throw e;
      throw await expire(
        `the Cloudflare authorization could not be refreshed (${e instanceof OAuthError ? e.code : "error"})`,
      );
    }
  }

  async accounts(operatorId: string): Promise<ReadonlyArray<Account>> {
    const inst = await this.installation(operatorId);

    return this.deps.cloudflare.accounts(await this.accessToken(inst));
  }

  /** Active zones of an account this authorization reaches (never the OAuth token itself). */
  async zones(
    operatorId: string,
    accountId: string,
  ): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>> {
    const inst = await this.installation(operatorId);
    const token = await this.accessToken(inst);

    if (!(await this.deps.cloudflare.accounts(token)).some((a) => a.id === accountId))
      throw new OnboardingError("invalid", "that account is not available to this authorization");

    return (await this.activeZones(token, accountId)).map((z) => ({ id: z.id, name: z.name }));
  }

  // ── Re-attach (infra/onboarding/spec.md §43) ─────────────────────────────────────────────

  /**
   * Installations this session's fresh Cloudflare grant proves control of: standard (prod)
   * installations bound to an account the grant reaches. Offered only to a session whose own
   * installation is still unbound, e.g. after its browser lost the session cookie.
   */
  async reattachable(operatorId: string): Promise<ReadonlyArray<ReattachCandidate>> {
    const inst = await this.installation(operatorId);

    if (inst.boundAt !== null || inst.authorization.status !== "connected") return [];
    const accounts = await this.deps.cloudflare.accounts(await this.accessToken(inst));
    const out: Array<ReattachCandidate> = [];

    for (const account of accounts) {
      const other = await this.deps.store.installationForTarget(account.id, "prod");

      if (other && other.id !== inst.id && other.boundAt !== null)
        out.push({
          installationId: other.id,
          accountName: other.accountName ?? account.name,
          appUrl: other.urls?.app ?? null,
          ready: other.ready,
        });
    }

    return out;
  }

  /**
   * Moves an installation to this session. The proof is this session's fresh grant, which must
   * reach the installation's account: whoever holds it could deploy there anyway. The previous
   * operator loses access, the grant replaces the stored one (which is revoked), and nothing is
   * deployed, retried or re-issued (the recovery kit stays issued once).
   */
  async reattach(operatorId: string, installationId: string): Promise<StatusView> {
    const current = await this.installation(operatorId);

    if (current.id === installationId) return this.status(operatorId);

    if (current.boundAt !== null || this.installing.has(current.id))
      throw new OnboardingError(
        "conflict",
        "this session already has its own installation",
        "Open onboarding in a new browser session to resume another installation",
      );
    // May refresh (and rotate) the grant; the credentials moved below are read after it.
    const token = await this.accessToken(current);
    const target = await this.deps.store.getInstallation(installationId);

    // Only what reattachable() offers: bound standard (prod) installations.
    if (!target || target.boundAt === null || target.accountId === null || target.stage !== "prod")
      throw new OnboardingError("not_found", "installation not found");
    const accounts = await this.deps.cloudflare.accounts(token);

    if (!accounts.some((a) => a.id === target.accountId))
      throw new OnboardingError(
        "unauthorized",
        "this Cloudflare authorization cannot reach the installation's account",
        "Continue with Cloudflare as a member of that account",
      );
    const refreshed = await this.fresh(current.id);

    if (refreshed.credentials === null)
      throw new OnboardingError(
        "unauthorized",
        "Cloudflare is not connected",
        "Connect Cloudflare",
      );
    const grant = open<StoredCredentials>(this.deps.keys, refreshed.credentials, current.id);

    const previous =
      target.credentials === null
        ? null
        : open<StoredCredentials>(this.deps.keys, target.credentials, target.id);

    await this.deps.store.putInstallation({
      ...(await this.fresh(target.id)),
      operatorId,
      // Sealed again: the installation ID is the additional authenticated data.
      credentials: seal(this.deps.keys, grant, target.id),
      authorization: refreshed.authorization,
    });
    await this.deps.store.deleteInstallation(current.id);
    await this.event(
      target.id,
      "installation.reattached",
      `a new operator session took over with a fresh Cloudflare grant to ${target.accountName ?? target.accountId}`,
    );

    // The replaced grant must not outlive the session that held it.
    if (previous && previous.accessToken !== grant.accessToken) {
      if (previous.refreshToken)
        await revokeToken(this.deps.oauth, previous.refreshToken, "refresh_token", this.deps.fetch);
      await revokeToken(this.deps.oauth, previous.accessToken, "access_token", this.deps.fetch);
    }

    return this.status(operatorId);
  }

  private async activeZones(token: string, accountId: string): Promise<ReadonlyArray<Zone>> {
    return (await this.deps.cloudflare.zones(token, accountId))
      .filter((z) => z.status === "active")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Standard install: account + zone + label → Create Bye ───────────────────────────────

  /**
   * "Create Bye" (infra/onboarding/spec.md §5–§6): binds the immutable install target (fixed stage
   * `prod`), records the install intent, plans, and — only for a standard clean first install —
   * approves by policy and starts the deployment. Otherwise the plan waits in `needs-review`.
   * Zone name and hostname are derived here from Cloudflare, never taken from the browser.
   */
  async install(operatorId: string, input: InstallInput): Promise<InstallResult> {
    const inst = await this.installation(operatorId);

    if (this.installing.has(inst.id))
      throw new OnboardingError("conflict", "Bye is already being prepared", "Wait for it");
    this.installing.add(inst.id);

    try {
      return await this.runInstall(operatorId, inst, input);
    } finally {
      this.installing.delete(inst.id);
    }
  }

  private async runInstall(
    operatorId: string,
    initial: Installation,
    input: InstallInput,
  ): Promise<InstallResult> {
    const label = normalizeLabel(input.label);

    if (label === null)
      throw new OnboardingError(
        "invalid",
        "the Bye address must be 1–63 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
      );
    // A running deployment is simply reported (duplicate "Create Bye").
    const active = await this.activeOperation(initial.id);

    if (active && initial.urls)
      return { status: "deploying", operationId: active.id, appUrl: initial.urls.app };
    const bound = await this.bindTarget(initial, input.accountId, input.zoneId, label);

    // The choice is part of the configuration (and so of the reviewed digest) from the first plan.
    const inst =
      input.pushNotifications === undefined || input.pushNotifications === pushEnabled(bound)
        ? bound
        : await this.recordPush(bound, input.pushNotifications);

    const resolved = this.deps.release.resolve();

    if (!resolved.ok)
      throw new OnboardingError("blocked", resolved.reason, "Contact the Bye release owner");

    // The intent is recorded before planning; a retry keeps the first one (same target).
    const intent: InstallIntent =
      inst.installIntent &&
      canonical(inst.installIntent.release) === canonical(resolved.release.ref) &&
      inst.installIntent.zoneId === inst.zoneId
        ? inst.installIntent
        : {
            id: hex(12),
            installationId: inst.id,
            accountId: inst.accountId!,
            zoneId: inst.zoneId!,
            zoneName: inst.zoneName!,
            appHostname: inst.appHostname!,
            stage: "prod",
            release: resolved.release.ref,
            createdAt: this.iso(),
            operatorId,
          };

    if (intent !== inst.installIntent) {
      await this.deps.store.putInstallation({
        ...(await this.fresh(inst.id)),
        installIntent: intent,
      });
      await this.event(
        inst.id,
        "install.intent",
        `Create Bye at ${intent.appHostname} (release ${intent.release.version})`,
      );
    }

    const review = await this.review(operatorId);
    const current = await this.fresh(inst.id);

    const reasons = autoApprovalBlockers({
      installation: current,
      intent,
      review,
      release: resolved.release.ref,
      releaseMigrations: await this.deps.release.migrations(resolved.release.dir),
    });

    if (reasons.length > 0) {
      await this.deps.store.putInstallation({ ...current, pendingReviewId: review.id });
      await this.event(inst.id, "install.needs-review", reasons.join("; "));

      return { status: "needs-review", reviewId: review.id, reasons };
    }

    const approval: Approval = {
      id: hex(12),
      reviewId: review.id,
      installationId: inst.id,
      digest: review.digest,
      subject: review.subject,
      approvedAt: this.iso(),
      approvedBy: operatorId,
      policy: "standard-first-install",
      installIntentId: intent.id,
    };

    await this.deps.store.putApproval(approval);
    await this.deps.store.putInstallation({
      ...(await this.fresh(inst.id)),
      pendingReviewId: null,
    });
    await this.event(
      inst.id,
      "approval.recorded",
      `standard first install approved by policy for install intent ${intent.id} (plan ${review.digest.slice(0, 12)})`,
    );
    const op = await this.deploy(operatorId, approval.id);

    return { status: "deploying", operationId: op.id, appUrl: current.urls!.app };
  }

  /** Binds account + zone + hostname once; a retry with the same target returns the record. */
  private async bindTarget(
    inst: Installation,
    accountId: string,
    zoneId: string,
    label: string,
  ): Promise<Installation> {
    if (inst.boundAt !== null) {
      const same =
        inst.accountId === accountId &&
        inst.zoneId === zoneId &&
        inst.appHostname === appHostnameFor(label, inst.zoneName ?? "");

      if (same) return inst;

      // Before the first deployment write nothing exists yet, so a standard install may still
      // move to another hostname (e.g. the first one was taken). Afterwards the target is fixed,
      // and once the recovery kit (which names the target) is out it is fixed too.
      const movable =
        !!inst.appHostname &&
        inst.firstWriteAt === null &&
        !inst.provisionedAt &&
        !inst.recoveryKitIssuedAt &&
        (await this.activeOperation(inst.id)) === null;

      if (!movable)
        throw new OnboardingError(
          "conflict",
          inst.appHostname
            ? `this installation is bound to ${inst.appHostname} in ${inst.accountName ?? inst.accountId}`
            : `this installation is bound to ${inst.accountName ?? inst.accountId} / ${inst.stage}`,
          "Retries always use the recorded account, zone and hostname; changing them needs a separately reviewed workflow",
        );
    }

    const token = await this.accessToken(inst);
    const account = (await this.deps.cloudflare.accounts(token)).find((a) => a.id === accountId);

    if (!account)
      throw new OnboardingError("invalid", "that account is not available to this authorization");
    const zone = (await this.activeZones(token, accountId)).find((z) => z.id === zoneId);

    if (!zone)
      throw new OnboardingError(
        "invalid",
        "that domain is not an active zone in the selected Cloudflare account",
        "Add or activate the domain in Cloudflare, then refresh domains",
      );
    const appHostname = appHostnameFor(label, zone.name);

    if (appHostname === null)
      throw new OnboardingError("invalid", "that Bye address is not a valid hostname in the zone");

    // A Worker custom domain never overrides an existing record, so catch the conflict before
    // anything is created instead of at the final attach.
    if ((await hostnameInUse(this.deps.fetch, appHostname, zone.name)) === true)
      throw new OnboardingError(
        "conflict",
        `${appHostname} already has DNS records`,
        "Choose another Bye address, or remove those records in Cloudflare first",
      );
    const other = await this.deps.store.installationForTarget(accountId, "prod");

    if (other && other.id !== inst.id)
      throw new OnboardingError("conflict", "another installation already targets this account");
    const subdomain = await this.deps.cloudflare.workersSubdomain(token, accountId);

    if (!subdomain)
      throw new OnboardingError(
        "blocked",
        "the account has no workers.dev subdomain",
        "Register a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then continue",
      );
    const workerName = `bye-${inst.id.slice(0, 10)}`;

    // A move before the first write keeps the already generated secrets.
    const runtimeSecrets =
      inst.runtimeSecrets ?? seal(this.deps.keys, generateRuntimeSecrets(), inst.id);

    const bound: Installation = {
      ...(await this.fresh(inst.id)),
      installIntent: null,
      pendingReviewId: null,
      accountId,
      accountName: account.name,
      stage: "prod",
      workerName,
      urls: customDomainUrls(appHostname, workerName, subdomain),
      stateRef: { backend: "cloudflare", accountId, stack: "MailboxPlatform", stage: "prod" },
      runtimeSecrets,
      boundAt: this.iso(),
      zoneId: zone.id,
      zoneName: zone.name,
      appHostname,
      ownerAddressDomain: zone.name,
    };

    await this.deps.store.putInstallation(bound);
    await this.event(inst.id, "installation.bound", `account ${account.name}, ${appHostname}`);

    return bound;
  }

  // ── Stage binding (internal/test/operator pathway; the normal UI never asks for a stage) ──

  async bind(operatorId: string, accountId: string, stage: string): Promise<Installation> {
    const inst = await this.installation(operatorId);

    if (inst.boundAt !== null) {
      if (inst.accountId === accountId && inst.stage === stage) return inst;
      throw new OnboardingError(
        "conflict",
        `this installation is bound to ${inst.accountName ?? inst.accountId} / ${inst.stage}`,
        "Changing the account or stage needs a separately reviewed workflow; retries always use the bound target",
      );
    }

    const stageProblem = allowedStage(stage);

    if (stageProblem) throw new OnboardingError("invalid", stageProblem);
    const token = await this.accessToken(inst);
    const account = (await this.deps.cloudflare.accounts(token)).find((a) => a.id === accountId);

    if (!account)
      throw new OnboardingError("invalid", "that account is not available to this authorization");
    const other = await this.deps.store.installationForTarget(accountId, stage);

    if (other && other.id !== inst.id)
      throw new OnboardingError(
        "conflict",
        `another installation already targets this account and stage ${stage}`,
      );
    const subdomain = await this.deps.cloudflare.workersSubdomain(token, accountId);

    if (!subdomain)
      throw new OnboardingError(
        "blocked",
        "the account has no workers.dev subdomain",
        "Register a workers.dev subdomain in the Cloudflare dashboard, then continue",
      );
    const workerName = `bye-${inst.id.slice(0, 10)}`;
    const secrets = generateRuntimeSecrets();

    const bound: Installation = {
      ...(await this.fresh(inst.id)),
      accountId,
      accountName: account.name,
      stage,
      workerName,
      urls: workersDevUrls(workerName, subdomain),
      stateRef: { backend: "cloudflare", accountId, stack: "MailboxPlatform", stage },
      runtimeSecrets: seal(this.deps.keys, secrets, inst.id),
      boundAt: this.iso(),
    };

    await this.deps.store.putInstallation(bound);
    await this.event(inst.id, "installation.bound", `account ${account.name}, stage ${stage}`);

    return bound;
  }

  private config(inst: Installation) {
    const secrets = open<Record<string, string>>(this.deps.keys, inst.runtimeSecrets!, inst.id);
    // Newsletter dispatch qualification comes only from the pinned release's own evidence file,
    // never from the operator. It is part of the configuration digest, so a release that changes
    // it needs a fresh review.
    const resolved = this.deps.release.resolve();
    const qualified = resolved.ok ? (resolved.release.qualification?.newsletter ?? null) : null;

    const config: RuntimeConfig = {
      APP_ORIGIN: inst.urls!.app,
      MAIL_RENDER_ORIGIN: inst.urls!.render,
      BYE_WORKERS_DEV_NAME: inst.workerName!,
    };

    // The chosen Bye hostname becomes MailCore's custom domain. Installation metadata is
    // non-secret: the bootstrap address domain and the zone incoming email binds to later.
    if (inst.appHostname) {
      config.APP_DOMAIN = inst.appHostname;
      config.BOOTSTRAP_ADDRESS_DOMAIN = inst.ownerAddressDomain ?? inst.zoneName ?? "";
      config.INSTALL_ACCOUNT_ID = inst.accountId!;
      config.INSTALL_ZONE_ID = inst.zoneId ?? "";
      config.INSTALL_ZONE_NAME = inst.zoneName ?? "";
      // The Worker incoming email's catch-all routes to (MailCore's fixed name).
      config.MAIL_WORKER_NAME = inst.workerName!;
    }

    if (qualified) config.NEWSLETTER_QUALIFIED = qualified;

    // A release with pinned images deploys them from the account's own registry (the deployer
    // copies them there; nothing is built). Part of the configuration digest, like the release.
    const images = resolved.ok ? resolved.release.ref.images : undefined;

    if (images) {
      const ref = (name: keyof typeof images) =>
        accountImageRef(inst.accountId!, INSTALL_IMAGES[name], images[name]);

      config.SCANNER_SIGNATURES = "baked";
      config.SCANNER_IMAGE = ref("scanner");
      config.MIME_IMAGE = ref("mime");
      config.SIGMIRROR_IMAGE = ref("sigmirror");
    }

    // Outbound personal mail through Cloudflare Email Sending, DKIM-signed with the generated
    // key (installations bound before key generation keep transactional mail only).
    if (secrets.MAIL_DKIM_PRIVATE_KEY) {
      config.MAIL_DKIM_PUBLIC_KEY = dkimPublicKey(secrets.MAIL_DKIM_PRIVATE_KEY);
      config.MAIL_TRAFFIC_CLASSES = "transactional,personal";
    }

    // Push notifications: on, the public half is derived for /v1/push/vapid-key; off, no key is
    // deployed (the sealed one is kept for turning it back on).
    const push =
      pushEnabled(inst) && secrets.VAPID_PRIVATE_KEY
        ? {
            VAPID_PRIVATE_KEY: secrets.VAPID_PRIVATE_KEY,
            VAPID_PUBLIC_KEY: vapidPublicKey(secrets.VAPID_PRIVATE_KEY),
          }
        : { VAPID_PRIVATE_KEY: "", VAPID_PUBLIC_KEY: "" };

    return {
      ...config,
      ...secrets,
      ...Object.fromEntries(DISABLED_SECRETS.map((k) => [k, ""])),
      ...push,
    };
  }

  private context(
    inst: Installation,
    releaseDir: string,
    token: string,
    signal: AbortSignal,
  ): ExecutionContext {
    return {
      installationId: inst.id,
      releaseDir,
      homeDir: join(this.deps.dataDir, "homes", inst.id),
      stage: inst.stage!,
      accountId: inst.accountId!,
      apiToken: token,
      config: this.config(inst),
      signal,
    };
  }

  /** Checks that need no plan: release, account access, subdomain, names, required config. */
  private async prerequisites(inst: Installation, token: string): Promise<ReadonlyArray<string>> {
    const blockers: Array<string> = [];
    const accounts = await this.deps.cloudflare.accounts(token);

    if (!accounts.some((a) => a.id === inst.accountId))
      blockers.push("the bound account is no longer reachable with this authorization");
    const subdomain = await this.deps.cloudflare.workersSubdomain(token, inst.accountId!);

    if (!subdomain || workersDevUrls(inst.workerName!, subdomain).render !== inst.urls!.render)
      blockers.push("the account's workers.dev subdomain changed or was removed");

    if (inst.zoneId) {
      // The chosen zone must still be an active zone of the bound account, with the same name.
      const zone = (await this.deps.cloudflare.zones(token, inst.accountId!)).find(
        (z) => z.id === inst.zoneId,
      );

      if (!zone || zone.status !== "active" || zone.name !== inst.zoneName)
        blockers.push(`the zone ${inst.zoneName} is no longer an active zone in the bound account`);
      else if (!inst.appHostname?.endsWith(`.${zone.name}`))
        blockers.push("the Bye hostname is not a subdomain of the bound zone");
    }

    if (inst.firstWriteAt === null) {
      const names = new Set(await this.deps.cloudflare.workerNames(token, inst.accountId!));
      const n = inst.workerName!;

      for (const taken of [n, `${n}-site`, `${n}-render`].filter((x) => names.has(x)))
        blockers.push(`a Worker named ${taken} already exists in the account`);
    }

    return blockers;
  }

  private requiredConfigGaps(releaseDir: string, config: Readonly<Record<string, string>>) {
    return this.deps.release
      .requiredConfig(releaseDir)
      .filter((name) => !(name in config))
      .map((name) => `required stack configuration ${name} has no onboarding value`);
  }

  /**
   * Generated secrets added after an installation was bound (currently the VAPID key) are created
   * on its next review and sealed with the rest, so existing installations gain them on upgrade.
   * The DKIM key is deliberately not backfilled: it changes which mail an instance sends.
   */
  private async completeSecrets(inst: Installation): Promise<Installation> {
    if (!inst.runtimeSecrets) return inst;
    const secrets = open<Record<string, string>>(this.deps.keys, inst.runtimeSecrets, inst.id);

    if (secrets.VAPID_PRIVATE_KEY) return inst;

    const next: Installation = {
      ...(await this.fresh(inst.id)),
      runtimeSecrets: seal(
        this.deps.keys,
        { ...secrets, VAPID_PRIVATE_KEY: vapidPrivateKey() },
        inst.id,
      ),
    };

    await this.deps.store.putInstallation(next);
    await this.event(inst.id, "secrets.generated", "VAPID key for push notifications");

    return next;
  }

  private async recordPush(inst: Installation, enabled: boolean): Promise<Installation> {
    const next: Installation = { ...(await this.fresh(inst.id)), pushNotifications: enabled };
    await this.deps.store.putInstallation(next);
    await this.event(
      inst.id,
      "settings.push",
      `push notifications ${enabled ? "on" : "off"} (applies with the next deployment)`,
    );

    return next;
  }

  /**
   * Turn push notifications on or off for a bound installation. Like any configuration change it
   * takes effect through a reviewed deployment; the caller reviews next.
   */
  async setPushNotifications(operatorId: string, enabled: boolean): Promise<StatusView> {
    const inst = await this.installation(operatorId);

    if (inst.boundAt === null)
      throw new OnboardingError("invalid", "choose where Bye should live first");

    if (await this.activeOperation(inst.id))
      throw new OnboardingError(
        "conflict",
        "a deployment is already in progress for this installation",
        "Wait for it to finish, then change the setting",
      );

    if (pushEnabled(inst) !== enabled) await this.recordPush(inst, enabled);

    return this.status(operatorId);
  }

  // ── Review and approval ──────────────────────────────────────────────────────────────────

  async review(operatorId: string): Promise<Review> {
    const bound = await this.installation(operatorId);

    if (bound.boundAt === null)
      throw new OnboardingError("invalid", "choose where Bye should live first");

    const token = await this.accessToken(bound);
    const resolved = this.deps.release.resolve();

    if (!resolved.ok)
      throw new OnboardingError("blocked", resolved.reason, "Contact the Bye release owner");

    // A plan now would race the running apply (the hosted deployer runs one job at a time), and
    // its result would be stale when the apply finishes anyway.
    if (await this.activeOperation(bound.id))
      throw new OnboardingError(
        "conflict",
        "a deployment is already in progress for this installation",
        "Wait for it to finish, then review again",
      );

    const blockers: Array<string> = [
      ...(await this.prerequisites(bound, token)),
      // The VAPID names are always present (empty when push is off), so this doesn't depend on
      // whether the key exists yet.
      ...this.requiredConfigGaps(resolved.release.dir, this.config(bound)),
    ];

    // A missing key is created only for a plan that can go ahead (nothing running, no blockers),
    // just before the configuration digest: this review is what approves and deploys it.
    const inst = blockers.length === 0 ? await this.completeSecrets(bound) : bound;
    const config = this.config(inst);

    // A hosted plan first provisions the deployer in the account: that is a write. It happens
    // only for a target that passes its prerequisites, is recorded before it starts, and fixes
    // the target from then on (the deployer and images live in that account).
    if (this.deps.executor.provisionsOnPlan && !inst.provisionedAt) {
      if (blockers.length > 0)
        throw new OnboardingError(
          "blocked",
          blockers.join("; "),
          "Resolve these first; nothing has been created in your Cloudflare account yet",
        );
      await this.deps.store.putInstallation({
        ...(await this.fresh(inst.id)),
        provisionedAt: this.iso(),
      });
      await this.event(
        inst.id,
        "deployer.provisioning",
        `deployer for ${inst.accountName ?? inst.accountId}`,
      );
    }

    const controller = new AbortController();
    let exported: ExportedPlan;

    try {
      exported = await this.deps.executor.plan(
        this.context(inst, resolved.release.dir, token, controller.signal),
      );
    } catch (e) {
      throw new OnboardingError(
        "blocked",
        e instanceof Error ? scrub(e.message) : "planning failed",
        'If Alchemy state cannot be read, stop and follow infra/RUNBOOK.md "Interrupted deploy"; onboarding never substitutes fresh state',
      );
    }

    const outcome = buildReview({
      installation: inst,
      release: resolved.release.ref,
      exported,
      configHash: configHash(config, SECRET_NAMES),
      releaseMigrations: await this.deps.release.migrations(resolved.release.dir),
      prerequisiteBlockers: blockers,
      grantedScopes: inst.authorization.scopes,
      scopeMatrix: this.deps.scopeMatrix,
    });

    const review: Review = {
      id: hex(12),
      installationId: inst.id,
      createdAt: this.iso(),
      ...outcome,
    };

    await this.deps.store.putReview(review);
    await this.event(
      inst.id,
      "review.created",
      `${review.subject.actions.length} changes, ${review.blockers.length} blockers, release ${review.subject.release.version}`,
    );

    return review;
  }

  async approve(
    operatorId: string,
    reviewId: string,
    digest: string,
    acknowledgeDestructive = false,
  ): Promise<Approval> {
    const inst = await this.installation(operatorId);
    const review = await this.deps.store.getReview(reviewId);

    if (!review || review.installationId !== inst.id)
      throw new OnboardingError("not_found", "review not found");

    if (review.blockers.length > 0)
      throw new OnboardingError("blocked", "this review has blockers and cannot be approved");

    if (digest !== review.digest)
      throw new OnboardingError("invalid", "the approved plan does not match the review shown");

    if (review.destructive.length > 0 && !acknowledgeDestructive)
      throw new OnboardingError("invalid", "destructive changes need explicit acknowledgement");

    const approval: Approval = {
      id: hex(12),
      reviewId,
      installationId: inst.id,
      digest,
      subject: review.subject,
      approvedAt: this.iso(),
      approvedBy: operatorId,
      policy: "operator",
    };

    await this.deps.store.putApproval(approval);
    const current = await this.fresh(inst.id);

    if (current.pendingReviewId)
      await this.deps.store.putInstallation({ ...current, pendingReviewId: null });
    await this.event(
      inst.id,
      "approval.recorded",
      `approval ${approval.id} for plan ${digest.slice(0, 12)}`,
    );

    return approval;
  }

  // ── Deployment ───────────────────────────────────────────────────────────────────────────

  private async activeOperation(installationId: string): Promise<Operation | null> {
    return (
      (await this.deps.store.operations(installationId)).find(
        (o) => o.status === "queued" || o.status === "running",
      ) ?? null
    );
  }

  /**
   * Starts (or returns the already active) deployment for an approval. Only one writer runs per
   * installation; a repeated submission gets the active operation back instead of a second writer.
   */
  async deploy(operatorId: string, approvalId: string): Promise<Operation> {
    const inst = await this.installation(operatorId);
    const approval = await this.deps.store.getApproval(approvalId);

    if (!approval || approval.installationId !== inst.id)
      throw new OnboardingError("not_found", "approval not found");

    if (inst.authorization.status !== "connected")
      throw new OnboardingError(
        "unauthorized",
        "Cloudflare is not connected",
        "Connect Cloudflare, then review again",
      );
    const active = await this.activeOperation(inst.id);

    if (active) return active;

    const op: Operation = {
      id: hex(12),
      installationId: inst.id,
      kind: "deploy",
      approvalId,
      status: "queued",
      step: "revalidate",
      createdAt: this.iso(),
      updatedAt: this.iso(),
      finishedAt: null,
      outcomes: [],
      health: [],
      error: null,
    };

    const holder = await this.deps.store.acquireWriter(inst.id, op.id);

    if (holder !== null) {
      const held = await this.deps.store.getOperation(holder);

      if (held) return held;
      throw new OnboardingError(
        "conflict",
        "another writer holds this installation",
        "Wait for it to finish",
      );
    }

    await this.deps.store.putOperation(op);
    await this.event(inst.id, "operation.queued", `deploy with approval ${approvalId}`, op.id);
    this.launch(op, approval, "revalidate");

    return op;
  }

  /** Runs an operation that holds the writer lock in the background; the lock is released after. */
  private launch(op: Operation, approval: Approval, from: ResumePoint) {
    const controller = new AbortController();
    this.active.set(op.installationId, { opId: op.id, controller });

    const run = this.execute(op, approval, controller.signal, from).finally(async () => {
      this.active.delete(op.installationId);
      this.running.delete(op.id);
      await this.deps.store.releaseWriter(op.installationId, op.id);
    });

    this.running.set(op.id, run);
  }

  /** One of this operator's operations (progress polling). */
  async operation(operatorId: string, operationId: string): Promise<Operation> {
    const inst = await this.installation(operatorId);
    const op = await this.deps.store.getOperation(operationId);

    if (!op || op.installationId !== inst.id)
      throw new OnboardingError("not_found", "operation not found");

    return op;
  }

  /** Resolves when the operation's background run finishes (tests, graceful shutdown). */
  async settled(operationId: string): Promise<void> {
    await this.running.get(operationId);
  }

  private async execute(
    initial: Operation,
    approval: Approval,
    signal: AbortSignal,
    from: ResumePoint = "revalidate",
  ): Promise<void> {
    let op = initial;
    const instId = op.installationId;

    const save = async (patch: Partial<Operation>) => {
      op = { ...op, ...patch, updatedAt: this.iso() };
      await this.deps.store.putOperation(op);
    };

    const step = async (s: OperationStep) => {
      await save({ step: s, status: "running" });
      await this.event(instId, "operation.step", s, op.id);
    };

    const fail = async (
      s: OperationStep,
      message: string,
      nextAction: string,
      status: "failed" | "cancelled" = "failed",
    ) => {
      await save({
        status,
        step: s,
        finishedAt: this.iso(),
        error: { step: s, message: scrub(message), nextAction },
      });
      await this.event(instId, `operation.${status}`, `${s}: ${message}`, op.id);
    };

    // Disconnect aborts `signal` and flips the authorization status; either stops further calls.
    const stopped = async () =>
      signal.aborted || (await this.fresh(instId)).authorization.status !== "connected";

    /**
     * Records apply output as progress events (the first 400 lines) and, for a detached job, how
     * far it has been read, so a resumed follow continues close to where this one stopped.
     */
    const recorder = (start: number) => {
      let n = start;

      return (line: string) => {
        if (n < 400) void this.event(instId, "apply.progress", line, op.id);
        n++;

        if (op.job && n % 20 === 0) void save({ job: { ...op.job, next: n } });
      };
    };

    const STOPPED_NEXT =
      "Reconnect Cloudflare, review again and retry: completed resources are kept and nothing is replayed blindly";

    try {
      let inst = await this.fresh(instId);
      const resolved = this.deps.release.resolve();
      const dir = resolved.ok ? resolved.release.dir : "";
      let token = "";
      const ctx = () => this.context(inst, dir, token, signal);
      let planned: ReadonlyArray<PlannedAction>;
      let applied: ApplyResult | null = null;

      if (from === "revalidate") {
        await step("revalidate");

        try {
          token = await this.accessToken(inst, true);
        } catch (e) {
          return await fail(
            "revalidate",
            e instanceof Error ? e.message : "authorization unavailable",
            "Reconnect Cloudflare",
          );
        }

        if (!resolved.ok)
          return await fail(
            "revalidate",
            resolved.reason,
            "Review again once the pinned release is available",
          );

        if (JSON.stringify(resolved.release.ref) !== JSON.stringify(approval.subject.release))
          return await fail(
            "revalidate",
            `the pinned release is now ${resolved.release.ref.version}, not the approved ${approval.subject.release.version}`,
            "Review and approve the new release; retries never deploy a newer release silently",
          );
        const prereq = await this.prerequisites(inst, token);
        let exported: ExportedPlan;

        try {
          exported = await this.deps.executor.plan(ctx());
        } catch (e) {
          return await fail(
            "revalidate",
            e instanceof Error ? e.message : "planning failed",
            'If Alchemy state cannot be read, follow infra/RUNBOOK.md "Interrupted deploy"; do not start over with fresh state',
          );
        }

        const fresh = buildReview({
          installation: inst,
          release: resolved.release.ref,
          exported,
          configHash: configHash(this.config(inst), SECRET_NAMES),
          releaseMigrations: await this.deps.release.migrations(resolved.release.dir),
          prerequisiteBlockers: [
            ...prereq,
            ...this.requiredConfigGaps(resolved.release.dir, this.config(inst)),
          ],
          grantedScopes: inst.authorization.scopes,
          scopeMatrix: this.deps.scopeMatrix,
        });

        // A retry after a partial apply is not a first deployment: existing rows are its own.
        const blockers = fresh.blockers.filter(
          (b) => !(inst.firstWriteAt !== null && b.startsWith("Alchemy state already holds")),
        );

        if (blockers.length > 0)
          return await fail(
            "revalidate",
            blockers.join("; "),
            "Resolve the blockers, then review again",
          );
        const drift = approvalCovers(approval.subject, fresh.subject);

        if (drift.length > 0)
          return await fail(
            "revalidate",
            `the approval no longer covers the plan: ${drift.join("; ")}`,
            "Review the new plan and approve it; the old approval cannot authorize new effects",
          );

        planned = fresh.subject.actions;
        // Persisted before any write, so a resumed operation reconciles exactly these actions.
        await save({ planned });

        if (planned.length > 0) {
          if (await stopped())
            return await fail(
              "apply",
              "deployment stopped before any write",
              STOPPED_NEXT,
              "cancelled",
            );

          if (inst.firstWriteAt === null) {
            inst = { ...(await this.fresh(instId)), firstWriteAt: this.iso() };
            await this.deps.store.putInstallation(inst);
          }

          await step("apply");

          applied = await this.deps.executor.apply(ctx(), recorder(0), async (job) => {
            await save({ job: { ...job, next: 0 } });
          });
        }
      } else {
        // Resumed after a restart: the approval was already checked against a fresh plan before
        // the first write. Following a job or reconciling needs no management write.
        planned = op.planned ?? [];

        try {
          token = await this.accessToken(inst);
        } catch {
          token = "";
        }

        if (from === "follow" && op.job && this.deps.executor.resume) {
          applied = await this.deps.executor.resume(
            ctx(),
            { id: op.job.id, endpoint: op.job.endpoint },
            op.job.next,
            recorder(op.job.next),
          );
        } else applied = op.applied ?? null;
      }

      let outcomes: Array<ResourceOutcome> = [];

      if (planned.length > 0) {
        if (applied === null)
          return await fail(
            "apply",
            "the result of the apply was not recorded",
            "Review again: the fresh plan shows what exists",
          );
        await save({ applied });

        if (applied.aborted || (await stopped())) {
          // No further API calls after a stop: outcomes stay uncertain until a reviewed reconcile.
          await save({
            outcomes: planned.map((a) => ({
              fqn: a.fqn,
              logicalId: a.logicalId,
              action: a.action,
              outcome: "uncertain",
            })),
          });

          return await fail(
            "apply",
            "deployment was stopped while applying; requests already sent to Cloudflare may still complete",
            STOPPED_NEXT,
            "cancelled",
          );
        }

        await step("reconcile");

        try {
          token = await this.accessToken(await this.fresh(instId));
          const after = await this.deps.executor.plan(ctx());
          outcomes = planned.map((a) => {
            const row = after.rows.find((r) => r.fqn === a.fqn);

            const outcome: ResourceOutcome["outcome"] =
              row === undefined || row.action === "noop"
                ? "completed"
                : row.action === a.action || (a.action === "create" && row.action === "update")
                  ? "pending"
                  : "uncertain";

            return { fqn: a.fqn, logicalId: a.logicalId, action: a.action, outcome };
          });
        } catch {
          outcomes = planned.map((a) => ({
            fqn: a.fqn,
            logicalId: a.logicalId,
            action: a.action,
            outcome: "uncertain",
          }));
        }

        await save({ outcomes });

        if (!applied.ok)
          return await fail(
            "apply",
            `${applied.detail}; ${outcomes.filter((o) => o.outcome === "completed").length} of ${outcomes.length} changes completed`,
            "Retry with the same approval: completed resources are kept and only approved remaining actions run",
          );
        const open = outcomes.filter((o) => o.outcome !== "completed");

        if (open.length > 0)
          return await fail(
            "reconcile",
            `the deploy reported success but ${open.length} changes are not reflected in Alchemy state`,
            'Review again; if the plan shows replacements or deletions, stop and follow infra/RUNBOOK.md "Interrupted deploy"',
          );
        inst = await this.fresh(instId);
        await this.deps.store.putInstallation({
          ...inst,
          deployedRelease: approval.subject.release,
          appliedMigrations: [
            ...new Set([...inst.appliedMigrations, ...approval.subject.migrations]),
          ].sort(),
        });
      } else if (inst.deployedRelease === null) {
        inst = await this.fresh(instId);
        await this.deps.store.putInstallation({
          ...inst,
          deployedRelease: approval.subject.release,
        });
      }

      await step("health");
      inst = await this.fresh(instId);

      const probeToken = open<Record<string, string>>(
        this.deps.keys,
        inst.runtimeSecrets!,
        inst.id,
      ).PROBE_TOKEN!;

      let health: ReadonlyArray<HealthResult>;

      try {
        health = await runHealthChecks(
          inst.urls!,
          probeToken,
          this.deps.fetch,
          this.deps.healthTimeouts,
        );
      } catch (e) {
        health = [
          { name: "health", ok: false, ms: 0, detail: e instanceof Error ? e.message : "failed" },
        ];
      }

      await save({ health });
      const failed = health.filter((h) => !h.ok);
      inst = await this.fresh(instId);

      if (failed.length > 0) {
        await this.deps.store.putInstallation({ ...inst, ready: false });

        return await fail(
          "health",
          `required checks failed: ${failed.map((h) => `${h.name} (${h.detail})`).join(", ")}`,
          "Deploy again with the same approval to rerun the checks; no resource changes are replayed",
        );
      }

      await this.deps.store.putInstallation({ ...inst, ready: true, readyAt: this.iso() });
      await save({ status: "succeeded", step: "done", finishedAt: this.iso() });
      await this.event(instId, "operation.succeeded", `ready at ${inst.urls!.app}`, op.id);
    } catch (e) {
      await fail(
        op.step,
        e instanceof Error ? e.message : "unexpected failure",
        "Review again before retrying; outcomes of this step are uncertain",
      );
    }
  }

  /**
   * After process loss. With an executor that runs applies as detached jobs (hosted), operations
   * are continued where that is safe: before any write (revalidate again), while the apply job may
   * still be running (follow it), or after it (reconcile and health, both read-only). Everything
   * else, and every operation without a connected authorization, is marked interrupted (outcome
   * uncertain) and its writer lock released; recovery is then a fresh review whose plan reconciles
   * against Alchemy state, never a blind replay.
   */
  async recover(installationIds: ReadonlyArray<string>): Promise<number> {
    let n = 0;

    for (const id of installationIds) {
      for (const op of await this.deps.store.operations(id)) {
        if (op.status !== "queued" && op.status !== "running") continue;

        if (this.running.has(op.id)) continue;
        const from = await this.resumePoint(op);
        const approval = from ? await this.deps.store.getApproval(op.approvalId) : null;

        if (from && approval && (await this.deps.store.acquireWriter(id, op.id)) === null) {
          await this.event(id, "operation.resumed", `resumed at ${from} after a restart`, op.id);
          this.launch(op, approval, from);
          continue;
        }

        await this.deps.store.putOperation({
          ...op,
          status: "interrupted",
          updatedAt: this.iso(),
          finishedAt: this.iso(),
          error: {
            step: op.step,
            message: "the onboarding service stopped during this step; its outcome is uncertain",
            nextAction:
              "Review again: the fresh plan shows what exists. Retry only if it contains no replacement or deletion of persistent resources",
          },
        });
        await this.deps.store.releaseWriter(id, op.id);
        await this.event(id, "operation.interrupted", `step ${op.step}`, op.id);
        n++;
      }
    }

    return n;
  }

  /** Where an operation left by a lost process can safely continue, or null (interrupted). */
  private async resumePoint(op: Operation): Promise<ResumePoint | null> {
    if (!this.deps.executor.resume) return null;
    const inst = await this.deps.store.getInstallation(op.installationId);

    if (inst?.authorization.status !== "connected") return null;

    if (op.status === "queued" || op.step === "revalidate") return "revalidate";

    if (op.applied || op.step === "reconcile" || op.step === "health")
      return op.planned && (op.applied || op.planned.length === 0) ? "reconcile" : null;

    return op.step === "apply" && op.job ? "follow" : null;
  }

  // ── Disconnect ───────────────────────────────────────────────────────────────────────────

  async disconnect(
    operatorId: string,
  ): Promise<{ readonly revocation: string; readonly inFlight: string | null }> {
    const inst = await this.installation(operatorId);

    const creds =
      inst.credentials === null
        ? null
        : open<StoredCredentials>(this.deps.keys, inst.credentials, inst.id);

    const active = await this.activeOperation(inst.id);
    // 1. Block: no new, queued or retried writes and no refresh from here on.
    await this.deps.store.putInstallation({
      ...inst,
      credentials: null,
      authorization: { ...inst.authorization, status: "disconnected" },
    });
    // 2. Stop active work before any further deployment API call.
    this.active.get(inst.id)?.controller.abort();

    const inFlight =
      active === null
        ? null
        : active.step === "apply"
          ? "A deployment was applying; requests already sent to Cloudflare may still complete. Review after reconnecting to see what exists."
          : `A deployment was stopped during ${active.step}; no resource writes had started.`;

    if (active) {
      await this.settled(active.id);
      // Work recorded by an earlier process (queued, or running when it died) is cancelled too.
      const after = await this.deps.store.getOperation(active.id);

      if (after && (after.status === "queued" || after.status === "running")) {
        await this.deps.store.putOperation({
          ...after,
          status: "cancelled",
          updatedAt: this.iso(),
          finishedAt: this.iso(),
          error: {
            step: after.step,
            message: "cancelled by disconnect; its outcome is uncertain",
            nextAction: "Reconnect Cloudflare and review again",
          },
        });
        await this.deps.store.releaseWriter(inst.id, after.id);
      }
    }

    // 3. Revoke at the provider (best effort, reported), refresh token first.
    let revocation = "no stored credentials";

    if (creds) {
      const results = [
        ...(creds.refreshToken
          ? [
              await revokeToken(
                this.deps.oauth,
                creds.refreshToken,
                "refresh_token",
                this.deps.fetch,
              ),
            ]
          : []),
        await revokeToken(this.deps.oauth, creds.accessToken, "access_token", this.deps.fetch),
      ];

      revocation = results.every((r) => r.ok)
        ? "revoked at Cloudflare"
        : `local credentials deleted; provider revocation failed (${results.map((r) => r.detail).join(", ")}); revoke Bye's access in the Cloudflare dashboard`;
    }

    const current = await this.fresh(inst.id);
    await this.deps.store.putInstallation({
      ...current,
      credentials: null,
      authorization: {
        ...current.authorization,
        status: "disconnected",
        disconnect: { at: this.iso(), revocation, inFlight },
      },
    });
    await this.event(
      inst.id,
      "authorization.disconnected",
      `${revocation}${inFlight ? `; ${inFlight}` : ""}`,
    );

    return { revocation, inFlight };
  }

  // ── Status, handoff, guide ───────────────────────────────────────────────────────────────

  async status(operatorId: string): Promise<StatusView> {
    const inst = await this.installation(operatorId);
    const operation = (await this.deps.store.operations(inst.id))[0] ?? null;
    const resolved = this.deps.release.resolve();

    return {
      state: installState(inst, operation, this.installing.has(inst.id)),
      installation: {
        id: inst.id,
        accountId: inst.accountId,
        accountName: inst.accountName,
        zoneId: inst.zoneId ?? null,
        zoneName: inst.zoneName ?? null,
        appHostname: inst.appHostname ?? null,
        ownerAddressDomain: inst.ownerAddressDomain ?? null,
        pendingReviewId: inst.pendingReviewId ?? null,
        stage: inst.stage,
        stateRef: inst.stateRef,
        urls: inst.urls,
        deployedRelease: inst.deployedRelease,
        ready: inst.ready,
        readyAt: inst.readyAt,
        recoveryKitIssuedAt: inst.recoveryKitIssuedAt ?? null,
        pushNotifications: pushEnabled(inst),
      },
      pinnedRelease: resolved.ok
        ? { version: resolved.release.ref.version, commit: resolved.release.ref.commit }
        : null,
      releaseProblem: resolved.ok ? null : resolved.reason,
      authorization: inst.authorization,
      operation,
      progress: operation ? await this.deps.store.recentEvents(inst.id, operation.id, 50) : [],
      prerequisites: PREREQUISITES,
      manualSteps: MANUAL_STEPS,
      whatByeCreates: WHAT_BYE_CREATES,
      handoff: inst.ready && inst.urls ? handoffFor(inst.urls.app) : null,
    };
  }

  async handoff(operatorId: string): Promise<Handoff> {
    const inst = await this.installation(operatorId);

    if (!inst.ready || !inst.urls)
      throw new OnboardingError("not_ready", "the installation is not ready yet");

    return handoffFor(inst.urls.app);
  }

  /**
   * The setup link for the instance's first account (`/#bootstrap=<token>&domain=<zone>`, in a
   * fragment so it never reaches a server log). The instance accepts it once, only while it has
   * no users, and only for an address on BOOTSTRAP_ADDRESS_DOMAIN; `domain` is display input.
   */
  async firstAccountLink(operatorId: string): Promise<{ readonly link: string }> {
    const inst = await this.installation(operatorId);

    if (!inst.ready || !inst.urls || !inst.runtimeSecrets)
      throw new OnboardingError("not_ready", "the installation is not ready yet");

    const token = open<Record<string, string>>(
      this.deps.keys,
      inst.runtimeSecrets,
      inst.id,
    ).BOOTSTRAP_TOKEN;

    if (!token)
      throw new OnboardingError(
        "blocked",
        "this installation predates first-account setup links",
        "Create the first account through OPERATOR_USER_IDS and a reviewed deploy",
      );
    await this.event(inst.id, "first-account.link", "setup link shown to the operator");
    const domain = inst.ownerAddressDomain ?? null;

    return {
      link: `${inst.urls.app}/#bootstrap=${token}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`,
    };
  }

  /**
   * Hands out the recovery kit exactly once: stage, account, state reference, URLs and the
   * generated runtime secrets, so the operator can redeploy without this service. It never holds
   * Cloudflare credentials. Issuance is recorded before the kit is returned.
   */
  async recoveryKit(operatorId: string): Promise<RecoveryKit> {
    const bound = await this.installation(operatorId);

    if (bound.boundAt === null || !bound.runtimeSecrets || !bound.urls || !bound.stateRef)
      throw new OnboardingError("invalid", "choose where Bye should live first");

    if (bound.recoveryKitIssuedAt)
      throw new OnboardingError(
        "conflict",
        `the recovery kit was already issued at ${bound.recoveryKitIssuedAt}`,
        "It is issued only once; use the copy you saved",
      );

    // The kit is issued once, so it must hold every key existing subscriptions depend on. Creating
    // one changes the configuration, so not while a deployment is running or awaiting approval.
    const missingKey = !open<Record<string, string>>(this.deps.keys, bound.runtimeSecrets, bound.id)
      .VAPID_PRIVATE_KEY;

    if (missingKey && (bound.pendingReviewId || (await this.activeOperation(bound.id))))
      throw new OnboardingError(
        "conflict",
        "a deployment is in progress or awaiting approval",
        "Finish or cancel it, then download the recovery kit",
      );

    const inst = await this.completeSecrets(bound);

    const vapidKey = open<Record<string, string>>(
      this.deps.keys,
      inst.runtimeSecrets!,
      inst.id,
    ).VAPID_PRIVATE_KEY!;

    const issuedAt = this.iso();
    await this.deps.store.putInstallation({
      ...(await this.fresh(inst.id)),
      recoveryKitIssuedAt: issuedAt,
    });
    await this.event(
      inst.id,
      "recovery-kit.issued",
      "recovery kit downloaded (contents not logged)",
    );

    return {
      format: "bye.recovery-kit.v1",
      issuedAt,
      installationId: inst.id,
      account: { id: inst.accountId!, name: inst.accountName },
      zone: inst.zoneId && inst.zoneName ? { id: inst.zoneId, name: inst.zoneName } : null,
      appHostname: inst.appHostname ?? null,
      ownerAddressDomain: inst.ownerAddressDomain ?? null,
      stage: inst.stage!,
      stack: "MailboxPlatform",
      state: bound.stateRef,
      release: inst.deployedRelease,
      urls: bound.urls,
      env: {
        STAGE: inst.stage!,
        CLOUDFLARE_ACCOUNT_ID: inst.accountId!,
        STATE_BACKEND: "cloudflare",
        ...this.config(inst),
        // Kept even while push is off (VAPID_PUBLIC_KEY is then empty, so push stays off).
        VAPID_PRIVATE_KEY: vapidKey,
      },
      push: { enabled: pushEnabled(inst), vapidPublicKey: vapidPublicKey(vapidKey) },
      notes: [
        "Store this file like a password: it contains the instance's session, signing and probe secrets.",
        "Keep BYE_WORKERS_DEV_NAME, APP_DOMAIN and every secret unchanged on redeploys; changing the name replaces the Workers and their Durable Object data, and changing SESSION_KEY signs everyone out.",
        'To manage the installation without the onboarding service, deploy the recorded release with these values and a scoped Cloudflare API token (infra/RUNBOOK.md, "Cloudflare deployment token"); follow "Onboarding installations" and "Interrupted deploy" there.',
        "Alchemy state lives in your account (Cloudflare state store); resources and data are unaffected by losing the onboarding service.",
        "Push notifications need both VAPID keys. When `push.enabled` is false, VAPID_PUBLIC_KEY is empty; set it to `push.vapidPublicKey` to turn push on with the same key, so existing devices keep working.",
      ],
    };
  }

  async guide(operatorId: string): Promise<ManualGuide> {
    const inst = await this.installation(operatorId);

    return manualGuide({ stage: inst.stage ?? "prod", appUrl: inst.urls?.app ?? null });
  }
}

/** The native-app handoff carries only the instance's HTTPS URL (OB10). */
export const handoffFor = (url: string): Handoff => {
  if (!/^https:\/\/[^/?#@]+$/.test(url))
    throw new OnboardingError("invalid", "not an HTTPS instance origin");

  return { url, link: addInstanceLink(url), qrSvg: qrSvg(url) };
};
