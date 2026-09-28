// Allowlist HTML sanitizer for message rendering (§10). The output is rendered on a separate,
// sandboxed origin; this is defence in depth, not the only barrier.

export type HtmlToken =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "start";
      readonly name: string;
      readonly attrs: ReadonlyArray<readonly [string, string]>;
      readonly selfClosing: boolean;
    }
  | { readonly type: "end"; readonly name: string }
  | { readonly type: "comment" };

const RAWTEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

interface NamedEntityTable {
  readonly [name: string]: string;
}

const NAMED_ENTITIES: NamedEntityTable = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  zwnj: "\u200c",
  zwj: "\u200d",
  shy: "\u00ad",
  colon: ":",
  tab: "\t",
  newline: "\n",
  lpar: "(",
  rpar: ")",
};

export const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);

      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return "\ufffd";

      return String.fromCodePoint(code);
    }

    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];

    return named ?? match;
  });

const escapeText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, "&quot;");

/** Tolerant HTML tokenizer. Never throws; unknown constructs become text or are skipped. */
export const tokenizeHtml = (html: string): Array<HtmlToken> => {
  const tokens: Array<HtmlToken> = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      tokens.push({ type: "comment" });
      i = end < 0 ? len : end + 3;
      continue;
    }

    if (html[i] === "<" && (html[i + 1] === "!" || html[i + 1] === "?")) {
      const end = html.indexOf(">", i);
      tokens.push({ type: "comment" });
      i = end < 0 ? len : end + 1;
      continue;
    }

    if (html[i] === "<" && html[i + 1] === "/" && /[A-Za-z]/.test(html[i + 2] ?? "")) {
      const end = html.indexOf(">", i);
      const name = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(i + 2))?.[0] ?? "";
      tokens.push({ type: "end", name: name.toLowerCase() });
      i = end < 0 ? len : end + 1;
      continue;
    }

    if (html[i] === "<" && /[A-Za-z]/.test(html[i + 1] ?? "")) {
      let j = i + 1;

      while (j < len && /[A-Za-z0-9:-]/.test(html[j]!)) j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const attrs: Array<readonly [string, string]> = [];
      const seen = new Set<string>();
      let selfClosing = false;

      while (j < len) {
        while (j < len && /[\s/]/.test(html[j]!)) {
          if (html[j] === "/" && html[j + 1] === ">") selfClosing = true;
          j++;
        }

        if (j >= len || html[j] === ">") break;
        let k = j;

        while (k < len && !/[\s/>=]/.test(html[k]!)) k++;

        if (k === j) k++;
        const attrName = html.slice(j, k).toLowerCase();
        j = k;

        while (j < len && /\s/.test(html[j]!)) j++;
        let value = "";

        if (html[j] === "=") {
          j++;

          while (j < len && /\s/.test(html[j]!)) j++;
          const quote = html[j];

          if (quote === '"' || quote === "'") {
            const end = html.indexOf(quote, j + 1);
            value = html.slice(j + 1, end < 0 ? len : end);
            j = end < 0 ? len : end + 1;
          } else {
            let e = j;

            while (e < len && !/[\s>]/.test(html[e]!)) e++;
            value = html.slice(j, e);
            j = e;
          }
        }

        if (!seen.has(attrName)) {
          seen.add(attrName);
          attrs.push([attrName, decodeHtmlEntities(value)]);
        }
      }

      i = j + 1;
      // Browsers ignore `/>` on raw-text elements: `<style/>` still opens a style block.
      const rawText = RAWTEXT.has(name);
      tokens.push({ type: "start", name, attrs, selfClosing: selfClosing && !rawText });

      if (rawText) {
        const closeRe = new RegExp(`</${name}[\\s>/]`, "i");
        const rest = html.slice(i);
        const found = closeRe.exec(rest);
        const endIdx = found ? i + found.index : len;
        tokens.push({ type: "text", text: html.slice(i, endIdx) });
        tokens.push({ type: "end", name });
        const gt = html.indexOf(">", endIdx);
        i = found ? (gt < 0 ? len : gt + 1) : len;
      }

      continue;
    }

    let next = i + 1;

    while (next < len) {
      const at = html.indexOf("<", next);

      if (at < 0) {
        next = len;
        break;
      }

      const c = html[at + 1] ?? "";

      if (/[A-Za-z!?/]/.test(c)) {
        next = at;
        break;
      }

      next = at + 1;
    }

    tokens.push({ type: "text", text: decodeHtmlEntities(html.slice(i, next)) });
    i = next;
  }

  return tokens;
};

