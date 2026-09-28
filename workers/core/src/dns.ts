import { Predicate } from "effect";
import { isForbiddenIp, isForbiddenProxyTarget } from "@bye/mail-codec";

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

/** Default deadline for a guarded request that carries none of its own. */
export const GUARDED_FETCH_TIMEOUT_MS = 30_000;

const blocked = () =>
  new Response("destination not allowed", {
    status: 403,
    headers: { "x-bye-egress": "blocked" },
  });

/**
 * `fetch` for user-chosen endpoints (external-identity relays and OAuth token endpoints): https
 * only, the lexical forbidden-target rules, then resolve-then-check (`forbiddenResolution`) on
 * every request, `redirect: "manual"` (a 3xx comes back as-is and callers treat it as a failed
 * submission, so a redirect can't lead to an unchecked host), and a deadline. A forbidden
 * destination gets a synthetic 403 without any request being sent; a failed lookup throws like a
 * native DNS error. Same TOCTOU residual as the image proxy (see above).
 */
export const guardedFetch = (
  fetchFn: typeof fetch,
  timeoutMs = GUARDED_FETCH_TIMEOUT_MS,
  doh: DohFetch = (u, i) => fetchFn(u, { ...i, signal: AbortSignal.timeout(timeoutMs) }),
): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = Predicate.isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    let url: URL;

    try {
      url = new URL(raw);
    } catch {
      return blocked();
    }

    if (url.protocol !== "https:" || isForbiddenProxyTarget(url.toString())) return blocked();
    const why = await forbiddenResolution(url.hostname, doh);

    if (why === "resolution failed") throw new TypeError("destination could not be resolved");

    if (why !== null) return blocked();

    return fetchFn(input, {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }) as typeof fetch;

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
