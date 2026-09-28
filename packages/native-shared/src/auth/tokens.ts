import { Predicate } from "effect";
import type { JsonObject, JsonValue } from "../json.ts";

// Token endpoint client (RFC 6749 §4.1.3, §6; RFC 7009). Distinguishes definitive OAuth errors,
// which end the session, from transient network/server failures, which must preserve credentials.

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scope: string;
}

export type OAuthErrorCode =
  | "invalid_grant"
  | "invalid_request"
  | "invalid_client"
  | "unsupported_grant_type"
  | "unauthorized_client"
  | "access_denied";

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(readonly code: OAuthErrorCode | (string & {})) {
    super(`authorization server rejected the request: ${code}`);
  }
}

/** Network unavailable, timeout, 429 or 5xx: retryable, credentials are kept. */
export class TransientAuthError extends Error {
  override readonly name = "TransientAuthError";
  constructor(readonly detail: string) {
    super(`temporarily unable to reach sign-in service (${detail})`);
  }
}

export type TokenFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    /** Credentials are never re-sent to a redirect target. */
    redirect?: "error";
    credentials?: "omit";
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** The validated endpoint set this client may send credentials to (and nowhere else). */
export interface TokenEndpoints {
  readonly token: string;
  readonly revocation: string | null;
}

/** The instance has no revocation endpoint: sign-out is local only and reported as such. */
export class RevocationUnsupported extends Error {
  override readonly name = "RevocationUnsupported";
}

const form = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

export class TokenClient {
  constructor(
    readonly endpoints: TokenEndpoints,
    private readonly clientId: string,
    private readonly fetchImpl: TokenFetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async post(url: string, values: Record<string, string>): Promise<JsonObject> {
    let response: { status: number; text(): Promise<string> };

    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form(values),
      });
    } catch (error) {
      throw new TransientAuthError(error instanceof Error ? error.name : "network");
    }

    const text = await response.text().catch(() => "");

    if (response.status >= 300 && response.status < 400) throw new OAuthError("invalid_request");

    if (response.status === 429 || response.status >= 500)
      throw new TransientAuthError(`HTTP ${response.status}`);
    let data: JsonObject = {};

    try {
      const parsed: JsonValue = text ? JSON.parse(text) : {};
      data = Predicate.isObject(parsed) ? parsed : {};
    } catch {
      if (response.status >= 400) throw new OAuthError("invalid_request");
    }

    if (response.status >= 400)
      throw new OAuthError(Predicate.isString(data.error) ? data.error : "invalid_request");

    return data;
  }

  private tokenSet(d: JsonObject): TokenSet {
    if (
      !Predicate.isString(d.access_token) ||
      !Predicate.isString(d.refresh_token) ||
      !Predicate.isString(d.token_type) ||
      d.token_type.toLowerCase() !== "bearer"
    ) {
      throw new OAuthError("invalid_request");
    }

    const expiresIn = Predicate.isNumber(d.expires_in) && d.expires_in > 0 ? d.expires_in : 900;

    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresAt: this.now() + expiresIn * 1000,
      scope: Predicate.isString(d.scope) ? d.scope : "",
    };
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
  }): Promise<TokenSet> {
    return this.tokenSet(
      await this.post(this.endpoints.token, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.clientId,
        code_verifier: input.verifier,
      }),
    );
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenSet(
      await this.post(this.endpoints.token, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
      }),
    );
  }

  async revoke(refreshToken: string): Promise<void> {
    if (!this.endpoints.revocation) throw new RevocationUnsupported("no revocation endpoint");
    await this.post(this.endpoints.revocation, {
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: this.clientId,
    });
  }
}
