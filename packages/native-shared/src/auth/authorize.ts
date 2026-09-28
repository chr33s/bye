import { parseUrl, withQuery } from "./url.ts";
import {
  codeChallengeS256,
  constantTimeEqual,
  createCodeVerifier,
  createState,
  type RandomBytes,
  secureRandom,
} from "./pkce.ts";

// Browser authorization request and callback validation (RFC 8252, RFC 7636, RFC 9700).
// The passkey ceremony runs in the system browser on the product's HTTPS origin; the app only
// ever sees a short-lived authorization code on its registered callback.

export const DESKTOP_CLIENT_ID = "bye-desktop";

/** iOS/Android: same PKCE device-session flow, registered as its own client. */
export const MOBILE_CLIENT_ID = "bye-mobile";

export const CUSTOM_SCHEME_REDIRECT = "bye://oauth/callback";

export const loopbackRedirect = (port: number): string => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("invalid loopback port");

  return `http://127.0.0.1:${port}/oauth/callback`;
};

export const isAllowedRedirect = (uri: string): boolean =>
  uri === CUSTOM_SCHEME_REDIRECT || /^http:\/\/127\.0\.0\.1:(\d{4,5})\/oauth\/callback$/.test(uri);

/** What an attempt is bound to: the instance, its issuer and its authorization endpoint. */
export interface AuthorizationTarget {
  readonly key: string;
  readonly issuer: string;
  readonly endpoints: { readonly authorization: string };
}

/** Browser attempts older than this are refused (the server's codes live far shorter). */
export const ATTEMPT_TTL_MS = 10 * 60_000;

/** An authorization callback URL (never navigation, never an instance handoff). */
export const isAuthCallback = (url: string): boolean => {
  const parsed = parseUrl(url);

  return parsed !== null && isAllowedRedirect(parsed.base);
};

export interface AuthorizationAttempt {
  readonly id: string;
  /** The instance the attempt started on; the code is redeemed only there. */
  readonly instanceKey: string;
  /** RFC 9207: the callback must name exactly this issuer. */
  readonly issuer: string;
  readonly clientId: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly url: string;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export const createAuthorizationAttempt = (input: {
  readonly instance: AuthorizationTarget;
  readonly redirectUri: string;
  readonly deviceName: string;
  readonly now: number;
  readonly random?: RandomBytes;
  /** Registered client; must match the one the token exchange uses. Defaults to desktop. */
  readonly clientId?: string;
}): AuthorizationAttempt => {
  if (!isAllowedRedirect(input.redirectUri)) throw new Error("unregistered redirect URI");
  const random = input.random ?? secureRandom;
  const verifier = createCodeVerifier(random);
  const state = createState(random);
  const clientId = input.clientId ?? DESKTOP_CLIENT_ID;

  const url = withQuery(input.instance.endpoints.authorization, [
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", input.redirectUri],
    ["code_challenge", codeChallengeS256(verifier)],
    ["code_challenge_method", "S256"],
    ["state", state],
    ["device_name", input.deviceName.slice(0, 64)],
  ]);

  return {
    id: state.slice(0, 8),
    instanceKey: input.instance.key,
    issuer: input.instance.issuer,
    clientId,
    state,
    verifier,
    redirectUri: input.redirectUri,
    url,
    startedAt: input.now,
    expiresAt: input.now + ATTEMPT_TTL_MS,
  };
};

export type CallbackResult =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Denied"; readonly error: string }
  | {
      readonly _tag: "Ignored";
      readonly reason: "not-a-callback" | "state-mismatch" | "no-attempt";
    }
  | { readonly _tag: "Invalid"; readonly reason: string };

/**
 * Validate a callback against the current attempt. A callback from an older or foreign attempt is
 * ignored (never resumes it); only the exact registered redirect with matching state, the attempt's
 * exact issuer (RFC 9207 mix-up defense) and an unexpired attempt yields a code.
 */
export const parseCallback = (
  url: string,
  attempt: AuthorizationAttempt | null,
  now: number = Date.now(),
): CallbackResult => {
  const parsed = parseUrl(url);

  if (!parsed) return { _tag: "Ignored", reason: "not-a-callback" };
  const normalized = parsed.base;

  if (!isAllowedRedirect(normalized)) return { _tag: "Ignored", reason: "not-a-callback" };

  if (!attempt) return { _tag: "Ignored", reason: "no-attempt" };

  if (normalized !== attempt.redirectUri) return { _tag: "Ignored", reason: "not-a-callback" };
  const state = parsed.query.get("state") ?? "";

  if (!constantTimeEqual(state, attempt.state))
    return { _tag: "Ignored", reason: "state-mismatch" };
  // RFC 9207 §2.4: a missing or different `iss` means the response may come from another
  // instance's authorization server; nothing from it is used, not even an error.
  const iss = parsed.query.get("iss");

  if (iss === undefined) return { _tag: "Invalid", reason: "missing issuer" };

  if (iss !== attempt.issuer) return { _tag: "Invalid", reason: "issuer mismatch" };

  if (now > attempt.expiresAt) return { _tag: "Invalid", reason: "expired attempt" };
  const error = parsed.query.get("error");

  if (error) return { _tag: "Denied", error };

  // Tokens must never arrive on the callback URL (RFC 9700 §2.1.2).
  if (
    parsed.query.has("access_token") ||
    parsed.query.has("refresh_token") ||
    parsed.fragment.includes("token")
  ) {
    return { _tag: "Invalid", reason: "tokens in callback" };
  }

  const code = parsed.query.get("code");

  if (!code || code.length < 8 || code.length > 512)
    return { _tag: "Invalid", reason: "missing code" };

  return { _tag: "Code", code };
};
