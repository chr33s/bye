// WebCrypto helpers shared by auth, links, billing, and subscriptions. No Node APIs.
import { Predicate } from "effect";

export {
  concatBytes,
  fromBase64Url,
  fromHex,
  hmacSha256,
  sha256,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
  toHex,
  utf8,
} from "@bye/domain";

import { fromBase64Url, toBase64Url } from "@bye/domain";

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(n));

/** Unguessable bearer token (256 bits). Only its hash is stored. */
export const randomToken = (bytes = 32): string => toBase64Url(randomBytes(bytes));

/** AES-GCM envelope for credentials at rest with a versioned key-encryption key (§10). */
export interface VersionedKeys {
  readonly current: number;
  readonly keys: Readonly<Record<number, Uint8Array<ArrayBuffer>>>;
}

export const sealWithKey = async (
  keys: VersionedKeys,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ keyVersion: number; iv: string; ciphertext: string }> => {
  const raw = keys.keys[keys.current];

  if (!raw) throw new Error("missing current key version");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  return { keyVersion: keys.current, iv: toBase64Url(iv), ciphertext: toBase64Url(ct) };
};

export const openWithKey = async (
  keys: VersionedKeys,
  sealed: { keyVersion: number; iv: string; ciphertext: string },
): Promise<Uint8Array<ArrayBuffer>> => {
  const raw = keys.keys[sealed.keyVersion];

  if (!raw) throw new UnknownKeyVersion("seal", sealed.keyVersion);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);

  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(sealed.iv) },
      key,
      fromBase64Url(sealed.ciphertext),
    ),
  );
};

/**
 * A versioned ring of root secrets (e.g. SESSION_KEY), in the same `v2:<key>,v1:<key>` shape as
 * BYE_STATE_ENCRYPTION_KEY: the FIRST entry is current (new seals, hashes and tokens use it); the
 * rest stay readable until everything written under them has been rotated or has expired. A plain
 * single value (no `v<n>:` prefixes) is the version-1 key, so existing deployments keep working.
 */
export interface SecretRing {
  readonly current: number;
  readonly secrets: Readonly<Record<number, string>>;
}

/** A value written under a key version that is no longer (or not yet) in the ring. */
export class UnknownKeyVersion extends Error {
  readonly _tag = "UnknownKeyVersion" as const;
  constructor(
    readonly purpose: string,
    readonly version: number,
  ) {
    super(`${purpose}: key version ${version} is not in the key ring`);
    this.name = "UnknownKeyVersion";
  }
}

const RING_ENTRY = /^v(\d+):(.+)$/s;

export const parseSecretRing = (value: string | SecretRing): SecretRing => {
  if (!Predicate.isString(value)) return value;
  const entries = value.split(",").map((s) => s.trim());
  const parsed = entries.map((e) => RING_ENTRY.exec(e));

  if (entries.length === 0 || parsed.some((m) => m === null || Number(m[1]) < 1))
    return { current: 1, secrets: { 1: value } };
  const secrets: Record<number, string> = {};

  for (const m of parsed) {
    const version = Number(m![1]);

    if (secrets[version] !== undefined) throw new Error(`duplicate key version v${version}`);
    secrets[version] = m![2]!;
  }

  return { current: Number(parsed[0]![1]), secrets };
};

/** The ring's secret for `version`, or a tagged `UnknownKeyVersion`. */
export const secretFor = (ring: SecretRing, version: number, purpose: string): string => {
  const secret = ring.secrets[version];

  if (secret === undefined) throw new UnknownKeyVersion(purpose, version);

  return secret;
};

/** Every version in the ring, current first. */
export const ringVersions = (ring: SecretRing): ReadonlyArray<number> => [
  ring.current,
  ...Object.keys(ring.secrets)
    .map(Number)
    .filter((v) => v !== ring.current)
    .sort((a, b) => b - a),
];

/**
 * `<value>` tagged with the key version it was made under: `v<n>.<value>`. Untagged values are
 * version 1 (everything written before key rings existed).
 */
export const tagVersion = (version: number, value: string): string => `v${version}.${value}`;

export const untagVersion = (tagged: string): { version: number; value: string } => {
  const m = /^v(\d+)\.(.*)$/s.exec(tagged);

  return m ? { version: Number(m[1]), value: m[2]! } : { version: 1, value: tagged };
};
