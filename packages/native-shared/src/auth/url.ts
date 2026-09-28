// Minimal URL helpers. React Native's URL/URLSearchParams polyfill is incomplete under Hermes, so
// the auth flow never depends on it.

export interface ParsedUrl {
  /** scheme://authority/path without query or fragment, lower-cased scheme and host. */
  readonly base: string;
  readonly query: ReadonlyMap<string, string>;
  readonly fragment: string;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return "";
  }
};

export const parseUrl = (url: string): ParsedUrl | null => {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
    url.trim(),
  );

  if (!m) return null;
  const query = new Map<string, string>();

  for (const pair of (m[4] ?? "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));

    // Duplicate parameters are ambiguous; the first wins and later duplicates are ignored.
    if (!query.has(key)) query.set(key, decode(eq < 0 ? "" : pair.slice(eq + 1)));
  }

  return {
    base: `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3] ?? ""}`,
    query,
    fragment: m[5] ?? "",
  };
};

/** Normalize an origin (scheme://host[:port]) and require https except for local development. */
export const normalizeOrigin = (origin: string): string => {
  const m = /^(https?):\/\/([^/?#]+)\/?$/i.exec(origin.trim());

  if (!m) throw new Error("invalid origin");
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!.toLowerCase();

  if (scheme !== "https" && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
    throw new Error("origin must be https");

  return `${scheme}://${host}`;
};

/** Append parameters; an endpoint that already has a query keeps it (RFC 6749 §3.1). */
export const withQuery = (base: string, params: ReadonlyArray<readonly [string, string]>): string =>
  `${base}${base.includes("?") ? "&" : "?"}${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
