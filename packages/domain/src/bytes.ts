// The canonical byte, encoding and hashing primitives (WebCrypto only; no Node APIs). Every
// package imports these instead of keeping a local copy, so a security fix lands once.

const encoder = new TextEncoder();

export const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(s) as Uint8Array<ArrayBuffer>;

export const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Strict decode: throws on malformed input. */
export const fromBase64Url = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Lenient decode for untrusted input: `undefined` instead of throwing. */
export const tryFromBase64Url = (s: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return undefined;
  try {
    return fromBase64Url(s.replace(/=+$/, ""));
  } catch {
    return undefined;
  }
};

/** base64url of a UTF-8 string (and back), for text carried inside tokens. */
export const textToBase64Url = (s: string): string => toBase64Url(utf8(s));
export const textFromBase64Url = (s: string): string => new TextDecoder().decode(fromBase64Url(s));

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const sha256 = async (
  data: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8(data) : data),
  );

export const sha256Hex = async (data: string): Promise<string> => toHex(await sha256(data));

export const hmacSha256 = async (
  key: Uint8Array<ArrayBuffer> | string,
  data: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? utf8(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, typeof data === "string" ? utf8(data) : data),
  );
};

export const hmacHex = async (
  key: Uint8Array<ArrayBuffer> | string,
  data: string,
): Promise<string> => toHex(await hmacSha256(key, data));
export const hmacBase64Url = async (
  key: Uint8Array<ArrayBuffer> | string,
  data: string,
): Promise<string> => toBase64Url(await hmacSha256(key, data));

/**
 * Constant-time string comparison. Runs over the longer input with no early exit, so neither the
 * position of the first mismatch nor (beyond the length itself) the content leaks through timing.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

/**
 * `Authorization: Bearer <token>` equals `secret` (constant time; both sides trimmed). A missing,
 * empty or shorter-than-`minSecretLength` secret never matches, so an unset token can't open a route.
 */
export const bearerMatches = (
  header: string | null | undefined,
  secret: string | null | undefined,
  minSecretLength = 1,
): boolean => {
  const expected = (secret ?? "").trim();
  if (expected.length < minSecretLength || !header || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  return token.length > 0 && timingSafeEqual(token, expected);
};

export const concatBytes = (...parts: Array<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** HTML-escape text for element content and quoted attribute values. */
export const escapeHtml = (v: string): string =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
