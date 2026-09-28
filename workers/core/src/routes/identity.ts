// Identity, credential and security-settings routes (A03, X02).
import { Effect, type Types } from "effect";
import { issueApiToken, NotFound, Principal, requireStepUp } from "@bye/application";
import { AuthService, CommerceService, SupportService } from "@bye/platform-cloudflare";
import type { CoreEnv } from "../env.ts";
import { route, type Route } from "../http.ts";
import {
  AddPasskeyRequest,
  CreateApiTokenRequest,
  SupportGrantRequest,
  TotpCodeRequest,
} from "@bye/contracts";
import { authed, authedBody, closeLiveSockets, ctl, requireUser } from "./common.ts";

export const identityRoutes: ReadonlyArray<Route<CoreEnv>> = [
  // ---- identity ----
  route(
    "GET",
    "/v1/me",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* Principal;

        return {
          userId: p.userId,
          kind: p.kind,
          scopes: p.scopes,
          mailboxIds: p.mailboxIds,
          calendarIds: p.calendarIds,
          organizationIds: p.organizationIds,
        };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/tokens",
    authedBody(
      CreateApiTokenRequest,
      ({ body }) => {
        const input: Types.Mutable<Parameters<typeof issueApiToken>[0]> = {
          kind: body.kind ?? "agent",
          label: body.label,
        };

        if (body.scopes) input.scopes = body.scopes;

        if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt;

        return issueApiToken(input);
      },
      { status: 201 },
    ),
  ),
  route(
    "GET",
    "/v1/tokens",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return { items: yield* auth.listApiTokens(p.userId) };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/tokens/:id",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        if (!(yield* auth.revokeApiToken(p.userId, params.id!)))
          return yield* new NotFound({ resource: "token" });
        yield* Effect.promise(() => closeLiveSockets(env, p.userId, params.id!));

        return { revoked: true };
      }),
    ),
  ),

  // ---- security settings (A03) ----
  route(
    "GET",
    "/v1/security",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return yield* auth.securityStatus(p.userId);
      }),
    ),
  ),
  // Recovery codes are shown exactly once; generating a new set invalidates the old set.
  route(
    "POST",
    "/v1/security/recovery-codes",
    authed(
      () =>
        Effect.gen(function* () {
          const p = yield* requireUser();
          yield* requireStepUp("recovery");
          const auth = yield* AuthService;

          return { codes: yield* auth.generateRecoveryCodes(p.userId) };
        }),
      { status: 201 },
    ),
  ),
  route(
    "POST",
    "/v1/security/totp",
    authed(
      ({ env }) =>
        Effect.gen(function* () {
          const p = yield* requireUser();
          yield* requireStepUp("credentials");
          const auth = yield* AuthService;
          const { secret } = yield* auth.enrollTotp(p.userId);

          const { address } = yield* ctl(() =>
            env.DIRECTORY.prepare("SELECT primary_address AS address FROM users WHERE id = ?")
              .bind(p.userId)
              .first<{ address: string }>()
              .then((r) => r ?? { address: p.userId }),
          );

          const issuer = new URL(env.APP_ORIGIN).hostname;

          return {
            secret,
            otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${address}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
          };
        }),
      { status: 201 },
    ),
  ),
  route(
    "POST",
    "/v1/security/totp/confirm",
    authedBody(TotpCodeRequest, ({ body }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;
        yield* auth.confirmTotp(p.userId, body.code);

        return { enabled: true };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/security/totp",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;

        return { disabled: yield* auth.disableTotp(p.userId) };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/security/passkeys",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return { items: yield* auth.listPasskeys(p.userId) };
      }),
    ),
  ),
  // Adding a passkey: step-up, then a registration ceremony bound to this user.
  route(
    "POST",
    "/v1/security/passkeys/challenge",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;

        return yield* auth.beginChallenge("register", p.userId);
      }),
    ),
  ),
  route(
    "POST",
    "/v1/security/passkeys",
    authedBody(
      AddPasskeyRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const p = yield* requireUser();
          yield* requireStepUp("credentials");
          const auth = yield* AuthService;

          const id = yield* auth.registerPasskey(
            p.userId,
            body.challengeId,
            body.response,
            body.label ?? "",
          );

          return { id };
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/security/passkeys/:id",
    authed(({ params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;
        yield* auth.removePasskey(p.userId, params.id!);

        return { removed: true };
      }),
    ),
  ),
  // Browser sessions (desktop/mobile OAuth devices are under /v1/devices).
  route(
    "GET",
    "/v1/security/sessions",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;
        const rows = yield* auth.listSessions(p.userId);

        return {
          items: rows.map((s) => ({
            id: s.id,
            device: s.device,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            expiresAt: s.expires_at,
            current: s.id === p.sessionId,
          })),
        };
      }),
    ),
  ),
  route(
    "DELETE",
    "/v1/security/sessions/:id",
    authed(({ env, params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        if (!(yield* auth.revokeSession(p.userId, params.id!)))
          return yield* new NotFound({ resource: "session" });
        yield* Effect.promise(() => closeLiveSockets(env, p.userId, params.id!));

        return { revoked: true };
      }),
    ),
  ),

  // ---- support access: time-limited user consent, audited (§10) ----
  route(
    "GET",
    "/v1/support-access",
    authed(() =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const support = yield* SupportService;

        return { items: yield* support.list(p.userId) };
      }),
    ),
  ),
  route(
    "POST",
    "/v1/support-access",
    authedBody(
      SupportGrantRequest,
      ({ body }) =>
        Effect.gen(function* () {
          const p = yield* requireUser();
          yield* requireStepUp("sharing");
          const support = yield* SupportService;

          return yield* support.grant(p.userId, body.reason, body.hours ?? 24);
        }),
      { status: 201 },
    ),
  ),
  route(
    "DELETE",
    "/v1/support-access/:id",
    authed(({ params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const support = yield* SupportService;

        if (!(yield* support.revoke(p.userId, params.id!)))
          return yield* new NotFound({ resource: "support grant" });

        return { revoked: true };
      }),
    ),
  ),

  // ---- referrals (A02) ----
  route(
    "GET",
    "/v1/referral",
    authed(({ env }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const commerce = yield* CommerceService;
        const code = yield* commerce.referralCode(p.userId);

        return { code, url: `${env.APP_ORIGIN}/signup?ref=${code}` };
      }),
    ),
  ),
];
