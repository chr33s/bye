import { Schema } from "effect";

// Control-plane HTTP contracts: authentication, sessions, tokens, organizations, domains,
// billing and account lifecycle (A01–A04, O01, O02). Versioned independently of Effect.

const Bounded = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)));

const UpTo = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));

const Base64Url = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(max)));

export const ControlEmailAddress = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/), Schema.isMaxLength(320)),
);

const Timestamp = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export const ScopeNameSchema = Schema.Literals([
  "read",
  "draft",
  "send",
  "screen",
  "delete",
  "calendar",
  "publish",
  "admin",
]);

// ---- authentication (A03) ----

/** `purpose` defaults to authenticate. */
export const ChallengeRequest = Schema.Struct({
  purpose: Schema.optional(Schema.Literals(["register", "authenticate", "step-up"])),
});

export const ChallengeResponse = Schema.Struct({
  challengeId: Bounded(64),
  challenge: Base64Url(128),
  rpId: Bounded(253),
});

const AttestationResponse = Schema.Struct({
  clientDataJSON: Base64Url(8192),
  attestationObject: Base64Url(16384),
});

const AssertionResponse = Schema.Struct({
  credentialId: Base64Url(1024),
  clientDataJSON: Base64Url(8192),
  authenticatorData: Base64Url(4096),
  signature: Base64Url(512),
});

/** Signup's first passkey (`/auth/passkey/register`): the WebAuthn attestation for the new account. */
export const PasskeyRegistrationRequest = Schema.Struct({
  userId: Bounded(64),
  challengeId: Bounded(64),
  timeZone: Schema.optional(Bounded(64)),
  response: AttestationResponse,
});

export type PasskeyRegistrationRequest = typeof PasskeyRegistrationRequest.Type;

/** Passkey sign-in and step-up: a WebAuthn assertion for an issued challenge. */
export const PasskeyAssertionRequest = Schema.Struct({
  challengeId: Bounded(64),
  response: AssertionResponse,
});

export type PasskeyAssertionRequest = typeof PasskeyAssertionRequest.Type;

/** Retry signup's passkey ceremony with the signup capability. */
export const SignupRetryRequest = Schema.Struct({ userId: Bounded(64), signupToken: Bounded(512) });

export const TotpCodeRequest = Schema.Struct({
  code: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{6}$/))),
});

export const TotpEnrollment = Schema.Struct({ secret: Bounded(64), otpauthUri: Bounded(512) });

export const SecurityStatusSchema = Schema.Struct({
  passkeys: Schema.Number,
  totp: Schema.Literals(["none", "pending", "enabled"]),
  recoveryCodesRemaining: Schema.Number,
});

export const AddPasskeyRequest = Schema.Struct({
  challengeId: Bounded(64),
  label: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(80)))),
  response: AttestationResponse,
});

/** Personal signup. `timeZone` is an IANA zone (the browser's resolved zone) for the calendar default. */
export const SignupRequest = Schema.Struct({
  address: ControlEmailAddress,
  displayName: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))),
  /** Required unless `bootstrap` is given. */
  turnstile: Schema.optional(Bounded(4096)),
  /** Onboarding installations only: the single-use first-account token, in place of Turnstile. */
  bootstrap: Schema.optional(Bounded(128)),
  timeZone: Schema.optional(Bounded(64)),
  referralCode: Schema.optional(Bounded(32)),
  /** Required for short (≤4 character) addresses: a completed short-address checkout. */
  checkoutSessionId: Schema.optional(Bounded(64)),
});

export const ShortAddressCheckoutRequest = Schema.Struct({
  address: ControlEmailAddress,
  interval: Schema.optional(Schema.Literals(["monthly", "annual"])),
});

/** `hours` defaults to 24. */
export const SupportGrantRequest = Schema.Struct({
  reason: Bounded(500),
  hours: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(72),
      ),
    ),
  ),
});

export const RecoveryCodes = Schema.Struct({ codes: Schema.Array(Bounded(32)) });

export const RecoveryRequest = Schema.Struct({ address: ControlEmailAddress, code: Bounded(32) });

export const SessionViewSchema = Schema.Struct({
  id: Bounded(64),
  device: Schema.String,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Schema.optional(Timestamp),
  current: Schema.Boolean,
});

export type SessionViewSchema = typeof SessionViewSchema.Type;

