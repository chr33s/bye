import { binaryToBytes, bytesToBinary, decodeCharset } from "./encoding.ts";
import { headerValue, parseAddressList } from "./headers.ts";
import { parseMessage, summarizeMessage } from "./parse.ts";
import { htmlToText } from "./sanitize.ts";
import type { Address, MimePart, ParsedMessage } from "./types.ts";

// Bounded preparation of an immutable message for JMAP publication (spec.md §16.4, §16.6
// `packages/mail-codec`). Everything an Email object exposes is derived here once, before the
// account transaction; body values and part bytes are re-derived from the same immutable bytes on
// demand, so a part's blob always names exactly the bytes it was prepared from.

export interface JmapAddress {
  readonly name: string | null;
  readonly email: string;
}

export interface PreparedBodyPart {
  /** Leaf parts only; multipart containers have null. */
  readonly partId: string | null;
  readonly size: number;
  readonly name: string | null;
  readonly type: string;
  readonly charset: string | null;
  readonly disposition: string | null;
  readonly cid: string | null;
  readonly subParts?: ReadonlyArray<PreparedBodyPart>;
}

export interface PreparedEmail {
  readonly size: number;
  readonly messageId: ReadonlyArray<string> | null;
  readonly inReplyTo: ReadonlyArray<string> | null;
  readonly references: ReadonlyArray<string> | null;
  readonly sender: ReadonlyArray<JmapAddress> | null;
  readonly from: ReadonlyArray<JmapAddress> | null;
  readonly to: ReadonlyArray<JmapAddress> | null;
  readonly cc: ReadonlyArray<JmapAddress> | null;
  readonly bcc: ReadonlyArray<JmapAddress> | null;
  readonly replyTo: ReadonlyArray<JmapAddress> | null;
  readonly subject: string;
  /** Date header in ms, or null when absent/unparseable. */
  readonly sentAt: number | null;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly bodyStructure: PreparedBodyPart;
  readonly textBody: ReadonlyArray<string>;
  readonly htmlBody: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<string>;
  readonly hasAttachment: boolean;
  readonly preview: string;
  /** Full plain text of the body parts, for the canonical search index (never truncated here). */
  readonly text: string;
  /** Parsing hit a limit; canonical fields may be incomplete and the arrival must not publish. */
  readonly truncated: boolean;
}

const PREVIEW_MAX = 256;

/**
 * Top-level header fields with byte-exact raw values (RFC 8621 §4.1.2 `asRaw`): everything after
 * the colon up to the field's terminating CRLF, folding included, decoded as Latin-1 octets.
 */
export const rawHeaders = (
  raw: Uint8Array,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const text = bytesToBinary(raw.subarray(0, Math.min(raw.byteLength, 256 * 1024)));
  const end = text.search(/\r?\n\r?\n/);
  const block = end < 0 ? text : text.slice(0, end);
  const out: Array<{ name: string; value: string }> = [];

  for (const line of block.split(/\r?\n/)) {
    const last = out.at(-1);

    if (/^[ \t]/.test(line) && last) {
      last.value = `${last.value}\r\n${line}`;
      continue;
    }

    const colon = line.indexOf(":");

    if (colon > 0) out.push({ name: line.slice(0, colon).trimEnd(), value: line.slice(colon + 1) });
  }

  return out;
};

const addresses = (list: ReadonlyArray<Address>): ReadonlyArray<JmapAddress> | null =>
  list.length > 0 ? list.map((a) => ({ name: a.name ?? null, email: a.address })) : null;

const ids = (list: ReadonlyArray<string>): ReadonlyArray<string> | null =>
  list.length > 0 ? list : null;

const leaf = (p: MimePart): PreparedBodyPart => ({
  partId: p.partId,
  size: p.size,
  name: p.filename ?? null,
  type: p.contentType,
  charset: p.params["charset"] ?? (p.contentType.startsWith("text/") ? "us-ascii" : null),
  disposition: p.disposition ?? null,
  cid: p.contentId ?? null,
});

const isChild = (parent: string, child: string): boolean => {
  if (parent === "") return !child.includes(".") || child === "1";
  const prefix = `${parent}.`;

  return child.startsWith(prefix) && !child.slice(prefix.length).includes(".");
};

/** Rebuild the MIME tree from the parser's containers and leaves (partIds encode the paths). */
const structure = (parsed: ParsedMessage): PreparedBodyPart => {
  // Opaque copies of signed content are an implementation detail, not part of the structure.
  const leaves = parsed.parts.filter((p) => !p.partId.endsWith(".signed"));
  const containers = new Map(parsed.containers.map((c) => [c.partId, c]));

  const build = (partId: string): PreparedBodyPart => {
    const container = containers.get(partId);

    if (!container) {
      const found = leaves.find((p) => p.partId === (partId === "" ? "1" : partId));

      return found
        ? leaf(found)
        : {
            partId: null,
            size: 0,
            name: null,
            type: "text/plain",
            charset: null,
            disposition: null,
            cid: null,
          };
    }

    const childIds = [
      ...new Set([
        ...[...containers.keys()].filter((c) => c !== partId && isChildPath(partId, c)),
        ...leaves.flatMap((p) => (isChildPath(partId, p.partId) ? [p.partId] : [])),
      ]),
    ].sort(comparePartIds);

    return {
      partId: null,
      size: 0,
      name: null,
      type: container.contentType,
      charset: null,
      disposition: null,
      cid: null,
      subParts: childIds.map(build),
    };
  };

  return build("");
};

