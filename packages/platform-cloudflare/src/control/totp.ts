// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) second factor (A03).

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;

    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += B32[(value << (5 - bits)) & 31];

  return out;
};

export const base32Decode = (s: string): Uint8Array<ArrayBuffer> => {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  const out: Array<number> = [];
  let bits = 0;
  let value = 0;

  for (const c of clean) {
    const i = B32.indexOf(c);

    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
};

export const TOTP_STEP_SECONDS = 30;

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export const hotp = async (
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
  digits = 6,
): Promise<string> => {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));

  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;

  return String(bin % 10 ** digits).padStart(digits, "0");
};

/**
 * Verify a code within ±1 step. Returns the matched step so callers can reject reuse
 * of the same or an earlier step (replay protection).
 */
export const verifyTotp = async (
  secret: Uint8Array<ArrayBuffer>,
  code: string,
  nowMs: number,
  lastStep: number,
): Promise<number | null> => {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);

  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;

    if ((await hotp(secret, step)) === code) return step;
  }

  return null;
};

export const otpauthUri = (secretB32: string, account: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
