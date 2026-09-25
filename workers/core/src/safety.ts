import type { SafetyVerdict } from "@bye/domain";
import type { ParsedMessage } from "@bye/mail-codec";

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
}

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
    const result = (method: string) =>
      new RegExp(`\\b${method}=([a-z]+)`, "i").exec(value)?.[1]?.toLowerCase();
    return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
  }
  return undefined;
};

export const safetyVerdict = (parsed: ParsedMessage): SafetyVerdict => {
  const auth = trustedAuthenticationResults(parsed.headers);
  if (auth?.dmarc === "fail") return { _tag: "Spoofed", reason: "dmarc=fail" };
  const risky = parsed.attachments.find((a) => DANGEROUS_EXTENSIONS.test(a.filename));
  if (risky) return { _tag: "Malware", reason: "executable attachment quarantined" };
  if (parsed.truncated) return { _tag: "Spam", reason: "limits exceeded; quarantined for review" };
  return { _tag: "Clean" };
};
