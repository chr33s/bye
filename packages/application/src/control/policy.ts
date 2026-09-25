import { Context, Effect } from "effect";
import { Forbidden, type PrincipalShape, requireScope, type Unavailable } from "../services.ts";

// Directory, Authorization and SendingPolicy as Effect services (§7.1 "Directory, Authorization and
// Policy are services"). Callers depend on these tags; the platform package provides D1-backed
// layers. Each is built per request/invocation — nothing here caches principals or decisions.

/** Recipient resolution (§5.1 step 1). A directory outage is `TransientFailure`, never a rejection. */
export type DirectoryRoute =
  | {
      readonly _tag: "Deliver";
      readonly mailboxId: string;
      readonly via: "exact" | "plus" | "catch-all";
      readonly plusTag: string | undefined;
    }
  | { readonly _tag: "Forward"; readonly to: string; readonly reason: "closure-forwarding" }
  | {
      readonly _tag: "Rejected";
      readonly reason: "unknown-recipient" | "domain-inactive" | "closed";
    }
  | { readonly _tag: "TransientFailure"; readonly detail: string };

/** Address directory: recipient routing and sender authority (§3.2, §5.1 step 1, §10). */
export class Directory extends Context.Service<
  Directory,
  {
    /** Exact → plus → catch-all; directory outages come back as `TransientFailure`, never a rejection. */
    readonly resolveRecipient: (address: string) => Effect.Effect<DirectoryRoute>;
    /** Whether a user may send as `from` from this mailbox (identity added through the API). */
    readonly canSendAs: (
      userId: string,
      mailboxId: string,
      from: string,
    ) => Effect.Effect<boolean, Unavailable>;
    /** Whether the mailbox itself may send as `from` (dispatch-time revalidation). */
    readonly mailboxMaySendAs: (
      mailboxId: string,
      from: string,
    ) => Effect.Effect<boolean, Unavailable>;
  }
>()("control/Directory") {}

export type OrgRoleName = "owner" | "admin" | "member";

/** Authorization facts that live outside the principal (roles in D1, operator allowlist). */
export class Authorization extends Context.Service<
  Authorization,
  {
    /** The user's active role in an organization, or null when not an active member. */
    readonly orgRole: (
      orgId: string,
      userId: string,
    ) => Effect.Effect<OrgRoleName | null, Unavailable>;
    readonly isOperator: (userId: string) => boolean;
  }
>()("control/Authorization") {}

export interface SendingCheckInput {
  readonly userId: string;
  readonly identity: string;
  readonly recipients: ReadonlyArray<string>;
}

export type SendingDecision =
  | {
      readonly allowed: true;
      readonly suppressed: ReadonlyArray<string>;
      readonly remaining: number;
      /** Recipients already counted against every budget by the (atomic) check. */
      readonly reserved?: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "suspended" | "budget" | "all-suppressed";
      readonly scope?: string;
      readonly retryAfterMs?: number;
      readonly suppressed: ReadonlyArray<string>;
    };

/**
 * Outbound abuse policy: suspensions, suppressions, budgets and ramp (§10). `check` RESERVES the
 * deliverable recipients against every budget atomically when it allows a send, so concurrent
 * dispatches cannot all pass the same remaining budget; `release` hands a reservation back when the
 * send never reached a provider.
 */
export class SendingPolicyService extends Context.Service<
  SendingPolicyService,
  {
    readonly check: (input: SendingCheckInput) => Effect.Effect<SendingDecision, Unavailable>;
    readonly release: (input: {
      readonly userId: string;
      readonly identity: string;
      readonly recipients: number;
    }) => Effect.Effect<void, Unavailable>;
  }
>()("control/SendingPolicy") {}

/**
 * Organization administrator check (O02). The principal must be a member and the D1 role is
 * always re-verified. Billing routes pass scope "read" so a lapsed (read-only) account can still
 * pay or cancel.
 */
export const requireOrgAdminAccess = (orgId: string, scope: "read" | "admin" = "admin") =>
  Effect.gen(function* () {
    const principal = yield* requireScope(scope);
    if (!principal.organizationIds.includes(orgId))
      return yield* new Forbidden({ reason: "not a member of organization" });
    const role = yield* (yield* Authorization).orgRole(orgId, principal.userId);
    if (role !== "owner" && role !== "admin")
      return yield* new Forbidden({ reason: "administrator role required" });
    // The verified role travels with the principal, so nothing downstream re-reads it.
    const access: PrincipalShape & { readonly orgRole: "owner" | "admin" } = {
      ...principal,
      orgRole: role,
    };
    return access;
  });

/** Service operators only (DLQ, restore, erasure, abuse review); requires the admin scope. */
export const requireOperatorAccess = () =>
  Effect.gen(function* () {
    const principal = yield* requireScope("admin");
    if (!(yield* Authorization).isOperator(principal.userId))
      return yield* new Forbidden({ reason: "operator only" });
    return principal;
  });
