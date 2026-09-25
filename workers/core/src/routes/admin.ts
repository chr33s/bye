// Administration and lifecycle routes (O01, O02, A01, A02, A04, §10 operator tooling, device sessions).
import { Effect } from "effect";
import {
  closeOwnAccount,
  Forbidden,
  inviteTeamMember,
  NotFound,
  reactivateTeamMember,
  removeTeamMember,
  requireOperatorAccess,
  requireOrgAdminAccess,
  requireScope,
  requireStepUp,
  setTeamMemberRole,
  suspendTeamMember,
} from "@bye/application";
import {
  AcceptInvitationRequest,
  ApiError,
  CancelSubscriptionRequest,
  CheckoutRequest,
  CloseAccountRequest,
  CreateExtensionRequest,
  CreateOrganizationRequest,
  CreditRequest,
  DomainAliasRequest,
  DomainRequest,
  DomainSettingsRequest,
  InviteMemberRequest,
  MembershipSuspendRequest,
  SetRoleRequest,
  SetSeatLimitRequest,
  SignalReviewRequest,
  SupportSessionRequest,
  SuppressionRequest,
  SuspensionRequest,
  ZoneAuthorizationRequest,
} from "@bye/contracts";
import {
  BillingService,
  CommerceService,
  ControlDeviceAuth,
  DomainOnboarding,
  DomainsService,
  entitlementState,
  LifecycleService,
  OrgsService,
  PLAN_CATALOG,
  RegistryService,
  SendingService,
  type SendingScope,
  SupportService,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, route, type Route } from "../http.ts";
import { sendSystemEmail } from "../publishing.ts";
import { onboardingDeps, type ZoneAuthorizationMethod } from "../workflows/domain.ts";
import {
  authed,
  authedBody,
  closeLiveSockets,
  ctl,
  personalOrgOf,
  requireUser,
  rpcResult,
  signDownload,
  verifyDownload,
} from "./common.ts";

// Authorization goes through the Authorization service (§7.1), provided by the request layer:
// the D1 role and the operator allowlist are facts of the service, not of this module.

/** The verified administrator an org mutation takes (role read once, by `requireOrgAdminAccess`). */
const actorOf = (access: { readonly userId: string; readonly orgRole: "owner" | "admin" }) => ({
  userId: access.userId,
  role: access.orgRole,
});

const EXPORT_LINK_TTL_MS = 15 * 60_000;
const SENDING_SCOPES: ReadonlyArray<SendingScope> = ["user", "domain", "identity", "platform"];

const badRequest = (message: string) => Effect.fail(new ApiError({ code: "bad_request", message }));

/** A domain the caller administers (organization admin of the domain's org). */
const adminDomain = (domainId: string) =>
  Effect.gen(function* () {
    const domains = yield* DomainsService;
    const d = yield* domains.get(domainId);
    const principal = yield* requireOrgAdminAccess(d.org_id);
    return { domain: d, principal, domains };
  });

const verificationRecord = (domain: {
  readonly name: string;
  readonly verification_token: string;
}) => ({
  type: "TXT",
  name: `_bye-verification.${domain.name}`,
  content: `bye-verification=${domain.verification_token}`,
});

/** The org a billing request targets: the one named, else the caller's personal org. */
const billingOrgId = (env: CoreEnv, requested: string | undefined, userId: string) =>
  requested
    ? Effect.succeed(requested)
    : Effect.promise(() => personalOrgOf(env, userId)).pipe(Effect.map((id) => id || ""));

/** Current onboarding Workflow instance for a domain (retries replace it). */
const domainWorkflow = (env: CoreEnv, domainId: string) =>
  Effect.promise(() =>
    env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT workflow_instance FROM domains WHERE id = ?")
      .bind(domainId)
      .first<{ workflow_instance: string | null }>(),
  ).pipe(Effect.map((r) => r?.workflow_instance ?? `dom-${domainId}`));

const setDomainWorkflow = (env: CoreEnv, domainId: string, instanceId: string) =>
  Effect.promise(() =>
    env.DIRECTORY.prepare("UPDATE domains SET workflow_instance = ? WHERE id = ?")
      .bind(instanceId, domainId)
      .run(),
  ).pipe(Effect.asVoid);

