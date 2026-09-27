import { domainOf, type SafetyVerdict } from "@bye/domain";
import { headerValues, parseAddressList, type ParsedMessage } from "@bye/mail-codec";

// Safety verdict from authenticated transport evidence only (§10). An arbitrary
// `Authentication-Results` header supplied by the sender is never trusted: only the topmost
// header stamped by our own receiving authority (Cloudflare Email Routing) counts, and only if
// it appears before any Received header added upstream of it.

export const TRUSTED_AUTHSERV_IDS: ReadonlyArray<string> = ["mx.cloudflare.net"];

export const DANGEROUS_EXTENSIONS =
  /\.(exe|scr|pif|com|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msi|msp|hta|cpl|jar|ps1|psm1|lnk|iso|img|vhd|vhdx|dll|sys|reg|scf|appx|msix|dmg|pkg|app|sh|command)$/i;

const startsWith = (bytes: Uint8Array, sig: ReadonlyArray<number>) =>
  sig.every((b, i) => bytes[i] === b);

/** Magic-byte sniff for executables, shortcuts and scripts (PE, ELF, Mach-O, LNK, shebang). */
export const isExecutableContent = (bytes: Uint8Array): boolean =>
  startsWith(bytes, [0x4d, 0x5a]) ||
  startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
  startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
  startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
  startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
  startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
  startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) ||
  startsWith(bytes, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00]) ||
  startsWith(bytes, [0x23, 0x21]);

export interface AuthEvidence {
  readonly spf: string | undefined;
  readonly dkim: string | undefined;
  readonly dmarc: string | undefined;
  /** RFC5322.From domain the receiving MTA evaluated DMARC against (`header.from`). */
  readonly headerFrom: string | undefined;
}

type ResInfo = ReadonlyArray<readonly [key: string, value: string]>;

/**
 * Split an Authentication-Results value (RFC 8601) into its authserv-id and resinfo, each resinfo
 * tokenized into `key=value` pairs with the method result first. Comments are dropped and quoted
 * strings are kept whole, so text echoed inside a property value or comment can never be read as
 * a method result. Returns undefined when quoting or comment nesting is unbalanced.
 */
const parseAuthResults = (
  value: string,
): { readonly authserv: string; readonly resinfo: ReadonlyArray<ResInfo> } | undefined => {
  const segments: Array<Array<[string, string]>> = [];
  let authserv = "";
  let pairs: Array<[string, string]> | undefined;
  let i = 0;
  const skip = (): boolean => {
    for (;;) {
      while (i < value.length && /\s/.test(value[i]!)) i++;
      if (value[i] !== "(") return true;
      let depth = 0;
      for (; i < value.length; i++) {
        const ch = value[i]!;
        if (ch === "\\") i++;
        else if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
      }
      if (depth !== 0) return false;
      i++;
    }
  };
  const word = (): string | undefined => {
    if (value[i] === '"') {
      let out = "";
      for (i++; i < value.length; i++) {
        const ch = value[i]!;
        if (ch === "\\") out += value[++i] ?? "";
        else if (ch === '"') {
          i++;
          return out;
        } else out += ch;
      }
      return undefined;
    }
    const start = i;
    while (i < value.length && !/[\s;=()"]/.test(value[i]!)) i++;
    return value.slice(start, i);
  };
  for (;;) {
    if (!skip()) return undefined;
    if (i >= value.length) break;
    if (value[i] === ";") {
      i++;
      pairs = [];
      segments.push(pairs);
      continue;
    }
    const key = word();
    if (key === undefined) return undefined;
    if (!skip()) return undefined;
    if (pairs === undefined) {
      // authserv-id (optionally followed by a version); nothing else precedes the first ';'.
      if (!authserv) authserv = key.toLowerCase();
      if (key === "" && value[i] !== ";") i++;
      continue;
    }
    if (value[i] !== "=") {
      if (key === "") i++;
      continue;
    }
    i++;
    if (!skip()) return undefined;
    const val = word();
    if (val === undefined) return undefined;
    pairs.push([key.toLowerCase(), val]);
  }
  return { authserv, resinfo: segments };
};

export const trustedAuthenticationResults = (
  headers: ParsedMessage["headers"],
): AuthEvidence | undefined => {
  // Headers are in wire order and each hop prepends. Only our receiving MTA's block is trusted:
  // its own Received trace may sit above its Authentication-Results, but anything below a second
  // Received was written by an earlier hop — possibly the sender — and is never trusted, even
  // with a matching authserv-id (which anyone can write).
  let received = 0;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "received" && ++received > 1) return undefined;
    if (lower !== "authentication-results") continue;
    const authserv = value.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!TRUSTED_AUTHSERV_IDS.includes(authserv)) return undefined;
    const parsed = parseAuthResults(value);
    // Our authserv-id but an unparseable body: fail closed rather than guess at the verdict.
    if (!parsed || parsed.authserv !== authserv)
      return { spf: undefined, dkim: undefined, dmarc: "fail", headerFrom: undefined };
    // A method result is only ever the first token of its own resinfo (`method[/version]=result`).
    const results = (method: string) =>
      parsed.resinfo.filter((r) => r[0]?.[0]?.replace(/\/.*$/, "") === method);
    const first = (method: string) => results(method)[0]?.[0]?.[1]?.toLowerCase();
    const dmarc = results("dmarc");
    const headerFroms = dmarc.flatMap((r) =>
      r.slice(1).flatMap(([k, v]) => (k === "header.from" ? [v.trim().toLowerCase()] : [])),
    );
    // More than one DMARC evaluation (or more than one evaluated From) is ambiguous: treat as fail.
    const ambiguous = dmarc.length > 1 || headerFroms.length > 1;
    return {
      spf: first("spf"),
      dkim: first("dkim"),
      dmarc: ambiguous ? "fail" : first("dmarc"),
      headerFrom: ambiguous ? undefined : headerFroms[0],
    };
  }
  return undefined;
};

const spoofed = (reason: string): SafetyVerdict => ({ _tag: "Spoofed", reason });

export const safetyVerdict = (parsed: ParsedMessage): SafetyVerdict => {
  const auth = trustedAuthenticationResults(parsed.headers);
  if (auth?.dmarc === "fail") return spoofed("dmarc=fail");
  // Sender policy is keyed on the parsed From, so it must be the identity DMARC authenticated.
  // Several From headers (including `From :` variants, which the header parser normalizes) let
  // the MTA and this parser disagree about which one counts.
  const fromHeaders = headerValues(parsed.headers, "from");
  if (fromHeaders.length !== 1) return spoofed("missing or multiple From headers");
  if (auth?.headerFrom !== undefined) {
    const from = parseAddressList(fromHeaders[0], [])[0]?.address ?? "";
    const evaluated = domainOf(`@${auth.headerFrom.replace(/\.$/, "")}`);
    if (!from || domainOf(from) !== evaluated)
      return spoofed("From does not match dmarc header.from");
  }
  const risky = parsed.attachments.find((a) => DANGEROUS_EXTENSIONS.test(a.filename));
  if (risky) return { _tag: "Malware", reason: "executable attachment quarantined" };
  if (parsed.truncated) return { _tag: "Spam", reason: "limits exceeded; quarantined for review" };
  return { _tag: "Clean" };
};
