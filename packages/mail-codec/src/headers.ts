import {
  binaryToBytes,
  binaryToText,
  decodeCharset,
  decodeEncodedWords,
  pushWarning,
} from "./encoding.ts";
import type { Address, Warning } from "./types.ts";

export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

/** Parse a header block (binary string), unfolding continuation lines. */
export const parseHeaderBlock = (
  block: string,
  warnings: Array<Warning>,
): Array<readonly [string, string]> => {
  const headers: Array<readonly [string, string]> = [];
  const lines = block.split(/\r?\n/);
  let current: [string, string] | undefined;

  const commit = () => {
    if (current) headers.push([current[0], binaryToText(current[1]).trim()]);
    current = undefined;
  };

  for (const line of lines) {
    if (line.length === 0) continue;

    if ((line[0] === " " || line[0] === "\t") && current) {
      current[1] += line;
      continue;
    }

    commit();
    const colon = line.indexOf(":");

    if (colon <= 0 || !/^[!-9;-~]+$/.test(line.slice(0, colon).trimEnd())) {
      pushWarning(warnings, { _tag: "MalformedHeader", name: line.slice(0, 20) });
      continue;
    }

    current = [line.slice(0, colon).trimEnd(), line.slice(colon + 1)];
  }

  commit();

  return headers;
};

export const headerValue = (headers: HeaderList, name: string): string | undefined => {
  const lower = name.toLowerCase();

  for (const [key, value] of headers) if (key.toLowerCase() === lower) return value;

  return undefined;
};

export const headerValues = (headers: HeaderList, name: string): Array<string> => {
  const lower = name.toLowerCase();

  return headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
};

// ---------- structured header params (Content-Type / Content-Disposition) ----------

interface HeaderParamMap {
  [name: string]: string;
}

export interface StructuredHeader {
  readonly value: string;
  readonly params: Readonly<Record<string, string>>;
}

const splitOutsideQuotes = (input: string, separator: string): Array<string> => {
  const out: Array<string> = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch === "\\" && quoted) {
      current += ch + (input[i + 1] ?? "");
      i++;
      continue;
    }

    if (ch === '"') quoted = !quoted;

    if (ch === separator && !quoted) {
      out.push(current);
      current = "";
    } else current += ch;
  }

  out.push(current);

  return out;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }

  return trimmed;
};

const percentDecodeBinary = (value: string): string =>
  value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Parse `type/subtype; a=b; c*=utf-8''x; d*0=..; d*1=..` including RFC 2231 continuations. */
export const parseStructuredHeader = (
  input: string | undefined,
  warnings: Array<Warning>,
): StructuredHeader => {
  if (!input) return { value: "", params: {} };
  const [head = "", ...rest] = splitOutsideQuotes(input, ";");
  const plain: Record<string, string> = {};
  const extended = new Map<string, Array<{ index: number; encoded: boolean; value: string }>>();

  for (const segment of rest) {
    const eq = segment.indexOf("=");

    if (eq < 0) continue;
    const rawName = segment.slice(0, eq).trim().toLowerCase();
    const rawValue = unquote(segment.slice(eq + 1));
    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawName);

    if (!match) continue;
    const name = match[1]!;

    if (match[2] === undefined && match[3] === undefined) {
      if (!(name in plain)) plain[name] = decodeEncodedWords(rawValue, warnings);
      continue;
    }

    const list = extended.get(name) ?? [];
    list.push({
      index: match[2] === undefined ? 0 : Number(match[2]),
      encoded: match[3] === "*",
      value: rawValue,
    });
    extended.set(name, list);
  }

  const params: HeaderParamMap = { ...plain };

  for (const [name, sections] of extended) {
    sections.sort((a, b) => a.index - b.index);
    let charset: string | undefined;
    let binary = "";

    for (const section of sections) {
      let value = section.value;

      if (section.encoded) {
        if (section.index === 0) {
          const parts = value.split("'");

          if (parts.length >= 3) {
            charset = parts[0] || undefined;
            value = parts.slice(2).join("'");
          }
        }

        binary += percentDecodeBinary(value);
      } else binary += value;
    }

    params[name] = decodeCharset(binaryToBytes(binary), charset ?? "utf-8", warnings);
  }

  return { value: head.trim().toLowerCase(), params };
};