/** `kind` defaults to agent. */
export const CreateApiTokenRequest = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["agent", "cli"])),
  label: Bounded(100),
  scopes: Schema.optional(Schema.Array(ScopeNameSchema)),
  expiresAt: Schema.optional(Timestamp),
});

export type CreateApiTokenRequest = typeof CreateApiTokenRequest.Type;

export const ApiTokenCreated = Schema.Struct({
  id: Bounded(64),
  token: Bounded(200),
  scopes: Schema.Array(ScopeNameSchema),
});

// ---- organizations (O02, A01) ----

export const MemberRoleSchema = Schema.Literals(["owner", "admin", "member"]);

export const CreateOrganizationRequest = Schema.Struct({
  name: Bounded(200),
  kind: Schema.Literals(["domain", "family"]),
  /** Default: 6 for a family, 5 for a domain organization. */
  seatLimit: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(10_000),
      ),
    ),
  ),
  reassignmentPolicy: Schema.optional(
    Schema.Literals(["retain", "reassign-to-admin", "forward-then-close"]),
  ),
});

/** `role` defaults to member. */
export const InviteMemberRequest = Schema.Struct({
  address: ControlEmailAddress,
  role: Schema.optional(Schema.Literals(["admin", "member"])),
});

/** Legacy `/v1/memberships/:orgId/suspend` body. */
export const MembershipSuspendRequest = Schema.Struct({ userId: Bounded(64) });

export const AcceptInvitationRequest = Schema.Struct({ token: Base64Url(128) });

export const SetRoleRequest = Schema.Struct({ role: MemberRoleSchema });

export const MemberViewSchema = Schema.Struct({
  userId: Bounded(64),
  address: ControlEmailAddress,
  role: MemberRoleSchema,
  status: Schema.Literals(["active", "suspended", "removed"]),
});

export const SeatsViewSchema = Schema.Struct({
  limit: Schema.Number,
  used: Schema.Number,
  entitled: Schema.NullOr(Schema.Number),
});

export const SetSeatLimitRequest = Schema.Struct({
  limit: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
});

export const CreateExtensionRequest = Schema.Struct({
  domainId: Bounded(64),
  localPart: Bounded(64),
  displayName: Schema.optional(Bounded(120)),
  memberIds: Schema.optional(Schema.Array(Bounded(64))),
  sendAs: Schema.optional(Schema.Boolean),
  workflowBoard: Schema.optional(Bounded(64)),
  workflowStage: Schema.optional(Bounded(64)),
});

// ---- domains (O01) ----

export const DomainStateSchema = Schema.Literals([
  "requested",
  "ownership-proven",
  "zone-authorized",
  "dns-configured",
  "inbound-tested",
  "outbound-tested",
  "active",
  "removing",
  "removed",
]);

export const DnsRecordSchema = Schema.Struct({
  type: Schema.Literals(["MX", "TXT", "CNAME"]),
  name: Bounded(253),
  content: Bounded(4096),
  priority: Schema.optional(Schema.Number),
});

export const DnsOperationSchema = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), record: DnsRecordSchema, purpose: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("update"),
    from: DnsRecordSchema,
    to: DnsRecordSchema,
    purpose: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("keep"), record: DnsRecordSchema, purpose: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("conflict"),
    existing: DnsRecordSchema,
    desired: DnsRecordSchema,
    purpose: Schema.String,
  }),
]);

export const DomainRequest = Schema.Struct({ orgId: Bounded(64), name: Bounded(253) });

export const DomainViewSchema = Schema.Struct({
  id: Bounded(64),
  name: Bounded(253),
  state: DomainStateSchema,
  verificationRecord: Schema.optional(DnsRecordSchema),
  plusAddressing: Schema.Boolean,
  catchAllMailboxId: Schema.NullOr(Schema.String),
});

export const DomainDiagnosticSchema = Schema.Struct({
  check: Schema.Literals(["ownership", "mx", "spf", "dkim", "dmarc"]),
  status: Schema.Literals(["pass", "fail", "warn"]),
  detail: Schema.String,
});

