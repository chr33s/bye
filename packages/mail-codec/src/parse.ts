import {
  binaryToBytes,
  bytesToBinary,
  decodeBase64Binary,
  decodeCharset,
  decodeEncodedWords,
  decodeQuotedPrintableBinary,
  pushWarning,
} from "./encoding.ts";
import {
  headerValue,
  parseAddressList,
  parseHeaderBlock,
  parseMailDate,
  parseMessageIdList,
  parseStructuredHeader,
  type HeaderList,
} from "./headers.ts";
import { htmlToText } from "./sanitize.ts";
import {
  type AttachmentMeta,
  DEFAULT_PARSE_LIMITS,
  type MessageSummary,
  type MimePart,
  type ParsedMessage,
  type ParseLimits,
  type Warning,
} from "./types.ts";

interface ParseCtx {
  readonly limits: ParseLimits;
  readonly warnings: Array<Warning>;
  readonly parts: Array<MimePart>;
  readonly attachments: Array<AttachmentMeta>;
  partCount: number;
  decodedBytes: number;
  truncated: boolean;
  stopped: boolean;
  text: string | undefined;
  html: string | undefined;
  calendar: { method: string | undefined; ics: string } | undefined;
}

const limitHit = (ctx: ParseCtx, limit: keyof ParseLimits): void => {
  ctx.truncated = true;
  pushWarning(ctx.warnings, { _tag: "LimitExceeded", limit });
};

interface SplitEntity {
  readonly header: string;
  readonly body: string;
}

/** Split an entity (binary string) into its header block and body. */
const splitEntity = (entity: string): SplitEntity => {
  if (entity.startsWith("\r\n")) return { header: "", body: entity.slice(2) };

  if (entity.startsWith("\n")) return { header: "", body: entity.slice(1) };
  const crlf = entity.indexOf("\r\n\r\n");
  const lf = entity.indexOf("\n\n");

  if (crlf < 0 && lf < 0) return { header: entity, body: "" };

  if (crlf >= 0 && (lf < 0 || crlf < lf))
    return { header: entity.slice(0, crlf), body: entity.slice(crlf + 4) };

  return { header: entity.slice(0, lf), body: entity.slice(lf + 2) };
};

const decodeTransfer = (body: string, encoding: string | undefined): string => {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      return decodeBase64Binary(body);
    case "quoted-printable":
      return decodeQuotedPrintableBinary(body);
    default:
      return body;
  }
};

const findDelimiter = (body: string, delimiter: string, from: number): number => {
  let i = body.indexOf(delimiter, from);

  while (i >= 0) {
    const after = body[i + delimiter.length];
    const atLineStart = i === 0 || body[i - 1] === "\n";

    const validAfter =
      after === undefined ||
      after === "\r" ||
      after === "\n" ||
      after === " " ||
      after === "\t" ||
      (after === "-" && body[i + delimiter.length + 1] === "-");

    if (atLineStart && validAfter) return i;
    i = body.indexOf(delimiter, i + 1);
  }

  return -1;
};

interface SplitResult {
  readonly parts: ReadonlyArray<string>;
  readonly malformed: boolean;
}

const splitMultipart = (body: string, boundary: string): SplitResult => {
  const delimiter = `--${boundary}`;
  let pos = findDelimiter(body, delimiter, 0);

  if (pos < 0) return { parts: [], malformed: true };
  const parts: Array<string> = [];

  while (pos >= 0) {
    if (body.startsWith("--", pos + delimiter.length)) return { parts, malformed: false };
    const lineEnd = body.indexOf("\n", pos);

    if (lineEnd < 0) return { parts, malformed: true };
    const start = lineEnd + 1;
    const next = findDelimiter(body, delimiter, start);

    if (next < 0) {
      parts.push(body.slice(start));

      return { parts, malformed: true };
    }

    let end = next - 1;

    if (end > start && body[end - 1] === "\r") end -= 1;
    parts.push(body.slice(start, Math.max(start, end)));
    pos = next;
  }

  return { parts, malformed: true };
};

/**
 * Reject a copy before it is allocated: opaque leaves duplicate their entity's bytes, so the
 * decoded-byte budget has to be enforced up front rather than after the allocation.
 */
const exceedsDecodedBudget = (ctx: ParseCtx, length: number): boolean => {
  if (ctx.decodedBytes + length <= ctx.limits.maxDecodedBytes) return false;
  limitHit(ctx, "maxDecodedBytes");
  ctx.stopped = true;

  return true;
};

