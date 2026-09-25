import { isForbiddenIp } from "@bye/mail-codec";

// Resolved-address checks for outbound fetches of user-controlled URLs (§10 image proxy): DNS
// rebinding defense. A hostname is resolved over DNS-over-HTTPS (A and AAAA) before every hop and
// refused when ANY answer is private, loopback, link-local, CGNAT or metadata, or when resolution
// fails. Workers can't pin the connection to the checked address, so this is best-effort against
// a hostile authoritative server that answers differently within its TTL (time-of-check/
// time-of-use); the deployment control that closes that gap is the pinning egress proxy.

export type DohFetch = (url: string, init: RequestInit) => Promise<Response>;

type DohAnswer = { readonly type: number; readonly data: string };

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Why a host may not be fetched, or null when every resolved address is public. */
export const forbiddenResolution = async (
  hostname: string,
  doh: DohFetch,
): Promise<string | null> => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":"))
    return isForbiddenIp(host) ? "forbidden address" : null;
  // A and AAAA are queried together (fixed pair): one round trip of latency per hop, not two.
  const lookup = async (type: "A" | "AAAA"): Promise<ReadonlyArray<string> | null> => {
    try {
      const response = await doh(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        Status?: number;
        Answer?: ReadonlyArray<DohAnswer>;
      } | null;
      return body
        ? (body.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data)
        : null;
    } catch {
      return null;
    }
  };
  const [v4, v6] = await Promise.all([lookup("A"), lookup("AAAA")]);
  if (v4 === null || v6 === null) return "resolution failed";
  const answers = [...v4, ...v6];
  if (answers.length === 0) return "did not resolve";
  return answers.some((ip) => isForbiddenIp(ip)) ? "resolves to a forbidden address" : null;
};

/**
 * Read a response body up to `max` bytes. Returns null — and cancels the stream at once — as soon
 * as it grows past `max`, so an oversized (or unannounced chunked) body is never buffered.
 */
export const readCapped = async (response: Response, max: number): Promise<Uint8Array | null> => {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};
