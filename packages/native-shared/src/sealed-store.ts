import { base64Url, constantTimeEqual, type RandomBytes, secureRandom } from "./auth/pkce.ts";
import { sha256 } from "./auth/sha256.ts";
import { SecureStoreError, type SecureSessionStore } from "./auth/store.ts";
import type { KeyValueStore } from "./drafts.ts";

// Encrypted key-value storage for native drafts (§10: no plaintext mail at rest outside the OS
// secure store). AsyncStorage holds only ciphertext; the 256-bit key lives in the OS secure store
// (Keychain, Android Keystore, Windows Credential Manager), which is also why values are not stored
// there directly (Credential Manager caps a secret at 2.5 KB).
//
// Hermes has no crypto.subtle, so this uses the package's pure-TS SHA-256: HMAC-SHA256 as a PRF in
// counter mode for the keystream, and encrypt-then-MAC with a separate HMAC-SHA256 key over the
// version, storage key, nonce and ciphertext (a record can't be moved to another key or altered).

const VERSION = "s1.";
const NONCE = 16;
const TAG = 32;
const KEY_SLOT = "email.bye.drafts-key.v1";

// UTF-8 by hand: Hermes' TextEncoder/TextDecoder support varies by React Native version.
const enc = {
  encode: (s: string): Uint8Array => {
    const out: Array<number> = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    return new Uint8Array(out);
  },
};
const dec = {
  decode: (bytes: Uint8Array): string => {
    let out = "";
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i]!;
      const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
      if (n === 0 || i + n > bytes.length) throw new Error("invalid utf-8");
      let c = n === 1 ? b : b & (0xff >> (n + 1));
      for (let k = 1; k < n; k++) {
        const next = bytes[i + k]!;
        if ((next & 0xc0) !== 0x80) throw new Error("invalid utf-8");
        c = (c << 6) | (next & 63);
      }
      out += String.fromCodePoint(c);
      i += n;
    }
    return out;
  },
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  return sha256(concat(outer, sha256(concat(inner, message))));
};

const fromBase64Url = (value: string): Uint8Array | null => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const out: Array<number> = [];
  let bits = 0;
  let acc = 0;
  for (const ch of value) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

interface Keys {
  readonly enc: Uint8Array;
  readonly mac: Uint8Array;
}

const deriveKeys = (master: Uint8Array): Keys => ({
  enc: hmacSha256(master, enc.encode("bye drafts v1 encryption")),
  mac: hmacSha256(master, enc.encode("bye drafts v1 authentication")),
});

const keystreamXor = (key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(data.length);
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  for (let block = 0; block * 32 < data.length; block++) {
    view.setUint32(0, block);
    const stream = hmacSha256(key, concat(nonce, counter));
    const start = block * 32;
    for (let i = 0; i < 32 && start + i < data.length; i++)
      out[start + i] = data[start + i]! ^ stream[i]!;
  }
  return out;
};

const tagOf = (keys: Keys, storageKey: string, nonce: Uint8Array, ciphertext: Uint8Array) =>
  hmacSha256(keys.mac, concat(enc.encode(`${VERSION}${storageKey}\u0000`), nonce, ciphertext));

export const seal = (
  master: Uint8Array,
  storageKey: string,
  plaintext: string,
  random: RandomBytes = secureRandom,
): string => {
  const keys = deriveKeys(master);
  const nonce = random(NONCE);
  const ciphertext = keystreamXor(keys.enc, nonce, enc.encode(plaintext));
  return VERSION + base64Url(concat(nonce, ciphertext, tagOf(keys, storageKey, nonce, ciphertext)));
};

/** The plaintext, or null when the record is not authentic (tampered, moved or wrong key). */
export const open = (master: Uint8Array, storageKey: string, sealed: string): string | null => {
  if (!sealed.startsWith(VERSION)) return null;
  const bytes = fromBase64Url(sealed.slice(VERSION.length));
  if (!bytes || bytes.length < NONCE + TAG) return null;
  const keys = deriveKeys(master);
  const nonce = bytes.subarray(0, NONCE);
  const ciphertext = bytes.subarray(NONCE, bytes.length - TAG);
  const tag = bytes.subarray(bytes.length - TAG);
  if (!constantTimeEqual(base64Url(tag), base64Url(tagOf(keys, storageKey, nonce, ciphertext))))
    return null;
  try {
    return dec.decode(keystreamXor(keys.enc, nonce, ciphertext));
  } catch {
    return null;
  }
};

/**
 * The device's drafts key from the OS secure store, created on first use. Any storage error other
 * than "nothing stored yet" is surfaced: drafts are never written unencrypted as a fallback.
 */
export const secureStoreKey = (
  store: SecureSessionStore,
  random: RandomBytes = secureRandom,
): (() => Promise<Uint8Array>) => {
  let pending: Promise<Uint8Array> | null = null;
  const load = async (): Promise<Uint8Array> => {
    try {
      const existing = fromBase64Url(await store.read(KEY_SLOT));
      if (existing && existing.length === 32) return existing;
    } catch (error) {
      if (!(error instanceof SecureStoreError && error.kind === "MissingCredential")) throw error;
    }
    const created = random(32);
    await store.write(KEY_SLOT, base64Url(created));
    return created;
  };
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
};

/**
 * Wrap a key-value store so every value is sealed with the secure-store key. Values written by
 * older builds in plaintext are re-sealed the first time they are read; records that fail
 * authentication read as missing.
 */
export const sealedStore = (kv: KeyValueStore, key: () => Promise<Uint8Array>): KeyValueStore => ({
  getItem: async (name) => {
    const stored = await kv.getItem(name);
    if (stored === null) return null;
    const master = await key();
    if (stored.startsWith(VERSION)) return open(master, name, stored);
    await kv.setItem(name, seal(master, name, stored));
    return stored;
  },
  setItem: async (name, value) => kv.setItem(name, seal(await key(), name, value)),
  removeItem: (name) => kv.removeItem(name),
});
