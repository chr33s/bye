// Identity, credential and security-settings endpoints (A03, X02).
import {
  AddPasskeyRequest,
  ApiTokenCreated,
  ApiTokenList,
  CreateApiTokenRequest,
  MeView,
  PasskeyAdded,
  PasskeyChallenge,
  PasskeyList,
  PasskeyRemoved,
  RecoveryCodes,
  ReferralView,
  RevocationResult,
  SecurityStatusSchema,
  SessionList,
  SupportGrantCreated,
  SupportGrantList,
  SupportGrantRequest,
  TotpCodeRequest,
  TotpDisabled,
  TotpEnabled,
  TotpEnrollment,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { RequestServices, SchemaErrors } from "../httpapi.ts";

const id = { id: Schema.String };

export class IdentityApi extends HttpApiGroup.make("identity")
  .add(
    // ---- identity ----
    HttpApiEndpoint.get("me", "/v1/me", { success: MeView }),
    HttpApiEndpoint.post("createToken", "/v1/tokens", {
      payload: CreateApiTokenRequest,
      success: ApiTokenCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("listTokens", "/v1/tokens", { success: ApiTokenList }),
    HttpApiEndpoint.delete("revokeToken", "/v1/tokens/:id", {
      params: id,
      success: RevocationResult,
    }),

    // ---- security settings (A03) ----
    HttpApiEndpoint.get("securityStatus", "/v1/security", { success: SecurityStatusSchema }),
    /** Recovery codes are shown exactly once; generating a new set invalidates the old set. */
    HttpApiEndpoint.post("generateRecoveryCodes", "/v1/security/recovery-codes", {
      success: RecoveryCodes.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("enrollTotp", "/v1/security/totp", {
      success: TotpEnrollment.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.post("confirmTotp", "/v1/security/totp/confirm", {
      payload: TotpCodeRequest,
      success: TotpEnabled,
    }),
    HttpApiEndpoint.delete("disableTotp", "/v1/security/totp", { success: TotpDisabled }),
    HttpApiEndpoint.get("listPasskeys", "/v1/security/passkeys", { success: PasskeyList }),
    /** Adding a passkey: step-up, then a registration ceremony bound to this user. */
    HttpApiEndpoint.post("passkeyChallenge", "/v1/security/passkeys/challenge", {
      success: PasskeyChallenge,
    }),
    HttpApiEndpoint.post("addPasskey", "/v1/security/passkeys", {
      payload: AddPasskeyRequest,
      success: PasskeyAdded.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("removePasskey", "/v1/security/passkeys/:id", {
      params: id,
      success: PasskeyRemoved,
    }),
    /** Browser sessions (desktop/mobile OAuth devices are under /v1/devices). */
    HttpApiEndpoint.get("listSessions", "/v1/security/sessions", { success: SessionList }),
    HttpApiEndpoint.delete("revokeSession", "/v1/security/sessions/:id", {
      params: id,
      success: RevocationResult,
    }),

    // ---- support access: time-limited user consent, audited (§10) ----
    HttpApiEndpoint.get("listSupportGrants", "/v1/support-access", { success: SupportGrantList }),
    HttpApiEndpoint.post("grantSupportAccess", "/v1/support-access", {
      payload: SupportGrantRequest,
      success: SupportGrantCreated.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("revokeSupportGrant", "/v1/support-access/:id", {
      params: id,
      success: RevocationResult,
    }),

    // ---- referrals (A02) ----
    HttpApiEndpoint.get("referral", "/v1/referral", { success: ReferralView }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
