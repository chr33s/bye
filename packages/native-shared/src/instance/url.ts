// The one instance-URL parser and normalizer every client (iOS, Android, macOS, Windows, CLI) uses
// (spec §10 Instance selection). Hermes' URL polyfill is incomplete, so this
// never relies on `URL`. Anything ambiguous is rejected rather than silently rewritten: no dropped
// paths, no merged aliases, no certificate bypass (TLS is always the platform's).

export type PrivateNetworkPolicy = "block" | "allow";

export type InstanceUrlError =
  | "empty"
  | "malformed"
  | "insecure-scheme"
  | "unsupported-scheme"
  | "credentials"
  | "query"
  | "fragment"
  | "invalid-host"
  | "invalid-port"
  | "invalid-path"
  | "private-network";

export type NormalizedInstanceUrl =
  | {
      readonly ok: true;
      /** `https://host[:port][/base/path]`, no trailing slash: the instance identity. */
      readonly url: string;
      /** `https://host[:port]`. */
      readonly origin: string;
      readonly host: string;
      readonly port: number | null;
      /** `""` or `/base/path`. */
      readonly path: string;
    }
  | { readonly ok: false; readonly reason: InstanceUrlError };

export interface NormalizeOptions {
  /** Private, loopback and link-local literals are refused unless explicitly allowed. */
  readonly privateNetwork?: PrivateNetworkPolicy;
  /** Manual entry only: `mail.example.com` means `https://mail.example.com`. Links never assume. */
  readonly assumeHttps?: boolean;
  /** Development only (CLI `BYE_INSECURE_LOOPBACK=1`): accept plain http to localhost, 127.0.0.1
   *  or [::1]. Never set by the apps; every other http address is still refused. */
  readonly insecureLoopback?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const fail = (reason: InstanceUrlError): NormalizedInstanceUrl => ({ ok: false, reason });

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const IPV6 = /^\[[0-9a-f:.]{2,45}\]$/;

// RFC 3986 pchar, without "%" handled separately.
const SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;

const ipv4Private = (host: string): boolean => {
  const [a, b] = host.split(".").map(Number) as [number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const ipv6Private = (bracketed: string): boolean => {
  const h = bracketed.slice(1, -1);

  if (h === "::1" || h === "::") return true;

  if (h.startsWith("::ffff:")) return true; // IPv4-mapped: judge by the v4 policy (block)
  const first = h.split(":")[0] ?? "";
  const n = first === "" ? 0 : parseInt(first, 16);

  return (n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80 || (n & 0xff00) === 0xff00;
};

/** Hostnames that only resolve on a local network. */
const localName = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".local") ||
  host.endsWith(".internal") ||
  host.endsWith(".home.arpa") ||
  !host.includes(".");

const upperHex = (segment: string) => segment.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());

export const normalizeInstanceUrl = (
  raw: string,
  options: NormalizeOptions = {},
): NormalizedInstanceUrl => {
  const input = raw.trim();

  if (!input) return fail("empty");

  // Whitespace, controls and backslashes are never part of a valid instance address.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f\\]/.test(input)) return fail("malformed");

  const withScheme =
    options.assumeHttps && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) ? `https://${input}` : input;

  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(withScheme);

  if (!m) return fail("malformed");
  const scheme = m[1]!.toLowerCase();
  const insecure = scheme === "http" && options.insecureLoopback === true;

  if (scheme === "http" && !insecure) return fail("insecure-scheme");

  if (scheme !== "https" && !insecure) return fail("unsupported-scheme");
  const authority = m[2]!;

  if (authority.includes("@")) return fail("credentials");

  if (m[4] !== undefined) return fail("query");

  if (m[5] !== undefined) return fail("fragment");

  const hp = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(authority);

  if (!hp) return fail("invalid-host");
  const host = hp[1]!.toLowerCase();
  let port: number | null = null;

  if (hp[2] !== undefined) {
    if (!/^\d{1,5}$/.test(hp[2])) return fail("invalid-port");
    port = Number(hp[2]);

    if (port < 1 || port > 65535) return fail("invalid-port");

    if (port === (insecure ? 80 : 443)) port = null;
  }

  if (insecure && !LOOPBACK_HOSTS.has(host)) return fail("insecure-scheme");

  let isPrivate: boolean;

  if (host.startsWith("[")) {
    if (!IPV6.test(host)) return fail("invalid-host");
    isPrivate = ipv6Private(host);
  } else if (IPV4.test(host)) {
    isPrivate = ipv4Private(host);
  } else {
    const labels = host.split(".");

    if (host.length === 0 || host.length > 253 || !labels.every((l) => LABEL.test(l)))
      return fail("invalid-host"); // includes trailing dots, IDN and percent-encoded hosts

    // A numeric final label is an IPv4 shorthand (0x7f.1, 2130706433): an alias, never accepted.
    if (/^(0x[0-9a-f]*|\d+)$/.test(labels.at(-1)!)) return fail("invalid-host");
    isPrivate = localName(host);
  }

  if (isPrivate && !insecure && options.privateNetwork !== "allow") return fail("private-network");

  const rawPath = m[3]!;
  const segments = rawPath.split("/").slice(1);

  if (segments.at(-1) === "") segments.pop(); // one trailing slash is insignificant

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return fail("invalid-path");

    if (!SEGMENT.test(segment)) return fail("invalid-path");

    if (/%(2f|5c|2e)/i.test(segment)) return fail("invalid-path");
  }

  const path = segments.length ? `/${segments.map(upperHex).join("/")}` : "";
  const origin = `${insecure ? "http" : "https"}://${host}${port === null ? "" : `:${port}`}`;

  return { ok: true, url: `${origin}${path}`, origin, host, port, path };
};

export const INSTANCE_URL_ERRORS: Readonly<Record<InstanceUrlError, string>> = {
  empty: "Enter a server address.",
  malformed: "That isn't a valid server address.",
  "insecure-scheme": "The server address must use https.",
  "unsupported-scheme": "The server address must start with https://.",
  credentials: "Server addresses can't contain a user name or password.",
  query: "Server addresses can't contain a query (?…).",
  fragment: "Server addresses can't contain a fragment (#…).",
  "invalid-host": "The server's host name isn't valid.",
  "invalid-port": "The server's port isn't valid.",
  "invalid-path": "The server's path isn't valid.",
  "private-network": "Private and local network addresses aren't supported.",
};