const recordLeaf = (
  ctx: ParseCtx,
  part: {
    readonly partId: string;
    readonly contentType: string;
    readonly params: Readonly<Record<string, string>>;
    readonly disposition: "inline" | "attachment" | undefined;
    readonly filename: string | undefined;
    readonly contentId: string | undefined;
    readonly content: Uint8Array;
    readonly opaque: boolean;
  },
  forceAttachment: boolean,
): void => {
  if (ctx.stopped) return;
  ctx.partCount++;

  if (ctx.partCount > ctx.limits.maxParts) {
    limitHit(ctx, "maxParts");
    ctx.stopped = true;

    return;
  }

  ctx.decodedBytes += part.content.length;

  if (ctx.decodedBytes > ctx.limits.maxDecodedBytes) {
    limitHit(ctx, "maxDecodedBytes");
    ctx.stopped = true;

    return;
  }

  const mime: MimePart = { ...part, size: part.content.length };
  ctx.parts.push(mime);
  const isAttachment = forceAttachment || part.opaque || part.disposition === "attachment";

  if (!isAttachment && part.contentType === "text/plain" && part.filename === undefined) {
    const text = decodeCharset(part.content, part.params["charset"], ctx.warnings);
    ctx.text = ctx.text === undefined ? text : `${ctx.text}\n\n${text}`;

    return;
  }

  if (
    !isAttachment &&
    part.contentType === "text/html" &&
    part.filename === undefined &&
    ctx.html === undefined
  ) {
    ctx.html = decodeCharset(part.content, part.params["charset"], ctx.warnings);

    return;
  }

  if (part.contentType === "text/calendar" || part.contentType === "application/ics") {
    if (ctx.calendar === undefined) {
      const ics = decodeCharset(part.content, part.params["charset"], ctx.warnings);
      const method = part.params["method"] ?? /^METHOD:(.+)$/im.exec(ics)?.[1]?.trim();
      ctx.calendar = { method: method?.toUpperCase(), ics };
    }

    if (!isAttachment) return;
  }

  ctx.attachments.push({
    partId: part.partId,
    filename: part.filename ?? defaultFilename(part.partId, part.contentType),
    contentType: part.contentType,
    size: part.content.length,
    contentId: part.contentId,
    inline:
      part.disposition === "inline" ||
      (part.contentId !== undefined && part.disposition !== "attachment"),
  });
};

interface ExtensionTable {
  readonly [mediaType: string]: string;
}

const EXTENSIONS: ExtensionTable = {
  "message/rfc822": "eml",
  "text/plain": "txt",
  "text/html": "html",
  "text/calendar": "ics",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/pkcs7-signature": "p7s",
  "application/pgp-signature": "asc",
  "application/pkcs7-mime": "p7m",
  "application/pgp-encrypted": "pgp",
};

const defaultFilename = (partId: string, contentType: string): string =>
  `part-${partId}.${EXTENSIONS[contentType] ?? "bin"}`;

