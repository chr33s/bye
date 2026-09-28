// Administration and lifecycle routes (O01, O02, A01, A02, A04, §10 operator tooling, device sessions).
import { Effect } from "effect";
import {
  Authorization,
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
  InstallationDomainRequest,
  InstallationZoneTokenRequest,
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
import { requestErasure } from "../erasure.ts";
import { sendSystemEmail } from "../publishing.ts";
import {
  onboardingDeps,
  onboardingDepsFor,
  type ZoneAuthorizationMethod,
} from "../workflows/domain.ts";
import {
  deleteZoneToken,
  installationAutomation,
  storeZoneToken,
  zoneApiToken,
  ZoneTokenRejected,
  zoneTokenConfigured,
} from "../zone-token.ts";
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
/** Minimum spacing between full-account export requests of one user. */
const EXPORT_COOLDOWN_MS = 60 * 60_000;
/** An export not marked complete by then is presumed dead and no longer blocks a new one. */
const EXPORT_STALE_MS = 6 * 3600_000;

/**
 * The mailbox or calendar an export file was made from: files are `<id>.<ext>`, or
 * `.chunks/<id>.<ext>` / `.carry/<id>/<n>` for intermediates.
 */
const exportSourceId = (name: string): string =>
  name.replace(/^\.(chunks|carry)\//, "").split(/[./]/, 1)[0] ?? "";
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

/**
 * Who may manage the installation's incoming-email automation: a platform operator who
 * administers the organization holding the installation zone's domain (or, before it exists,
 * their personal organization) — the same authority as binding the zone.
 */
const installationMailAdmin = (env: CoreEnv) =>
  Effect.gen(function* () {
    const operator = yield* requireOperatorAccess();
    const zone = (env.INSTALL_ZONE_NAME ?? "").toLowerCase();
    if (!zone || !env.INSTALL_ZONE_ID)
      return yield* Effect.fail(
        new ApiError({ code: "conflict", message: "this installation has no recorded zone" }),
      );
    const bound = yield* ctl(() =>
      env.DIRECTORY.withSession("first-primary")
        .prepare("SELECT org_id FROM domains WHERE name = ? AND state != 'removed'")
        .bind(zone)
        .first<{ org_id: string }>(),
    );
    const orgId =
      bound?.org_id ?? ((yield* Effect.promise(() => personalOrgOf(env, operator.userId))) || "");
    if (!orgId) return yield* badRequest("no organization for the installation zone");
    return yield* requireOrgAdminAccess(orgId);
  });

/** Onboarding deps for a domain, with its zone token resolved (and decrypted) for this request. */
const depsFor = (env: CoreEnv, domainName: string | null, method: ZoneAuthorizationMethod | null) =>
  Effect.promise(() => onboardingDepsFor(env, domainName, method));

/** Workflow instance statuses that can still make progress (or receive an event). */
const LIVE_WORKFLOW = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

/** Status of a domain Workflow instance; null when it is missing or unreadable. */
const domainWorkflowStatus = (env: CoreEnv, instanceId: string) =>
  Effect.promise(() =>
    env.PROVISION_DOMAIN.get(instanceId)
      .then((i) => i.status())
      .then(
        (s) => (s as { status?: string }).status ?? null,
        () => null,
      ),
  );

/**
 * A live onboarding Workflow for the domain: the recorded instance while it can still progress,
 * otherwise a fresh one (after a rollback, a timed-out wait, an error or a stop). A fresh instance
 * resumes from the state and authorization recorded in D1 (workflows/domain.ts).
 */
const ensureDomainWorkflow = (env: CoreEnv, domainId: string, actorId: string) =>
  Effect.gen(function* () {
    const current = yield* domainWorkflow(env, domainId);
    const status = yield* domainWorkflowStatus(env, current);
    if (status !== null && LIVE_WORKFLOW.has(status)) return { id: current, fresh: false };
    const id =
      status === null && current === `dom-${domainId}`
        ? current
        : `dom-${domainId}-${Date.now().toString(36)}`;
    yield* ctl(() =>
      env.PROVISION_DOMAIN.create({ id, params: { v: 1, domainId, actorId } }).then(() => true),
    );
    // Later status reads and zone-authorization events must reach THIS instance.
    yield* setDomainWorkflow(env, domainId, id);
    return { id, fresh: true };
  });

/**
 * Stops the domain's Workflow if it is still live. True when nothing live remains, false when it
 * could not be stopped (callers must not proceed as if it had been).
 */
const stopDomainWorkflow = (env: CoreEnv, domainId: string) =>
  Effect.gen(function* () {
    const current = yield* domainWorkflow(env, domainId);
    const status = yield* domainWorkflowStatus(env, current);
    if (status === null || !LIVE_WORKFLOW.has(status)) return true;
    yield* Effect.promise(() =>
      env.PROVISION_DOMAIN.get(current)
        .then((i) => (i as { terminate?: () => Promise<void> }).terminate?.())
        .catch(() => undefined),
    );
    const after = yield* domainWorkflowStatus(env, current);
    return after === null || !LIVE_WORKFLOW.has(after);
  });

/** Restarts setup from the recorded state: stop the live instance (if any), then a fresh one. */
const restartDomainWorkflow = (env: CoreEnv, domainId: string, actorId: string) =>
  Effect.gen(function* () {
    if (!(yield* stopDomainWorkflow(env, domainId)))
      return yield* Effect.fail(
        new ApiError({
          code: "conflict",
          message: "the running setup could not be stopped; try again",
        }),
      );
    return yield* ensureDomainWorkflow(env, domainId, actorId);
  });

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
          // `inviteTeamMember` verified the admin role and step-up; the actor is charged for the send.
          const principal = yield* requireScope("read");
          const link = `${env.APP_ORIGIN}/invite?token=${encodeURIComponent(result.token)}`;
          yield* Effect.promise(() =>
            sendSystemEmail(
              env,
              {
                to: address,
                subject: "You're invited to join an organization",
                text: `Accept the invitation (valid 7 days):\n${link}\n`,
              },
              { actorUserId: principal.userId },
            ).catch(() => undefined),
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

  // ---- incoming email for the onboarding-selected zone (infra/onboarding/spec.md §10–§17) ----
  // What the post-owner "Set up incoming email" card needs. Never claims mail is ready: only a
  // domain in state `active` receives mail.
  route(
    "GET",
    "/v1/installation/mail",
    authed(({ env }) =>
      Effect.gen(function* () {
        const principal = yield* requireScope("read");
        const zone = env.INSTALL_ZONE_NAME || null;
        const row = zone
          ? yield* ctl(() =>
              env.DIRECTORY.withSession("first-primary")
                .prepare(
                  "SELECT id, org_id, state FROM domains WHERE name = ? AND state != 'removed'",
                )
                .bind(zone)
                .first<{ id: string; org_id: string; state: string }>(),
            )
          : null;
        const visible = row !== null && principal.organizationIds.includes(row.org_id);
        return {
          zone,
          automation: yield* Effect.promise(() => installationAutomation(env)),
          tokenConfigured: yield* Effect.promise(() => zoneTokenConfigured(env)),
          canSetup: zone !== null && (yield* Authorization).isOperator(principal.userId),
          domain: visible ? { id: row.id, orgId: row.org_id, state: row.state } : null,
          incomingMail: visible && row.state === "active" ? "active" : "not-set-up",
        };
      }),
    ),
  ),
  // "Let Bye make the changes": the owner enters a Cloudflare API token limited to the installation's
  // zone. It is validated against Cloudflare, sealed, and used only for that zone's incoming-email
  // work (zone-token.ts). Neither it nor any part of it is ever returned or logged.
  route(
    "POST",
    "/v1/installation/mail/token",
    authedBody(InstallationZoneTokenRequest, ({ body, env }) =>
      Effect.gen(function* () {
        const principal = yield* installationMailAdmin(env);
        yield* requireStepUp("admin");
        const token = body.token.trim();
        const refused = yield* Effect.promise(() =>
          storeZoneToken(env, token, principal.userId, Date.now()).then(
            () => null,
            (e: unknown) =>
              e instanceof ZoneTokenRejected ? e.message : "the token could not be checked",
          ),
        );
        if (refused !== null) return yield* badRequest(refused);
        return { automation: "zone-api" as const, tokenConfigured: true };
      }),
    ),
  ),
  // Removing the token returns incoming email to manual records. Refused while setup is writing
  // through the zone API, so a change is never left half made.
  route(
    "DELETE",
    "/v1/installation/mail/token",
    authed(({ env }) =>
      Effect.gen(function* () {
        yield* installationMailAdmin(env);
        yield* requireStepUp("admin");
        const zone = (env.INSTALL_ZONE_NAME ?? "").toLowerCase();
        const row = zone
          ? yield* ctl(() =>
              env.DIRECTORY.withSession("first-primary")
                .prepare(
                  "SELECT id, state, zone_auth_method FROM domains WHERE name = ? AND state != 'removed'",
                )
                .bind(zone)
                .first<{ id: string; state: string; zone_auth_method: string | null }>(),
            )
          : null;
        const writing = ["zone-authorized", "dns-configured", "inbound-tested", "outbound-tested"];
        if (
          row !== null &&
          row.zone_auth_method !== null &&
          row.zone_auth_method !== "manual-records" &&
          writing.includes(row.state) &&
          !env.CF_DNS_API_TOKEN
        ) {
          const status = yield* domainWorkflowStatus(env, yield* domainWorkflow(env, row.id));
          if (status !== null && LIVE_WORKFLOW.has(status))
            return yield* Effect.fail(
              new ApiError({
                code: "conflict",
                message:
                  "incoming email setup is making changes with this token; wait for it to finish or restore the previous setup first",
              }),
            );
        }
        yield* Effect.promise(() => deleteZoneToken(env));
        return {
          automation: yield* Effect.promise(() => installationAutomation(env)),
          tokenConfigured: false,
        };
      }),
    ),
  ),
  // "Review mail setup": create or reuse the customer domain for the installation's zone without
  // re-entering it. Ownership is the onboarding account/zone link, so the domain starts at
  // `ownership-proven`; nothing is written to DNS or Email Routing here.
  route(
    "POST",
    "/v1/domains/from-installation",
    authedBody(
      InstallationDomainRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          const operator = yield* requireOperatorAccess();
          // Default: the owner's personal organization, where their address on the zone lives.
          const orgId =
            body.orgId ??
            ((yield* Effect.promise(() => personalOrgOf(env, operator.userId))) || "");
          if (!orgId) return yield* badRequest("no organization to bind the domain to");
          const principal = yield* requireOrgAdminAccess(orgId);
          yield* requireStepUp("admin");
          const zone = (env.INSTALL_ZONE_NAME ?? "").toLowerCase();
          if (!zone || !env.INSTALL_ZONE_ID || !env.INSTALL_ACCOUNT_ID)
            return yield* Effect.fail(
              new ApiError({ code: "conflict", message: "this installation has no recorded zone" }),
            );
          if (body.name !== undefined && body.name.toLowerCase().replace(/\.$/, "") !== zone)
            return yield* badRequest("name does not match the installation's zone");
          const deps = yield* depsFor(env, zone, null);
          const row = yield* ctl(() =>
            new DomainOnboarding(env.DIRECTORY, kernelClock, deps).domains.requestFromInstallation(
              orgId,
              principal.userId,
              {
                name: zone,
                accountId: env.INSTALL_ACCOUNT_ID!,
                zoneId: env.INSTALL_ZONE_ID!,
              },
            ),
          );
          // Reuse the domain's live workflow; a missing or finished one is replaced.
          yield* ensureDomainWorkflow(env, row.id, principal.userId);
          return { domainId: row.id, name: row.name, state: row.state };
        }),
      { status: 202 },
    ),
  ),
  // "Restore previous mail setup": puts the recorded MX/SPF/DKIM/DMARC/routing state back (or,
  // for a manual-records setup, keeps it for the customer to restore by hand) and returns the
  // domain to `ownership-proven`, from where setup can start again. The application deployment and
  // mail already accepted are untouched.
  route(
    "POST",
    "/v1/domains/:id/rollback",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { domain, principal } = yield* adminDomain(params.id!);
        yield* requireStepUp("admin");
        const link = yield* ctl(() =>
          new DomainOnboarding(
            env.DIRECTORY,
            kernelClock,
            onboardingDeps(env, null, null),
          ).domains.mailLink(domain.id),
        );
        // Restore through the path the change was made: the zone API only if Bye wrote with it.
        const method: ZoneAuthorizationMethod =
          link.writeMode === "api" ? "delegated-token" : "manual-records";
        const onboarding = new DomainOnboarding(
          env.DIRECTORY,
          kernelClock,
          yield* depsFor(env, domain.name, method),
        );
        // Validate first: nothing is stopped when there is nothing (or no way) to restore.
        yield* ctl(() => onboarding.rollbackPlan(domain.id));
        // Stop the running workflow so it does not re-apply the change being rolled back.
        if (!(yield* stopDomainWorkflow(env, domain.id)))
          return yield* Effect.fail(
            new ApiError({
              code: "conflict",
              message: "the running setup could not be stopped; nothing was restored, try again",
            }),
          );
        return yield* ctl(() => onboarding.rollback(domain.id, principal.userId));
      }),
    ),
  ),
  // After a manual-records rollback: the customer confirms they put their previous records back.
  route(
    "POST",
    "/v1/domains/:id/restore-acknowledged",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const { domain, principal } = yield* adminDomain(params.id!);
        yield* requireStepUp("admin");
        yield* ctl(() =>
          new DomainOnboarding(
            env.DIRECTORY,
            kernelClock,
            onboardingDeps(env, null, null),
          ).domains.acknowledgeRestore(domain.id, principal.userId),
        );
        return { domainId: domain.id, restorePending: null };
      }),
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
        const deps = yield* depsFor(env, domain.name, null);
        return yield* ctl(() =>
          new DomainOnboarding(env.DIRECTORY, kernelClock, deps).preview(domain.id),
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
          const { domain, principal } = yield* adminDomain(params.id!);
          yield* requireStepUp("admin");
          const method: ZoneAuthorizationMethod = body.method;
          if (
            method !== "manual-records" &&
            (yield* Effect.promise(() => zoneApiToken(env, domain.name))) === null
          )
            return yield* badRequest("zone automation is not configured; use manual-records");
          const onboarding = new DomainOnboarding(
            env.DIRECTORY,
            kernelClock,
            yield* depsFor(env, domain.name, method),
          );
          // One read of the current setup (authoritative zone records and routing rules when the
          // zone API is available) decides the cutover and becomes the recorded snapshot.
          const inspection = yield* ctl(() => onboarding.inspect(domain.id));
          const { requiresCutover, provider } = inspection.classification;
          const needConfirmation = () =>
            Effect.fail(
              new ApiError({
                code: "conflict",
                message: `incoming mail for ${domain.name} currently goes to ${provider}; confirm the switch to continue`,
                details: { cutoverRequired: true, provider },
              }),
            );
          const authorizedStates = [
            "zone-authorized",
            "dns-configured",
            "inbound-tested",
            "outbound-tested",
          ];
          if (authorizedStates.includes(domain.state)) {
            // Already authorized, but the current provider is still in place (it appeared after
            // authorization, or public DNS was stale): confirm the switch now and restart setup
            // so it continues immediately.
            if (!requiresCutover || inspection.link.cutoverConfirmedAt !== null)
              return yield* Effect.fail(
                new ApiError({ code: "conflict", message: `domain is ${domain.state}` }),
              );
            if (body.confirmCutover !== true) return yield* needConfirmation();
            yield* ctl(() =>
              onboarding.domains.recordCutover(
                domain.id,
                principal.userId,
                onboarding.snapshotOf(inspection),
                true,
              ),
            );
            yield* restartDomainWorkflow(env, domain.id, principal.userId);
            return { domainId: domain.id, method, status: "switching" };
          }
          if (domain.state !== "ownership-proven")
            return yield* Effect.fail(
              new ApiError({ code: "conflict", message: `domain is ${domain.state}` }),
            );
          // Replacing the current provider is a separate, explicit decision (infra/onboarding/spec.md
          // §12 state 3); the current configuration is recorded before anything is written.
          if (requiresCutover && body.confirmCutover !== true) return yield* needConfirmation();
          yield* ctl(() =>
            onboarding.domains.recordCutover(
              domain.id,
              principal.userId,
              onboarding.snapshotOf(inspection),
              requiresCutover,
            ),
          );
          // Recorded before the event, so a fresh instance resumes from it without waiting.
          yield* ctl(() =>
            onboarding.domains.recordAuthorization(domain.id, principal.userId, method),
          );
          const workflow = yield* ensureDomainWorkflow(env, domain.id, principal.userId);
          if (!workflow.fresh) {
            const instance = yield* Effect.promise(() => env.PROVISION_DOMAIN.get(workflow.id));
            yield* Effect.promise(() =>
              instance.sendEvent({ type: "zone-authorized", payload: { method } }),
            );
          }
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
          yield* requireStepUp("admin");
          // A fresh instance re-runs the checks from the recorded state and authorization; the
          // live one (if any) is stopped first so two never run for one domain.
          const { id } = yield* restartDomainWorkflow(env, domain.id, principal.userId);
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
          // Routing an address to a mailbox is a forwarding-class change (§7.3): fresh step-up.
          yield* requireStepUp("admin");
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
        yield* requireStepUp("admin");
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
          // Each export is a full copy of every mailbox and calendar kept for a week: one in
          // flight per user, and a cooldown between requests (claimed atomically in D1).
          const now = Date.now();
          const claimed = yield* Effect.promise(() =>
            env.DIRECTORY.prepare(
              `INSERT INTO account_exports (id, user_id, created_at)
               SELECT ?, ?, ? WHERE NOT EXISTS (
                 SELECT 1 FROM account_exports WHERE user_id = ?
                   AND ((completed_at IS NULL AND created_at > ?) OR created_at > ?))`,
            )
              .bind(
                exportId,
                principal.userId,
                now,
                principal.userId,
                now - EXPORT_STALE_MS,
                now - EXPORT_COOLDOWN_MS,
              )
              .run(),
          );
          if (!claimed.meta.changes)
            return yield* Effect.fail(
              new ApiError({
                code: "rate_limited",
                message: "an export is already in progress or was requested recently",
              }),
            );
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
        // No links for files of a mailbox the caller can no longer access (the principal is built
        // per request): a member removed from an org mailbox gets no new links to its export.
        const current = new Set(principal.mailboxIds);
        const sources = [
          ...new Set(listed.objects.map((o) => exportSourceId(o.key.slice(prefix.length)))),
        ].filter((id) => id && !current.has(id));
        const revoked = new Set<string>();
        // bounded: one D1 query per 50 distinct source ids of at most 1000 listed files
        for (let i = 0; i < sources.length; i += 50) {
          const chunk = sources.slice(i, i + 50);
          const rows = yield* Effect.promise(() =>
            env.DIRECTORY.prepare(
              `SELECT id FROM mailboxes WHERE id IN (${chunk.map(() => "?").join(", ")})`,
            )
              .bind(...chunk)
              .all<{ id: string }>(),
          );
          for (const r of rows.results) revoked.add(r.id);
        }
        const visible = listed.objects.filter(
          (o) => !revoked.has(exportSourceId(o.key.slice(prefix.length))),
        );
        const files = yield* Effect.promise(() =>
          // bounded: at most 1000 listed export files, each a local HMAC signature (no I/O fan-out)
          Promise.all(
            visible.map(async (o) => ({
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
        // Closure starts erasure (§12); it runs from the durable queue so it is retried on failure.
        yield* Effect.promise(() => requestErasure(env, principal.userId, "account closed"));
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
              sendSystemEmail(
                env,
                {
                  to: forwardTo,
                  subject: `Confirm forwarding from ${address}`,
                  text: `Confirm that mail sent to ${address} should be forwarded to this address for ${terms.forwardingDays} days:\n${link}\n\nIf you did not request this, ignore this message.`,
                },
                { actorUserId: principal.userId },
              ).catch(() => undefined),
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
