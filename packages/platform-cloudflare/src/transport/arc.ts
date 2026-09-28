import { Match, Predicate } from "effect";
import { sha256 } from "@bye/domain";
// ARC sealing for forwarded mail (RFC 8617), so receivers can evaluate the original authentication
// after we forward (§5.4 Forwarding gate). Signatures use DKIM relaxed/relaxed canonicalization
// (RFC 6376 §3.4) with ed25519-sha256 (RFC 8463) or rsa-sha256.
//
// Chain validation of earlier ARC sets is delegated to our receiving MTA: Cloudflare Email Routing
// stamps an Authentication-Results header with `arc=pass|fail|none`, which callers pass in as
// `priorChain`. We never claim `cv=pass` without that evidence, and only for a structurally intact
// chain (`arcChainSummary`).

export const ARC_MAX_INSTANCES = 50;

export type ArcAlgorithm = "ed25519-sha256" | "rsa-sha256";

export interface ArcSigner {
  readonly algorithm: ArcAlgorithm;
  readonly domain: string;
  readonly selector: string;
  readonly key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
}

// ---- canonicalization (RFC 6376 §3.4) ----

/** Relaxed header canonicalization for one `name: value` header (value may contain folding). */
export const relaxedHeader = (name: string, value: string): string =>
  `${name.trim().toLowerCase()}:${value
    .replace(/\r?\n(?=[ \t])/g, "")
    .replace(/[ \t]+/g, " ")
    .trim()}\r\n`;

/** Relaxed body canonicalization. */
export const relaxedBody = (body: string): string => {
  const lines = body
    .replace(/\r?\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/, ""));

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
};

export interface SplitMessage {
  /** Headers in wire order, each with its raw (possibly folded) value. */
  readonly headers: Array<readonly [string, string]>;
  readonly body: string;
}

export const splitMessage = (raw: string): SplitMessage => {
  const normalized = raw.replace(/\r?\n/g, "\r\n");
  const idx = normalized.indexOf("\r\n\r\n");
  const head = idx < 0 ? normalized : normalized.slice(0, idx);
  const body = idx < 0 ? "" : normalized.slice(idx + 4);
  const headers: Array<readonly [string, string]> = [];

  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const [n, v] = headers[headers.length - 1]!;
      headers[headers.length - 1] = [n, `${v}\r\n${line}`];
    } else {
      const colon = line.indexOf(":");

      if (colon > 0) headers.push([line.slice(0, colon), line.slice(colon + 1)]);
    }
  }

  return { headers, body };
};

/**
 * ARC operates on "binary strings" (one char per octet, latin1) so 8-bit message bytes survive the
 * header/body split and are hashed exactly as they go on the wire — never UTF-8 re-encoded.
 */
export const bytesToBinary = (bytes: Uint8Array): string => {
  let s = "";

  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return s;
};

export const binaryToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(s.length);

  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;

  return out;
};

const b64 = (bytes: Uint8Array): string => {
  let s = "";

  for (const b of bytes) s += String.fromCharCode(b);

  return btoa(s);
};

export const bodyHash = async (body: string): Promise<string> =>
  b64(await sha256(binaryToBytes(relaxedBody(body))));

export const signData = async (signer: ArcSigner, data: string): Promise<string> => {
  if (signer.algorithm === "ed25519-sha256") {
    // RFC 8463: PureEdDSA over the SHA-256 hash of the canonicalized data.
    return b64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          signer.key,
          (await sha256(binaryToBytes(data))) as Uint8Array<ArrayBuffer>,
        ),
      ),
    );
  }

  return b64(
    new Uint8Array(
      await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, signer.key, binaryToBytes(data)),
    ),
  );
};

/** Import a PKCS#8 PEM signing key, detecting Ed25519 vs RSA. */
export const importArcSigner = async (
  pem: string,
  domain: string,
  selector: string,
): Promise<ArcSigner> => {
  const der = Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );

  try {
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);

    return { algorithm: "ed25519-sha256", domain, selector, key };
  } catch {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return { algorithm: "rsa-sha256", domain, selector, key };
  }
};