const parseEntity = (
  ctx: ParseCtx,
  entity: string,
  partId: string,
  depth: number,
  headersOverride?: HeaderList,
  /** True below a multipart/signed whose opaque copy already preserves these exact bytes. */
  insideSigned = false,
): void => {
  if (ctx.stopped) return;
  const { header, body } = splitEntity(entity);
  const headers = headersOverride ?? parseHeaderBlock(header, ctx.warnings);

  const ct = parseStructuredHeader(
    headerValue(headers, "content-type") ?? "text/plain",
    ctx.warnings,
  );

  const contentType = ct.value.includes("/") ? ct.value : "text/plain";
  const disp = parseStructuredHeader(headerValue(headers, "content-disposition"), ctx.warnings);

  const disposition =
    disp.value === "attachment" || disp.value === "inline" ? disp.value : undefined;

  const filename = disp.params["filename"] ?? ct.params["name"];
  const rawCid = headerValue(headers, "content-id");
  const contentId = rawCid ? rawCid.trim().replace(/^<|>$/g, "") : undefined;
  const encoding = headerValue(headers, "content-transfer-encoding");

  if (contentType.startsWith("multipart/")) {
    if (depth >= ctx.limits.maxDepth) {
      limitHit(ctx, "maxDepth");

      return;
    }

    const boundary = ct.params["boundary"];
    const split = boundary ? splitMultipart(body, boundary) : { parts: [], malformed: true };

    if (split.malformed) pushWarning(ctx.warnings, { _tag: "MalformedBoundary", partId });

    if (split.parts.length === 0) {
      // Best effort: expose the body as text so content is not silently lost.
      recordLeaf(
        ctx,
        {
          partId,
          contentType: "text/plain",
          params: {},
          disposition: undefined,
          filename: undefined,
          contentId: undefined,
          content: binaryToBytes(body),
          opaque: false,
        },
        false,
      );

      return;
    }

    const prefix = partId === "" ? "" : `${partId}.`;
    const subtype = contentType.slice("multipart/".length);
    split.parts.forEach((child, index) => {
      const childId = `${prefix}${index + 1}`;

      if (subtype === "encrypted") {
        if (exceedsDecodedBudget(ctx, child.length)) return;
        recordLeaf(
          ctx,
          {
            partId: childId,
            contentType:
              parseStructuredHeader(
                headerValue(parseHeaderBlock(splitEntity(child).header, []), "content-type"),
                [],
              ).value || "application/octet-stream",
            params: {},
            disposition: "attachment",
            filename: undefined,
            contentId: undefined,
            content: binaryToBytes(child),
            opaque: true,
          },
          true,
        );

        return;
      }

      if (subtype === "signed" && index === 0) {
        // A nested signed entity is a byte range of the enclosing opaque copy, so only the
        // outermost one is preserved; copying at every level would amplify the input per depth.
        if (insideSigned) {
          parseEntity(ctx, child, childId, depth + 1, undefined, true);

          return;
        }

        // Preserve the exact signed entity bytes so the signature remains verifiable.
        if (exceedsDecodedBudget(ctx, child.length)) return;
        recordLeaf(
          ctx,
          {
            partId: `${childId}.signed`,
            contentType: "application/octet-stream",
            params: {},
            disposition: "attachment",
            filename: "signed-content.eml",
            contentId: undefined,
            content: binaryToBytes(child),
            opaque: true,
          },
          true,
        );
        parseEntity(ctx, child, childId, depth + 1, undefined, true);
        // The opaque copy is an implementation detail, not a user-visible attachment.
        const idx = ctx.attachments.findIndex((a) => a.partId === `${childId}.signed`);

        if (idx >= 0) ctx.attachments.splice(idx, 1);

        return;
      }

      parseEntity(ctx, child, childId, depth + 1, undefined, insideSigned);
    });

    return;
  }

  const decoded = binaryToBytes(decodeTransfer(body, encoding));
  const effectiveId = partId === "" ? "1" : partId;

  if (contentType === "message/rfc822" || contentType === "message/global") {
    const nestedHeaders = parseHeaderBlock(splitEntity(bytesToBinary(decoded)).header, []);
    const subject = decodeEncodedWords(headerValue(nestedHeaders, "subject") ?? "").trim();
    // oxlint-disable-next-line no-control-regex -- intentional control-char match
    const safe = subject.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100);
    recordLeaf(
      ctx,
      {
        partId: effectiveId,
        contentType,
        params: ct.params,
        disposition: disposition ?? "attachment",
        filename: filename ?? `${safe || "message"}.eml`,
        contentId,
        content: decoded,
        opaque: false,
      },
      true,
    );

    return;
  }

  const opaque =
    contentType === "application/pkcs7-signature" ||
    contentType === "application/x-pkcs7-signature" ||
    contentType === "application/pgp-signature" ||
    contentType === "application/pkcs7-mime" ||
    contentType === "application/x-pkcs7-mime";

  recordLeaf(
    ctx,
    {
      partId: effectiveId,
      contentType,
      params: ct.params,
      disposition,
      filename,
      contentId,
      content: decoded,
      opaque,
    },
    opaque,
  );
};

/**
 * Parse a raw RFC 5322 message. Never throws on hostile input: limit violations and malformed
 * structure are reported via `warnings`/`truncated` so the original can be quarantined.
 */
