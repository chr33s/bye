import { Effect, Layer } from "effect";
import { isRejection } from "@bye/platform-cloudflare";
import { settle, sharedMessageOf, space } from "./authorities.ts";
import {
  CalendarDiscovery,
  MailboxFacts,
  MailboxSelection,
  NotFound,
  type SharedFailure,
  SharedSpaces,
  Unavailable,
} from "@bye/application";
import {
  type AuthConfig,
  ControlAuth,
  ControlBilling,
  ControlCommerce,
  ControlDirectory,
  ControlDomains,
  ControlSharedRegistry,
  ControlSupport,
  httpBillingProvider,
  SendingPolicy,
  type ControlAdapters,
  controlServicesLayer,
  policyServicesLayer,
  ControlLifecycle,
  ControlOrganizations,
  RpcMailboxRepositoryLive,
  calendarRepositoryRpc,
  parseSecretRing,
  type VersionedKeys,
} from "@bye/platform-cloudflare";
import { kernelClock } from "./durable-host.ts";
import type { CoreEnv } from "./env.ts";
import { bootstrapOperatorIds } from "./bootstrap.ts";

// Worker-side implementations of application services over native bindings. Built per
// invocation from `env`; nothing request-scoped (principal, credentials) is cached here (§7.4).
//
// The control plane is one set of D1 adapter instances per request (`controlAdapters`), exposed
// as Effect services by `controlLayer`:
//   - application ports (`Credentials`, `OrgAdmin`, `Accounts`, `Directory`, `Authorization`,
//     `SendingPolicyService`) that use cases depend on, and
//   - one lifted capability service per adapter (`OrgsService`, `DomainsService`, …) for routes.
// Authorization happens once, in the application (use cases / `requireOrgAdminAccess`).
// Direct adapter use is limited to code that runs before or outside a request Effect: the
// pre-principal auth routes (sign-up, passkey ceremonies, OAuth), Durable Objects, the scheduled
// handler and provider webhooks.

/** An authority call as a shared use-case Effect: refusals stay `Rejection`s, transport is `Unavailable`. */
const authorityCall = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, SharedFailure> =>
  Effect.tryPromise({
    try: f,
    catch: (e) =>
      isRejection(e) ? e : new Unavailable({ dependency: "durable-object", detail: op }),
  });

const deriveHkdf = async (secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> => {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    base,
    256,
  );
  return new Uint8Array(bits);
};

