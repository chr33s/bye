// Credentials at rest (spec.md §15.11 "Encrypt stored OAuth credentials"). AES-256-GCM with a
// versioned key ring, the same `v2:<hex>,v1:<hex>` shape as BYE_STATE_ENCRYPTION_KEY. The
// installation ID is the additional authenticated data, so a sealed record opens only for the
// installation it was written for.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Buffer#toString with an encoding. infra's tsconfig also loads @cloudflare/workers-types, whose
 * Uint8Array#toString() signature shadows Node's overload.
 */
export const encode = (b: Uint8Array, encoding: "base64" | "base64url" | "hex" | "utf8"): string =>
  (Buffer.prototype.toString as (this: Uint8Array, e: string) => string).call(b, encoding);

export interface KeyRing {
  readonly current: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface Sealed {
  readonly v: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export const parseKeyRing = (value: string | undefined): KeyRing => {
  const entries = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^(v\d+):([0-9a-f]{64})$/i.exec(entry);
      if (!m) throw new Error("BYE_ONBOARDING_KEYS entries must be v<n>:<64 hex>");
      return [m[1]!, Buffer.from(m[2]!, "hex")] as const;
    });
  if (entries.length === 0) throw new Error("BYE_ONBOARDING_KEYS is not set");
  return { current: entries[0]![0], keys: new Map(entries) };
};

export const seal = (ring: KeyRing, value: unknown, aad: string): Sealed => {
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: ring.current,
    iv: encode(iv, "base64url"),
    ct: encode(ct, "base64url"),
    tag: encode(cipher.getAuthTag(), "base64url"),
  };
};

export const open = <T>(ring: KeyRing, sealed: Sealed, aad: string): T => {
  const key = ring.keys.get(sealed.v);
  if (!key) throw new Error(`onboarding key ${sealed.v} is unavailable`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(encode(pt, "utf8")) as T;
};
