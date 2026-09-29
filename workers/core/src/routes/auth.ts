// Unauthenticated / differently-authenticated routes: sign-up, passkeys, step-up, recovery, OAuth device sign-in.
import { Match } from "effect";
import {
  ChallengeRequest,
  PasskeyAssertionRequest,
  PasskeyRegistrationRequest,
  RecoveryRequest,
  ShortAddressCheckoutRequest,
  SignupRequest,
  SignupRetryRequest,
  TotpCodeRequest,
} from "@bye/contracts";
import { decodeAs } from "./decode.ts";
import {
  clearSessionCookie,
  ControlDeviceAuth,
  DeviceAuthError,
  formatUserCode,
  isRejection,
  isShortAddress,
  normalizeUserCode,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  UnknownKeyVersion,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, json, readJson, route, type Route } from "../http.ts";
import { controlAdapters } from "../services.ts";
import { issuerOf } from "./discovery.ts";
import {
  authorizeParams,
  closeLiveSockets,
  releaseCredential,
  consentPage,
  currentSession,
  escapeHtml,
  oauthError,
  oauthForm,
  provisionCalendar,
  readTextCapped,
  sameOriginJson,
  serviceDomain,
  signupToken,
  validTimeZone,
  verifySignupToken,
  verifyTurnstile,
} from "./common.ts";
import {
  bootstrapAddressDomain,
  claimBootstrap,
  completeBootstrap,
  releaseBootstrap,
} from "../bootstrap.ts";

/** RFC 8628 §3.4 grant type. */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Per-client-IP rate limit for unauthenticated endpoints; `true` when the request may proceed. */
const allowedForIp = async (env: CoreEnv, request: Request, bucket: string): Promise<boolean> =>
  (
    await env.AUTH_RATE_LIMIT.limit({
      key: `${bucket}:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
    })
  ).success;

/** Refusal for a session-issuing POST that isn't a same-origin JSON request (login CSRF). */
const crossOrigin = () => errorResponse("forbidden", "cross-origin request rejected");

/** Passkey sign-in happens in the web app on this origin, then returns to `url`. */
const signInRedirect = (url: URL) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/?next=${encodeURIComponent(url.pathname + url.search)}`,
      "cache-control": "no-store",
    },
  });

/** Step-up elevates the session, so the cookie token is rotated (fixation defense, A03). */
const rotatedCookie = async (request: Request, env: CoreEnv): Promise<Record<string, string>> => {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);

  if (!token) return {};
  const { auth } = await controlAdapters(env);
  const next = await auth.rotateSession(token).catch(() => null);

  if (!next) return {};
  // The old session is revoked by rotation: sockets it opened close too (the client reconnects
  // with the new cookie), so a later logout can't leave them behind.
  await closeLiveSockets(env, next.session.user_id, next.previousId);

  return { "set-cookie": sessionCookie(next.token) };
};

/**
 * Device auth whose revocations (logout, refresh-token reuse, races) also close live sockets and
 * drop the session's push registrations.
 */
const deviceAuth = (env: CoreEnv) =>
  new ControlDeviceAuth(env.DIRECTORY, kernelClock, (userId, sessionId) =>
    releaseCredential(env, userId, sessionId),
  );

const AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "device_name",
]);

