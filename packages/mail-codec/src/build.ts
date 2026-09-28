import {
  encodeBase64,
  encodeHeaderWords,
  encodeQuotedPrintable,
  isAscii,
  utf8Encode,
  wrapLines,
} from "./encoding.ts";
import { htmlToText } from "./sanitize.ts";
import type { Address } from "./types.ts";

// Outbound MIME builder (E17). Bcc recipients only ever appear in the envelope.

export interface OutboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface OutboundInlinePart extends OutboundAttachment {
  readonly contentId: string;
}

export type CalendarMethod = "REQUEST" | "REPLY" | "CANCEL" | "PUBLISH" | "COUNTER" | "REFRESH";

export interface BuildMessageInput {
  readonly from: Address;
  readonly to: ReadonlyArray<Address>;
  readonly cc?: ReadonlyArray<Address>;
  /** Envelope-only; never written to headers. */
  readonly bcc?: ReadonlyArray<Address>;
  readonly replyTo?: ReadonlyArray<Address>;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly inline?: ReadonlyArray<OutboundInlinePart>;
  readonly attachments?: ReadonlyArray<OutboundAttachment>;
  readonly calendar?: { readonly method: CalendarMethod; readonly ics: string };
  /** Message IDs without angle brackets. */
  readonly inReplyTo?: string;
  readonly references?: ReadonlyArray<string>;
  readonly autoSubmitted?: "auto-replied" | "auto-generated";
  readonly date: number;
  readonly messageId: string;
  /** Deterministic boundary source for tests; defaults to random. */
  readonly boundary?: (index: number) => string;
  readonly extraHeaders?: ReadonlyArray<readonly [string, string]>;
}

export interface BuiltMessage {
  readonly bytes: Uint8Array;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly envelopeRecipients: ReadonlyArray<string>;
  readonly messageId: string;
}

const PROTECTED_HEADERS = new Set([
  "bcc",
  "from",
  "to",
  "cc",
  "date",
  "message-id",
  "mime-version",
  "subject",
  "reply-to",
  "in-reply-to",
  "references",
  "sender",
  "return-path",
  "received",
  "dkim-signature",
  "authentication-results",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
]);

const stripNewlines = (value: string): string => value.replace(/[\r\n]+/g, " ");

/** An addr-spec or msg-id with newlines, angle brackets and whitespace removed. */
const bare = (value: string): string => stripNewlines(value).replace(/[<>\s]/g, "");

