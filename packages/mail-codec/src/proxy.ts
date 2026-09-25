import { hmacSha256 } from "@bye/domain";
import { base64Url, fromBase64Url, utf8Encode } from "./encoding.ts";

// Image proxy helpers (E23, §10). Signing binds a URL to our proxy so the proxy cannot be used
// as an open fetcher; target checks block SSRF destinations. DNS rebinding must additionally be
// defended at fetch time by checking every resolved address with `isForbiddenIp`.

const parseIPv4 = (host: string): Array<number> | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
};

const ipv4Forbidden = ([a, b, c]: Array<number>): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b! >= 64 && b! <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b! >= 16 && b! <= 31) ||
  (a === 192 && b === 0 && (c === 0 || c === 2)) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  (a === 198 && b === 51 && c === 100) ||
  (a === 203 && b === 0 && c === 113) ||
  a! >= 224;

const expandIPv6 = (host: string): Array<number> | undefined => {
  const h = host.toLowerCase().replace(/(\d+\.\d+\.\d+\.\d+)$/, (v4) => {
    const o = parseIPv4(v4) ?? [256, 0, 0, 0];
    return `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  });
  const halves = h.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) =>
    s ? s.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : Number.NaN)) : [];
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const groups = [...left, ...Array.from<number>({ length: fill }).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g > 0xffff))
    return undefined;
  return groups;
};

const ipv6Forbidden = (g: Array<number>): boolean => {
  const allZero = g.slice(0, 7).every((x) => x === 0);
  if (allZero && (g[7] === 0 || g[7] === 1)) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b;
  if (mapped || nat64) return ipv4Forbidden([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  return false;
};

/** Check a literal IP (as resolved by DNS) against private, loopback, link-local, and metadata ranges. */
export const isForbiddenIp = (ip: string): boolean => {
  const host = ip.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(host);
  if (v4) return ipv4Forbidden(v4);
  if (host.includes(":")) {
    const v6 = expandIPv6(host.split("%")[0]!);
    return v6 === undefined ? true : ipv6Forbidden(v6);
  }
  return false;
};

const FORBIDDEN_HOSTS =
  /(^|\.)(localhost|local|internal|localdomain|home\.arpa|intranet|corp|lan)$/i;

export const isForbiddenProxyTarget = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (url.username || url.password) return true;
  if (url.port !== "") return true;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || host.includes(":"))
    return isForbiddenIp(host) || (/^[\d.]+$/.test(host) && !parseIPv4(host));
  if (!host.includes(".")) return true;
  if (FORBIDDEN_HOSTS.test(host)) return true;
  if (host === "metadata.google.internal" || host.endsWith(".nip.io") || host.endsWith(".sslip.io"))
    return true;
  return false;
};

/** WebCrypto wants ArrayBuffer-backed views; copy to decouple from SharedArrayBuffer typing. */
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

const importKey = (key: Uint8Array | string) =>
  crypto.subtle.importKey(
    "raw",
    bytes(typeof key === "string" ? utf8Encode(key) : key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

/** Produce `${base}?u=<b64url(url)>&s=<b64url(hmac)>`. */
export const signProxyUrl = async (
  url: string,
  key: Uint8Array | string,
  base = "/img",
): Promise<string> => {
  const payload = utf8Encode(url);
  const sig = await hmacSha256(
    bytes(typeof key === "string" ? utf8Encode(key) : key),
    bytes(payload),
  );
  return `${base}?u=${base64Url(payload)}&s=${base64Url(sig)}`;
};

/** Verify a signed proxy request; returns the target URL or null. Uses WebCrypto's constant-time verify. */
export const verifyProxyUrl = async (
  requestUrl: string | URL,
  key: Uint8Array | string,
): Promise<string | null> => {
  const parsed =
    typeof requestUrl === "string" ? new URL(requestUrl, "https://proxy.invalid") : requestUrl;
  const u = parsed.searchParams.get("u");
  const s = parsed.searchParams.get("s");
  if (!u || !s) return null;
  const payload = fromBase64Url(u);
  const sig = fromBase64Url(s);
  if (!payload || !sig || sig.length !== 32) return null;
  const ok = await crypto.subtle.verify("HMAC", await importKey(key), bytes(sig), bytes(payload));
  if (!ok) return null;
  const target = new TextDecoder().decode(payload);
  return isForbiddenProxyTarget(target) ? null : target;
};