// ---------- addresses ----------

const SPECIALS = new Set(["<", ">", ",", ":", ";", '"', "(", ")"]);

/** Parse an RFC 5322 address list (display names, quoted strings, comments, groups). */
export const parseAddressList = (
  input: string | undefined,
  warnings: Array<Warning> = [],
): Array<Address> => {
  if (!input) return [];
  const out: Array<Address> = [];
  let words: Array<string> = [];
  let addr: string | undefined;

  const finish = () => {
    if (addr !== undefined) {
      const name = decodeEncodedWords(words.join(" "), warnings).trim();
      const address = addr.trim();

      if (address) out.push({ name: name || undefined, address });
    } else if (words.length > 0) {
      const joined = words.join("");

      if (joined.includes("@")) out.push({ name: undefined, address: joined });
    }

    words = [];
    addr = undefined;
  };

  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === '"') {
      let value = "";
      i++;

      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++;
        value += input[i] ?? "";
        i++;
      }

      i++;
      words.push(value);
    } else if (ch === "(") {
      let depth = 1;
      i++;

      while (i < input.length && depth > 0) {
        if (input[i] === "\\") i++;
        else if (input[i] === "(") depth++;
        else if (input[i] === ")") depth--;
        i++;
      }
    } else if (ch === "<") {
      const end = input.indexOf(">", i);
      addr = input.slice(i + 1, end < 0 ? input.length : end).replace(/\s+/g, "");
      i = end < 0 ? input.length : end + 1;
    } else if (ch === "," || ch === ";") {
      finish();
      i++;
    } else if (ch === ":") {
      // Group display name: discard and parse members.
      words = [];
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      let word = "";

      while (i < input.length && !/\s/.test(input[i]!) && !SPECIALS.has(input[i]!)) {
        word += input[i];
        i++;
      }

      if (word) words.push(word);
      else i++;
    }
  }

  finish();

  return out;
};

// ---------- identifiers and dates ----------

export const parseMessageIdList = (value: string | undefined): Array<string> => {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);

  if (bracketed.length > 0) return bracketed;

  return value.split(/[\s,]+/).filter((token) => token.includes("@"));
};

const MAIL_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

interface NamedZoneTable {
  readonly [zone: string]: number;
}

// RFC 5322 §4.3 obsolete zones; anything else alphabetic (military zones included) means -0000.
const NAMED_ZONES: NamedZoneTable = {
  ut: 0,
  utc: 0,
  gmt: 0,
  z: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
};

/**
 * RFC 5322 dates are parsed by hand so the result never depends on the host's time zone: a missing
 * or unknown zone is taken as UTC (RFC 5322 §4.3 "-0000"), where `Date.parse` would use local time.
 * Other shapes (ISO 8601 and the like) fall back to `Date.parse`.
 */
export const parseMailDate = (value: string | undefined): number | undefined => {
  if (!value) return undefined;

  const cleaned = value
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const m =
    /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([+-]\d{4}|[A-Za-z]{1,5})\b)?/.exec(
      cleaned,
    );

  if (!m) {
    const direct = Date.parse(cleaned);

    return Number.isNaN(direct) ? undefined : direct;
  }

  const month = MAIL_MONTHS.indexOf(m[2]!.toLowerCase());

  if (month < 0) return undefined;
  let year = Number(m[3]);

  if (m[3]!.length === 2) year += year < 50 ? 2000 : 1900;
  else if (m[3]!.length === 3) year += 1900; // RFC 5322 §4.3: three-digit years add 1900
  const day = Number(m[1]);
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];

  if (hour > 23 || minute > 59 || second > 60) return undefined;
  const local = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));

  if (new Date(local).getUTCDate() !== day) return undefined; // e.g. 31 Sep
  const zone = m[7];
  let offsetMinutes = 0;

  if (zone && /^[+-]\d{4}$/.test(zone)) {
    const sign = zone[0] === "-" ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  } else if (zone) offsetMinutes = NAMED_ZONES[zone.toLowerCase()] ?? 0;

  return local - offsetMinutes * 60_000;
};