// ---------- sanitizer ----------

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "label",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "wbr",
]);

const DROP_WITH_CONTENT = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "noscript",
  "template",
  "svg",
  "math",
  "frame",
  "frameset",
  "title",
  "textarea",
  "select",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  "head",
  "audio",
  "video",
  "canvas",
]);

const VOID = new Set([
  "br",
  "hr",
  "img",
  "col",
  "wbr",
  "input",
  "meta",
  "link",
  "base",
  "source",
  "area",
  "param",
  "embed",
  "track",
]);

const ALLOWED_ATTRS = new Set([
  "style",
  "class",
  "title",
  "dir",
  "lang",
  "align",
  "valign",
  "width",
  "height",
  "bgcolor",
  "color",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "face",
  "size",
  "alt",
  "start",
  "type",
  "span",
  "nowrap",
]);

const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i;

const TRACKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\/\/([^/]+\.)?mailtrack\.io\//i,
  /list-manage\.com\/track\/open/i,
  /\/wf\/open\?/i,
  /mandrillapp\.com\/track\/open/i,
  /\/\/t\.yesware\.com\//i,
  /mixmax\.com\/api\/track/i,
  /\/\/([^/]+\.)?mailstat\.us\/tr/i,
  /\/\/track\.customer\.io\//i,
  /\/\/([^/]+\.)?hubspotemail\.net\//i,
  /\/track\/open/i,
  /\/open\.(gif|png|jpg)(\?|$)/i,
  /\/(pixel|beacon|tracking)(\.gif|\.png)?(\?|$)/i,
];

export const isKnownTrackerUrl = (url: string): boolean =>
  TRACKER_PATTERNS.some((re) => re.test(url));

export interface SanitizeOptions {
  /** Return a proxied URL for a remote image, or null to drop it. */
  readonly proxyImage: (url: string) => string | null;
  /** Resolve a cid: reference to a same-origin part URL, or null to drop it. */
  readonly cid: (contentId: string) => string | null;
  readonly blockRemoteImages: boolean;
  /**
   * Keep (sanitized) `<style>` blocks. Default true for isolated rendering (one message per
   * sandboxed document); pages that place several untrusted messages in ONE document must pass
   * false, because a stylesheet applies to the whole page.
   */
  readonly allowStyleBlocks?: boolean;
}

export interface SanitizedHtml {
  readonly html: string;
  readonly blockedTrackers: ReadonlyArray<string>;
  readonly remoteImages: ReadonlyArray<string>;
}

// oxlint-disable-next-line no-control-regex -- intentional control-char match
const stripForScheme = (url: string): string => url.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");

const schemeOf = (url: string): string | undefined =>
  /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();

const sanitizeHref = (value: string): string | null => {
  const trimmed = value.trim();
  const stripped = stripForScheme(trimmed);

  if (stripped.startsWith("#")) return stripped;
  const scheme = schemeOf(stripped);

  if (!scheme || !["http", "https", "mailto", "tel"].includes(scheme)) return null;

  if (schemeOf(trimmed) !== scheme) return null;

  return trimmed;
};

interface Ctx {
  readonly opts: SanitizeOptions;
  readonly trackers: Array<string>;
  readonly remote: Array<string>;
}

const resolveImageUrl = (raw: string, ctx: Ctx): string | null => {
  const url = stripForScheme(raw.trim());
  const scheme = schemeOf(url);

  if (scheme === "cid") return ctx.opts.cid(url.slice(4).replace(/^<|>$/g, ""));

  if (scheme === "data") return SAFE_DATA_IMAGE.test(url) ? url.replace(/\s+/g, "") : null;

  if (scheme === "http" || scheme === "https") {
    if (isKnownTrackerUrl(url)) {
      ctx.trackers.push(url);

      return null;
    }

    ctx.remote.push(url);

    if (ctx.opts.blockRemoteImages) return null;

    return ctx.opts.proxyImage(url);
  }

  return null;
};

/**
 * Decode every CSS escape in ONE pass, so a decoded character is never re-scanned as an escape
 * (the old hex-then-char passes turned `\5c \5c 75rl(` into `\75rl(`, which the browser reads as
 * `url(`). The output keeps no backslash at all — neither decoded (`\5c`, `\\`) nor dangling — so
 * what the checks see is exactly what the browser will parse, with nothing left to re-decode.
 */
