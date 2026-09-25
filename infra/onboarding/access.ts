// Cloudflare Access identity for the onboarding service (spec.md §15.11). Behind Access, every
// request carries `Cf-Access-Jwt-Assertion`: an RS256 JWT signed by the team's keys. The operator
// is the verified token's `email`, never a bare header: anyone who reaches the origin directly
// could set `cf-access-authenticated-user-email` themselves.
//
// Checked: signature (RS256 with a key from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs,
// cached and refetched on an unknown `kid`), `iss` = the team domain, `aud` contains the
// application's AUD tag, `exp`/`nbf` with a small clock skew, and a non-empty `email`.
import { createPublicKey, type JsonWebKey, verify } from "node:crypto";
import type { Fetch } from "./oauth.ts";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export interface AccessConfig {
  /** Team domain, e.g. `https://myteam.cloudflareaccess.com` (a bare host is accepted). */
  readonly teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  readonly audience: string;
}

interface Jwk extends JsonWebKey {
  readonly kid?: string;
}

export interface AccessVerifierOptions extends AccessConfig {
  readonly fetch: Fetch;
  readonly now?: () => number;
  /** How long fetched keys are trusted before a refetch (default 1 hour). */
  readonly cacheMs?: number;
  /** Minimum gap between refetches triggered by an unknown `kid` (default 60 s). */
  readonly refetchMs?: number;
}

const SKEW_S = 60;

export const normalizeTeamDomain = (team: string): string => {
  const url = new URL(team.includes("://") ? team : `https://${team}`);
  if (url.protocol !== "https:") throw new Error("the Access team domain must be https");
  return url.origin;
};

const b64urlJson = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Returns a verifier: JWT string → the verified operator email, or null for anything invalid.
 * Never throws for bad tokens; a certs fetch failure yields null (fail closed).
 */
export const accessVerifier = (o: AccessVerifierOptions) => {
  const issuer = normalizeTeamDomain(o.teamDomain);
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 3600_000;
  const refetchMs = o.refetchMs ?? 60_000;
  let keys: ReadonlyArray<Jwk> = [];
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        const r = await o.fetch(certsUrl);
        if (!r.ok) return;
        const body = (await r.json()) as { keys?: ReadonlyArray<Jwk> };
        if (Array.isArray(body.keys)) {
          keys = body.keys.filter((k) => k.kty === "RSA");
          fetchedAt = now();
        }
      } catch {
        // Keep the previous keys; the token is refused if none match.
      } finally {
        inflight = null;
      }
    })());

  const keyFor = async (kid: string | undefined): Promise<Jwk | undefined> => {
    const find = () => keys.find((k) => kid === undefined || k.kid === kid);
    if (now() - fetchedAt > cacheMs) await refresh();
    let key = find();
    if (key === undefined && now() - fetchedAt > refetchMs) {
      await refresh();
      key = find();
    }
    return key;
  };

  return async (token: string | null | undefined): Promise<string | null> => {
    if (!token || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts as [string, string, string];
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (!header || !payload || header.alg !== "RS256") return null;
    const key = await keyFor(typeof header.kid === "string" ? header.kid : undefined);
    if (!key) return null;
    let valid = false;
    try {
      valid = verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(sig, "base64url"),
      );
    } catch {
      return null;
    }
    if (!valid) return null;
    if (payload.iss !== issuer) return null;
    const aud = payload.aud;
    if (!(Array.isArray(aud) ? aud.includes(o.audience) : aud === o.audience)) return null;
    const t = Math.floor(now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + SKEW_S < t) return null;
    if (typeof payload.nbf === "number" && payload.nbf - SKEW_S > t) return null;
    const email = payload.email;
    return typeof email === "string" && email.length > 0 && email.length <= 256 ? email : null;
  };
};
