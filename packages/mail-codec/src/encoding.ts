import { toBase64Url, tryFromBase64Url } from "@bye/domain";
import type { Warning } from "./types.ts";

// Byte/text codecs shared by the parser and builder. Binary strings map each byte to one
// UTF-16 code unit (0–255) so MIME structure can be scanned without copying bytes per part.

export const bytesToBinary = (bytes: Uint8Array): string => {
  let out = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return out;
};

export const binaryToBytes = (binary: string): Uint8Array => {
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;

  return out;
};

const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const utf8Lenient = new TextDecoder("utf-8");

const utf8Encoder = new TextEncoder();

export const utf8Encode = (text: string): Uint8Array => utf8Encoder.encode(text);

/** Decode a binary string as UTF-8 when valid (RFC 6532 headers), otherwise as Latin-1. */
export const binaryToText = (binary: string): string => {
  if (!/[\u0080-ÿ]/.test(binary)) return binary;

  try {
    return utf8Fatal.decode(binaryToBytes(binary));
  } catch {
    return binary;
  }
};

const latin1Decode = (bytes: Uint8Array): string => bytesToBinary(bytes);

interface CharsetAliasTable {
  readonly [charset: string]: string;
}

const CHARSET_ALIASES: CharsetAliasTable = {
  utf8: "utf-8",
  "utf-8": "utf-8",
  "us-ascii": "latin1-exact",
  ascii: "latin1-exact",
  "iso-8859-1": "latin1-exact",
  latin1: "latin1-exact",
  "iso8859-1": "latin1-exact",
  "iso_8859-1": "latin1-exact",
};

const addWarning = (warnings: Array<Warning> | undefined, warning: Warning): void => {
  if (!warnings) return;
  const key = JSON.stringify(warning);

  if (!warnings.some((w) => JSON.stringify(w) === key)) warnings.push(warning);
};

/** Decode bytes in a declared charset; unknown charsets fall back to UTF-8 with a warning. */
export const decodeCharset = (
  bytes: Uint8Array,
  charset: string | undefined,
  warnings?: Array<Warning>,
): string => {
  const raw =
    (charset ?? "utf-8")
      .trim()
      .toLowerCase()
      .replace(/^["']|["']$/g, "")
      .split("*")[0] ?? "utf-8";

  const label = CHARSET_ALIASES[raw] ?? raw;

  if (label === "utf-8") return utf8Lenient.decode(bytes);

  if (label === "latin1-exact") return latin1Decode(bytes);

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    addWarning(warnings, { _tag: "UnknownCharset", charset: raw });

    return utf8Lenient.decode(bytes);
  }
};

export { addWarning as pushWarning };

// ---------- base64 ----------

export const decodeBase64Binary = (input: string): string => {
  let clean = input.replace(/[^A-Za-z0-9+/]/g, "");

  if (clean.length % 4 === 1) clean = clean.slice(0, -1);

  while (clean.length % 4 !== 0) clean += "=";

  try {
    return atob(clean);
  } catch {
    return "";
  }
};

export const encodeBase64 = (bytes: Uint8Array): string => btoa(bytesToBinary(bytes));

export const wrapLines = (text: string, width = 76): string => {
  const lines: Array<string> = [];

  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));

  return lines.join("\r\n");
};

/** base64url (canonical helpers in @bye/domain); decoding untrusted input never throws. */
export const base64Url = (bytes: Uint8Array): string => toBase64Url(bytes);

export const fromBase64Url = (text: string): Uint8Array | undefined => tryFromBase64Url(text);

// ---------- quoted-printable ----------

export const decodeQuotedPrintableBinary = (input: string): string => {
  let out = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch !== "=") {
      out += ch;
      continue;
    }

    const next = input.slice(i + 1, i + 3);

    if (/^[0-9A-Fa-f]{2}$/.test(next)) {
      out += String.fromCharCode(parseInt(next, 16));
      i += 2;
    } else if (input[i + 1] === "\r" && input[i + 2] === "\n") {
      i += 2;
    } else if (input[i + 1] === "\n") {
      i += 1;
    } else {
      // Soft break followed by trailing whitespace, or a malformed escape: keep literally.
      const rest = /^[ \t]+\r?\n/.exec(input.slice(i + 1));

      if (rest) i += rest[0].length;
      else out += ch;
    }
  }

  return out;
};

export const encodeQuotedPrintable = (bytes: Uint8Array): string => {
  const lines = bytesToBinary(bytes).replace(/\r\n/g, "\n").split("\n");
  const out: Array<string> = [];

  for (const line of lines) {
    let encoded = "";

    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      const last = i === line.length - 1;
      let token: string;

      if ((code === 32 || code === 9) && !last) token = line[i]!;
      else if (code >= 33 && code <= 126 && code !== 61) token = line[i]!;
      else token = `=${code.toString(16).toUpperCase().padStart(2, "0")}`;

      if (encoded.length + token.length > 75) {
        out.push(`${encoded}=`);
        encoded = "";
      }

      encoded += token;
    }

    out.push(encoded);
  }

  return out.join("\r\n");
};

// ---------- RFC 2047 ----------

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

const decodeQWord = (text: string): string => decodeQuotedPrintableBinary(text.replace(/_/g, " "));

/** Decode RFC 2047 encoded words; adjacent words of one charset are joined before decoding. */
export const decodeEncodedWords = (value: string, warnings?: Array<Warning>): string => {
  if (!value.includes("=?")) return value;
  let out = "";
  let last = 0;
  let pending: { charset: string; bytes: string } | undefined;

  const flush = () => {
    if (pending) out += decodeCharset(binaryToBytes(pending.bytes), pending.charset, warnings);
    pending = undefined;
  };

  for (const match of value.matchAll(ENCODED_WORD)) {
    const index = match.index ?? 0;
    const between = value.slice(last, index);
    const charset = (match[1] ?? "").toLowerCase().split("*")[0] ?? "utf-8";

    const binary =
      (match[2] ?? "").toLowerCase() === "b"
        ? decodeBase64Binary(match[3] ?? "")
        : decodeQWord(match[3] ?? "");

    if (pending && /^\s*$/.test(between)) {
      if (pending.charset === charset) pending.bytes += binary;
      else {
        flush();
        pending = { charset, bytes: binary };
      }
    } else {
      flush();
      out += between;
      pending = { charset, bytes: binary };
    }

    last = index + match[0].length;
  }

  flush();

  return out + value.slice(last);
};

// oxlint-disable-next-line no-control-regex -- intentional control-char match
export const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);

export const MAX_UNFOLDABLE_RUN = 900;

/**
 * RFC 2047 encoded words for an unstructured header value. ASCII passes through unchanged —
 * unless it contains a run without whitespace too long to fold under the RFC 5322 998-octet line
 * limit (e.g. a 1,200-character URL as a subject). Encoded words can be split and folded, so
 * such values are encoded instead of producing an over-long line.
 */
export const encodeHeaderWords = (text: string): string => {
  if (isAscii(text) && !text.split(/[ \t]+/).some((run) => run.length > MAX_UNFOLDABLE_RUN))
    return text;
  const words: Array<string> = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const cp of text) {
    const size = utf8Encode(cp).length;

    if (chunkBytes + size > 45) {
      words.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }

    chunk += cp;
    chunkBytes += size;
  }

  if (chunk) words.push(chunk);

  return words.map((w) => `=?UTF-8?B?${encodeBase64(utf8Encode(w))}?=`).join(" ");
};
