import { Predicate, type Schema } from "effect";
import {
  type Address,
  bodyValuesOf,
  buildMessage,
  type OutboundAttachment,
  type OutboundInlinePart,
  type OutboundPart,
  partContent,
  prepareEmail,
  withoutBcc,
} from "@bye/mail-codec";
import type { PreparedContent, PreparedSubmission } from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";

// Content preparation before publication (spec.md §16.4): bytes are built or read and written
// to R2, then parsed once, before any account transaction. Content-addressed keys make retries
// idempotent; a crash after the R2 write leaves an unreferenced object for delayed cleanup, never
// an Email without bytes (B4).

/** Reads a blob's bytes as the principal is allowed to see them; null when absent or gated. */
export type BlobReader = (blobId: string) => Promise<Uint8Array | null>;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

const addresses = (value: Schema.Json | undefined): ReadonlyArray<Address> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<Schema.Json>).flatMap((a) =>
        Predicate.isObject(a) && Predicate.isString((a as Schema.JsonObject)["email"])
          ? [
              {
                name: Predicate.isString((a as Schema.JsonObject)["name"])
                  ? ((a as Schema.JsonObject)["name"] as string)
                  : undefined,
                address: (a as Schema.JsonObject)["email"] as string,
              },
            ]
          : [],
      )
    : [];

const strings = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  Array.isArray(value) ? (value as ReadonlyArray<Schema.Json>).filter(Predicate.isString) : [];

const objects = (value: Schema.Json | undefined): ReadonlyArray<Schema.JsonObject> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<Schema.Json>).flatMap((v) =>
        Predicate.isObject(v) && !Array.isArray(v) ? [v as Schema.JsonObject] : [],
      )
    : [];

/** Store immutable message bytes under a content-addressed key and prepare them. */
const storeMessage = async (
  env: Pick<CoreEnv, "ORIGINALS">,
  accountId: string,
  bytes: Uint8Array,
  kind: "msg" | "sub",
): Promise<{ readonly blobId: string; readonly r2Key: string }> => {
  const digest = await sha256Hex(bytes);
  const r2Key = `t/${accountId}/jmap/${kind}/${digest}.eml`;

  if (!(await env.ORIGINALS.head(r2Key)))
    await env.ORIGINALS.put(r2Key, bytes, { httpMetadata: { contentType: "message/rfc822" } });

  return { blobId: `${kind === "msg" ? "M" : "S"}${digest.slice(0, 40)}`, r2Key };
};

const MAX_STRUCTURE_DEPTH = 10;

export class PrepareError extends Error {
  override readonly name = "PrepareError";
}

/**
 * Build an RFC 5322 message from an Email/set create object (RFC 8621 §4.6): addresses, subject,
 * threading headers, text/html body values, attachments by blobId, and `header:` forms.
 */
