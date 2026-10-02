// Identity, credential and security-settings routes (A03, X02). All are conventional JSON
// endpoints (../spec/identity.ts); none remain native routes.
import { Effect, type Types } from "effect";
import { issueApiToken, NotFound, Principal, requireStepUp } from "@bye/application";
import { AuthService, CommerceService, SupportService } from "@bye/platform-cloudflare";
import { HttpApiBuilder } from "effect/http-api";
import { Invocation } from "../http.ts";
import { publicly } from "../httpapi.ts";
import { CoreApi } from "../spec/index.ts";
import { closeLiveSockets, ctl, releaseCredential, requireUser } from "./common.ts";

export const IdentityHandlers = HttpApiBuilder.group(CoreApi, "identity", (handlers) =>
  handlers
    // ---- identity ----
    .handle("me", () =>
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
      }).pipe(publicly),
    )
    .handle("createToken", ({ payload }) => {
      const input: Types.Mutable<Parameters<typeof issueApiToken>[0]> = {
        kind: payload.kind ?? "agent",
        label: payload.label,
      };

      if (payload.scopes) input.scopes = payload.scopes;

      if (payload.expiresAt !== undefined) input.expiresAt = payload.expiresAt;

      return issueApiToken(input).pipe(publicly);
    })
    .handle("listTokens", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return { items: yield* auth.listApiTokens(p.userId) };
      }).pipe(publicly),
    )
    .handle("revokeToken", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const p = yield* requireUser();
        const auth = yield* AuthService;

        if (!(yield* auth.revokeApiToken(p.userId, params.id)))
          return yield* new NotFound({ resource: "token" });
        yield* Effect.promise(() => closeLiveSockets(env, p.userId, params.id));

        return { revoked: true };
      }).pipe(publicly),
    )

    // ---- security settings (A03) ----
    .handle("securityStatus", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return yield* auth.securityStatus(p.userId);
      }).pipe(publicly),
    )
    .handle("generateRecoveryCodes", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("recovery");
        const auth = yield* AuthService;

        return { codes: yield* auth.generateRecoveryCodes(p.userId) };
      }).pipe(publicly),
    )
    .handle("enrollTotp", () =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
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
      }).pipe(publicly),
    )
    .handle("confirmTotp", ({ payload }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;
        yield* auth.confirmTotp(p.userId, payload.code);

        return { enabled: true };
      }).pipe(publicly),
    )
    .handle("disableTotp", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;

        return { disabled: yield* auth.disableTotp(p.userId) };
      }).pipe(publicly),
    )
    .handle("listPasskeys", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const auth = yield* AuthService;

        return { items: yield* auth.listPasskeys(p.userId) };
      }).pipe(publicly),
    )
    .handle("passkeyChallenge", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;

        return yield* auth.beginChallenge("register", p.userId);
      }).pipe(publicly),
    )
    .handle("addPasskey", ({ payload }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;

        const id = yield* auth.registerPasskey(
          p.userId,
          payload.challengeId,
          payload.response,
          payload.label ?? "",
        );

        return { id };
      }).pipe(publicly),
    )
    .handle("removePasskey", ({ params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("credentials");
        const auth = yield* AuthService;
        yield* auth.removePasskey(p.userId, params.id);

        return { removed: true };
      }).pipe(publicly),
    )
    .handle("listSessions", () =>
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
      }).pipe(publicly),
    )
    .handle("revokeSession", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const p = yield* requireUser();
        const auth = yield* AuthService;

        if (!(yield* auth.revokeSession(p.userId, params.id)))
          return yield* new NotFound({ resource: "session" });
        yield* Effect.promise(() => releaseCredential(env, p.userId, params.id));

        return { revoked: true };
      }).pipe(publicly),
    )

    // ---- support access: time-limited user consent, audited (§10) ----
    .handle("listSupportGrants", () =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const support = yield* SupportService;

        return { items: yield* support.list(p.userId) };
      }).pipe(publicly),
    )
    .handle("grantSupportAccess", ({ payload }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        yield* requireStepUp("sharing");
        const support = yield* SupportService;

        return yield* support.grant(p.userId, payload.reason, payload.hours ?? 24);
      }).pipe(publicly),
    )
    .handle("revokeSupportGrant", ({ params }) =>
      Effect.gen(function* () {
        const p = yield* requireUser();
        const support = yield* SupportService;

        if (!(yield* support.revoke(p.userId, params.id)))
          return yield* new NotFound({ resource: "support grant" });

        return { revoked: true };
      }).pipe(publicly),
    )

    // ---- referrals (A02) ----
    .handle("referral", () =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const p = yield* requireUser();
        const commerce = yield* CommerceService;
        const code = yield* commerce.referralCode(p.userId);

        return { code, url: `${env.APP_ORIGIN}/signup?ref=${code}` };
      }).pipe(publicly),
    ),
);