export const DomainSettingsRequest = Schema.Struct({
  plusAddressing: Schema.optional(Schema.Boolean),
  catchAllMailboxId: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ZoneAuthorizationRequest = Schema.Struct({
  method: Schema.Literals(["service-zone", "delegated-token", "manual-records"]),
  /** Explicit "Switch incoming email to Bye": required when the domain's MX points elsewhere. */
  confirmCutover: Schema.optional(Schema.Boolean),
});

/** Bind the onboarding-selected zone as a customer domain (infra/onboarding/spec.md §17). */
export const InstallationDomainRequest = Schema.Struct({
  /** Defaults to the caller's personal organization (where the owner's address lives). */
  orgId: Schema.optional(Bounded(64)),
  /** Optional echo of the zone name; refused when it differs from the installation's. */
  name: Schema.optional(Bounded(253)),
});

/**
 * A Cloudflare API token the owner created for exactly the installation's zone
 * (infra/onboarding/spec.md §13). Only type-checked here, so a decode error never echoes it.
 */
export const InstallationZoneTokenRequest = Schema.Struct({ token: Schema.String });

export const DomainAliasRequest = Schema.Struct({ localPart: Bounded(64), mailboxId: Bounded(64) });

// ---- billing and lifecycle (A02, A04) ----

export const EntitlementViewSchema = Schema.Struct({
  plan: Schema.String,
  interval: Schema.Literals(["monthly", "annual"]),
  status: Schema.Literals(["trialing", "active", "past_due", "cancelled", "expired"]),
  seats: Schema.Number,
  trialEndsAt: Schema.NullOr(Timestamp),
  periodEnd: Schema.NullOr(Timestamp),
  creditsCents: Schema.Number,
});

/** Closure terms (reservation and forwarding periods) are derived server-side from the entitlement. */
export const CloseAccountRequest = Schema.Struct({
  confirmAddress: ControlEmailAddress,
  /** Optional post-cancellation forwarding destination; verified by an emailed link. */
  forwardTo: Schema.optional(ControlEmailAddress),
  /**
   * v1 fields, still accepted for backward compatibility (§7.5) but ignored: closure terms now
   * come from the account's entitlement (A04), never from the client.
   */
  reserveAddressDays: Schema.optional(Schema.Number),
  forwardingDays: Schema.optional(Schema.Number),
});

export const ClosureTermsSchema = Schema.Struct({
  plan: Schema.NullOr(Schema.String),
  reserveAddressDays: Schema.Number,
  forwardingDays: Schema.Number,
});

export const CheckoutRequest = Schema.Struct({
  orgId: Schema.optional(Bounded(64)),
  plan: Schema.Literals(["personal", "family", "domain"]),
  interval: Schema.Literals(["monthly", "annual"]),
  seats: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  ),
});

export const CheckoutCreated = Schema.Struct({ sessionId: Bounded(64), url: Bounded(2048) });

export const CancelSubscriptionRequest = Schema.Struct({
  orgId: Schema.optional(Bounded(64)),
  atPeriodEnd: Schema.optional(Schema.Boolean),
});

// ---- platform operator tooling (§10) ----

export const SendingScopeSchema = Schema.Literals(["user", "domain", "identity", "platform"]);

export const SuspensionRequest = Schema.Struct({
  scope: SendingScopeSchema,
  key: Bounded(320),
  reason: Schema.optional(Bounded(500)),
});

export const SignalReviewRequest = Schema.Struct({
  resolution: Schema.Literals(["confirmed-abuse", "false-positive"]),
});

/** `reason` defaults to goodwill. */
export const CreditRequest = Schema.Struct({
  orgId: Bounded(64),
  cents: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  reason: Schema.optional(Schema.Literals(["goodwill", "refund"])),
});

export const SuppressionRequest = Schema.Struct({ address: ControlEmailAddress });

export const SupportSessionRequest = Schema.Struct({ grantId: Bounded(64) });

/** Push device registration (E23, C02/C10). `keys` is the Web Push subscription JSON form. */
export const PushSubscriptionRequest = Schema.Struct({
  kind: Schema.Literals(["webpush", "apns", "fcm"]),
  endpoint: Bounded(2048),
  p256dh: Schema.optional(UpTo(256)),
  auth: Schema.optional(UpTo(256)),
  keys: Schema.optional(
    Schema.Struct({ p256dh: Schema.optional(UpTo(256)), auth: Schema.optional(UpTo(256)) }),
  ),
  label: Schema.optional(UpTo(200)),
});

/** External send-as credential (§5.3 ExternalIdentityTransport, E19). Sealed at rest. */
export const ExternalIdentityCredentialRequest = Schema.Struct({
  provider: Schema.Literals(["gmail", "graph", "http"]),
  endpoint: Schema.optional(Bounded(2048)),
  apiKey: Schema.optional(Bounded(4096)),
  accessToken: Schema.optional(Bounded(8192)),
  refreshToken: Schema.optional(Bounded(8192)),
  tokenEndpoint: Schema.optional(Bounded(2048)),
  clientId: Schema.optional(Bounded(512)),
  clientSecret: Schema.optional(Bounded(4096)),
  expiresAt: Schema.optional(Schema.Number),
});

// Operator routes (§6, §12; OPS_TOKEN only).
export const OpsDiscardRequest = Schema.Struct({ note: Schema.optional(UpTo(500)) });

export const OpsReindexRequest = Schema.Struct({
  mailboxId: Schema.String.pipe(Schema.check(Schema.isPattern(/^mbx_[A-Za-z0-9_-]{1,80}$/))),
});

export const OpsErasureRequest = Schema.Struct({
  userId: Schema.String.pipe(Schema.check(Schema.isPattern(/^usr_[A-Za-z0-9_-]{1,80}$/))),
  reason: Schema.optional(UpTo(200)),
});

export const OpsRestoreRequest = Schema.Struct({
  kind: Schema.Literals(["mailbox", "calendar", "space"]),
  id: Bounded(84),
  /** Must repeat `id` exactly (explicit confirmation). */
  confirm: Bounded(84),
  at: Schema.Number,
});

// ---- identity, credentials and security settings: responses (A03, X02) ----

/** The verified principal behind the request (`GET /v1/me`). */
export const MeView = Schema.Struct({
  userId: Schema.String,
  kind: Schema.Literals(["user", "agent", "cli"]),
  scopes: Schema.Array(ScopeNameSchema),
  mailboxIds: Schema.Array(Schema.String),
  calendarIds: Schema.Array(Schema.String),
  organizationIds: Schema.Array(Schema.String),
});

export type MeView = typeof MeView.Type;

export const ApiTokenView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(ScopeNameSchema),
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
});

