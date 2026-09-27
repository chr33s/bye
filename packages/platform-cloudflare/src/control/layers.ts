import { isRejection, type Rejection, reject } from "../durable/rpc.ts";
import {
  Accounts,
  type AuthenticatedRequest,
  Authorization,
  Credentials,
  Directory,
  OrgAdmin,
  SendingPolicyService,
  type SharedFailure,
  SharedSpaces,
  Unauthenticated,
  Unavailable,
  WorldPublishing,
} from "@bye/application";
import { Context, Effect, Layer } from "effect";
import type { SharedSpaceStore } from "../shared/space.ts";
import type { WorldStore } from "../shared/world.ts";
import type { ControlAuth } from "./auth.ts";
import type { ControlBilling, ControlLifecycle } from "./billing.ts";
import type { ControlCommerce } from "./commerce.ts";
import type { ControlDirectory } from "./directory.ts";
import type { ControlDomains } from "./domains.ts";
import type { ControlOrganizations } from "./orgs.ts";
import type { ControlSharedRegistry } from "./registry.ts";
import type { SendingPolicy } from "./sending.ts";
import type { ControlSupport } from "./support.ts";
import { type D1Like, primary, q } from "./d1.ts";

// The control plane as Effect services (§7.1). Each capability is ONE service, built from its
// Promise-based D1 adapter by the one generic `lift`: a `Rejection` becomes the expected failure;
// anything else stays a defect (never relabelled). Application use cases depend on the narrow
// ports they own (`Credentials`, `OrgAdmin`, `Accounts`, `Directory`, `Authorization`,
// `SendingPolicyService`); the Worker's HTTP routes use the lifted capability services below.
// Everything is built once per request from one set of adapter instances (`controlLayer`).

/** Every Promise-returning method of an adapter, as an Effect failing with `Rejection`. */
export type Lifted<C> = {
  readonly [
    K in keyof C as C[K] extends (...args: never) => Promise<unknown> ? K : never
  ]: C[K] extends (...args: infer P) => Promise<infer R>
    ? (...args: P) => Effect.Effect<R, Rejection>
    : never;
};

/** Run a Promise-based adapter call: a Rejection fails expectedly; anything else is a defect. */
export const attempt = <A>(fn: () => Promise<A>): Effect.Effect<A, Rejection> =>
  Effect.tryPromise({ try: fn, catch: (e) => e }).pipe(
    Effect.catch((e) => (isRejection(e) ? Effect.fail(e) : Effect.die(e))),
  );

/** Lift an adapter instance's methods (walking its prototype chain) into Effects. */
export const lift = <C extends object>(instance: C): Lifted<C> => {
  const out: Record<string, unknown> = {};
  for (
    let proto = Object.getPrototypeOf(instance);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const method = (instance as Record<string, unknown>)[key];
      if (key === "constructor" || key in out || typeof method !== "function") continue;
      out[key] = (...args: Array<unknown>) =>
        attempt(async () => (method as (...a: Array<unknown>) => unknown).apply(instance, args));
    }
  }
  return out as Lifted<C>;
};

// ---- capability services used by the Worker's routes ----
export class AuthService extends Context.Service<AuthService, Lifted<ControlAuth>>()(
  "control/Auth",
) {}
export class OrgsService extends Context.Service<OrgsService, Lifted<ControlOrganizations>>()(
  "control/Orgs",
) {}
export class DomainsService extends Context.Service<DomainsService, Lifted<ControlDomains>>()(
  "control/Domains",
) {}
export class BillingService extends Context.Service<BillingService, Lifted<ControlBilling>>()(
  "control/Billing",
) {}
export class CommerceService extends Context.Service<CommerceService, Lifted<ControlCommerce>>()(
  "control/Commerce",
) {}
export class LifecycleService extends Context.Service<LifecycleService, Lifted<ControlLifecycle>>()(
  "control/Lifecycle",
) {}
export class SendingService extends Context.Service<SendingService, Lifted<SendingPolicy>>()(
  "control/Sending",
) {}
export class SupportService extends Context.Service<SupportService, Lifted<ControlSupport>>()(
  "control/Support",
) {}
export class RegistryService extends Context.Service<
  RegistryService,
  Lifted<ControlSharedRegistry>
>()("control/Registry") {}

/** One request's adapter instances; every service below shares them (built once). */
export interface ControlAdapters {
  readonly db: D1Like;
  readonly auth: ControlAuth;
  readonly directory: ControlDirectory;
  readonly orgs: ControlOrganizations;
  readonly lifecycle: ControlLifecycle;
  readonly commerce: ControlCommerce;
  readonly billing: ControlBilling;
  readonly domains: ControlDomains;
  readonly sending: SendingPolicy;
  readonly support: ControlSupport;
  readonly registry: ControlSharedRegistry;
  /** Platform operator user IDs (environment configuration). */
  readonly operators: ReadonlyArray<string>;
}

const unavailable = (detail: string) => () => new Unavailable({ dependency: "d1", detail });

/** Authenticate a presented credential into the per-request authentication state. */
const authenticateWith = (auth: ControlAuth) => (token: string) =>
  attempt(async (): Promise<AuthenticatedRequest> => {
    const cred = await auth.authenticate(token);
    const principal = await auth.principal(cred);
    return {
      principal,
      credentialId: principal.sessionId,
      steppedUpAt: cred.kind === "session" ? cred.session.step_up_at : null,
      interactive: cred.kind === "session",
    };
  }).pipe(
    Effect.catch((e) =>
      Effect.fail(
        e.code === "unavailable"
          ? new Unavailable({ dependency: "d1", detail: e.message })
          : new Unauthenticated({
              reason: e.code === "unauthenticated" ? e.message : "invalid credential",
            }),
      ),
    ),
  );