export const authRoutes: ReadonlyArray<Route> = [
  route("POST", "/auth/challenge", async (request, _p, env) => {
    if (!(await allowedForIp(env, request, "auth")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(ChallengeRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const { auth } = await controlAdapters(env);
    const purpose = body.purpose ?? "authenticate";

    return json(await auth.beginChallenge(purpose));
  }),
  route("POST", "/auth/signup", async (request, _p, env) => {
    const ip = request.headers.get("cf-connecting-ip") ?? "anon";
    const limited = await env.AUTH_RATE_LIMIT.limit({ key: `signup:${ip}` });

    if (!limited.success) return errorResponse("rate_limited", "slow down");
    const body = decodeAs(SignupRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const address = body.address.trim().toLowerCase();
    // The first account of an onboarding installation proves itself with the bootstrap token.
    const bootstrap = body.bootstrap !== undefined;
    // Personal signup only allocates addresses on the service domain; customer-domain addresses are
    // provisioned by that organization (O01). The bootstrap account instead uses the domain chosen
    // in onboarding (BOOTSTRAP_ADDRESS_DOMAIN), enforced here; the setup link's fragment is display
    // input only.
    const addressDomain = bootstrap ? bootstrapAddressDomain(env) : serviceDomain(env);

    if (address.split("@")[1] !== addressDomain)
      return errorResponse(
        "bad_request",
        bootstrap
          ? `choose an address on ${addressDomain}`
          : "choose an address on the service domain",
      );

    if (body.timeZone !== undefined && !validTimeZone(body.timeZone))
      return errorResponse("bad_request", "invalid time zone");

    if (bootstrap) {
      if (!(await claimBootstrap(env, body.bootstrap!, Date.now())))
        return errorResponse("forbidden", "this setup link is invalid or was already used");
    } else if (!(await verifyTurnstile(env, body.turnstile ?? "", ip)))
      return errorResponse("forbidden", "verification failed");
    const { directory, auth, commerce } = await controlAdapters(env);

    // Short addresses are a paid product (A02): only a completed short-address checkout unlocks one.
    if (
      isShortAddress(address) &&
      !(await commerce.shortAddressPaid(address, body.checkoutSessionId))
    ) {
      if (bootstrap) await releaseBootstrap(env);

      return errorResponse("forbidden", "short addresses require purchase", undefined, {
        checkout: "short-address",
      });
    }

    let account;

    try {
      account = await directory.provisionPersonalAccount({
        address,
        displayName: body.displayName ?? "",
      });
    } catch (e) {
      if (bootstrap) await releaseBootstrap(env);
      const code = (e as { code?: string }).code;

      return errorResponse(
        Match.value(code).pipe(
          Match.when("conflict", () => "conflict" as const),
          Match.when("forbidden", () => "forbidden" as const),
          Match.when("bad_request", () => "bad_request" as const),
          Match.orElse(() => "unavailable" as const),
        ),
        "signup failed",
      );
    }

    if (bootstrap) await completeBootstrap(env, account.userId);
    await provisionCalendar(env, account, validTimeZone(body.timeZone)).catch(() => undefined); // retried at passkey registration

    if (body.referralCode)
      await commerce.redeemReferral(account.userId, body.referralCode).catch(() => false);

    if (isShortAddress(address)) {
      // The paid short address survives plan changes and closure (A02/A04).
      await env.DIRECTORY.prepare("UPDATE entitlements SET short_address = 1 WHERE org_id = ?")
        .bind(account.organizationId)
        .run();
    }

    const challenge = await auth.beginChallenge("register", account.userId);

    return json(
      {
        userId: account.userId,
        challenge,
        signupToken: await signupToken(env, account.userId, Date.now()),
      },
      201,
    );
  }),
  // A cancelled or failed passkey ceremony can be retried with the signup token until a passkey exists.
  route("POST", "/auth/signup/challenge", async (request, _p, env) => {
    if (!(await allowedForIp(env, request, "signup-challenge")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(SignupRetryRequest, await readJson(request));

    if (!body) return errorResponse("unauthenticated", "signup expired");
    const userId = body.userId;

    if (!(await verifySignupToken(env, userId, body.signupToken, Date.now())))
      return errorResponse("unauthenticated", "signup expired");

    const existing = await env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT 1 AS k FROM passkeys WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first();

    if (existing) return errorResponse("conflict", "account already has a passkey");
    const { auth } = await controlAdapters(env);

    return json(await auth.beginChallenge("register", userId));
  }),
  route("POST", "/auth/passkey/register", async (request, _p, env) => {
    if (!sameOriginJson(request, env)) return crossOrigin();

    if (!(await allowedForIp(env, request, "register")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(PasskeyRegistrationRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const { auth } = await controlAdapters(env);

    try {
      await auth.registerPasskey(body.userId, body.challengeId, body.response);

      const account = await env.DIRECTORY.withSession("first-primary")
        .prepare(
          "SELECT u.id AS userId, u.primary_address AS address, c.id AS calendarId FROM users u JOIN calendars c ON c.owner_user_id = u.id WHERE u.id = ? LIMIT 1",
        )
        .bind(body.userId)
        .first<{ userId: string; address: string; calendarId: string }>();

      // Provisioning is first-write-wins, so the zone chosen at signup is kept.
      if (account) await provisionCalendar(env, account, validTimeZone(body.timeZone));

      const session = await auth.issueSession(
        body.userId,
        request.headers.get("user-agent")?.slice(0, 120) ?? "",
        true,
      );

      return json({ ok: true }, 201, { "set-cookie": sessionCookie(session.token) });
    } catch {
      return errorResponse("unauthenticated", "registration failed");
    }
  }),
  // Step-up for consequential actions (§10): fresh passkey assertion or TOTP on the current session.
  route("POST", "/auth/step-up/challenge", async (request, _p, env) => {
    const session = await currentSession(request, env);

    if (!session) return errorResponse("unauthenticated", "unauthenticated");
    const { auth } = await controlAdapters(env);

    return json(await auth.beginChallenge("step-up", session.user_id));
  }),
  route("POST", "/auth/step-up/passkey", async (request, _p, env) => {
    const session = await currentSession(request, env);

    if (!session) return errorResponse("unauthenticated", "unauthenticated");
    const body = decodeAs(PasskeyAssertionRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const { auth } = await controlAdapters(env);

    try {
      await auth.stepUpWithPasskey(session.id, body.challengeId, body.response);

      return json({ ok: true }, 200, await rotatedCookie(request, env));
    } catch {
      return errorResponse("unauthenticated", "step-up failed");
    }
  }),
  route("POST", "/auth/step-up/totp", async (request, _p, env) => {
    const session = await currentSession(request, env);

    if (!session) return errorResponse("unauthenticated", "unauthenticated");
    const limited = await env.AUTH_RATE_LIMIT.limit({ key: `stepup:${session.id}` });

    if (!limited.success) return errorResponse("rate_limited", "slow down");
    const body = decodeAs(TotpCodeRequest, await readJson(request));

    if (!body) return errorResponse("unauthenticated", "step-up failed");
    const { auth } = await controlAdapters(env);

    try {
      await auth.stepUpWithTotp(session.id, body.code);

      return json({ ok: true }, 200, await rotatedCookie(request, env));
    } catch (e) {
      // Per-user lockout (control/auth.ts): after TOTP_MAX_FAILURES wrong codes the user's TOTP
      // step-up is refused for TOTP_LOCKOUT_MS, whichever session asks. Attempts are audited.
      const locked = isRejection(e) && e.code === "rate_limited";
      console.warn(
        JSON.stringify({
          level: "warn",
          op: locked ? "auth.totp.locked" : "auth.totp.failed",
          userId: session.user_id,
        }),
      );

      return locked
        ? errorResponse("rate_limited", "too many attempts; try again later")
        : errorResponse("unauthenticated", "step-up failed");
    }
  }),
  route("POST", "/auth/passkey/login", async (request, _p, env) => {
    if (!sameOriginJson(request, env)) return crossOrigin();

    if (!(await allowedForIp(env, request, "login")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(PasskeyAssertionRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const { auth } = await controlAdapters(env);

    try {
      const session = await auth.authenticatePasskey(
        body.challengeId,
        body.response,
        request.headers.get("user-agent")?.slice(0, 120) ?? "",
      );

      return json({ ok: true }, 200, { "set-cookie": sessionCookie(session.token) });
    } catch {
      return errorResponse("unauthenticated", "sign-in failed");
    }
  }),
  route("POST", "/auth/recover", async (request, _p, env) => {
    if (!sameOriginJson(request, env)) return crossOrigin();

    if (!(await allowedForIp(env, request, "recover")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(RecoveryRequest, await readJson(request));

    if (!body) return errorResponse("unauthenticated", "recovery failed");
    const { auth } = await controlAdapters(env);

    try {
      // Recovery is independent of the locked mailbox (A03).
      const session = await auth.recoverWithCode(
        body.address,
        body.code,
        request.headers.get("user-agent")?.slice(0, 120) ?? "",
      );

      await closeLiveSockets(env, session.session.user_id, null);

      return json({ ok: true }, 200, { "set-cookie": sessionCookie(session.token) });
    } catch (e) {
      // A code hashed under a retired SESSION_KEY version is an operator error, not a bad code.
      if (e instanceof UnknownKeyVersion)
        console.error(
          JSON.stringify({ level: "error", op: "auth.recover.key-version", version: e.version }),
        );

      return errorResponse("unauthenticated", "recovery failed");
    }
  }),
  route("POST", "/auth/logout", async (request, _p, env) => {
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);

    if (token) {
      const { auth } = await controlAdapters(env);
      const cred = await auth.authenticate(token).catch(() => null);

      if (cred?.kind === "session") {
        await auth.revokeSession(cred.session.user_id, cred.session.id);
        await releaseCredential(env, cred.session.user_id, cred.session.id);
      }
    }

    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }),
  // Short-address purchase before signup (A02): the signed return lets the browser poll status and
  // then call /auth/signup with the checkout session ID.
  route("POST", "/auth/short-address/checkout", async (request, _p, env) => {
    if (!(await allowedForIp(env, request, "checkout")))
      return errorResponse("rate_limited", "slow down");
    const body = decodeAs(ShortAddressCheckoutRequest, await readJson(request));

    if (!body) return errorResponse("bad_request", "invalid request body");
    const address = body.address.trim().toLowerCase();

    if (address.split("@")[1] !== serviceDomain(env) || !isShortAddress(address))
      return errorResponse("bad_request", "not a short address on the service domain");
    const { commerce } = await controlAdapters(env);

    try {
      const r = await commerce.createCheckout({
        purpose: "short-address",
        plan: "short-address",
        interval: body.interval ?? "annual",
        seats: 1,
        orgId: null,
        userId: null,
        address,
        returnUrl: `${env.APP_ORIGIN}/signup`,
      });

      return json(r, 201);
    } catch (e) {
      // Unauthenticated callers get a generic message; provider/processor detail is logged only.
      const code = isRejection(e) ? e.code : undefined;
      console.warn(
        JSON.stringify({
          level: "warn",
          op: "auth.short-address-checkout",
          code: code ?? "defect",
          detail: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        }),
      );

      return Match.value(code).pipe(
        Match.when("conflict", () => errorResponse("conflict", "address unavailable")),
        Match.when("bad_request", () => errorResponse("bad_request", "invalid checkout request")),
        Match.orElse(() => errorResponse("unavailable", "checkout unavailable")),
      );
    }
  }),
  route("GET", "/auth/checkout/status", async (request, _p, env) => {
    const url = new URL(request.url);
    const { commerce } = await controlAdapters(env);

    try {
      return json(
        await commerce.checkoutStatus(
          url.searchParams.get("checkout") ?? "",
          url.searchParams.get("sig") ?? "",
        ),
      );
    } catch {
      return errorResponse("forbidden", "invalid checkout");
    }
  }),
  // Post-cancellation forwarding destination verification link (A04), sent by email.
  route("GET", "/auth/forwarding/confirm", async (request, _p, env) => {
    const url = new URL(request.url);
    const { lifecycle } = await controlAdapters(env);

    try {
      await lifecycle.confirmForwarding(
        url.searchParams.get("address") ?? "",
        url.searchParams.get("token") ?? "",
      );

      return consentPage(
        "Forwarding confirmed",
        "<p>Mail to your former address will be forwarded here until the forwarding period ends.</p>",
      );
    } catch {
      return consentPage(
        "Link invalid",
        "<p>This forwarding confirmation link is invalid or expired.</p>",
        400,
      );
    }
  }),
  // ---- desktop sign-in: browser-mediated passkey + authorization code with PKCE (A03/X01) ----
  route("GET", "/oauth/authorize", async (request, _p, env) => {
    const url = new URL(request.url);
    const params = authorizeParams(url.searchParams);
    const devices = deviceAuth(env);

    try {
      devices.validateAuthorize(params);
    } catch (e) {
      // Invalid client/redirect: show the error, never redirect to an unverified URI.
      return consentPage(
        "Sign-in request rejected",
        `<p>${escapeHtml((e as Error).message)}</p>`,
        400,
      );
    }

    const session = await currentSession(request, env);

    if (!session) return signInRedirect(url);

    // Only the authorization-request parameters are carried: an attacker-supplied `decision` (or
    // anything else) in the link must never ride along into the consent POST.
    const hidden = [...url.searchParams]
      .flatMap(([k, v]) =>
        AUTHORIZE_PARAMS.has(k)
          ? [`<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`]
          : [],
      )
      .join("");

    const device = params.deviceName ? escapeHtml(params.deviceName) : "the bye desktop app";

    return consentPage(
      "Allow desktop sign-in?",
      `<p>Allow <strong>${device}</strong> to access your mail and calendar on this device? You can revoke it anytime under Devices.</p>
       <form method="post" action="/oauth/authorize">${hidden}
         <button name="decision" value="allow" type="submit">Allow</button>
         <button name="decision" value="deny" type="submit">Cancel</button>
       </form>`,
    );
  }),
  route("POST", "/oauth/authorize", async (request, _p, env) => {
    const session = await currentSession(request, env);

    if (!session)
      return consentPage("Session expired", "<p>Sign in again from the desktop app.</p>", 401);
    // An oversized body reads as an empty form, which validateAuthorize rejects.
    const form = new URLSearchParams((await readTextCapped(request, 8192)) ?? "");
    const params = authorizeParams(form);
    const devices = deviceAuth(env);

    try {
      devices.validateAuthorize(params);
    } catch (e) {
      return consentPage(
        "Sign-in request rejected",
        `<p>${escapeHtml((e as Error).message)}</p>`,
        400,
      );
    }

    const target = new URL(params.redirectUri);

    // The clicked button is the submitter, appended last; never trust an earlier field.
    if (form.getAll("decision").at(-1) !== "allow") {
      target.searchParams.set("error", "access_denied");
    } else {
      target.searchParams.set("code", await devices.issueCode(session.user_id, params));
    }

    target.searchParams.set("state", params.state);
    // RFC 9207: name the issuer so a client talking to several instances redeems the code only at
    // the instance that issued it (mix-up defense).
    target.searchParams.set("iss", issuerOf(env));

    return new Response(null, {
      status: 303,
      headers: {
        location: target.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }),
  route("POST", "/oauth/token", async (request, _p, env) => {
    if (!(await allowedForIp(env, request, "token")))
      return oauthError("invalid_request", "slow down", 429);
    const form = await oauthForm(request);
    const devices = deviceAuth(env);

    try {
      const grant = form.get("grant_type");

      const tokens =
        grant === "authorization_code"
          ? await devices.exchangeCode({
              code: form.get("code") ?? "",
              codeVerifier: form.get("code_verifier") ?? "",
              redirectUri: form.get("redirect_uri") ?? "",
              clientId: form.get("client_id") ?? "",
            })
          : grant === "refresh_token"
            ? await devices.refresh({
                refreshToken: form.get("refresh_token") ?? "",
                clientId: form.get("client_id") ?? "",
              })
            : grant === DEVICE_CODE_GRANT
              ? await devices.pollDeviceCode({
                  deviceCode: form.get("device_code") ?? "",
                  clientId: form.get("client_id") ?? "",
                })
              : await Promise.reject(
                  new DeviceAuthError("unsupported_grant_type", "unsupported grant_type"),
                );

      return json(tokens, 200, { pragma: "no-cache" });
    } catch (e) {
      if (e instanceof DeviceAuthError)
        return oauthError(e.code, e.message, e.code === "invalid_client" ? 401 : 400);
      throw e;
    }
  }),
  // ---- device-authorization grant fallback (DS10, RFC 8628): headless CLI/TUI and similar ----
  route("POST", "/oauth/device_authorization", async (request, _p, env) => {
    if (!(await allowedForIp(env, request, "devauth")))
      return oauthError("slow_down", "slow down", 429);
    const form = await oauthForm(request);

    try {
      const started = await deviceAuth(env).startDeviceAuthorization({
        clientId: form.get("client_id") ?? "",
        deviceName: form.get("device_name") ?? "",
      });

      const verificationUri = `${env.APP_ORIGIN}/device`;

      return json(
        {
          ...started,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.user_code)}`,
        },
        200,
        { pragma: "no-cache" },
      );
    } catch (e) {
      if (e instanceof DeviceAuthError)
        return oauthError(e.code, e.message, e.code === "invalid_client" ? 401 : 400);
      throw e;
    }
  }),
  route("GET", "/device", async (request, _p, env) => {
    const url = new URL(request.url);
    const session = await currentSession(request, env);

    if (!session) return signInRedirect(url);
    const entered = url.searchParams.get("user_code") ?? "";

    // Code lookups are rate-limited per session: user codes are short, so unthrottled probing
    // could find (and deny) other people's pending sign-ins.
    if (entered && !(await env.AUTH_RATE_LIMIT.limit({ key: `device:${session.id}` })).success) {
      return consentPage(
        "Slow down",
        "<p>Too many attempts. Wait a minute and try again.</p>",
        429,
      );
    }

    const pending = entered ? await deviceAuth(env).pendingUserCode(entered) : null;

    if (!pending) {
      return consentPage(
        "Connect a device",
        `${entered ? "<p>That code is invalid or has expired. Check the code on your device and try again.</p>" : "<p>Enter the code shown on your device.</p>"}
         <form method="get" action="/device"><label>Code <input name="user_code" autocomplete="off" autocapitalize="characters" maxlength="12" required></label>
           <button type="submit">Continue</button></form>`,
        entered ? 400 : 200,
      );
    }

    const device = pending.deviceName
      ? escapeHtml(pending.deviceName)
      : escapeHtml(pending.clientId);

    return consentPage(
      "Allow this device?",
      `<p>Allow <strong>${device}</strong> (code <strong>${escapeHtml(formatUserCode(normalizeUserCode(entered)))}</strong>) to access your mail and calendar? Only continue if you started this sign-in yourself. You can revoke it anytime under Devices.</p>
       <form method="post" action="/device"><input type="hidden" name="user_code" value="${escapeHtml(normalizeUserCode(entered))}">
         <button name="decision" value="allow" type="submit">Allow</button>
         <button name="decision" value="deny" type="submit">Deny</button>
       </form>`,
    );
  }),
  route("POST", "/device", async (request, _p, env) => {
    // currentSession enforces the same-origin CSRF check for cookie-authenticated posts.
    const session = await currentSession(request, env);

    if (!session)
      return consentPage("Session expired", "<p>Sign in again, then re-enter the code.</p>", 401);

    if (!(await env.AUTH_RATE_LIMIT.limit({ key: `device:${session.id}` })).success) {
      return consentPage(
        "Slow down",
        "<p>Too many attempts. Wait a minute and try again.</p>",
        429,
      );
    }

    // An oversized body reads as an empty form: no user code, so nothing is decided.
    const form = new URLSearchParams((await readTextCapped(request, 4096)) ?? "");
    const allow = form.getAll("decision").at(-1) === "allow";

    const ok = await deviceAuth(env).decideUserCode(
      session.user_id,
      form.get("user_code") ?? "",
      allow,
    );

    if (!ok)
      return consentPage(
        "Code expired",
        "<p>That code is invalid or has expired. Start again on your device.</p>",
        400,
      );

    return consentPage(
      allow ? "Device connected" : "Request denied",
      allow ? "<p>You can return to your device.</p>" : "<p>The device was not given access.</p>",
    );
  }),
  route("POST", "/oauth/revoke", async (request, _p, env) => {
    const form = await oauthForm(request);
    const token = form.get("token");

    if (token) await deviceAuth(env).revokeToken(token);

    return json({}, 200);
  }),
];