export type ApiTokenView = typeof ApiTokenView.Type;

export const ApiTokenList = Schema.Struct({ items: Schema.Array(ApiTokenView) });

/** A revoked credential, session or grant. */
export const RevocationResult = Schema.Struct({ revoked: Schema.Boolean });

export const TotpEnabled = Schema.Struct({ enabled: Schema.Boolean });

/** `disabled` is false when no authenticator was enrolled. */
export const TotpDisabled = Schema.Struct({ disabled: Schema.Boolean });

export const PasskeyView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
});

export type PasskeyView = typeof PasskeyView.Type;

export const PasskeyList = Schema.Struct({ items: Schema.Array(PasskeyView) });

/** A registration challenge for adding a passkey to the signed-in account. */
export const PasskeyChallenge = Schema.Struct({ id: Schema.String, challenge: Schema.String });

export const PasskeyAdded = Schema.Struct({ id: Schema.String });

export const PasskeyRemoved = Schema.Struct({ removed: Schema.Boolean });

export const SessionList = Schema.Struct({ items: Schema.Array(SessionViewSchema) });

export const SupportGrantView = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  grantedAt: Schema.Number,
  expiresAt: Schema.Number,
  active: Schema.Boolean,
});

export type SupportGrantView = typeof SupportGrantView.Type;

export const SupportGrantList = Schema.Struct({ items: Schema.Array(SupportGrantView) });

export const SupportGrantCreated = Schema.Struct({ id: Schema.String, expiresAt: Schema.Number });

export const ReferralView = Schema.Struct({ code: Schema.String, url: Schema.String });

// ---- push devices: responses (E23) ----

export const PushDeviceView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.Number,
  lastSuccessAt: Schema.NullOr(Schema.Number),
  disabledAt: Schema.NullOr(Schema.Number),
});

export type PushDeviceView = typeof PushDeviceView.Type;

export const PushDeviceList = Schema.Struct({ items: Schema.Array(PushDeviceView) });

export const PushDeviceRegistered = Schema.Struct({ id: Schema.String });

// ---- organizations, domains, billing, lifecycle and operator tooling: responses (A01–A04, O01–O03, §10) ----
// Plain wire shapes (no refinements): a response is described, never re-validated.

const OrgKindSchema = Schema.Literals(["personal", "domain", "family"]);

const ReassignmentPolicySchema = Schema.Literals([
  "retain",
  "reassign-to-admin",
  "forward-then-close",
]);

