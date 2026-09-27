// DKIM signing for outbound personal mail (RFC 6376, relaxed/relaxed; rsa-sha256 or RFC 8463
// ed25519-sha256). The key is the installation's own (MAIL_DKIM_PRIVATE_KEY, published as
// `bye1._domainkey.<domain>` by the domain workflow), and d= is the From address's domain, so a
// signature verifies on every domain Bye configured with that key.
//
// Only headers the sending service leaves alone are signed: Cloudflare Email Sending controls
// Message-ID, Date and Return-Path (spec.md §5.3), so those are never in h=. Canonicalization
// and signing reuse the ARC implementation (arc.ts), which follows the same RFC 6376 rules.
import {
  type ArcSigner,
  bodyHash,
  bytesToBinary,
  binaryToBytes,
  importArcSigner,
  signData,
  signingInput,
  splitMessage,
} from "./arc.ts";

export const DKIM_SIGNED_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "reply-to",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
] as const;

export interface DkimKey {
  readonly algorithm: ArcSigner["algorithm"];
  readonly selector: string;
  readonly key: ArcSigner["key"];
}

/** Import a PKCS#8 PEM (RSA or Ed25519) DKIM private key. */
export const importDkimKey = async (pem: string, selector: string): Promise<DkimKey> => {
  const { algorithm, key } = await importArcSigner(pem, "", selector);
  return { algorithm, selector, key };
};

/** The domain part of the first address in a From header value, lowercased; null if none. */
export const fromDomain = (fromValue: string): string | null => {
  const unfolded = fromValue.replace(/\r?\n[ \t]/g, " ");
  const angle = /<[^<>@\s]+@([^<>\s]+)>/.exec(unfolded);
  const bare = /(?:^|[\s,:])[^\s<>@,;"]+@([A-Za-z0-9.-]+)/.exec(unfolded);
  const domain = (angle?.[1] ?? bare?.[1] ?? "").toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ? domain
    : null;
};

export type DkimResult =
  | { readonly _tag: "Signed"; readonly raw: Uint8Array<ArrayBuffer>; readonly domain: string }
  | { readonly _tag: "Unsigned"; readonly reason: string };

/**
 * Prepend a DKIM-Signature to raw MIME. Line endings are normalized to CRLF first, and the
 * normalized bytes are what is returned (and must be sent), so the body hash matches the wire.
 */
export const dkimSign = async (
  raw: Uint8Array,
  key: DkimKey,
  now: number = Date.now(),
): Promise<DkimResult> => {
  const binary = bytesToBinary(raw).replace(/\r?\n/g, "\r\n");
  const { headers, body } = splitMessage(binary);
  const from = headers.filter(([n]) => n.trim().toLowerCase() === "from");
  if (from.length !== 1) return { _tag: "Unsigned", reason: "message needs exactly one From" };
  const domain = fromDomain(from[0]![1]);
  if (domain === null) return { _tag: "Unsigned", reason: "From has no signable domain" };
  // Each occurrence of a signed header is listed once (duplicates are signed bottom-up).
  const signed: Array<string> = [];
  for (const name of DKIM_SIGNED_HEADERS)
    for (const [n] of headers) if (n.trim().toLowerCase() === name) signed.push(name);
  const t = Math.floor(now / 1000);
  const base = ` v=1; a=${key.algorithm}; c=relaxed/relaxed; d=${domain}; s=${key.selector}; t=${t}; h=${signed.join(":")}; bh=${await bodyHash(body)}; b=`;
  const signer: ArcSigner = { ...key, domain };
  const b = await signData(signer, signingInput(headers, signed, "DKIM-Signature", base));
  return {
    _tag: "Signed",
    raw: binaryToBytes(`DKIM-Signature:${base}${b}\r\n${binary}`),
    domain,
  };
};