const decodeCssEscapes = (css: string): string =>
  css.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\r\n|([\s\S])|$)/g,
    (_, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined) {
        const code = parseInt(hex, 16);

        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0x5c
          ? String.fromCodePoint(code)
          : "";
      }

      // `\<newline>` is a line continuation; an escaped backslash is dropped rather than emitted.
      return ch === undefined || ch === "\\" || /[\r\n\f]/.test(ch) ? "" : ch;
    },
  );

const splitDeclarations = (text: string): Array<string> => {
  const out: Array<string> = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";

  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);

  return out;
};

const DANGEROUS_CSS =
  /expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding|<\/?\s*style/i;

// Image functions that accept a bare string URL, which the url() rewrite below would not see.
const STRING_IMAGE_FN = /image-set\s*\(|(?:^|[^\w-])(?:image|src)\s*\(|cross-fade\s*\(/i;

/**
 * A `/*` left in the output (from a decoded `\2f\2a`, or a comment never closed) would start a
 * comment the browser honours but the sanitizer never parsed. `/ *` means the same in any value.
 */
const neutralizeComments = (css: string): string => css.replace(/\/\*/g, "/ *");

const sanitizeDeclarations = (text: string, ctx: Ctx): string => {
  const kept: Array<string> = [];

  for (const decl of splitDeclarations(text)) {
    const colon = decl.indexOf(":");

    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim();

    if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) continue;

    if (prop === "behavior" || prop.includes("binding") || DANGEROUS_CSS.test(value)) continue;

    if (STRING_IMAGE_FN.test(value)) continue;

    if (prop === "position" && /fixed|sticky/i.test(value)) continue;
    let ok = true;
    value = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, _q: string, target: string) => {
      const resolved = resolveImageUrl(target, ctx);

      if (resolved === null) {
        ok = false;

        return "";
      }

      return `url("${resolved.replace(/["\\]/g, "")}")`;
    });

    if (!ok || /url\s*\(/i.test(value.replace(/url\("[^"]*"\)/g, ""))) continue;
    kept.push(`${prop}: ${value}`);
  }

  return neutralizeComments(kept.join("; "));
};

export interface SanitizedCss {
  readonly css: string;
  readonly remoteImages: ReadonlyArray<string>;
  readonly blockedTrackers: ReadonlyArray<string>;
}

export const sanitizeCss = (css: string, opts: SanitizeOptions): SanitizedCss => {
  const ctx: Ctx = { opts, trackers: [], remote: [] };

  return {
    css: sanitizeStyleBlock(css, ctx),
    remoteImages: ctx.remote,
    blockedTrackers: ctx.trackers,
  };
};

const sanitizeStyleBlock = (css: string, ctx: Ctx): string => {
  let text = decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  text = text
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@charset[^;]*;?/gi, "")
    .replace(/@namespace[^;]*;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "");

  return neutralizeComments(rebuildStylesheet(text, ctx))
    .replace(/<\//g, "<\\/")
    .replace(/[<>]/g, "");
};

/**
 * Rebuild a stylesheet from its block structure so EVERY declaration list is sanitized, at any
 * nesting depth (CSS nesting puts declarations beside nested rules), and nothing unsanitized
 * survives:
 * - text inside a block, up to a nested rule's selector, is a declaration list → sanitized;
 * - selectors/at-rule preludes carrying url()/expression()/javascript: are neutralized;
 * - a rule never closed (browsers auto-close it at end of sheet) and stray `}` are dropped, as is
 *   top-level text that isn't followed by a block;
 * - braces inside a quoted string (ended by its quote or a newline, as in CSS) are not structure.
 */
const rebuildStylesheet = (text: string, ctx: Ctx): string => {
  const out: Array<string> = [];
  let buf = "";
  let depth = 0;
  let complete = 0; // out length at the last point the sheet was balanced
  let quote: string | undefined;

  const prelude = (raw: string) => {
    const p = raw.trim();

    return /url\s*\(|expression\s*\(|javascript:|image-set|@import/i.test(p) ? "x-blocked" : p;
  };

  for (const c of text) {
    if (quote) {
      if (c === quote || c === "\n") quote = undefined;
      buf += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      buf += c;
    } else if (c === "{") {
      if (depth > 0) {
        // Declarations may precede a nested rule: `color:red; b { … }`.
        const cut = buf.lastIndexOf(";");
        const decls = cut >= 0 ? buf.slice(0, cut) : "";
        const kept = decls.trim() ? sanitizeDeclarations(decls, ctx) : "";

        if (kept) out.push(`${kept}; `);
        out.push(`${prelude(cut >= 0 ? buf.slice(cut + 1) : buf)} { `);
      } else {
        out.push(`${prelude(buf)} { `);
      }

      depth++;
      buf = "";
    } else if (c === "}") {
      if (depth === 0) {
        buf = ""; // stray closing brace: drop it and whatever preceded it at top level
        continue;
      }

      const kept = buf.trim() ? sanitizeDeclarations(buf, ctx) : "";
      out.push(`${kept} }`);
      depth--;
      buf = "";

      if (depth === 0) {
        out.push("\n");
        complete = out.length;
      }
    } else {
      buf += c;
    }
  }

  return out.slice(0, complete).join("");
};

const isHiddenOrPixel = (attrs: ReadonlyMap<string, string>): boolean => {
  const width = Number.parseFloat(attrs.get("width") ?? "");
  const height = Number.parseFloat(attrs.get("height") ?? "");

  if ((width <= 1 && height <= 1) || width === 0 || height === 0) return true;
  const style = (attrs.get("style") ?? "").toLowerCase().replace(/\s+/g, "");

  if (/display:none|visibility:hidden|opacity:0(?![.\d])/.test(style)) return true;

  if (/(^|;)width:[01]px/.test(style) && /(^|;)height:[01]px/.test(style)) return true;

  return false;
};

export const sanitizeHtml = (html: string, opts: SanitizeOptions): SanitizedHtml => {
  const ctx: Ctx = { opts, trackers: [], remote: [] };
  const out: Array<string> = [];
  const skip: Array<string> = [];
  let inStyle = false;

  for (const token of tokenizeHtml(html)) {
    if (skip.length > 0) {
      const top = skip[skip.length - 1]!;

      if (
        token.type === "start" &&
        token.name === top &&
        !token.selfClosing &&
        !VOID.has(token.name)
      )
        skip.push(top);
      else if (token.type === "end" && token.name === top) skip.pop();
      continue;
    }

    switch (token.type) {
      case "comment":
        break;
      case "text":
        out.push(inStyle ? sanitizeStyleBlock(token.text, ctx) : escapeText(token.text));
        break;
      case "end":
        if (token.name === "style") inStyle = false;

        if (ALLOWED_TAGS.has(token.name) && !VOID.has(token.name)) out.push(`</${token.name}>`);
        break;
      case "start": {
        const { name } = token;

        if (DROP_WITH_CONTENT.has(name)) {
          if (!token.selfClosing && !VOID.has(name)) skip.push(name);
          break;
        }

        if (!ALLOWED_TAGS.has(name)) break;
        const attrs = new Map(token.attrs);
        const kept: Array<string> = [];

        if (name === "img") {
          const src = attrs.get("src");

          if (!src) break;
          const scheme = schemeOf(stripForScheme(src.trim()));

          if ((scheme === "http" || scheme === "https") && isHiddenOrPixel(attrs)) {
            ctx.trackers.push(src.trim());
            break;
          }

          const resolved = resolveImageUrl(src, ctx);

          if (resolved === null) break;
          kept.push(`src="${escapeAttr(resolved)}"`);
        }

        if (name === "a") {
          const href = attrs.get("href");
          const safe = href === undefined ? null : sanitizeHref(href);

          if (safe !== null)
            kept.push(`href="${escapeAttr(safe)}"`, 'rel="noopener noreferrer"', 'target="_blank"');
        }

        for (const [attr, value] of token.attrs) {
          if (!ALLOWED_ATTRS.has(attr)) continue;

          if (attr === "style") {
            const css = sanitizeDeclarations(
              decodeCssEscapes(value.replace(/\/\*[\s\S]*?\*\//g, "")),
              ctx,
            );

            if (css) kept.push(`style="${escapeAttr(css)}"`);
            continue;
          }

          kept.push(`${attr}="${escapeAttr(value)}"`);
        }

        if (name === "style") {
          if (token.selfClosing) break;

          if (ctx.opts.allowStyleBlocks === false) {
            skip.push("style"); // drop the block and its content
            break;
          }

          inStyle = true;
          out.push("<style>");
          break;
        }

        out.push(`<${name}${kept.length ? ` ${kept.join(" ")}` : ""}>`);
        break;
      }
    }
  }

  return { html: out.join(""), blockedTrackers: ctx.trackers, remoteImages: ctx.remote };
};

// ---------- text extraction ----------

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "tr",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "hr",
  "address",
  "center",
]);

const SKIP_TEXT = new Set([
  "script",
  "style",
  "title",
  "head",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
]);

/** Plain-text projection for snippets and the search index. */
export const htmlToText = (html: string): string => {
  const parts: Array<string> = [];
  const skip: Array<string> = [];

  for (const token of tokenizeHtml(html)) {
    if (skip.length > 0) {
      const top = skip[skip.length - 1]!;

      if (token.type === "start" && token.name === top && !token.selfClosing) skip.push(top);
      else if (token.type === "end" && token.name === top) skip.pop();
      continue;
    }

    if (token.type === "text") parts.push(token.text.replace(/\s+/g, " "));
    else if (token.type === "start") {
      if (SKIP_TEXT.has(token.name) && !token.selfClosing) skip.push(token.name);
      else if (token.name === "br") parts.push("\n");
      else if (token.name === "li") parts.push("\n- ");
      else if (token.name === "td" || token.name === "th") parts.push(" ");
      else if (BLOCK_TAGS.has(token.name)) parts.push("\n");
    } else if (token.type === "end" && BLOCK_TAGS.has(token.name)) parts.push("\n");
  }

  return parts
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * Message HTML as text for reading (terminal and agent clients), unlike `htmlToText`'s one-line
 * projection for snippets and search: entities are decoded, `<pre>` blocks keep their spacing and
 * line breaks, and web/mail links whose text differs from the target show it as `text <url>`.
 * The result is untrusted text: clients still strip control characters before display.
 */
export const htmlToReadableText = (html: string): string => {
  // Flowing text collapses whitespace; preformatted text is kept exactly.
  const segments: Array<{ text: string; pre: boolean }> = [];
  const emit = (text: string, pre = false) => segments.push({ text, pre });
  const skip: Array<string> = [];
  let preDepth = 0;
  let link: { href: string; label: string } | undefined;

  for (const token of tokenizeHtml(html)) {
    if (skip.length > 0) {
      const top = skip[skip.length - 1]!;

      if (token.type === "start" && token.name === top && !token.selfClosing) skip.push(top);
      else if (token.type === "end" && token.name === top) skip.pop();
      continue;
    }

    if (token.type === "text") {
      const text = decodeHtmlEntities(token.text);

      if (link) link.label += text;

      if (preDepth > 0) emit(text, true);
      else emit(text.replace(/\s+/g, " "));
    } else if (token.type === "start") {
      if (SKIP_TEXT.has(token.name) && !token.selfClosing) skip.push(token.name);
      else if (token.name === "pre" && !token.selfClosing) {
        preDepth++;
        emit("\n");
      } else if (token.name === "a" && !token.selfClosing) {
        const href = token.attrs.find(([n]) => n === "href")?.[1] ?? "";
        link = /^(https?:|mailto:)/i.test(href) ? { href, label: "" } : undefined;
      } else if (token.name === "br") emit("\n", preDepth > 0);
      else if (token.name === "li") emit("\n- ");
      else if (token.name === "td" || token.name === "th") emit(" ");
      else if (BLOCK_TAGS.has(token.name)) emit("\n");
    } else if (token.type === "end") {
      if (token.name === "pre" && preDepth > 0) {
        preDepth--;
        emit("\n");
      } else if (token.name === "a" && link) {
        if (link.label.replace(/\s+/g, " ").trim() !== link.href) emit(` <${link.href}>`);
        link = undefined;
      } else if (BLOCK_TAGS.has(token.name)) emit("\n");
    }
  }

  // Tidy flowing lines only; preformatted lines keep their leading spaces.
  const lines: Array<{ text: string; pre: boolean }> = [{ text: "", pre: false }];

  for (const s of segments) {
    const parts = s.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push({ text: "", pre: s.pre });
      const line = lines[lines.length - 1]!;
      line.text += part;
      line.pre ||= s.pre && part.length > 0;
    });
  }

  return lines
    .map((l) =>
      (l.pre
        ? l.text
        : l.text
            .replace(/ /g, " ")
            .replace(/[ \t]+/g, " ")
            .trim()
      ).replace(/[ \t]+$/, ""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
