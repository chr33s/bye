// Sender Rewriting Scheme (SRS) for forwarding (§5.3 ForwardingTransport, §5.4). Compatible with the
// libsrs2 / Shevek scheme: SRS0 for first-hop rewrites and SRS1 for re-forwarding an SRS0 address.
//
//   SRS0=HHHH=TT=orig-domain=orig-local@forwarder
//   SRS1=HHHH=srs0-host==HHHH=TT=orig-domain=orig-local@forwarder
//
// HHHH is a truncated base64 HMAC-SHA1 over the rest (compared case-insensitively); TT is a 10-bit
// day timestamp in base32. Bounces to an SRS address are reversed only if the hash verifies and
// the timestamp is within the maximum age, so the forwarder never becomes an open relay.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TIME_PRECISION = 86_400_000; // one day
const TIME_SLOTS = 1024; // 10 bits
export const SRS_HASH_LENGTH = 4;
export const SRS_MAX_AGE_DAYS = 21;

const enc = new TextEncoder();

const hmacHash = async (secret: string, ...parts: ReadonlyArray<string>): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(parts.join("").toLowerCase())),
  );
  let s = "";
  for (const b of mac) s += String.fromCharCode(b);
  return btoa(s).slice(0, SRS_HASH_LENGTH);
};

export const srsTimestamp = (now: number): string => {
  const t = Math.floor(now / TIME_PRECISION) % TIME_SLOTS;
  return BASE32[(t >> 5) & 31]! + BASE32[t & 31]!;
};

const timestampAgeDays = (ts: string, now: number): number | null => {
  if (ts.length !== 2) return null;
  const hi = BASE32.indexOf(ts[0]!.toUpperCase());
  const lo = BASE32.indexOf(ts[1]!.toUpperCase());
  if (hi < 0 || lo < 0) return null;
  const then = (hi << 5) | lo;
  const today = Math.floor(now / TIME_PRECISION) % TIME_SLOTS;
  return (today - then + TIME_SLOTS) % TIME_SLOTS;
};

const splitAddress = (address: string): { local: string; domain: string } | null => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
};

export interface SrsConfig {
  readonly secret: string;
  /** Forwarding domain the rewritten envelope sender belongs to (SPF-aligned). */
  readonly domain: string;
  readonly maxAgeDays?: number;
}

/** Rewrite an envelope sender for forwarding. An empty (null) sender stays empty. */
export const srsForward = async (
  config: SrsConfig,
  sender: string,
  now = Date.now(),
): Promise<string> => {
  if (!sender) return "";
  const parts = splitAddress(sender);
  if (!parts) throw new Error("invalid envelope sender");
  if (parts.domain.toLowerCase() === config.domain.toLowerCase()) return sender;
  const local = parts.local;
  if (/^SRS0[=+-]/i.test(local)) {
    // Re-forward an SRS0 address: SRS1=HASH=srs0host==opaque@us
    const opaque = local.slice(4); // keeps the leading separator
    const hash = await hmacHash(config.secret, parts.domain, opaque);
    return `SRS1=${hash}=${parts.domain}=${opaque}@${config.domain}`;
  }
  if (/^SRS1[=+-]/i.test(local)) {
    // Already SRS1: keep the original SRS0 host and opaque part, re-hash for our domain.
    const m = /^SRS1[=+-][^=]+=([^=]+)=(.*)$/i.exec(local);
    if (!m) throw new Error("malformed SRS1 address");
    const [, host, opaque] = m;
    const hash = await hmacHash(config.secret, host!, opaque!);
    return `SRS1=${hash}=${host}=${opaque}@${config.domain}`;
  }
  const ts = srsTimestamp(now);
  const hash = await hmacHash(config.secret, ts, parts.domain, local);
  return `SRS0=${hash}=${ts}=${parts.domain}=${local}@${config.domain}`;
};

export type SrsReverse =
  | { readonly _tag: "Ok"; readonly address: string }
  | { readonly _tag: "Invalid"; readonly reason: "not-srs" | "bad-hash" | "expired" | "malformed" };

const safeEqual = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};

/** Reverse a bounce address. SRS1 reverses to the previous hop's SRS0 address. */
export const srsReverse = async (
  config: SrsConfig,
  address: string,
  now = Date.now(),
): Promise<SrsReverse> => {
  const parts = splitAddress(address);
  if (!parts || parts.domain.toLowerCase() !== config.domain.toLowerCase())
    return { _tag: "Invalid", reason: "not-srs" };
  const local = parts.local;
  if (/^SRS0[=+-]/i.test(local)) {
    const m = /^SRS0[=+-]([^=]+)=([^=]+)=([^=]+)=(.+)$/i.exec(local);
    if (!m) return { _tag: "Invalid", reason: "malformed" };
    const [, hash = "", ts = "", domain = "", origLocal = ""] = m;
    if (!safeEqual(hash, await hmacHash(config.secret, ts, domain, origLocal)))
      return { _tag: "Invalid", reason: "bad-hash" };
    const age = timestampAgeDays(ts, now);
    if (age === null || age > (config.maxAgeDays ?? SRS_MAX_AGE_DAYS))
      return { _tag: "Invalid", reason: "expired" };
    return { _tag: "Ok", address: `${origLocal}@${domain}` };
  }
  if (/^SRS1[=+-]/i.test(local)) {
    const m = /^SRS1[=+-]([^=]+)=([^=]+)=(.*)$/i.exec(local);
    if (!m) return { _tag: "Invalid", reason: "malformed" };
    const [, hash = "", host = "", opaque = ""] = m;
    if (!safeEqual(hash, await hmacHash(config.secret, host, opaque)))
      return { _tag: "Invalid", reason: "bad-hash" };
    return { _tag: "Ok", address: `SRS0${opaque}@${host}` };
  }
  return { _tag: "Invalid", reason: "not-srs" };
};
