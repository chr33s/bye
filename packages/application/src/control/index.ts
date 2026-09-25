import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { Rejection } from "@bye/contracts";
import {
  Conflict,
  DEFAULT_AGENT_SCOPES,
  Forbidden,
  Principal,
  type PrincipalShape,
  type Scope,
  Unavailable,
} from "../services.ts";
import { requireOrgAdminAccess } from "./policy.ts";

// Control-plane use cases (A03, O02, A04, X02). Principals are constructed per request from
// verified credentials; nothing here is memoized across requests (§7.4 Request isolation).

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  reason: Schema.String,
}) {}

export class StepUpRequired extends Schema.TaggedError<StepUpRequired>()("StepUpRequired", {
  action: Schema.String,
}) {}

export type SensitiveAction =
  | "recovery"
  | "new-identity"
  | "forwarding"
  | "sharing"
  | "admin"
  | "credentials"
  | "closure";

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export interface AuthenticatedRequest {
  readonly principal: PrincipalShape;
  /** Session ID for cookie/session credentials; token ID for agent/CLI credentials. */
  readonly credentialId: string;
  readonly steppedUpAt: number | null;
}

/** Per-request authentication state. Provided freshly for every invocation. */
export class CurrentAuthentication extends Context.Service<
  CurrentAuthentication,
  AuthenticatedRequest
>()("app/CurrentAuthentication") {}

/**
 * Credential capability (A03, X02): authenticate a presented credential into per-request state,
 * and mint agent/CLI tokens. Policy (who may mint what, step-up) lives in the use cases below;
 * the port only persists.
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<AuthenticatedRequest, Unauthenticated | Unavailable>;
    readonly createApiToken: (
      userId: string,
      input: {
        readonly kind: "agent" | "cli";
        readonly label: string;
        readonly scopes?: ReadonlyArray<Scope>;
        readonly expiresAt?: number;
      },
    ) => Effect.Effect<
      { readonly id: string; readonly token: string; readonly scopes: ReadonlyArray<Scope> },
      Rejection
    >;
  }
>()("control/Credentials") {}

/** An organization administrator whose role was verified for this request (`requireOrgAdminAccess`). */
export interface OrgActor {
  readonly userId: string;
  readonly role: "owner" | "admin";
}

/** Team-administration capability (O02). Authorization is the caller's; the port only applies. */
export class OrgAdmin extends Context.Service<
  OrgAdmin,
  {
    readonly invite: (
      orgId: string,
      actor: OrgActor,
      address: string,
      role: "admin" | "member",
    ) => Effect.Effect<{ readonly invitationId: string; readonly token: string }, Rejection>;
    readonly setRole: (
      orgId: string,
      actor: OrgActor,
      userId: string,
      role: "owner" | "admin" | "member",
    ) => Effect.Effect<void, Rejection>;
    readonly suspend: (
      orgId: string,
      actor: OrgActor,
      userId: string,
    ) => Effect.Effect<void, Rejection>;
    readonly reactivate: (
      orgId: string,
      actor: OrgActor,
      userId: string,
    ) => Effect.Effect<void, Rejection>;
    readonly remove: (
      orgId: string,
      actor: OrgActor,
      userId: string,
    ) => Effect.Effect<
      { readonly policy: string; readonly mailboxes: ReadonlyArray<string> },
      Rejection
    >;
  }
>()("control/OrgAdmin") {}

/** Account lifecycle capability (A04). */
export class Accounts extends Context.Service<
  Accounts,
  {
    readonly primaryAddress: (userId: string) => Effect.Effect<string, Rejection>;
    readonly close: (
      userId: string,
      input: { readonly reserveAddressDays: number; readonly forwardingDays: number },
    ) => Effect.Effect<{ readonly reserved: ReadonlyArray<string> }, Rejection>;
  }
>()("control/Accounts") {}

export interface RequestCredentials {
  readonly method: string;
  readonly cookieToken: string | undefined;
  readonly bearerToken: string | undefined;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
}

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * THE CSRF/origin rule (§10): a state-changing request authenticated by cookie must carry an
 * Origin matching the application origin, or — when the Origin is absent or the opaque "null"
 * (privacy-sensitive referrer policy) — `Sec-Fetch-Site: same-origin`.
 */
export const checkCsrf = (
  method: string,
  headers: { get(name: string): string | null },
  appOrigin: string,
): boolean => {
  if (SAFE_METHODS.includes(method.toUpperCase())) return true;
  const origin = headers.get("origin");
  if (origin !== null && origin !== "null") return origin === appOrigin;
  return headers.get("sec-fetch-site") === "same-origin";
};