const EntitlementStatusSchema = Schema.Literals([
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
]);

/** Access derived from an entitlement at request time (grace follows a lapse). */
const EntitlementStateSchema = Schema.Literals(["entitled", "grace", "lapsed"]);

export const OrganizationCreated = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["domain", "family"]),
  name: Schema.String,
  seatLimit: Schema.Number,
});

export type OrganizationCreated = typeof OrganizationCreated.Type;

/** An organization as one of its active members sees it, with its entitlement summary. */
export const OrganizationView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: OrgKindSchema,
  seatLimit: Schema.Number,
  reassignmentPolicy: ReassignmentPolicySchema,
  role: MemberRoleSchema,
  entitlement: Schema.NullOr(
    Schema.Struct({
      plan: Schema.String,
      status: EntitlementStatusSchema,
      state: EntitlementStateSchema,
      seats: Schema.Number,
      periodEnd: Schema.NullOr(Schema.Number),
      trialEndsAt: Schema.NullOr(Schema.Number),
    }),
  ),
});

export type OrganizationView = typeof OrganizationView.Type;

export const MemberList = Schema.Struct({ items: Schema.Array(MemberViewSchema) });

export const MemberRoleChanged = Schema.Struct({ userId: Schema.String, role: MemberRoleSchema });

export const MemberReactivated = Schema.Struct({ userId: Schema.String, status: Schema.String });

/** `policy` is the organization's reassignment policy; `mailboxes` the member's owned mailboxes. */
export const MemberRemoved = Schema.Struct({
  policy: Schema.String,
  mailboxes: Schema.Array(Schema.String),
});

export const OrgAuditEntry = Schema.Struct({
  action: Schema.String,
  actor_id: Schema.String,
  target: Schema.String,
  created_at: Schema.Number,
});

export type OrgAuditEntry = typeof OrgAuditEntry.Type;

export const OrgAuditLog = Schema.Struct({ items: Schema.Array(OrgAuditEntry) });

/** The invitation token is returned once, to the inviting administrator (it is also mailed). */
export const InvitationCreated = Schema.Struct({
  invitationId: Schema.String,
  token: Schema.String,
});

export const InvitationAccepted = Schema.Struct({ orgId: Schema.String, role: MemberRoleSchema });

export const ExtensionCreated = Schema.Struct({
  mailboxId: Schema.String,
  spaceId: Schema.String,
  address: Schema.String,
});

// Domains (O01) and incoming email for the installation's zone (infra/onboarding/spec.md §10–§17).

const ZoneAutomationSchema = Schema.Literals(["manual-records", "zone-api"]);

const ZoneAuthMethodSchema = Schema.Literals(["service-zone", "delegated-token", "manual-records"]);

/** What the "Set up incoming email" card needs; `incomingMail` is `active` or `not-set-up`. */
export const InstallationMailView = Schema.Struct({
  zone: Schema.NullOr(Schema.String),
  automation: ZoneAutomationSchema,
  tokenConfigured: Schema.Boolean,
  canSetup: Schema.Boolean,
  domain: Schema.NullOr(
    Schema.Struct({ id: Schema.String, orgId: Schema.String, state: Schema.String }),
  ),
  incomingMail: Schema.String,
});

export type InstallationMailView = typeof InstallationMailView.Type;

/** The installation zone token's status after it is stored or removed (never the token). */
export const InstallationZoneTokenStatus = Schema.Struct({
  automation: ZoneAutomationSchema,
  tokenConfigured: Schema.Boolean,
});

/** A domain's stored row (snake_case, as the API has always returned it). */
export const DomainRowView = Schema.Struct({
  id: Schema.String,
  org_id: Schema.String,
  name: Schema.String,
  state: DomainStateSchema,
  verification_token: Schema.String,
  plus_addressing: Schema.Number,
  catch_all_mailbox_id: Schema.NullOr(Schema.String),
});

export type DomainRowView = typeof DomainRowView.Type;

/** The TXT record that proves ownership of a requested domain. */
const VerificationRecordView = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
});

export const DomainRequested = Schema.Struct({
  ...DomainRowView.fields,
  verificationRecord: VerificationRecordView,
});

export type DomainRequested = typeof DomainRequested.Type;

export const DomainDetail = Schema.Struct({
  ...DomainRowView.fields,
  /** The last recorded onboarding diagnostics, as stored. */
  diagnostics: Schema.Unknown,
  verificationRecord: VerificationRecordView,
  workflow: Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.String })),
});

