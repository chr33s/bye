import { escapeHtml } from "@bye/domain";
import { htmlToText, sanitizeHtml } from "@bye/mail-codec";

// Composer output (E17). The rich editor is a contenteditable surface, so whatever it produces is
// untrusted: it is re-sanitized with the same allowlist the renderer uses before it becomes the
// draft's HTML part, and a plain-text alternative is derived from the sanitized result.

export interface ComposedBody {
  readonly html: string;
  readonly text: string;
}

/** Inline images reference uploads as `cid:<uploadId>`; remote images are never embedded. */
export const composeBody = (editorHtml: string): ComposedBody => {
  const { html } = sanitizeHtml(editorHtml, {
    proxyImage: () => null,
    cid: (id) => `cid:${id}`,
    blockRemoteImages: true,
  });
  return { html, text: htmlToText(html).trim() };
};

/**
 * Re-attach saved inline images (`<img src="cid:<uploadId>">`) to the editor: each gets its
 * `data-cid` back and a displayable URL from the draft's local copy, or no `src` when that copy
 * is gone (the reference is still kept, so the send still carries it).
 */
export const restoreInlineImages = (
  root: ParentNode,
  images: Readonly<Record<string, Blob>> | undefined,
  toUrl: (blob: Blob) => string,
): void => {
  root.querySelectorAll("img[src^='cid:']").forEach((img) => {
    const id = img.getAttribute("src")!.slice(4);
    img.setAttribute("data-cid", id);
    const local = images && Object.hasOwn(images, id) ? images[id] : undefined;
    if (local) img.setAttribute("src", toUrl(local));
    else img.removeAttribute("src");
  });
};

export interface Recipient {
  readonly name?: string;
  readonly address: string;
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/**
 * Parse a recipient field: comma/semicolon separated, `Name <addr>` or bare addresses, and group
 * tokens `@group:Name` expanded through `groups`. Invalid tokens are returned separately so the UI
 * can flag them instead of silently dropping them.
 */
export const parseRecipients = (
  field: string,
  groups: Readonly<Record<string, ReadonlyArray<Recipient>>> = {},
): { readonly recipients: ReadonlyArray<Recipient>; readonly invalid: ReadonlyArray<string> } => {
  const recipients: Array<Recipient> = [];
  const invalid: Array<string> = [];
  const seen = new Set<string>();
  const push = (r: Recipient) => {
    const key = r.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push(r);
  };
  for (const raw of field
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const group = /^@group:(.+)$/i.exec(raw);
    if (group) {
      const members = groups[group[1]!.trim()];
      if (members) members.forEach(push);
      else invalid.push(raw);
      continue;
    }
    const named = /^(.*?)\s*<([^>]+)>$/.exec(raw);
    const address = (named ? named[2]! : raw).trim();
    if (!ADDRESS.test(address)) {
      invalid.push(raw);
      continue;
    }
    const name = named?.[1]?.replace(/^"|"$/g, "").trim();
    push(name ? { name, address } : { address });
  }
  return { recipients, invalid };
};

/** Append a signature below a `-- ` separator unless the body already ends with it. */
export const withSignature = (text: string, signature: string): string => {
  const sig = signature.trim();
  if (!sig) return text;
  const block = `\n\n-- \n${sig}`;
  return text.endsWith(block) ? text : `${text.replace(/\s+$/, "")}${block}`;
};

/** Expand `;;name` snippet shortcuts in plain text. Unknown snippets are left untouched. */
export const expandSnippets = (text: string, snippets: Readonly<Record<string, string>>): string =>
  text.replace(/;;([a-z0-9_-]+)/gi, (whole, name: string) => snippets[name.toLowerCase()] ?? whole);

/** Upload parts: split a file size into part ranges (the server fixes the part size). */
export const partRanges = (
  size: number,
  partSize: number,
): ReadonlyArray<{ readonly part: number; readonly start: number; readonly end: number }> => {
  if (size <= 0) return [];
  const out: Array<{ part: number; start: number; end: number }> = [];
  for (let start = 0, part = 1; start < size; start += partSize, part++)
    out.push({ part, start, end: Math.min(size, start + partSize) });
  return out;
};

/** Plain text → escaped HTML paragraphs (blank lines split paragraphs); used by the World editor. */
export const textToHtml = (value: string): string =>
  `<p>${escapeHtml(value).replace(/\n\n+/g, "</p><p>")}</p>`;