/**
 * Authenticate an HTTP request. Bearer tokens (CLI/agents) are not ambient, so CSRF applies only
 * to cookie-authenticated state changes, which must be same-origin.
 */
export const authenticateRequest = (creds: RequestCredentials, appOrigin: string) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    if (creds.bearerToken) return yield* credentials.authenticate(creds.bearerToken);
    if (!creds.cookieToken) return yield* new Unauthenticated({ reason: "missing credential" });
    const headers = {
      get: (name: string) =>
        name === "origin" ? creds.origin : name === "sec-fetch-site" ? creds.secFetchSite : null,
    };
    if (!checkCsrf(creds.method, headers, appOrigin))
      return yield* new Forbidden({ reason: "cross-origin request rejected" });
    return yield* credentials.authenticate(creds.cookieToken);
  }).pipe(Effect.withSpan("control.authenticate"));

/** Per-request layer providing both the principal and the authentication state. */
export const requestAuthLayer = (auth: AuthenticatedRequest) =>
  Layer.merge(Layer.succeed(Principal, auth.principal), Layer.succeed(CurrentAuthentication, auth));

export const requireStepUp = (action: SensitiveAction) =>
  Effect.gen(function* () {
    const auth = yield* CurrentAuthentication;
    const now = yield* Clock.currentTimeMillis;
    if (auth.principal.kind !== "user")
      return yield* new Forbidden({ reason: `${action} requires an interactive session` });
    if (auth.steppedUpAt === null || now - auth.steppedUpAt > STEP_UP_WINDOW_MS)
      return yield* new StepUpRequired({ action });
    return auth;
  });

/** Agents and CLIs cannot mint credentials; consequential scopes need a recent step-up (§8). */
export const issueApiToken = (input: {
  readonly kind: "agent" | "cli";
  readonly label: string;
  readonly scopes?: ReadonlyArray<Scope>;
  readonly expiresAt?: number;
}) =>
  Effect.gen(function* () {
    const auth = yield* CurrentAuthentication;
    if (auth.principal.kind !== "user")
      return yield* new Forbidden({ reason: "only interactive sessions create credentials" });
    const scopes =
      input.scopes ??
      (input.kind === "agent" ? DEFAULT_AGENT_SCOPES : (["read", "draft"] as const));
    if (scopes.some((s) => s !== "read" && s !== "draft")) yield* requireStepUp("credentials");
    return yield* (yield* Credentials).createApiToken(auth.principal.userId, { ...input, scopes });
  }).pipe(Effect.withSpan("control.issueApiToken"));

/**
 * Every team-administration mutation takes the same path (O02): one verified admin role read,
 * a recent step-up, then the capability. The platform adapter no longer re-checks the role.
 */
const administer = <A, E, R>(orgId: string, apply: (actor: OrgActor) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const access = yield* requireOrgAdminAccess(orgId);
    yield* requireStepUp("admin");
    return yield* apply({ userId: access.userId, role: access.orgRole });
  });

export const inviteTeamMember = (orgId: string, address: string, role: "admin" | "member") =>
  administer(orgId, (actor) => OrgAdmin.use((admin) => admin.invite(orgId, actor, address, role)));

export const setTeamMemberRole = (
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) =>
  administer(orgId, (actor) => OrgAdmin.use((admin) => admin.setRole(orgId, actor, userId, role)));

export const suspendTeamMember = (orgId: string, userId: string) =>
  administer(orgId, (actor) => OrgAdmin.use((admin) => admin.suspend(orgId, actor, userId)));

export const reactivateTeamMember = (orgId: string, userId: string) =>
  administer(orgId, (actor) => OrgAdmin.use((admin) => admin.reactivate(orgId, actor, userId)));

export const removeTeamMember = (orgId: string, userId: string) =>
  administer(orgId, (actor) => OrgAdmin.use((admin) => admin.remove(orgId, actor, userId)));

/** Account closure: step-up, explicit address confirmation, distinct from cancellation. */
export const closeOwnAccount = (input: {
  readonly confirmAddress: string;
  readonly reserveAddressDays: number;
  readonly forwardingDays: number;
}) =>
  Effect.gen(function* () {
    const auth = yield* requireStepUp("closure");
    const accounts = yield* Accounts;
    const address = yield* accounts.primaryAddress(auth.principal.userId);
    if (address !== input.confirmAddress.trim().toLowerCase())
      return yield* new Conflict({ reason: "confirmation address does not match" });
    return yield* accounts.close(auth.principal.userId, {
      reserveAddressDays: input.reserveAddressDays,
      forwardingDays: input.forwardingDays,
    });
  });

export * from "./policy.ts";