export const prepareEmailCreate = async (
  env: Pick<CoreEnv, "ORIGINALS">,
  accountId: string,
  obj: Schema.JsonObject,
  readBlob: BlobReader,
): Promise<PreparedContent> => {
  const from = addresses(obj["from"]);

  if (from.length !== 1) throw new PrepareError("exactly one From address is required");

  const values = Predicate.isObject(obj["bodyValues"])
    ? (obj["bodyValues"] as Schema.JsonObject)
    : {};

  const valueOf = (part: Schema.JsonObject): string | undefined => {
    const id = part["partId"];
    const v = Predicate.isString(id) ? values[id] : undefined;

    return Predicate.isObject(v) && Predicate.isString((v as Schema.JsonObject)["value"])
      ? ((v as Schema.JsonObject)["value"] as string)
      : undefined;
  };

  let text: string | undefined;
  let html: string | undefined;
  const attachments: Array<OutboundAttachment> = [];
  const inline: Array<OutboundInlinePart> = [];

  const addBlob = async (part: Schema.JsonObject) => {
    const blobId = part["blobId"];

    if (!Predicate.isString(blobId)) throw new PrepareError("attachment without blobId");
    const content = await readBlob(blobId);

    if (content === null) throw new PrepareError(`blob ${blobId} not found`);
    const filename = Predicate.isString(part["name"]) ? part["name"] : blobId;

    const contentType = Predicate.isString(part["type"])
      ? part["type"]
      : "application/octet-stream";

    const cid = part["cid"];

    if (part["disposition"] === "inline" && Predicate.isString(cid))
      inline.push({ filename, contentType, content, contentId: cid });
    else attachments.push({ filename, contentType, content });
  };

  const leaf = async (part: Schema.JsonObject, defaultType = "text/plain") => {
    const type = Predicate.isString(part["type"]) ? part["type"].toLowerCase() : defaultType;

    if (Predicate.isString(part["blobId"])) return addBlob(part);
    const value = valueOf(part);

    if (value === undefined) throw new PrepareError("body part without a body value");

    if (type === "text/html") html ??= value;
    else text ??= value;
  };

  /** The client's MIME tree as given (RFC 8621 §4.6 `bodyStructure`), depth-bounded. */
  const tree = async (part: Schema.JsonObject, depth: number): Promise<OutboundPart> => {
    if (depth > MAX_STRUCTURE_DEPTH) throw new PrepareError("bodyStructure nests too deeply");
    const type = Predicate.isString(part["type"]) ? part["type"].toLowerCase() : "text/plain";
    const subParts = objects(part["subParts"]);

    if (type.startsWith("multipart/")) {
      const parts: Array<OutboundPart> = [];

      for (const p of subParts) parts.push(await tree(p, depth + 1));

      return { kind: "multipart", subtype: type.slice("multipart/".length), parts };
    }

    const disposition =
      part["disposition"] === "attachment" || part["disposition"] === "inline"
        ? part["disposition"]
        : undefined;

    const name = Predicate.isString(part["name"]) ? part["name"] : undefined;
    const blobId = part["blobId"];

    if (Predicate.isString(blobId)) {
      const content = await readBlob(blobId);

      if (content === null) throw new PrepareError(`blob ${blobId} not found`);
      const cid = part["cid"];

      return {
        kind: "binary",
        type,
        content,
        filename: name ?? blobId,
        disposition: disposition ?? "attachment",
        ...(Predicate.isString(cid) ? { contentId: cid } : undefined),
      };
    }

    const value = valueOf(part);

    if (value === undefined) throw new PrepareError("body part without a body value");

    return disposition === undefined
      ? { kind: "text", type, text: value }
      : {
          kind: "text",
          type,
          text: value,
          disposition,
          ...(name ? { filename: name } : undefined),
        };
  };

  let structure: OutboundPart | undefined;

  if (Predicate.isObject(obj["bodyStructure"]))
    structure = await tree(obj["bodyStructure"] as Schema.JsonObject, 0);
  else {
    for (const p of objects(obj["textBody"])) await leaf(p, "text/plain");

    for (const p of objects(obj["htmlBody"])) await leaf(p, "text/html");

    for (const p of objects(obj["attachments"])) await addBlob(p);
  }

  const extraHeaders: Array<readonly [string, string]> = [];
  const bcc = addresses(obj["bcc"]);

  const sender = addresses(obj["sender"])[0];

  for (const [key, value] of Object.entries(obj)) {
    const m = /^header:([!-9;-~]+)(?::asText|:asRaw)?$/.exec(key);

    if (m && Predicate.isString(value)) extraHeaders.push([m[1]!, value.replace(/[\r\n]+/g, " ")]);
  }

  const messageIds = strings(obj["messageId"]);
  const inReplyTo = strings(obj["inReplyTo"]);
  const sentAt = Predicate.isString(obj["sentAt"]) ? Date.parse(obj["sentAt"]) : Number.NaN;
  const domain = from[0]!.address.split("@")[1] ?? "localhost";

  const built = buildMessage({
    from: from[0]!,
    ...(sender === undefined ? undefined : { sender }),
    to: addresses(obj["to"]),
    cc: addresses(obj["cc"]),
    bcc,
    draftBcc: true,
    replyTo: addresses(obj["replyTo"]),
    subject: Predicate.isString(obj["subject"]) ? obj["subject"] : "",
    ...(text === undefined && html === undefined ? { text: "" } : undefined),
    ...(text === undefined ? undefined : { text }),
    ...(html === undefined ? undefined : { html }),
    attachments,
    inline,
    date: Number.isFinite(sentAt) ? sentAt : Date.now(),
    messageId: messageIds[0] ?? `${crypto.randomUUID()}@${domain}`,
    ...(inReplyTo[0] === undefined ? undefined : { inReplyTo: inReplyTo[0] }),
    references: strings(obj["references"]),
    extraHeaders,
    ...(structure ? { structure } : undefined),
  });

  const stored = await storeMessage(env, accountId, built.bytes, "msg");

  return {
    ...stored,
    bucket: "originals",
    type: "message/rfc822",
    email: prepareEmail(built.bytes),
  };
};

/** Prepare an existing blob for Email/import (bytes already immutable in R2). */
export const prepareBlob = (
  blob: { readonly blobId: string; readonly bucket: "originals" | "parts"; readonly r2Key: string },
  bytes: Uint8Array,
): PreparedContent => ({
  blobId: blob.blobId,
  bucket: blob.bucket,
  r2Key: blob.r2Key,
  type: "message/rfc822",
  email: prepareEmail(bytes),
});

/**
 * The submission's own content pin (B2): the Email's bytes with Bcc removed, stored immutably so
 * later Email changes or destruction never alter what is sent.
 */
export const prepareSubmission = async (
  env: Pick<CoreEnv, "ORIGINALS">,
  accountId: string,
  emailBytes: Uint8Array,
): Promise<PreparedSubmission> => {
  const bytes = withoutBcc(emailBytes);
  const stored = await storeMessage(env, accountId, bytes, "sub");

  return { blobId: stored.blobId, r2Key: stored.r2Key, size: bytes.byteLength };
};

/** RFC 8621 §4.2 bodyValues for one Email's text/html parts. */
export const bodyValues = (
  bytes: Uint8Array,
  options: {
    readonly text: boolean;
    readonly html: boolean;
    readonly all: boolean;
    readonly maxBytes: number;
  },
): Schema.JsonObject => {
  const e = prepareEmail(bytes);

  const ids = new Set([
    ...(options.text || options.all ? e.textBody : []),
    ...(options.html || options.all ? e.htmlBody : []),
  ]);

  const out: { [partId: string]: Schema.Json } = {};

  for (const [id, v] of bodyValuesOf(bytes, ids, options.maxBytes))
    out[id] = {
      value: v.value,
      isEncodingProblem: v.isEncodingProblem,
      isTruncated: v.isTruncated,
    };

  return out;
};

/** One leaf part's decoded bytes (part blob downloads). */
export const partBytes = (bytes: Uint8Array, partId: string) => partContent(bytes, partId);