/** The policy services (Directory, Authorization, SendingPolicy); also used alone by non-HTTP callers (dispatch). */
export const policyServicesLayer = (
  a: Pick<ControlAdapters, "directory" | "orgs" | "sending" | "operators">,
) =>
  Layer.mergeAll(
    Layer.succeed(Directory, {
      resolveRecipient: (address) => Effect.promise(() => a.directory.resolveRecipient(address)),
      canSendAs: (userId, mailboxId, from) =>
        Effect.tryPromise({
          try: () => a.directory.canSendAs(userId, mailboxId, from),
          catch: unavailable("canSendAs"),
        }),
      mailboxMaySendAs: (mailboxId, from) =>
        Effect.tryPromise({
          try: () => a.directory.mailboxMaySendAs(mailboxId, from),
          catch: unavailable("mailboxMaySendAs"),
        }),
    }),
    Layer.succeed(Authorization, {
      orgRole: (orgId, userId) =>
        Effect.tryPromise({
          try: () => a.orgs.membership(orgId, userId),
          catch: unavailable("orgRole"),
        }).pipe(Effect.map((m) => (m && m.status === "active" ? m.role : null))),
      isOperator: (userId) => a.operators.includes(userId),
    }),
    Layer.succeed(SendingPolicyService, {
      check: (input) =>
        Effect.tryPromise({
          try: () => a.sending.reserve(input),
          catch: unavailable("sending.check"),
        }),
      release: (input) =>
        Effect.tryPromise({
          try: () => a.sending.release(input),
          catch: unavailable("sending.release"),
        }),
    }),
  );

/** Every control-plane service for one request, from one set of adapter instances. */
export const controlServicesLayer = (a: ControlAdapters) => {
  const orgs = lift(a.orgs);
  const lifecycle = lift(a.lifecycle);
  return Layer.mergeAll(
    // Application ports.
    Layer.succeed(Credentials, {
      authenticate: authenticateWith(a.auth),
      createApiToken: (userId, input) => attempt(() => a.auth.createApiToken(userId, input)),
    }),
    Layer.succeed(OrgAdmin, {
      invite: orgs.invite,
      setRole: orgs.setRole,
      suspend: orgs.suspend,
      reactivate: orgs.reactivate,
      remove: orgs.remove,
    }),
    Layer.succeed(Accounts, {
      primaryAddress: (userId) =>
        attempt(async () => {
          const u = await q(
            primary(a.db),
            "SELECT primary_address FROM users WHERE id = ?",
            userId,
          ).first<{ primary_address: string }>();
          return u ? u.primary_address : reject("not_found", "user");
        }),
      close: lifecycle.closeAccount,
    }),
    policyServicesLayer(a),
    // Route-facing capability services.
    Layer.succeed(AuthService, lift(a.auth)),
    Layer.succeed(OrgsService, orgs),
    Layer.succeed(DomainsService, lift(a.domains)),
    Layer.succeed(BillingService, lift(a.billing)),
    Layer.succeed(CommerceService, lift(a.commerce)),
    Layer.succeed(LifecycleService, lifecycle),
    Layer.succeed(SendingService, lift(a.sending)),
    Layer.succeed(SupportService, lift(a.support)),
    Layer.succeed(RegistryService, lift(a.registry)),
  );
};

/** Every service `controlServicesLayer` provides (for request-layer typing). */
export type ControlServices = Layer.Success<ReturnType<typeof controlServicesLayer>>;

const toSharedFailure = (e: unknown): SharedFailure => {
  if (isRejection(e)) return e;
  throw e;
};

const sync = <A>(fn: () => A) => Effect.try({ try: fn, catch: toSharedFailure });
const promise = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: toSharedFailure });

/** In-authority implementation (inside SharedSpaceDO RPC handlers, or tests with local stores). */
export const makeLocalSharedSpaces = (
  resolve: (spaceId: string) => SharedSpaceStore,
): typeof SharedSpaces.Service => ({
  shareThread: (spaceId, input) => sync(() => resolve(spaceId).shareThread(input)),
  revokeGrant: (spaceId, actorId, grantId) => sync(() => resolve(spaceId).revoke(actorId, grantId)),
  createPublicLink: (spaceId, actorId, threadId, options) =>
    promise(() => resolve(spaceId).createPublicLink(actorId, threadId, options)),
  resolvePublicLink: (spaceId, token) => promise(() => resolve(spaceId).resolvePublicLink(token)),
});

/**
 * In-authority publish (tests, local stores). Like the Worker pipeline, the adapter itself performs
 * the selected media copies after the commit (`copy`); the use case never copies content.
 */
export const makeLocalWorldPublishing = (
  resolve: (authorId: string) => WorldStore,
  copy: (from: string, to: string) => void = () => undefined,
): typeof WorldPublishing.Service => ({
  publish: (authorId, op) =>
    sync(() => {
      const result = resolve(authorId).publishFromMail(op);
      if ("copies" in result) for (const c of result.copies) copy(c.from, c.to);
      return { postId: result.postId, revision: result.revision };
    }),
});
