import { ControlDeviceAuth } from "./device.ts";
import type { EntitlementRecord } from "./billing.ts";
import { entitlementState } from "./commerce.ts";
import { ControlSupport, SUPPORT_TOKEN_PREFIX } from "./support.ts";
import {
  ALL_SCOPES,
  DEFAULT_AGENT_SCOPES,
  type PrincipalContext,
  type Scope,
} from "@bye/application";
import type { KernelClock } from "../durable/kernel.ts";
import {
  hmacSha256,
  openWithKey,
  parseSecretRing,
  randomBytes,
  randomToken,
  ringVersions,
  sealWithKey,
  type SecretRing,
  secretFor,
  sha256Hex,
  toHex,
  UnknownKeyVersion,
  type VersionedKeys,
} from "./crypto.ts";
import {
  audit,
  auditIfChanged,
  changesOf,
  type D1Like,
  type D1SessionLike,
  type D1Value,
  type D1StatementLike,
  primary,
  q,
} from "./d1.ts";
import { guardD1 } from "./errors.ts";
import { base32Encode, verifyTotp } from "./totp.ts";
import {
  type EcPublicJwk,
  type RelyingParty,
  verifyAssertion,
  verifyRegistration,
} from "./webauthn.ts";
import { isRejection, reject } from "@bye/contracts";

// Authentication and session management (A03, §10). Tokens are 256-bit random bearer values;
// D1 stores only SHA-256 hashes. Authorization reads use primary-consistent sessions.

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const SESSION_COOKIE = "__Host-session";

export interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly expires_at: number;
  readonly step_up_at: number | null;
  readonly device: string;
  readonly revoked_at: number | null;
}

export interface AuthConfig {
  readonly rp: RelyingParty;
  readonly totpKeys: VersionedKeys;
  /**
   * Pepper for recovery-code hashes, from Worker secrets: a plain secret (version 1) or a versioned
   * ring. Each stored hash records the version it was made under.
   */
  readonly recoveryPepper: string | SecretRing;
}

/** TOTP step-up lockout (§10): this many failures within the window lock step-up for the window. */
export const TOTP_MAX_FAILURES = 5;

export const TOTP_LOCKOUT_MS = 15 * 60 * 1000;

export type AuthCredential =
  | { readonly kind: "session"; readonly session: SessionRow }
  | {
      readonly kind: "agent" | "cli";
      readonly tokenId: string;
      readonly userId: string;
      readonly scopes: ReadonlyArray<Scope>;
    }
  /** Desktop device session (browser-mediated passkey sign-in); never stepped up. */
  | {
      readonly kind: "device";
      readonly tokenId: string;
      readonly userId: string;
      readonly scopes: ReadonlyArray<Scope>;
    }
  /** Operator support session under a user-consented, time-boxed grant; always read-only (§10). */
  | {
      readonly kind: "support";
      readonly tokenId: string;
      readonly userId: string;
      readonly scopes: ReadonlyArray<Scope>;
      readonly operatorId: string;
    };

/** Scopes kept when every organization of the user has lapsed past its grace period (A01/A02). */
export const LAPSED_SCOPES: ReadonlyArray<Scope> = ["read"];