// A request builds control adapters more than once (authentication layer, then the route), so
// derivations are memoized per isolate. Keyed by the secret and info: a rotated secret (new
// deployment/env) derives afresh.
const hkdfCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const hkdfKey = (secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> => {
  const key = `${info}\u0000${secret}`;
  let derived = hkdfCache.get(key);
  if (!derived) {
    derived = deriveHkdf(secret, info);
    derived.catch(() => hkdfCache.delete(key));
    hkdfCache.set(key, derived);
  }
  return derived;
};

/**
 * TOTP sealing keys, one per SESSION_KEY ring version (`v2:<key>,v1:<key>`; a plain key is v1).
 * Version n is HKDF(secret_n, "totp-seal-v<n>"), so v1 is exactly the pre-ring derivation and
 * existing seals keep opening. New seals use the ring's current version; `rotateTotpKeys`
 * re-seals the rest before an old version is retired.
 */
const totpKeys = async (sessionKey: string): Promise<VersionedKeys> => {
  const ring = parseSecretRing(sessionKey);
  const keys: Record<number, Uint8Array<ArrayBuffer>> = {};
  for (const [version, secret] of Object.entries(ring.secrets))
    keys[Number(version)] = await hkdfKey(secret, `totp-seal-v${version}`);
  return { current: ring.current, keys };
};

export const authConfig = async (env: CoreEnv): Promise<AuthConfig> => {
  const origin = new URL(env.APP_ORIGIN);
  return {
    rp: { rpId: origin.hostname, origins: [env.APP_ORIGIN], requireUserVerification: true },
    totpKeys: await totpKeys(env.SESSION_KEY),
    // Recovery hashes record the ring version they were made under (control/auth.ts).
    recoveryPepper: parseSecretRing(env.SESSION_KEY),
  };
};

/** One request's control-plane adapter instances (built once; every control service shares them). */
export const controlAdapters = async (env: CoreEnv): Promise<ControlAdapters> => {
  const db = env.DIRECTORY;
  return {
    db,
    auth: new ControlAuth(db, kernelClock, await authConfig(env)),
    directory: new ControlDirectory(db, kernelClock),
    orgs: new ControlOrganizations(db, kernelClock),
    lifecycle: new ControlLifecycle(db, kernelClock, env.SESSION_KEY),
    ...controlServices(env),
    operators: await allOperatorIds(env),
  };
};

/** Control-plane adapters that need no auth configuration (billing, sending policy, support, registry). */
export const controlServices = (env: CoreEnv) => {
  const db = env.DIRECTORY;
  const provider =
    env.BILLING_CHECKOUT_URL && env.BILLING_API_KEY
      ? httpBillingProvider(env.BILLING_CHECKOUT_URL, env.BILLING_API_KEY, (u, i) => fetch(u, i))
      : null;
  const commerce = new ControlCommerce(db, kernelClock, provider, env.SESSION_KEY);
  return {
    commerce,
    billing: new ControlBilling(db, kernelClock, commerce),
    domains: new ControlDomains(db, kernelClock),
    sending: new SendingPolicy(db, kernelClock),
    support: new ControlSupport(db, kernelClock),
    registry: new ControlSharedRegistry(db, kernelClock),
  };
};

export const mailboxRepositoryLayer = (env: CoreEnv) =>
  RpcMailboxRepositoryLive((mailboxId) => env.MAILBOXES.getByName(mailboxId));

/** The calendar authority over RPC (§3.2). */
export const calendarRepositoryLayer = (env: CoreEnv) =>
  calendarRepositoryRpc((spaceId) => env.CALENDARS.getByName(spaceId));

/** The D1 grant index: spaces that shared calendars with a user (C05); authorities re-check grants. */
export const calendarDiscoveryLayer = (env: CoreEnv) =>
  Layer.succeed(CalendarDiscovery, {
    sharedSpaces: (userId) =>
      Effect.promise(() =>
        env.DIRECTORY.withSession("first-primary")
          .prepare(
            "SELECT DISTINCT space_id FROM calendar_grants WHERE grantee_user_id = ? ORDER BY space_id",
          )
          .bind(userId)
          .all<{ space_id: string }>(),
      ).pipe(Effect.map((r) => r.results.map((row) => row.space_id))),
  });

export const sharedLayers = (env: CoreEnv) =>
  Layer.mergeAll(
    Layer.succeed(SharedSpaces, {
      shareThread: (spaceId, input) =>
        authorityCall("shareThread", () => settle(space(env, spaceId).shareThread(input))),
      revokeGrant: (spaceId, actorId, grantId) =>
        authorityCall("revoke", () => settle(space(env, spaceId).revoke(actorId, grantId))),
      createPublicLink: (spaceId, actorId, threadId, options) =>
        authorityCall("createPublicLink", () =>
          settle(space(env, spaceId).createPublicLink(actorId, threadId, options)),
        ),
      resolvePublicLink: (spaceId, token) =>
        authorityCall("resolvePublicLink", () =>
          settle(space(env, spaceId).resolvePublicLink(token)),
        ),
    }),
    Layer.succeed(MailboxSelection, {
      selectMessages: (mailboxId, threadId, refs) =>
        Effect.flatMap(
          authorityCall("selectMessages", () => sharedMessageOf(env, mailboxId, threadId, refs)),
          (selected) =>
            selected ? Effect.succeed(selected) : Effect.fail(new NotFound({ resource: "thread" })),
        ),
    }),
  );

/** Mailbox facts the command guards read (redelivery source quarantine and scan state). */
export const mailboxFactsLayer = (env: CoreEnv) =>
  Layer.succeed(MailboxFacts, {
    redeliverySource: (mailboxId, deliveryId) =>
      Effect.tryPromise({
        try: async () => {
          const stub = env.MAILBOXES.getByName(mailboxId);
          const source = await stub.delivery(deliveryId);
          if (!source) return null;
          const scan = await stub.attachmentAccess(deliveryId);
          return {
            quarantined: source.routing.decidedBy === "safety",
            scan: { allowed: scan.allowed, status: scan.status },
          };
        },
        catch: () => new Unavailable({ dependency: "mailbox", detail: "redelivery source" }),
      }),
  });

/** Every control-plane service for one request, from one set of adapters. */
export const controlLayer = async (env: CoreEnv) =>
  controlServicesLayer(await controlAdapters(env));

/** Platform operators (abuse review, support sessions, credits), configured per environment: the one parser. */
export const operatorIds = (env: Pick<CoreEnv, "OPERATOR_USER_IDS">): ReadonlyArray<string> =>
  (env.OPERATOR_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Configured operators plus the one created by first-account bootstrap (bootstrap.ts): the one list. */
export const allOperatorIds = async (env: CoreEnv): Promise<ReadonlyArray<string>> => [
  ...operatorIds(env),
  ...(await bootstrapOperatorIds(env)),
];

/**
 * Directory, Authorization and SendingPolicy alone, for non-HTTP callers (inbound resolution, the
 * dispatch claim). Same operator list as request handling.
 */
export const policyLayers = async (env: CoreEnv) =>
  policyServicesLayer({
    directory: new ControlDirectory(env.DIRECTORY, kernelClock),
    orgs: new ControlOrganizations(env.DIRECTORY, kernelClock),
    sending: new SendingPolicy(env.DIRECTORY, kernelClock),
    operators: await allOperatorIds(env),
  });
