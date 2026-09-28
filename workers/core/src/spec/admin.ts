// Administration and lifecycle (O01, O02, O03, A01, A02, A04, §10 operator tooling, device
// sessions). The capability download (`GET /v1/downloads`) stays a native route (../routes/admin.ts).
import {
  AcceptInvitationRequest,
  AccountClosed,
  BillingChangeRequested,
  BillingView,
  CancelSubscriptionRequest,
  CheckoutCreated,
  CheckoutRequest,
  CheckoutStatusView,
  CloseAccountRequest,
  ClosureTermsSchema,
  CreateExtensionRequest,
  CreateOrganizationRequest,
  CreditGranted,
  CreditRequest,
  DeviceSessionList,
  DomainAliasCreated,
  DomainAliasList,
  DomainAliasRequest,
  DomainDetail,
  DomainRemoved,
  DomainRequest,
  DomainRequested,
  DomainRestoreAcknowledged,
  DomainRollbackResult,
  DomainRowView,
  DomainSettingsRequest,
  DomainWorkflowRestarted,
  ExportQueued,
  ExportStatusView,
  ExtensionCreated,
  InstallationDomainBound,
  InstallationDomainRequest,
  InstallationMailView,
  InstallationZoneTokenRequest,
  InstallationZoneTokenStatus,
  InvitationAccepted,
  InvitationCreated,
  InviteMemberRequest,
  MailPreviewView,
  MemberList,
  MemberReactivated,
  MemberRemoved,
  MemberRoleChanged,
  MembershipSuspendRequest,
  OrgAuditLog,
  OrgDomainList,
  OrganizationCreated,
  OrganizationView,
  RemovalResult,
  RevocationResult,
  SeatsViewSchema,
  SendingSignalList,
  SetRoleRequest,
  SetSeatLimitRequest,
  SignalReviewed,
  SignalReviewRequest,
  SupportSessionOpened,
  SupportSessionRequest,
  SuppressionCreated,
  SuppressionRequest,
  SuspensionCreated,
  SuspensionLifted,
  SuspensionRequest,
  ZoneAuthorizationAccepted,
  ZoneAuthorizationRequest,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Ok, RequestServices, SchemaErrors } from "../httpapi.ts";

const org = { orgId: Schema.String };

const member = { orgId: Schema.String, userId: Schema.String };

const byId = { id: Schema.String };