export type DomainDetail = typeof DomainDetail.Type;

export const OrgDomainSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: DomainStateSchema,
  plus_addressing: Schema.Number,
  catch_all_mailbox_id: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
});

export type OrgDomainSummary = typeof OrgDomainSummary.Type;

export const OrgDomainList = Schema.Struct({ items: Schema.Array(OrgDomainSummary) });

/**
 * A DNS record as observed or planned. `type` is any record type the zone holds at a managed
 * name; `id` is present when the record was read through the zone API.
 */
export const DnsRecordView = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
  priority: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
});

export type DnsRecordView = typeof DnsRecordView.Type;

export const DnsOperationView = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), record: DnsRecordView, purpose: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("update"),
    from: DnsRecordView,
    to: DnsRecordView,
    purpose: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("keep"), record: DnsRecordView, purpose: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("conflict"),
    existing: DnsRecordView,
    desired: DnsRecordView,
    purpose: Schema.String,
  }),
]);

export type DnsOperationView = typeof DnsOperationView.Type;

/** A Cloudflare Email Routing rule, as recorded. */
export const EmailRoutingRuleView = Schema.Struct({
  enabled: Schema.Boolean,
  name: Schema.optional(Schema.String),
  matchers: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      field: Schema.optional(Schema.String),
      value: Schema.optional(Schema.String),
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({ type: Schema.String, value: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

/** The mail setup recorded before a cutover; `routing` is null when it could not be read. */
export const MailSnapshotView = Schema.Struct({
  capturedAt: Schema.Number,
  mx: Schema.Array(DnsRecordView),
  spf: Schema.Array(DnsRecordView),
  dkim: Schema.Array(DnsRecordView),
  dmarc: Schema.Array(DnsRecordView),
  routing: Schema.NullOr(
    Schema.Struct({
      enabled: Schema.Boolean,
      catchAll: Schema.NullOr(EmailRoutingRuleView),
      rules: Schema.Array(EmailRoutingRuleView),
    }),
  ),
});

export type MailSnapshotView = typeof MailSnapshotView.Type;

/** Live DNS change preview (public answers or zone records vs. the service profile). */
export const MailPreviewView = Schema.Struct({
  domain: DomainRowView,
  plan: Schema.Array(DnsOperationView),
  diagnostics: Schema.Unknown,
  classification: Schema.Struct({
    kind: Schema.Literals(["new", "existing-provider", "conflicted"]),
    provider: Schema.NullOr(Schema.String),
    currentMx: Schema.Array(DnsRecordView),
    conflicts: Schema.Array(DnsOperationView),
    requiresCutover: Schema.Boolean,
  }),
  source: Schema.Literals(["zone-api", "public-dns"]),
  cutoverPending: Schema.Boolean,
  link: Schema.Struct({
    installAccountId: Schema.NullOr(Schema.String),
    installZoneId: Schema.NullOr(Schema.String),
    cutoverConfirmedAt: Schema.NullOr(Schema.Number),
    zoneAuthMethod: Schema.NullOr(Schema.String),
    writeMode: Schema.NullOr(Schema.String),
    restorePending: Schema.NullOr(MailSnapshotView),
    inboundProbe: Schema.NullOr(
      Schema.Struct({ address: Schema.String, receivedAt: Schema.NullOr(Schema.Number) }),
    ),
    hasSnapshot: Schema.Boolean,
  }),
});

export type MailPreviewView = typeof MailPreviewView.Type;

export const InstallationDomainBound = Schema.Struct({
  domainId: Schema.String,
  name: Schema.String,
  state: DomainStateSchema,
});

/** "Restore previous mail setup": `manual` is the setup the customer restores by hand. */
export const DomainRollbackResult = Schema.Struct({
  domain: DomainRowView,
  restored: Schema.Array(Schema.String),
  manual: Schema.NullOr(MailSnapshotView),
});

export const DomainRestoreAcknowledged = Schema.Struct({
  domainId: Schema.String,
  restorePending: Schema.Null,
});

export const ZoneAuthorizationAccepted = Schema.Struct({
  domainId: Schema.String,
  method: ZoneAuthMethodSchema,
  status: Schema.String,
});

export const DomainWorkflowRestarted = Schema.Struct({
  domainId: Schema.String,
  workflowId: Schema.String,
});

export const DomainRemoved = Schema.Struct({ disabledRoutes: Schema.Number });

export const DomainAliasView = Schema.Struct({
  address: Schema.String,
  mailboxId: Schema.String,
  kind: Schema.String,
  disabled: Schema.Boolean,
});

export type DomainAliasView = typeof DomainAliasView.Type;

export const DomainAliasList = Schema.Struct({ items: Schema.Array(DomainAliasView) });

export const DomainAliasCreated = Schema.Struct({ address: Schema.String });

/** A removed alias or suppression; false when there was none. */
export const RemovalResult = Schema.Struct({ removed: Schema.Boolean });

// Billing (A02).

export const PlanDefinitionView = Schema.Struct({
  id: Schema.String,
  kind: OrgKindSchema,
  monthlyCents: Schema.Number,
  annualCents: Schema.Number,
  perSeat: Schema.Boolean,
  closure: Schema.Struct({ reserveAddressDays: Schema.Number, forwardingDays: Schema.Number }),
});

export type PlanDefinitionView = typeof PlanDefinitionView.Type;

export const BillingLedgerEntry = Schema.Struct({
  kind: Schema.String,
  amountCents: Schema.Number,
  reason: Schema.String,
  createdAt: Schema.Number,
});

export type BillingLedgerEntry = typeof BillingLedgerEntry.Type;

export const BillingView = Schema.Struct({
  orgId: Schema.String,
  entitlement: Schema.NullOr(
    Schema.Struct({
      plan: Schema.String,
      interval: Schema.Literals(["monthly", "annual"]),
      status: EntitlementStatusSchema,
      state: EntitlementStateSchema,
      seats: Schema.Number,
      trialEndsAt: Schema.NullOr(Schema.Number),
      periodEnd: Schema.NullOr(Schema.Number),
      creditsCents: Schema.Number,
      shortAddress: Schema.Boolean,
    }),
  ),
  ledger: Schema.Array(BillingLedgerEntry),
  plans: Schema.Array(PlanDefinitionView),
});

export type BillingView = typeof BillingView.Type;

export const CheckoutStatusView = Schema.Struct({ status: Schema.String, purpose: Schema.String });

/** A plan change or cancellation was requested; the processor's webhook applies it. */
export const BillingChangeRequested = Schema.Struct({ requested: Schema.Literal(true) });

// Export, device sessions and closure (A04).

export const ExportQueued = Schema.Struct({ exportId: Schema.String, status: Schema.String });

/** An export file with its signed, expiring download link. */
export const ExportFileView = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  url: Schema.String,
  expiresAt: Schema.Number,
});

export const ExportStatusView = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.Struct({ name: Schema.String, message: Schema.String })),
  output: Schema.optional(Schema.Unknown),
  files: Schema.Array(ExportFileView),
});

