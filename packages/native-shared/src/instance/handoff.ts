import { normalizeInstanceUrl } from "./url.ts";

// "Open in Bye" / QR handoff from Cloudflare onboarding (spec.md §15.11 OB10). The only
// variable payload is the deployed instance's HTTPS URL. It is an add-instance request: it never
// authenticates, selects, or authorizes anything, and it is handled apart from the OAuth callback.
//
//   bye://add-instance?url=https%3A%2F%2Fmail.example.com
//   https://mail.example.com                (a scanned QR code that holds just the address)

export const ADD_INSTANCE_LINK = "bye://add-instance";

export type HandoffResult =
  | { readonly _tag: "AddInstance"; readonly url: string }
  | { readonly _tag: "Rejected"; readonly reason: string }
  | { readonly _tag: "NotHandoff" };

export const addInstanceLink = (url: string): string =>
  `${ADD_INSTANCE_LINK}?url=${encodeURIComponent(url)}`;

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** Parse a handoff link or scanned code. Anything besides the one URL parameter is refused. */
export const parseInstanceHandoff = (
  raw: string,
  options: { scanned?: boolean } = {},
): HandoffResult => {
  const input = raw.trim();
  const link = /^bye:\/\/add-instance\/?(?:\?([^#]*))?(#.*)?$/i.exec(input);
  let candidate: string;

  if (link) {
    if (link[2] !== undefined) return { _tag: "Rejected", reason: "fragment" };
    const pairs = (link[1] ?? "").split("&").filter(Boolean);

    // Exactly one `url`: codes, tokens, state or credentials are never accepted here.
    if (pairs.length !== 1 || !pairs[0]!.startsWith("url="))
      return { _tag: "Rejected", reason: "unexpected-parameters" };
    const value = decode(pairs[0]!.slice(4));

    if (!value) return { _tag: "Rejected", reason: "malformed" };
    candidate = value;
  } else if (options.scanned && /^https:\/\//i.test(input)) {
    candidate = input;
  } else {
    return { _tag: "NotHandoff" };
  }

  const n = normalizeInstanceUrl(candidate);

  return n.ok ? { _tag: "AddInstance", url: n.url } : { _tag: "Rejected", reason: n.reason };
};
