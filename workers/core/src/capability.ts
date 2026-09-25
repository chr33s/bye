import { hmacBase64Url, textFromBase64Url, textToBase64Url, timingSafeEqual } from "@bye/domain";
import { parseSecretRing, ringVersions, type SecretRing } from "@bye/platform-cloudflare";

// Signed, expiring capabilities (render/preview/download/inline links, day-photo reads, signup
// retries, export downloads) in ONE wire format:
//
//   <purpose>.<base64url field>….<expiresAt>.<base64url HMAC-SHA256(key, "cap:" + everything before)>
//
// The purpose is bound into the MAC, so a token minted for one use never verifies for another, and
// every field (IDs, storage keys) is bound too. Verification is constant-time.
//
// `key` may be a versioned ring (`v2:<key>,v1:<key>`, see `parseSecretRing`): tokens are minted
// under the current key and verify under any key still in the ring, so a rotation never
// invalidates a live link before its TTL ends.

export type CapabilityPurpose =
  | "render"
  | "preview"
  | "download"
  | "inline"
  | "dayphoto"
  | "signup"
  | "export";

export const mint = async (
  key: string | SecretRing,
  purpose: CapabilityPurpose,
  fields: ReadonlyArray<string>,
  ttlMs: number,
  now: number,
): Promise<string> => {
  const payload = [purpose, ...fields.map(textToBase64Url), String(now + ttlMs)].join(".");
  const ring = parseSecretRing(key);
  return `${payload}.${await hmacBase64Url(ring.secrets[ring.current]!, `cap:${payload}`)}`;
};

/** The token's fields when it is a valid, unexpired `purpose` capability with `arity` fields; else null. */
export const verify = async (
  key: string | SecretRing,
  purpose: CapabilityPurpose,
  token: string,
  arity: number,
  now: number,
): Promise<ReadonlyArray<string> | null> => {
  const parts = token.split(".");
  if (parts.length !== arity + 3 || parts[0] !== purpose) return null;
  if (!(Number(parts[parts.length - 2]) > now)) return null;
  const payload = parts.slice(0, -1).join(".");
  const ring = parseSecretRing(key);
  let valid = false;
  for (const version of ringVersions(ring)) {
    const mac = await hmacBase64Url(ring.secrets[version]!, `cap:${payload}`);
    if (timingSafeEqual(parts[parts.length - 1]!, mac)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  try {
    return parts.slice(1, -2).map(textFromBase64Url);
  } catch {
    return null;
  }
};

/** The purpose a token claims (dispatch only — always `verify` before trusting it). */
export const purposeOf = (token: string): string => token.slice(0, Math.max(0, token.indexOf(".")));