const isChildPath = (parent: string, child: string): boolean =>
  parent === "" ? child !== "" && !child.includes(".") : isChild(parent, child);

const comparePartIds = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);

    if (d !== 0) return d;
  }

  return 0;
};

const isInlineText = (p: PreparedBodyPart, type: "text/plain" | "text/html") =>
  p.type === type && p.disposition !== "attachment" && p.name === null;

/** Parse and prepare one message. Never throws; check `truncated` before publishing. */
export const prepareEmail = (raw: Uint8Array): PreparedEmail => {
  const parsed = parseMessage(raw);
  const bodyStructure = structure(parsed);
  const leaves: Array<PreparedBodyPart> = [];

  const walk = (p: PreparedBodyPart) => {
    if (p.subParts) p.subParts.forEach(walk);
    else if (p.partId !== null) leaves.push(p);
  };

  walk(bodyStructure);

  const text = leaves.filter((p) => isInlineText(p, "text/plain"));
  const html = leaves.filter((p) => isInlineText(p, "text/html"));

  const attachments = leaves.filter(
    (p) => !isInlineText(p, "text/plain") && !isInlineText(p, "text/html"),
  );

  const partIds = (list: ReadonlyArray<PreparedBodyPart>) => list.map((p) => p.partId!);

  return {
    size: raw.byteLength,
    messageId: parsed.messageIdHeader ? [parsed.messageIdHeader] : null,
    inReplyTo: ids(parsed.inReplyTo),
    references: ids(parsed.references),
    sender: parsed.sender ? addresses([parsed.sender]) : null,
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parseAddressList(headerValue(parsed.headers, "bcc"), [])),
    replyTo: addresses(parsed.replyTo),
    subject: parsed.subject,
    sentAt: parsed.date ?? null,
    headers: rawHeaders(raw),
    bodyStructure,
    // RFC 8621 §4.1.4: each list falls back to the other's alternative when it has none.
    textBody: partIds(text.length > 0 ? text : html),
    htmlBody: partIds(html.length > 0 ? html : text),
    attachments: partIds(attachments),
    hasAttachment: attachments.some((p) => p.disposition !== "inline" || p.cid === null),
    preview: summarizeMessage(parsed, 0).snippet.slice(0, PREVIEW_MAX),
    text: parsed.text ?? (parsed.html ? htmlToText(parsed.html) : ""),
    truncated: parsed.truncated,
  };
};

/** One leaf part's decoded bytes and metadata; undefined when the part doesn't exist. */
export const partContent = (
  raw: Uint8Array,
  partId: string,
):
  | {
      readonly content: Uint8Array;
      readonly type: string;
      readonly name: string | undefined;
      readonly charset: string | undefined;
    }
  | undefined => {
  const part = parseMessage(raw).parts.find((p) => p.partId === partId);

  return part
    ? {
        content: part.content,
        type: part.contentType,
        name: part.filename,
        charset: part.params["charset"],
      }
    : undefined;
};

export interface BodyValue {
  readonly value: string;
  readonly isEncodingProblem: boolean;
  readonly isTruncated: boolean;
}

/** The longest prefix of `value` whose UTF-8 encoding fits `maxBytes`, cut on a code point. */
const utf8Prefix = (value: string, maxBytes: number): string => {
  // encodeInto writes whole UTF-8 sequences only, so `read` never splits a surrogate pair.
  const { read } = new TextEncoder().encodeInto(value, new Uint8Array(maxBytes));

  return value.slice(0, read);
};

/**
 * RFC 8621 EmailBodyValues for the given text parts, from one parse of the message, each
 * truncated to `maxBytes` UTF-8 bytes when > 0. Parts that aren't text are omitted.
 */
export const bodyValuesOf = (
  raw: Uint8Array,
  partIds: Iterable<string>,
  maxBytes: number,
): ReadonlyMap<string, BodyValue> => {
  const parts = new Map(parseMessage(raw).parts.map((p) => [p.partId, p]));
  const out = new Map<string, BodyValue>();

  for (const partId of partIds) {
    const part = parts.get(partId);

    if (!part || !part.contentType.startsWith("text/")) continue;
    const warnings: Parameters<typeof decodeCharset>[2] = [];
    const value = decodeCharset(part.content, part.params["charset"], warnings);
    const cut = maxBytes > 0 ? utf8Prefix(value, maxBytes) : value;

    out.set(partId, {
      value: cut,
      isEncodingProblem: warnings.length > 0,
      isTruncated: cut.length < value.length,
    });
  }

  return out;
};

/** RFC 8621 EmailBodyValue for one text part, truncated to `maxBytes` UTF-8 bytes when > 0. */
export const bodyValue = (
  raw: Uint8Array,
  partId: string,
  maxBytes: number,
): BodyValue | undefined => bodyValuesOf(raw, [partId], maxBytes).get(partId);

/**
 * The bytes to submit for a message: identical to the original except that every Bcc header
 * field is removed (RFC 8621 §7: Bcc recipients come from the envelope, never the header).
 */
export const withoutBcc = (raw: Uint8Array): Uint8Array => {
  const text = bytesToBinary(raw);
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const rest = end < 0 ? "" : text.slice(end);
  const lines = head.split(/(?<=\n)/);
  const kept: Array<string> = [];
  let skipping = false;

  for (const line of lines) {
    if (/^[ \t]/.test(line) && skipping) continue;
    skipping = /^bcc\s*:/i.test(line);

    if (!skipping) kept.push(line);
  }

  const joined = kept.join("");
  const unchanged = joined.length === head.length;

  return unchanged ? raw : binaryToBytes(joined + rest);
};