export const parseMessage = (
  input: Uint8Array,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
): ParsedMessage => {
  const ctx: ParseCtx = {
    limits,
    warnings: [],
    parts: [],
    attachments: [],
    partCount: 0,
    decodedBytes: 0,
    truncated: false,
    stopped: false,
    text: undefined,
    html: undefined,
    calendar: undefined,
  };

  let bytes = input;

  if (bytes.length > limits.maxBytes) {
    limitHit(ctx, "maxBytes");
    bytes = bytes.subarray(0, limits.maxBytes);
  }

  let headers: Array<readonly [string, string]> = [];

  try {
    const raw = bytesToBinary(bytes);
    const { header, body } = splitEntity(raw);
    let headerBlock = header;

    if (headerBlock.length > limits.maxHeaderBytes) {
      limitHit(ctx, "maxHeaderBytes");
      headerBlock = headerBlock.slice(0, limits.maxHeaderBytes);
    }

    headers = parseHeaderBlock(headerBlock, ctx.warnings);
    parseEntity(ctx, `\r\n${body}`, "", 0, headers);
  } catch (error) {
    ctx.truncated = true;
    pushWarning(ctx.warnings, {
      _tag: "MalformedHeader",
      name: `parse-error:${error instanceof Error ? error.name : "unknown"}`,
    });
  }

  const get = (name: string) => headerValue(headers, name);

  return {
    headers,
    from: parseAddressList(get("from"), ctx.warnings),
    sender: parseAddressList(get("sender"), ctx.warnings)[0],
    replyTo: parseAddressList(get("reply-to"), ctx.warnings),
    to: parseAddressList(get("to"), ctx.warnings),
    cc: parseAddressList(get("cc"), ctx.warnings),
    subject: decodeEncodedWords(get("subject") ?? "", ctx.warnings)
      .replace(/\s+/g, " ")
      .trim(),
    date: parseMailDate(get("date")),
    messageIdHeader: parseMessageIdList(get("message-id"))[0],
    inReplyTo: parseMessageIdList(get("in-reply-to")),
    references: parseMessageIdList(get("references")),
    listId: get("list-id")?.trim(),
    listUnsubscribe: get("list-unsubscribe")?.trim(),
    autoSubmitted: get("auto-submitted")?.trim().toLowerCase(),
    precedence: get("precedence")?.trim().toLowerCase(),
    text: ctx.text,
    html: ctx.html,
    attachments: ctx.attachments,
    parts: ctx.parts,
    calendar: ctx.calendar,
    warnings: ctx.warnings,
    truncated: ctx.truncated,
  };
};

const AUTOMATED_SENDER =
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+-][^@]*)?@/i;

// Delivery status and disposition notifications (RFC 3462 / RFC 6522): bounces and read receipts.
const REPORT_TYPE = /^\s*multipart\/report\b/i;

export const isAutomatedMessage = (
  parsed: Pick<ParsedMessage, "autoSubmitted" | "precedence" | "listId" | "from"> &
    Partial<Pick<ParsedMessage, "headers">>,
): boolean =>
  (parsed.autoSubmitted !== undefined && parsed.autoSubmitted !== "no") ||
  (parsed.headers ?? []).some(
    ([n, v]) => n.toLowerCase() === "content-type" && REPORT_TYPE.test(v),
  ) ||
  (parsed.precedence !== undefined &&
    ["bulk", "list", "junk", "auto_reply"].includes(parsed.precedence)) ||
  parsed.listId !== undefined ||
  parsed.from.some((a) => AUTOMATED_SENDER.test(a.address));

export const SNIPPET_LENGTH = 200;

export const makeSnippet = (text: string | undefined, html: string | undefined): string => {
  const source = text ?? (html ? htmlToText(html) : "");
  const collapsed = source.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);

  return chars.length <= SNIPPET_LENGTH
    ? collapsed
    : `${chars.slice(0, SNIPPET_LENGTH - 1).join("")}…`;
};

/** UID of the first iCalendar component (RFC 5545 line unfolding applied). */
export const icsUid = (ics: string): string | undefined =>
  /^UID[^:\r\n]*:(.+)$/m.exec(ics.replace(/\r?\n[ \t]/g, ""))?.[1]?.trim() || undefined;

/** JSON-safe summary committed into the mailbox authority. */
export const summarizeMessage = (parsed: ParsedMessage, receivedAt: number): MessageSummary => ({
  from: parsed.from[0] ?? parsed.sender ?? { name: undefined, address: "" },
  to: parsed.to,
  cc: parsed.cc,
  replyTo: parsed.replyTo,
  subject: parsed.subject,
  date: parsed.date ?? receivedAt,
  messageIdHeader: parsed.messageIdHeader,
  inReplyTo: parsed.inReplyTo,
  references: parsed.references,
  listId: parsed.listId,
  listUnsubscribe: parsed.listUnsubscribe,
  automated: isAutomatedMessage(parsed),
  snippet: makeSnippet(parsed.text, parsed.html),
  attachments: parsed.attachments.filter((a) => !a.inline || a.contentId === undefined),
  hasCalendar: parsed.calendar !== undefined,
  calendarMethod: parsed.calendar?.method,
  calendarUid: parsed.calendar ? icsUid(parsed.calendar.ics) : undefined,
});
