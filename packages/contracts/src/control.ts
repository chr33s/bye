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
});
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
