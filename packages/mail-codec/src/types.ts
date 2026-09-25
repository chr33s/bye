// Shared parsed-message shape. Produced by `parseMessage` in this package and consumed by
// the ingest use case and MailboxDO commit. Bodies/attachments are referenced, not embedded,
// once persisted; `ParsedMessage` is an in-isolate value only.

export interface Address {
  readonly name: string | undefined;
  readonly address: string;
}

export interface ParseLimits {
  readonly maxBytes: number;
  readonly maxParts: number;
  readonly maxDepth: number;
  readonly maxHeaderBytes: number;
  /** Maximum total decoded bytes across all parts (decompression/expansion bound). */
  readonly maxDecodedBytes: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxParts: 500,
  maxDepth: 12,
  maxHeaderBytes: 256 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
};

export interface MimePart {
  readonly partId: string;
  readonly contentType: string;
  readonly params: Readonly<Record<string, string>>;
  readonly disposition: "inline" | "attachment" | undefined;
  readonly filename: string | undefined;
  readonly contentId: string | undefined;
  readonly size: number;
  readonly content: Uint8Array;
  /** True for signed/encrypted/opaque parts that must be preserved byte-for-byte. */
  readonly opaque: boolean;
}

export interface AttachmentMeta {
  readonly partId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly contentId: string | undefined;
  readonly inline: boolean;
}

export type Warning =
  | { readonly _tag: "MalformedBoundary"; readonly partId: string }
  | { readonly _tag: "UnknownCharset"; readonly charset: string }
  | { readonly _tag: "LimitExceeded"; readonly limit: keyof ParseLimits }
  | { readonly _tag: "MalformedHeader"; readonly name: string };

export interface ParsedMessage {
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly from: ReadonlyArray<Address>;
  readonly sender: Address | undefined;
  readonly replyTo: ReadonlyArray<Address>;
  readonly to: ReadonlyArray<Address>;
  readonly cc: ReadonlyArray<Address>;
  readonly subject: string;
  readonly date: number | undefined;
  /** Untrusted RFC Message-ID, without angle brackets. */
  readonly messageIdHeader: string | undefined;
  readonly inReplyTo: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly listId: string | undefined;
  readonly listUnsubscribe: string | undefined;
  readonly autoSubmitted: string | undefined;
  readonly precedence: string | undefined;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: ReadonlyArray<AttachmentMeta>;
  readonly parts: ReadonlyArray<MimePart>;
  /** text/calendar payload if present, with its METHOD. */
  readonly calendar: { readonly method: string | undefined; readonly ics: string } | undefined;
  readonly warnings: ReadonlyArray<Warning>;
  /** True if limits were hit; the original is preserved and the delivery is quarantined for review. */
  readonly truncated: boolean;
}

/** Compact, JSON-safe summary committed into MailboxDO. No body text beyond a snippet. */
export interface MessageSummary {
  readonly from: Address;
  readonly to: ReadonlyArray<Address>;
  readonly cc: ReadonlyArray<Address>;
  readonly replyTo: ReadonlyArray<Address>;
  readonly subject: string;
  readonly date: number;
  readonly messageIdHeader: string | undefined;
  readonly inReplyTo: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly listId: string | undefined;
  readonly listUnsubscribe: string | undefined;
  readonly automated: boolean;
  readonly snippet: string;
  readonly attachments: ReadonlyArray<AttachmentMeta>;
  readonly hasCalendar: boolean;
  readonly calendarMethod: string | undefined;
  /** iTIP UID of the calendar part, extracted at ingest (absent on summaries from older ingests). */
  readonly calendarUid?: string | undefined;
}