export type ExportStatusView = typeof ExportStatusView.Type;

export const DeviceSessionView = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  deviceName: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
});

export type DeviceSessionView = typeof DeviceSessionView.Type;

export const DeviceSessionList = Schema.Struct({ items: Schema.Array(DeviceSessionView) });

/** Addresses reserved at closure, the terms applied, and forwarding awaiting confirmation. */
export const AccountClosed = Schema.Struct({
  reserved: Schema.Array(Schema.String),
  terms: ClosureTermsSchema,
  forwarding: Schema.Array(Schema.Struct({ address: Schema.String, pending: Schema.Boolean })),
});

export type AccountClosed = typeof AccountClosed.Type;

// Platform operator tooling (§10).

export const SendingSignalView = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  key: Schema.String,
  signal: Schema.String,
  detail: Schema.Unknown,
  createdAt: Schema.Number,
});

export type SendingSignalView = typeof SendingSignalView.Type;

export const SendingSignalList = Schema.Struct({ items: Schema.Array(SendingSignalView) });

export const SignalReviewed = Schema.Struct({ reviewed: Schema.Boolean });

export const SuspensionCreated = Schema.Struct({ suspended: Schema.Boolean });

export const SuspensionLifted = Schema.Struct({ lifted: Schema.Boolean });

export const SuppressionCreated = Schema.Struct({ suppressed: Schema.Boolean });

export const CreditGranted = Schema.Struct({ credited: Schema.Boolean });

/** A time-boxed support session token (opened under an active user grant, audited). */
export const SupportSessionOpened = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.Number,
  userId: Schema.String,
});