export const sessionCookie = (token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`;

export const clearSessionCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");

    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }

  return undefined;
};

/** The one CSRF/origin rule lives in the application layer (§10); re-exported for Worker helpers. */
export { checkCsrf } from "@bye/application";

export class ControlAuth {
  private readonly peppers: SecretRing;

  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    readonly config: AuthConfig,
  ) {
    this.peppers = parseSecretRing(config.recoveryPepper);
  }

  // ---- challenges ----

  async beginChallenge(
    purpose: "register" | "authenticate" | "step-up",
    userId?: string,
  ): Promise<{ id: string; challenge: string }> {
    const id = this.clock.id("chl");
    const challenge = randomToken(32);
    await guardD1("challenge", () =>
      q(
        this.db,
        "INSERT INTO auth_challenges (id, user_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
        id,
        userId ?? null,
        purpose,
        challenge,
        this.clock.now() + CHALLENGE_TTL_MS,
      ).run(),
    );

    return { id, challenge };
  }

  /** Single-use: a replayed or expired challenge is rejected. */
  private async consumeChallenge(
    id: string,
    purpose: string,
  ): Promise<{ challenge: string; userId: string | null }> {
    const row = await guardD1("challenge", () =>
      q(
        primary(this.db),
        "SELECT challenge, user_id, purpose, expires_at, consumed_at FROM auth_challenges WHERE id = ?",
        id,
      ).first<{
        challenge: string;
        user_id: string | null;
        purpose: string;
        expires_at: number;
        consumed_at: number | null;
      }>(),
    );

    if (
      !row ||
      row.purpose !== purpose ||
      row.consumed_at !== null ||
      row.expires_at < this.clock.now()
    ) {
      return reject("unauthenticated", "challenge invalid or expired");
    }

    const { meta } = await q(
      this.db,
      "UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
      this.clock.now(),
      id,
    ).run();

    if (meta.changes !== 1) reject("unauthenticated", "challenge already used");

    return { challenge: row.challenge, userId: row.user_id };
  }

  // ---- passkeys ----

  async registerPasskey(
    userId: string,
    challengeId: string,
    response: { clientDataJSON: string; attestationObject: string },
    label = "",
  ): Promise<string> {
    const { challenge, userId: bound } = await this.consumeChallenge(challengeId, "register");

    if (bound !== userId) reject("forbidden", "challenge bound to another user");
    let reg;

    try {
      reg = await verifyRegistration(response, challenge, this.config.rp);
    } catch (e) {
      return reject("unauthenticated", (e as Error).message);
    }

    await this.db.batch([
      q(
        this.db,
        "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        reg.credentialId,
        userId,
        JSON.stringify(reg.publicKeyJwk),
        reg.signCount,
        label,
        this.clock.now(),
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "passkey.register",
        target: reg.credentialId,
      }),
    ]);

    return reg.credentialId;
  }

  async authenticatePasskey(
    challengeId: string,
    response: {
      credentialId: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    },
    device: string,
  ): Promise<{ token: string; session: SessionRow }> {
    const { challenge } = await this.consumeChallenge(challengeId, "authenticate");
    const key = await this.passkey(response.credentialId);
    const signCount = await this.assert(key, response, challenge);
    // The counter advance and the session it authorizes commit together, and only if the counter
    // compare-and-set landed: two concurrent uses of one assertion cannot both get a session.
    const issued = await this.newSession(key.user_id, device, true);

    const results = await this.db.batch([
      this.advanceSignCount(response.credentialId, signCount),
      q(
        this.db,
        "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at, step_up_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0",
        issued.session.id,
        key.user_id,
        issued.tokenHash,
        device,
        issued.session.created_at,
        issued.session.last_seen_at,
        issued.session.expires_at,
        issued.session.step_up_at,
      ),
    ]);

    if (changesOf(results[0]) === 0) reject("unauthenticated", "authenticator counter replayed");

    return { token: issued.token, session: issued.session };
  }

  /**
   * Compare-and-set of the signature counter. WebAuthn §6.1.1: a counter must strictly increase;
   * an authenticator that reports 0 (and was stored at 0) does not implement counters, so it only
   * refreshes `last_used_at`.
   */
  private advanceSignCount(credentialId: string, signCount: number): D1StatementLike {
    return q(
      this.db,
      "UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ? AND (sign_count < ? OR (? = 0 AND sign_count = 0))",
      signCount,
      this.clock.now(),
      credentialId,
      signCount,
      signCount,
    );
  }

  private async passkey(credentialId: string) {
    const key = await guardD1("passkey", () =>
      q(
        primary(this.db),
        "SELECT user_id, public_key_jwk, sign_count FROM passkeys WHERE credential_id = ?",
        credentialId,
      ).first<{ user_id: string; public_key_jwk: string; sign_count: number }>(),
    );

    return key ?? reject("unauthenticated", "unknown credential");
  }

  private async assert(
    key: { public_key_jwk: string; sign_count: number },
    response: { clientDataJSON: string; authenticatorData: string; signature: string },
    challenge: string,
  ) {
    try {
      return (
        await verifyAssertion(response, challenge, this.config.rp, {
          publicKeyJwk: JSON.parse(key.public_key_jwk) as EcPublicJwk,
          signCount: key.sign_count,
        })
      ).signCount;
    } catch (e) {
      return reject("unauthenticated", (e as Error).message);
    }
  }

  /** Step-up with a passkey assertion for the session's own user. */
  async stepUpWithPasskey(
    sessionId: string,
    challengeId: string,
    response: {
      credentialId: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    },
  ): Promise<void> {
    const session = await this.sessionById(sessionId);
    const { challenge } = await this.consumeChallenge(challengeId, "step-up");
    const key = await this.passkey(response.credentialId);

    if (key.user_id !== session.user_id) reject("forbidden", "credential belongs to another user");
    const signCount = await this.assert(key, response, challenge);

    const results = await this.db.batch([
      this.advanceSignCount(response.credentialId, signCount),
      q(
        this.db,
        "UPDATE sessions SET step_up_at = ? WHERE id = ? AND changes() > 0",
        this.clock.now(),
        sessionId,
      ),
    ]);

    if (changesOf(results[0]) === 0) reject("unauthenticated", "authenticator counter replayed");
  }

  /**
   * Step-up with a TOTP code. After `TOTP_MAX_FAILURES` wrong codes within `TOTP_LOCKOUT_MS` the
   * user's TOTP step-up is locked for `TOTP_LOCKOUT_MS` (per user, across sessions), so a stolen
   * session cannot brute-force the second factor. Failures and lockouts are audited.
   */
  async stepUpWithTotp(sessionId: string, code: string): Promise<void> {
    const session = await this.sessionById(sessionId);
    const lockedUntil = await this.totpLockedUntil(session.user_id);

    if (lockedUntil !== null)
      return reject("rate_limited", "second factor locked", { lockedUntil });

    try {
      await this.verifyTotpCode(session.user_id, code);
    } catch (e) {
      if (isRejection(e) && e.code === "unauthenticated") {
        const locked = await this.recordTotpFailure(session.user_id);

        if (locked !== null)
          return reject("rate_limited", "second factor locked", { lockedUntil: locked });
      }

      throw e;
    }

    await this.db.batch([
      q(this.db, "UPDATE sessions SET step_up_at = ? WHERE id = ?", this.clock.now(), sessionId),
      q(this.db, "DELETE FROM auth_lockouts WHERE user_id = ? AND kind = 'totp'", session.user_id),
    ]);
  }

  /** When the user's TOTP step-up is locked, the time it unlocks; otherwise null. */
  async totpLockedUntil(userId: string): Promise<number | null> {
    const row = await guardD1("lockout", () =>
      q(
        primary(this.db),
        "SELECT locked_until FROM auth_lockouts WHERE user_id = ? AND kind = 'totp' AND locked_until > ?",
        userId,
        this.clock.now(),
      ).first<{ locked_until: number }>(),
    );

    return row ? Number(row.locked_until) : null;
  }

  /**
   * Count one failed TOTP attempt in the current window (a stale window restarts at 1). Returns
   * the lock expiry when this failure locks the user out.
   */
  private async recordTotpFailure(userId: string): Promise<number | null> {
    const now = this.clock.now();
    const lockUntil = now + TOTP_LOCKOUT_MS;

    const results = await this.db.batch([
      q(
        this.db,
        `INSERT INTO auth_lockouts (user_id, kind, failures, window_start, locked_until) VALUES (?, 'totp', 1, ?, NULL)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           failures = CASE WHEN auth_lockouts.window_start <= ? THEN 1 ELSE auth_lockouts.failures + 1 END,
           window_start = CASE WHEN auth_lockouts.window_start <= ? THEN excluded.window_start ELSE auth_lockouts.window_start END,
           locked_until = NULL`,
        userId,
        now,
        now - TOTP_LOCKOUT_MS,
        now - TOTP_LOCKOUT_MS,
      ),
      q(
        this.db,
        "UPDATE auth_lockouts SET locked_until = ?, failures = 0 WHERE user_id = ? AND kind = 'totp' AND failures >= ?",
        lockUntil,
        userId,
        TOTP_MAX_FAILURES,
      ),
      q(
        this.db,
        "SELECT failures, locked_until FROM auth_lockouts WHERE user_id = ? AND kind = 'totp'",
        userId,
      ),
    ]);

    const locked = changesOf(results[1]) > 0;
    const row = (results[2] as { results?: Array<{ failures: number }> } | undefined)?.results?.[0];
    await audit(this.db, this.clock, {
      actorId: userId,
      action: locked ? "totp.lockout" : "totp.failure",
      target: userId,
      detail: locked ? { lockedUntil: lockUntil } : { failures: Number(row?.failures ?? 0) },
    }).run();

    return locked ? lockUntil : null;
  }

  // ---- TOTP ----

  async enrollTotp(userId: string): Promise<{ secret: string }> {
    const secret = randomBytes(20);
    const sealed = await sealWithKey(this.config.totpKeys, secret);
    await q(
      this.db,
      `INSERT INTO totp_secrets (user_id, key_version, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET key_version = excluded.key_version, iv = excluded.iv, ciphertext = excluded.ciphertext, created_at = excluded.created_at, confirmed_at = NULL, last_step = 0`,
      userId,
      sealed.keyVersion,
      sealed.iv,
      sealed.ciphertext,
      this.clock.now(),
    ).run();

    return { secret: base32Encode(secret) };
  }

  async confirmTotp(userId: string, code: string): Promise<void> {
    await this.verifyTotpCode(userId, code, true);
    await q(
      this.db,
      "UPDATE totp_secrets SET confirmed_at = ? WHERE user_id = ?",
      this.clock.now(),
      userId,
    ).run();
  }

  private async verifyTotpCode(
    userId: string,
    code: string,
    allowUnconfirmed = false,
  ): Promise<void> {
    const row = await guardD1("totp", () =>
      q(
        primary(this.db),
        "SELECT key_version, iv, ciphertext, confirmed_at, last_step FROM totp_secrets WHERE user_id = ?",
        userId,
      ).first<{
        key_version: number;
        iv: string;
        ciphertext: string;
        confirmed_at: number | null;
        last_step: number;
      }>(),
    );

    if (!row || (!allowUnconfirmed && row.confirmed_at === null))
      return reject("unauthenticated", "second factor not enrolled");

    const secret = await openWithKey(this.config.totpKeys, {
      keyVersion: row.key_version,
      iv: row.iv,
      ciphertext: row.ciphertext,
    });

    const step = await verifyTotp(secret, code, this.clock.now(), row.last_step);

    if (step === null) return reject("unauthenticated", "invalid code");

    // Compare-and-set prevents two concurrent uses of the same code.
    const { meta } = await q(
      this.db,
      "UPDATE totp_secrets SET last_step = ? WHERE user_id = ? AND last_step < ?",
      step,
      userId,
      step,
    ).run();

    if (meta.changes !== 1) reject("unauthenticated", "code already used");
  }

  /**
   * Re-encrypt TOTP secrets under the current key version (key rotation), a page at a time so a
   * large table never exceeds one invocation's limits. Each row is a compare-and-set on its old
   * version, so a rotation that stops part-way (or runs twice) is safe: unrotated rows still open
   * with their old key, which stays in the ring until this returns 0 remaining.
   * `maxPages` bounds one call; the return value counts rows re-sealed.
   */
  async rotateTotpKeys(pageSize = 100, maxPages = Number.POSITIVE_INFINITY): Promise<number> {
    let rotated = 0;
    let after = "";

    for (let page = 0; page < maxPages; page++) {
      const rows = (
        await q(
          this.db,
          "SELECT user_id, key_version, iv, ciphertext FROM totp_secrets WHERE key_version != ? AND user_id > ? ORDER BY user_id LIMIT ?",
          this.config.totpKeys.current,
          after,
          pageSize,
        ).all<{ user_id: string; key_version: number; iv: string; ciphertext: string }>()
      ).results;

      if (rows.length === 0) break;
      const updates: Array<D1StatementLike> = [];

      for (const r of rows) {
        const plain = await openWithKey(this.config.totpKeys, {
          keyVersion: r.key_version,
          iv: r.iv,
          ciphertext: r.ciphertext,
        });

        const sealed = await sealWithKey(this.config.totpKeys, plain);
        updates.push(
          q(
            this.db,
            "UPDATE totp_secrets SET key_version = ?, iv = ?, ciphertext = ? WHERE user_id = ? AND key_version = ?",
            sealed.keyVersion,
            sealed.iv,
            sealed.ciphertext,
            r.user_id,
            r.key_version,
          ),
        );
      }

      await this.db.batch(updates);
      rotated += rows.length;
      after = rows.at(-1)!.user_id;

      if (rows.length < pageSize) break;
    }

    return rotated;
  }

  // ---- recovery codes ----

  private async hashRecovery(
    userId: string,
    code: string,
    version: number = this.peppers.current,
  ): Promise<string> {
    return toHex(
      await hmacSha256(
        secretFor(this.peppers, version, "recovery-pepper"),
        `${userId}:${code.replace(/[\s-]/g, "").toUpperCase()}`,
      ),
    );
  }

  /** Replace all recovery codes. Plaintext is returned once and never stored. */
  async generateRecoveryCodes(userId: string, count = 10): Promise<ReadonlyArray<string>> {
    const codes = Array.from({ length: count }, () => {
      const s = base32Encode(randomBytes(10));

      return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
    });

    const hashes = await Promise.all(codes.map((c) => this.hashRecovery(userId, c)));
    await this.db.batch([
      q(this.db, "DELETE FROM recovery_codes WHERE user_id = ?", userId),
      ...hashes.map((h) =>
        q(
          this.db,
          "INSERT INTO recovery_codes (user_id, code_hash, created_at, pepper_version) VALUES (?, ?, ?, ?)",
          userId,
          h,
          this.clock.now(),
          this.peppers.current,
        ),
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "recovery.codes.generate",
        target: userId,
      }),
    ]);

    return codes;
  }

  /**
   * Independent recovery (A03): address + single-use code, no mailbox access required.
   * Every existing credential is revoked — browser sessions, agent/CLI API tokens and desktop/mobile
   * device sessions (so their refresh tokens stop working) — because recovery is what a user does
   * after losing control of the account. The new session is stepped-up so they can enrol a passkey.
   */
  async recoverWithCode(
    address: string,
    code: string,
    device: string,
  ): Promise<{ token: string; session: SessionRow }> {
    const user = await guardD1("recover", () =>
      q(
        primary(this.db),
        "SELECT id, status FROM users WHERE primary_address = ?",
        address.trim().toLowerCase(),
      ).first<{ id: string; status: string }>(),
    );

    if (!user || user.status !== "active") return reject("unauthenticated", "recovery failed");
    // Hash under every pepper version in the ring; each stored hash says which one it used.
    const versions = ringVersions(this.peppers);

    // bounded: one hash per pepper version in the configured ring (a handful at most).
    const candidates = await Promise.all(
      versions.map(async (v) => [v, await this.hashRecovery(user.id, code, v)] as const),
    );

    const found = await guardD1("recover", () =>
      q(
        primary(this.db),
        `SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND (${candidates.map(() => "(pepper_version = ? AND code_hash = ?)").join(" OR ")}) LIMIT 1`,
        user.id,
        ...candidates.flat(),
      ).first<{ code_hash: string }>(),
    );

    if (!found) {
      // Codes made under a pepper that has left the ring can never verify: a configuration error
      // (retire a version only after its codes are regenerated), surfaced as such.
      const orphaned = await guardD1("recover", () =>
        q(
          primary(this.db),
          `SELECT pepper_version FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND pepper_version NOT IN (${versions.map(() => "?").join(",")}) LIMIT 1`,
          user.id,
          ...versions,
        ).first<{ pepper_version: number }>(),
      );

      if (orphaned) throw new UnknownKeyVersion("recovery-pepper", Number(orphaned.pepper_version));

      return reject("unauthenticated", "recovery failed");
    }

    const hash = found.code_hash;
    // One atomic batch. The audit row doubles as the redemption marker: it is inserted only if
    // the compare-and-set burn changed a row, and every later statement is guarded on it, so a
    // concurrent redeem of the same code changes nothing and gets no session.
    const auditId = this.clock.id("aud");
    const now = this.clock.now();
    const redeemed = { exists: "SELECT 1 FROM audit_log WHERE id = ?", args: [auditId] };
    const issued = await this.newSession(user.id, device, true);
    await this.db.batch([
      q(
        this.db,
        "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        now,
        user.id,
        hash,
      ),
      auditIfChanged(
        this.db,
        this.clock,
        { actorId: user.id, action: "recovery.redeem", target: user.id },
        auditId,
      ),
      ...revokeAllCredentials(this.db, this.clock, user.id, "recovery", redeemed),
      q(
        this.db,
        "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at, step_up_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)",
        issued.session.id,
        user.id,
        issued.tokenHash,
        device,
        issued.session.created_at,
        issued.session.last_seen_at,
        issued.session.expires_at,
        issued.session.step_up_at,
        auditId,
      ),
    ]);

    const marker = await q(
      primary(this.db),
      "SELECT 1 AS ok FROM audit_log WHERE id = ?",
      auditId,
    ).first();

    if (!marker) return reject("unauthenticated", "recovery failed");

    return { token: issued.token, session: issued.session };
  }

  // ---- sessions ----

  async issueSession(
    userId: string,
    device: string,
    steppedUp = false,
  ): Promise<{ token: string; session: SessionRow }> {
    const issued = await this.newSession(userId, device, steppedUp);
    await issued.statement.run();

    return { token: issued.token, session: issued.session };
  }

  /** A new session and its INSERT, so callers can commit it inside a larger batch. */
  private async newSession(
    userId: string,
    device: string,
    steppedUp: boolean,
  ): Promise<{
    token: string;
    tokenHash: string;
    session: SessionRow;
    statement: D1StatementLike;
  }> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = this.clock.now();

    const session: SessionRow = {
      id: this.clock.id("ses"),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: now + SESSION_TTL_MS,
      step_up_at: steppedUp ? now : null,
      device,
      revoked_at: null,
    };

    const statement = q(
      this.db,
      "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at, step_up_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      session.id,
      userId,
      tokenHash,
      device,
      now,
      now,
      session.expires_at,
      session.step_up_at,
    );

    return { token, tokenHash, session, statement };
  }

  private async sessionById(id: string): Promise<SessionRow> {
    const s = await guardD1("session", () =>
      q(
        primary(this.db),
        "SELECT id, user_id, created_at, last_seen_at, expires_at, step_up_at, device, revoked_at FROM sessions WHERE id = ?",
        id,
      ).first<SessionRow>(),
    );

    if (!s || s.revoked_at !== null || s.expires_at < this.clock.now())
      return reject("unauthenticated", "session invalid");

    return s;
  }

  /**
   * Resolve a bearer credential. Prefixed kinds (support, device, API token) are looked up by their
   * own table first; anything else, and a prefixed miss, falls back to the browser session table
   * (session tokens are unprefixed random values, so a rare collision with a prefix still resolves).
   */
  async authenticate(token: string): Promise<AuthCredential> {
    if (!token) return reject("unauthenticated", "missing credential");
    const hash = await sha256Hex(token);
    const kind = credentialKindOf(token);

    if (kind !== "session") {
      const found = await CREDENTIALS[kind].authenticate(this, token, hash);

      if (found) return found;
    }

    const session = await CREDENTIALS.session.authenticate(this, token, hash);

    return session ?? reject("unauthenticated", "invalid credential");
  }

  /** Rotate: issue a new token and revoke the old one atomically. */
  async rotateSession(
    token: string,
  ): Promise<{ token: string; session: SessionRow; previousId: string }> {
    const cred = await this.authenticate(token);

    if (cred.kind !== "session") return reject("bad_request", "only sessions rotate");
    const next = randomToken();
    const now = this.clock.now();
    const id = this.clock.id("ses");
    const s = cred.session;

    // Compare-and-set on the old session: only the rotation that revokes it issues a successor, so
    // two concurrent rotations (or one racing a logout) cannot fork the session.
    const results = await this.db.batch([
      q(
        this.db,
        "UPDATE sessions SET revoked_at = ?, rotated_to = ? WHERE id = ? AND revoked_at IS NULL",
        now,
        id,
        s.id,
      ),
      q(
        this.db,
        "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at, step_up_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0",
        id,
        s.user_id,
        await sha256Hex(next),
        s.device,
        now,
        now,
        now + SESSION_TTL_MS,
        s.step_up_at,
      ),
      // Push registrations follow the successor in the same transaction, so no delivery ever sees
      // them bound to a revoked session (spec P1.7).
      q(
        this.db,
        "UPDATE push_devices SET session_id = ? WHERE session_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)",
        id,
        s.id,
        id,
      ),
    ]);

    if (changesOf(results[0]) === 0) return reject("unauthenticated", "session invalid");

    return {
      token: next,
      session: { ...s, id, created_at: now, last_seen_at: now, expires_at: now + SESSION_TTL_MS },
      previousId: s.id,
    };
  }

  async listSessions(userId: string): Promise<ReadonlyArray<SessionRow>> {
    return (
      await q(
        this.db,
        "SELECT id, user_id, created_at, last_seen_at, expires_at, step_up_at, device, revoked_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
        userId,
      ).all<SessionRow>()
    ).results;
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const { meta } = await q(
      this.db,
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      this.clock.now(),
      sessionId,
      userId,
    ).run();

    return meta.changes === 1;
  }

  // ---- agent / CLI tokens ----

  /**
   * Persist an agent/CLI token for `userId`. Who may mint which scopes (interactive session,
   * step-up for consequential scopes) is the `issueApiToken` use case's decision, made once.
   */
  async createApiToken(
    userId: string,
    input: {
      kind: "agent" | "cli";
      label: string;
      scopes?: ReadonlyArray<Scope>;
      expiresAt?: number;
    },
  ): Promise<{ id: string; token: string; scopes: ReadonlyArray<Scope> }> {
    const scopes =
      input.scopes ??
      (input.kind === "agent" ? DEFAULT_AGENT_SCOPES : (["read", "draft"] as const));

    for (const s of scopes)
      if (!ALL_SCOPES.includes(s)) reject("bad_request", `unknown scope ${s}`);
    const token = `bye_${input.kind}_${randomToken()}`;
    const id = this.clock.id("tok");
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO api_tokens (id, user_id, token_hash, kind, label, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        userId,
        await sha256Hex(token),
        input.kind,
        input.label,
        JSON.stringify(scopes),
        this.clock.now(),
        input.expiresAt ?? null,
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "token.create",
        target: id,
        detail: { kind: input.kind, scopes },
      }),
    ]);

    return { id, token, scopes };
  }

  async listApiTokens(userId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly label: string;
      readonly scopes: ReadonlyArray<Scope>;
      readonly createdAt: number;
      readonly lastUsedAt: number | null;
      readonly expiresAt: number | null;
    }>
  > {
    const rows = await q(
      primary(this.db),
      "SELECT id, kind, label, scopes, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      userId,
    ).all<{
      id: string;
      kind: string;
      label: string;
      scopes: string;
      created_at: number;
      last_used_at: number | null;
      expires_at: number | null;
    }>();

    return rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      scopes: JSON.parse(r.scopes) as Array<Scope>,
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    }));
  }

  // ---- security settings (A03) ----

  async listPasskeys(userId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly createdAt: number;
      readonly lastUsedAt: number | null;
    }>
  > {
    const rows = await q(
      primary(this.db),
      "SELECT credential_id, label, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at",
      userId,
    ).all<{
      credential_id: string;
      label: string;
      created_at: number;
      last_used_at: number | null;
    }>();

    return rows.results.map((r) => ({
      id: r.credential_id,
      label: r.label,
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    }));
  }

  /**
   * Remove a passkey. The last passkey stays unless the user can still sign in another way: an
   * unused recovery code (`/auth/recover`). TOTP is a step-up factor only — it cannot sign in, so
   * it never counts as a fallback here.
   */
  async removePasskey(userId: string, credentialId: string): Promise<void> {
    const keys = await this.listPasskeys(userId);

    if (!keys.some((k) => k.id === credentialId)) return reject("not_found", "passkey");

    if (keys.length === 1) {
      const codes = await q(
        primary(this.db),
        "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
        userId,
      ).first<{ n: number }>();

      if (!codes?.n) reject("conflict", "cannot remove the only sign-in credential");
    }

    await this.db.batch([
      q(
        this.db,
        "DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?",
        credentialId,
        userId,
      ),
      audit(this.db, this.clock, {
        actorId: userId,
        action: "passkey.remove",
        target: credentialId,
      }),
    ]);
  }

  async disableTotp(userId: string): Promise<boolean> {
    const had = await q(
      primary(this.db),
      "SELECT 1 AS ok FROM totp_secrets WHERE user_id = ?",
      userId,
    ).first();

    if (!had) return false;
    // Delete and audit commit together; the audit row is written only when a secret existed.
    await this.db.batch([
      q(this.db, "DELETE FROM totp_secrets WHERE user_id = ?", userId),
      auditIfChanged(this.db, this.clock, {
        actorId: userId,
        action: "totp.disable",
        target: userId,
      }),
    ]);

    return true;
  }

  async securityStatus(userId: string): Promise<{
    readonly passkeys: number;
    readonly totp: "none" | "pending" | "enabled";
    readonly recoveryCodesRemaining: number;
  }> {
    const db = primary(this.db);

    const [p, t, r] = await Promise.all([
      q(db, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", userId).first<{ n: number }>(),
      q(db, "SELECT confirmed_at FROM totp_secrets WHERE user_id = ?", userId).first<{
        confirmed_at: number | null;
      }>(),
      q(
        db,
        "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
        userId,
      ).first<{ n: number }>(),
    ]);

    return {
      passkeys: Number(p?.n ?? 0),
      totp: t === null ? "none" : t.confirmed_at === null ? "pending" : "enabled",
      recoveryCodesRemaining: Number(r?.n ?? 0),
    };
  }

  async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
    const { meta } = await q(
      this.db,
      "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      this.clock.now(),
      tokenId,
      userId,
    ).run();

    return meta.changes === 1;
  }

  // ---- principal ----

  /**
   * Build the per-request principal from a verified credential. Suspended memberships and
   * suspended/closed mailboxes are excluded immediately (§11, O02).
   */
  async principal(cred: AuthCredential): Promise<PrincipalContext> {
    const userId = cred.kind === "session" ? cred.session.user_id : cred.userId;
    const db = primary(this.db);

    const [mailboxes, calendars, orgs, ents] = await guardD1("principal", () =>
      Promise.all([
        q(
          db,
          `SELECT DISTINCT a.mailbox_id AS id FROM mailbox_access a
           JOIN mailboxes m ON m.id = a.mailbox_id
           JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id
           WHERE a.user_id = ? AND m.status = 'active' AND ms.status = 'active' ORDER BY a.mailbox_id`,
          userId,
        ).all<{ id: string }>(),
        q(db, "SELECT id FROM calendars WHERE owner_user_id = ? ORDER BY id", userId).all<{
          id: string;
        }>(),
        q(
          db,
          "SELECT org_id AS id FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY org_id",
          userId,
        ).all<{ id: string }>(),
        q(
          db,
          "SELECT e.* FROM memberships m LEFT JOIN entitlements e ON e.org_id = m.org_id WHERE m.user_id = ? AND m.status = 'active'",
          userId,
        ).all<EntitlementRecord & { org_id: string | null }>(),
      ]),
    );

    // Entitlement enforcement (A01/A02): if every organization has lapsed past its grace period the
    // credential keeps read access only (mail keeps arriving; export and billing stay reachable).
    const now = this.clock.now();

    const lapsed =
      ents.results.length > 0 &&
      ents.results.every((e) => entitlementState(e.org_id === null ? null : e, now) === "lapsed");

    const baseScopes = cred.kind === "session" ? ALL_SCOPES : cred.scopes;

    return {
      userId,
      sessionId: cred.kind === "session" ? cred.session.id : cred.tokenId,
      kind:
        cred.kind === "session" || cred.kind === "device"
          ? "user"
          : cred.kind === "support"
            ? "agent"
            : cred.kind,
      scopes: lapsed ? baseScopes.filter((s) => LAPSED_SCOPES.includes(s)) : baseScopes,
      mailboxIds: mailboxes.results.map((r) => r.id),
      calendarIds: calendars.results.map((r) => r.id),
      organizationIds: orgs.results.map((r) => r.id),
    };
  }
}

// ---- credential kinds (A03, §10) ----

export type CredentialKind = "session" | "api" | "device" | "support";

interface CredentialSpec {
  /** Token prefix that identifies the kind; `null` for unprefixed browser session tokens. */
  readonly prefix: string | null;
  readonly authenticate: (
    auth: ControlAuth,
    token: string,
    hash: string,
  ) => Promise<AuthCredential | null>;
  /** Statements revoking every credential of this kind for a user (committed by the caller). */
  readonly revokeAllFor: (
    db: D1SessionLike,
    now: number,
    userId: string,
    reason: string,
    guard: RevocationGuard | undefined,
  ) => ReadonlyArray<D1StatementLike>;
}

/** Optional `EXISTS (…)` condition every revocation statement must also satisfy (atomic batches). */
export interface RevocationGuard {
  readonly exists: string;
  readonly args: ReadonlyArray<D1Value>;
}

const guarded = (
  db: D1SessionLike,
  sql: string,
  args: ReadonlyArray<D1Value>,
  guard: RevocationGuard | undefined,
): D1StatementLike =>
  guard
    ? q(db, `${sql} AND EXISTS (${guard.exists})`, ...args, ...guard.args)
    : q(db, sql, ...args);

/** Every credential kind in one place: how it's recognized, authenticated and revoked. */
export const CREDENTIALS: Readonly<Record<CredentialKind, CredentialSpec>> = {
  session: {
    prefix: null,
    authenticate: async (auth, _token, hash) => {
      const session = await guardD1("session", () =>
        q(
          primary(auth.db),
          "SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.step_up_at, s.device, s.revoked_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.status = 'active'",
          hash,
        ).first<SessionRow>(),
      );

      if (!session) return null;

      if (session.revoked_at !== null || session.expires_at < auth.clock.now())
        return reject("unauthenticated", "session expired");

      return { kind: "session", session };
    },
    revokeAllFor: (db, now, userId, _reason, guard) => [
      guarded(
        db,
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [now, userId],
        guard,
      ),
    ],
  },
  api: {
    prefix: "bye_",
    authenticate: async (auth, _token, hash) => {
      const now = auth.clock.now();

      const tok = await guardD1("token", () =>
        q(
          primary(auth.db),
          "SELECT t.id, t.user_id, t.kind, t.scopes, t.expires_at, t.revoked_at FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.status = 'active'",
          hash,
        ).first<{
          id: string;
          user_id: string;
          kind: "agent" | "cli";
          scopes: string;
          expires_at: number | null;
          revoked_at: number | null;
        }>(),
      );

      if (!tok) return null;

      if (tok.revoked_at !== null || (tok.expires_at !== null && tok.expires_at < now))
        return reject("unauthenticated", "invalid credential");
      await q(auth.db, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now, tok.id).run();

      return {
        kind: tok.kind,
        tokenId: tok.id,
        userId: tok.user_id,
        scopes: JSON.parse(tok.scopes) as Array<Scope>,
      };
    },
    revokeAllFor: (db, now, userId, _reason, guard) => [
      guarded(
        db,
        "UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [now, userId],
        guard,
      ),
    ],
  },
  device: {
    prefix: "bda_",
    authenticate: async (auth, token) => {
      const device = await new ControlDeviceAuth(auth.db, auth.clock).authenticateAccess(token);

      return device
        ? { kind: "device", tokenId: device.sessionId, userId: device.userId, scopes: ALL_SCOPES }
        : null;
    },
    revokeAllFor: (db, now, userId, reason, guard) => [
      guarded(
        db,
        "UPDATE device_sessions SET revoked_at = ?, revoke_reason = COALESCE(revoke_reason, ?) WHERE user_id = ? AND revoked_at IS NULL",
        [now, reason, userId],
        guard,
      ),
      guarded(
        db,
        "DELETE FROM device_access_tokens WHERE session_id IN (SELECT id FROM device_sessions WHERE user_id = ?)",
        [userId],
        guard,
      ),
      // In-flight grants would otherwise mint a fresh device session after the revocation: an
      // unredeemed authorization code is spent, an approved device code is withdrawn.
      guarded(
        db,
        "UPDATE oauth_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
        [now, userId],
        guard,
      ),
      guarded(
        db,
        "UPDATE device_codes SET status = 'denied' WHERE user_id = ? AND status = 'approved'",
        [userId],
        guard,
      ),
    ],
  },
  support: {
    prefix: SUPPORT_TOKEN_PREFIX,
    authenticate: async (auth, token) => {
      const support = await new ControlSupport(auth.db, auth.clock).authenticate(token);

      return support
        ? {
            kind: "support",
            tokenId: support.grantId,
            userId: support.userId,
            scopes: ["read"],
            operatorId: support.operatorId,
          }
        : null;
    },
    // Revoking the grants ends every support session under them (sessions join on the grant).
    revokeAllFor: (db, now, userId, _reason, guard) => [
      guarded(
        db,
        "UPDATE support_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [now, userId],
        guard,
      ),
    ],
  },
};

/** The credential kind a presented token claims by its prefix (sessions are unprefixed). */
export const credentialKindOf = (token: string): CredentialKind => {
  for (const kind of ["support", "device", "api"] as const)
    if (token.startsWith(CREDENTIALS[kind].prefix!)) return kind;

  return "session";
};

/**
 * Statements revoking EVERY credential a user holds — browser sessions, API tokens, device
 * sessions (and their access tokens and unredeemed OAuth/device-code grants), support grants —
 * for recovery, closure and erasure. The user's push devices are disabled too: a registration
 * isn't bound to the credential that made it, so it must not outlive a revoke-everything.
 */
export const revokeAllCredentials = (
  db: D1SessionLike,
  clock: { now(): number },
  userId: string,
  reason: string,
  guard?: RevocationGuard,
): Array<D1StatementLike> => {
  const now = clock.now();

  return [
    ...(Object.keys(CREDENTIALS) as Array<CredentialKind>).flatMap((k) =>
      CREDENTIALS[k].revokeAllFor(db, now, userId, reason, guard),
    ),
    guarded(
      db,
      "UPDATE push_devices SET enabled = 0, disabled_at = ? WHERE user_id = ? AND enabled = 1",
      [now, userId],
      guard,
    ),
  ];
};
