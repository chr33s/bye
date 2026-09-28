import {
  DEFAULT_PARSE_LIMITS,
  parseMessage,
  sanitizeHtml,
  summarizeMessage,
  type ParseLimits,
} from "@bye/mail-codec";

// NDJSON protocol for exceptional messages (§5.1 step 5). Line 1 is the metadata record; each later
// line is one attachment part. The Worker streams lines, writing each part to R2 as it arrives, so
// it never holds more than one decoded part plus the metadata in memory.

export interface MimeMeta {
  readonly type: "meta";
  readonly summary: ReturnType<typeof summarizeMessage>;
  readonly body: {
    readonly text: string;
    readonly html: string | null;
    readonly remoteImages: number;
    readonly blockedTrackers: number;
  };
  /** Headers needed for the transport-authenticated safety verdict (first 64 only). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly attachments: ReadonlyArray<{
    readonly partId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly contentId?: string;
  }>;
  readonly truncated: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface MimePart {
  readonly type: "part";
  readonly partId: string;
  readonly filename: string;
  readonly contentBase64: string;
}

export const CONTAINER_LIMITS: ParseLimits = {
  ...DEFAULT_PARSE_LIMITS,
  maxBytes: 25 * 1024 * 1024,
  maxParts: 1000,
  maxDecodedBytes: 96 * 1024 * 1024,
};

const b64 = (bytes: Uint8Array): string => {
  let s = "";

  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(s);
};

/** Parse a message and yield NDJSON lines (metadata first, then one line per attachment). */
export function* parseToLines(
  bytes: Uint8Array,
  receivedAt: number,
  limits: ParseLimits = CONTAINER_LIMITS,
): Generator<string> {
  const parsed = parseMessage(bytes, limits);

  const sanitized = parsed.html
    ? sanitizeHtml(parsed.html, {
        proxyImage: (url) => url,
        cid: (id) => `cid:${id}`,
        blockRemoteImages: false,
      })
    : undefined;

  const meta: MimeMeta = {
    type: "meta",
    summary: summarizeMessage(parsed, receivedAt),
    body: {
      text: parsed.text ?? "",
      html: sanitized?.html ?? null,
      remoteImages: sanitized?.remoteImages.length ?? 0,
      blockedTrackers: sanitized?.blockedTrackers.length ?? 0,
    },
    headers: parsed.headers.slice(0, 64),
    attachments: parsed.attachments.map((a) => {
      const attachment = {
        partId: a.partId,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      };

      return a.contentId ? { ...attachment, contentId: a.contentId } : attachment;
    }),
    truncated: parsed.truncated,
    warnings: parsed.warnings.map((w) => w._tag),
  };

  yield JSON.stringify(meta);

  for (const a of parsed.attachments) {
    const part = parsed.parts.find((p) => p.partId === a.partId);

    if (!part) continue;

    const line: MimePart = {
      type: "part",
      partId: a.partId,
      filename: a.filename,
      contentBase64: b64(part.content),
    };

    yield JSON.stringify(line);
  }
}
