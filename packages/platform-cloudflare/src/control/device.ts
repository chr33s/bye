import type { KernelClock } from "../durable/kernel.ts";
import { randomToken, sha256, sha256Hex, toBase64Url } from "./crypto.ts";
import { audit, changesOf, type D1Like, primary, q } from "./d1.ts";
import { guardD1 } from "./errors.ts";

// Browser-mediated desktop sign-in (A03/X01). The passkey ceremony happens in the system browser on
// the product's HTTPS origin; the desktop app receives a short-lived, single-use authorization code
// bound to a PKCE S256 challenge (RFC 8252, RFC 7636) and exchanges it for its own revocable device
// session. Refresh credentials rotate on every use, and replaying a rotated one revokes the whole
// device session (RFC 9700 §4.14). Only hashes are persisted.

export interface DeviceClient {
  readonly clientId: string;
  /** Exact redirect URIs; loopback redirects match any port (RFC 8252 §7.3). */
  readonly redirects: ReadonlyArray<string>;
  readonly loopbackPath: string | undefined;
}

export const DEVICE_CLIENTS: ReadonlyArray<DeviceClient> = [
  { clientId: "bye-desktop", redirects: ["bye://oauth/callback"], loopbackPath: "/oauth/callback" },
  // Mobile: system browser (ASWebAuthenticationSession / Custom Tab) back to the app scheme.
  { clientId: "bye-mobile", redirects: ["bye://oauth/callback"], loopbackPath: undefined },
  // Input-constrained clients (CLI/TUI on a headless host): device-authorization grant only.
  { clientId: "bye-cli", redirects: [], loopbackPath: undefined },
];

/** Clients allowed to use the device-authorization grant (RFC 8628). */
export const DEVICE_GRANT_CLIENTS: ReadonlyArray<string> = ["bye-cli", "bye-desktop", "bye-mobile"];

export const DEVICE_CODE_TTL_MS = 2 * 60_000;
export const DEVICE_ACCESS_TTL_MS = 15 * 60_000;
export const DEVICE_IDLE_TTL_MS = 30 * 24 * 3600_000;
export const DEVICE_ABSOLUTE_TTL_MS = 180 * 24 * 3600_000;
/** RFC 8628: device code lifetime and minimum polling interval. */
export const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
/** RFC 8628 §6.1: consonants only (no vowels, no ambiguous characters), shown as XXXX-XXXX. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export type DeviceTokenError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token";

export class DeviceAuthError extends Error {
  override readonly name = "DeviceAuthError";
  constructor(
    readonly code: DeviceTokenError,
    message: string,
  ) {
    super(message);
  }
}

const fail = (code: DeviceTokenError, message: string): never => {
  throw new DeviceAuthError(code, message);
};

export interface AuthorizeParams {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly state: string;
  readonly deviceName: string;
}

export interface DeviceTokens {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface DeviceSessionView {
  readonly id: string;
  readonly clientId: string;
  readonly deviceName: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

const B64URL_43_128 = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 §4.6: BASE64URL(SHA256(ASCII(code_verifier))). */
export const pkceChallenge = async (verifier: string): Promise<string> =>
  toBase64Url(await sha256(verifier));

const clientFor = (clientId: string) => DEVICE_CLIENTS.find((c) => c.clientId === clientId);

/** Canonical form of a user-entered code: uppercase letters only (hyphens/spaces dropped). */
export const normalizeUserCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z]/g, "");

/** Eight unbiased draws from the 20-letter alphabet (rejection sampling). */
const newUserCode = (): string => {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && out.length < 8) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
    }
  }
  return out;
};

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** Exact match, or a loopback IP literal with any port and the registered path (never "localhost"). */
export const redirectAllowed = (client: DeviceClient, redirectUri: string): boolean => {
  if (client.redirects.includes(redirectUri)) return true;
  if (!client.loopbackPath) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
    url.pathname === client.loopbackPath &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
};

