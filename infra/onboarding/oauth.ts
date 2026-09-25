// Cloudflare OAuth for deployment management (spec.md §15.11 step 2). Authorization-code grant
// with PKCE (S256), exchanged server-side; the callback is valid once, only for the operator
// session that started it, and only before it expires. Tokens never leave this module's callers
// except sealed at rest (seal.ts); errors carry provider error codes, never token material.
import { createHash, randomBytes } from "node:crypto";
import { forbiddenScopes, requestedScopes } from "./scopes.ts";
import { encode } from "./seal.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface OAuthConfig {
  readonly clientId: string;
  /** Confidential-client secret, when Bye's registration issues one. Sent only to the token endpoint. */
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
  readonly scopes: ReadonlyArray<string>;
}

/** Cloudflare's dashboard OAuth endpoints (the ones Wrangler uses). Client registration is an open decision. */
export const CLOUDFLARE_OAUTH = {
  authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  revokeUrl: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

export const cloudflareOAuthConfig = (
  clientId: string,
  redirectUri: string,
  clientSecret?: string,
): OAuthConfig => ({
  clientId,
  redirectUri,
  ...(clientSecret ? { clientSecret } : {}),
  ...CLOUDFLARE_OAUTH,
  scopes: requestedScopes(),
});

/** Ten minutes from redirect to callback. */
export const PENDING_TTL_MS = 10 * 60_000;

export interface PendingAuthorization {
  readonly state: string;
  readonly verifier: string;
  readonly sessionId: string;
  readonly installationId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch ms; null when the provider did not say. */
  readonly expiresAt: number | null;
  readonly scopes: ReadonlyArray<string>;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64url = (b: Buffer) => encode(b, "base64url");

export const beginAuthorization = (
  config: OAuthConfig,
  binding: { readonly sessionId: string; readonly installationId: string },
  now: number,
  random: (n: number) => Buffer = randomBytes,
): { readonly url: string; readonly pending: PendingAuthorization } => {
  const state = b64url(random(32));
  const verifier = b64url(random(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    url: url.toString(),
    pending: {
      state,
      verifier,
      ...binding,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    },
  };
};

export type CallbackCheck =
  | { readonly ok: true; readonly code: string; readonly pending: PendingAuthorization }
  | { readonly ok: false; readonly reason: string };

/**
 * `pending` must come from a single-use take of the stored state (store.takePending), so a replayed
 * callback finds nothing. Consent withheld is reported, not retried.
 */
export const checkCallback = (
  pending: PendingAuthorization | null,
  params: URLSearchParams,
  sessionId: string,
  now: number,
): CallbackCheck => {
  if (pending === null) return { ok: false, reason: "unknown or already used authorization state" };
  if (pending.sessionId !== sessionId)
    return { ok: false, reason: "authorization was started in a different session" };
  if (now > pending.expiresAt) return { ok: false, reason: "authorization expired; start again" };
  const error = params.get("error");
  if (error !== null)
    return {
      ok: false,
      reason: error === "access_denied" ? "consent was withheld" : `provider error ${error}`,
    };
  const code = params.get("code");
  if (!code) return { ok: false, reason: "callback carried no authorization code" };
  return { ok: true, code, pending };
};

const tokenRequest = async (
  config: OAuthConfig,
  body: Record<string, string>,
  fetcher: Fetch,
): Promise<TokenSet> => {
  const form = new URLSearchParams({ ...body, client_id: config.clientId });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  let response: Response;
  try {
    response = await fetcher(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OAuthError("unreachable", "the Cloudflare token endpoint could not be reached");
  }
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof json.access_token !== "string") {
    const code = typeof json.error === "string" ? json.error : `http_${response.status}`;
    throw new OAuthError(code, `token request failed (${code})`);
  }
  const scopes =
    typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [...config.scopes];
  const forbidden = forbiddenScopes(scopes);
  if (forbidden.length > 0)
    throw new OAuthError(
      "forbidden_scope",
      `authorization includes out-of-scope permissions (${forbidden.join(", ")})`,
    );
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : null,
    scopes,
  };
};

export const exchangeCode = (
  config: OAuthConfig,
  code: string,
  verifier: string,
  fetcher: Fetch,
): Promise<TokenSet> =>
  tokenRequest(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    },
    fetcher,
  );

export const refreshTokens = async (
  config: OAuthConfig,
  refreshToken: string,
  fetcher: Fetch,
): Promise<TokenSet> => {
  const next = await tokenRequest(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetcher,
  );
  // Providers that don't rotate refresh tokens omit a new one.
  return next.refreshToken === null ? { ...next, refreshToken } : next;
};

/** RFC 7009 revocation. The outcome is reported; a failure never restores access locally. */
export const revokeToken = async (
  config: OAuthConfig,
  token: string,
  hint: "access_token" | "refresh_token",
  fetcher: Fetch,
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  if (!config.revokeUrl) return { ok: false, detail: "provider revocation is not supported" };
  const form = new URLSearchParams({ token, token_type_hint: hint, client_id: config.clientId });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  try {
    const r = await fetcher(config.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, detail: r.ok ? "revoked" : `revocation returned ${r.status}` };
  } catch {
    return { ok: false, detail: "revocation endpoint unreachable" };
  }
};

export const missingScopes = (granted: ReadonlyArray<string>): ReadonlyArray<string> =>
  requestedScopes().filter((s) => !granted.includes(s));