export class AdminApi extends HttpApiGroup.make("admin")
  .add(
    // ---- organizations and team administration (A01, O02) ----
    HttpApiEndpoint.post("createOrganization", "/v1/orgs", {
      payload: CreateOrganizationRequest,
      success: OrganizationCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("organization", "/v1/orgs/:orgId", {
      params: org,
      success: OrganizationView,
    }),
    HttpApiEndpoint.get("members", "/v1/orgs/:orgId/members", { params: org, success: MemberList }),
    HttpApiEndpoint.patch("setMemberRole", "/v1/orgs/:orgId/members/:userId", {
      params: member,
      payload: SetRoleRequest,
      success: MemberRoleChanged,
    }),
    HttpApiEndpoint.post("suspendMember", "/v1/orgs/:orgId/members/:userId/suspend", {
      params: member,
      success: Ok,
    }),
    HttpApiEndpoint.post("reactivateMember", "/v1/orgs/:orgId/members/:userId/reactivate", {
      params: member,
      success: MemberReactivated,
    }),
    HttpApiEndpoint.delete("removeMember", "/v1/orgs/:orgId/members/:userId", {
      params: member,
      success: MemberRemoved,
    }),
    HttpApiEndpoint.get("seats", "/v1/orgs/:orgId/seats", {
      params: org,
      success: SeatsViewSchema,
    }),
    HttpApiEndpoint.put("setSeatLimit", "/v1/orgs/:orgId/seats", {
      params: org,
      payload: SetSeatLimitRequest,
      success: SeatsViewSchema,
    }),
    HttpApiEndpoint.get("auditLog", "/v1/orgs/:orgId/audit", {
      params: org,
      query: { limit: Schema.optional(Schema.String) },
      success: OrgAuditLog,
    }),
    // Invitations: the admin invites (step-up); the invitee accepts from their own account.
    HttpApiEndpoint.post("inviteMember", "/v1/orgs/:orgId/invitations", {
      params: org,
      payload: InviteMemberRequest,
      success: InvitationCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("acceptInvitation", "/v1/invitations/accept", {
      payload: AcceptInvitationRequest,
      success: InvitationAccepted,
    }),
    // Legacy paths kept for existing clients.
    HttpApiEndpoint.post("legacyInviteMember", "/v1/memberships/:orgId/invite", {
      params: org,
      payload: InviteMemberRequest,
      success: InvitationCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("legacySuspendMember", "/v1/memberships/:orgId/suspend", {
      params: org,
      payload: MembershipSuspendRequest,
      success: Ok,
    }),
    // Extension (shared-address) mailboxes backed by a shared space (O03).
    HttpApiEndpoint.post("createExtension", "/v1/orgs/:orgId/extensions", {
      params: org,
      payload: CreateExtensionRequest,
      success: ExtensionCreated.pipe(HttpApiSchema.status(201)),
    }),

    // ---- incoming email for the onboarding-selected zone (infra/onboarding/spec.md §10–§17) ----
    // What the post-owner "Set up incoming email" card needs. Never claims mail is ready: only a
    // domain in state `active` receives mail.
    HttpApiEndpoint.get("installationMail", "/v1/installation/mail", {
      success: InstallationMailView,
    }),
    // "Let Bye make the changes": the owner enters a Cloudflare API token limited to the
    // installation's zone. It is validated against Cloudflare, sealed, and used only for that
    // zone's incoming-email work (zone-token.ts). Neither it nor any part of it is ever returned or
    // logged.
    HttpApiEndpoint.post("storeInstallationZoneToken", "/v1/installation/mail/token", {
      payload: InstallationZoneTokenRequest,
      success: InstallationZoneTokenStatus,
    }),
    // Removing the token returns incoming email to manual records. Refused while setup is writing
    // through the zone API, so a change is never left half made.
    HttpApiEndpoint.delete("removeInstallationZoneToken", "/v1/installation/mail/token", {
      success: InstallationZoneTokenStatus,
    }),
    // "Review mail setup": create or reuse the customer domain for the installation's zone without
    // re-entering it. Ownership is the onboarding account/zone link, so the domain starts at
    // `ownership-proven`; nothing is written to DNS or Email Routing here.
    HttpApiEndpoint.post("domainFromInstallation", "/v1/domains/from-installation", {
      payload: InstallationDomainRequest,
      success: InstallationDomainBound.pipe(HttpApiSchema.status(202)),
    }),
    // "Restore previous mail setup": puts the recorded MX/SPF/DKIM/DMARC/routing state back (or,
    // for a manual-records setup, keeps it for the customer to restore by hand) and returns the
    // domain to `ownership-proven`, from where setup can start again. The application deployment
    // and mail already accepted are untouched.
    HttpApiEndpoint.post("rollbackDomain", "/v1/domains/:id/rollback", {
      params: byId,
      success: DomainRollbackResult,
    }),
    // After a manual-records rollback: the customer confirms they put their previous records back.
    HttpApiEndpoint.post("acknowledgeDomainRestore", "/v1/domains/:id/restore-acknowledged", {
      params: byId,
      success: DomainRestoreAcknowledged,
    }),

    // ---- customer domains (O01) ----
    HttpApiEndpoint.post("requestDomain", "/v1/domains", {
      payload: DomainRequest,
      success: DomainRequested.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.get("orgDomains", "/v1/orgs/:orgId/domains", {
      params: org,
      success: OrgDomainList,
    }),
    HttpApiEndpoint.get("domain", "/v1/domains/:id", { params: byId, success: DomainDetail }),
    // Live DNS change preview (public answers vs. the service profile), shown before applying.
    HttpApiEndpoint.get("domainDnsPreview", "/v1/domains/:id/dns", {
      params: byId,
      success: MailPreviewView,
    }),
    HttpApiEndpoint.patch("configureDomain", "/v1/domains/:id", {
      params: byId,
      payload: DomainSettingsRequest,
      success: DomainRowView,
    }),
    // Explicit, separately approved zone-authorization step (§5.4); resumes the onboarding Workflow.
    HttpApiEndpoint.post("authorizeDomainZone", "/v1/domains/:id/authorize-zone", {
      params: byId,
      payload: ZoneAuthorizationRequest,
      success: ZoneAuthorizationAccepted.pipe(HttpApiSchema.status(202)),
    }),
    // Restart onboarding (e.g. after the Workflow timed out waiting for DNS); idempotent steps resume.
    HttpApiEndpoint.post("retryDomain", "/v1/domains/:id/retry", {
      params: byId,
      success: DomainWorkflowRestarted.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.delete("removeDomain", "/v1/domains/:id", {
      params: byId,
      success: DomainRemoved,
    }),
    HttpApiEndpoint.get("domainAliases", "/v1/domains/:id/aliases", {
      params: byId,
      success: DomainAliasList,
    }),
    HttpApiEndpoint.post("addDomainAlias", "/v1/domains/:id/aliases", {
      params: byId,
      payload: DomainAliasRequest,
      success: DomainAliasCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("removeDomainAlias", "/v1/domains/:id/aliases/:address", {
      params: { id: Schema.String, address: Schema.String },
      success: RemovalResult,
    }),

    // ---- billing (A02) ----
    HttpApiEndpoint.get("billing", "/v1/billing", {
      query: { orgId: Schema.optional(Schema.String) },
      success: BillingView,
    }),
    HttpApiEndpoint.post("createCheckout", "/v1/billing/checkout", {
      payload: CheckoutRequest,
      success: CheckoutCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("checkoutStatus", "/v1/billing/checkout/:id", {
      params: byId,
      query: { sig: Schema.optional(Schema.String) },
      success: CheckoutStatusView,
    }),
    HttpApiEndpoint.post("changePlan", "/v1/billing/plan", {
      payload: CheckoutRequest,
      success: BillingChangeRequested.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.post("cancelSubscription", "/v1/billing/cancel", {
      payload: CancelSubscriptionRequest,
      success: BillingChangeRequested.pipe(HttpApiSchema.status(202)),
    }),

    // ---- export, device sessions, closure (A04) ----
    HttpApiEndpoint.post("requestExport", "/v1/exports", {
      success: ExportQueued.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.get("exportStatus", "/v1/exports/:id", {
      params: byId,
      success: ExportStatusView,
    }),
    HttpApiEndpoint.get("devices", "/v1/devices", { success: DeviceSessionList }),
    HttpApiEndpoint.delete("revokeDevice", "/v1/devices/:id", {
      params: byId,
      success: RevocationResult,
    }),
    HttpApiEndpoint.get("closureTerms", "/v1/account/closure-terms", {
      success: ClosureTermsSchema,
    }),
    // Closure terms come from the entitlement; an optional forwarding destination is verified by
    // email.
    HttpApiEndpoint.post("closeAccount", "/v1/account/close", {
      payload: CloseAccountRequest,
      success: AccountClosed,
    }),

    // ---- platform operator tooling (§10 abuse review, A02 credits, audited support access) ----
    HttpApiEndpoint.get("operatorSignals", "/v1/operator/signals", { success: SendingSignalList }),
    HttpApiEndpoint.post("reviewSignal", "/v1/operator/signals/:id/review", {
      params: byId,
      payload: SignalReviewRequest,
      success: SignalReviewed,
    }),
    HttpApiEndpoint.post("suspendSending", "/v1/operator/suspensions", {
      payload: SuspensionRequest,
      success: SuspensionCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("liftSuspension", "/v1/operator/suspensions/:scope/:key", {
      params: { scope: Schema.String, key: Schema.String },
      success: SuspensionLifted,
    }),
    HttpApiEndpoint.post("suppressAddress", "/v1/operator/suppressions", {
      payload: SuppressionRequest,
      success: SuppressionCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("unsuppressAddress", "/v1/operator/suppressions/:address", {
      params: { address: Schema.String },
      success: RemovalResult,
    }),
    HttpApiEndpoint.post("grantCredit", "/v1/operator/credits", {
      payload: CreditRequest,
      success: CreditGranted.pipe(HttpApiSchema.status(201)),
    }),
    // Support sessions exist only under an active user grant; every open is audited and time-boxed.
    HttpApiEndpoint.post("openSupportSession", "/v1/operator/support-sessions", {
      payload: SupportSessionRequest,
      success: SupportSessionOpened.pipe(HttpApiSchema.status(201)),
    }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
