import { sha256 } from "./sha256.ts";

// PKCE (RFC 7636) and request state for the browser authorization-code flow (RFC 8252).
// Only S256 is supported; `plain` is never offered.

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const base64Url = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63]!;
  }
  return out;
};

const utf8 = (s: string): Uint8Array => {
  const out: Array<number> = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
};

export type RandomBytes = (length: number) => Uint8Array;

export const secureRandom: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/** 32 random bytes → 43-character verifier (RFC 7636 §4.1). */
export const createCodeVerifier = (random: RandomBytes = secureRandom): string =>
  base64Url(random(32));

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) (RFC 7636 §4.2). */
export const codeChallengeS256 = (verifier: string): string => {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new Error("invalid code verifier");
  return base64Url(sha256(utf8(verifier)));
};

/** Transaction-bound, single-use request state (RFC 6749 §10.12, RFC 9700 §2.1). */
export const createState = (random: RandomBytes = secureRandom): string => base64Url(random(24));

/** The platform-wide constant-time compare (@bye/domain). */
export { timingSafeEqual as constantTimeEqual } from "@bye/domain";

export { utf8 as utf8Encode };