const ADDRESS_SPECIALS = /[()<>[\]:;@\\,."]/;

export const formatAddress = (address: Address): string => {
  const addr = bare(address.address);
  const name = address.name === undefined ? "" : stripNewlines(address.name).trim();

  if (!name) return addr;

  if (!isAscii(name)) return `${encodeHeaderWords(name)} <${addr}>`;

  if (ADDRESS_SPECIALS.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`;

  return `${name} <${addr}>`;
};

/** Fold a header at whitespace to keep lines ≤78 characters where possible. */
export const foldHeader = (name: string, value: string): string => {
  const line = `${name}: ${value}`;

  if (line.length <= 78) return line;
  const words = line.split(" ");
  const lines: Array<string> = [];
  let current = "";

  for (const word of words) {
    if (current && current.length + 1 + word.length > 78) {
      lines.push(current);
      current = ` ${word}`;
    } else current = current ? `${current} ${word}` : word;
  }

  if (current) lines.push(current);

  return lines.join("\r\n");
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => n.toString().padStart(2, "0");

export const formatMailDate = (ms: number): string => {
  const d = new Date(ms);

  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
};

const randomBoundary = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));

  return `=_bye_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

type Entity =
  | {
      readonly kind: "leaf";
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly body: string;
    }
  | {
      readonly kind: "multipart";
      readonly subtype: string;
      readonly children: ReadonlyArray<Entity>;
    };

const textLeaf = (contentType: string, text: string, extraParams = ""): Entity => {
  const normalized = text.replace(/\r?\n/g, "\r\n");
  const plain = isAscii(normalized) && normalized.split("\r\n").every((l) => l.length <= 998);

  return {
    kind: "leaf",
    headers: [
      ["Content-Type", `${contentType}; charset=UTF-8${extraParams}`],
      ["Content-Transfer-Encoding", plain ? "7bit" : "quoted-printable"],
    ],
    body: plain ? normalized : encodeQuotedPrintable(utf8Encode(normalized)),
  };
};

const quoteParam = (value: string): string =>
  `"${stripNewlines(value).replace(/(["\\])/g, "\\$1")}"`;

const filenameParams = (param: string, filename: string): string => {
  if (isAscii(filename)) return `${param}=${quoteParam(filename)}`;
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");

  const encoded = Array.from(utf8Encode(filename), (b) =>
    /[A-Za-z0-9._~-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");

  return `${param}=${quoteParam(fallback)}; ${param}*=UTF-8''${encoded}`;
};

const binaryLeaf = (
  part: OutboundAttachment,
  disposition: "inline" | "attachment",
  contentId?: string,
): Entity => {
  const type = stripNewlines(part.contentType).toLowerCase() || "application/octet-stream";

  const headers: Array<readonly [string, string]> = [
    ["Content-Type", `${type}; ${filenameParams("name", part.filename)}`],
    ["Content-Transfer-Encoding", "base64"],
    ["Content-Disposition", `${disposition}; ${filenameParams("filename", part.filename)}`],
  ];

  if (contentId) headers.push(["Content-ID", `<${bare(contentId)}>`]);

  return { kind: "leaf", headers, body: wrapLines(encodeBase64(part.content)) };
};

interface SerializedEntity {
  headers: Array<readonly [string, string]>;
  body: string;
}

const serialize = (entity: Entity, nextBoundary: () => string): SerializedEntity => {
  if (entity.kind === "leaf") return { headers: [...entity.headers], body: entity.body };
  const boundary = nextBoundary();
  const chunks: Array<string> = [];

  for (const child of entity.children) {
    const serialized = serialize(child, nextBoundary);
    chunks.push(
      `--${boundary}\r\n${serialized.headers.map(([n, v]) => foldHeader(n, v)).join("\r\n")}\r\n\r\n${serialized.body}\r\n`,
    );
  }

  return {
    headers: [["Content-Type", `multipart/${entity.subtype}; boundary="${boundary}"`]],
    body: `${chunks.join("")}--${boundary}--\r\n`,
  };
};

const uniqueRecipients = (
  lists: ReadonlyArray<ReadonlyArray<Address> | undefined>,
): Array<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];

  for (const list of lists) {
    for (const a of list ?? []) {
      const addr = a.address.trim().toLowerCase();

      if (addr && !seen.has(addr)) {
        seen.add(addr);
        out.push(addr);
      }
    }
  }

  return out;
};

export const buildMessage = (input: BuildMessageInput): BuiltMessage => {
  let boundaryIndex = 0;
  const nextBoundary = () => (input.boundary ? input.boundary(boundaryIndex++) : randomBoundary());

  const alternatives: Array<Entity> = [];
  const text = input.text ?? (input.html !== undefined ? htmlToText(input.html) : "");
  alternatives.push(textLeaf("text/plain", text));

  if (input.html !== undefined) {
    const htmlLeaf = textLeaf("text/html", input.html);
    alternatives.push(
      input.inline && input.inline.length > 0
        ? {
            kind: "multipart",
            subtype: "related",
            children: [htmlLeaf, ...input.inline.map((p) => binaryLeaf(p, "inline", p.contentId))],
          }
        : htmlLeaf,
    );
  }

  if (input.calendar)
    alternatives.push(
      textLeaf("text/calendar", input.calendar.ics, `; method=${input.calendar.method}`),
    );

  let body: Entity =
    alternatives.length === 1
      ? alternatives[0]!
      : { kind: "multipart", subtype: "alternative", children: alternatives };

  if (input.attachments && input.attachments.length > 0) {
    body = {
      kind: "multipart",
      subtype: "mixed",
      children: [body, ...input.attachments.map((a) => binaryLeaf(a, "attachment"))],
    };
  }

  const messageId = bare(input.messageId);

  const headers: Array<readonly [string, string]> = [
    ["Date", formatMailDate(input.date)],
    ["From", formatAddress(input.from)],
  ];

  if (input.replyTo && input.replyTo.length > 0)
    headers.push(["Reply-To", input.replyTo.map(formatAddress).join(", ")]);

  if (input.to.length > 0) headers.push(["To", input.to.map(formatAddress).join(", ")]);

  if (input.cc && input.cc.length > 0) headers.push(["Cc", input.cc.map(formatAddress).join(", ")]);
  headers.push(
    ["Subject", encodeHeaderWords(stripNewlines(input.subject))],
    ["Message-ID", `<${messageId}>`],
  );
  const clean = (id: string) => `<${bare(id)}>`;

  if (input.inReplyTo) headers.push(["In-Reply-To", clean(input.inReplyTo)]);

  if (input.references && input.references.length > 0)
    headers.push(["References", input.references.map(clean).join(" ")]);

  if (input.autoSubmitted) headers.push(["Auto-Submitted", input.autoSubmitted]);

  for (const [name, value] of input.extraHeaders ?? []) {
    const n = stripNewlines(name).replace(/[^!-9;-~]/g, "");

    if (!n || PROTECTED_HEADERS.has(n.toLowerCase()) || n.toLowerCase().startsWith("content-"))
      continue;
    headers.push([n, encodeHeaderWords(stripNewlines(value))]);
  }

  headers.push(["MIME-Version", "1.0"]);
  const serialized = serialize(body, nextBoundary);
  const allHeaders = [...headers, ...serialized.headers];
  const wire = `${allHeaders.map(([n, v]) => foldHeader(n, v)).join("\r\n")}\r\n\r\n${serialized.body}`;

  return {
    bytes: utf8Encode(wire),
    headers: allHeaders,
    envelopeRecipients: uniqueRecipients([input.to, input.cc, input.bcc]),
    messageId,
  };
};