const ARC_HEADER = /^arc-(seal|message-signature|authentication-results)$/i;

const instanceOf = (value: string): number | null => {
  const m = /(?:^|;)\s*i\s*=\s*(\d+)/i.exec(value);

  return m ? Number(m[1]) : null;
};

/** Highest existing ARC instance in the message (0 when none). */
export const arcInstanceCount = (headers: ReadonlyArray<readonly [string, string]>): number => {
  let max = 0;

  for (const [name, value] of headers) {
    if (!ARC_HEADER.test(name.trim())) continue;
    const i = instanceOf(value);

    if (i !== null) max = Math.max(max, i);
  }

  return max;
};

export type ArcChainStatus =
  /** No ARC headers at all. */
  | { readonly _tag: "None" }
  /** Sets 1..count are each present exactly once (AAR, AMS, AS), and no seal already says cv=fail. */
  | { readonly _tag: "Intact"; readonly count: number }
  /** Gaps, duplicates, unparseable instances, out-of-range numbers or an earlier cv=fail. */
  | { readonly _tag: "Broken"; readonly highest: number };

/**
 * Structural chain check (RFC 8617 §5.2 steps 1–3). Signatures are verified by our MX; this only
 * decides whether the instance numbers are trustworthy. A sender can plant `ARC-Seal: i=50` to make
 * us refuse to forward; a planted number that is not part of a contiguous chain is just a broken
 * chain (sealed with cv=fail), never a loop.
 */
export const arcChainSummary = (
  headers: ReadonlyArray<readonly [string, string]>,
): ArcChainStatus => {
  const sets = new Map<number, Map<string, Array<string>>>();
  let highest = 0;
  let malformed = false;

  for (const [name, value] of headers) {
    const kind = name.trim().toLowerCase();

    if (!ARC_HEADER.test(kind)) continue;
    const i = instanceOf(value);

    if (i === null || i < 1 || i > ARC_MAX_INSTANCES) {
      malformed = true;

      if (i !== null) highest = Math.max(highest, i);
      continue;
    }

    highest = Math.max(highest, i);
    const set = sets.get(i) ?? new Map<string, Array<string>>();
    set.set(kind, [...(set.get(kind) ?? []), value]);
    sets.set(i, set);
  }

  if (!malformed && sets.size === 0) return { _tag: "None" };

  if (malformed || sets.size !== highest) return { _tag: "Broken", highest };

  for (let i = 1; i <= highest; i++) {
    const set = sets.get(i)!;

    for (const kind of ["arc-authentication-results", "arc-message-signature", "arc-seal"])
      if (set.get(kind)?.length !== 1) return { _tag: "Broken", highest };
    const cv = /(?:^|;)\s*cv\s*=\s*([a-z]+)/i.exec(set.get("arc-seal")![0]!)?.[1]?.toLowerCase();

    if (cv !== (i === 1 ? "none" : "pass")) return { _tag: "Broken", highest };
  }

  return { _tag: "Intact", count: highest };
};

/** DKIM signing input: listed headers (bottom-up for duplicates) + the signature header with empty b=. */
export const signingInput = (
  headers: ReadonlyArray<readonly [string, string]>,
  signed: ReadonlyArray<string>,
  sigName: string,
  sigValueWithoutB: string,
): string => {
  const used = new Map<string, number>();
  let out = "";

  for (const h of signed) {
    const lower = h.toLowerCase();
    const matches = headers.filter(([n]) => n.trim().toLowerCase() === lower);
    const count = used.get(lower) ?? 0;
    const pick = matches[matches.length - 1 - count];
    used.set(lower, count + 1);

    if (pick) out += relaxedHeader(pick[0], pick[1]);
  }

  return out + relaxedHeader(sigName, sigValueWithoutB).replace(/\r\n$/, "");
};

export const ARC_SIGNED_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "reply-to",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
];