export class ControlDeviceAuth {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    /** Called after a device session is revoked (any reason), e.g. to close its live sockets. Best effort. */
    readonly onRevoked?: (userId: string, sessionId: string) => Promise<void>,
  ) {}

  /**
   * Validate an authorization request before anything is shown to the user. Invalid client or
   * redirect errors must be displayed, never redirected (RFC 6749 §4.1.2.1).
   */
  validateAuthorize(p: AuthorizeParams): { readonly client: DeviceClient } {
    const client = clientFor(p.clientId) ?? fail("invalid_client", "unknown client");
    if (!redirectAllowed(client, p.redirectUri))
      fail("invalid_request", "redirect_uri not registered");
    if (p.responseType !== "code") fail("invalid_request", "response_type must be code");
    if (p.codeChallengeMethod !== "S256" || !B64URL_43_128.test(p.codeChallenge))
      fail("invalid_request", "PKCE S256 challenge required");
    if (p.state.length < 16 || p.state.length > 256) fail("invalid_request", "state required");
    return { client };
  }

  /** Issue a single-use authorization code for an interactively approved request. */
  async issueCode(userId: string, p: AuthorizeParams): Promise<string> {
    this.validateAuthorize(p);
    const code = randomToken(32);
    const now = this.clock.now();
    const codeHash = await sha256Hex(code);
    await guardD1("oauth-code", () =>
      q(
        this.db,
        "INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        codeHash,
        userId,
        p.clientId,
        p.redirectUri,
        p.codeChallenge,
        p.deviceName.slice(0, 120),
        now,
        now + DEVICE_CODE_TTL_MS,
      ).run(),
    );
    return code;
  }

  /**
   * Fresh access + refresh credentials for a session. `chained`: each statement runs only if the
   * statement before it in the batch changed a row (`changes() > 0`), so the credentials are issued
   * only when a preceding compare-and-set (refresh rotation) landed.
   */
  private async newTokens(
    sessionId: string,
    chained = false,
  ): Promise<{
    readonly tokens: DeviceTokens;
    readonly statements: ReadonlyArray<ReturnType<typeof q>>;
  }> {
    const now = this.clock.now();
    const guard = chained ? " AND changes() > 0" : "";
    const access = `bda_${randomToken(32)}`;
    const refresh = `bdr_${randomToken(32)}`;
    return {
      tokens: {
        access_token: access,
        token_type: "Bearer",
        expires_in: DEVICE_ACCESS_TTL_MS / 1000,
        refresh_token: refresh,
        scope: "mail calendar",
      },
      statements: [
        q(
          this.db,
          `INSERT INTO device_access_tokens (token_hash, session_id, expires_at) SELECT ?, ?, ? WHERE 1${guard}`,
          await sha256Hex(access),
          sessionId,
          now + DEVICE_ACCESS_TTL_MS,
        ),
        q(
          this.db,
          `INSERT INTO device_refresh_tokens (token_hash, session_id, created_at) SELECT ?, ?, ? WHERE 1${guard}`,
          await sha256Hex(refresh),
          sessionId,
          now,
        ),
        q(
          this.db,
          `UPDATE device_sessions SET last_used_at = ?, idle_expires_at = MIN(absolute_expires_at, ?) WHERE id = ?${guard}`,
          now,
          now + DEVICE_IDLE_TTL_MS,
          sessionId,
        ),
      ],
    };
  }

  /** Exchange a code (single use, PKCE-verified, redirect- and client-bound) for a device session. */
  async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly clientId: string;
  }): Promise<DeviceTokens> {
    if (!clientFor(input.clientId)) fail("invalid_client", "unknown client");
    if (!VERIFIER.test(input.codeVerifier)) fail("invalid_request", "invalid code_verifier");
    const hash = await sha256Hex(input.code);
    const now = this.clock.now();
    const row = await guardD1("oauth-code", () =>
      q(
        primary(this.db),
        "SELECT user_id, client_id, redirect_uri, code_challenge, device_name, expires_at, consumed_at, session_id FROM oauth_codes WHERE code_hash = ?",
        hash,
      ).first<{
        user_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        device_name: string;
        expires_at: number;
        consumed_at: number | null;
        session_id: string | null;
      }>(),
    );
    if (!row) return fail("invalid_grant", "unknown code");
    if (row.consumed_at !== null) {
      // Replayed code: revoke anything it issued (RFC 6749 §4.1.2).
      if (row.session_id) await this.revokeSession(row.session_id, "code-replay");
      return fail("invalid_grant", "code already used");
    }
    // Atomically consume before any further checks so concurrent redemptions cannot both succeed.
    const consumed = await q(
      this.db,
      "UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL",
      now,
      hash,
    ).run();
    if (consumed.meta.changes !== 1) return fail("invalid_grant", "code already used");
    if (row.expires_at < now) return fail("invalid_grant", "code expired");
    if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri)
      return fail("invalid_grant", "code not issued for this client or redirect");
    if ((await pkceChallenge(input.codeVerifier)) !== row.code_challenge)
      return fail("invalid_grant", "PKCE verification failed");
    const active = await q(
      primary(this.db),
      "SELECT 1 AS ok FROM users WHERE id = ? AND status = 'active'",
      row.user_id,
    ).first();
    if (!active) return fail("invalid_grant", "account unavailable");

    return this.createSession(row.user_id, row.client_id, row.device_name, (sessionId) => [
      q(this.db, "UPDATE oauth_codes SET session_id = ? WHERE code_hash = ?", sessionId, hash),
    ]);
  }

  /** New device session plus its first credentials, audited, in one batch with `link` statements. */
  private async createSession(
    userId: string,
    clientId: string,
    deviceName: string,
    link: (sessionId: string) => ReadonlyArray<ReturnType<typeof q>>,
  ): Promise<DeviceTokens> {
    const now = this.clock.now();
    const sessionId = this.clock.id("dvs");
    const { tokens, statements } = await this.newTokens(sessionId);
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO device_sessions (id, user_id, client_id, device_name, created_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        sessionId,
        userId,
        clientId,
        deviceName,
        now,
        now,
        now + DEVICE_IDLE_TTL_MS,
        now + DEVICE_ABSOLUTE_TTL_MS,
      ),
      ...link(sessionId),
      ...statements,
      audit(this.db, this.clock, {
        actorId: userId,
        action: "device.session.create",
        target: sessionId,
        detail: { clientId, device: deviceName },
      }),
    ]);
    return tokens;
  }

  // ---- device-authorization grant (DS10, RFC 8628) ----

  /** Start a device authorization: the client shows `user_code` and polls with `device_code`. */
  async startDeviceAuthorization(input: {
    readonly clientId: string;
    readonly deviceName: string;
  }): Promise<DeviceAuthorization> {
    if (!DEVICE_GRANT_CLIENTS.includes(input.clientId))
      fail("invalid_client", "client may not use the device grant");
    const now = this.clock.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const deviceCode = randomToken(32);
      const userCode = newUserCode();
      try {
        await q(
          this.db,
          "INSERT INTO device_codes (device_code_hash, user_code_hash, client_id, device_name, interval_s, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          await sha256Hex(deviceCode),
          await sha256Hex(userCode),
          input.clientId,
          input.deviceName.slice(0, 120),
          DEVICE_POLL_INTERVAL_S,
          now,
          now + DEVICE_AUTHORIZATION_TTL_MS,
        ).run();
        return {
          device_code: deviceCode,
          user_code: formatUserCode(userCode),
          expires_in: DEVICE_AUTHORIZATION_TTL_MS / 1000,
          interval: DEVICE_POLL_INTERVAL_S,
        };
      } catch (e) {
        // A user-code collision (UNIQUE) retries with a fresh code; anything else is a real failure.
        if (!String(e).includes("UNIQUE")) throw e;
      }
    }
    return fail("invalid_request", "could not allocate a user code");
  }

  /** The pending request a user code names, for the approval page; null if unknown, used or expired. */
  async pendingUserCode(
    userCode: string,
  ): Promise<{ readonly clientId: string; readonly deviceName: string } | null> {
    const code = normalizeUserCode(userCode);
    if (code.length !== 8) return null;
    const row = await q(
      primary(this.db),
      "SELECT client_id, device_name, status, expires_at FROM device_codes WHERE user_code_hash = ?",
      await sha256Hex(code),
    ).first<{ client_id: string; device_name: string; status: string; expires_at: number }>();
    if (!row || row.status !== "pending" || row.expires_at < this.clock.now()) return null;
    return { clientId: row.client_id, deviceName: row.device_name };
  }

  /** Approve or deny a pending user code as the signed-in user. False when unknown, used or expired. */
  async decideUserCode(userId: string, userCode: string, allow: boolean): Promise<boolean> {
    const code = normalizeUserCode(userCode);
    if (code.length !== 8) return false;
    const { meta } = await q(
      this.db,
      "UPDATE device_codes SET status = ?, user_id = ? WHERE user_code_hash = ? AND status = 'pending' AND expires_at >= ?",
      allow ? "approved" : "denied",
      userId,
      await sha256Hex(code),
      this.clock.now(),
    ).run();
    return meta.changes === 1;
  }

  /**
   * Poll with a device code (RFC 8628 §3.4/3.5). Pending → `authorization_pending`; polling faster
   * than the interval → `slow_down` (and the interval grows by 5 s); denied → `access_denied`;
   * expired or already redeemed → `expired_token`. An approval is redeemed exactly once.
   */
  async pollDeviceCode(input: {
    readonly deviceCode: string;
    readonly clientId: string;
  }): Promise<DeviceTokens> {
    if (!clientFor(input.clientId)) fail("invalid_client", "unknown client");
    const hash = await sha256Hex(input.deviceCode);
    const now = this.clock.now();
    const row = await guardD1("device-code", () =>
      q(
        primary(this.db),
        "SELECT client_id, device_name, status, user_id, interval_s, last_polled_at, expires_at FROM device_codes WHERE device_code_hash = ?",
        hash,
      ).first<{
        client_id: string;
        device_name: string;
        status: string;
        user_id: string | null;
        interval_s: number;
        last_polled_at: number | null;
        expires_at: number;
      }>(),
    );
    if (!row) return fail("invalid_grant", "unknown device code");
    if (row.client_id !== input.clientId)
      return fail("invalid_grant", "device code not issued for this client");
    if (row.expires_at < now || row.status === "consumed")
      return fail("expired_token", "device code expired");
    if (row.status === "denied") return fail("access_denied", "the user denied the request");
    if (row.status === "pending") {
      const tooSoon =
        row.last_polled_at !== null && now - row.last_polled_at < row.interval_s * 1000;
      await q(
        this.db,
        "UPDATE device_codes SET last_polled_at = ?, interval_s = interval_s + ? WHERE device_code_hash = ?",
        now,
        tooSoon ? 5 : 0,
        hash,
      ).run();
      return fail(
        tooSoon ? "slow_down" : "authorization_pending",
        tooSoon ? "polling too fast" : "waiting for the user",
      );
    }
    // Approved: consume atomically so two concurrent polls can't both mint a session.
    const consumed = await q(
      this.db,
      "UPDATE device_codes SET status = 'consumed' WHERE device_code_hash = ? AND status = 'approved'",
      hash,
    ).run();
    if (consumed.meta.changes !== 1 || !row.user_id)
      return fail("expired_token", "device code already redeemed");
    const active = await q(
      primary(this.db),
      "SELECT 1 AS ok FROM users WHERE id = ? AND status = 'active'",
      row.user_id,
    ).first();
    if (!active) return fail("access_denied", "account unavailable");
    return this.createSession(row.user_id, row.client_id, row.device_name, (sessionId) => [
      q(
        this.db,
        "UPDATE device_codes SET session_id = ? WHERE device_code_hash = ?",
        sessionId,
        hash,
      ),
    ]);
  }

  /** Rotate a refresh credential. Replaying a rotated credential revokes the device session. */
  async refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
  }): Promise<DeviceTokens> {
    if (!clientFor(input.clientId)) fail("invalid_client", "unknown client");
    const hash = await sha256Hex(input.refreshToken);
    const now = this.clock.now();
    const row = await guardD1("refresh", () =>
      q(
        primary(this.db),
        `SELECT r.session_id, r.rotated_at, s.client_id, s.revoked_at, s.idle_expires_at, s.absolute_expires_at, u.status AS user_status
         FROM device_refresh_tokens r JOIN device_sessions s ON s.id = r.session_id JOIN users u ON u.id = s.user_id WHERE r.token_hash = ?`,
        hash,
      ).first<{
        session_id: string;
        rotated_at: number | null;
        client_id: string;
        revoked_at: number | null;
        idle_expires_at: number;
        absolute_expires_at: number;
        user_status: string;
      }>(),
    );
    if (!row) return fail("invalid_grant", "unknown refresh token");
    if (row.client_id !== input.clientId) return fail("invalid_grant", "client mismatch");
    if (row.rotated_at !== null) {
      await this.revokeSession(row.session_id, "refresh-reuse");
      return fail("invalid_grant", "refresh token reused; session revoked");
    }
    if (row.revoked_at !== null || row.user_status !== "active")
      return fail("invalid_grant", "session revoked");
    if (row.idle_expires_at < now || row.absolute_expires_at < now)
      return fail("invalid_grant", "session expired");
    // One batch: the compare-and-set on the presented credential (which also re-checks that the
    // session is still live) gates the new credentials, so a lost race or a concurrent revocation
    // issues nothing.
    const { tokens, statements } = await this.newTokens(row.session_id, true);
    const results = await this.db.batch([
      q(
        this.db,
        "UPDATE device_refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND EXISTS (SELECT 1 FROM device_sessions WHERE id = ? AND revoked_at IS NULL)",
        now,
        hash,
        row.session_id,
      ),
      ...statements,
    ]);
    if (changesOf(results[0]) !== 1) {
      await this.revokeSession(row.session_id, "refresh-race");
      return fail("invalid_grant", "refresh token reused; session revoked");
    }
    return tokens;
  }

  /** RFC 7009-style revocation by refresh or access credential; unknown tokens are not an error. */
  async revokeToken(token: string): Promise<void> {
    const hash = await sha256Hex(token);
    const db = primary(this.db);
    const r = await q(
      db,
      "SELECT session_id FROM device_refresh_tokens WHERE token_hash = ?",
      hash,
    ).first<{ session_id: string }>();
    const a = r
      ? null
      : await q(
          db,
          "SELECT session_id FROM device_access_tokens WHERE token_hash = ?",
          hash,
        ).first<{ session_id: string }>();
    const sessionId = r?.session_id ?? a?.session_id;
    if (sessionId) await this.revokeSession(sessionId, "client-logout");
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.db.batch([
      q(
        this.db,
        "UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?) WHERE id = ?",
        now,
        reason,
        sessionId,
      ),
      q(this.db, "DELETE FROM device_access_tokens WHERE session_id = ?", sessionId),
    ]);
    if (this.onRevoked) {
      const owner = await q(
        primary(this.db),
        "SELECT user_id FROM device_sessions WHERE id = ?",
        sessionId,
      ).first<{ user_id: string }>();
      if (owner) await this.onRevoked(owner.user_id, sessionId).catch(() => undefined);
    }
  }

  /** Resolve an access credential for the API. Revocation and expiry are checked on every request. */
  async authenticateAccess(
    token: string,
  ): Promise<{ readonly sessionId: string; readonly userId: string } | null> {
    const now = this.clock.now();
    const hash = await sha256Hex(token);
    const found = await guardD1("device-access", () =>
      q(
        primary(this.db),
        `SELECT s.id, s.user_id FROM device_access_tokens t JOIN device_sessions s ON s.id = t.session_id JOIN users u ON u.id = s.user_id
         WHERE t.token_hash = ? AND t.expires_at >= ? AND s.revoked_at IS NULL AND s.absolute_expires_at >= ? AND u.status = 'active'`,
        hash,
        now,
        now,
      ).first<{ id: string; user_id: string }>(),
    );
    return found ? { sessionId: found.id, userId: found.user_id } : null;
  }

  async listSessions(userId: string): Promise<ReadonlyArray<DeviceSessionView>> {
    const rows = await q(
      primary(this.db),
      "SELECT id, client_id, device_name, created_at, last_used_at FROM device_sessions WHERE user_id = ? AND revoked_at IS NULL AND absolute_expires_at >= ? ORDER BY last_used_at DESC",
      userId,
      this.clock.now(),
    ).all<{
      id: string;
      client_id: string;
      device_name: string;
      created_at: number;
      last_used_at: number;
    }>();
    return rows.results.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      deviceName: r.device_name,
      createdAt: Number(r.created_at),
      lastUsedAt: Number(r.last_used_at),
    }));
  }

  async revokeOwnSession(userId: string, sessionId: string): Promise<boolean> {
    const s = await q(
      primary(this.db),
      "SELECT 1 AS ok FROM device_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      sessionId,
      userId,
    ).first();
    if (!s) return false;
    await this.revokeSession(sessionId, "user-revoked");
    return true;
  }
}