export const adminRoutes: ReadonlyArray<Route<CoreEnv>> = [
  // ---- organizations and team administration (A01, O02) ----
  route(
    "POST",
    "/v1/orgs",
    authedBody(
      CreateOrganizationRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const principal = yield* requireUser("admin");
          yield* requireStepUp("admin");
          const kind = body.kind;
          const name = body.name.trim().slice(0, 120);
          if (!name) return yield* badRequest("name required");
          const seatLimit = body.seatLimit ?? (kind === "family" ? 6 : 5);
          const orgs = yield* OrgsService;
          const id = yield* orgs.createOrganization(principal.userId, {
            name,
            kind,
            seatLimit,
            ...(body.reassignmentPolicy ? { reassignmentPolicy: body.reassignmentPolicy } : {}),
          });
          return { id, kind, name, seatLimit };
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/orgs/:orgId",
    authed(({ params }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const orgs = yield* OrgsService;
        const billing = yield* BillingService;
        const org = yield* orgs.organization(params.orgId!, principal.userId);
        const ent = yield* billing.entitlement(params.orgId!);
        return {
          ...org,
          entitlement: ent
            ? {
                plan: ent.plan,
                status: ent.status,
                state: entitlementState(ent, Date.now()),
                seats: ent.seats,
                periodEnd: ent.period_end,
                trialEndsAt: ent.trial_ends_at,
              }
            : null,
        };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/orgs/:orgId/members",
    authed(({ params }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const orgs = yield* OrgsService;
        return { items: yield* orgs.members(params.orgId!, principal.userId) };
      }),
    ),
  ),
  route(
    "PATCH",
    "/v1/orgs/:orgId/members/:userId",
    authedBody(SetRoleRequest, ({ params, body }) =>
      Effect.gen(function* () {
        const role = body.role;
        yield* setTeamMemberRole(params.orgId!, params.userId!, role);
        return { userId: params.userId, role };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/orgs/:orgId/members/:userId/suspend",
    authed(({ params }) => suspendTeamMember(params.orgId!, params.userId!)),
  ),
  route(
    "POST",
    "/v1/orgs/:orgId/members/:userId/reactivate",
    authed(({ params }) =>
      Effect.map(reactivateTeamMember(params.orgId!, params.userId!), () => ({
        userId: params.userId,
        status: "active",
      })),
    ),
  ),
  route(
    "DELETE",
    "/v1/orgs/:orgId/members/:userId",
    authed(({ params }) => removeTeamMember(params.orgId!, params.userId!)),
  ),
  route(
    "GET",
    "/v1/orgs/:orgId/seats",
    authed(({ params }) =>
      Effect.gen(function* () {
        yield* requireOrgAdminAccess(params.orgId!);
        const orgs = yield* OrgsService;
        return yield* orgs.seats(params.orgId!);
      }),
    ),
  ),
  route(
    "PUT",
    "/v1/orgs/:orgId/seats",
    authedBody(SetSeatLimitRequest, ({ params, body }) =>
      Effect.gen(function* () {
        const principal = yield* requireOrgAdminAccess(params.orgId!);
        yield* requireStepUp("admin");
        const orgs = yield* OrgsService;
        return yield* orgs.setSeatLimit(params.orgId!, actorOf(principal), body.limit);
      }),
    ),
  ),
  route(
    "GET",
    "/v1/orgs/:orgId/audit",
    authed(({ params, url }) =>
      Effect.gen(function* () {
        yield* requireOrgAdminAccess(params.orgId!);
        const orgs = yield* OrgsService;
        const limit = Math.min(
          500,
          Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100),
        );
        return { items: yield* orgs.auditLog(params.orgId!, limit) };
      }),
    ),
  ),
  // Invitations: the admin invites (step-up); the invitee accepts from their own account.
  route(
    "POST",
    "/v1/orgs/:orgId/invitations",
    authedBody(
      InviteMemberRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const address = body.address.trim().toLowerCase();
          const result = yield* inviteTeamMember(params.orgId!, address, body.role ?? "member");
          const link = `${env.APP_ORIGIN}/invite?token=${encodeURIComponent(result.token)}`;
          yield* Effect.promise(() =>
            sendSystemEmail(env, {
              to: address,
              subject: "You're invited to join an organization",
              text: `Accept the invitation (valid 7 days):\n${link}\n`,
            }).catch(() => undefined),
          );
          return result;
        }),
      { status: 201 },
    ),
  ),
  route(
    "POST",
    "/v1/invitations/accept",
    authedBody(AcceptInvitationRequest, ({ body }) =>
      Effect.gen(function* () {
        const principal = yield* requireUser();
        const orgs = yield* OrgsService;
        return yield* orgs.acceptInvitation(body.token, principal.userId);
      }),
    ),
  ),
  // Legacy paths kept for existing clients.
  route(
    "POST",
    "/v1/memberships/:orgId/invite",
    authedBody(
      InviteMemberRequest,
      ({ params, body }) => inviteTeamMember(params.orgId!, body.address, body.role ?? "member"),
      { status: 201 },
    ),
  ),
  route(
    "POST",
    "/v1/memberships/:orgId/suspend",
    authedBody(MembershipSuspendRequest, ({ params, body }) =>
      suspendTeamMember(params.orgId!, body.userId),
    ),
  ),

  // Extension (shared-address) mailboxes backed by a shared space (O03).
  route(
    "POST",
    "/v1/orgs/:orgId/extensions",
    authedBody(
      CreateExtensionRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const orgId = params.orgId!;
          const principal = yield* requireOrgAdminAccess(orgId);
          yield* requireStepUp("admin");
          const orgs = yield* OrgsService;
          const domains = yield* DomainsService;
          const registry = yield* RegistryService;
          const domain = yield* domains.get(body.domainId);
          if (domain.org_id !== orgId)
            return yield* new Forbidden({ reason: "domain belongs to another organization" });
          const memberIds = body.memberIds ?? [];
          const members = yield* orgs.members(orgId, principal.userId);
          if (memberIds.some((m) => !members.some((x) => x.userId === m && x.status === "active")))
            return yield* badRequest("extension members must be active organization members");
          const mailboxId = yield* orgs.createExtensionMailbox(
            orgId,
            actorOf(principal),
            memberIds,
          );
          const { address } = yield* domains.addAlias(domain.id, principal.userId, {
            localPart: body.localPart,
            mailboxId,
            kind: "extension",
          });
          const spaceId = `ext_${mailboxId}`;
          const space = env.SHARED_SPACES.getByName(`space:${spaceId}`);
          yield* rpcResult(
            () =>
              space.initSpace({
                spaceId,
                kind: "extension",
                organizationId: orgId,
                ownerId: principal.userId,
              }) as Promise<unknown>,
          );
          for (const m of memberIds)
            if (m !== principal.userId)
              yield* rpcResult(
                () => space.setMember(principal.userId, m, "member") as Promise<unknown>,
              );
          const sendAs = body.sendAs ?? true;
          yield* rpcResult(
            () =>
              space.configureExtension(principal.userId, {
                address,
                displayName: body.displayName || address,
                sendAs,
                ...(body.workflowBoard ? { workflowBoard: body.workflowBoard } : {}),
                ...(body.workflowStage ? { workflowStage: body.workflowStage } : {}),
              }) as Promise<unknown>,
          );
          yield* registry.registerSpace(spaceId, orgId, "extension", principal.userId);
          yield* registry.registerExtension(mailboxId, spaceId, address);
          return { mailboxId, spaceId, address };
        }),
      { status: 201 },
    ),
  ),

  // ---- customer domains (O01) ----
  route(
    "POST",
    "/v1/domains",
    authedBody(
      DomainRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          const orgId = body.orgId;
          // Only organization admins, with a recent step-up, may claim a domain (O01/O02).
          const principal = yield* requireOrgAdminAccess(orgId);
          yield* requireStepUp("admin");
          const domains = yield* DomainsService;
          const row = yield* domains.request(orgId, principal.userId, body.name);
          // Resumable onboarding runs as a Workflow; status is read from the domain resource.
          yield* Effect.promise(() =>
            env.PROVISION_DOMAIN.create({
              id: `dom-${row.id}`,
              params: { v: 1, domainId: row.id, actorId: principal.userId },
            }).catch(() => undefined),
          );
          yield* setDomainWorkflow(env, row.id, `dom-${row.id}`);
          return {
            ...row,
            verificationRecord: verificationRecord(row),
          };
        }),
      { status: 202 },
    ),
  ),
  route(
    "GET",
    "/v1/orgs/:orgId/domains",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        if (!principal.organizationIds.includes(params.orgId!))
          return yield* new Forbidden({ reason: "not a member of organization" });
        const rows = yield* ctl(() =>
          env.DIRECTORY.withSession("first-primary")
            .prepare(
              "SELECT id, name, state, plus_addressing, catch_all_mailbox_id, updated_at FROM domains WHERE org_id = ? AND state != 'removed' ORDER BY name",
            )
            .bind(params.orgId!)
            .all(),
        );
        return { items: rows.results };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/domains/:id",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { domain } = yield* adminDomain(params.id!);
        const diag = yield* ctl(() =>
          env.DIRECTORY.withSession("first-primary")
            .prepare("SELECT last_diagnostics FROM domains WHERE id = ?")
            .bind(domain.id)
            .first<{ last_diagnostics: string | null }>(),
        );
        const workflowId = yield* domainWorkflow(env, domain.id);
        const instance = yield* Effect.promise(() =>
          env.PROVISION_DOMAIN.get(workflowId)
            .then((i) => i.status())
            .catch(() => null),
        );
        return {
          ...domain,
          diagnostics: diag?.last_diagnostics
            ? (JSON.parse(diag.last_diagnostics) as unknown)
            : null,
          verificationRecord: verificationRecord(domain),
          workflow: instance
            ? { id: workflowId, status: (instance as { status: string }).status }
            : null,
        };
      }),
    ),
  ),
  // Live DNS change preview (public answers vs. the service profile), shown before applying.
  route(
    "GET",
    "/v1/domains/:id/dns",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { domain } = yield* adminDomain(params.id!);
        return yield* ctl(() =>
          new DomainOnboarding(env.DIRECTORY, kernelClock, onboardingDeps(env, null)).preview(
            domain.id,
          ),
        );
      }),
    ),
  ),
  route(
    "PATCH",
    "/v1/domains/:id",
    authedBody(DomainSettingsRequest, ({ params, body }) =>
      Effect.gen(function* () {
        const { domain, principal, domains } = yield* adminDomain(params.id!);
        yield* requireStepUp("admin");
        return yield* domains.configure(domain.id, principal.userId, {
          ...(body.plusAddressing === undefined ? {} : { plusAddressing: body.plusAddressing }),
          ...(body.catchAllMailboxId === undefined
            ? {}
            : { catchAllMailboxId: body.catchAllMailboxId }),
        });
      }),
    ),
  ),
  // Explicit, separately approved zone-authorization step (§5.4); resumes the onboarding Workflow.
  route(
    "POST",
    "/v1/domains/:id/authorize-zone",
    authedBody(
      ZoneAuthorizationRequest,
      ({ env, params, body }) =>
        Effect.gen(function* () {
          const { domain } = yield* adminDomain(params.id!);
          yield* requireStepUp("admin");
          const method: ZoneAuthorizationMethod = body.method;
          if (method !== "manual-records" && !env.CF_DNS_API_TOKEN)
            return yield* badRequest("zone automation is not configured; use manual-records");
          if (domain.state !== "ownership-proven")
            return yield* Effect.fail(
              new ApiError({ code: "conflict", message: `domain is ${domain.state}` }),
            );
          const workflowId = yield* domainWorkflow(env, domain.id);
          const instance = yield* Effect.promise(() => env.PROVISION_DOMAIN.get(workflowId));
          yield* Effect.promise(() =>
            instance.sendEvent({ type: "zone-authorized", payload: { method } }),
          );
          return { domainId: domain.id, method, status: "authorizing" };
        }),
      { status: 202 },
    ),
  ),
  // Restart onboarding (e.g. after the Workflow timed out waiting for DNS); idempotent steps resume.
  route(
    "POST",
    "/v1/domains/:id/retry",
    authed(
      ({ env, params }) =>
        Effect.gen(function* () {
          const { domain, principal } = yield* adminDomain(params.id!);
          const id = `dom-${domain.id}-${Date.now().toString(36)}`;
          yield* Effect.promise(() =>
            env.PROVISION_DOMAIN.create({
              id,
              params: { v: 1, domainId: domain.id, actorId: principal.userId },
            }),
          );
          // Later status reads and zone-authorization events must reach THIS instance, not the first one.
          yield* setDomainWorkflow(env, domain.id, id);
          return { domainId: domain.id, workflowId: id };
        }),
      { status: 202 },
    ),
  ),
  route(
    "DELETE",
    "/v1/domains/:id",
    authed(({ params }) =>
      Effect.gen(function* () {
        const { domain, principal, domains } = yield* adminDomain(params.id!);
        yield* requireStepUp("admin");
        return yield* domains.remove(domain.id, principal.userId);
      }),
    ),
  ),
  route(
    "GET",
    "/v1/domains/:id/aliases",
    authed(({ params }) =>
      Effect.gen(function* () {
        const { domain, domains } = yield* adminDomain(params.id!);
        return { items: yield* domains.listAliases(domain.id) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/domains/:id/aliases",
    authedBody(
      DomainAliasRequest,
      ({ params, body }) =>
        Effect.gen(function* () {
          const { domain, principal, domains } = yield* adminDomain(params.id!);
          return yield* domains.addAlias(domain.id, principal.userId, {
            localPart: body.localPart,
            mailboxId: body.mailboxId,
          });
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/domains/:id/aliases/:address",
    authed(({ params }) =>
      Effect.gen(function* () {
        const { domain, principal, domains } = yield* adminDomain(params.id!);
        if (!(yield* domains.removeAlias(domain.id, principal.userId, params.address!)))
          return yield* new NotFound({ resource: "alias" });
        return { removed: true };
      }),
    ),
  ),

  // ---- billing (A02) ----
  route(
    "GET",
    "/v1/billing",
    authed(({ env, url }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const orgId =
          url.searchParams.get("orgId") ??
          (yield* Effect.promise(() => personalOrgOf(env, principal.userId)));
        if (!orgId || !principal.organizationIds.includes(orgId))
          return yield* new Forbidden({ reason: "not a member of organization" });
        const billing = yield* BillingService;
        const commerce = yield* CommerceService;
        const ent = yield* billing.entitlement(orgId);
        return {
          orgId,
          entitlement: ent
            ? {
                plan: ent.plan,
                interval: ent.interval,
                status: ent.status,
                state: entitlementState(ent, Date.now()),
                seats: ent.seats,
                trialEndsAt: ent.trial_ends_at,
                periodEnd: ent.period_end,
                creditsCents: ent.credits_cents,
                shortAddress: ent.short_address === 1,
              }
            : null,
          ledger: yield* commerce.ledgerFor(orgId),
          plans: Object.values(PLAN_CATALOG),
        };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/billing/checkout",
    authedBody(
      CheckoutRequest,
      ({ env, body }) =>
        Effect.gen(function* () {
          const principal = yield* requireUser();
          const orgId = yield* billingOrgId(env, body.orgId, principal.userId);
          yield* requireOrgAdminAccess(orgId, "read");
          const commerce = yield* CommerceService;
          return yield* commerce.createCheckout({
            purpose: "subscription",
            plan: body.plan,
            interval: body.interval,
            seats: body.seats ?? 1,
            orgId,
            userId: principal.userId,
            returnUrl: `${env.APP_ORIGIN}/settings/billing`,
          });
        }),
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/billing/checkout/:id",
    authed(({ params, url }) =>
      Effect.gen(function* () {
        yield* requireScope("read");
        const commerce = yield* CommerceService;
        return yield* commerce.checkoutStatus(params.id!, url.searchParams.get("sig") ?? "");
      }),
    ),
  ),
  route(
    "POST",
    "/v1/billing/plan",
    authedBody(
      CheckoutRequest,
      ({ env, body }) =>
        Effect.gen(function* () {
          const principal = yield* requireUser();
          const orgId = yield* billingOrgId(env, body.orgId, principal.userId);
          yield* requireOrgAdminAccess(orgId, "read");
          yield* requireStepUp("admin");
          const commerce = yield* CommerceService;
          return yield* commerce.requestPlanChange(orgId, principal.userId, {
            plan: body.plan,
            interval: body.interval,
            seats: body.seats ?? 1,
          });
        }),
      { status: 202 },
    ),
  ),
  route(
    "POST",
    "/v1/billing/cancel",
    authedBody(
      CancelSubscriptionRequest,
      ({ env, body }) =>
        Effect.gen(function* () {
          const principal = yield* requireUser();
          const orgId = yield* billingOrgId(env, body.orgId, principal.userId);
          yield* requireOrgAdminAccess(orgId, "read");
          yield* requireStepUp("admin");
          const commerce = yield* CommerceService;
          return yield* commerce.requestCancel(orgId, principal.userId, body.atPeriodEnd ?? true);
        }),
      { status: 202 },
    ),
  ),

  // ---- export, device sessions, closure (A04) ----
  route(
    "POST",
    "/v1/exports",
    authed(
      ({ env }) =>
        Effect.gen(function* () {
          // A full-account export is bulk access to everything: interactive sessions only (a lapsed
          // account keeps it, read scope suffices), never agent tokens or support sessions.
          const principal = yield* requireUser();
          const exportId = crypto.randomUUID();
          yield* Effect.promise(() =>
            env.EXPORT_ACCOUNT.create({
              id: `exp-${principal.userId}-${exportId}`,
              params: {
                v: 1,
                exportId,
                userId: principal.userId,
                mailboxIds: principal.mailboxIds,
                calendarIds: principal.calendarIds,
              },
            }),
          );
          return { exportId, status: "queued" };
        }),
      { status: 202 },
    ),
  ),
  route(
    "GET",
    "/v1/exports/:id",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        const principal = yield* requireUser();
        // Instance IDs embed the owner, so one user can never read another's export status.
        // An unknown (or another user's) export id has no instance: `get` rejects, which is a 404.
        const status = yield* Effect.promise(() =>
          env.EXPORT_ACCOUNT.get(`exp-${principal.userId}-${params.id}`)
            .then((instance) => instance.status())
            .catch(() => null),
        );
        if (!status)
          return yield* Effect.fail(new ApiError({ code: "not_found", message: "export" }));
        // Files are listed with signed, expiring download links (the private bucket is never public).
        const prefix = `t/${principal.userId}/export/${params.id}/`;
        const listed = yield* Effect.promise(() => env.EXPORTS.list({ prefix, limit: 1000 }));
        const expiresAt = Date.now() + EXPORT_LINK_TTL_MS;
        const files = yield* Effect.promise(() =>
          // bounded: at most 1000 listed export files, each a local HMAC signature (no I/O fan-out)
          Promise.all(
            listed.objects.map(async (o) => ({
              name: o.key.slice(prefix.length),
              size: o.size,
              url: `${env.APP_ORIGIN}/v1/downloads?key=${encodeURIComponent(o.key)}&token=${await signDownload(env, o.key, expiresAt)}`,
              expiresAt,
            })),
          ),
        );
        return { ...status, files };
      }),
    ),
  ),
  // Capability download: the signed, expiring token is the authorization (works for CLI and browsers).
  route("GET", "/v1/downloads", async (request, _p, env) => {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    if (
      !key.startsWith("t/") ||
      !key.includes("/export/") ||
      !(await verifyDownload(env, key, url.searchParams.get("token") ?? "", Date.now()))
    ) {
      return errorResponse("forbidden", "invalid or expired download link");
    }
    const object = await env.EXPORTS.get(key);
    if (!object) return errorResponse("not_found", "file");
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${(key.split("/").pop() ?? "export").replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }),
  route(
    "GET",
    "/v1/devices",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        return {
          items: yield* Effect.promise(() =>
            new ControlDeviceAuth(env.DIRECTORY, kernelClock).listSessions(principal.userId),
          ),
        };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/devices/:id",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        // Credential management is for the account holder's own interactive session only.
        const principal = yield* requireUser();
        const devices = new ControlDeviceAuth(env.DIRECTORY, kernelClock, (userId, sessionId) =>
          closeLiveSockets(env, userId, sessionId),
        );
        const ok = yield* Effect.promise(() =>
          devices.revokeOwnSession(principal.userId, params.id!),
        );
        if (!ok) return yield* new NotFound({ resource: "device" });
        return { revoked: true };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/account/closure-terms",
    authed(() =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const commerce = yield* CommerceService;
        return yield* commerce.closureTerms(principal.userId);
      }),
    ),
  ),
  // Closure terms come from the entitlement; an optional forwarding destination is verified by email.
  route(
    "POST",
    "/v1/account/close",
    authedBody(CloseAccountRequest, ({ env, body }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const commerce = yield* CommerceService;
        const lifecycle = yield* LifecycleService;
        const terms = yield* commerce.closureTerms(principal.userId);
        const forwardTo = (body.forwardTo ?? "").trim().toLowerCase();
        const closed = yield* closeOwnAccount({
          confirmAddress: body.confirmAddress,
          reserveAddressDays: terms.reserveAddressDays,
          forwardingDays: terms.forwardingDays,
        });
        const forwarding: Array<{ address: string; pending: boolean }> = [];
        if (forwardTo && terms.forwardingDays > 0) {
          for (const address of closed.reserved) {
            const { verificationToken } = yield* lifecycle.requestForwarding(
              principal.userId,
              address,
              forwardTo,
            );
            const link = `${env.APP_ORIGIN}/auth/forwarding/confirm?address=${encodeURIComponent(address)}&token=${encodeURIComponent(verificationToken)}`;
            yield* Effect.promise(() =>
              sendSystemEmail(env, {
                to: forwardTo,
                subject: `Confirm forwarding from ${address}`,
                text: `Confirm that mail sent to ${address} should be forwarded to this address for ${terms.forwardingDays} days:\n${link}\n\nIf you did not request this, ignore this message.`,
              }).catch(() => undefined),
            );
            forwarding.push({ address, pending: true });
          }
        }
        return { ...closed, terms, forwarding };
      }),
    ),
  ),

  // ---- platform operator tooling (§10 abuse review, A02 credits, audited support access) ----
  route(
    "GET",
    "/v1/operator/signals",
    authed(() =>
      Effect.gen(function* () {
        yield* requireOperatorAccess();
        const sending = yield* SendingService;
        return { items: yield* sending.openSignals() };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/operator/signals/:id/review",
    authedBody(SignalReviewRequest, ({ params, body }) =>
      Effect.gen(function* () {
        const operator = yield* requireOperatorAccess();
        yield* requireStepUp("admin");
        const resolution = body.resolution;
        const sending = yield* SendingService;
        yield* sending.reviewSignal(params.id!, operator.userId, resolution);
        return { reviewed: true };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/operator/suspensions",
    authedBody(
      SuspensionRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const operator = yield* requireOperatorAccess();
          yield* requireStepUp("admin");
          const sending = yield* SendingService;
          yield* sending.suspend(body.scope, body.key, body.reason || "operator", operator.userId);
          return { suspended: true };
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/operator/suspensions/:scope/:key",
    authed(({ params }) =>
      Effect.gen(function* () {
        const operator = yield* requireOperatorAccess();
        yield* requireStepUp("admin");
        const scope = params.scope as SendingScope;
        if (!SENDING_SCOPES.includes(scope)) return yield* badRequest("invalid scope");
        const sending = yield* SendingService;
        return { lifted: yield* sending.lift(scope, params.key!, operator.userId) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/operator/suppressions",
    authedBody(
      SuppressionRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const operator = yield* requireOperatorAccess();
          yield* requireStepUp("admin");
          const sending = yield* SendingService;
          yield* sending.suppress(body.address, "manual", `operator:${operator.userId}`);
          return { suppressed: true };
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/operator/suppressions/:address",
    authed(({ params }) =>
      Effect.gen(function* () {
        yield* requireOperatorAccess();
        yield* requireStepUp("admin");
        const sending = yield* SendingService;
        return { removed: yield* sending.unsuppress(params.address!) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/operator/credits",
    authedBody(
      CreditRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const operator = yield* requireOperatorAccess();
          yield* requireStepUp("admin");
          const commerce = yield* CommerceService;
          yield* commerce.grantCredit(
            body.orgId,
            operator.userId,
            body.cents,
            body.reason ?? "goodwill",
          );
          return { credited: true };
        }),
      { status: 201 },
    ),
  ),
  // Support sessions exist only under an active user grant; every open is audited and time-boxed.
  route(
    "POST",
    "/v1/operator/support-sessions",
    authedBody(
      SupportSessionRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const operator = yield* requireOperatorAccess();
          yield* requireStepUp("admin");
          const support = yield* SupportService;
          return yield* support.openSession(operator.userId, body.grantId);
        }),
      { status: 201 },
    ),
  ),
];