export interface SealInput {
  /** The message as a binary string (one char per octet; see `bytesToBinary`). */
  readonly raw: string;
  readonly signer: ArcSigner;
  /** authserv-id and results of OUR verification, e.g. "mx.bye.test; spf=pass; dkim=pass; dmarc=pass; arc=pass". */
  readonly authResults: string;
  /** Result of validating the existing ARC chain (from our trusted Authentication-Results). */
  readonly priorChain: "pass" | "fail" | "none";
  readonly now?: number;
}

export type SealResult =
  | { readonly _tag: "Sealed"; readonly raw: string; readonly instance: number }
  | { readonly _tag: "LoopLimit" };

/** Prepend one ARC set (AAR, AMS, AS) to the message. */
export const arcSeal = async (input: SealInput): Promise<SealResult> => {
  const { headers, body } = splitMessage(input.raw);
  const chain = arcChainSummary(headers);

  // Only an intact chain's length counts toward the loop limit; a broken chain gets the next free
  // instance number (capped) and cv=fail, so receivers stop trusting it without us dropping mail.
  const instance = Match.value(chain).pipe(
    Match.tag("None", () => 1),
    Match.tag("Intact", (intact) => intact.count + 1),
    Match.tag("Broken", (broken) => Math.min(broken.highest + 1, ARC_MAX_INSTANCES)),
    Match.exhaustive,
  );

  if (Predicate.isTagged(chain, "Intact") && instance > ARC_MAX_INSTANCES)
    return { _tag: "LoopLimit" };
  const { signer } = input;
  const t = Math.floor((input.now ?? Date.now()) / 1000);

  const cv = Predicate.isTagged(chain, "None")
    ? "none"
    : Predicate.isTagged(chain, "Intact") && input.priorChain === "pass"
      ? "pass"
      : "fail";

  const aarValue = ` i=${instance}; ${input.authResults}`;
  const present = new Set(headers.map(([n]) => n.trim().toLowerCase()));
  const signedHeaders = ARC_SIGNED_HEADERS.filter((h) => present.has(h));
  const bh = await bodyHash(body);
  const amsBase = ` i=${instance}; a=${signer.algorithm}; c=relaxed/relaxed; d=${signer.domain}; s=${signer.selector}; t=${t}; h=${signedHeaders.join(":")}; bh=${bh}; b=`;

  const amsSig = await signData(
    signer,
    signingInput(headers, signedHeaders, "ARC-Message-Signature", amsBase),
  );

  const amsValue = `${amsBase}${amsSig}`;

  // ARC-Seal covers every ARC set in instance order: AAR, AMS, AS for i=1..N (current AS with b=).
  const sets: Array<readonly [string, string]> = [];

  for (let i = 1; i < instance; i++) {
    for (const kind of ["arc-authentication-results", "arc-message-signature", "arc-seal"]) {
      const h = headers.find(
        ([n, v]) =>
          n.trim().toLowerCase() === kind &&
          new RegExp(`(?:^|;)\\s*i\\s*=\\s*${i}\\b`, "i").test(v),
      );

      if (h) sets.push(h);
    }
  }

  sets.push(["ARC-Authentication-Results", aarValue], ["ARC-Message-Signature", amsValue]);
  const asBase = ` i=${instance}; a=${signer.algorithm}; cv=${cv}; d=${signer.domain}; s=${signer.selector}; t=${t}; b=`;

  const sealInput =
    sets.map(([n, v]) => relaxedHeader(n, v)).join("") +
    relaxedHeader("ARC-Seal", asBase).replace(/\r\n$/, "");

  const asValue = `${asBase}${await signData(signer, sealInput)}`;

  const prefix = `ARC-Seal:${asValue}\r\nARC-Message-Signature:${amsValue}\r\nARC-Authentication-Results:${aarValue}\r\n`;

  return { _tag: "Sealed", raw: prefix + input.raw.replace(/^\r?\n?/, ""), instance };
};

/** Test/diagnostic helper: the exact data a verifier would check for a seal or AMS. */
export const arcSigningData = { signingInput, relaxedHeader };
